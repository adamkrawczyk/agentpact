# Contract Verification on BaseScan

## Contract Details

| Field | Value |
|-------|-------|
| **Address** | `0x588168712bF758aFD747bF46471afa53f9599A64` |
| **Network** | Base Mainnet (Chain ID: 8453) |
| **Contract** | `AgentPactEscrow` |
| **Solidity Version** | `0.8.20` |
| **Optimizer** | Enabled, 200 runs |
| **OpenZeppelin** | `@openzeppelin/contracts@5.4.0` |
| **License** | MIT |

## Constructor Arguments

The contract was deployed with these constructor arguments:

| Parameter | Type | Value |
|-----------|------|-------|
| `_usdc` | `address` | `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` (Base USDC) |
| `_platformWallet` | `address` | `0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4` |
| `_platformFeePercent` | `uint256` | `10` |

**ABI-encoded constructor arguments:**
```
000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda02913
0000000000000000000000004ddcf20aa5fbce8dc7bb9dd1b503a61a65fba1f4
000000000000000000000000000000000000000000000000000000000000000a
```

## On-Chain Verification Status

✅ **Contract is deployed** — bytecode confirmed at the address (9526 chars).

✅ **On-chain values match expected constructor args:**
- `usdc()` → `0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` ✓
- `platformWallet()` → `0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4` ✓
- `platformFeePercent()` → `10` ✓

✅ **Contract functions match chain.ts ABI:**
- `createMilestone(bytes32, bytes32, address, uint256)` ✓
- `acceptMilestone(bytes32)` ✓
- `openDispute(bytes32)` ✓
- `resolveDispute(bytes32, bool)` ✓
- `claimAfterTimeout(bytes32)` ✓
- `milestones(bytes32)` (view) ✓
- `usdc()` (view) ✓
- `platformWallet()` (view) ✓
- `platformFeePercent()` (view) ✓
- `TIMEOUT_PERIOD()` (view) ✓

## Source Verification on BaseScan

**Status:** ❌ Not yet verified on BaseScan (no API key available).

### Option 1: Manual Verification via BaseScan UI

1. Go to [BaseScan Contract Verification](https://basescan.org/verifyContract?a=0x588168712bF758aFD747bF46471afa53f9599A64)
2. Fill in:
   - **Contract Address:** `0x588168712bF758aFD747bF46471afa53f9599A64`
   - **Compiler Type:** Solidity (Single file) — or use "Standard-Json-Input" for multi-file
   - **Compiler Version:** `v0.8.20+commit.a1b79de6`
   - **Open Source License Type:** MIT License
3. Click "Continue"
4. **For Standard-Json-Input (recommended):**
   - Generate the JSON input: `npx hardhat compile` then use the standard JSON from `artifacts/build-info/`
   - Upload the JSON file
5. **For single file:**
   - Flatten the source: `npx hardhat flatten contracts/AgentPactEscrow.sol > flat.sol`
   - Paste the flattened source
   - Enable optimization: Yes, 200 runs
6. **Constructor Arguments (ABI-encoded):**
   ```
   000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000004ddcf20aa5fbce8dc7bb9dd1b503a61a65fba1f4000000000000000000000000000000000000000000000000000000000000000a
   ```
7. Click "Verify and Publish"

### Option 2: Hardhat Verification (Requires API Key)

1. Get a free BaseScan API key from [basescan.org/apis](https://basescan.org/apis)

2. Add to `hardhat.config.cjs`:
   ```js
   etherscan: {
     apiKey: {
       base: process.env.BASESCAN_API_KEY
     },
     customChains: [
       {
         network: "base",
         chainId: 8453,
         urls: {
           apiURL: "https://api.basescan.org/api",
           browserURL: "https://basescan.org"
         }
       }
     ]
   }
   ```

3. Add `BASESCAN_API_KEY=<your-key>` to `.env.production`

4. Run:
   ```bash
   npx hardhat verify --network base \
     0x588168712bF758aFD747bF46471afa53f9599A64 \
     "0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913" \
     "0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4" \
     10
   ```

### Option 3: Programmatic Verification via Etherscan V2 API

```bash
# Using Etherscan V2 API (which BaseScan now requires)
BASESCAN_API_KEY="your_api_key"

# First, flatten the source
npx hardhat flatten contracts/AgentPactEscrow.sol > /tmp/flat.sol

# Then verify via API
curl -X POST "https://api.etherscan.io/v2/api" \
  -d "chainid=8453" \
  -d "module=contract" \
  -d "action=verifysourcecode" \
  -d "apikey=$BASESCAN_API_KEY" \
  -d "contractaddress=0x588168712bF758aFD747bF46471afa53f9599A64" \
  -d "sourceCode=$(cat /tmp/flat.sol)" \
  -d "codeformat=solidity-single-file" \
  -d "contractname=AgentPactEscrow" \
  -d "compilerversion=v0.8.20+commit.a1b79de6" \
  -d "optimizationUsed=1" \
  -d "runs=200" \
  -d "constructorArguements=000000000000000000000000833589fcd6edb6e08f4c7c32d4f71b54bda029130000000000000000000000004ddcf20aa5fbce8dc7bb9dd1b503a61a65fba1f4000000000000000000000000000000000000000000000000000000000000000a" \
  -d "licenseType=3"
```

## Dependencies

The contract imports two OpenZeppelin contracts:
- `@openzeppelin/contracts/token/ERC20/IERC20.sol` (v5.4.0)
- `@openzeppelin/contracts/utils/ReentrancyGuard.sol` (v5.4.0)

When using single-file verification, the source must be flattened to include these dependencies inline.
