# Security

## Reporting a vulnerability

Report vulnerabilities privately via GitHub Security Advisories:

**https://github.com/PyriteShip/cdp-wagmi-rn/security/advisories/new**

Do not open a public issue for security findings. There is no bug bounty program.

## Security-sensitive areas

The following files are the highest-impact surface in this package:

- **`src/cdpCswWrap.ts`** — ERC-1271 / ERC-6492 signature wrapping and replay-safe hashing. Errors here can produce signatures that verify against the wrong message or chain.
- **`src/cdpAccount.ts`** — message/typed-data signing and sponsored-send calls over `@coinbase/cdp-core` actions.

When reporting, include the affected file(s), a description of the impact, and a minimal reproduction if possible.

## Supported versions

Security fixes are applied to the latest minor release only.
