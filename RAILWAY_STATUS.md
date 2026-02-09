# 🔧 Railway Deployment Status & Fixes

## ✅ What's Working

### API Service (agentpactapi-production.up.railway.app)
- ✅ Deployed successfully
- ✅ Health endpoint working: `/health`
- ✅ API is running
- 🔴 **Database connection failing** (IPv6/connection pooling issue)

### MCP Service (agentpactmcp-production.up.railway.app)
- ❓ MCP is a **stdio-based server**, not HTTP
- ❌ **Should NOT be deployed as a web service**
- MCP is meant to run locally and connect to AI assistants
- **Action:** You can stop/delete this Railway service

### Web Service (agentpactweb-production.up.railway.app)
- ⚠️ Deployed but routes not working (404 on `/`)
- Possible build issue or missing files

---

## 🔴 Critical Fix: Database Connection

Your API can't connect to Supabase. Fix this first:

### Step 1: Get Supabase Connection Pooler URL

1. Go to **Supabase Dashboard**: https://supabase.com/dashboard
2. Select your project: `acminbfzfqjwqbapigma`
3. Settings → Database → **Connection Pooling** section
4. Copy the **"Transaction" mode** connection string

It should look like:
```
postgresql://postgres.acminbfzfqjwqbapigma:Exa5r*aCeFH5qA@aws-0-us-east-1.pooler.supabase.com:6543/postgres
```

Key changes from direct connection:
- Host: `pooler.supabase.com` (instead of `db.supabase.co`)
- Port: `6543` (instead of `5432`)

### Step 2: Update Railway DATABASE_URL

1. Railway → **agentpactapi** service → Variables
2. Find `DATABASE_URL`
3. Replace with the pooler URL from Step 1
4. Click "Redeploy"

### Step 3: Verify Fix

After redeployment:
```bash
curl https://agentpactapi-production.up.railway.app/health/detailed
```

Should show `"database": { "status": "healthy" }`

---

## 🚂 Railway Health Check Configuration

### For API Service:

Railway → agentpactapi → Settings → Health Check:

- **Health Check Path:** `/health`
- **Health Check Timeout:** `5`
- **Health Check Interval:** `30`
- **Health Check Grace Period:** `20`

---

## ❌ Services to Remove/Stop

### MCP Service
**Why:** MCP servers use stdio (standard input/output), not HTTP. They're meant to be run locally by AI assistants (like Claude Desktop), not as web services.

**Action:**
1. Railway → agentpactmcp service → Settings
2. Scroll to bottom → "Delete Service"

You'll run MCP locally when needed with:
```bash
cd ~/repos/agentpact
npm run dev -w @agentpact/mcp
```

---

## ⚠️ Web Service Issues

The web service is deployed but returning 404s. This might be because:

1. **Build didn't complete properly**
2. **Missing source files**
3. **Wrong Dockerfile target**

### Debug Web Service:

Check Railway logs:
1. Railway → agentpactweb → Deployments → Latest
2. Click "View Logs"
3. Look for build errors or missing files

### Temporary Fix:

Since the API is the most important part, you can:
- Stop the web service for now
- Focus on getting API + Database working
- Deploy web later once API is stable

Or we can create a separate Dockerfile for web service.

---

## 📋 Current Priority Order:

1. ✅ **Fix API database connection** (use Supabase connection pooler)
2. ✅ **Configure API health checks**
3. ❌ **Delete MCP service** (not needed as web service)
4. ⚠️ **Debug web service** (or deploy later)

---

## 🧪 Test Your API

Once database is connected, test creating an agent:

```bash
# Register first agent
curl -X POST https://agentpactapi-production.up.railway.app/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "550e8400-e29b-41d4-a716-446655440000",
    "walletAddress": "0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"
  }'

# Save the returned API key!

# Test with API key:
curl https://agentpactapi-production.up.railway.app/api/offers \
  -H "x-api-key: YOUR_API_KEY_HERE"
```

---

## 📊 Final Architecture

After fixes, you should have:

- ✅ **API Service** (Railway): Handles all backend logic
- ✅ **Database** (Supabase): Stores all data
- ✅ **Smart Contract** (Base): Handles USDC payments
- ✅ **MCP Server** (Local): Run when needed for AI assistant integration
- ⚠️ **Web UI** (Optional): Can deploy later or use API directly

---

**Next steps:**
1. Get Supabase connection pooler URL
2. Update Railway DATABASE_URL
3. Redeploy and test `/health/detailed`
4. Register your first agent!

Let me know when you have the pooler URL and I'll help you complete the setup! 🚀
