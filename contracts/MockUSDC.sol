// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockUSDC
 * @notice Mock USDC with full EIP-3009 receiveWithAuthorization support.
 *         Domain: name="USD Coin", version="2" — matches Base USDC on mainnet.
 *         Implements real EIP-712 signature verification (domain separator +
 *         ReceiveWithAuthorization typehash + ecrecover) so the local hardhat
 *         end-to-end test is a genuine proof of the gasless path.
 */
contract MockUSDC is ERC20 {
    // ------ EIP-712 domain separator (computed once at deploy) ------
    bytes32 private immutable _DOMAIN_SEPARATOR;

    bytes32 public constant RECEIVE_WITH_AUTHORIZATION_TYPEHASH =
        keccak256("ReceiveWithAuthorization(address from,address to,uint256 value,uint256 validAfter,uint256 validBefore,bytes32 nonce)");

    // ------ Replay protection ----------------------------------------
    // authorizer => nonce => used
    mapping(address => mapping(bytes32 => bool)) private _authorizationStates;

    event AuthorizationUsed(address indexed authorizer, bytes32 indexed nonce);

    constructor() ERC20("USD Coin", "USDC") {
        _DOMAIN_SEPARATOR = keccak256(
            abi.encode(
                keccak256(
                    "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
                ),
                keccak256(bytes("USD Coin")),
                keccak256(bytes("2")),
                block.chainid,
                address(this)
            )
        );
    }

    // ------ ERC20 overrides -----------------------------------------

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    // ------ EIP-3009 ------------------------------------------------

    /// @notice Returns the EIP-712 domain separator.
    function DOMAIN_SEPARATOR() external view returns (bytes32) {
        return _DOMAIN_SEPARATOR;
    }

    /// @notice Returns true if the nonce has already been used by the authorizer.
    function authorizationState(address authorizer, bytes32 nonce)
        external
        view
        returns (bool)
    {
        return _authorizationStates[authorizer][nonce];
    }

    /**
     * @notice Execute a transfer using a signed EIP-3009 authorization.
     *
     * @param from        Address of the USDC holder (authorizer / signer).
     * @param to          Recipient of the transfer. Must equal msg.sender.
     * @param value       USDC amount (6-decimal).
     * @param validAfter  Authorization not valid at or before this timestamp.
     * @param validBefore Authorization not valid at or after this timestamp.
     * @param nonce       Unique bytes32 per authorization (chosen by the signer).
     * @param v           EIP-712 signature component.
     * @param r           EIP-712 signature component.
     * @param s           EIP-712 signature component.
     */
    function receiveWithAuthorization(
        address from,
        address to,
        uint256 value,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        uint8 v,
        bytes32 r,
        bytes32 s
    ) external {
        // EIP-3009: only the designated recipient may submit this authorization.
        require(msg.sender == to, "MockUSDC: caller is not to");

        // Time window.
        require(block.timestamp > validAfter,  "MockUSDC: authorization not yet valid");
        require(block.timestamp < validBefore, "MockUSDC: authorization expired");

        // Replay protection (check before state change).
        require(!_authorizationStates[from][nonce], "MockUSDC: authorization already used");

        // Compute EIP-712 digest.
        bytes32 structHash = keccak256(
            abi.encode(
                RECEIVE_WITH_AUTHORIZATION_TYPEHASH,
                from,
                to,
                value,
                validAfter,
                validBefore,
                nonce
            )
        );
        bytes32 digest = keccak256(
            abi.encodePacked(hex"1901", _DOMAIN_SEPARATOR, structHash)
        );

        // Recover signer and verify.
        address recovered = ecrecover(digest, v, r, s);
        require(
            recovered != address(0) && recovered == from,
            "MockUSDC: invalid signature"
        );

        // Effects: mark nonce used before external transfer call.
        _authorizationStates[from][nonce] = true;

        // Interaction: transfer funds.
        _transfer(from, to, value);

        emit AuthorizationUsed(from, nonce);
    }
}
