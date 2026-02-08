# Build stage
FROM node:20-alpine AS builder

WORKDIR /app

# Copy package files
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/
COPY apps/mcp/package*.json ./apps/mcp/
COPY apps/web/package*.json ./apps/web/

# Install dependencies
RUN npm ci

# Copy source code
COPY . .

# Build all apps
RUN npm run build

# Production stage (API)
FROM node:20-alpine AS api

WORKDIR /app

# Copy runtime files and dependencies
COPY --from=builder /app/package*.json ./
COPY --from=builder /app/migrations ./migrations
COPY --from=builder /app/scripts ./scripts
COPY --from=builder /app/apps/api/dist ./apps/api/dist
COPY --from=builder /app/apps/api/package*.json ./apps/api/
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 4000

CMD ["node", "apps/api/dist/server.js"]

# Production stage (MCP)
FROM node:20-alpine AS mcp

WORKDIR /app

COPY --from=builder /app/apps/mcp/dist ./dist
COPY --from=builder /app/apps/mcp/package*.json ./
COPY --from=builder /app/node_modules ./node_modules

ENV NODE_ENV=production
EXPOSE 5000

CMD ["node", "dist/index.js"]
