// pm2 start apps/demo-x402-seller/ecosystem.config.cjs
// Build first: npm run build -w @agentpact/x402-escrow && npm run build -w @agentpact/demo-x402-seller
// Secrets (AGENTPACT_API_KEY, …) come from the process environment, never from this file.
module.exports = {
  apps: [
    {
      name: "demo-x402-seller",
      script: "dist/main.js",
      cwd: __dirname,
      instances: 1,
      autorestart: true,
      max_memory_restart: "256M",
      env: {
        NODE_ENV: "production",
        PORT: "4402",
        X402_NETWORK: "base-sepolia",
        PRICE_PER_CALL_USD: "0.02",
        ESCROW_THRESHOLD_USD: "1",
      },
    },
  ],
};
