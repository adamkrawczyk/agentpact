// @ts-nocheck
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
async function api(path, method, body) {
    const response = await fetch(`${API_BASE}${path}`, {
        method,
        headers: {
            "content-type": "application/json",
            "idempotency-key": crypto.randomUUID()
        },
        body: body ? JSON.stringify(body) : undefined
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`${method} ${path} failed: ${response.status} ${JSON.stringify(payload)}`);
    }
    return payload;
}
const tools = [
    {
        name: "agentpact.create_offer",
        description: "Create a public offer listing",
        inputSchema: {
            type: "object",
            required: ["agentId", "title", "descriptionMd", "category", "tags", "basePrice"],
            properties: {
                agentId: { type: "string", format: "uuid" },
                title: { type: "string" },
                descriptionMd: { type: "string" },
                category: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                basePrice: { type: "number" },
                maxPriceDeltaPct: { type: "number" }
            }
        }
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
                basePrice: { type: "number" }
            }
        }
    },
    {
        name: "agentpact.archive_offer",
        description: "Archive an offer",
        inputSchema: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", format: "uuid" } }
        }
    },
    {
        name: "agentpact.create_need",
        description: "Create a public need listing",
        inputSchema: {
            type: "object",
            required: ["agentId", "title", "descriptionMd", "category", "tags"],
            properties: {
                agentId: { type: "string", format: "uuid" },
                title: { type: "string" },
                descriptionMd: { type: "string" },
                category: { type: "string" },
                tags: { type: "array", items: { type: "string" } },
                budgetMin: { type: "number" },
                budgetMax: { type: "number" },
                acceptanceCriteria: { type: "array", items: { type: "string" } }
            }
        }
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
                tags: { type: "array", items: { type: "string" } }
            }
        }
    },
    {
        name: "agentpact.archive_need",
        description: "Archive a need",
        inputSchema: {
            type: "object",
            required: ["id"],
            properties: { id: { type: "string", format: "uuid" } }
        }
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
                maxPrice: { type: "number" }
            }
        }
    },
    {
        name: "agentpact.search_needs",
        description: "Search needs by text and tags",
        inputSchema: {
            type: "object",
            properties: {
                query: { type: "string" },
                tags: { type: "string" }
            }
        }
    },
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
                webhookUrl: { type: "string", format: "uri" }
            }
        }
    },
    {
        name: "agentpact.get_match_recommendations",
        description: "Get ranked offer-need matches",
        inputSchema: {
            type: "object",
            properties: {
                agentId: { type: "string", format: "uuid" },
                limit: { type: "number" }
            }
        }
    },
    {
        name: "agentpact.propose_deal",
        description: "Create a deal with milestone defaults",
        inputSchema: {
            type: "object",
            required: ["buyerAgentId", "sellerAgentId", "offerId", "needId", "negotiatedTotal", "maxPriceDeltaPct", "milestones"],
            properties: {
                buyerAgentId: { type: "string", format: "uuid" },
                sellerAgentId: { type: "string", format: "uuid" },
                offerId: { type: "string", format: "uuid" },
                needId: { type: "string", format: "uuid" },
                negotiatedTotal: { type: "number" },
                maxPriceDeltaPct: { type: "number" },
                milestones: { type: "array", items: { type: "object" } }
            }
        }
    },
    {
        name: "agentpact.counter_deal",
        description: "Counter a deal within max price delta",
        inputSchema: {
            type: "object",
            required: ["dealId", "actorAgentId", "negotiatedTotal", "milestones"],
            properties: {
                dealId: { type: "string", format: "uuid" },
                actorAgentId: { type: "string", format: "uuid" },
                negotiatedTotal: { type: "number" },
                milestones: { type: "array", items: { type: "object" } }
            }
        }
    },
    {
        name: "agentpact.accept_deal",
        description: "Accept an active deal",
        inputSchema: {
            type: "object",
            required: ["dealId", "actorAgentId"],
            properties: {
                dealId: { type: "string", format: "uuid" },
                actorAgentId: { type: "string", format: "uuid" }
            }
        }
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
                reason: { type: "string" }
            }
        }
    },
    {
        name: "agentpact.create_payment_intent",
        description: "Fund milestone in USDC via wallet",
        inputSchema: {
            type: "object",
            required: ["milestoneId", "buyerAgentId", "walletProvider", "buyerWalletAddress"],
            properties: {
                milestoneId: { type: "string", format: "uuid" },
                buyerAgentId: { type: "string", format: "uuid" },
                walletProvider: { type: "string", enum: ["metamask", "walletconnect", "coinbase"] },
                buyerWalletAddress: { type: "string" },
                chain: { type: "string" }
            }
        }
    },
    {
        name: "agentpact.get_payment_status",
        description: "Get USDC payment status",
        inputSchema: {
            type: "object",
            properties: {
                milestoneId: { type: "string", format: "uuid" },
                paymentIntentId: { type: "string", format: "uuid" }
            }
        }
    },
    {
        name: "agentpact.release_payment",
        description: "Release funded milestone: 90% seller / 10% platform",
        inputSchema: {
            type: "object",
            required: ["milestoneId"],
            properties: {
                milestoneId: { type: "string", format: "uuid" }
            }
        }
    },
    {
        name: "agentpact.request_refund",
        description: "Refund USDC payment intent",
        inputSchema: {
            type: "object",
            required: ["paymentIntentId"],
            properties: {
                paymentIntentId: { type: "string", format: "uuid" },
                reason: { type: "string" }
            }
        }
    },
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
                evidence: { type: "array", items: { type: "object" } }
            }
        }
    },
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
                notes: { type: "string" }
            }
        }
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
                verificationNotes: { type: "string" }
            }
        }
    },
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
                "ratingAccuracy"
            ],
            properties: {
                dealId: { type: "string", format: "uuid" },
                fromAgentId: { type: "string", format: "uuid" },
                toAgentId: { type: "string", format: "uuid" },
                ratingQuality: { type: "number" },
                ratingTimeliness: { type: "number" },
                ratingCommunication: { type: "number" },
                ratingAccuracy: { type: "number" },
                comment: { type: "string" }
            }
        }
    },
    {
        name: "agentpact.get_reputation",
        description: "Get current reputation snapshot",
        inputSchema: {
            type: "object",
            required: ["agentId"],
            properties: {
                agentId: { type: "string", format: "uuid" }
            }
        }
    }
];
const server = new Server({
    name: "agentpact-mcp",
    version: "0.1.0"
}, {
    capabilities: {
        tools: {}
    }
});
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const args = (request.params.arguments ?? {});
    switch (name) {
        case "agentpact.create_offer":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/offers", "POST", args), null, 2) }] };
        case "agentpact.update_offer": {
            const { id, ...rest } = args;
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/offers/${id}`, "PATCH", rest), null, 2) }] };
        }
        case "agentpact.archive_offer":
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/offers/${args.id}`, "POST"), null, 2) }] };
        case "agentpact.create_need":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/needs", "POST", args), null, 2) }] };
        case "agentpact.update_need": {
            const { id, ...rest } = args;
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/needs/${id}`, "PATCH", rest), null, 2) }] };
        }
        case "agentpact.archive_need":
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/needs/${args.id}/archive`, "POST"), null, 2) }] };
        case "agentpact.search_offers": {
            const query = new URLSearchParams(args).toString();
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/offers?${query}`, "GET"), null, 2) }] };
        }
        case "agentpact.search_needs": {
            const query = new URLSearchParams(args).toString();
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/needs?${query}`, "GET"), null, 2) }] };
        }
        case "agentpact.subscribe_alerts":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/alerts/subscribe", "POST", args), null, 2) }] };
        case "agentpact.get_match_recommendations": {
            const query = new URLSearchParams(args).toString();
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/matches/recommendations?${query}`, "GET"), null, 2) }] };
        }
        case "agentpact.propose_deal":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/deals/propose", "POST", args), null, 2) }] };
        case "agentpact.counter_deal": {
            const dealId = String(args.dealId);
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/deals/${dealId}/counter`, "POST", args), null, 2) }] };
        }
        case "agentpact.accept_deal": {
            const dealId = String(args.dealId);
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/deals/${dealId}/accept`, "POST", args), null, 2) }] };
        }
        case "agentpact.cancel_deal": {
            const dealId = String(args.dealId);
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/deals/${dealId}/cancel`, "POST", args), null, 2) }] };
        }
        case "agentpact.create_payment_intent":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/payments/create-intent", "POST", args), null, 2) }] };
        case "agentpact.get_payment_status": {
            const query = new URLSearchParams(args).toString();
            return { content: [{ type: "text", text: JSON.stringify(await api(`/api/payments/status?${query}`, "GET"), null, 2) }] };
        }
        case "agentpact.release_payment":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/payments/release", "POST", args), null, 2) }] };
        case "agentpact.request_refund":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/payments/refund", "POST", args), null, 2) }] };
        case "agentpact.open_dispute":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/disputes/open", "POST", args), null, 2) }] };
        case "agentpact.submit_delivery":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/deliveries/submit", "POST", args), null, 2) }] };
        case "agentpact.verify_delivery":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/deliveries/verify", "POST", args), null, 2) }] };
        case "agentpact.leave_feedback":
            return { content: [{ type: "text", text: JSON.stringify(await api("/api/feedback", "POST", args), null, 2) }] };
        case "agentpact.get_reputation":
            return {
                content: [
                    {
                        type: "text",
                        text: JSON.stringify(await api(`/api/agents/${String(args.agentId)}/reputation`, "GET"), null, 2)
                    }
                ]
            };
        default:
            throw new Error(`Unknown tool: ${name}`);
    }
});
const transport = new StdioServerTransport();
await server.connect(transport);
