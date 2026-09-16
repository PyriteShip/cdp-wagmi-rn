/**
 * cdp-wagmi-rn — a Coinbase CDP embedded smart-account wallet as a
 * bare-React-Native wagmi connector.
 *
 * The official `@wagmi/connectors` don't work in bare RN (dynamic import,
 * `window.*` reads, EIP-6963 discovery, Metro ESM interop). This package ships
 * its own `createConnector` over the CDP capability core that works on
 * RN New Architecture, plus the Coinbase Smart Wallet ERC-1271 / ERC-6492
 * signature wrapping the account needs.
 *
 * The connector is configured entirely through `CdpWalletConfig` — it imports
 * nothing app-specific. See README for host (Metro/polyfill) requirements.
 */

// Config shapes
export type { CdpWalletConfig, CdpSignOpts, CdpSendOpts } from './cdpConfig';

// wagmi connector (the main entry point)
export { cdpWagmiConnector, registerCdpAuthRequester } from './cdpWagmiConnector';

// EIP-1193 provider boundary (for non-wagmi consumers)
export { createCdpEip1193Provider } from './cdpEip1193';

// CDP capability core (framework-agnostic; e.g. sign a message against a
// specific verifier chain without going through the wagmi provider)
export {
  cdpGetAddress,
  cdpSignMessage,
  cdpSignTypedData,
  cdpSendCalls,
  waitForUserOpTransactionHash,
  type CdpCall,
} from './cdpAccount';

// Session-state bridge — wire your `<CDPHooksProvider>` into the connector by
// calling `setCdpState` from a binder component that reads the CDP hooks.
export {
  getCdpState,
  setCdpState,
  subscribeCdpState,
  waitForCdpAddress,
  waitForCdpSignedOut,
  type CdpState,
} from './cdpBridge';

// Coinbase Smart Wallet signature wrapping (pure helpers + constants)
export {
  buildCswReplaySafeTypedData,
  buildCswReplaySafeTypedDataForHash,
  wrapCswSignature,
  wrapErc6492,
  buildCoinbaseFactoryCalldata,
  encodeAddressOwner,
  coinbaseFactoryInterface,
  CDP_SMART_ACCOUNT_FACTORY,
  ERC6492_MAGIC,
} from './cdpCswWrap';

// Recovery from two CDP failures the SDK does not surface usefully on its own:
// a contact already linked to a different CDP user (reported at the verify
// step with no `code` field), and an iOS App Attest key the backend has
// rejected (which the SDK's own retry does not cover — see cdpAttestHeal).
export { isAlreadyLinkedError } from './cdpLinkErrors';
export {
  isAttestationWedgeError,
  healAttestationWedge,
  withAttestationHeal,
} from './cdpAttestHeal';
