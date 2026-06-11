require("ts-node/register/transpile-only");
require("@nomicfoundation/hardhat-toolbox");
require("dotenv").config({ path: ".env.production" });

/** @type {import('hardhat/config').HardhatUserConfig} */
module.exports = {
  solidity: {
    version: "0.8.20",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200
      }
    }
  },
  paths: {
    sources: "./contracts",
    tests: "./contracts/test",
    cache: "./cache",
    artifacts: "./artifacts"
  },
  typechain: {
    outDir: "contracts/typechain-types",
    target: "ethers-v6"
  },
  networks: {
    base: {
      url: process.env.RPC_URL || "https://mainnet.base.org",
      accounts: process.env.PLATFORM_PRIVATE_KEY ? [process.env.PLATFORM_PRIVATE_KEY] : [],
      chainId: 8453
    },
    "base-sepolia": {
      url: "https://sepolia.base.org",
      accounts: process.env.PLATFORM_PRIVATE_KEY ? [process.env.PLATFORM_PRIVATE_KEY] : [],
      chainId: 84532
    }
  },
  // Etherscan v2 unified API config for hardhat-verify v2. The single
  // Etherscan-account API key (BaseScan-issued ones are Etherscan-account keys)
  // works across all chains via the v2 endpoint. Token sourced from
  // BASESCAN_API_KEY env (read from BW item `basescan-api-key(etherscan)`).
  //
  etherscan: {
    apiKey: process.env.BASESCAN_API_KEY || "",
    customChains: [
      {
        network: "base",
        chainId: 8453,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=8453",
          browserURL: "https://basescan.org"
        }
      },
      {
        network: "base-sepolia",
        chainId: 84532,
        urls: {
          apiURL: "https://api.etherscan.io/v2/api?chainid=84532",
          browserURL: "https://sepolia.basescan.org"
        }
      }
    ]
  }
};
