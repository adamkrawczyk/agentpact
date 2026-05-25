# ─── builder ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS builder

WORKDIR /repo

# Copy root workspace manifests
COPY package.json package-lock.json tsconfig.base.json ./

# Copy all workspace package.json files (needed for npm workspaces install)
COPY apps/daemon/package.json apps/daemon/
COPY apps/fulfillment-daemon/package.json apps/fulfillment-daemon/

RUN npm install --ignore-scripts

# Copy source
COPY apps/fulfillment-daemon/tsconfig.json apps/fulfillment-daemon/
COPY apps/fulfillment-daemon/src/ apps/fulfillment-daemon/src/

# Build only this workspace
RUN npm run build -w @agentpact/fulfillment-daemon

# ─── runtime ─────────────────────────────────────────────────────────────────
FROM node:20-slim AS runtime

# Install slither dependencies.
# Note: 'solc' is not a Debian bookworm apt package; we install solc-select via pip
# and download a recent solc binary at image-build time. solc-select lets the runtime
# switch between solc versions if a contract pins a specific pragma — slither will
# trigger this automatically when needed.
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip python3-venv ca-certificates && \
    pip3 install --break-system-packages slither-analyzer solc-select && \
    solc-select install 0.8.20 && \
    solc-select use 0.8.20 && \
    rm -rf /var/lib/apt/lists/*

WORKDIR /app

# Copy workspace manifests and production node_modules
COPY package.json package-lock.json tsconfig.base.json ./
COPY apps/daemon/package.json apps/daemon/
COPY apps/fulfillment-daemon/package.json apps/fulfillment-daemon/

RUN npm install --omit=dev --ignore-scripts

# Copy built dist
COPY --from=builder /repo/apps/fulfillment-daemon/dist/ apps/fulfillment-daemon/dist/

# Copy scripts (audit-runner-cli.ts)
COPY scripts/ scripts/

ENV NODE_ENV=production

CMD ["node", "apps/fulfillment-daemon/dist/index.js"]
