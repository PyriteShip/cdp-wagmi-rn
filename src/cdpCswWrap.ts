/**
 * Pure-logic helpers for Coinbase Smart Wallet ERC-1271 signature wrapping.
 * Kept separate from `cdpAccount.ts` so jest can import these without pulling
 * in the CDP SDK's ESM runtime (which the babel-jest pipeline can't transform).
 *
 * `cdpAccount.ts` uses them; `cdpCswWrap.test.ts` shows what the wrap layout
 * looks like and why the flat `(uint8, bytes)` form is wrong.
 */

import {
  concat,
  encodeAbiParameters,
  encodeFunctionData,
  getAddress,
  hashTypedData,
  pad,
  parseAbi,
  parseAbiParameters,
  type Hex,
  type TypedDataDomain,
  type TypedDataParameter,
} from 'viem';

/** An EIP-712 struct field (`{ name, type }`). */
export type TypedDataField = TypedDataParameter;

/**
 * The inner offer digest is hashed with the `EIP712Domain` type derived from
 * the domain's own fields, so an `EIP712Domain` entry in a caller's `types` is
 * dropped first. Inbound `types` may or may not carry it.
 */
function omitEIP712Domain(
  types: Record<string, readonly TypedDataField[]>,
): Record<string, readonly TypedDataField[]> {
  if (!('EIP712Domain' in types)) return types;
  const { EIP712Domain: _drop, ...rest } = types;
  void _drop;
  return rest;
}

function domainTypeFor(domain: TypedDataDomain): TypedDataField[] {
  const fields: TypedDataField[] = [];
  if (domain.name != null) fields.push({ name: 'name', type: 'string' });
  if (domain.version != null) fields.push({ name: 'version', type: 'string' });
  if (domain.chainId != null) fields.push({ name: 'chainId', type: 'uint256' });
  if (domain.verifyingContract != null) fields.push({ name: 'verifyingContract', type: 'address' });
  if (domain.salt != null) fields.push({ name: 'salt', type: 'bytes32' });
  return fields;
}

/**
 * The struct a set of EIP-712 types describes: the one type no other type
 * references. Throws when that is not exactly one type, since the digest would
 * then depend on which root the caller meant.
 */
export function inferPrimaryType(types: Record<string, readonly TypedDataField[]>): string {
  const names = Object.keys(types).filter((k) => k !== 'EIP712Domain');
  const referenced = new Set<string>();
  for (const name of names) {
    for (const field of types[name]) {
      const base = field.type.replace(/(\[\d*\])+$/, '');
      if (base !== name) referenced.add(base);
    }
  }
  const roots = names.filter((n) => !referenced.has(n));
  if (roots.length !== 1) {
    throw new Error(`EIP-712 types have ${roots.length} root types (${roots.join(', ')}); expected exactly one`);
  }
  return roots[0];
}

/** Domain values as `hashTypedData` reads them: `chainId` as a bigint even when given as a string. */
function normalizeDomain(domain: TypedDataDomain): TypedDataDomain {
  const out: Record<string, unknown> = {};
  if (domain.name != null) out.name = domain.name;
  if (domain.version != null) out.version = domain.version;
  if (domain.chainId != null) out.chainId = BigInt(domain.chainId as number | bigint | string);
  if (domain.verifyingContract != null) out.verifyingContract = domain.verifyingContract;
  if (domain.salt != null) out.salt = domain.salt;
  return out as TypedDataDomain;
}

function serializeDomain(domain: TypedDataDomain): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (domain.name != null) out.name = domain.name;
  if (domain.version != null) out.version = domain.version;
  if (domain.chainId != null) out.chainId = Number(domain.chainId);
  if (domain.verifyingContract != null) out.verifyingContract = domain.verifyingContract;
  if (domain.salt != null) out.salt = domain.salt;
  return out;
}

/**
 * Build the meta-EIP-712 envelope that Coinbase Smart Wallet's
 * `_isValidSignature` expects: the caller's offer digest gets wrapped in
 * CSW's `CoinbaseSmartWalletMessage(bytes32 hash)` type under CSW's own
 * EIP-712 domain (`name: 'Coinbase Smart Wallet'`, `version: '1'`,
 * `verifyingContract: <smart account address>`). The EOA signs the
 * envelope; the resulting sig verifies against
 * `smartAccount.isValidSignature(originalDigest, wrappedSig)` because
 * `replaySafeHash(originalDigest)` recomputes the same envelope hash.
 */
export function buildCswReplaySafeTypedData(args: {
  originalDomain: TypedDataDomain;
  originalTypes: Record<string, readonly TypedDataField[]>;
  originalValue: Record<string, unknown>;
  /** The struct being signed; inferred from `originalTypes` when omitted. */
  originalPrimaryType?: string;
  smartAccount: string;
  chainId: number | bigint;
}): {
  domain: Record<string, unknown>;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
} {
  const types = omitEIP712Domain(args.originalTypes);
  const offerDigest = hashTypedData({
    domain: normalizeDomain(args.originalDomain),
    types,
    primaryType: args.originalPrimaryType ?? inferPrimaryType(types),
    message: args.originalValue,
  } as Parameters<typeof hashTypedData>[0]);
  return buildCswReplaySafeTypedDataForHash({
    hash: offerDigest,
    smartAccount: args.smartAccount,
    chainId: args.chainId,
  });
}

/**
 * Same CSW replay-safe envelope as {@link buildCswReplaySafeTypedData}, but
 * for a caller that already has the 32-byte inner digest the smart wallet will
 * verify. Used by the XMTP auth path, where the inner digest is the EIP-191
 * personal-sign hash of XMTP's signature text rather than an EIP-712 typed
 * digest. The owner EOA signs this envelope; the resulting signature verifies
 * against `smartAccount.isValidSignature(hash, wrappedSig)` because
 * `replaySafeHash(hash)` recomputes the same envelope hash.
 */
export function buildCswReplaySafeTypedDataForHash(args: {
  hash: string;
  smartAccount: string;
  chainId: number | bigint;
}): {
  domain: Record<string, unknown>;
  types: Record<string, TypedDataField[]>;
  primaryType: string;
  message: Record<string, unknown>;
} {
  const cswDomain: TypedDataDomain = {
    name: 'Coinbase Smart Wallet',
    version: '1',
    chainId: args.chainId,
    verifyingContract: args.smartAccount as Hex,
  };
  return {
    domain: serializeDomain(cswDomain),
    types: {
      EIP712Domain: domainTypeFor(cswDomain),
      CoinbaseSmartWalletMessage: [{ name: 'hash', type: 'bytes32' }],
    },
    primaryType: 'CoinbaseSmartWalletMessage',
    message: { hash: args.hash },
  };
}

/**
 * Wrap a raw 65-byte ECDSA signature in CSW's `SignatureWrapper` struct
 * (`(uint8 ownerIndex, bytes signatureData)`) and ABI-encode as a single
 * tuple parameter — matches the SDK's internal
 * `createSmartAccountSignatureWrapper`.
 *
 * `ownerIndex = 0` is the primary owner slot, which is the EOA on a fresh
 * CDP smart account.
 *
 * Note: encoding a single tuple value (`(uint8, bytes)` as one parameter)
 * produces a different byte layout than encoding two top-level params
 * (`uint8, bytes`) — the tuple form starts with a 32-byte offset prefix that
 * CSW's `abi.decode(sig, (SignatureWrapper))` requires.
 */
export function wrapCswSignature(rawSig: string): Hex {
  return encodeAbiParameters(parseAbiParameters('(uint8 ownerIndex, bytes signatureData)'), [
    { ownerIndex: 0, signatureData: rawSig as Hex },
  ]);
}

/**
 * ERC-6492 magic suffix. A verifier that supports ERC-6492 checks the trailing
 * 32 bytes of a signature for this value; if present, it decodes the preceding
 * `(address factory, bytes factoryCalldata, bytes innerSig)` tuple, deploys the
 * counterfactual wallet by `CALL`ing the factory with factoryCalldata (inside
 * its `eth_call` simulation), then validates `innerSig` via the now-deployed
 * wallet's `isValidSignature`.
 */
export const ERC6492_MAGIC: Hex =
  '0x6492649264926492649264926492649264926492649264926492649264926492';

/**
 * CDP Embedded Wallet smart-account factory address. Deployed at the same
 * address on every chain (Base mainnet + Base Sepolia verified on-chain
 * 2026-06-04), so the CREATE2 account address it derives is identical
 * cross-chain — which is the whole reason a Sepolia-only account is verifiable
 * on Base mainnet once deployed counterfactually.
 *
 * NOTE: this is NOT the public Coinbase Smart Wallet factory
 * (`0x0BA5ED0c6AA8c49038F819E587E2633c4A9F428a`, implementation
 * `0x000100ab…`). CDP Embedded Wallets use a sibling factory with a different
 * account implementation (`0x00000110dCdEdC9581cb5eCB8467282f2926534d`), so
 * the standard factory's `getAddress` derives a different (wrong) address. We
 * verified on-chain that `getAddress([ownerEoa], 0)` on this factory reproduces
 * the live CDP smart-account address. Both share the `("Coinbase Smart Wallet",
 * "1")` ERC-1271 replaySafeHash domain, so the inner signature envelope is the
 * same for both.
 */
export const CDP_SMART_ACCOUNT_FACTORY =
  '0xba5ed110efdba3d005bfc882d75358acbbb85842';

/** The factory's ABI, for encoding `createAccount` / `getAddress` calls and decoding `getAddress`. */
export const coinbaseFactoryAbi = parseAbi([
  'function createAccount(bytes[] owners, uint256 nonce) payable returns (address)',
  'function getAddress(bytes[] owners, uint256 nonce) view returns (address)',
]);

/**
 * Encode a single EOA owner the way CoinbaseSmartWalletFactory stores it: the
 * 20-byte address left-padded to a 32-byte word (`abi.encode(address)`). The
 * factory's `owners` argument is `bytes[]`, one entry per owner; address owners
 * are 32 bytes, passkey owners are 64 bytes (`x ‖ y`).
 */
export function encodeAddressOwner(address: string): Hex {
  return pad(getAddress(address), { size: 32 }).toLowerCase() as Hex;
}

/**
 * Build the `createAccount(owners, nonce)` calldata that deploys the smart
 * account at its counterfactual address. The (owners, nonce) pair MUST be the
 * one that produced the account's address — the factory salt is
 * `keccak256(abi.encode(owners, nonce))`, so a wrong pair deploys a different
 * address and ERC-6492 verification fails.
 */
export function buildCoinbaseFactoryCalldata(
  owners: string[],
  nonce: bigint | number,
): Hex {
  return encodeFunctionData({
    abi: coinbaseFactoryAbi,
    functionName: 'createAccount',
    args: [owners as Hex[], BigInt(nonce)],
  });
}

/**
 * Wrap an ERC-1271 signature in the ERC-6492 deploy-then-verify envelope so a
 * not-yet-deployed (counterfactual) smart account can be validated off-chain.
 *
 * Layout: `abi.encode(address factory, bytes factoryCalldata, bytes innerSig)`
 * followed by {@link ERC6492_MAGIC}.
 */
export function wrapErc6492(args: {
  factory: string;
  factoryCalldata: string;
  innerSig: string;
}): Hex {
  const encoded = encodeAbiParameters(parseAbiParameters('address, bytes, bytes'), [
    args.factory as Hex,
    args.factoryCalldata as Hex,
    args.innerSig as Hex,
  ]);
  return concat([encoded, ERC6492_MAGIC]);
}
