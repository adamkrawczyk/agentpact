FROM node:22-alpine AS base
WORKDIR /app
COPY package.json tsconfig.base.json ./
COPY apps/api/package.json apps/api/package.json
COPY apps/mcp/package.json apps/mcp/package.json
COPY apps/web/package.json apps/web/package.json
RUN npm install

FROM base AS build
COPY . .
RUN npm run build

FROM node:22-alpine AS api
WORKDIR /app
COPY --from=build /app /app
EXPOSE 4000
CMD ["sh", "-lc", "npm run migrate && npm run start -w @agentpact/api"]

FROM node:22-alpine AS web
WORKDIR /app
COPY --from=build /app /app
EXPOSE 3000
CMD ["npm", "run", "start", "-w", "@agentpact/web"]
