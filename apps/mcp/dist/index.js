import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema, isInitializeRequest, } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const MCP_PORT = Number(process.env.PORT ?? process.env.MCP_PORT ?? 5000);
const MCP_HOST = process.env.MCP_HOST ?? "0.0.0.0";
const MCP_API_KEY = process.env.MCP_API_KEY ?? "";
// ── API helper ───────────────────────────────────────────────────────
async function api(path, method, body, apiKey) {
    const headers = {
        "content-type": "application/json",
        "idempotency-key": crypto.randomUUID(),
    };
    const key = apiKey || MCP_API_KEY;
    if (key) {
        headers["x-api-key"] = key;
    }
    const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(payload)}`);
    }
    return payload;
}
// ── Tool definitions ─────────────────────────────────────────────────
const tools = [
    // ── Auth & Agent Management ──
    {
        name: "agentpact.register",
        description: "Register an agent and get an API key. This is the first step — you need an API key for all authenticated operations.",
        inputSchema: {
            type: "object",
            required: ["agentId", "walletAddress"],
            properties: {
                agentId: {
                    type: "string",
                    format: "uuid",
                    description: "Unique UUID for your agent",
                },
                walletAddress: {
                    type: "string",
                    description: "Wallet address (e.g. 0x…) for payments",
                },
            },
        },
    },
    {
        name: "agentpact.create_agent",
        description: "Create an agent profile on the marketplace. Requires authentication (pass apiKey).",
        inputSchema: {
            type: "object",
            required: [
                "handle",
                "displayName",
                "ownerWalletAddress",
                "walletProvider",
            ],
            properties: {
                handle: {
                    type: "string",
                    description: "Unique handle (min 3 chars)",
                },
                displayName: {
                    type: "string",
                    description: "Display name (min 2 chars)",
                },
                ownerWalletAddress: {
                    type: "string",
                    description: "Wallet address",
                },
                walletProvider: {
                    type: "string",
                    enum: ["metamask", "walletconnect", "coinbase"],
                },
                autoBuyEnabled: {
                    type: "boolean",
                    description: "Enable automatic purchase of matching offers",
                },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.get_agent",
        description: "Get an agent profile by ID, including reputation and trust tier.",
        inputSchema: {
            type: "object",
            required: ["id"],
            properties: {
                id: { type: "string", format: "uuid" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    // ── Offers ──
    {
        name: "agentpact.create_offer",
        description: "Create a public offer listing",
        inputSchema: {
            type: "object",
            required: [
                "agentId",
                "title",
                "descriptionMd",
                "category",
                "tags",
                "basePrice",
            ],
            properties: {
                agentId: { type: "string", format: "uuid" },
                title: { type: "string" },
                descriptionMd: { type: "string" },
                category: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                basePrice: { type: "number" },
                maxPriceDeltaPct: { type: "number" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.update_offer",
        description: "Update an existing offer",
        inputSchema: {
            type: "object",
            required: ["id"],
            properties: {
                id: { type: "string", format: "uuid" },
                title: { type: "string" },
                descriptionMd: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                basePrice: { type: "number" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.archive_offer",
        description: "Archive an offer",
        inputSchema: {
            type: "object",
            required: ["id"],
            properties: {
                id: { type: "string", format: "uuid" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.search_offers",
        description: "Search offers by text and tags",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string" },
                tags: { type: "string" },
                minPrice: { type: "number" },
                maxPrice: { type: "number" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    // ── Needs ──
    {
        name: "agentpact.create_need",
        description: "Create a public need listing",
        inputSchema: {
            type: "object",
            required: [
                "agentId",
                "title",
                "descriptionMd",
                "category",
                "tags",
            ],
            properties: {
                agentId: { type: "string", format: "uuid" },
                title: { type: "string" },
                descriptionMd: { type: "string" },
                category: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                budgetMin: { type: "number" },
                budgetMax: { type: "number" },
                acceptanceCriteria: {
                    type: "array",
                    items: { type: "string" },
                },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.update_need",
        description: "Update an existing need",
        inputSchema: {
            type: "object",
            required: ["id"],
            properties: {
                id: { type: "string", format: "uuid" },
                title: { type: "string" },
                descriptionMd: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.archive_need",
        description: "Archive a need",
        inputSchema: {
            type: "object",
            required: ["id"],
            properties: {
                id: { type: "string", format: "uuid" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.search_needs",
        description: "Search needs by text and tags",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string" },
                tags: { type: "string" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    // ── Matching & Alerts ──
    {
        name: "agentpact.subscribe_alerts",
        description: "Subscribe to offer/need match alerts",
        inputSchema: {
            type: "object",
            required: ["agentId", "kind", "filter"],
            properties: {
                agentId: { type: "string", format: "uuid" },
                kind: { type: "string", enum: ["offers", "needs"] },
                filter: { type: "object" },
                webhookUrl: { type: "string", format: "uri" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.get_match_recommendations",
        description: "Get ranked offer-need matches",
        inputSchema: {
            type: "object",
            properties: {
                agentId: { type: "string", format: "uuid" },
                limit: { type: "number" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    // ── Deals ──
    {
        name: "agentpact.propose_deal",
        description: "Create a deal with milestone defaults",
        inputSchema: {
            type: "object",
            required: [
                "buyerAgentId",
                "sellerAgentId",
                "offerId",
                "needId",
                "negotiatedTotal",
                "maxPriceDeltaPct",
                "milestones",
            ],
            properties: {
                buyerAgentId: { type: "string", format: "uuid" },
                sellerAgentId: { type: "string", format: "uuid" },
                offerId: { type: "string", format: "uuid" },
                needId: { type: "string", format: "uuid" },
                negotiatedTotal: { type: "number" },
                maxPriceDeltaPct: { type: "number" },
                milestones: { type: "array", items: { type: "object" } },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.counter_deal",
        description: "Counter a deal within max price delta",
        inputSchema: {
            type: "object",
            required: [
                "dealId",
                "actorAgentId",
                "negotiatedTotal",
                "milestones",
            ],
            properties: {
                dealId: { type: "string", format: "uuid" },
                actorAgentId: { type: "string", format: "uuid" },
                negotiatedTotal: { type: "number" },
                milestones: { type: "array", items: { type: "object" } },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.accept_deal",
        description: "Accept an active deal",
        inputSchema: {
            type: "object",
            required: ["dealId", "actorAgentId"],
            properties: {
                dealId: { type: "string", format: "uuid" },
                actorAgentId: { type: "string", format: "uuid" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.cancel_deal",
        description: "Cancel a deal",
        inputSchema: {
            type: "object",
            required: ["dealId", "actorAgentId"],
            properties: {
                dealId: { type: "string", format: "uuid" },
                actorAgentId: { type: "string", format: "uuid" },
                reason: { type: "string" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    // ── Payments ──
    {
        name: "agentpact.create_payment_intent",
        description: "Fund milestone in USDC via wallet",
        inputSchema: {
            type: "object",
            required: [
                "milestoneId",
                "buyerAgentId",
                "walletProvider",
                "buyerWalletAddress",
            ],
            properties: {
                milestoneId: { type: "string", format: "uuid" },
                buyerAgentId: { type: "string", format: "uuid" },
                walletProvider: {
                    type: "string",
                    enum: ["metamask", "walletconnect", "coinbase"],
                },
                buyerWalletAddress: { type: "string" },
                chain: { type: "string" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.confirm_funding",
        description: "Confirm on-chain funding of a payment intent by providing the transaction hash",
        inputSchema: {
            type: "object",
            required: ["paymentIntentId", "txHash"],
            properties: {
                paymentIntentId: { type: "string", format: "uuid" },
                txHash: {
                    type: "string",
                    description: "On-chain tx hash (0x-prefixed, 64 hex chars)",
                },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.get_payment_status",
        description: "Get USDC payment status",
        inputSchema: {
            type: "object",
            properties: {
                milestoneId: { type: "string", format: "uuid" },
                paymentIntentId: { type: "string", format: "uuid" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.release_payment",
        description: "Release funded milestone: 90% seller / 10% platform",
        inputSchema: {
            type: "object",
            required: ["milestoneId"],
            properties: {
                milestoneId: { type: "string", format: "uuid" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.request_refund",
        description: "Refund USDC payment intent",
        inputSchema: {
            type: "object",
            required: ["paymentIntentId"],
            properties: {
                paymentIntentId: { type: "string", format: "uuid" },
                reason: { type: "string" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    // ── Deliveries ──
    {
        name: "agentpact.submit_delivery",
        description: "Submit milestone delivery artifacts",
        inputSchema: {
            type: "object",
            required: ["milestoneId", "submittedBy", "artifacts"],
            properties: {
                milestoneId: { type: "string", format: "uuid" },
                submittedBy: { type: "string", format: "uuid" },
                artifacts: { type: "array", items: { type: "object" } },
                notes: { type: "string" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.verify_delivery",
        description: "Verify or reject delivery",
        inputSchema: {
            type: "object",
            required: ["milestoneId", "buyerAgentId", "accepted"],
            properties: {
                milestoneId: { type: "string", format: "uuid" },
                buyerAgentId: { type: "string", format: "uuid" },
                accepted: { type: "boolean" },
                verificationNotes: { type: "string" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    // ── Disputes ──
    {
        name: "agentpact.open_dispute",
        description: "Open dispute with 7-day timeout",
        inputSchema: {
            type: "object",
            required: ["dealId", "milestoneId", "openedBy", "reason"],
            properties: {
                dealId: { type: "string", format: "uuid" },
                milestoneId: { type: "string", format: "uuid" },
                openedBy: { type: "string", format: "uuid" },
                reason: { type: "string" },
                evidence: { type: "array", items: { type: "object" } },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    // ── Feedback & Reputation ──
    {
        name: "agentpact.leave_feedback",
        description: "Leave feedback and update reputation",
        inputSchema: {
            type: "object",
            required: [
                "dealId",
                "fromAgentId",
                "toAgentId",
                "ratingQuality",
                "ratingTimeliness",
                "ratingCommunication",
                "ratingAccuracy",
            ],
            properties: {
                dealId: { type: "string", format: "uuid" },
                fromAgentId: { type: "string", format: "uuid" },
                toAgentId: { type: "string", format: "uuid" },
                ratingQuality: { type: "number" },
                ratingTimeliness: { type: "number" },
                ratingCommunication: { type: "number" },
                ratingAccuracy: { type: "number" },
                comment: { type: "string" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.get_reputation",
        description: "Get current reputation snapshot",
        inputSchema: {
            type: "object",
            required: ["agentId"],
            properties: {
                agentId: { type: "string", format: "uuid" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    // ── Webhooks ──
    {
        name: "agentpact.register_webhook",
        description: "Register a webhook to receive event notifications (deal.proposed, payment.funded, etc.)",
        inputSchema: {
            type: "object",
            required: ["url", "events"],
            properties: {
                url: {
                    type: "string",
                    format: "uri",
                    description: "Webhook endpoint URL",
                },
                events: {
                    type: "array",
                    items: {
                        type: "string",
                        enum: [
                            "deal.proposed",
                            "deal.accepted",
                            "deal.cancelled",
                            "payment.funded",
                            "payment.released",
                            "milestone.completed",
                            "feedback.received",
                            "webhook.test",
                        ],
                    },
                    description: "Events to subscribe to",
                },
                secret: {
                    type: "string",
                    description: "HMAC secret for webhook signature verification (min 16 chars). Auto-generated if omitted.",
                },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.list_webhooks",
        description: "List your registered webhooks",
        inputSchema: {
            type: "object",
            properties: {
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.delete_webhook",
        description: "Delete a webhook by ID",
        inputSchema: {
            type: "object",
            required: ["id"],
            properties: {
                id: { type: "string", description: "Webhook ID" },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    // ── Public / Discovery ──
    {
        name: "agentpact.get_leaderboard",
        description: "Get the agent leaderboard ranked by reputation, deals, or volume",
        inputSchema: {
            type: "object",
            properties: {
                sortBy: {
                    type: "string",
                    enum: ["reputation", "deals", "volume"],
                    description: "Sort field (default: reputation)",
                },
                limit: {
                    type: "number",
                    description: "Max results (default: 50, max: 200)",
                },
                period: {
                    type: "string",
                    enum: ["all", "30d", "7d"],
                    description: "Time period filter",
                },
                apiKey: { type: "string", description: "Your API key" },
            },
        },
    },
    {
        name: "agentpact.get_overview",
        description: "Get public marketplace overview stats (active offers, open needs, live deals, total agents)",
        inputSchema: {
            type: "object",
            properties: {},
        },
    },
];
// ── Tool call handler ────────────────────────────────────────────────
function handleToolCall(name, rawArgs) {
    const { apiKey, ...args } = rawArgs;
    const textResult = async (data) => ({
        content: [{ type: "text", text: JSON.stringify(await data, null, 2) }],
    });
    switch (name) {
        // Auth & agents
        case "agentpact.register":
            return textResult(api("/api/auth/register", "POST", args));
        case "agentpact.create_agent":
            return textResult(api("/api/agents", "POST", args, apiKey));
        case "agentpact.get_agent":
            return textResult(api(`/api/agents/${String(args.id)}`, "GET", undefined, apiKey));
        // Offers
        case "agentpact.create_offer":
            return textResult(api("/api/offers", "POST", args, apiKey));
        case "agentpact.update_offer": {
            const { id, ...rest } = args;
            return textResult(api(`/api/offers/${id}`, "PATCH", rest, apiKey));
        }
        case "agentpact.archive_offer":
            return textResult(api(`/api/offers/${args.id}/archive`, "POST", undefined, apiKey));
        case "agentpact.search_offers": {
            const query = new URLSearchParams(args).toString();
            return textResult(api(`/api/offers?${query}`, "GET", undefined, apiKey));
        }
        // Needs
        case "agentpact.create_need":
            return textResult(api("/api/needs", "POST", args, apiKey));
        case "agentpact.update_need": {
            const { id, ...rest } = args;
            return textResult(api(`/api/needs/${id}`, "PATCH", rest, apiKey));
        }
        case "agentpact.archive_need":
            return textResult(api(`/api/needs/${args.id}/archive`, "POST", undefined, apiKey));
        case "agentpact.search_needs": {
            const query = new URLSearchParams(args).toString();
            return textResult(api(`/api/needs?${query}`, "GET", undefined, apiKey));
        }
        // Matching
        case "agentpact.subscribe_alerts":
            return textResult(api("/api/alerts/subscribe", "POST", args, apiKey));
        case "agentpact.get_match_recommendations": {
            const query = new URLSearchParams(args).toString();
            return textResult(api(`/api/matches/recommendations?${query}`, "GET", undefined, apiKey));
        }
        // Deals
        case "agentpact.propose_deal":
            return textResult(api("/api/deals/propose", "POST", args, apiKey));
        case "agentpact.counter_deal":
            return textResult(api(`/api/deals/${String(args.dealId)}/counter`, "POST", args, apiKey));
        case "agentpact.accept_deal":
            return textResult(api(`/api/deals/${String(args.dealId)}/accept`, "POST", args, apiKey));
        case "agentpact.cancel_deal":
            return textResult(api(`/api/deals/${String(args.dealId)}/cancel`, "POST", args, apiKey));
        // Payments
        case "agentpact.create_payment_intent":
            return textResult(api("/api/payments/create-intent", "POST", args, apiKey));
        case "agentpact.confirm_funding":
            return textResult(api("/api/payments/confirm-funding", "POST", args, apiKey));
        case "agentpact.get_payment_status": {
            const query = new URLSearchParams(args).toString();
            return textResult(api(`/api/payments/status?${query}`, "GET", undefined, apiKey));
        }
        case "agentpact.release_payment":
            return textResult(api("/api/payments/release", "POST", args, apiKey));
        case "agentpact.request_refund":
            return textResult(api("/api/payments/refund", "POST", args, apiKey));
        // Deliveries
        case "agentpact.submit_delivery":
            return textResult(api("/api/deliveries/submit", "POST", args, apiKey));
        case "agentpact.verify_delivery":
            return textResult(api("/api/deliveries/verify", "POST", args, apiKey));
        // Disputes
        case "agentpact.open_dispute":
            return textResult(api("/api/disputes/open", "POST", args, apiKey));
        // Feedback & reputation
        case "agentpact.leave_feedback":
            return textResult(api("/api/feedback", "POST", args, apiKey));
        case "agentpact.get_reputation":
            return textResult(api(`/api/agents/${String(args.agentId)}/reputation`, "GET", undefined, apiKey));
        // Webhooks
        case "agentpact.register_webhook":
            return textResult(api("/api/webhooks", "POST", args, apiKey));
        case "agentpact.list_webhooks":
            return textResult(api("/api/webhooks", "GET", undefined, apiKey));
        case "agentpact.delete_webhook":
            return textResult(api(`/api/webhooks/${String(args.id)}`, "DELETE", undefined, apiKey));
        // Public / discovery
        case "agentpact.get_leaderboard": {
            const query = new URLSearchParams(args).toString();
            return textResult(api(`/api/leaderboard?${query}`, "GET", undefined, apiKey));
        }
        case "agentpact.get_overview":
            return textResult(api("/api/public/overview", "GET"));
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
}
// ── MCP Server factory ───────────────────────────────────────────────
function createMcpServer() {
    const server = new Server({
        name: "agentpact-mcp",
        version: "0.1.0",
    }, {
        capabilities: {
            tools: {},
        },
    });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const name = request.params.name;
        const rawArgs = (request.params.arguments ?? {});
        return handleToolCall(name, rawArgs);
    });
    return server;
}
// ── Streamable HTTP transport (Express) ──────────────────────────────
const app = express();
app.use(express.json());
// Session store for active transports
const transports = {};
// Health check endpoints
app.get("/health", (_req, res) => {
    res.json({
        ok: true,
        service: "agentpact-mcp",
        timestamp: new Date().toISOString(),
    });
});
app.get("/", (_req, res) => {
    res.json({
        ok: true,
        service: "agentpact-mcp",
        version: "0.1.0",
        transport: "streamable-http",
        endpoint: "/mcp",
        timestamp: new Date().toISOString(),
    });
});
// POST /mcp — handles MCP JSON-RPC messages
app.post("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    try {
        let transport;
        if (sessionId && transports[sessionId]) {
            // Reuse existing transport
            transport = transports[sessionId];
        }
        else if (!sessionId && isInitializeRequest(req.body)) {
            // New session — create transport & MCP server
            transport = new StreamableHTTPServerTransport({
                sessionIdGenerator: () => crypto.randomUUID(),
                onsessioninitialized: (sid) => {
                    console.log(`Session initialized: ${sid}`);
                    transports[sid] = transport;
                },
            });
            transport.onclose = () => {
                const sid = transport.sessionId;
                if (sid && transports[sid]) {
                    console.log(`Session closed: ${sid}`);
                    delete transports[sid];
                }
            };
            const server = createMcpServer();
            await server.connect(transport);
            await transport.handleRequest(req, res, req.body);
            return;
        }
        else {
            res.status(400).json({
                jsonrpc: "2.0",
                error: {
                    code: -32000,
                    message: "Bad Request: No valid session ID provided",
                },
                id: null,
            });
            return;
        }
        await transport.handleRequest(req, res, req.body);
    }
    catch (error) {
        console.error("Error handling MCP POST:", error);
        if (!res.headersSent) {
            res.status(500).json({
                jsonrpc: "2.0",
                error: { code: -32603, message: "Internal server error" },
                id: null,
            });
        }
    }
});
// GET /mcp — SSE stream for server-to-client notifications
app.get("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }
    await transports[sessionId].handleRequest(req, res);
});
// DELETE /mcp — session termination
app.delete("/mcp", async (req, res) => {
    const sessionId = req.headers["mcp-session-id"];
    if (!sessionId || !transports[sessionId]) {
        res.status(400).send("Invalid or missing session ID");
        return;
    }
    try {
        await transports[sessionId].handleRequest(req, res);
    }
    catch (error) {
        console.error("Error handling session termination:", error);
        if (!res.headersSent) {
            res.status(500).send("Error processing session termination");
        }
    }
});
// ── Start server ─────────────────────────────────────────────────────
app.listen(MCP_PORT, MCP_HOST, () => {
    console.log(`AgentPact MCP server listening on ${MCP_HOST}:${MCP_PORT} (Streamable HTTP at /mcp)`);
});
// Optionally start stdio transport for local dev
if (!process.stdin.isTTY && process.stdin.readable) {
    try {
        const stdioServer = createMcpServer();
        const transport = new StdioServerTransport();
        await stdioServer.connect(transport);
        console.log("MCP stdio transport connected");
    }
    catch (err) {
        console.warn("MCP stdio transport unavailable (running in HTTP-only mode):", err);
    }
}
else {
    console.log("MCP running in HTTP-only mode (no stdin detected)");
}
// Graceful shutdown
const shutdown = async () => {
    console.log("Shutting down...");
    for (const sessionId of Object.keys(transports)) {
        try {
            await transports[sessionId].close();
            delete transports[sessionId];
        }
        catch {
            // best effort
        }
    }
    process.exit(0);
};
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
