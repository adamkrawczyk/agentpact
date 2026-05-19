import { afterEach, test } from 'node:test';
import * as assert from 'node:assert/strict';

import { AgentPact, request } from '../src/index.js';

type RequestRecord = {
  url: string;
  method: string;
  body: any;
  headers: Record<string, string>;
};

const originalFetch = globalThis.fetch;

function installFetchRecorder(responseBody: unknown = { ok: true }) {
  const calls: RequestRecord[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: init?.method ?? 'GET',
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      headers: init?.headers as Record<string, string>,
    });
    return new Response(JSON.stringify(responseBody), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
  return calls;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test('register uses current auth route and requires caller-provided agentId', async () => {
  const calls = installFetchRecorder({ agentId: 'agent-id', apiKey: 'key' });
  await AgentPact.register({ agentId: '00000000-0000-4000-8000-000000000001', walletAddress: '0xabc' }, { baseUrl: 'http://api.test' });

  assert.equal(calls[0].url, 'http://api.test/api/auth/register');
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].body.agentId, '00000000-0000-4000-8000-000000000001');
  assert.equal(calls[0].body.walletAddress, '0xabc');
});

test('offer and need creation use current API payload names', async () => {
  const calls = installFetchRecorder({ id: 'created' });
  const ap = new AgentPact({ baseUrl: 'http://api.test', apiKey: 'key', agentId: '00000000-0000-4000-8000-000000000002' });

  await ap.offers.create({
    title: 'Lead research',
    descriptionMd: 'Research and return qualified leads.',
    basePrice: 10,
    category: 'research',
    tags: ['leads'],
    fulfillmentType: 'consultation',
    maxRespondents: 3,
    timeLimitMinutes: 60,
  });
  await ap.needs.create({
    title: 'Need leads',
    descriptionMd: 'Need a qualified lead list.',
    budgetMin: 5,
    budgetMax: 15,
    category: 'research',
    tags: ['leads'],
    acceptanceCriteria: ['CSV delivered'],
  });

  assert.equal(calls[0].url, 'http://api.test/api/offers');
  assert.equal(calls[0].body.descriptionMd, 'Research and return qualified leads.');
  assert.equal(calls[0].body.basePrice, 10);
  assert.equal(calls[0].body.price, undefined);
  assert.equal(calls[0].body.description, undefined);
  assert.equal(calls[0].body.fulfillmentType, 'consultation');

  assert.equal(calls[1].url, 'http://api.test/api/needs');
  assert.equal(calls[1].body.descriptionMd, 'Need a qualified lead list.');
  assert.equal(calls[1].body.budgetMin, 5);
  assert.equal(calls[1].body.budgetMax, 15);
  assert.equal(calls[1].body.maxBudget, undefined);
});

test('deal proposal and payment intent use current routes', async () => {
  const calls = installFetchRecorder({ id: 'deal' });
  const ap = new AgentPact({ baseUrl: 'http://api.test', apiKey: 'key', agentId: '00000000-0000-4000-8000-000000000003' });

  await ap.deals.propose({
    offerId: '00000000-0000-4000-8000-000000000010',
    needId: '00000000-0000-4000-8000-000000000011',
    sellerAgentId: '00000000-0000-4000-8000-000000000004',
    milestones: [{ idx: 1, title: 'Deliver', amount: 7, acceptanceCriteria: ['Done'] }],
  });
  await ap.deals.createPaymentIntent({
    milestoneId: '00000000-0000-4000-8000-000000000020',
    walletProvider: 'phantom',
    buyerWalletAddress: 'So11111111111111111111111111111111111111112',
    chain: 'solana',
  });

  assert.equal(calls[0].url, 'http://api.test/api/deals/propose');
  assert.equal(calls[0].body.buyerAgentId, '00000000-0000-4000-8000-000000000003');
  assert.equal(calls[0].body.negotiatedTotal, 7);
  assert.equal(calls[0].body.maxPriceDeltaPct, 15);

  assert.equal(calls[1].url, 'http://api.test/api/payments/create-intent');
  assert.equal(calls[1].body.provider, 'usdc');
  assert.equal(calls[1].body.walletProvider, 'phantom');
  assert.equal(calls[1].body.chain, 'solana');
});

test('request includes API key and idempotency key for writes', async () => {
  const calls = installFetchRecorder({ ok: true });
  await request('http://api.test', '/api/example', { method: 'POST', apiKey: 'key', body: { ok: true } });

  assert.equal(calls[0].headers['X-API-Key'], 'key');
  assert.ok(calls[0].headers['Idempotency-Key']);
});
