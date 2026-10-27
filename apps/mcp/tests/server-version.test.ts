/**
 * serverInfo.version must come from package.json — the hosted server reported
 * 0.1.0 while package.json + the MCP Registry entry said 0.2.0 (ah_1027).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const source = fs.readFileSync(path.resolve(import.meta.dirname, '../src/index.ts'), 'utf-8');

describe('@agentpact/mcp server version', () => {
  it('has no hard-coded semver in a version: field', () => {
    const literals = source.match(/version:\s*"\d+\.\d+\.\d+"/g) ?? [];
    assert.deepEqual(literals, [], `hard-coded versions drift from package.json: ${literals.join(', ')}`);
  });

  it('reads SERVER_VERSION from package.json and uses it on all 3 surfaces', () => {
    assert.match(source, /const SERVER_VERSION\b[^;]*package\.json/s);
    const uses = source.match(/version:\s*SERVER_VERSION\b/g) ?? [];
    assert.equal(uses.length, 3, `expected serverInfo, server-card and / to use SERVER_VERSION, got ${uses.length}`);
  });
});
