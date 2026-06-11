import test from "node:test";
import assert from "node:assert/strict";

import { selectAutopilotMatches } from "./autopilot.js";

test("selectAutopilotMatches respects threshold, max price, categories, rate limit, and self-matches", () => {
  const matches = selectAutopilotMatches({
    agentId: "buyer-1",
    now: "2026-03-18T08:30:00.000Z",
    matches: [
      {
        fingerprint: "offer-1:need-1",
        summary: "Strong writing match",
        score: 0.91,
        offerId: "offer-1",
        needId: "need-1",
        offerTitle: "Research writing",
        needTitle: "Need a brief",
        offerAgentId: "seller-1",
        needAgentId: "buyer-1",
        category: "writing",
        price: 75,
        maxPriceDeltaPct: 10,
        acceptanceCriteria: ["Draft delivered"],
      },
      {
        fingerprint: "offer-2:need-2",
        summary: "Too expensive",
        score: 0.95,
        offerId: "offer-2",
        needId: "need-2",
        offerTitle: "Strategy consulting",
        needTitle: "Need advice",
        offerAgentId: "seller-2",
        needAgentId: "buyer-1",
        category: "advisory",
        price: 150,
        maxPriceDeltaPct: 10,
        acceptanceCriteria: [],
      },
      {
        fingerprint: "offer-3:need-3",
        summary: "Self match",
        score: 0.96,
        offerId: "offer-3",
        needId: "need-3",
        offerTitle: "Internal offer",
        needTitle: "Internal need",
        offerAgentId: "buyer-1",
        needAgentId: "buyer-1",
        category: "writing",
        price: 30,
        maxPriceDeltaPct: 10,
        acceptanceCriteria: [],
      },
    ],
    autopilot: {
      enabled: true,
      threshold: 0.85,
      maxPrice: 100,
      allowedCategories: ["writing"],
      rateLimitPerHour: 1,
    },
    autopilotDeals: [],
  });

  assert.deepEqual(matches.map((match) => match.fingerprint), ["offer-1:need-1"]);
});
