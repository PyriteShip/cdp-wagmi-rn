# Changelog

## [Unreleased]
### Fixed
- `cdpSendCalls` / `waitForUserOpTransactionHash` returned the transaction hash of a
  userOp whose status was `failed`, so `eth_sendTransaction` and `wallet_sendCalls`
  reported a reverted operation as sent. A `failed` status now throws, like `dropped`.

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
