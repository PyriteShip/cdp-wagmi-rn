# Host setup — bare React Native, New Architecture

What a bare RN app needs before `@coinbase/cdp-core` / `@coinbase/cdp-hooks` —
and therefore this connector — will run. Everything here is extracted from a
production Android app running **RN 0.83, Hermes, Bridgeless (New
Architecture)**; the 0.0.x line is the pre-verification extraction — v0.1.0
marks the device-verified cut.

## 1. Polyfills (before any cdp-* import)

CDP needs the full Web Crypto API — ECDSA **and** RSA key generation for JWT
signing and encryption, not just `getRandomValues` — plus `structuredClone`.
React Native provides none of these.

```sh
npm install react-native-get-random-values @ungap/structured-clone react-native-quick-crypto readable-stream
```

`react-native-quick-crypto` is a native module — run `pod install` (iOS) and
rebuild the app after installing it.

Create a `polyfills.ts` and import it at the very top of your `index.js`,
before `AppRegistry.registerComponent` and before anything that transitively
imports a `cdp-*` package:

```ts
// polyfills.ts
import 'react-native-get-random-values'; // crypto.getRandomValues
import structuredClone from '@ungap/structured-clone';
import { install } from 'react-native-quick-crypto';

if (!('structuredClone' in globalThis)) {
  (globalThis as unknown as { structuredClone: typeof structuredClone }).structuredClone =
    structuredClone;
}

install(); // adds crypto.subtle + crypto.randomUUID
```

> **Do NOT shim `window.addEventListener` or `window.location`.** Browser shims
> make wallet SDKs (e.g. `@metamask/connect-evm`) think they're in a browser and
> load browser-only paths that break Metro's ESM interop ("Cannot set property
> 'importedAll' of undefined"). As of wagmi v3, the only `window.addEventListener`
> caller we've hit is the EIP-6963 discovery (mipd), disabled via
> `multiInjectedProviderDiscovery: false` (see §3), and TanStack Query guards
> its focus/online listeners on `window.addEventListener` being truthy — so
> RN's default bare `window` (an alias of `global`, with no
> `addEventListener`/`location`) is correct as-is.

## 2. Metro

`@coinbase/cdp-core` pulls in `@solana/web3.js` and `viem`, both of which
transitively require Node built-ins. Map those to RN-compatible
implementations, enable package `exports` resolution, and stub two modules:

```js
// metro.config.js
const path = require('path');
const { getDefaultConfig, mergeConfig } = require('@react-native/metro-config');

const wsShim = path.resolve(__dirname, 'src/shims/ws.js');

const config = {
  resolver: {
    // @ecies/ciphers (transitive of CDP) uses the package.json `exports` field
    // with subpaths like "@ecies/ciphers/aes". Metro doesn't honor `exports` by
    // default, so without this flag bundling fails with "Unable to resolve
    // module @ecies/ciphers/aes".
    unstable_enablePackageExports: true,
    // Node built-ins required by CDP's transitive deps (`stream` via `ws`,
    // `crypto` in several places). Add more entries as new "Unable to resolve
    // module <node-builtin>" errors surface.
    extraNodeModules: {
      stream: require.resolve('readable-stream'),
      crypto: require.resolve('react-native-quick-crypto'),
    },
    resolveRequest: (context, moduleName, platform) => {
      // Alias the Node-only `ws` package to a shim that re-exports
      // global.WebSocket. CDP's Solana transitive chain pulls in `ws`, which
      // would otherwise drag in zlib/net/tls/etc.
      if (moduleName === 'ws') {
        return { type: 'sourceFile', filePath: wsShim };
      }
      // @wagmi/core v3's "tempo" connectors do a guarded require of an
      // optional 'accounts' integration. Metro resolves it statically
      // (ignoring the runtime guard) and fails; stub it to empty.
      if (moduleName === 'accounts') {
        return { type: 'empty' };
      }
      return context.resolveRequest(context, moduleName, platform);
    },
  },
};

module.exports = mergeConfig(getDefaultConfig(__dirname), config);
```

The `ws` shim:

```js
// src/shims/ws.js
// React Native shim for the Node-only `ws` package. Everything maps to RN's
// global WebSocket.
const WebSocket = global.WebSocket;

module.exports = WebSocket;
module.exports.WebSocket = WebSocket;
module.exports.default = WebSocket;
```

## 3. wagmi config

```ts
import { createConfig, createStorage, http } from 'wagmi';
import { baseSepolia } from 'viem/chains';
import { cdpWagmiConnector, type CdpWalletConfig } from 'cdp-wagmi-rn';
import { mmkvStorage } from './wagmiStorage'; // or an AsyncStorage adapter

const cdpCfg: CdpWalletConfig = {
  chainId: baseSepolia.id,
  rpcUrl: 'https://sepolia.base.org',
  cdpNetwork: 'base-sepolia',
};

export const wagmiConfig = createConfig({
  chains: [baseSepolia],
  connectors: [cdpWagmiConnector(cdpCfg)],
  transports: { [baseSepolia.id]: http(cdpCfg.rpcUrl) },
  // Persist the active connector so `WagmiProvider reconnectOnMount` silently
  // restores it on cold start. MMKV (synchronous) is the most reliable on
  // Bridgeless; an AsyncStorage-backed adapter also works.
  storage: createStorage({ storage: mmkvStorage }),
  // EIP-6963 injected-provider discovery calls `window.addEventListener` at
  // init — undefined in React Native. Browser-only; we use explicit connectors.
  multiInjectedProviderDiscovery: false,
});
```

An MMKV adapter is three methods:

```ts
import { createMMKV } from 'react-native-mmkv';

const mmkv = createMMKV({ id: 'wagmi' });

export const mmkvStorage = {
  getItem: (key: string) => mmkv.getString(key) ?? null,
  setItem: (key: string, value: string) => mmkv.set(key, value),
  removeItem: (key: string) => mmkv.remove(key),
};
```

## 4. CDP hooks → connector state binder

You need a CDP Portal project first: create one at
[portal.cdp.coinbase.com](https://portal.cdp.coinbase.com) and copy the Project
ID into `CDPHooksProvider`'s config below. Then allowlist your app per
[CDP's embedded-wallet docs](https://docs.cdp.coinbase.com/embedded-wallets/docs/welcome)
so the project accepts sign-in requests from it.

The connector does not own the CDP session — `@coinbase/cdp-hooks` does. The
connector reads session state (addresses, sign-in status) from a module-level
bridge that you populate from a small binder component mounted inside
`<CDPHooksProvider>`. The fields are exactly `CdpState`:

```tsx
import { useEffect } from 'react';
import {
  CDPHooksProvider,
  useCurrentUser,
  useEvmAddress,
  useIsInitialized,
} from '@coinbase/cdp-hooks';
import { setCdpState } from 'cdp-wagmi-rn';

function CdpStateBinder() {
  const { isInitialized } = useIsInitialized();
  const { currentUser } = useCurrentUser();
  const { evmAddress } = useEvmAddress();

  useEffect(() => {
    setCdpState({
      // True once <CDPHooksProvider> has finished bootstrapping.
      initialized: isInitialized,
      // True iff currentUser is non-null.
      signedIn: !!currentUser,
      // The smart-account address — the on-chain identity.
      evmAddress: evmAddress ?? null,
      // The EOA that owns the smart account. CDP's signEvmTypedData /
      // signEvmMessage accept only EOAs (User.evmAccounts) — passing the
      // smart-account address fails with "EVM account not found".
      evmEoaAddress: currentUser?.evmAccounts?.[0] ?? null,
    });
  }, [isInitialized, currentUser, evmAddress]);

  return null;
}

// CDPHooksProvider's init effect re-runs on every `config` reference change —
// pass a module-scope constant, never an inline object literal.
const CDP_HOOKS_CONFIG = {
  projectId: YOUR_CDP_PROJECT_ID,
  ethereum: { createOnLogin: 'smart' as const },
};

export function App() {
  return (
    <CDPHooksProvider config={CDP_HOOKS_CONFIG}>
      <CdpStateBinder />
      {/* WagmiProvider etc. */}
    </CDPHooksProvider>
  );
}
```

Imperative actions (`signEvmTypedData`, `sendUserOperation`, `signOut`) come
straight from `@coinbase/cdp-core` — they share the same singleton auth state
that `<CDPHooksProvider>` initializes and don't need to be bridged.

The last piece is the sign-in flow itself, registered via
`registerCdpAuthRequester` so a fresh `connect()` can drive it. A minimal
email-OTP flow uses `signInWithEmail` + `verifyEmailOTP` from
`@coinbase/cdp-core` (see
[CDP's embedded-wallet auth docs](https://docs.cdp.coinbase.com/embedded-wallets/docs/welcome)):

```ts
import { signInWithEmail, verifyEmailOTP } from '@coinbase/cdp-core';
import { registerCdpAuthRequester } from 'cdp-wagmi-rn';

registerCdpAuthRequester(async () => {
  // 1. Collect the user's email in your UI, then start the flow —
  //    CDP emails a one-time code and returns a flowId.
  const { flowId } = await signInWithEmail({ email });
  // 2. Collect the 6-digit code, then verify it.
  await verifyEmailOTP({ flowId, otp });
  // 3. Done — the CDP hooks fire and the state binder above picks up the
  //    session; resolve to let connect() proceed (reject on cancel).
});
```

## 5. Version-matrix notes

- **New Architecture / Bridgeless is required in practice.** The connector
  itself is pure TypeScript, but it has only been run on New Arch, and
  common companion libraries (e.g. `react-native-mmkv@^4` for wagmi storage)
  are Nitro modules that hard-require Bridgeless.
- **Expo SDK ↔ RN versions are coupled.** If your bare app pulls in any
  `expo-*` modules, stay on a matched SDK/RN pair — mixing versions breaks
  Kotlin metadata on Android.
- **`unstable_enablePackageExports` is needed on current RN Metro defaults** —
  without it, CDP's transitive `exports`-subpath imports fail to resolve at
  bundle time.
