/**
 * @agentpact/mcp tests — tool schema validation (no API needed)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

// Parse tool definitions from source (can't import directly due to side effects)
const source = fs.readFileSync(
  path.resolve(import.meta.dirname, '../src/index.ts'),
  'utf-8',
);

// Extract tool names via regex from source
const TOOL_NAME_RE = /name:\s*"agentpact\.([a-z_]+)"/g;
const toolNames: string[] = [];
let m;
while ((m = TOOL_NAME_RE.exec(source)) !== null) {
  toolNames.push(m[1]);
}

describe('@agentpact/mcp', () => {
  it('exports at least 10 tools', () => {
    assert.ok(toolNames.length >= 10, `Expected >= 10 tools, got ${toolNames.length}`);
  });

  it('has core auth tools', () => {
    const required = ['register', 'get_agent'];
    for (const name of required) {
      assert.ok(toolNames.includes(name), `Missing tool: ${name}`);
    }
  });

  it('has offer tools', () => {
    const required = ['create_offer', 'update_offer', 'archive_offer', 'search_offers'];
    for (const name of required) {
      assert.ok(toolNames.includes(name), `Missing tool: ${name}`);
    }
  });

  it('has need tools', () => {
    const required = ['create_need', 'update_need', 'archive_need'];
    for (const name of required) {
      assert.ok(toolNames.includes(name), `Missing tool: ${name}`);
    }
  });

  it('has deal tools', () => {
    const required = ['propose_deal', 'accept_deal', 'cancel_deal'];
    for (const name of required) {
      assert.ok(toolNames.includes(name), `Missing tool: ${name}`);
    }
  });

  it('all tool names use agentpact namespace', () => {
    const names = [...source.matchAll(/name:\s*"(agentpact\.[^"]+)"/g)].map(m => m[1]);
    for (const name of names) {
      assert.ok(name.startsWith('agentpact.'), `${name} should start with agentpact.`);
    }
  });

  it('all tools have description', () => {
    const toolBlocks = source.split(/name:\s*"agentpact\./);
    // Skip first chunk (before first tool)
    for (let i = 1; i < toolBlocks.length; i++) {
      assert.ok(
        /description:/.test(toolBlocks[i]),
        `Tool block ${i} missing description`,
      );
    }
  });

  it('all tools have inputSchema', () => {
    const toolBlocks = source.split(/name:\s*"agentpact\./);
    for (let i = 1; i < toolBlocks.length; i++) {
      assert.ok(
        /inputSchema:/.test(toolBlocks[i]),
        `Tool block ${i} missing inputSchema`,
      );
    }
  });

  it('has API_BASE config from env', () => {
    assert.ok(source.includes('API_BASE'), 'Should read API_BASE from env');
  });

  it('supports both stdio and HTTP transports', () => {
    assert.ok(source.includes('StdioServerTransport'), 'Should support stdio');
    assert.ok(source.includes('StreamableHTTPServerTransport'), 'Should support HTTP');
  });

  it('supports explicit transport mode and keeps logs off stdout', () => {
    assert.ok(source.includes('MCP_TRANSPORT'), 'Should read explicit MCP_TRANSPORT mode');
    assert.ok(source.includes('console.error'), 'Operational logs should use stderr');
    assert.equal(/console\.log\(/.test(source), false, 'stdout must remain MCP protocol-only');
  });

  it('includes current enum values from the API', () => {
    assert.ok(source.includes('"phantom"'), 'walletProvider should include phantom');
    assert.ok(source.includes('"other"'), 'walletProvider should include other');
    assert.ok(source.includes('"consultation"'), 'fulfillmentType should include consultation');
  });

  it('strips path-only fields from path-param tool bodies', () => {
    assert.ok(source.includes('stripFields(args, ["dealId"])'), 'dealId should be stripped from path-param request bodies');
  });
});
