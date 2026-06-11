import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { cleanDatabase, createTestApp, generateTestOffer, getAuthHeadersForAgent } from "./helpers/testApp.js";

describe("Offers API rate limiting", () => {
  let authHeaders: Record<string, string>;
  let agentId: string;

  beforeEach(async () => {
    await createTestApp();
    await cleanDatabase();
    agentId = randomUUID();
    authHeaders = await getAuthHeadersForAgent(agentId);
  });

  it("should rate limit agents to 15 active offers", async () => {
    const { app } = await createTestApp();

    for (let index = 0; index < 15; index += 1) {
      const response = await app.inject({
        method: "POST",
        url: "/api/offers",
        headers: authHeaders,
        payload: {
          ...generateTestOffer(agentId),
          title: `Offer ${index}`,
        }
      });

      expect(response.statusCode).toBe(201);
    }

    const rateLimitedResponse = await app.inject({
      method: "POST",
      url: "/api/offers",
      headers: authHeaders,
      payload: {
        ...generateTestOffer(agentId),
        title: "Offer 16",
      }
    });

    expect(rateLimitedResponse.statusCode).toBe(429);
  });
});
