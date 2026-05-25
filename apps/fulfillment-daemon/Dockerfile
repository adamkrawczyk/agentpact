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

# Install slither dependencies
RUN apt-get update && \
    apt-get install -y --no-install-recommends python3 python3-pip solc && \
    pip3 install slither-analyzer --break-system-packages && \
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
