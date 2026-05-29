// Auto-extracted from AgentPactEscrow.sol compiled artifact
// SPDX-License-Identifier: MIT
export default [
    {
        "inputs": [
            {
                "internalType": "address",
                "name": "_usdc",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "_platformWallet",
                "type": "address"
            },
            {
                "internalType": "uint256",
                "name": "_platformFeePercent",
                "type": "uint256"
            }
        ],
        "stateMutability": "nonpayable",
        "type": "constructor"
    },
    {
        "inputs": [],
        "name": "ReentrancyGuardReentrantCall",
        "type": "error"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "milestoneId",
                "type": "bytes32"
            }
        ],
        "name": "DisputeOpened",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "milestoneId",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "bool",
                "name": "refundedBuyer",
                "type": "bool"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
            }
        ],
        "name": "DisputeResolved",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "milestoneId",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "sellerAmount",
                "type": "uint256"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "platformFee",
                "type": "uint256"
            }
        ],
        "name": "MilestoneAccepted",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "milestoneId",
                "type": "bytes32"
            },
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "dealId",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "address",
                "name": "buyer",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "address",
                "name": "seller",
                "type": "address"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
            }
        ],
        "name": "MilestoneCreated",
        "type": "event"
    },
    {
        "anonymous": false,
        "inputs": [
            {
                "indexed": true,
                "internalType": "bytes32",
                "name": "milestoneId",
                "type": "bytes32"
            },
            {
                "indexed": false,
                "internalType": "uint256",
                "name": "sellerAmount",
                "type": "uint256"
            }
        ],
        "name": "TimeoutClaimed",
        "type": "event"
    },
    {
        "inputs": [],
        "name": "TIMEOUT_PERIOD",
        "outputs": [
            {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "milestoneId",
                "type": "bytes32"
            }
        ],
        "name": "acceptMilestone",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "milestoneId",
                "type": "bytes32"
            }
        ],
        "name": "claimAfterTimeout",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "dealId",
                "type": "bytes32"
            },
            {
                "internalType": "bytes32",
                "name": "milestoneId",
                "type": "bytes32"
            },
            {
                "internalType": "address",
                "name": "seller",
                "type": "address"
            },
            {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
            }
        ],
        "name": "createMilestone",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "",
                "type": "bytes32"
            }
        ],
        "name": "milestones",
        "outputs": [
            {
                "internalType": "bytes32",
                "name": "dealId",
                "type": "bytes32"
            },
            {
                "internalType": "address",
                "name": "buyer",
                "type": "address"
            },
            {
                "internalType": "address",
                "name": "seller",
                "type": "address"
            },
            {
                "internalType": "uint256",
                "name": "amount",
                "type": "uint256"
            },
            {
                "internalType": "enum AgentPactEscrow.MilestoneStatus",
                "name": "status",
                "type": "uint8"
            },
            {
                "internalType": "uint256",
                "name": "createdAt",
                "type": "uint256"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "milestoneId",
                "type": "bytes32"
            }
        ],
        "name": "openDispute",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "platformFeePercent",
        "outputs": [
            {
                "internalType": "uint256",
                "name": "",
                "type": "uint256"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "platformWallet",
        "outputs": [
            {
                "internalType": "address",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    },
    {
        "inputs": [
            {
                "internalType": "bytes32",
                "name": "milestoneId",
                "type": "bytes32"
            },
            {
                "internalType": "bool",
                "name": "refundBuyer",
                "type": "bool"
            }
        ],
        "name": "resolveDispute",
        "outputs": [],
        "stateMutability": "nonpayable",
        "type": "function"
    },
    {
        "inputs": [],
        "name": "usdc",
        "outputs": [
            {
                "internalType": "contract IERC20",
                "name": "",
                "type": "address"
            }
        ],
        "stateMutability": "view",
        "type": "function"
    }
];
