// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title CctpMessageV2
 * @notice Calldata parser for a CCTP v2 message: the MessageV2 header and the
 *         BurnMessageV2 body it carries.
 *
 * @dev Layouts copied from Circle's source (packed, big-endian; uintNN
 *      left-padded, bytesNN right-padded):
 *      https://github.com/circlefin/evm-cctp-contracts/blob/master/src/messages/v2/MessageV2.sol
 *      https://github.com/circlefin/evm-cctp-contracts/blob/master/src/messages/v2/BurnMessageV2.sol
 *
 *      MessageV2 header
 *        version                    4   uint32   0
 *        sourceDomain               4   uint32   4
 *        destinationDomain          4   uint32   8
 *        nonce                     32   bytes32  12
 *        sender                    32   bytes32  44
 *        recipient                 32   bytes32  76
 *        destinationCaller         32   bytes32  108
 *        minFinalityThreshold       4   uint32   140
 *        finalityThresholdExecuted  4   uint32   144
 *        messageBody          dynamic   bytes    148
 *
 *      BurnMessageV2 body
 *        version                    4   uint32   0
 *        burnToken                 32   bytes32  4
 *        mintRecipient             32   bytes32  36
 *        amount                    32   uint256  68
 *        messageSender             32   bytes32  100
 *        maxFee                    32   uint256  132
 *        feeExecuted               32   uint256  164
 *        expirationBlock           32   uint256  196
 *        hookData             dynamic   bytes    228
 *
 *      `nonce`, `finalityThresholdExecuted`, `feeExecuted` and
 *      `expirationBlock` are zero on the source chain and filled in by Circle's
 *      attestation service, so they are only meaningful on an attested message.
 */
library CctpMessageV2 {
    uint256 internal constant HEADER_LENGTH = 148;
    uint256 internal constant BURN_BODY_FIXED_LENGTH = 228;

    error CctpMessageTooShort(uint256 length);

    struct BurnMessage {
        // header
        uint32 version;
        uint32 sourceDomain;
        uint32 destinationDomain;
        bytes32 nonce;
        bytes32 sender;
        bytes32 recipient;
        bytes32 destinationCaller;
        // body
        uint32 bodyVersion;
        bytes32 burnToken;
        bytes32 mintRecipient;
        uint256 amount;
        bytes32 messageSender;
        uint256 maxFee;
        uint256 feeExecuted;
    }

    /// @notice Parse the fixed fields of a v2 burn message. Reverts if the
    ///         message is too short to hold a header plus a burn body.
    function parseBurnMessage(bytes calldata message) internal pure returns (BurnMessage memory m) {
        if (message.length < HEADER_LENGTH + BURN_BODY_FIXED_LENGTH) revert CctpMessageTooShort(message.length);
        m.version = uint32(bytes4(message[0:4]));
        m.sourceDomain = uint32(bytes4(message[4:8]));
        m.destinationDomain = uint32(bytes4(message[8:12]));
        m.nonce = bytes32(message[12:44]);
        m.sender = bytes32(message[44:76]);
        m.recipient = bytes32(message[76:108]);
        m.destinationCaller = bytes32(message[108:140]);

        bytes calldata body = message[HEADER_LENGTH:];
        m.bodyVersion = uint32(bytes4(body[0:4]));
        m.burnToken = bytes32(body[4:36]);
        m.mintRecipient = bytes32(body[36:68]);
        m.amount = uint256(bytes32(body[68:100]));
        m.messageSender = bytes32(body[100:132]);
        m.maxFee = uint256(bytes32(body[132:164]));
        m.feeExecuted = uint256(bytes32(body[164:196]));
    }

    /// @notice The BurnMessageV2 `hookData` (everything after the fixed body).
    ///         Callers must have validated the length via `parseBurnMessage`.
    function hookData(bytes calldata message) internal pure returns (bytes calldata) {
        return message[HEADER_LENGTH + BURN_BODY_FIXED_LENGTH:];
    }

    function toBytes32(address a) internal pure returns (bytes32) {
        return bytes32(uint256(uint160(a)));
    }
}
