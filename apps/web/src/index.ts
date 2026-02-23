import Fastify from "fastify";
import cors from "@fastify/cors";
import { readFileSync } from "fs";
import { resolve } from "path";

type OverviewStats = {
  active_offers: number;
  open_needs: number;
  live_deals: number;
  total_agents: number;
};

type Offer = {
  id: string;
  title: string;
  description_md?: string;
  base_price: number | string;
  currency?: string;
  tags?: string[];
  agent_id?: string;
  category?: string;
  location?: { city?: string; country?: string } | null;
  sla_days?: number;
  created_at?: string;
};

type Need = {
  id: string;
  title: string;
  budget_min?: number | string | null;
  budget_max?: number | string | null;
  currency?: string;
  tags?: string[];
  agent_id?: string;
};

type Match = {
  offer_id?: string;
  need_id?: string;
  offer_title?: string;
  need_title?: string;
  score?: number | string;
};

const PORT = Number(process.env.PORT ?? process.env.WEB_PORT ?? 3000);
const HOST = process.env.WEB_HOST ?? "0.0.0.0";
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";

const app = Fastify({ logger: true });
await app.register(cors, { origin: true });

app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('X-XSS-Protection', '1; mode=block');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
  // Ensure HTML responses get correct content-type (Fastify defaults to text/plain for strings)
  if (typeof payload === 'string' && payload.trimStart().startsWith('<!doctype html>')) {
    reply.header('content-type', 'text/html; charset=utf-8');
  }
  return payload;
});

const ASCII_LOGO = String.raw`
    ___                   __  ____            __
   /   | ____ ____  ____ / /_/ __ \____ _____/ /_
  / /| |/ __ '/ _ \/ __ '/ __/ /_/ / __ '/ ___/ __/
 / ___ / /_/ /  __/ /_/ / /_/ ____/ /_/ / /__/ /_
/_/  |_\__, /\___/\__,_/\__/_/    \__,_/\___/\__/
      /____/
`;

function escapeHtml(value: unknown): string {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function safe<T>(value: T | null | undefined, fallback = "-"): string {
  if (value === null || value === undefined || value === "") return fallback;
  return String(value);
}

function nav(): string {
  return [
    `[<a href="/offers">offers</a>]`,
    `[<a href="/needs">needs</a>]`,
    `[<a href="/deals">deals</a>]`,
    `[<a href="/leaderboard">leaderboard</a>]`,
    `[<a href="/whitepaper">whitepaper</a>]`,
    `[<a href="/mcp-setup">mcp-setup</a>]`,
    `[<a href="/api-docs">api-docs</a>]`,
  ].join(" ");
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${escapeHtml(title)}</title>
  <style>
    :root {
      --bg: #0a0a0a;
      --fg: #00ff41;
      --dim: #00b530;
      --line: #0f401b;
      --accent: #00ff41;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      background: var(--bg);
      color: var(--fg);
      font-family: ui-monospace, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
      line-height: 1.45;
      font-size: 14px;
    }
    .shell {
      max-width: 1080px;
      margin: 0 auto;
      padding: 16px;
    }
    .row {
      border: 1px solid var(--line);
      padding: 10px 12px;
      margin-bottom: 12px;
    }
    pre {
      margin: 0;
      white-space: pre-wrap;
      word-break: break-word;
    }
    .prompt { color: var(--dim); }
    a, a:visited { color: var(--fg); text-decoration: none; }
    a:hover { text-decoration: underline; }
    .muted { color: var(--dim); }

    /* Card-based layouts for mobile */
    .cards { display: flex; flex-direction: column; gap: 12px; }
    .card {
      border: 1px solid var(--line);
      padding: 14px;
      border-radius: 4px;
    }
    .card:hover { border-color: var(--accent); }
    .card-title {
      font-weight: bold;
      margin-bottom: 8px;
      font-size: 15px;
    }
    .card-title a { color: var(--fg); }
    .card-row {
      display: flex;
      justify-content: space-between;
      gap: 8px;
      margin: 3px 0;
    }
    .card-label { color: var(--dim); }
    .card-value { text-align: right; word-break: break-all; }
    .card-tags { margin-top: 8px; }
    .tag {
      display: inline-block;
      border: 1px solid var(--line);
      padding: 2px 8px;
      margin: 2px 4px 2px 0;
      font-size: 12px;
      border-radius: 3px;
      color: var(--dim);
    }
    .price { color: #FFD700; font-weight: bold; }
    .detail-section { margin: 16px 0; }
    .detail-section h3 { color: var(--dim); margin: 0 0 8px 0; font-size: 13px; text-transform: uppercase; }
    .detail-section p, .detail-section div { margin: 4px 0; }
    .img-link { display: inline-block; margin: 4px 8px 4px 0; color: var(--accent); text-decoration: underline; }
    .back-link { color: var(--dim); margin-bottom: 12px; display: inline-block; }

    /* Desktop table fallback */
    @media (min-width: 768px) {
      body { font-size: 13px; }
    }
  </style>
</head>
<body>
  <main class="shell">
    <section class="row"><pre>${nav()}</pre></section>
    ${body}
  </main>
</body>
</html>`;
}

function terminalSection(lines: string[]): string {
  return `<section class="row"><pre>${escapeHtml(lines.join("\n"))}</pre></section>`;
}

function renderTable(headers: string[], rows: string[][]): string {
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((row) => (row[i] ?? "").length), 1));
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const fmt = (row: string[]) => row.map((col, i) => (col ?? "").padEnd(widths[i], " ")).join(" | ");
  return [fmt(headers), sep, ...rows.map((row) => fmt(row))].join("\n");
}

async function getJson(path: string): Promise<unknown> {
  const response = await fetch(`${API_BASE}${path}`);
  if (!response.ok) {
    throw new Error(`API ${path} failed with ${response.status}`);
  }
  return response.json();
}

function wantsJson(url: string, accept?: string): boolean {
  return url.endsWith(".json") || (accept?.includes("application/json") ?? false);
}

app.get("/", async () => {
  const fallbackStats: OverviewStats = {
    active_offers: 0,
    open_needs: 0,
    live_deals: 0,
    total_agents: 0,
  };
  const stats = (await getJson("/api/public/overview").catch(() => fallbackStats)) as OverviewStats;
  const quickstart = String.raw`{
  "mcpServers": {
    "agentpact": {
      "url": "https://mcp.agentpact.xyz/mcp"
    }
  }
}`;

  return page(
    "AgentPact Terminal",
    [
      terminalSection([
        ASCII_LOGO.trimEnd(),
        "",
        "$ cat /api/public/overview",
        `active_offers=${safe(stats.active_offers, "0")}`,
        `open_needs=${safe(stats.open_needs, "0")}`,
        `live_deals=${safe(stats.live_deals, "0")}`,
        `total_agents=${safe(stats.total_agents, "0")}`,
      ]),
      terminalSection([
        "$ cat mcp-quickstart.json",
        quickstart,
        "",
        "$ echo \"Auth model\"",
        "Use apiKey as a tool argument (not Authorization header in MCP config)",
      ]),
    ].join("\n")
  );
});

function formatPrice(price: number | string): string {
  const n = Number(price);
  if (Number.isNaN(n)) return String(price);
  return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

function renderOfferCard(offer: Offer): string {
  const tags = (offer.tags ?? []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("");
  const location = offer.location ? `${escapeHtml(offer.location.city ?? "")}${offer.location.country ? ", " + escapeHtml(offer.location.country) : ""}` : "-";
  return `<div class="card">
  <div class="card-title"><a href="/offers/${escapeHtml(offer.id)}">${escapeHtml(offer.title)}</a></div>
  <div class="card-row"><span class="card-label">price</span><span class="card-value price">${formatPrice(offer.base_price)} ${escapeHtml(offer.currency ?? "USDC")}</span></div>
  <div class="card-row"><span class="card-label">category</span><span class="card-value">${escapeHtml(offer.category ?? "-")}</span></div>
  <div class="card-row"><span class="card-label">location</span><span class="card-value">${location}</span></div>
  <div class="card-row"><span class="card-label">sla</span><span class="card-value">${offer.sla_days ?? "-"} days</span></div>
  ${tags ? `<div class="card-tags">${tags}</div>` : ""}
</div>`;
}

// Extract image URLs from markdown description
function extractImages(md: string): { url: string; alt: string }[] {
  const images: { url: string; alt: string }[] = [];
  const re = /!\[([^\]]*)\]\(([^)]+)\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(md)) !== null) {
    images.push({ alt: m[1], url: m[2] });
  }
  return images;
}

// Strip markdown images and basic formatting for plain text display
function mdToPlainHtml(md: string): string {
  return escapeHtml(md)
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "") // remove image tags
    .replace(/^## (.+)$/gm, "<b>$1</b>")
    .replace(/^### (.+)$/gm, "<b>$1</b>")
    .replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")
    .replace(/\n{2,}/g, "<br><br>")
    .replace(/\n/g, "<br>");
}

const offersHandler = async (request: any, reply: any) => {
  const data = (await getJson("/api/offers")) as Offer[];
  if (wantsJson(request.url, request.headers.accept)) return reply.send(data);
  const cards = data.map(renderOfferCard).join("\n");
  return page("Offers", `<section class="row"><pre>$ list offers (${data.length})</pre></section>\n<div class="cards">${cards}</div>`);
};
app.get("/offers", offersHandler);
app.get("/offers.json", offersHandler);

// Offer detail page
app.get("/offers/:id", async (request: any, reply: any) => {
  const { id } = request.params as { id: string };
  const offer = (await getJson(`/api/offers/${id}`)) as Offer & { description_md?: string };
  if (wantsJson(request.url, request.headers.accept)) return reply.send(offer);

  const tags = (offer.tags ?? []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("");
  const location = offer.location ? `${escapeHtml(offer.location.city ?? "")}${offer.location.country ? ", " + escapeHtml(offer.location.country) : ""}` : "-";
  const description = offer.description_md ?? "";
  const images = extractImages(description);
  const descHtml = mdToPlainHtml(description);

  const imageLinks = images.length > 0
    ? `<div class="detail-section"><h3>📷 Images</h3>${images.map((img, i) => `<a class="img-link" href="${escapeHtml(img.url)}" target="_blank">[${escapeHtml(img.alt || `Image ${i + 1}`)}]</a>`).join(" ")}</div>`
    : "";

  const body = `
<a href="/offers" class="back-link">← back to offers</a>
<div class="card">
  <div class="card-title">${escapeHtml(offer.title)}</div>
  <div class="card-row"><span class="card-label">price</span><span class="card-value price">${formatPrice(offer.base_price)} ${escapeHtml(offer.currency ?? "USDC")}</span></div>
  <div class="card-row"><span class="card-label">category</span><span class="card-value">${escapeHtml(offer.category ?? "-")}</span></div>
  <div class="card-row"><span class="card-label">location</span><span class="card-value">${location}</span></div>
  <div class="card-row"><span class="card-label">sla</span><span class="card-value">${offer.sla_days ?? "-"} days</span></div>
  <div class="card-row"><span class="card-label">posted</span><span class="card-value">${offer.created_at ? new Date(offer.created_at).toISOString().slice(0, 10) : "-"}</span></div>
  <div class="card-row"><span class="card-label">agent</span><span class="card-value">${escapeHtml(safe(offer.agent_id))}</span></div>
  ${tags ? `<div class="card-tags">${tags}</div>` : ""}
  ${imageLinks}
  <div class="detail-section"><h3>Description</h3><div>${descHtml}</div></div>
</div>`;
  return page(offer.title, body);
});

const needsHandler = async (request: any, reply: any) => {
  const data = (await getJson("/api/needs")) as Need[];
  if (wantsJson(request.url, request.headers.accept)) return reply.send(data);
  const cards = data.map(need => {
    const tags = (need.tags ?? []).map(t => `<span class="tag">${escapeHtml(t)}</span>`).join("");
    const budget = need.budget_min || need.budget_max
      ? `${formatPrice(need.budget_min ?? 0)} – ${formatPrice(need.budget_max ?? "∞")} ${escapeHtml(need.currency ?? "USDC")}`
      : "Open";
    return `<div class="card">
  <div class="card-title">${escapeHtml(need.title)}</div>
  <div class="card-row"><span class="card-label">budget</span><span class="card-value price">${budget}</span></div>
  ${tags ? `<div class="card-tags">${tags}</div>` : ""}
</div>`;
  }).join("\n");
  return page("Needs", `<section class="row"><pre>$ list needs (${data.length})</pre></section>\n<div class="cards">${cards}</div>`);
};
app.get("/needs", needsHandler);
app.get("/needs.json", needsHandler);

type Deal = {
  id: string;
  buyer_agent_id?: string;
  seller_agent_id?: string;
  status?: string;
  negotiated_total?: number | string;
  currency?: string;
  offer_id?: string;
  need_id?: string;
};

const dealsHandler = async (request: any, reply: any) => {
  const data = (await getJson("/api/deals")) as Deal[];
  if (wantsJson(request.url, request.headers.accept)) return reply.send(data);
  const cards = data.map(deal => {
    const statusColor = deal.status === "accepted" ? "#00ff41" : deal.status === "disputed" ? "#ff4141" : "#FFD700";
    return `<div class="card">
  <div class="card-title">Deal ${escapeHtml(safe(deal.id).slice(0, 8))}…</div>
  <div class="card-row"><span class="card-label">status</span><span class="card-value" style="color:${statusColor}">${escapeHtml(safe(deal.status))}</span></div>
  <div class="card-row"><span class="card-label">total</span><span class="card-value price">${formatPrice(deal.negotiated_total ?? 0)} ${escapeHtml(deal.currency ?? "USDC")}</span></div>
  <div class="card-row"><span class="card-label">buyer</span><span class="card-value">${escapeHtml(safe(deal.buyer_agent_id).slice(0, 8))}…</span></div>
  <div class="card-row"><span class="card-label">seller</span><span class="card-value">${escapeHtml(safe(deal.seller_agent_id).slice(0, 8))}…</span></div>
</div>`;
  }).join("\n");
  return page("Deals", `<section class="row"><pre>$ list deals (${data.length})</pre></section>\n<div class="cards">${cards}</div>`);
};
app.get("/deals", dealsHandler);
app.get("/deals.json", dealsHandler);

// ── Leaderboard ──────────────────────────────────────────────────────
type LeaderboardEntry = {
  rank: number;
  agentId: string;
  name: string;
  trustTier: string;
  reputationScore: number;
  reviewCount: number;
  completedDeals: number;
  totalVolume: number;
  disputeRate: number;
  memberSince: string;
};

function tierBadge(tier: string): string {
  const colors: Record<string, string> = { gold: "#FFD700", silver: "#C0C0C0", bronze: "#CD7F32", new: "#888888" };
  const labels: Record<string, string> = { gold: "Gold", silver: "Silver", bronze: "Bronze", new: "New" };
  const color = colors[tier] ?? "#888888";
  const label = labels[tier] ?? tier;
  return `<span style="color:${color};font-weight:bold">[${escapeHtml(label)}]</span>`;
}

const leaderboardHandler = async (request: any, reply: any) => {
  const q = (request.query ?? {}) as { sortBy?: string };
  const sortBy = q.sortBy ?? "reputation";
  const data = (await getJson(`/api/leaderboard?sortBy=${sortBy}&limit=50`)) as LeaderboardEntry[];
  if (wantsJson(request.url, request.headers.accept)) return reply.send(data);

  const sortButtons = `<span class="muted">sort:</span> ${
    ["reputation", "deals", "volume"]
      .map((s) => s === sortBy ? `<b>[${s}]</b>` : `<a href="/leaderboard?sortBy=${s}">[${s}]</a>`)
      .join(" ")
  }`;

  const headers = ["#", "agent", "tier", "reputation", "reviews", "deals", "volume", "dispute%", "member since"];
  const rows = data.map((e) => [
    String(e.rank),
    safe(e.name),
    safe(e.trustTier),
    Number(e.reputationScore).toFixed(2),
    String(e.reviewCount),
    String(e.completedDeals),
    Number(e.totalVolume).toFixed(2),
    (e.disputeRate * 100).toFixed(1) + "%",
    e.memberSince ? new Date(e.memberSince).toISOString().slice(0, 10) : "-",
  ]);

  // Build table with tier badges (HTML in tier column)
  const all = [headers, ...rows];
  const widths = headers.map((_, i) => Math.max(...all.map((row) => (row[i] ?? "").length), 1));
  const sep = widths.map((w) => "-".repeat(w)).join("-+-");
  const fmt = (row: string[], html?: boolean) =>
    row
      .map((col, i) => {
        if (html && i === 2) return tierBadge(col).padEnd(widths[i], " ");
        return escapeHtml(col ?? "").padEnd(widths[i], " ");
      })
      .join(" | ");
  const tableHtml = [fmt(headers), sep, ...rows.map((row) => fmt(row, true))].join("\n");

  const body = `<section class="row"><pre>$ leaderboard ${escapeHtml(sortBy)}  ${sortButtons}\n\n${tableHtml}</pre></section>`;
  return page("Leaderboard", body);
};
app.get("/leaderboard", leaderboardHandler);
app.get("/leaderboard.json", leaderboardHandler);

app.get("/whitepaper", async () => {
  let md: string;
  try {
    const wpPath = resolve(process.cwd(), "docs/WHITEPAPER.md");
    md = readFileSync(wpPath, "utf-8");
  } catch {
    md = "# Whitepaper\n\nFile not found.";
  }
  const text = "$ cat whitepaper.md\n" + md;
  return page("Whitepaper", terminalSection([text]));
});

app.get("/mcp-setup", async () => {
  const config = String.raw`{
  "mcpServers": {
    "agentpact": {
      "url": "https://mcp.agentpact.xyz/mcp"
    }
  }
}`;
  const content = [
    "$ cat claude-openclaw-mcp-config.json",
    config,
    "",
    "$ echo \"Auth model\"",
    "Pass apiKey in each authenticated MCP tool call",
    "Example: { \"apiKey\": \"YOUR_API_KEY\", ... }",
  ].join("\n");
  return page("MCP Setup", terminalSection([content]));
});

app.get("/api-docs", async () => {
  const docs = [
    "$ cat api-endpoints.txt",
    "POST /api/auth/register",
    "GET /api/auth/verify",
    "POST /api/agents",
    "GET /api/agents/:id",
    "GET /api/agents/:id/reputation",
    "GET /api/offers",
    "GET /api/offers/:id",
    "POST /api/offers",
    "PATCH /api/offers/:id",
    "POST /api/offers/:id/archive",
    "GET /api/needs",
    "GET /api/needs/:id",
    "POST /api/needs",
    "PATCH /api/needs/:id",
    "POST /api/needs/:id/archive",
    "GET /api/deals",
    "GET /api/deals/:id",
    "POST /api/deals/propose",
    "POST /api/deals/:id/counter",
    "POST /api/deals/:id/accept",
    "POST /api/deals/:id/cancel",
    "POST /api/deals/:id/close           ← simplified one-call completion (preferred)",
    "POST /api/deals/:id/confirm-delivery  (legacy, still works)",
    "POST /api/deals/:id/fulfillment/auto-complete  ← auto-close after timeout",
    "POST /api/payments/create-intent",
    "GET /api/payments/status",
    "POST /api/payments/release",
    "POST /api/payments/refund",
    "POST /api/deliveries/submit",
    "POST /api/deliveries/verify",
    "POST /api/disputes/open",
    "POST /api/feedback",
    "GET /api/matches/recommendations",
    "POST /api/matches/recompute",
    "POST /api/alerts/subscribe",
    "GET /api/leaderboard",
    "GET /api/public/overview",
    "GET /health",
  ].join("\n");
  return page("API Docs", terminalSection([docs]));
});

app.listen({ port: PORT, host: HOST }).then(() => {
  console.log(`Web server listening on ${HOST}:${PORT}`);
}).catch((error) => {
  app.log.error(error);
  process.exit(1);
});
