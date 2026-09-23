# Changelog

## [Unreleased]

## [0.0.5] - 2026-09-23
### Added
- EIP-1193 provider error codes. The provider throws `CdpProviderRpcError` with
  4001 when the user closes a cdp-core MFA prompt, 4100 when no session is signed
  in or MFA did not complete, 4200 for signing methods a smart account cannot serve
  and unhandled `wallet_*` methods, 4900 when CDP's signing service is unavailable,
  and 4901 for a request naming another chain. Exported with `PROVIDER_ERROR_CODES`
  and `toProviderRpcError`. `CdpUserOperationFailedError` and unclassified CDP
  errors reach the caller unchanged.
- `wallet_switchEthereumChain`: `null` for `cfg.chainId`, 4901 for any other chain.

### Changed
- `eth_accounts` returns `[]` with no signed-in session instead of `['']`.
- `eth_sign`, `eth_signTransaction`, `eth_signTypedData` / `_v1` / `_v3` and unhandled
  `wallet_*` methods are rejected (4200) instead of forwarded to the read provider.
- `wallet_sendCalls` and `eth_sendTransaction` reject a `chainId` other than
  `cfg.chainId` (4901) instead of sending on the configured chain.

## [0.0.4] - 2026-09-16
### Fixed
- `cdpSendCalls` / `waitForUserOpTransactionHash` returned the transaction hash of a
  userOp whose status was `failed`, so `eth_sendTransaction` and `wallet_sendCalls`
  reported a reverted operation as sent. A `failed` status now throws, like `dropped`.

### Added
- `CdpUserOperationFailedError`, thrown for a `failed` or `dropped` userOp, with
  readonly `userOperationHash`, `status` and `transactionHash` (set when the op was
  included), so a consumer can fetch the receipt and decode the revert itself.

## [0.0.2] - 2026-09-08
### Fixed
- A lapsed CDP access token read as signed-out, so `connect()` raised the full
  OTP ceremony and an address drop tore down the wagmi connection. `connect()`
  now attempts refresh-token revival before showing the OTP modal, and
  `isAuthorized()` waits (bounded by `cfg.hydrationTimeoutMs`) for the bridge to
  hydrate rather than reporting a transient null address as signed-out.

### Changed
- Repository, homepage and bugs URLs point at the PyriteShip org after the repo
  transfer. This matters beyond metadata: `npm publish --provenance` verifies
  the `repository` field against the source repo.
- Releases authenticate via npm trusted publishing (OIDC) instead of an
  `NPM_TOKEN` secret. Requires the trusted publisher to be registered on npm for
  this package — repo, workflow filename and environment must all match.

## [0.0.1] - 2026-06-11
### Added
- Initial release, extracted from the tool-rental production app (pre-verification extraction; v0.1.0 marks the device-verified cut).
- `cdpWagmiConnector` — bare-RN wagmi connector over `@coinbase/cdp-core`.
- `createCdpEip1193Provider` — EIP-1193 boundary for non-wagmi consumers.
- Coinbase Smart Wallet ERC-1271 / ERC-6492 signature wrapping helpers.
- `cdpSendCalls` sponsored sends; cross-verifier-chain `cdpSignMessage`.
