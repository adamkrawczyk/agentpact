/**
 * @agentpact/identity tests — pure TypeScript, no mocking needed
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('@agentpact/identity', () => {
  it('createDID generates correct format', async () => {
    const { createDID } = await import('../src/index.js');
    const did = createDID('base', '0x1234567890abcdef1234567890abcdef12345678');
    assert.equal(did, 'did:agentpact:base:0x1234567890abcdef1234567890abcdef12345678');
  });

  it('createDID lowercases address', async () => {
    const { createDID } = await import('../src/index.js');
    const did = createDID('base', '0xABCDEF');
    assert.ok(did.includes('0xabcdef'), 'address should be lowercased');
  });

  it('parseDID extracts chain and address', async () => {
    const { parseDID } = await import('../src/index.js');
    const result = parseDID('did:agentpact:arbitrum:0xabc123');
    assert.ok(result);
    assert.equal(result!.chain, 'arbitrum');
    assert.equal(result!.address, '0xabc123');
  });

  it('parseDID returns null for invalid DID', async () => {
    const { parseDID } = await import('../src/index.js');
    assert.equal(parseDID('not-a-did'), null);
    assert.equal(parseDID('did:web:example.com'), null);
    assert.equal(parseDID(''), null);
  });

  it('createDIDDocument generates valid document', async () => {
    const { createDIDDocument } = await import('../src/index.js');
    const doc = createDIDDocument('base', '0xabc123');
    assert.equal(doc.id, 'did:agentpact:base:0xabc123');
    assert.equal(doc.controller, doc.id);
    assert.equal(doc.verificationMethod.length, 1);
    assert.equal(doc.verificationMethod[0].type, 'EcdsaSecp256k1RecoveryMethod2020');
    assert.ok(doc.verificationMethod[0].blockchainAccountId.includes('0xabc123'));
    assert.ok(doc.metadata.created);
    assert.equal(doc.metadata.chain, 'base');
  });

  it('createDIDDocument includes services when provided', async () => {
    const { createDIDDocument } = await import('../src/index.js');
    const services = [
      { id: 'did:agentpact:base:0xabc#mcp', type: 'MCP', serviceEndpoint: 'https://mcp.example.com' },
    ];
    const doc = createDIDDocument('base', '0xabc123', services);
    assert.ok(doc.service);
    assert.equal(doc.service!.length, 1);
    assert.equal(doc.service![0].type, 'MCP');
  });

  it('round-trip: createDID → parseDID', async () => {
    const { createDID, parseDID } = await import('../src/index.js');
    const addr = '0x1234567890abcdef1234567890abcdef12345678';
    const did = createDID('optimism', addr);
    const parsed = parseDID(did);
    assert.ok(parsed);
    assert.equal(parsed!.chain, 'optimism');
    assert.equal(parsed!.address, addr);
  });
});
