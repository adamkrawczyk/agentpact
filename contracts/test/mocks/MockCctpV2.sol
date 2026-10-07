// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IMintableUSDC {
    function mint(address to, uint256 amount) external;
}

interface IMessageHandlerV2Mock {
    function handleReceiveFinalizedMessage(uint32 remoteDomain, bytes32 sender, uint32 finalityThresholdExecuted, bytes calldata messageBody)
        external
        returns (bool);
    function handleReceiveUnfinalizedMessage(uint32 remoteDomain, bytes32 sender, uint32 finalityThresholdExecuted, bytes calldata messageBody)
        external
        returns (bool);
}

/// @dev Test-only hook: when armed, the next guarded call re-enters `target`
///      with `data` and bubbles its revert. Used to prove the gateway's
///      ReentrancyGuard.
abstract contract MockReenterer {
    address public reenterTarget;
    bytes public reenterData;

    function armReentry(address target, bytes calldata data) external {
        reenterTarget = target;
        reenterData = data;
    }

    function _maybeReenter() internal {
        address target = reenterTarget;
        if (target == address(0)) return;
        reenterTarget = address(0);
        (bool ok, bytes memory ret) = target.call(reenterData);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}

/**
 * @title MockMessageTransmitterV2
 * @notice Test double for Circle's MessageTransmitterV2 with the behaviour the
 *         gateway relies on: header parsing, destinationDomain check,
 *         destinationCaller enforcement (bytes32(0) = anyone), nonce replay
 *         protection, and dispatch to the header recipient's
 *         handleReceive{Finalized,Unfinalized}Message (threshold 2000).
 *         Attestation = keccak256("mock-attestation", message).
 */
contract MockMessageTransmitterV2 is MockReenterer {
    uint32 public immutable localDomain;
    uint32 public constant version = 1;
    mapping(bytes32 => uint256) public usedNonces;

    constructor(uint32 _localDomain) {
        localDomain = _localDomain;
        usedNonces[bytes32(0)] = 1; // nonce 0 pre-claimed, as on-chain
    }

    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool) {
        require(message.length >= 148, "Invalid message: too short");
        require(keccak256(attestation) == keccak256(abi.encodePacked(keccak256(abi.encodePacked("mock-attestation", message)))), "Invalid attestation");
        require(uint32(bytes4(message[0:4])) == version, "Invalid message version");
        uint32 sourceDomain = uint32(bytes4(message[4:8]));
        require(uint32(bytes4(message[8:12])) == localDomain, "Invalid destination domain");
        bytes32 nonce = bytes32(message[12:44]);
        bytes32 sender = bytes32(message[44:76]);
        address recipient = address(uint160(uint256(bytes32(message[76:108]))));
        bytes32 destinationCaller = bytes32(message[108:140]);
        if (destinationCaller != bytes32(0)) {
            require(destinationCaller == bytes32(uint256(uint160(msg.sender))), "Invalid caller for message");
        }
        uint32 finalityExecuted = uint32(bytes4(message[144:148]));
        require(usedNonces[nonce] == 0, "Nonce already used");
        usedNonces[nonce] = 1;

        _maybeReenter();

        bytes calldata body = message[148:];
        bool ok = finalityExecuted < 2000
            ? IMessageHandlerV2Mock(recipient).handleReceiveUnfinalizedMessage(sourceDomain, sender, finalityExecuted, body)
            : IMessageHandlerV2Mock(recipient).handleReceiveFinalizedMessage(sourceDomain, sender, finalityExecuted, body);
        require(ok, "handleReceiveMessage() failed");
        return true;
    }
}

/**
 * @title MockTokenMessengerV2
 * @notice Test double for TokenMessengerV2 + TokenMinterV2. Receives burn
 *         messages from the transmitter (mints `amount - feeExecuted` to
 *         mintRecipient, fee to feeRecipient) and records outgoing
 *         `depositForBurnWithHook` calls (pulls funds with transferFrom,
 *         applying the deployed Base build's checks).
 */
contract MockTokenMessengerV2 is MockReenterer {
    struct Burn {
        address from;
        uint256 amount;
        uint32 destinationDomain;
        bytes32 mintRecipient;
        address burnToken;
        bytes32 destinationCaller;
        uint256 maxFee;
        uint32 minFinalityThreshold;
        bytes hookData;
    }

    address public immutable localMessageTransmitter;
    address public immutable usdc;
    address public feeRecipient = address(0xFEE);
    uint32 public constant messageBodyVersion = 1;
    mapping(uint32 => bytes32) public remoteTokenMessengers;
    mapping(uint32 => mapping(bytes32 => address)) private _localTokens;
    bool public failBurns;
    Burn[] private _burns;

    event BurnRecorded(uint256 indexed index, uint32 destinationDomain, bytes32 mintRecipient, uint256 amount, uint256 maxFee);

    constructor(address _transmitter, address _usdc) {
        localMessageTransmitter = _transmitter;
        usdc = _usdc;
    }

    function localMinter() external view returns (address) {
        return address(this);
    }

    function setRemoteTokenMessenger(uint32 domain, bytes32 messenger) external {
        remoteTokenMessengers[domain] = messenger;
    }

    function setLocalToken(uint32 remoteDomain, bytes32 remoteToken, address localToken) external {
        _localTokens[remoteDomain][remoteToken] = localToken;
    }

    function setFailBurns(bool v) external {
        failBurns = v;
    }

    function getLocalToken(uint32 remoteDomain, bytes32 remoteToken) external view returns (address) {
        return _localTokens[remoteDomain][remoteToken];
    }

    function handleReceiveFinalizedMessage(uint32 remoteDomain, bytes32 sender, uint32, bytes calldata body)
        external
        returns (bool)
    {
        return _handle(remoteDomain, sender, body);
    }

    function handleReceiveUnfinalizedMessage(uint32 remoteDomain, bytes32 sender, uint32 finality, bytes calldata body)
        external
        returns (bool)
    {
        require(finality >= 500, "Unsupported finality threshold");
        return _handle(remoteDomain, sender, body);
    }

    function _handle(uint32 remoteDomain, bytes32 sender, bytes calldata body) private returns (bool) {
        require(msg.sender == localMessageTransmitter, "Invalid message transmitter");
        require(remoteTokenMessengers[remoteDomain] == sender && sender != bytes32(0), "Remote TokenMessenger unsupported");
        require(uint32(bytes4(body[0:4])) == messageBodyVersion, "Invalid message body version");
        bytes32 burnToken = bytes32(body[4:36]);
        address mintRecipient = address(uint160(uint256(bytes32(body[36:68]))));
        uint256 amount = uint256(bytes32(body[68:100]));
        uint256 maxFee = uint256(bytes32(body[132:164]));
        uint256 fee = uint256(bytes32(body[164:196]));
        require(fee == 0 || fee < amount, "Fee equals or exceeds amount");
        require(fee <= maxFee, "Fee exceeds max fee");
        address token = _localTokens[remoteDomain][burnToken];
        require(token != address(0), "Mint token not supported");
        IMintableUSDC(token).mint(mintRecipient, amount - fee);
        if (fee > 0) IMintableUSDC(token).mint(feeRecipient, fee);
        return true;
    }

    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external {
        require(!failBurns, "Burns failing (mock)");
        require(hookData.length > 0, "Hook data is empty");
        require(amount > 0, "Amount must be nonzero");
        require(mintRecipient != bytes32(0), "Mint recipient must be nonzero");
        require(maxFee < amount, "Max fee must be less than amount");
        require(remoteTokenMessengers[destinationDomain] != bytes32(0), "No TokenMessenger for domain");
        require(burnToken == usdc, "Burn token not supported");

        _maybeReenter();

        require(IERC20(burnToken).transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        _burns.push(Burn(msg.sender, amount, destinationDomain, mintRecipient, burnToken, destinationCaller, maxFee, minFinalityThreshold, hookData));
        emit BurnRecorded(_burns.length - 1, destinationDomain, mintRecipient, amount, maxFee);
    }

    function burnCount() external view returns (uint256) {
        return _burns.length;
    }

    function burns(uint256 i) external view returns (Burn memory) {
        return _burns[i];
    }
}

/// @dev ERC-1271 wallet stub whose owner EOA signs for it.
contract MockERC1271Wallet {
    address public immutable owner;

    constructor(address _owner) {
        owner = _owner;
    }

    function isValidSignature(bytes32 hash, bytes memory signature) external view returns (bytes4) {
        if (signature.length != 65) return 0xffffffff;
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        return ecrecover(hash, v, r, s) == owner ? bytes4(0x1626ba7e) : bytes4(0xffffffff);
    }

    function approve(address token, address spender, uint256 amount) external {
        require(msg.sender == owner, "not owner");
        IERC20(token).approve(spender, amount);
    }

    function call(address target, bytes calldata data) external returns (bytes memory) {
        require(msg.sender == owner, "not owner");
        (bool ok, bytes memory ret) = target.call(data);
        require(ok, "call failed");
        return ret;
    }
}
