/**
 * Module-level mutable that bridges CDP's hook-only state into our
 * imperative wallet connector layer.
 *
 * `<CdpStateBinder>` (mounted inside `<CDPHooksProvider>` in App.tsx)
 * reads `useEvmAddress()` + `useCurrentUser()` and writes their values
 * into this object via `setCdpState()`. Anything outside the React tree
 * (the connector class, the ethers signer adapter) reads via `getCdpState()`.
 *
 * Imperative actions (signEvmTypedData, sendUserOperation, getUserOperation,
 * signOut) come straight from `@coinbase/cdp-core` — they share the same
 * singleton auth state initialized by `<CDPHooksProvider>` and don't need
 * to be bridged.
 */

export interface CdpState {
  /** The user's smart account address. Used as the on-chain identity (NFT
   *  owner, offer lender). Null when signed out. */
  evmAddress: string | null;
  /** The EOA that owns the smart account. CDP's `signEvmTypedData` /
   *  `signEvmMessage` accept only EOAs (User.evmAccounts) — passing the
   *  smart account address fails with "EVM account not found". For ERC-1271
   *  flows, sign with this EOA; the contract verifies via SignatureChecker
   *  against the smart account address. Null when signed out. */
  evmEoaAddress: string | null;
  /** True once `<CDPHooksProvider>` has finished bootstrapping. */
  initialized: boolean;
  /** True iff currentUser is non-null (i.e. user is signed in). */
  signedIn: boolean;
}

const state: CdpState = {
  evmAddress: null,
  evmEoaAddress: null,
  initialized: false,
  signedIn: false,
};

const subscribers = new Set<(s: CdpState) => void>();

export function getCdpState(): CdpState {
  return { ...state };
}

export function setCdpState(patch: Partial<CdpState>): void {
  let changed = false;
  for (const k of Object.keys(patch) as (keyof CdpState)[]) {
    const next = patch[k] as CdpState[typeof k];
    if (state[k] !== next) {
      (state[k] as CdpState[typeof k]) = next;
      changed = true;
    }
  }
  if (changed) {
    const snapshot = { ...state };
    for (const cb of subscribers) cb(snapshot);
  }
}

export function subscribeCdpState(cb: (s: CdpState) => void): () => void {
  subscribers.add(cb);
  return () => { subscribers.delete(cb); };
}

/**
 * Resolve once `evmAddress` is non-null (i.e. the post-sign-in handoff
 * has propagated through CDP's React state). Used by the connect flow
 * to bridge between the auth modal closing and the connector returning
 * a usable ConnectedWallet.
 */
export function waitForCdpAddress(timeoutMs = 15000): Promise<string> {
  if (state.evmAddress) return Promise.resolve(state.evmAddress);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      unsub();
      reject(new Error('Timed out waiting for CDP wallet address'));
    }, timeoutMs);
    const unsub = subscribeCdpState((s) => {
      if (s.evmAddress) {
        clearTimeout(timer);
        unsub();
        resolve(s.evmAddress);
      }
    });
  });
}

/**
 * Resolve with the bridge state once `<CdpStateBinder>` has hydrated it
 * (`initialized` true), or with whatever is there when `timeoutMs` elapses.
 * wagmi's cold-start autoConnect calls `isAuthorized()` before the React tree
 * has written the first bridge snapshot — answering from the zeroed initial
 * state there reads as "signed out" and drops a restorable session.
 */
export function waitForCdpInitialized(timeoutMs = 2000): Promise<CdpState> {
  if (state.initialized) return Promise.resolve({ ...state });
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      unsub();
      resolve({ ...state });
    }, timeoutMs);
    const unsub = subscribeCdpState((s) => {
      if (s.initialized) {
        clearTimeout(timer);
        unsub();
        resolve(s);
      }
    });
  });
}
