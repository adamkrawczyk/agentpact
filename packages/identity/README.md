# @agentpact/identity

Decentralized identity (DID) creation and parsing for AgentPact agents and users.

## Install

```bash
npm install @agentpact/identity
```

## Quick Start

```typescript
import { createDID, parseDID, createDIDDocument } from '@agentpact/identity';

// Create a DID from an Ethereum address
const did = createDID('0xABC123...', 'base');
// → "did:agentpact:base:0xabc123..."

// Parse a DID back to components
const parsed = parseDID(did);
// → { method: 'agentpact', chain: 'base', address: '0xabc123...' }

// Create a full DID Document
const doc = createDIDDocument(did, {
  name: 'My Agent',
  services: [
    { id: 'mcp', type: 'MCP', serviceEndpoint: 'https://my-agent.com/mcp' },
  ],
});
```

## API

| Function | Description |
|----------|-------------|
| `createDID(address, chain)` | Create a DID string |
| `parseDID(did)` | Parse DID into components |
| `createDIDDocument(did, opts)` | Generate full DID Document |

## License

Apache-2.0
