// apps/relayer-daemon/src/cctp-gateway-abi.ts — M1 (lane m1-relay)
//
// HAND-WRITTEN minimal ABI for AgentPactCctpGateway, matching the interface
// locked in the ap_v31 SHARED_CONTEXT §6. The real ABI ships as
// packages/escrow/abi/AgentPactCctpGateway.json (lane m1-contracts); when it
// merges, swap the gateway constant below for the JSON import and delete the
// hand-written signatures. Nothing else in the relayer names a gateway
// function or event — this file is the only reconciliation point.
//
// Fee parameters on refund / claimAndForward: §6 makes (maxFee,
// minFinalityThreshold) caller inputs bounded on-chain by construction-time
// caps. Their position (trailing arguments) is this file's assumption.

import { parseAbi } from "viem";

export const CCTP_GATEWAY_ABI = parseAbi([
  "function relayDeposit(bytes message, bytes attestation) returns (bytes32 intentId)",
  "function refund(bytes32 intentId, uint256 maxFee, uint32 minFinalityThreshold)",
  "function claimAndForward(bytes32 intentId, bytes ciphertext, bytes witness, uint256 maxFee, uint32 minFinalityThreshold)",
  "event CctpDepositBound(bytes32 indexed intentId, bytes32 indexed dealRef, uint32 sourceDomain, bytes32 messageSender, bytes32 refundRecipient, uint256 amount, uint256 feeExecuted, bytes32 nonce)",
  "event CctpDepositRejected(bytes32 indexed messageHash, string reason)",
  "event CctpRefundSent(bytes32 indexed intentId, uint32 destinationDomain, bytes32 recipient, uint256 amount, uint256 maxFee)",
  "event CctpPayoutSent(bytes32 indexed intentId, uint32 domain, bytes32 recipient, uint256 amount, uint256 maxFee)",
]);

// MessageTransmitterV2 (circlefin/evm-cctp-contracts src/v2/BaseMessageTransmitter.sol):
// usedNonces[nonce] == 1 once a message with that bytes32 nonce was received.
export const MESSAGE_TRANSMITTER_V2_ABI = parseAbi([
  "function usedNonces(bytes32 nonce) view returns (uint256)",
]);

export const NONCE_USED = 1n;
