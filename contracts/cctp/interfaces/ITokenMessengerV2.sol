// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ITokenMessengerV2
 * @notice Minimal subset of Circle's CCTP v2 TokenMessengerV2 used by the
 *         AgentPact CCTP gateway.
 * @dev    Source: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/TokenMessengerV2.sol
 *         and src/v2/BaseTokenMessenger.sol. Docs:
 *         https://developers.circle.com/cctp/references/contract-interfaces
 *
 *         `depositForBurnWithHook` pulls `amount` of `burnToken` from msg.sender
 *         with transferFrom (an allowance is required) and burns it. On-chain
 *         checks (deployed Base build): amount > 0, mintRecipient != 0,
 *         maxFee < amount, a remote TokenMessenger exists for the destination
 *         domain, hookData non-empty. `minFinalityThreshold` is not checked
 *         on-chain; Iris treats <= 1000 as Fast (confirmed) and > 1000 as
 *         Standard (finalized, 2000).
 */
interface ITokenMessengerV2 {
    function depositForBurnWithHook(
        uint256 amount,
        uint32 destinationDomain,
        bytes32 mintRecipient,
        address burnToken,
        bytes32 destinationCaller,
        uint256 maxFee,
        uint32 minFinalityThreshold,
        bytes calldata hookData
    ) external;

    function localMinter() external view returns (address);

    function localMessageTransmitter() external view returns (address);

    /// @notice BurnMessageV2 body format version. Deployed CCTP v2 value is 1.
    function messageBodyVersion() external view returns (uint32);

    function remoteTokenMessengers(uint32 domain) external view returns (bytes32);
}

/**
 * @title ITokenMinterV2
 * @notice The one TokenMinter read the gateway needs: map a remote burn token
 *         (as CCTP encodes it, bytes32) to its local counterpart.
 * @dev    Source: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/TokenMinter.sol
 *         (inherited by src/v2/TokenMinterV2.sol).
 */
interface ITokenMinterV2 {
    function getLocalToken(uint32 remoteDomain, bytes32 remoteToken) external view returns (address);
}
