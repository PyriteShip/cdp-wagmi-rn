/**
 * Public config shapes for the CDP smart-account wallet — the nucleus of a
 * future standalone `cdp-wagmi-rn` package. Deliberately imports NOTHING from
 * the app: the connector factory receives these resolved values so the CDP
 * files carry zero app coupling.
 */

/** Wallet-wide config passed once to `cdpWagmiConnector(cfg)`. */
export interface CdpWalletConfig {
  /** The wallet's chain — used for sends and as the default sign-envelope chain. */
  chainId: number;
  /** Read RPC URL backing the EIP-1193 passthrough (reads + factory probe). */
  rpcUrl: string;
  /** CDP UserOperation network for `sendUserOperation` / `getUserOperation`. */
  cdpNetwork: 'base-sepolia' | 'base';
  /**
   * Optional override of the hardcoded CDP smart-account factory in
   * `cdpCswWrap.ts`. Load-bearing — only set if Coinbase rotates the factory.
   */
  smartAccountFactory?: string;
  /**
   * How long `isAuthorized()` waits for the CDP bridge to hydrate before
   * answering (ms, default 2000). wagmi's cold-start autoConnect runs before
   * the React tree writes the first bridge snapshot; without the wait a
   * restorable session reads as signed-out. Tests pass a small value.
   */
  hydrationTimeoutMs?: number;
}

/**
 * Per-signature options. `chainId` is the chain bound into the CSW replay-safe
 * envelope — i.e. the chain the signature will be verified on. The EIP-1193
 * provider passes `cfg.chainId`; a caller whose verifier lives elsewhere (e.g.
 * an off-chain ERC-1271 verifier that only runs on mainnet) passes its own.
 */
export interface CdpSignOpts {
  chainId: number;
  smartAccountFactory?: string;
}

/** Per-send options — the CDP UserOperation network. */
export interface CdpSendOpts {
  cdpNetwork: CdpWalletConfig['cdpNetwork'];
}
