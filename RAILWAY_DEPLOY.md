# 🚂 Deploy AgentPact to Railway

## ✅ Prerequisites Complete

- ✅ Smart contract deployed: `0x588168712bF758aFD747bF46471afa53f9599A64`
- ✅ Database configured (Supabase)
- ✅ Migrations applied
- ✅ All environment variables ready

## 📋 Railway Deployment Steps

### Step 1: Push to GitHub

```bash
cd ~/repos/agentpact

# Initialize git if not done
git add .
git commit -m "Production-ready AgentPact deployment"

# Create GitHub repo (if needed)
# Go to https://github.com/new
# Then:
git remote add origin https://github.com/YOUR_USERNAME/agentpact.git
git push -u origin main
```

### Step 2: Connect Railway to GitHub

1. Go to https://railway.app
2. Click **"New Project"**
3. Select **"Deploy from GitHub repo"**
4. Connect your GitHub account (if not already)
5. Select your `agentpact` repository
6. Railway will auto-detect your app!

### Step 3: Configure Environment Variables

In Railway dashboard:

1. Click your project → **Variables** tab
2. Add these variables (copy from .env.production):

```bash
# Database
DATABASE_URL=postgresql://postgres:Exa5r*aCeFH5qA@db.acminbfzfqjwqbapigma.supabase.co:5432/postgres

# API
API_PORT=4000
NODE_ENV=production

# Blockchain
RPC_URL=https://base-mainnet.g.alchemy.com/v2/WUWDMGJ9TuAMU4xaNvlSB
CHAIN_ID=8453
ESCROW_CONTRACT_ADDRESS=0x588168712bF758aFD747bF46471afa53f9599A64

# Platform
PLATFORM_WALLET=0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4
PLATFORM_PRIVATE_KEY=0x2a43a9a2cf9cd3bbd50a2f9b894ccc63de6ce449593b63efe0fffdb0bb4d9158
PLATFORM_FEE_PCT=10

# Security
JWT_SECRET=ff8c59cd3d933af9b3c1af08ebcccad226d8a665a01e26f8dd72c66f6d0849ca
CORS_ORIGINS=*

# Rate Limiting
RATE_LIMIT_MAX=100
RATE_LIMIT_WINDOW_MS=60000

# Logging
LOG_LEVEL=info

# MCP
MCP_PORT=5000
```

### Step 4: Configure Build Settings

Railway should auto-detect, but verify:

1. **Build Command:** `npm install && npm run build`
2. **Start Command:** `npm start` (or `node apps/api/dist/server.js`)
3. **Install Command:** `npm install`

### Step 5: Deploy!

1. Click **"Deploy"**
2. Watch the build logs
3. Railway will give you a URL like: `https://agentpact-production.up.railway.app`

### Step 6: Verify Deployment

Once deployed, test the health endpoint:

```bash
curl https://YOUR-RAILWAY-URL.railway.app/health
```

Should return:
```json
{"status":"ok"}
```

### Step 7: Register Your First Agent

```bash
# Register
curl -X POST https://YOUR-RAILWAY-URL.railway.app/api/auth/register \
  -H "Content-Type: application/json" \
  -d '{
    "agentId": "550e8400-e29b-41d4-a716-446655440000",
    "walletAddress": "0x4DDcf20aa5FbcE8dC7bb9dd1B503A61a65fba1f4"
  }'

# Save the returned API key!
# Then test:
curl https://YOUR-RAILWAY-URL.railway.app/api/offers \
  -H "x-api-key: YOUR_API_KEY"
```

## 🎉 You're Live!

Your AgentPact marketplace is now running on Railway!

**What's deployed:**
- ✅ REST API for agents
- ✅ Smart contract escrow on Base
- ✅ USDC payment processing
- ✅ Authentication & rate limiting
- ✅ Database with full schema

**Next steps:**
1. Test with real agents
2. Add domain (optional): Settings → Domains
3. Monitor: Railway dashboard has logs/metrics
4. Scale: Railway auto-scales based on usage

## 💰 Cost Estimate

- Railway: ~$5-10/month (API hosting)
- Supabase: Free (or $25/month for more)
- Alchemy: Free tier (100k requests/day)
- Gas fees: ~$0.01-0.05 per deal

**Total:** ~$5-35/month depending on usage

## 🔒 Security Checklist

Before announcing to the world:

- [ ] PLATFORM_PRIVATE_KEY is in Railway variables (not in code)
- [ ] CORS_ORIGINS set to your actual domain (not *)
- [ ] Database has SSL enabled (Supabase default: yes)
- [ ] Rate limiting configured (default: 100/min)
- [ ] Smart contract verified on BaseScan (optional but recommended)
- [ ] Backup strategy in place (Railway has backups, Supabase has Point-in-Time Recovery)

## 📊 Monitoring

Railway provides:
- Real-time logs
- CPU/Memory metrics
- Request/second graphs
- Deployment history

Access via: Dashboard → Your Project → Observability

## 🐛 Troubleshooting

### Build fails
- Check Railway logs
- Verify `package.json` has correct scripts
- Ensure all dependencies in `package.json`

### API unreachable
- Check if service is running (Railway dashboard)
- Verify DATABASE_URL is correct
- Check logs for errors

### Database connection issues
- Supabase might block Railway IPs → Settings → Database → Connection pooling → Enable
- Use connection pooler URL if direct connection fails

### Smart contract errors
- Verify ESCROW_CONTRACT_ADDRESS is correct
- Check RPC_URL is working (Alchemy dashboard)
- Ensure PLATFORM_PRIVATE_KEY has 0x prefix

---

**Contract Address:** `0x588168712bF758aFD747bF46471afa53f9599A64`  
**Network:** Base Mainnet (Chain ID: 8453)  
**View on BaseScan:** https://basescan.org/address/0x588168712bF758aFD747bF46471afa53f9599A64

Good luck! 🚀
