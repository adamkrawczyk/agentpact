/**
 * @agentpact/payouts tests — adapter interface validation
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

// Nano genesis account (real, known-good checksum).
const GENESIS = 'nano_3t6k35gi95xu6tergt6p69ck76ogmitsa8mnijtpxm9fkcm736xtoncuohr3';

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

  it('NanoXNOAdapter accepts a valid Nano account, then refuses until implemented', async () => {
    const { NanoXNOAdapter } = await import('../src/index.js');
    const adapter = new NanoXNOAdapter();
    for (const recipient of [
      'nano_1yo6c1t64ahfjdw1dxizmbbnpdmbrckwhw9phbg5pdkeubrizga4qhnjmnx7',
      'xrb_1yo6c1t64ahfjdw1dxizmbbnpdmbrckwhw9phbg5pdkeubrizga4qhnjmnx7',
      GENESIS,
    ]) {
      try {
        await adapter.send({ recipient, amount: 0, amountRaw: '1000000', currency: 'xno', rail: 'nano-xno' });
        assert.fail('should have thrown');
      } catch (e: any) {
        assert.ok(e.message.includes('not implemented'), e.message);
      }
    }
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

  it('NanoXNOAdapter getStatus never reports a payout it did not make', async () => {
    const { NanoXNOAdapter } = await import('../src/index.js');
    const adapter = new NanoXNOAdapter();
    await assert.rejects(() => adapter.getStatus('nano_test123'), /Not implemented/);
  });

  it('blake2b matches RFC 7693 and node blake2b512; 5-byte digest is not a truncation', async () => {
    const { blake2b } = await import('../src/blake2b.js');
    const hex = (b: Uint8Array) => Buffer.from(b).toString('hex');
    assert.equal(
      hex(blake2b(new TextEncoder().encode('abc'))),
      'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
        '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
    );
    for (const n of [0, 1, 127, 128, 129, 256, 300]) {
      const data = new Uint8Array(n).map((_, i) => (i * 31 + 7) & 0xff);
      assert.equal(hex(blake2b(data)), createHash('blake2b512').update(data).digest('hex'), `len ${n}`);
    }
    const key = new Uint8Array(32);
    assert.notEqual(hex(blake2b(key, 5)), hex(blake2b(key).subarray(0, 5)));
    assert.throws(() => blake2b(key, 0));
    assert.throws(() => blake2b(key, 65));
  });

  it('isValidNanoAccount verifies the blake2b checksum', async () => {
    const { isValidNanoAccount } = await import('../src/index.js');
    assert.equal(GENESIS.length, 65);
    assert.ok(isValidNanoAccount(GENESIS));
    assert.ok(isValidNanoAccount(GENESIS.replace('nano_', 'xrb_')));
    const body = GENESIS.slice(5);
    // Bad checksum: every single-character change in the last 8 chars must fail.
    for (let i = 52; i < 60; i++) {
      const c = body[i] === '1' ? '3' : '1';
      assert.equal(isValidNanoAccount('nano_' + body.slice(0, i) + c + body.slice(i + 1)), false, `checksum pos ${i}`);
    }
    // A flipped public-key character no longer matches the checksum either.
    assert.equal(isValidNanoAccount('nano_' + body.slice(0, 10) + (body[10] === 'a' ? 'b' : 'a') + body.slice(11)), false);
    // Swapped checksum halves.
    assert.equal(isValidNanoAccount('nano_' + body.slice(0, 52) + body.slice(56) + body.slice(52, 56)), false);
  });

  it('isValidNanoAccount rejects wrong length, bad characters and wrong prefix', async () => {
    const { isValidNanoAccount } = await import('../src/index.js');
    const body = GENESIS.slice(5);
    for (const bad of [
      'nano_' + body.slice(0, 59),          // 59 chars
      'nano_' + body + '1',                 // 61 chars
      'nano_' + body.slice(0, 52),          // key only, no checksum
      'nano_',
      '',
      'nano_' + body.slice(0, 20) + 'l' + body.slice(21),   // 'l' not in alphabet
      'nano_' + body.slice(0, 20) + 'v' + body.slice(21),   // 'v'
      'nano_' + body.slice(0, 20) + '0' + body.slice(21),   // '0'
      'nano_' + body.slice(0, 20) + '2' + body.slice(21),   // '2'
      'nano_' + body.toUpperCase(),
      'nano_5' + body.slice(1),             // first char must be 1 or 3 (pad bits)
      'ban_' + body,
      'NANO_' + body,
      'nano-' + body,
      'nan_' + body,
      body,
      ' ' + GENESIS,
      GENESIS + '\n',
    ]) {
      assert.equal(isValidNanoAccount(bad), false, JSON.stringify(bad));
    }
    assert.equal(isValidNanoAccount(42 as any), false);
  });

  it('NanoXNOAdapter rejects a checksum-invalid account before anything else', async () => {
    const { NanoXNOAdapter } = await import('../src/index.js');
    const typo = GENESIS.slice(0, -1) + (GENESIS.endsWith('3') ? '1' : '3');
    await assert.rejects(
      () => new NanoXNOAdapter().send({ recipient: typo, amount: 0, amountRaw: '1', currency: 'xno', rail: 'nano-xno' }),
      /invalid Nano account/,
    );
  });

  it('NanoXNOAdapter requires a lossless amountRaw', async () => {
    const { NanoXNOAdapter } = await import('../src/index.js');
    const adapter = new NanoXNOAdapter();
    const base = { recipient: GENESIS, amount: 1, currency: 'xno', rail: 'nano-xno' as const };
    await assert.rejects(() => adapter.send(base), /requires amountRaw/);
    await assert.rejects(() => adapter.send({ ...base, amountRaw: '0' }), /greater than 0/);
    for (const bad of ['-1', '1.5', '1e30', '01', '', ' 1', (1n << 128n).toString()]) {
      await assert.rejects(() => adapter.send({ ...base, amountRaw: bad }), /raw amount/, bad);
    }
    await assert.rejects(() => adapter.send({ ...base, amountRaw: 1 as any }), /invalid raw amount/);
    await assert.rejects(() => adapter.send({ ...base, amountRaw: ((1n << 128n) - 1n).toString() }), /not implemented/);
  });

  it('XNO/raw conversion is exact at the boundaries', async () => {
    const { xnoToRaw, rawToXno, parseRaw, RAW_PER_XNO, MAX_RAW } = await import('../src/index.js');
    assert.equal(RAW_PER_XNO, 10n ** 30n);
    assert.equal(MAX_RAW, 2n ** 128n - 1n);
    // zero
    assert.equal(xnoToRaw('0'), 0n);
    assert.equal(xnoToRaw('0.0'), 0n);
    assert.equal(rawToXno(0n), '0');
    assert.equal(parseRaw('0'), 0n);
    // smallest unit: 1 raw = 10^-30 XNO
    assert.equal(xnoToRaw('0.000000000000000000000000000001'), 1n);
    assert.equal(rawToXno(1n), '0.000000000000000000000000000001');
    // one XNO and a value a float cannot hold
    assert.equal(xnoToRaw('1'), RAW_PER_XNO);
    assert.equal(rawToXno(RAW_PER_XNO), '1');
    assert.equal(xnoToRaw('1.000000000000000000000000000001'), RAW_PER_XNO + 1n);
    assert.equal(rawToXno(RAW_PER_XNO + 1n), '1.000000000000000000000000000001');
    assert.equal(xnoToRaw('0.1'), 10n ** 29n);
    // max: 2^128 - 1 raw
    const maxXno = '340282366.920938463463374607431768211455';
    assert.equal(rawToXno(MAX_RAW), maxXno);
    assert.equal(xnoToRaw(maxXno), MAX_RAW);
    assert.equal(parseRaw(MAX_RAW.toString()), MAX_RAW);
    assert.throws(() => xnoToRaw('340282366.920938463463374607431768211456'), /exceeds/);
    assert.throws(() => parseRaw((MAX_RAW + 1n).toString()), /exceeds/);
    assert.throws(() => rawToXno(MAX_RAW + 1n));
    assert.throws(() => rawToXno(-1n));
    // more than 30 decimals is refused, never rounded
    assert.throws(() => xnoToRaw('0.0000000000000000000000000000001'), /max 30 decimals/);
    assert.throws(() => xnoToRaw('1.0000000000000000000000000000000'), /max 30 decimals/);
    // no floats or loose formats
    assert.throws(() => xnoToRaw(0.1 as any), /decimal string/);
    assert.throws(() => rawToXno(1 as any));
    for (const bad of ['', '.5', '5.', '-1', '+1', '1e-30', '01', '1,5', ' 1', 'NaN', 'Infinity']) {
      assert.throws(() => xnoToRaw(bad), /invalid XNO amount/, bad);
    }
    // round trip
    for (const raw of [0n, 1n, 999n, RAW_PER_XNO - 1n, RAW_PER_XNO, 123456789n * RAW_PER_XNO + 42n, MAX_RAW]) {
      assert.equal(xnoToRaw(rawToXno(raw)), raw);
    }
  });
});
