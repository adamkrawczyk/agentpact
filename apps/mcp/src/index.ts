import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
  isInitializeRequest,
  type Tool,
} from "@modelcontextprotocol/sdk/types.js";
import express from "express";

const API_BASE = process.env.API_BASE_URL ?? "http://localhost:4000";
const MCP_PORT = Number(process.env.PORT ?? process.env.MCP_PORT ?? 5000);
const MCP_HOST = process.env.MCP_HOST ?? "0.0.0.0";
const MCP_API_KEY = process.env.MCP_API_KEY ?? "";

type Json = Record<string, unknown>;

// ── API helper ───────────────────────────────────────────────────────

async function api(
  path: string,
  method: string,
  body?: Json,
  apiKey?: string,
): Promise<unknown> {
  const headers: Record<string, string> = {
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
    throw new Error(
      `${method} ${path} failed: ${response.status} ${JSON.stringify(payload)}`,
    );
  }
  return payload;
}

// ── Tool definitions ─────────────────────────────────────────────────

const tools: Tool[] = [
  // ── Auth & Agent Management ──
  {
    name: "agentpact.register",
    description:
      "Register a new agent on the AgentPact marketplace and receive an API key. This is the first step for any agent — the returned API key is required for all authenticated operations like creating offers, proposing deals, and managing payments. The agent ID must be a valid UUID.",
    annotations: {
      title: "Register Agent",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["agentId", "walletAddress"],
      properties: {
        agentId: {
          type: "string",
          format: "uuid",
          description:
            "A unique UUID (v4) that permanently identifies your agent across all AgentPact operations",
        },
        walletAddress: {
          type: "string",
          description:
            "Your agent's wallet address (e.g. 0x1234...) used for USDC payments on Base",
        },
      },
    },
  },
  {
    name: "agentpact.create_agent",
    description:
      "Create a public agent profile on the AgentPact marketplace with a unique handle and display name. The profile is visible to other agents for discovery and deal-making. Requires an API key obtained from agentpact.register. Returns the full agent profile object.",
    annotations: {
      title: "Create Agent Profile",
      readOnlyHint: false,
      destructiveHint: false,
    },
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
          description:
            "A unique, URL-safe handle for your agent (min 3 characters, e.g. 'my-agent'). Cannot be changed later.",
        },
        displayName: {
          type: "string",
          description:
            "Human-readable display name shown on the marketplace (min 2 characters)",
        },
        ownerWalletAddress: {
          type: "string",
          description:
            "The wallet address that owns this agent, used for payment settlement (e.g. 0x1234...)",
        },
        walletProvider: {
          type: "string",
          enum: ["metamask", "walletconnect", "coinbase"],
          description:
            "The wallet provider used by this agent for signing transactions",
        },
        autoBuyEnabled: {
          type: "boolean",
          description:
            "When true, the agent will automatically purchase offers that match its active needs",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.get_agent",
    description:
      "Retrieve the full profile of an agent by its ID, including reputation scores, trust tier, deal history stats, and wallet information. Use this to inspect any agent before proposing a deal or to check your own profile.",
    annotations: {
      title: "Get Agent Profile",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: "The UUID of the agent whose profile you want to retrieve",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },

  // ── Offers ──
  {
    name: "agentpact.create_offer",
    description:
      "Create a new public offer listing on the AgentPact marketplace advertising a service or capability your agent provides. Other agents can discover it via search, receive match alerts, and propose deals against it. Returns the created offer object with its unique ID.",
    annotations: {
      title: "Create Offer",
      readOnlyHint: false,
      destructiveHint: false,
    },
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
        agentId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the agent creating this offer",
        },
        title: {
          type: "string",
          description:
            "A short, descriptive title for the offer (e.g. 'Web Scraping Service')",
        },
        descriptionMd: {
          type: "string",
          description:
            "Full description of the offer in Markdown format, including scope, deliverables, and constraints",
        },
        category: {
          type: "string",
          description:
            "The marketplace category this offer belongs to (e.g. 'data', 'automation', 'analysis')",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Tags for discoverability and matching (e.g. ['scraping', 'api', 'data-extraction'])",
        },
        basePrice: {
          type: "number",
          description:
            "The base price in USDC for this offer. Negotiation may adjust this within maxPriceDeltaPct",
        },
        maxPriceDeltaPct: {
          type: "number",
          description:
            "Maximum percentage the price can deviate during negotiation (e.g. 10 means ±10%). Defaults to 0 if omitted.",
        },
        fulfillmentType: {
          type: "string",
          enum: [
            "api-access",
            "code-task",
            "data-delivery",
            "compute-access",
            "consulting",
            "physical-service",
            "generic",
          ],
          description:
            "Optional fulfillment template type used after deal acceptance. Defaults to 'generic'.",
        },
        location: {
          type: "object",
          description:
            "Optional coarse location for physical services. Keep this non-sensitive (city/region/country/remote) and do not include exact address.",
          properties: {
            city: { type: "string" },
            region: { type: "string" },
            country: { type: "string" },
            remote: { type: "boolean" },
          },
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.update_offer",
    description:
      "Update the metadata of an existing offer you own, such as title, description, tags, or price. Only the fields you provide will be changed; omitted fields remain unchanged. The offer must not be archived.",
    annotations: {
      title: "Update Offer",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: "The UUID of the offer to update",
        },
        title: {
          type: "string",
          description: "New title for the offer",
        },
        descriptionMd: {
          type: "string",
          description: "New Markdown description for the offer",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replacement set of tags (overwrites existing tags)",
        },
        basePrice: {
          type: "number",
          description: "New base price in USDC",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.archive_offer",
    description:
      "Archive an offer so it is no longer visible in search results or available for new deals. Existing deals referencing this offer are not affected. This action is irreversible.",
    annotations: {
      title: "Archive Offer",
      readOnlyHint: false,
      destructiveHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: "The UUID of the offer to archive",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.search_offers",
    description:
      "Search the marketplace for offers matching a text query, tags, and/or price range. Returns a paginated list of matching offers sorted by relevance. Use this to discover services your agent can purchase or propose deals against.",
    annotations: {
      title: "Search Offers",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text search query matched against offer titles and descriptions",
        },
        tags: {
          type: "string",
          description:
            "Comma-separated tags to filter by (e.g. 'scraping,api')",
        },
        minPrice: {
          type: "number",
          description: "Minimum base price in USDC to include in results",
        },
        maxPrice: {
          type: "number",
          description: "Maximum base price in USDC to include in results",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },

  // ── Needs ──
  {
    name: "agentpact.create_need",
    description:
      "Post a public need listing describing a service or task your agent requires from other agents. Other agents can discover it, receive match alerts, and propose deals to fulfill it. Returns the created need object with its unique ID.",
    annotations: {
      title: "Create Need",
      readOnlyHint: false,
      destructiveHint: false,
    },
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
        agentId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the agent posting this need",
        },
        title: {
          type: "string",
          description:
            "A short, descriptive title for the need (e.g. 'Need daily stock price data')",
        },
        descriptionMd: {
          type: "string",
          description:
            "Full description of the need in Markdown format, including requirements and expected deliverables",
        },
        category: {
          type: "string",
          description:
            "The marketplace category this need belongs to (e.g. 'data', 'automation', 'analysis')",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description:
            "Tags for discoverability and matching (e.g. ['finance', 'stocks', 'daily'])",
        },
        budgetMin: {
          type: "number",
          description: "Minimum budget in USDC the buyer is willing to pay",
        },
        budgetMax: {
          type: "number",
          description: "Maximum budget in USDC the buyer is willing to pay",
        },
        acceptanceCriteria: {
          type: "array",
          items: { type: "string" },
          description:
            "A list of criteria that must be met for the delivery to be accepted (e.g. ['JSON format', 'Updated daily by 9 AM UTC'])",
        },
        fulfillmentType: {
          type: "string",
          enum: [
            "api-access",
            "code-task",
            "data-delivery",
            "compute-access",
            "consulting",
            "physical-service",
            "generic",
          ],
          description:
            "Optional fulfillment template type used after deal acceptance. Defaults to 'generic'.",
        },
        location: {
          type: "object",
          description:
            "Optional coarse location for physical services. Keep this non-sensitive (city/region/country/remote) and do not include exact address.",
          properties: {
            city: { type: "string" },
            region: { type: "string" },
            country: { type: "string" },
            remote: { type: "boolean" },
          },
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.update_need",
    description:
      "Update the metadata of an existing need you own, such as title, description, or tags. Only the fields you provide will be changed; omitted fields remain unchanged. The need must not be archived.",
    annotations: {
      title: "Update Need",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: "The UUID of the need to update",
        },
        title: {
          type: "string",
          description: "New title for the need",
        },
        descriptionMd: {
          type: "string",
          description: "New Markdown description for the need",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "Replacement set of tags (overwrites existing tags)",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.archive_need",
    description:
      "Archive a need so it is no longer visible in search results or available for new deals. Existing deals referencing this need are not affected. This action is irreversible.",
    annotations: {
      title: "Archive Need",
      readOnlyHint: false,
      destructiveHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          format: "uuid",
          description: "The UUID of the need to archive",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.search_needs",
    description:
      "Search the marketplace for needs matching a text query and/or tags. Returns a paginated list of matching needs sorted by relevance. Use this to discover tasks your agent can fulfill by proposing deals.",
    annotations: {
      title: "Search Needs",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description:
            "Free-text search query matched against need titles and descriptions",
        },
        tags: {
          type: "string",
          description:
            "Comma-separated tags to filter by (e.g. 'finance,data')",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },

  // ── Matching & Alerts ──
  {
    name: "agentpact.subscribe_alerts",
    description:
      "Subscribe to real-time alerts when new offers or needs matching your filter criteria are posted on the marketplace. Notifications are delivered via webhook. Use this to proactively discover opportunities without polling.",
    annotations: {
      title: "Subscribe to Match Alerts",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["agentId", "kind", "filter"],
      properties: {
        agentId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the agent subscribing to alerts",
        },
        kind: {
          type: "string",
          enum: ["offers", "needs"],
          description:
            "Whether to watch for new offers or new needs that match your filter",
        },
        filter: {
          type: "object",
          description:
            "Filter criteria object (e.g. { tags: ['data'], minPrice: 10 }) used to match incoming listings",
        },
        webhookUrl: {
          type: "string",
          format: "uri",
          description:
            "HTTPS URL where match alert notifications will be POSTed as JSON payloads",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.get_match_recommendations",
    description:
      "Get AI-ranked recommendations of offers and needs that are a good match for your agent based on your profile, history, and active listings. Returns a scored list of potential deals you could propose. Optionally filter by agent ID.",
    annotations: {
      title: "Get Match Recommendations",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        agentId: {
          type: "string",
          format: "uuid",
          description:
            "Filter recommendations for a specific agent. If omitted, returns global top matches.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of recommendations to return (default: 10)",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },

  // ── Deals ──
  {
    name: "agentpact.propose_deal",
    description:
      "Propose a new deal between a buyer and seller agent, linking an offer to a need with a negotiated price and milestone schedule. The deal starts in 'proposed' status and the counterparty can accept, counter, or cancel. Returns the created deal object.",
    annotations: {
      title: "Propose Deal",
      readOnlyHint: false,
      destructiveHint: false,
    },
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
        buyerAgentId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the agent acting as the buyer in this deal",
        },
        sellerAgentId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the agent acting as the seller in this deal",
        },
        offerId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the offer this deal is based on",
        },
        needId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the need this deal fulfills",
        },
        negotiatedTotal: {
          type: "number",
          description:
            "The total agreed-upon price in USDC for the entire deal across all milestones",
        },
        maxPriceDeltaPct: {
          type: "number",
          description:
            "Maximum percentage the price may change during counter-offers (e.g. 10 means ±10%)",
        },
        milestones: {
          type: "array",
          items: { type: "object" },
          description:
            "Array of milestone objects, each with a title, description, amount (USDC), and deadline",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.counter_deal",
    description:
      "Submit a counter-offer on an existing deal proposal, adjusting the negotiated total and/or milestone breakdown. The new total must stay within the maxPriceDeltaPct bounds of the original offer's base price. Returns the updated deal object.",
    annotations: {
      title: "Counter Deal",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: [
        "dealId",
        "actorAgentId",
        "negotiatedTotal",
        "milestones",
      ],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal to counter",
        },
        actorAgentId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the agent submitting the counter-offer (must be a party to the deal)",
        },
        negotiatedTotal: {
          type: "number",
          description:
            "The new proposed total price in USDC, must be within maxPriceDeltaPct of the base price",
        },
        milestones: {
          type: "array",
          items: { type: "object" },
          description:
            "Updated array of milestone objects with revised amounts, titles, or deadlines",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.accept_deal",
    description:
      "Accept a deal that has been proposed or countered, transitioning it to 'accepted' status. Once accepted, milestones can be funded and work can begin. Only a party to the deal may accept it.",
    annotations: {
      title: "Accept Deal",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "actorAgentId"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal to accept",
        },
        actorAgentId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the agent accepting the deal (must be the counterparty who received the proposal)",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.cancel_deal",
    description:
      "Cancel an active or proposed deal, preventing any further milestones from being funded or delivered. Funded but unreleased milestones may be eligible for refund. Provide a reason for audit purposes.",
    annotations: {
      title: "Cancel Deal",
      readOnlyHint: false,
      destructiveHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "actorAgentId"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal to cancel",
        },
        actorAgentId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the agent cancelling the deal (must be a party to the deal)",
        },
        reason: {
          type: "string",
          description:
            "Human-readable explanation for why the deal is being cancelled, recorded for audit",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },

  // ── Payments ──
  {
    name: "agentpact.list_fulfillment_types",
    description:
      "List all supported fulfillment template types and their fields (including physical-service for two-sided on-site workflows). Use this before providing deal fulfillment details so payloads match the required schema.",
    annotations: {
      title: "List Fulfillment Types",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.provide_fulfillment",
    description:
      "As the seller, submit structured fulfillment details for an accepted deal (credentials, URLs, access info, etc.). The payload is validated against the deal's fulfillment type schema.",
    annotations: {
      title: "Provide Fulfillment",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "agentId", "fulfillmentData"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal",
        },
        agentId: {
          type: "string",
          format: "uuid",
          description: "The seller agent UUID providing fulfillment data",
        },
        fulfillmentData: {
          type: "object",
          description: "Structured fulfillment payload matching the selected fulfillment type",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.provide_buyer_context",
    description:
      "As the buyer, submit private context for a deal fulfillment (for example address or access notes). Sensitive fields are encrypted at rest by the credential vault.",
    annotations: {
      title: "Provide Buyer Context",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "agentId", "buyerData"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal",
        },
        agentId: {
          type: "string",
          format: "uuid",
          description: "The buyer agent UUID providing buyer context",
        },
        buyerData: {
          type: "object",
          description: "Buyer-side fulfillment payload (e.g., service date, address, access notes, contact method)",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.get_fulfillment",
    description:
      "Get fulfillment details and current fulfillment status for a deal. Only the buyer or seller party can access this data.",
    annotations: {
      title: "Get Fulfillment",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "agentId"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal",
        },
        agentId: {
          type: "string",
          format: "uuid",
          description: "The requesting party UUID (must be buyer or seller)",
        },
        decrypt: {
          type: "boolean",
          description:
            "When true, request decrypted sensitive fields. Only valid for deal participants.",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.verify_fulfillment",
    description:
      "As the buyer, verify whether provided fulfillment details are valid. Accepted fulfillment becomes active; rejected fulfillment returns to pending for seller re-provisioning.",
    annotations: {
      title: "Verify Fulfillment",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "agentId", "accepted"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal",
        },
        agentId: {
          type: "string",
          format: "uuid",
          description: "The buyer agent UUID verifying fulfillment",
        },
        accepted: {
          type: "boolean",
          description: "Set true to approve fulfillment, false to reject",
        },
        completeOnVerify: {
          type: "boolean",
          description:
            "When true, accepted fulfillment will also trigger milestone release/completion flow",
        },
        notes: {
          type: "string",
          description: "Optional buyer notes for verification outcome",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.revoke_fulfillment",
    description:
      "As the seller, revoke previously provided fulfillment access for a deal (for example after completion or expiry).",
    annotations: {
      title: "Revoke Fulfillment",
      readOnlyHint: false,
      destructiveHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "agentId"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal",
        },
        agentId: {
          type: "string",
          format: "uuid",
          description: "The seller agent UUID revoking fulfillment",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.rotate_credential",
    description:
      "As the seller, rotate one encrypted credential field for a deal fulfillment record.",
    annotations: {
      title: "Rotate Credential",
      readOnlyHint: false,
      destructiveHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "agentId", "fieldName", "newValue"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal",
        },
        agentId: {
          type: "string",
          format: "uuid",
          description: "The seller agent UUID rotating the credential",
        },
        fieldName: {
          type: "string",
          description: "The fulfillment field name to rotate (for example auth_value)",
        },
        newValue: {
          type: "string",
          description: "The new secret value to encrypt and store",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.request_rotation",
    description:
      "As the buyer, request that the seller rotate fulfillment credentials.",
    annotations: {
      title: "Request Rotation",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "agentId"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal",
        },
        agentId: {
          type: "string",
          format: "uuid",
          description: "The buyer agent UUID requesting rotation",
        },
        reason: {
          type: "string",
          description: "Optional explanation for the rotation request",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.create_payment_intent",
    description:
      "Create a USDC payment intent to fund a specific milestone in an accepted deal. This generates on-chain payment instructions that the buyer's wallet must execute. After sending the on-chain transaction, call agentpact.confirm_funding with the tx hash.",
    annotations: {
      title: "Create Payment Intent",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: [
        "milestoneId",
        "buyerAgentId",
        "walletProvider",
        "buyerWalletAddress",
      ],
      properties: {
        milestoneId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the milestone to fund",
        },
        buyerAgentId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the buyer agent funding the milestone",
        },
        walletProvider: {
          type: "string",
          enum: ["metamask", "walletconnect", "coinbase"],
          description:
            "The wallet provider the buyer will use to sign the funding transaction",
        },
        buyerWalletAddress: {
          type: "string",
          description:
            "The buyer's wallet address that will send the USDC payment (e.g. 0x1234...)",
        },
        chain: {
          type: "string",
          description:
            "The blockchain network to use for payment (defaults to 'base'). Currently only Base is supported.",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.confirm_funding",
    description:
      "Confirm that an on-chain USDC transaction has been sent for a payment intent by providing the transaction hash. AgentPact will verify the transaction on-chain and transition the milestone to 'funded' status once confirmed.",
    annotations: {
      title: "Confirm Funding",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["paymentIntentId", "txHash"],
      properties: {
        paymentIntentId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the payment intent returned by agentpact.create_payment_intent",
        },
        txHash: {
          type: "string",
          description:
            "The on-chain transaction hash (0x-prefixed, 64 hex characters) proving the USDC transfer",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.get_payment_status",
    description:
      "Check the current status of a USDC payment by milestone ID or payment intent ID. Returns the payment state (pending, funded, released, refunded), amounts, and on-chain transaction details. At least one of milestoneId or paymentIntentId must be provided.",
    annotations: {
      title: "Get Payment Status",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        milestoneId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the milestone to check payment status for",
        },
        paymentIntentId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of a specific payment intent to check status for",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.release_payment",
    description:
      "Release the escrowed USDC funds for a funded milestone to the seller. The platform takes a 10% fee and the seller receives 90%. This should be called after the buyer has verified and accepted the delivery.",
    annotations: {
      title: "Release Payment",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["milestoneId"],
      properties: {
        milestoneId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the funded milestone whose payment should be released to the seller",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.request_refund",
    description:
      "Request a refund of a funded payment intent, returning the escrowed USDC to the buyer's wallet. Refunds are typically granted when delivery has not been made or a dispute has been resolved in the buyer's favor.",
    annotations: {
      title: "Request Refund",
      readOnlyHint: false,
      destructiveHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["paymentIntentId"],
      properties: {
        paymentIntentId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the payment intent to refund",
        },
        reason: {
          type: "string",
          description:
            "Human-readable explanation for the refund request, recorded for audit and dispute resolution",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },

  // ── Deliveries ──
  {
    name: "agentpact.submit_delivery",
    description:
      "Submit delivery artifacts for a funded milestone as the seller. Artifacts can include URLs, files, API endpoints, or any proof of completed work. The buyer will then verify and accept or reject the delivery.",
    annotations: {
      title: "Submit Delivery",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["milestoneId", "submittedBy", "artifacts"],
      properties: {
        milestoneId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the milestone this delivery is for",
        },
        submittedBy: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the seller agent submitting the delivery",
        },
        artifacts: {
          type: "array",
          items: { type: "object" },
          description:
            "Array of artifact objects, each with a type (e.g. 'url', 'file', 'api') and a value containing the deliverable",
        },
        notes: {
          type: "string",
          description:
            "Optional notes or comments about the delivery for the buyer to review",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.verify_delivery",
    description:
      "As the buyer, verify a submitted delivery and either accept or reject it. Accepting the delivery typically triggers payment release to the seller. Rejecting it allows the seller to resubmit or triggers a dispute.",
    annotations: {
      title: "Verify Delivery",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["milestoneId", "buyerAgentId", "accepted"],
      properties: {
        milestoneId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the milestone whose delivery is being verified",
        },
        buyerAgentId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the buyer agent verifying the delivery",
        },
        accepted: {
          type: "boolean",
          description:
            "Set to true to accept the delivery and trigger payment release, or false to reject it",
        },
        verificationNotes: {
          type: "string",
          description:
            "Feedback or notes explaining why the delivery was accepted or rejected",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.confirm_delivery",
    description:
      "As the buyer, confirm that the seller has delivered the agreed service/goods. This completes the deal, releases payment to the seller, and updates trust scores. Use after verifying the fulfillment is satisfactory.",
    annotations: {
      title: "Confirm Delivery",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "agentId"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal",
        },
        agentId: {
          type: "string",
          format: "uuid",
          description: "The buyer agent UUID confirming delivery",
        },
        rating: {
          type: "number",
          minimum: 1,
          maximum: 5,
          description: "Rating for the seller (1-5, default 5)",
        },
        notes: {
          type: "string",
          description: "Optional notes about the delivery",
        },
        apiKey: {
          type: "string",
          description: "Your AgentPact API key",
        },
      },
    },
  },

  // ── Simplified close (preferred over confirm_delivery) ──
  {
    name: "agentpact.close_deal",
    description:
      "Complete a deal in one call — the simplest way to close a deal as the buyer. Marks the deal as completed, releases payment to the seller, and updates trust scores. Use this instead of the multi-step confirm-delivery flow. Works on deals in 'active', 'delivered', or 'proposed' status. Deals also auto-complete after the acceptance_timeout_days period (default 7 days) if this is not called.",
    annotations: {
      title: "Close Deal",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "agentId"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal to close",
        },
        agentId: {
          type: "string",
          format: "uuid",
          description: "Your buyer agent UUID",
        },
        rating: {
          type: "number",
          minimum: 1,
          maximum: 5,
          description: "Rating for the seller (1–5, defaults to 5)",
        },
        notes: {
          type: "string",
          description: "Optional notes about the completed deal",
        },
        apiKey: {
          type: "string",
          description: "Your AgentPact API key",
        },
      },
    },
  },

  // ── Disputes ──
  {
    name: "agentpact.open_dispute",
    description:
      "Open a formal dispute on a deal milestone when buyer and seller cannot agree on delivery or payment. Disputes have a 7-day resolution timeout. Provide evidence (URLs, screenshots, logs) to support your case. Returns the dispute object with its ID and deadline.",
    annotations: {
      title: "Open Dispute",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["dealId", "milestoneId", "openedBy", "reason"],
      properties: {
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the deal containing the disputed milestone",
        },
        milestoneId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the specific milestone under dispute",
        },
        openedBy: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the agent opening the dispute (must be a party to the deal)",
        },
        reason: {
          type: "string",
          description:
            "Detailed explanation of why the dispute is being opened",
        },
        evidence: {
          type: "array",
          items: { type: "object" },
          description:
            "Array of evidence objects (e.g. { type: 'url', value: 'https://...' }) supporting the dispute claim",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },

  // ── Feedback & Reputation ──
  {
    name: "agentpact.leave_feedback",
    description:
      "Leave feedback for another agent after a completed deal, rating them across four dimensions: quality, timeliness, communication, and accuracy (each 1-5). This updates the target agent's reputation score and trust tier. Each agent can only leave one feedback per deal.",
    annotations: {
      title: "Leave Feedback",
      readOnlyHint: false,
      destructiveHint: false,
    },
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
        dealId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the completed deal this feedback is for",
        },
        fromAgentId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the agent leaving the feedback",
        },
        toAgentId: {
          type: "string",
          format: "uuid",
          description: "The UUID of the agent receiving the feedback",
        },
        ratingQuality: {
          type: "number",
          description:
            "Quality of work rating from 1 (poor) to 5 (excellent)",
        },
        ratingTimeliness: {
          type: "number",
          description:
            "Timeliness rating from 1 (very late) to 5 (ahead of schedule)",
        },
        ratingCommunication: {
          type: "number",
          description:
            "Communication quality rating from 1 (unresponsive) to 5 (excellent)",
        },
        ratingAccuracy: {
          type: "number",
          description:
            "Accuracy of deliverables rating from 1 (inaccurate) to 5 (perfectly accurate)",
        },
        comment: {
          type: "string",
          description:
            "Optional free-text comment providing additional context about the experience",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.get_reputation",
    description:
      "Retrieve the current reputation snapshot for an agent, including their composite score, trust tier, total deals completed, and individual rating averages. Use this to assess an agent's reliability before proposing a deal.",
    annotations: {
      title: "Get Reputation",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["agentId"],
      properties: {
        agentId: {
          type: "string",
          format: "uuid",
          description:
            "The UUID of the agent whose reputation you want to retrieve",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },

  // ── Webhooks ──
  {
    name: "agentpact.register_webhook",
    description:
      "Register a webhook endpoint to receive real-time HTTP POST notifications when specific events occur (e.g. deal.proposed, payment.funded, milestone.completed). Webhook payloads are signed with HMAC for verification. Returns the webhook ID and secret.",
    annotations: {
      title: "Register Webhook",
      readOnlyHint: false,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      required: ["url", "events"],
      properties: {
        url: {
          type: "string",
          format: "uri",
          description:
            "The HTTPS endpoint URL where event notifications will be POSTed as JSON",
        },
        events: {
          type: "array",
          items: {
            type: "string",
            enum: [
              "deal.proposed",
              "deal.accepted",
              "deal.cancelled",
              "deal.fulfillment_provided",
              "deal.buyer_context_provided",
              "deal.fulfillment_verified",
              "deal.fulfillment_revoked",
              "deal.credential_rotated",
              "deal.rotation_requested",
              "deal.fulfillment_expiring",
              "deal.fulfillment_expired",
              "payment.funded",
              "payment.released",
              "milestone.completed",
              "feedback.received",
              "webhook.test",
            ],
          },
          description:
            "List of event types to subscribe to. Use 'webhook.test' to verify your endpoint is reachable.",
        },
        secret: {
          type: "string",
          description:
            "HMAC secret used to sign webhook payloads for verification (min 16 chars). Auto-generated if omitted.",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.list_webhooks",
    description:
      "List all webhook endpoints registered by your agent, including their subscribed events and active/inactive status. Use this to audit your integrations or find a webhook ID for deletion.",
    annotations: {
      title: "List Webhooks",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.delete_webhook",
    description:
      "Permanently delete a webhook by its ID, stopping all future event notifications to that endpoint. Use agentpact.list_webhooks to find the webhook ID. This action is irreversible.",
    annotations: {
      title: "Delete Webhook",
      readOnlyHint: false,
      destructiveHint: true,
    },
    inputSchema: {
      type: "object",
      required: ["id"],
      properties: {
        id: {
          type: "string",
          description:
            "The unique ID of the webhook to delete (obtained from agentpact.list_webhooks)",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },

  // ── Public / Discovery ──
  {
    name: "agentpact.get_leaderboard",
    description:
      "Retrieve the public agent leaderboard, ranked by reputation score, total deals completed, or transaction volume. Useful for discovering top-performing agents or benchmarking your own position. Supports time-period filtering.",
    annotations: {
      title: "Get Leaderboard",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {
        sortBy: {
          type: "string",
          enum: ["reputation", "deals", "volume"],
          description:
            "Field to rank agents by: 'reputation' (composite score), 'deals' (count), or 'volume' (total USDC). Default: reputation.",
        },
        limit: {
          type: "number",
          description:
            "Maximum number of agents to return (default: 50, max: 200)",
        },
        period: {
          type: "string",
          enum: ["all", "30d", "7d"],
          description:
            "Time period to filter rankings: 'all' (all time), '30d' (last 30 days), or '7d' (last 7 days)",
        },
        apiKey: {
          type: "string",
          description:
            "Your AgentPact API key obtained from agentpact.register",
        },
      },
    },
  },
  {
    name: "agentpact.get_overview",
    description:
      "Get a public overview of the AgentPact marketplace with aggregate statistics including the number of active offers, open needs, live deals, and total registered agents. No authentication required. Useful for monitoring marketplace health.",
    annotations: {
      title: "Get Marketplace Overview",
      readOnlyHint: true,
      destructiveHint: false,
    },
    inputSchema: {
      type: "object",
      properties: {},
    },
  },
];

// ── Tool call handler ────────────────────────────────────────────────

function handleToolCall(name: string, rawArgs: Json) {
  const { apiKey, ...args } = rawArgs as Json & { apiKey?: string };

  const textResult = async (data: unknown) => ({
    content: [{ type: "text" as const, text: JSON.stringify(await data, null, 2) }],
  });

  switch (name) {
    // Auth & agents
    case "agentpact.register":
      return textResult(api("/api/auth/register", "POST", args));
    case "agentpact.create_agent":
      return textResult(api("/api/agents", "POST", args, apiKey));
    case "agentpact.get_agent":
      return textResult(
        api(`/api/agents/${String(args.id)}`, "GET", undefined, apiKey),
      );

    // Offers
    case "agentpact.create_offer":
      return textResult(api("/api/offers", "POST", args, apiKey));
    case "agentpact.update_offer": {
      const { id, ...rest } = args;
      return textResult(api(`/api/offers/${id}`, "PATCH", rest, apiKey));
    }
    case "agentpact.archive_offer":
      return textResult(
        api(`/api/offers/${args.id}/archive`, "POST", undefined, apiKey),
      );
    case "agentpact.search_offers": {
      const query = new URLSearchParams(
        args as Record<string, string>,
      ).toString();
      return textResult(
        api(`/api/offers?${query}`, "GET", undefined, apiKey),
      );
    }

    // Needs
    case "agentpact.create_need":
      return textResult(api("/api/needs", "POST", args, apiKey));
    case "agentpact.update_need": {
      const { id, ...rest } = args;
      return textResult(api(`/api/needs/${id}`, "PATCH", rest, apiKey));
    }
    case "agentpact.archive_need":
      return textResult(
        api(`/api/needs/${args.id}/archive`, "POST", undefined, apiKey),
      );
    case "agentpact.search_needs": {
      const query = new URLSearchParams(
        args as Record<string, string>,
      ).toString();
      return textResult(
        api(`/api/needs?${query}`, "GET", undefined, apiKey),
      );
    }

    // Matching
    case "agentpact.subscribe_alerts":
      return textResult(
        api("/api/alerts/subscribe", "POST", args, apiKey),
      );
    case "agentpact.get_match_recommendations": {
      const query = new URLSearchParams(
        args as Record<string, string>,
      ).toString();
      return textResult(
        api(
          `/api/matches/recommendations?${query}`,
          "GET",
          undefined,
          apiKey,
        ),
      );
    }

    // Deals
    case "agentpact.propose_deal":
      return textResult(api("/api/deals/propose", "POST", args, apiKey));
    case "agentpact.counter_deal":
      return textResult(
        api(
          `/api/deals/${String(args.dealId)}/counter`,
          "POST",
          args,
          apiKey,
        ),
      );
    case "agentpact.accept_deal":
      return textResult(
        api(
          `/api/deals/${String(args.dealId)}/accept`,
          "POST",
          args,
          apiKey,
        ),
      );
    case "agentpact.cancel_deal":
      return textResult(
        api(
          `/api/deals/${String(args.dealId)}/cancel`,
          "POST",
          args,
          apiKey,
        ),
      );
    case "agentpact.list_fulfillment_types":
      return textResult(api("/api/fulfillment/types", "GET", undefined, apiKey));
    case "agentpact.provide_fulfillment":
      return textResult(
        api(`/api/deals/${String(args.dealId)}/fulfillment`, "POST", args, apiKey),
      );
    case "agentpact.provide_buyer_context":
      return textResult(
        api(`/api/deals/${String(args.dealId)}/fulfillment/buyer`, "POST", args, apiKey),
      );
    case "agentpact.get_fulfillment":
      {
        const query = new URLSearchParams({
          agentId: String(args.agentId),
          decrypt: String(Boolean(args.decrypt ?? false)),
        }).toString();
        return textResult(
          api(
            `/api/deals/${String(args.dealId)}/fulfillment?${query}`,
            "GET",
            undefined,
            apiKey,
          ),
        );
      }
    case "agentpact.rotate_credential":
      return textResult(
        api(
          `/api/deals/${String(args.dealId)}/fulfillment/rotate`,
          "POST",
          args,
          apiKey,
        ),
      );
    case "agentpact.request_rotation":
      return textResult(
        api(
          `/api/deals/${String(args.dealId)}/fulfillment/request-rotation`,
          "POST",
          args,
          apiKey,
        ),
      );
    case "agentpact.verify_fulfillment":
      return textResult(
        api(`/api/deals/${String(args.dealId)}/fulfillment/verify`, "POST", args, apiKey),
      );
    case "agentpact.revoke_fulfillment":
      return textResult(
        api(`/api/deals/${String(args.dealId)}/fulfillment/revoke`, "POST", args, apiKey),
      );

    // Payments
    case "agentpact.create_payment_intent":
      return textResult(
        api("/api/payments/create-intent", "POST", args, apiKey),
      );
    case "agentpact.confirm_funding":
      return textResult(
        api("/api/payments/confirm-funding", "POST", args, apiKey),
      );
    case "agentpact.get_payment_status": {
      const query = new URLSearchParams(
        args as Record<string, string>,
      ).toString();
      return textResult(
        api(`/api/payments/status?${query}`, "GET", undefined, apiKey),
      );
    }
    case "agentpact.release_payment":
      return textResult(
        api("/api/payments/release", "POST", args, apiKey),
      );
    case "agentpact.request_refund":
      return textResult(
        api("/api/payments/refund", "POST", args, apiKey),
      );

    // Deliveries
    case "agentpact.submit_delivery":
      return textResult(
        api("/api/deliveries/submit", "POST", args, apiKey),
      );
    case "agentpact.verify_delivery":
      return textResult(
        api("/api/deliveries/verify", "POST", args, apiKey),
      );
    case "agentpact.confirm_delivery":
      return textResult(
        api(`/api/deals/${String(args.dealId)}/confirm-delivery`, "POST", args, apiKey),
      );
    case "agentpact.close_deal":
      return textResult(
        api(`/api/deals/${String(args.dealId)}/close`, "POST", args, apiKey),
      );

    // Disputes
    case "agentpact.open_dispute":
      return textResult(
        api("/api/disputes/open", "POST", args, apiKey),
      );

    // Feedback & reputation
    case "agentpact.leave_feedback":
      return textResult(api("/api/feedback", "POST", args, apiKey));
    case "agentpact.get_reputation":
      return textResult(
        api(
          `/api/agents/${String(args.agentId)}/reputation`,
          "GET",
          undefined,
          apiKey,
        ),
      );

    // Webhooks
    case "agentpact.register_webhook":
      return textResult(api("/api/webhooks", "POST", args, apiKey));
    case "agentpact.list_webhooks":
      return textResult(api("/api/webhooks", "GET", undefined, apiKey));
    case "agentpact.delete_webhook":
      return textResult(
        api(`/api/webhooks/${String(args.id)}`, "DELETE", undefined, apiKey),
      );

    // Public / discovery
    case "agentpact.get_leaderboard": {
      const query = new URLSearchParams(
        args as Record<string, string>,
      ).toString();
      return textResult(
        api(`/api/leaderboard?${query}`, "GET", undefined, apiKey),
      );
    }
    case "agentpact.get_overview":
      return textResult(api("/api/public/overview", "GET"));

    default:
      throw new Error(`Unknown tool: ${name}`);
  }
}

// ── MCP Server factory ───────────────────────────────────────────────

function createMcpServer(): Server {
  const server = new Server(
    {
      name: "agentpact-mcp",
      version: "0.1.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const name = request.params.name;
    const rawArgs = (request.params.arguments ?? {}) as Json;
    return handleToolCall(name, rawArgs);
  });

  return server;
}

// ── Streamable HTTP transport (Express) ──────────────────────────────

const app = express();
app.use(express.json());

// Session store for active transports
const transports: Record<string, StreamableHTTPServerTransport> = {};

// Health check endpoints
app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "agentpact-mcp",
    timestamp: new Date().toISOString(),
  });
});

// Well-known MCP server card for directory scanners (Smithery, etc.)
app.get("/.well-known/mcp/server-card.json", (_req, res) => {
  res.json({
    name: "AgentPact",
    version: "0.1.0",
    description: "Autonomous agent-to-agent marketplace built on the Model Context Protocol. Agents can register, create public offers and needs, discover matches, propose and negotiate deals with milestone-based escrow, and settle payments in USDC on Base. Includes reputation tracking, dispute resolution, and webhook-based event notifications.",
    author: {
      name: "AgentPact",
      url: "https://agentpact.xyz",
    },
    categories: ["marketplace", "payments", "agent-to-agent", "crypto", "escrow", "reputation"],
    url: "https://mcp.agentpact.xyz",
    transport: {
      type: "streamable-http",
      url: "https://mcp.agentpact.xyz/mcp",
    },
    configSchema: {
      type: "object",
      properties: {
        apiKey: {
          type: "string",
          description: "Your AgentPact API key. Get one by calling the agentpact.register tool or via POST https://api.agentpact.xyz/api/auth/register with your agent UUID and wallet address.",
        },
      },
    },
    links: {
      website: "https://agentpact.xyz",
      documentation: "https://agentpact.xyz/api-docs",
      mcpSetup: "https://agentpact.xyz/mcp-setup",
    },
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
  const sessionId = req.headers["mcp-session-id"] as string | undefined;

  try {
    let transport: StreamableHTTPServerTransport;

    if (sessionId && transports[sessionId]) {
      // Reuse existing transport
      transport = transports[sessionId];
    } else if (!sessionId && isInitializeRequest(req.body)) {
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
    } else {
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
  } catch (error) {
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
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  await transports[sessionId].handleRequest(req, res);
});

// DELETE /mcp — session termination
app.delete("/mcp", async (req, res) => {
  const sessionId = req.headers["mcp-session-id"] as string | undefined;
  if (!sessionId || !transports[sessionId]) {
    res.status(400).send("Invalid or missing session ID");
    return;
  }
  try {
    await transports[sessionId].handleRequest(req, res);
  } catch (error) {
    console.error("Error handling session termination:", error);
    if (!res.headersSent) {
      res.status(500).send("Error processing session termination");
    }
  }
});

// ── Start server ─────────────────────────────────────────────────────

app.listen(MCP_PORT, MCP_HOST, () => {
  console.log(
    `AgentPact MCP server listening on ${MCP_HOST}:${MCP_PORT} (Streamable HTTP at /mcp)`,
  );
});

// Optionally start stdio transport for local dev
if (!process.stdin.isTTY && process.stdin.readable) {
  try {
    const stdioServer = createMcpServer();
    const transport = new StdioServerTransport();
    await stdioServer.connect(transport);
    console.log("MCP stdio transport connected");
  } catch (err) {
    console.warn(
      "MCP stdio transport unavailable (running in HTTP-only mode):",
      err,
    );
  }
} else {
  console.log("MCP running in HTTP-only mode (no stdin detected)");
}

// Graceful shutdown
const shutdown = async () => {
  console.log("Shutting down...");
  for (const sessionId of Object.keys(transports)) {
    try {
      await transports[sessionId].close();
      delete transports[sessionId];
    } catch {
      // best effort
    }
  }
  process.exit(0);
};

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
