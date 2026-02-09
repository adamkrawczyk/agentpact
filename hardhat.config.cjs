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
  }
};
