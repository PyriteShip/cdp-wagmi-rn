# Contributing

## Dev setup

```bash
npm install
npm test           # jest, plain node env (no RN runtime needed — pure TS over mocked peers)
npm run typecheck  # tsc --noEmit
npm run build      # outputs to lib/
npm run size       # bundlesize check
```

The jest pipeline uses babel-jest with a node test environment. `@coinbase/cdp-core` and `@wagmi/core` are mocked in tests while `viem` runs for real — no React Native runtime or emulator is required. `ethers` is a dev dependency only: the CSW wrapping tests check each viem encoding against ethers' as an independent reference.

## PR expectations

- **Tests**: behavior changes and new exports should have test coverage. Pure refactors don't need new tests, but the existing suite must stay green.
- **CHANGELOG**: add a line under `## [Unreleased]` in `CHANGELOG.md` describing the change.
- **Public API surface**: this package is consumed by a production app. Be deliberate about new exports — prefer keeping internals unexported until there's a concrete consumer need.
- **Integration verification**: the test suite covers unit behavior only. If your change touches `cdpWagmiConnector`, `createCdpEip1193Provider`, or the CSW signing helpers, describe in the PR how you exercised it in a host RN app (emulator or device). PRs that change provider/connector behavior and have no integration note will be held.
