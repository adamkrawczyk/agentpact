/**
 * @agentpact/identity — Wallet-bound DID identity (ERC-8004 schema)
 */

export interface DIDDocument {
  id: string; // did:agentpact:<chain>:<address>
  controller: string;
  verificationMethod: VerificationMethod[];
  service?: ServiceEndpoint[];
  metadata: Record<string, unknown>;
}

export interface VerificationMethod {
  id: string;
  type: string;
  controller: string;
  blockchainAccountId: string;
}

export interface ServiceEndpoint {
  id: string;
  type: string;
  serviceEndpoint: string;
}

export function createDID(chain: string, address: string): string {
  return `did:agentpact:${chain}:${address.toLowerCase()}`;
}

export function createDIDDocument(chain: string, address: string, services?: ServiceEndpoint[]): DIDDocument {
  const did = createDID(chain, address);
  return {
    id: did,
    controller: did,
    verificationMethod: [{
      id: `${did}#key-1`,
      type: 'EcdsaSecp256k1RecoveryMethod2020',
      controller: did,
      blockchainAccountId: `${address.toLowerCase()}@eip155:8453`, // Base
    }],
    service: services,
    metadata: { created: new Date().toISOString(), chain },
  };
}

export function parseDID(did: string): { chain: string; address: string } | null {
  const match = did.match(/^did:agentpact:([^:]+):(.+)$/);
  if (!match) return null;
  return { chain: match[1], address: match[2] };
}

export { DIDDocument as default };
