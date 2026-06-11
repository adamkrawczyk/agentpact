const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();

  console.log("Deploying contracts with account:", deployer.address);

  const USDC_ADDRESS = "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913"; // Base mainnet USDC
  const PLATFORM_WALLET = process.env.PLATFORM_WALLET;
  const PLATFORM_FEE = 10;

  if (!PLATFORM_WALLET) {
    throw new Error("PLATFORM_WALLET is required");
  }

  console.log("\nDeployment parameters:");
  console.log("- USDC Token:", USDC_ADDRESS);
  console.log("- Platform wallet:", PLATFORM_WALLET);
  console.log("- Platform fee:", PLATFORM_FEE + "%");
  console.log("\nDeploying...");

  const Escrow = await ethers.getContractFactory("AgentPactEscrow");
  const escrow = await Escrow.deploy(USDC_ADDRESS, PLATFORM_WALLET, PLATFORM_FEE);

  await escrow.waitForDeployment();

  const contractAddress = await escrow.getAddress();
  
  console.log("\n✅ SUCCESS!");
  console.log("AgentPactEscrow deployed to:", contractAddress);
  console.log("\nAdd this to your .env.production:");
  console.log(`ESCROW_CONTRACT_ADDRESS=${contractAddress}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
