# syntax=docker/dockerfile:1

# Builder stage: install workspace deps from root, then build only the API workspace.
FROM node:20-alpine AS builder
WORKDIR /app

# Copy only manifests first for better build-layer cache behavior.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json

# Install root + API workspace deps (including dev deps needed to compile TypeScript).
RUN npm ci --ignore-scripts --workspace @agentpact/api --include-workspace-root

# Copy only files required to compile the API workspace.
COPY tsconfig.base.json ./
COPY apps/api ./apps/api

# Build only API.
RUN npm run build -w @agentpact/api

# Production stage: install only runtime deps, then copy built artifacts + required root assets.
FROM node:20-alpine AS production
WORKDIR /app

ENV NODE_ENV=production

# Manifests needed for workspace-aware production install.
COPY package.json package-lock.json ./
COPY apps/api/package.json ./apps/api/package.json

# Install production dependencies for root + API workspace only.
RUN npm ci --ignore-scripts --omit=dev --workspace @agentpact/api --include-workspace-root \
  && npm cache clean --force

# Runtime files needed by API and operational scripts/migrations.
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY db ./db
COPY migrations ./migrations
COPY scripts ./scripts

# Railway/containers should probe this endpoint.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD wget -qO- http://127.0.0.1:4000/health > /dev/null || exit 1

EXPOSE 4000

# Run API service only.
CMD ["node", "apps/api/dist/server.js"]
