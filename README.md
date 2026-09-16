# cdp-wagmi-rn

[![npm](https://img.shields.io/npm/v/cdp-wagmi-rn)](https://www.npmjs.com/package/cdp-wagmi-rn)
[![CI](https://github.com/PyriteShip/cdp-wagmi-rn/actions/workflows/ci.yml/badge.svg)](https://github.com/PyriteShip/cdp-wagmi-rn/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/cdp-wagmi-rn)](./LICENSE)

A [Coinbase CDP](https://docs.cdp.coinbase.com/) embedded smart-account wallet
exposed as a **bare React Native** [wagmi](https://wagmi.sh) connector, plus the
ERC-1271 / ERC-6492 signature wrapping Coinbase Smart Wallets need.

Nothing official covers this: Coinbase's
[`@coinbase/cdp-wagmi`](https://www.npmjs.com/package/@coinbase/cdp-wagmi) is
web-only, and the generic `@wagmi/connectors` don't survive bare RN on the New
Architecture (dynamic `import()`, `window.*` reads, EIP-6963 discovery, Metro
ESM interop). This package ships a purpose-built `createConnector` that does.

## vs @coinbase/cdp-wagmi

Coinbase publishes an official wagmi connector for CDP embedded wallets. It
targets web React; this package is its bare-RN counterpart, plus the
smart-wallet signing layer the official one doesn't have:

| | `@coinbase/cdp-wagmi` | `cdp-wagmi-rn` |
|---|---|---|
| Target | Web React (ESM-only, no RN entry, `window.location` touched at import) | **Bare React Native / New Architecture** |
| Sign-in UI | CDP web SignIn component | CDP **hooks** via a state binder (no web UI) |
| Provider | wraps cdp-core's stock embedded-wallet provider | hand-authored EIP-1193 over cdp-core low-level actions |
| Coinbase Smart Wallet signing | — | **ERC-1271 + ERC-6492 wrapping** |
| Sponsored sends (paymaster) | — | `cdpSendCalls` |
| Signing against a different verifier chain | — | yes (e.g. XMTP-on-mainnet) |

If you're on web, use the official package. If you're in bare RN — or you need
CSW replay-safe signatures / ERC-6492 for a counterfactual account — use this
one.

## Install

```sh
npm install cdp-wagmi-rn @coinbase/cdp-core @coinbase/cdp-hooks wagmi viem ethers
```

The peer dependencies dedupe to your app's copies; the polyfill/Metro companion
packages are covered in [docs/SETUP.md](./docs/SETUP.md).

Verified against `@wagmi/core` v3; the peer range also accepts v2, which
type-checks but hasn't been run.

Prerequisites: a CDP Portal project ID (see [docs/SETUP.md §4](./docs/SETUP.md)).

## Quickstart

```ts
import { createConfig, http } from 'wagmi';
import { baseSepolia } from 'viem/chains';
import { cdpWagmiConnector, type CdpWalletConfig } from 'cdp-wagmi-rn';

const cfg: CdpWalletConfig = {
  chainId: baseSepolia.id,
  rpcUrl: 'https://sepolia.base.org',
  cdpNetwork: 'base-sepolia',
};

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [cdpWagmiConnector(cfg)],
  transports: { [baseSepolia.id]: http(cfg.rpcUrl) },
});
```

Wire CDP session state into the connector from a binder that reads the CDP
hooks (mount it inside your `<CDPHooksProvider>`):

```tsx
import { useEffect } from 'react';
import { useCurrentUser, useEvmAddress, useIsInitialized } from '@coinbase/cdp-hooks';
import { setCdpState } from 'cdp-wagmi-rn';

function CdpStateBinder() {
  const { isInitialized } = useIsInitialized();
  const { currentUser } = useCurrentUser();
  const { evmAddress } = useEvmAddress();

  useEffect(() => {
    setCdpState({
      initialized: isInitialized,
      signedIn: !!currentUser,
      evmAddress: evmAddress ?? null,
      // CDP signs with the owner EOA (User.evmAccounts), not the smart account.
      evmEoaAddress: currentUser?.evmAccounts?.[0] ?? null,
    });
  }, [isInitialized, currentUser, evmAddress]);

  return null;
}
```

Finally, register your sign-in UI so a fresh `connect()` can drive it
(reconnects skip it — CDP restores its session silently):

```ts
import { registerCdpAuthRequester } from 'cdp-wagmi-rn';

registerCdpAuthRequester(async () => {
  // Open your CDP sign-in flow (e.g. email OTP via @coinbase/cdp-hooks).
  // Resolve once sign-in completes; reject on cancel.
});
```

## Signing against a different verifier chain

The connector signs `personal_sign` against `cfg.chainId`, like any wallet. If an
off-chain ERC-1271 verifier (e.g. SIWE/XMTP) only runs on another chain, call the
core helper directly with that chain instead of going through the provider:

```ts
import { cdpSignMessage } from 'cdp-wagmi-rn';
const sig = await cdpSignMessage(message, smartAccount, readProvider, { chainId: 8453 });
```

## API

### Config shapes

| Export | Description |
|---|---|
| `CdpWalletConfig` | Wallet-wide config passed once to `cdpWagmiConnector`: `chainId`, `rpcUrl`, `cdpNetwork` (`'base-sepolia' \| 'base'`), optional `smartAccountFactory` override. |
| `CdpSignOpts` | Per-signature options — `chainId` is the chain bound into the CSW replay-safe envelope, i.e. the chain the signature will be verified on. |
| `CdpSendOpts` | Per-send options — the CDP UserOperation network. |

### wagmi connector

| Export | Description |
|---|---|
| `cdpWagmiConnector(cfg)` | The main entry point: a `createConnector` over the EIP-1193 provider and the session bridge. |
| `registerCdpAuthRequester(fn)` | Register a function that shows your sign-in UI and resolves once sign-in completes; called on a fresh connect, skipped on reconnect (CDP auto-restores silently). |

### EIP-1193 provider boundary

| Export | Description |
|---|---|
| `createCdpEip1193Provider({ smartAccount, readProvider, cfg })` | EIP-1193 provider for non-wagmi consumers: routes `personal_sign`, `eth_signTypedData_v4`, `eth_sendTransaction`, and EIP-5792 `wallet_sendCalls` / `wallet_getCallsStatus` / `wallet_getCapabilities` to the CDP core, and forwards reads to the injected ethers provider. |

### CDP capability core

Framework-agnostic — e.g. sign a message against a specific verifier chain
without going through the wagmi provider.

| Export | Description |
|---|---|
| `cdpGetAddress(smartAccount)` | Current smart-account address from the hooks bridge, falling back to the address captured at connect time. |
| `cdpSignMessage(message, smartAccount, readProvider, opts)` | `personal_sign` for a Coinbase Smart Wallet: the EIP-191 hash wrapped in the CSW replay-safe envelope, then ERC-6492-wrapped so a counterfactual account can be deployed inside the verifier's `eth_call`. |
| `cdpSignTypedData(domain, types, value, smartAccount, opts)` | EIP-712 signing: the typed-data digest wrapped in CSW's replay-safe envelope, signed by the owner EOA, then ABI-encoded for ERC-1271. |
| `cdpSendCalls(calls, smartAccount, opts)` | Execute one or more calls as a single sponsored UserOperation and return the on-chain transaction hash once the bundler includes it. |
| `waitForUserOpTransactionHash(userOpHash, smartAccount, opts)` | Poll a UserOperation until inclusion; throws if it's dropped or times out. |
| `CdpCall` | A single call in a UserOperation batch (`{ to, value?, data? }`). |

### Session-state bridge

Wire your `<CDPHooksProvider>` into the connector by calling `setCdpState`
from a binder component that reads the CDP hooks.

| Export | Description |
|---|---|
| `getCdpState()` | Snapshot of the bridged session state. |
| `setCdpState(patch)` | Patch the bridged state; notifies subscribers on change. |
| `subscribeCdpState(cb)` | Observe state changes; returns an unsubscribe function. |
| `waitForCdpAddress(timeoutMs?)` | Resolves once `evmAddress` is non-null (the post-sign-in handoff); 15 s default timeout. |
| `waitForCdpSignedOut(timeoutMs?)` | The mirror: resolve once the bridge reports signed out, or on timeout — it never rejects. Re-authenticating means signing out and straight back in, and the connector adopts whatever session the bridge reports, so reconnecting before the sign-out has propagated re-adopts the session being torn down and the new sign-in never happens. Await this between the two halves. |
| `CdpState` | `{ evmAddress, evmEoaAddress, initialized, signedIn }`. |

### Coinbase Smart Wallet signature wrapping

Pure helpers + constants.

| Export | Description |
|---|---|
| `buildCswReplaySafeTypedData(args)` | Build the `CoinbaseSmartWalletMessage(bytes32 hash)` meta-EIP-712 envelope that CSW's `_isValidSignature` expects, from an original EIP-712 payload. |
| `buildCswReplaySafeTypedDataForHash(args)` | Same envelope for a caller that already has the 32-byte inner digest (e.g. an EIP-191 personal-sign hash). |
| `wrapCswSignature(rawSig)` | ABI-encode a raw 65-byte ECDSA signature into CSW's `SignatureWrapper` tuple (`ownerIndex = 0`, the primary owner slot). |
| `wrapErc6492({ factory, factoryCalldata, innerSig })` | Wrap an ERC-1271 signature in the ERC-6492 deploy-then-verify envelope for counterfactual accounts. |
| `buildCoinbaseFactoryCalldata(owners, nonce)` | `createAccount(owners, nonce)` calldata that deploys the smart account at its counterfactual address. |
| `encodeAddressOwner(address)` | Encode an EOA owner the way the factory stores it: left-padded to a 32-byte word. |
| `coinbaseFactoryInterface` | ethers `Interface` for the factory (`createAccount` / `getAddress`). |
| `CDP_SMART_ACCOUNT_FACTORY` | The CDP embedded-wallet smart-account factory address — **not** the public Coinbase Smart Wallet factory; CDP uses a sibling factory with a different account implementation. |
| `ERC6492_MAGIC` | The 32-byte ERC-6492 magic suffix a supporting verifier checks for. |

### Error recovery

Two CDP failures the SDK does not surface usefully on its own.

| Export | Description |
|---|---|
| `isAlreadyLinkedError(e)` | True when CDP refused to link an email or phone because it belongs to a **different** CDP user. It surfaces at the *verify* step, after the code was sent, and carries no `code` field — so a handler keyed on `code` reports a generic "wrong code" for a contact that is simply taken, and the user retries the OTP forever. Matches all three shapes CDP uses: `code: 'METHOD_ALREADY_LINKED'`, `errorType: 'already_exists'`, and the message text. |
| `isAttestationWedgeError(msg)` | True for the iOS App Attest rejection below. |
| `healAttestationWedge(projectId)` | Clear the dead key and run attest + register so the device holds a key the backend knows. Returns false rather than throwing. |
| `withAttestationHeal(fn, projectId)` | Run a CDP auth call; on the wedge error, heal once and retry. A failed heal rethrows the original. |

The App Attest wedge is permanent without this. `@coinbase/cdp-app-attest`
caches its key ID in the Keychain the moment the key is generated — before
Apple attestation and backend registration have succeeded — and
`createAssertion` signs with that cached key regardless of registration state.
The Keychain survives uninstall, so **one** failed registration leaves the
device sending assertions the backend rejects forever:

```
Attestation Key Not registered. Please re-register the device
```

The SDK's own retry covers a 404 thrown from assertion generation and Apple's
`devicecheck error 2` — neither fires here, because the rejection arrives on
the auth endpoint. So it never self-heals.

Healing is safe by construction: it runs only after the backend has already
rejected the stored key, so that key has no standing to lose. The account
credential is the SMS/email OTP — the attestation key is a device-integrity
gate, not an account key — and clearing it touches neither the refresh token
nor any wallet material.

```ts
const user = await withAttestationHeal(
  () => signInWithSms({ phoneNumber }),
  cdpProjectId,
);
```

`@coinbase/cdp-app-attest` and `@coinbase/cdp-api-client` are **optional**
peers: both are required lazily inside the heal, never at module load, so a
host without App Attest (a simulator, a sideload, an Android-only app) pulls in
neither and cannot raise the wedge error in the first place.

## Host setup (bare RN, New Architecture)

This package assumes a New-Arch / Bridgeless RN app with Web Crypto and
`structuredClone` polyfills installed before any `cdp-*` import, and Metro
configured for CDP's transitive deps (`unstable_enablePackageExports`,
`stream`/`crypto`/`ws` shims). The connector itself is pure TypeScript — the
native requirements come from its polyfill companions and from CDP's dependency
graph. The code is extracted from a production Android app (RN 0.83, Hermes,
Bridgeless/New Architecture); the 0.0.x line is the pre-verification extraction —
v0.1.0 marks the device-verified cut. See **[docs/SETUP.md](./docs/SETUP.md)**
for the full setup.

## License

MIT
