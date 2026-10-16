// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title IMessageTransmitterV2
 * @notice Minimal subset of Circle's CCTP v2 MessageTransmitterV2 used by the
 *         AgentPact CCTP gateway.
 * @dev    Source: https://github.com/circlefin/evm-cctp-contracts/blob/master/src/v2/MessageTransmitterV2.sol
 *         and src/v2/BaseMessageTransmitter.sol. Docs:
 *         https://developers.circle.com/cctp/references/contract-interfaces
 *
 *         `receiveMessage` verifies the attestation, enforces
 *         `destinationDomain == localDomain`, enforces `destinationCaller`
 *         (bytes32(0) = anyone, otherwise it must equal msg.sender), marks the
 *         nonce used (replay protection, `usedNonces`) and then calls
 *         `handleReceive{Finalized,Unfinalized}Message` on the header
 *         `recipient` (TokenMessengerV2 for burn messages), which mints
 *         `amount - feeExecuted` to `mintRecipient`.
 */
interface IMessageTransmitterV2 {
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);

    function localDomain() external view returns (uint32);

    /// @notice Message header format version. Deployed CCTP v2 value is 1.
    function version() external view returns (uint32);

    function usedNonces(bytes32 nonce) external view returns (uint256);
}
