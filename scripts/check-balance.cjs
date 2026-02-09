const { ethers } = require("hardhat");

async function main() {
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  
  console.log("Deployer address:", deployer.address);
  console.log("Balance:", ethers.formatEther(balance), "ETH");
  
  const minRequired = ethers.parseEther("0.001"); // ~$2-3 worth
  
  if (balance < minRequired) {
    console.log("\n⚠️  WARNING: Balance too low!");
    console.log("You need at least 0.001 ETH (~$2-3) for gas fees.");
    console.log("Send some ETH to your wallet on Base network.");
    process.exit(1);
  } else {
    console.log("\n✅ Balance sufficient for deployment!");
  }
}

main();
