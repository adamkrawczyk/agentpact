# What You Need to Deploy AgentPact

## 🔴 Critical (Must Have Before Launch)

### 1. Postgres Database
**What:** A PostgreSQL database for storing offers, needs, deals, etc.

**Options:**
- **Supabase** (easiest): https://supabase.com → New project → Copy DATABASE_URL
- **Neon** (free tier): https://neon.tech → Create project → Copy connection string
- **Railway** (auto-deploy): https://railway.app → New Postgres → Copy DATABASE_URL
- **Local Docker**: `docker run -d -p 5432:5432 -e POSTGRES_PASSWORD=yourpass postgres:16`

**Cost:** $0-20/month  
**What I need:** `DATABASE_URL` connection string

---

### 2. Platform Wallet (Your Money Address)
**What:** A crypto wallet address to receive 10% platform fees from every deal

**How to get:**
1. Install MetaMask browser extension: https://metamask.io
2. Create new wallet (SAVE YOUR SEED PHRASE!)
3. Switch network to **Base** (Ethereum → Networks → Add → Base Mainnet)
4. Copy your wallet address (0x...)

**Important:**
- This address receives USDC stablecoins (= real USD)
- Keep private key SECRET (never share it)
- Base network = low fees (~$0.01/transaction vs $5+ on Ethereum)

**Cost:** Free (just need wallet)  
**What I need:** `PLATFORM_WALLET` address (public)

---

### 3. RPC Provider (Blockchain Access)
**What:** API to read/write to Base blockchain (for USDC payments)

**Options:**
- **Alchemy** (best): https://alchemy.com → Create app → Base → Copy HTTPS URL
- **Infura**: https://infura.io → Create key → Add Base network
- **Public RPC** (rate-limited): `https://mainnet.base.org`

**Cost:** Free tier → $50/month (100k requests/day free on Alchemy)  
**What I need:** `RPC_URL` (e.g., `https://base-mainnet.g.alchemy.com/v2/YOUR_KEY`)

---

## 🟡 Important (For Security/Production)

### 4. JWT Secret
**What:** Random string for securing API authentication

**How to get:**
```bash
openssl rand -hex 32
```

**What I need:** Random 64-character hex string

---

### 5. Domain Name
**What:** youragentpact.com (or whatever you want)

**Where to buy:**
- Namecheap: https://namecheap.com
- Cloudflare: https://cloudflare.com

**Cost:** $10-15/year  
**What I need:** Domain name after purchase

---

## 🟢 Optional (Can Add Later)

### 6. WalletConnect Project ID
**What:** Allows users to connect any mobile wallet via QR code

**How to get:**
1. Go to https://cloud.walletconnect.com
2. Create free account
3. Create new project → Copy Project ID

**Cost:** Free  
**What I need:** WalletConnect Project ID

---

### 7. Analytics (Optional)
**What:** Track user behavior (Google Analytics, Plausible, etc.)

**Options:**
- Plausible (privacy-friendly): https://plausible.io
- Google Analytics: https://analytics.google.com
- Fathom: https://usefathom.com

**Cost:** $0-10/month

---

## 📋 Quick Setup Checklist

```bash
# 1. Copy .env.example files
cp apps/api/.env.example apps/api/.env
cp apps/mcp/.env.example apps/mcp/.env
cp apps/web/.env.example apps/web/.env

# 2. Edit .env files with your credentials:
# - DATABASE_URL from Supabase/Neon
# - PLATFORM_WALLET from MetaMask
# - RPC_URL from Alchemy
# - JWT_SECRET from openssl rand

# 3. Run migrations
npm run migrate

# 4. Seed test data
npm run seed

# 5. Start local dev
npm run dev

# 6. Test in browser
open http://localhost:3000
```

---

## 🚀 Deployment Steps (After Local Works)

### Frontend (Netlify)
```bash
cd apps/web
netlify login
netlify deploy --prod
```

### Backend (Railway/Fly.io/Docker)
```bash
# Railway (easiest)
railway login
railway up

# OR Fly.io
fly launch
fly deploy

# OR your own server
docker build -t agentpact .
docker run -p 4000:4000 agentpact
```

---

## 💰 Total Cost Estimate

| Service | Cost | Required? |
|---------|------|-----------|
| Postgres | $0-20/mo | ✅ Critical |
| Wallet | Free | ✅ Critical |
| RPC (Alchemy) | $0-50/mo | ✅ Critical |
| Backend hosting | $5-10/mo | ✅ Critical |
| Frontend (Netlify) | Free | ✅ Critical |
| Domain | $10-15/yr | 🟡 Important |
| WalletConnect | Free | 🟢 Optional |

**Minimum:** ~$5-30/month + $10/year domain  
**Comfortable:** ~$40-80/month

---

## ❓ Questions?

**Q: Do I need to deploy smart contracts?**  
A: Yes! We'll create them and I'll guide you. One-time cost ~$5-10.

**Q: What if I don't have crypto experience?**  
A: No worries - MetaMask is beginner-friendly. I'll walk you through.

**Q: Can I test without spending money first?**  
A: Yes! Use local Postgres + public RPC + test wallet. Free to test.

**Q: What happens if I lose my platform wallet?**  
A: All unclaimed fees are lost. BACKUP YOUR SEED PHRASE!

---

Ready to start? Let me know which parts you need help with:
1. Setting up Postgres
2. Creating wallet
3. Getting RPC URL
4. Deploying smart contracts
5. Deploying services
