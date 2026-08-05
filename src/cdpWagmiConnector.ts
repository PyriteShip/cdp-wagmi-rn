/**
 * wagmi Connector for the CDP smart-account wallet — the nucleus of a future
 * standalone `cdp-wagmi-rn` package.
 *
 * It wraps the pieces PR #14 established: `createCdpEip1193Provider` (the EIP-1193
 * view of the CDP capability core) as `getProvider()`, and `cdpBridge` for the
 * session state. For now it runs in **adopt mode** — it reflects the CDP session
 * the app already established via `useWalletSession` rather than owning it:
 *   - `connect()` waits for the existing signed-in address (no modal).
 *   - `disconnect()` is a no-op (the app owns real sign-out; tearing down the
 *     shared CDP session from here would log the user out of the whole app).
 * The future "own connection" variant injects the email-OTP modal trigger into
 * `connect()` and lets wagmi drive sign-in.
 */

import { createConnector } from '@wagmi/core';
import type { CreateConnectorFn } from '@wagmi/core';
import { ethers } from 'ethers';
import { createCdpEip1193Provider } from './cdpEip1193';
import {
  getCdpState,
  setCdpState,
  subscribeCdpState,
  waitForCdpAddress,
  waitForCdpInitialized,
} from './cdpBridge';
import {
  signOut as cdpSignOut,
  getAccessToken as cdpGetAccessToken,
  getCurrentUser as cdpGetCurrentUser,
} from '@coinbase/cdp-core';
import type { CdpWalletConfig } from './cdpConfig';
import type { Eip1193Provider } from 'ethers';

type Address = `0x${string}`;

// App registers a fn that shows the CDP email-OTP modal and resolves once
// sign-in completes (rejects on cancel). The connector calls it on a fresh
// connect when silent revival fails; on reconnect it's skipped (CDP
// auto-restores silently).
let authRequester: (() => Promise<void>) | null = null;
export function registerCdpAuthRequester(fn: (() => Promise<void>) | null): void {
  authRequester = fn;
}

// Bound on the silent-revival network round trip so a hung refresh can't
// stall connect() past the point a user would reasonably wait for a button.
const REVIVE_TIMEOUT_MS = 5000;

// Minimum spacing between address-drop revival attempts (see setup()).
const DROP_REVIVE_COOLDOWN_MS = 30_000;
let lastDropReviveAt = 0;

/** Test hook: reset the address-drop revival cooldown. */
export function _resetDropReviveCooldown(): void {
  lastDropReviveAt = 0;
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('cdp session revive timed out')), ms);
    p.then(
      (v) => { clearTimeout(timer); resolve(v); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/**
 * Try to revive the CDP session from the persisted refresh token — the silent
 * alternative to the OTP ceremony. Access tokens are short-lived; a lapsed one
 * does NOT mean the user is signed out, only that a refresh is due. On success
 * the bridge is hydrated imperatively (mirroring `<CdpStateBinder>`'s mapping)
 * so revival doesn't depend on the React tree re-rendering first.
 */
export async function tryReviveCdpSession(): Promise<boolean> {
  try {
    // `{ forceRefresh }` exists from cdp-core ≥0.0.119; the peer range floor
    // (0.0.37) types getAccessToken with no options and its impl ignores the
    // extra argument, so the cast is runtime-safe across the range.
    const getToken = cdpGetAccessToken as (opts?: { forceRefresh: boolean }) => Promise<string | null>;
    const token = await withTimeout(getToken({ forceRefresh: true }), REVIVE_TIMEOUT_MS);
    if (!token) return false;
    const user = await withTimeout(cdpGetCurrentUser(), REVIVE_TIMEOUT_MS);
    if (!user) return false;
    // Same field mapping as the app's CdpStateBinder: evmAccounts = EOA list
    // (signEvmTypedData only accepts these); evmSmartAccounts = on-chain identity.
    setCdpState({
      signedIn: true,
      evmAddress: user.evmSmartAccounts?.[0] ?? getCdpState().evmAddress,
      evmEoaAddress: user.evmAccounts?.[0] ?? getCdpState().evmEoaAddress,
    });
    return !!getCdpState().evmAddress;
  } catch {
    return false;
  }
}

export function cdpWagmiConnector(cfg: CdpWalletConfig): CreateConnectorFn {
  // Lazily-built singletons so getProvider() is stable across calls.
  let provider: Eip1193Provider | null = null;
  let unsubscribe: (() => void) | null = null;

  function getOrCreateProvider(): Eip1193Provider {
    if (!provider) {
      const readProvider = new ethers.JsonRpcProvider(
        cfg.rpcUrl,
        { name: cfg.cdpNetwork, chainId: cfg.chainId },
        { staticNetwork: true },
      );
      provider = createCdpEip1193Provider({
        smartAccount: getCdpState().evmAddress ?? '',
        readProvider,
        cfg,
      });
    }
    return provider;
  }

  return createConnector((config) => ({
    id: 'cdp',
    name: 'CDP Embedded Wallet',
    type: 'cdp' as const,

    async setup() {
      // Translate CDP bridge transitions into wagmi connector events so
      // `useAccount()` stays in step (e.g. external sign-out elsewhere).
      if (!unsubscribe) {
        let last = getCdpState().evmAddress ?? null;
        unsubscribe = subscribeCdpState((s) => {
          const next = s.evmAddress ?? null;
          if (next === last) return;
          last = next;
          if (!next) {
            // The address dropping usually means an access-token lapse, not a
            // sign-out — cdp-hooks nulls the user when a refresh fails or
            // hasn't run. Attempt one silent revival before tearing down the
            // wagmi connection; a real sign-out has no refresh token, so the
            // revival fails and the disconnect still propagates. The cooldown
            // stops a revive→hooks-rewrite-null→revive loop from hammering
            // the refresh endpoint if the upstream store won't hold the user.
            const now = Date.now();
            if (now - lastDropReviveAt < DROP_REVIVE_COOLDOWN_MS) {
              config.emitter.emit('disconnect');
              return;
            }
            lastDropReviveAt = now;
            void tryReviveCdpSession().then((revived) => {
              // Revival re-populates the bridge, so the address transition
              // back to non-null fires this subscriber again with the
              // 'change' event; nothing more to emit here on success.
              if (!revived && getCdpState().evmAddress == null) {
                config.emitter.emit('disconnect');
              }
            });
          } else {
            config.emitter.emit('change', { accounts: [next as Address] });
          }
        });
      }
    },

    // Cast: wagmi v3 types `connect` with a conditional EIP-5792 `withCapabilities`
    // return that a custom connector can't satisfy structurally. The
    // runtime shape ({ accounts, chainId }) is correct for the default case.
    connect: (async (params?: { isReconnecting?: boolean }) => {
      // Drive the email-OTP modal only for a fresh connect when CDP is NOT
      // already authenticated AND the session can't be revived silently from
      // the persisted refresh token. If a CDP session already exists —
      // reconnect, or wagmi state diverged from CDP's own (e.g. wagmi storage
      // cleared while the CDP session persisted) — adopt it instead. Calling
      // signInWithEmail again throws "user is already authenticated".
      const alreadyAuthed = getCdpState().signedIn && !!getCdpState().evmAddress;
      if (!params?.isReconnecting && !alreadyAuthed) {
        const revived = await tryReviveCdpSession();
        if (!revived && authRequester) await authRequester();
      }
      const address = await waitForCdpAddress();
      return { accounts: [address as Address], chainId: cfg.chainId };
    }) as never,

    async disconnect() {
      try {
        await cdpSignOut();
      } catch (err: any) {
        console.warn('[cdp] signOut error', err?.message ?? err);
      }
    },

    async getAccounts() {
      const a = getCdpState().evmAddress;
      return (a ? [a as Address] : []) as readonly Address[];
    },

    async getChainId() {
      return cfg.chainId;
    },

    async getProvider() {
      return getOrCreateProvider();
    },

    async isAuthorized() {
      // Wait (bounded) for the bridge's first hydration: wagmi's cold-start
      // autoConnect asks before <CdpStateBinder> has written a snapshot, and
      // answering from the zeroed initial state drops a restorable session.
      // The app-side deferred reconnect remains as backstop for CDP restores
      // that finish after this window.
      const s = await waitForCdpInitialized(cfg.hydrationTimeoutMs);
      return s.signedIn && !!s.evmAddress;
    },

    onAccountsChanged(accounts: string[]) {
      if (accounts.length === 0) config.emitter.emit('disconnect');
      else config.emitter.emit('change', { accounts: accounts as Address[] });
    },

    onChainChanged(chainId: string) {
      config.emitter.emit('change', { chainId: Number(chainId) });
    },

    onDisconnect() {
      config.emitter.emit('disconnect');
    },
  }));
}
