# Railway Configuration for AgentPact API

## Option 1: Deploy API without Docker (Recommended for Railway)

Railway works best with simple Node.js apps. Skip the Dockerfile complexity.

### Railway Settings:

**Build:**
- Builder: **Nixpacks** (not Dockerfile)
- Root Directory: `/` (leave empty or use root)
- Build Command: `npm install && npm run build -w @agentpact/api`
- Install Command: `npm install`

**Deploy:**
- Start Command: `node apps/api/dist/server.js`
- Watch Paths: `apps/api/**`

**Environment Variables:**
Add all the variables from `.env.production` (see main README)

---

## Option 2: Separate Dockerfile for API Only

If you want to use Docker, create a simpler Dockerfile:

1. Create `apps/api/Dockerfile`:

```dockerfile
FROM node:20-alpine

WORKDIR /app

# Copy root package.json for workspaces
COPY package*.json ./
COPY apps/api/package*.json ./apps/api/

# Install all dependencies
RUN npm install

# Copy API source
COPY apps/api ./apps/api
COPY db ./db
COPY migrations ./migrations
COPY scripts ./scripts

# Build API
RUN npm run build -w @agentpact/api

# Expose port
EXPOSE 4000

# Start API
CMD ["node", "apps/api/dist/server.js"]
```

2. Railway settings:
   - Builder: **Dockerfile**
   - Dockerfile Path: `apps/api/Dockerfile`
   - Root Directory: `/`

---

## Option 3: Use Root Dockerfile with Target

Keep existing Dockerfile but specify the build target:

**Railway Settings:**
- Builder: **Dockerfile**
- Dockerfile Path: `Dockerfile`
- Docker Build Args:
  ```
  --target=api
  ```

But this requires modifying the Dockerfile to use proper target naming.

---

## ✅ Recommended: Option 1 (No Docker)

Railway's Nixpacks auto-detects Node.js workspaces and handles them well.

### Step-by-step:

1. **Railway Dashboard → Settings → Builder**
   - Change from "Dockerfile" to "Nixpacks"

2. **Settings → Build**
   - Build Command: `npm install && npm run build -w @agentpact/api`
   - Install Command: `npm install`

3. **Settings → Deploy**
   - Start Command: `node apps/api/dist/server.js`

4. **Redeploy**

This avoids all the Docker workspace complexity.

---

## Current Error Explained

The error happens because:
1. Railway is using the Dockerfile (which runs `npm run build` in root)
2. But you also configured workspace-specific commands
3. During the build, it's trying to run workspace commands outside the npm install context
4. The workspaces aren't found because npm hasn't installed yet

**Fix:** Use Option 1 above (Nixpacks, no Docker).
