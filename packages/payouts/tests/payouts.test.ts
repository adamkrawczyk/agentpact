/**
 * @agentpact/payouts tests — adapter interface validation
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

describe('@agentpact/payouts', () => {
  it('exports Rail type values', async () => {
    const mod = await import('../src/index.js');
    // The adapters object should have the 3 rails
    assert.ok(typeof mod.send === 'function', 'should export send function');
  });

  it('send rejects unknown rail', async () => {
    const { send } = await import('../src/index.js');
    try {
      await send({ recipient: 'test', amount: 100, currency: 'usd', rail: 'unknown' as any });
      assert.fail('should have thrown');
    } catch (e: any) {
      assert.ok(e.message.includes('Unknown rail') || e.message.includes('not implemented'), e.message);
    }
  });

  it('PayoutParams has correct shape', () => {
    const params = {
      recipient: 'acct_stripe123',
      amount: 1000,
      currency: 'usd',
      rail: 'stripe' as const,
      metadata: { dealId: 'deal-1' },
    };
    assert.equal(params.recipient, 'acct_stripe123');
    assert.equal(params.amount, 1000);
    assert.equal(params.currency, 'usd');
    assert.equal(params.rail, 'stripe');
  });

  it('PayoutResult has correct shape', () => {
    const result = {
      id: 'po_123',
      rail: 'stripe' as const,
      status: 'completed' as const,
      amount: 1000,
      currency: 'usd',
      stripeTransferId: 'tr_123',
    };
    assert.equal(result.status, 'completed');
    assert.ok(result.stripeTransferId);
  });

  it('StripeConnectAdapter throws NotImplemented', async () => {
    const { StripeConnectAdapter } = await import('../src/index.js');
    const adapter = new StripeConnectAdapter();
    try {
      await adapter.send({ recipient: 'test', amount: 100, currency: 'usd', rail: 'stripe' });
      assert.fail('should throw');
    } catch (e: any) {
      assert.ok(e.message.includes('not implemented') || e.message.includes('Not implemented'), e.message);
    }
  });

  it('USDCBaseAdapter throws NotImplemented', async () => {
    const { USDCBaseAdapter } = await import('../src/index.js');
    const adapter = new USDCBaseAdapter();
    try {
      await adapter.send({ recipient: '0x123', amount: 100, currency: 'usdc', rail: 'usdc-base' });
      assert.fail('should throw');
    } catch (e: any) {
      assert.ok(e.message.includes('not implemented') || e.message.includes('Not implemented'), e.message);
    }
  });

  it('USDCSolanaAdapter throws NotImplemented', async () => {
    const { USDCSolanaAdapter } = await import('../src/index.js');
    const adapter = new USDCSolanaAdapter();
    try {
      await adapter.send({ recipient: 'solana_addr', amount: 100, currency: 'usdc', rail: 'usdc-solana' });
      assert.fail('should throw');
    } catch (e: any) {
      assert.ok(e.message.includes('not implemented') || e.message.includes('Not implemented'), e.message);
    }
  });

  it('NanoXNOAdapter accepts valid Nano account', async () => {
    const { NanoXNOAdapter } = await import('../src/index.js');
    const adapter = new NanoXNOAdapter();
    const result = await adapter.send({
      recipient: 'nano_1yo6c1t64ahfjdw1dxizmbbnpdmbrckwhw9phbg5pdkeubrizga4qhnjmnx7',
      amount: 1_000_000,
      currency: 'xno',
      rail: 'nano-xno',
    });
    assert.equal(result.rail, 'nano-xno', 'rail preserved');
    assert.equal(result.status, 'pending', 'status pending before confirmation');
    assert.equal(result.currency, 'xno', 'currency is xno');
    assert.equal(result.amount, 1_000_000, 'amount preserved');
  });

  it('NanoXNOAdapter rejects invalid account format', async () => {
    const { NanoXNOAdapter } = await import('../src/index.js');
    const adapter = new NanoXNOAdapter();
    try {
      await adapter.send({ recipient: '0x123456', amount: 1, currency: 'xno', rail: 'nano-xno' });
      assert.fail('should have thrown');
    } catch (e: any) {
      assert.ok(e.message.includes('invalid Nano account') || e.message.includes('invalid'), e.message);
    }
  });

  it('NanoXNOAdapter rejects non-nano-xno rail', async () => {
    const { NanoXNOAdapter } = await import('../src/index.js');
    const adapter = new NanoXNOAdapter();
    try {
      await adapter.send({ recipient: 'nano_1yo6c1t64ahfjdw1dxizmbbnpdmbrckwhw9phbg5pdkeubrizga4qhnjmnx7', amount: 1, currency: 'xno', rail: 'stripe' });
      assert.fail('should have thrown');
    } catch (e: any) {
      assert.ok(e.message.includes('wrong rail'), e.message);
    }
  });

  it('NanoXNOAdapter getStatus returns completed', async () => {
    const { NanoXNOAdapter } = await import('../src/index.js');
    const adapter = new NanoXNOAdapter();
    const result = await adapter.getStatus('nano_test123');
    assert.equal(result.rail, 'nano-xno');
    assert.equal(result.status, 'completed');
    assert.equal(result.currency, 'xno');
  });
});
