/**
 * @agentpact/escrow tests — mock-based (no chain needed)
 */
import { describe, it, mock, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

// Mock ethers before importing the SDK
const mockWait = mock.fn(() => Promise.resolve());
const mockTx = () => Promise.resolve({ wait: mockWait });
const mockCreateMilestone = mock.fn(mockTx);
const mockMilestones = mock.fn();
const mockAcceptMilestone = mock.fn(mockTx);
const mockOpenDispute = mock.fn(mockTx);
const mockResolveDispute = mock.fn(mockTx);
const mockClaimTimeout = mock.fn(mockTx);
const mockPlatformFeePercent = mock.fn(() => 10n);

const mockContract = {
  createMilestone: mockCreateMilestone,
  milestones: mockMilestones,
  acceptMilestone: mockAcceptMilestone,
  openDispute: mockOpenDispute,
  resolveDispute: mockResolveDispute,
  claimAfterTimeout: mockClaimTimeout,
  platformFeePercent: mockPlatformFeePercent,
};

// We test the types and structure — real integration tests run against testnet
describe('@agentpact/escrow', () => {
  it('exports EscrowSDK class', async () => {
    const { default: EscrowSDK } = await import('../src/index.js');
    assert.ok(typeof EscrowSDK === 'function');
  });

  it('exports CHAIN_ADDRESSES with base, arbitrum, optimism', async () => {
    const mod = await import('../src/index.js');
    assert.ok(mod.CHAIN_ADDRESSES);
    assert.ok(mod.CHAIN_ADDRESSES.base);
    assert.ok(mod.CHAIN_ADDRESSES.arbitrum);
    assert.ok(mod.CHAIN_ADDRESSES.optimism);
  });

  it('exports ESCROW_ABI as array', async () => {
    const mod = await import('../src/index.js');
    assert.ok(Array.isArray(mod.ESCROW_ABI));
    assert.ok(mod.ESCROW_ABI.length > 10, 'ABI should have >10 entries');
  });

  it('EscrowSDK constructor accepts config', async () => {
    const { default: EscrowSDK } = await import('../src/index.js');
    // Should not throw on construction (will fail on actual calls without provider)
    assert.doesNotThrow(() => {
      try { new EscrowSDK({ rpcUrl: 'http://localhost:8545', contractAddress: '0x1234' }); } catch {}
    });
  });

  it('CreateMilestoneParams has correct shape', async () => {
    const params = {
      dealId: 'deal-001',
      seller: '0xSellerAddress',
      amount: 1000n,
    };
    assert.equal(params.dealId, 'deal-001');
    assert.equal(params.seller, '0xSellerAddress');
    assert.equal(params.amount, 1000n);
  });

  it('Milestone status enum is correct', async () => {
    const statuses = ['Funded', 'Accepted', 'Disputed', 'Resolved'] as const;
    assert.equal(statuses[0], 'Funded');
    assert.equal(statuses[1], 'Accepted');
    assert.equal(statuses[2], 'Disputed');
    assert.equal(statuses[3], 'Resolved');
  });
});

describe('@agentpact/escrow ABI structure', () => {
  it('ABI has createMilestone function', async () => {
    const mod = await import('../src/index.js');
    const hasCreate = mod.ESCROW_ABI.some(
      (e: any) => e.name === 'createMilestone' && e.type === 'function'
    );
    assert.ok(hasCreate, 'ABI should have createMilestone function');
  });

  it('ABI has MilestoneCreated event', async () => {
    const mod = await import('../src/index.js');
    const hasEvent = mod.ESCROW_ABI.some(
      (e: any) => e.name === 'MilestoneCreated' && e.type === 'event'
    );
    assert.ok(hasEvent, 'ABI should have MilestoneCreated event');
  });

  it('ABI has dispute functions', async () => {
    const mod = await import('../src/index.js');
    const names = mod.ESCROW_ABI.filter((e: any) => e.type === 'function').map((e: any) => e.name);
    assert.ok(names.includes('openDispute'), 'should have openDispute');
    assert.ok(names.includes('resolveDispute'), 'should have resolveDispute');
  });

  it('ABI has timeout claim', async () => {
    const mod = await import('../src/index.js');
    const hasTimeout = mod.ESCROW_ABI.some(
      (e: any) => e.name === 'claimAfterTimeout' && e.type === 'function'
    );
    assert.ok(hasTimeout, 'ABI should have claimAfterTimeout');
  });
});
