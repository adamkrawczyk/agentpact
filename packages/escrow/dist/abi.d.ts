declare const _default: readonly [{
    readonly inputs: readonly [{
        readonly internalType: "address";
        readonly name: "_usdc";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "_platformWallet";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "_platformFeePercent";
        readonly type: "uint256";
    }];
    readonly stateMutability: "nonpayable";
    readonly type: "constructor";
}, {
    readonly inputs: readonly [];
    readonly name: "ReentrancyGuardReentrantCall";
    readonly type: "error";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "bytes32";
        readonly name: "milestoneId";
        readonly type: "bytes32";
    }];
    readonly name: "DisputeOpened";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "bytes32";
        readonly name: "milestoneId";
        readonly type: "bytes32";
    }, {
        readonly indexed: false;
        readonly internalType: "bool";
        readonly name: "refundedBuyer";
        readonly type: "bool";
    }, {
        readonly indexed: false;
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "DisputeResolved";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "bytes32";
        readonly name: "milestoneId";
        readonly type: "bytes32";
    }, {
        readonly indexed: false;
        readonly internalType: "uint256";
        readonly name: "sellerAmount";
        readonly type: "uint256";
    }, {
        readonly indexed: false;
        readonly internalType: "uint256";
        readonly name: "platformFee";
        readonly type: "uint256";
    }];
    readonly name: "MilestoneAccepted";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "bytes32";
        readonly name: "milestoneId";
        readonly type: "bytes32";
    }, {
        readonly indexed: true;
        readonly internalType: "bytes32";
        readonly name: "dealId";
        readonly type: "bytes32";
    }, {
        readonly indexed: false;
        readonly internalType: "address";
        readonly name: "buyer";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "address";
        readonly name: "seller";
        readonly type: "address";
    }, {
        readonly indexed: false;
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "MilestoneCreated";
    readonly type: "event";
}, {
    readonly anonymous: false;
    readonly inputs: readonly [{
        readonly indexed: true;
        readonly internalType: "bytes32";
        readonly name: "milestoneId";
        readonly type: "bytes32";
    }, {
        readonly indexed: false;
        readonly internalType: "uint256";
        readonly name: "sellerAmount";
        readonly type: "uint256";
    }];
    readonly name: "TimeoutClaimed";
    readonly type: "event";
}, {
    readonly inputs: readonly [];
    readonly name: "TIMEOUT_PERIOD";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "milestoneId";
        readonly type: "bytes32";
    }];
    readonly name: "acceptMilestone";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "milestoneId";
        readonly type: "bytes32";
    }];
    readonly name: "claimAfterTimeout";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "dealId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "bytes32";
        readonly name: "milestoneId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "address";
        readonly name: "seller";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }];
    readonly name: "createMilestone";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "";
        readonly type: "bytes32";
    }];
    readonly name: "milestones";
    readonly outputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "dealId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "address";
        readonly name: "buyer";
        readonly type: "address";
    }, {
        readonly internalType: "address";
        readonly name: "seller";
        readonly type: "address";
    }, {
        readonly internalType: "uint256";
        readonly name: "amount";
        readonly type: "uint256";
    }, {
        readonly internalType: "enum AgentPactEscrow.MilestoneStatus";
        readonly name: "status";
        readonly type: "uint8";
    }, {
        readonly internalType: "uint256";
        readonly name: "createdAt";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "milestoneId";
        readonly type: "bytes32";
    }];
    readonly name: "openDispute";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "platformFeePercent";
    readonly outputs: readonly [{
        readonly internalType: "uint256";
        readonly name: "";
        readonly type: "uint256";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "platformWallet";
    readonly outputs: readonly [{
        readonly internalType: "address";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}, {
    readonly inputs: readonly [{
        readonly internalType: "bytes32";
        readonly name: "milestoneId";
        readonly type: "bytes32";
    }, {
        readonly internalType: "bool";
        readonly name: "refundBuyer";
        readonly type: "bool";
    }];
    readonly name: "resolveDispute";
    readonly outputs: readonly [];
    readonly stateMutability: "nonpayable";
    readonly type: "function";
}, {
    readonly inputs: readonly [];
    readonly name: "usdc";
    readonly outputs: readonly [{
        readonly internalType: "contract IERC20";
        readonly name: "";
        readonly type: "address";
    }];
    readonly stateMutability: "view";
    readonly type: "function";
}];
export default _default;
