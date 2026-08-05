/**
 * The connector behaviours the cold-start reconnect fix depends on:
 *
 *  - isAuthorized() mirrors the CDP bridge. During the cold-start race it reads
 *    false (CDP not yet restored), which is exactly why wagmi's early reconnect
 *    drops the connector; once CDP restores it reads true and a deferred
 *    reconnect adopts the session.
 *  - connect() adopts an existing CDP session WITHOUT firing the email-OTP modal
 *    — on reconnect, and also on a fresh connect when a session already exists
 *    (calling signInWithEmail again throws "user is already authenticated").
 *    This is the "tap the button and it takes me right through" path.
 */

// @wagmi/core ships ESM that jest doesn't transform. createConnector is just an
// identity wrapper (returns the factory fn), so stub it rather than pull the
// whole ESM package through the transformer.
jest.mock('@wagmi/core', () => ({ createConnector: (fn: unknown) => fn }));

// cdpWagmiConnector → cdpEip1193 → cdpAccount → @coinbase/cdp-core. Mock the
// core so the connector loads without the native/browser CDP runtime.
jest.mock('@coinbase/cdp-core', () => ({
  signOut: jest.fn(async () => {}),
  // Default: no refresh token — silent revival fails, legacy OTP behavior.
  getAccessToken: jest.fn(async () => null),
  getCurrentUser: jest.fn(async () => null),
}));

import { cdpWagmiConnector, registerCdpAuthRequester, _resetDropReviveCooldown } from './cdpWagmiConnector';
import { setCdpState } from './cdpBridge';
import * as core from '@coinbase/cdp-core';
import type { CdpWalletConfig } from './cdpConfig';

const cfg: CdpWalletConfig = { chainId: 84532, rpcUrl: 'http://localhost:8545', cdpNetwork: 'base-sepolia', hydrationTimeoutMs: 25 };

// createConnector() just returns the factory fn; call it with a minimal config
// (only emitter is touched, and only by event paths these tests don't exercise).
function makeConnector(): any {
  const fn = cdpWagmiConnector(cfg) as any;
  return fn({ emitter: { emit: jest.fn() } });
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetDropReviveCooldown();
  registerCdpAuthRequester(null);
  setCdpState({ evmAddress: null, evmEoaAddress: null, initialized: false, signedIn: false });
});

describe('isAuthorized', () => {
  test('false while signed out (the cold-start race window)', async () => {
    const c = makeConnector();
    expect(await c.isAuthorized()).toBe(false);
  });

  test('false when signed in but the address has not propagated yet', async () => {
    setCdpState({ signedIn: true, evmAddress: null });
    const c = makeConnector();
    expect(await c.isAuthorized()).toBe(false);
  });

  test('true once signed in with an address (session restored)', async () => {
    setCdpState({ signedIn: true, evmAddress: '0xabc' });
    const c = makeConnector();
    expect(await c.isAuthorized()).toBe(true);
  });
});

describe('connect', () => {
  test('reconnect adopts the existing session without the OTP modal', async () => {
    setCdpState({ signedIn: true, evmAddress: '0xrestored' });
    const auth = jest.fn(async () => {});
    registerCdpAuthRequester(auth);

    const c = makeConnector();
    const res = await c.connect({ isReconnecting: true });

    expect(auth).not.toHaveBeenCalled();
    expect(res).toEqual({ accounts: ['0xrestored'], chainId: cfg.chainId });
  });

  test('fresh connect with no session fires the OTP modal, then returns the new address', async () => {
    const auth = jest.fn(async () => {
      // The modal flow signs the user in; the bridge then carries the address.
      setCdpState({ signedIn: true, evmAddress: '0xfresh' });
    });
    registerCdpAuthRequester(auth);

    const c = makeConnector();
    const res = await c.connect();

    expect(auth).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ accounts: ['0xfresh'], chainId: cfg.chainId });
  });

  test('fresh connect adopts a pre-existing session instead of re-prompting', async () => {
    // wagmi storage cleared but the CDP session persisted: connect() is called
    // without isReconnecting, yet must NOT call signInWithEmail again.
    setCdpState({ signedIn: true, evmAddress: '0xadopted' });
    const auth = jest.fn(async () => {});
    registerCdpAuthRequester(auth);

    const c = makeConnector();
    const res = await c.connect();

    expect(auth).not.toHaveBeenCalled();
    expect(res).toEqual({ accounts: ['0xadopted'], chainId: cfg.chainId });
  });
});

describe('connect — silent session revival', () => {
  test('a lapsed session revives from the refresh token without the OTP modal', async () => {
    // Regression pin: signing 25 min after OTP sign-in previously re-ran the
    // FULL ceremony because a lapsed access token read as signed-out.
    (core.getAccessToken as jest.Mock).mockResolvedValueOnce('fresh-token');
    (core.getCurrentUser as jest.Mock).mockResolvedValueOnce({
      userId: 'u1',
      evmAccounts: ['0xeoa'],
      evmSmartAccounts: ['0xsmart'],
    });
    const auth = jest.fn(async () => {});
    registerCdpAuthRequester(auth);

    const c = makeConnector();
    const res = await c.connect();

    expect(auth).not.toHaveBeenCalled();
    expect(res).toEqual({ accounts: ['0xsmart'], chainId: cfg.chainId });
    const { getCdpState } = require('./cdpBridge');
    expect(getCdpState().evmEoaAddress).toBe('0xeoa');
    expect(getCdpState().signedIn).toBe(true);
  });

  test('revival failure falls back to the OTP modal', async () => {
    (core.getAccessToken as jest.Mock).mockResolvedValueOnce(null);
    const auth = jest.fn(async () => {
      setCdpState({ signedIn: true, evmAddress: '0xfresh' });
    });
    registerCdpAuthRequester(auth);

    const c = makeConnector();
    const res = await c.connect();

    expect(auth).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ accounts: ['0xfresh'], chainId: cfg.chainId });
  });

  test('a thrown refresh (network down) falls back to the OTP modal', async () => {
    (core.getAccessToken as jest.Mock).mockRejectedValueOnce(new Error('offline'));
    const auth = jest.fn(async () => {
      setCdpState({ signedIn: true, evmAddress: '0xfresh2' });
    });
    registerCdpAuthRequester(auth);

    const c = makeConnector();
    const res = await c.connect();

    expect(auth).toHaveBeenCalledTimes(1);
    expect(res).toEqual({ accounts: ['0xfresh2'], chainId: cfg.chainId });
  });
});

describe('isAuthorized — hydration wait', () => {
  test('waits for the bridge to hydrate instead of answering from zeroed state', async () => {
    const c = makeConnector();
    const pending = c.isAuthorized();
    // Hydration lands after the call, within the timeout window.
    setCdpState({ initialized: true, signedIn: true, evmAddress: '0xhydrated' });
    expect(await pending).toBe(true);
  });

  test('answers false when hydration never arrives within the timeout', async () => {
    const c = makeConnector();
    expect(await c.isAuthorized()).toBe(false);
  });
});

describe('setup — address-drop revival', () => {
  test('a transient address drop with a live refresh token does not emit disconnect', async () => {
    (core.getAccessToken as jest.Mock).mockResolvedValueOnce('still-valid');
    (core.getCurrentUser as jest.Mock).mockResolvedValueOnce({
      userId: 'u1',
      evmAccounts: ['0xeoa'],
      evmSmartAccounts: ['0xback'],
    });
    const emit = jest.fn();
    const fn = cdpWagmiConnector(cfg) as any;
    const c = fn({ emitter: { emit } });
    setCdpState({ initialized: true, signedIn: true, evmAddress: '0xlive' });
    await c.setup();

    setCdpState({ signedIn: false, evmAddress: null, evmEoaAddress: null });
    await new Promise((r) => setTimeout(r, 10));

    expect(emit).not.toHaveBeenCalledWith('disconnect');
    // Revival wrote the address back; the subscriber emitted the change event.
    expect(emit).toHaveBeenCalledWith('change', { accounts: ['0xback'] });
  });

  test('a second drop inside the cooldown disconnects without another refresh call', async () => {
    (core.getAccessToken as jest.Mock).mockResolvedValue(null);
    const emit = jest.fn();
    const fn = cdpWagmiConnector(cfg) as any;
    const c = fn({ emitter: { emit } });
    setCdpState({ initialized: true, signedIn: true, evmAddress: '0xa' });
    await c.setup();

    setCdpState({ signedIn: false, evmAddress: null });
    await new Promise((r) => setTimeout(r, 10));
    const callsAfterFirst = (core.getAccessToken as jest.Mock).mock.calls.length;

    setCdpState({ signedIn: true, evmAddress: '0xa' });
    setCdpState({ signedIn: false, evmAddress: null });
    await new Promise((r) => setTimeout(r, 10));

    expect((core.getAccessToken as jest.Mock).mock.calls.length).toBe(callsAfterFirst);
    expect(emit).toHaveBeenCalledWith('disconnect');
  });

  test('a real sign-out (no refresh token) still propagates disconnect', async () => {
    (core.getAccessToken as jest.Mock).mockResolvedValue(null);
    const emit = jest.fn();
    const fn = cdpWagmiConnector(cfg) as any;
    const c = fn({ emitter: { emit } });
    setCdpState({ initialized: true, signedIn: true, evmAddress: '0xlive2' });
    await c.setup();

    setCdpState({ signedIn: false, evmAddress: null, evmEoaAddress: null });
    await new Promise((r) => setTimeout(r, 10));

    expect(emit).toHaveBeenCalledWith('disconnect');
  });
});

describe('disconnect', () => {
  test('signs out of the shared CDP session', async () => {
    const c = makeConnector();
    await c.disconnect();
    expect(core.signOut).toHaveBeenCalledTimes(1);
  });
});
