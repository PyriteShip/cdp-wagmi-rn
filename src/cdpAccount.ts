/**
 * Framework-agnostic CDP smart-account capability core.
 *
 * This is the heart of the CDP wallet: the four operations a wallet exposes —
 * get-address, sign-message, sign-typed-data, send-calls — implemented directly
 * on `@coinbase/cdp-core` actions + the Coinbase Smart Wallet (CSW) ERC-1271 /
 * ERC-6492 wrapping. It depends on NO signing framework (no ethers signer, no
 * viem account), so it can be wrapped by:
 *   - `CdpEthersSigner` (the live ethers path today — see cdp.ts), and
 *   - `createCdpEip1193Provider` (the EIP-1193 boundary — see cdpEip1193.ts),
 *     which a future `cdp-wagmi-rn` wagmi connector lifts almost verbatim.
 *
 * Keeping both wrappers on this single core means the core is exercised by the
 * production signer path, not speculative dead code.
 */

import { ethers } from 'ethers';
import type { TypedDataDomain, TypedDataField } from 'ethers';
import {
  signEvmTypedData,
  sendUserOperation,
  getUserOperation,
} from '@coinbase/cdp-core';
import { getCdpState } from './cdpBridge';
import {
  buildCswReplaySafeTypedData,
  buildCswReplaySafeTypedDataForHash,
  wrapCswSignature,
  wrapErc6492,
  buildCoinbaseFactoryCalldata,
  encodeAddressOwner,
  coinbaseFactoryInterface,
  CDP_SMART_ACCOUNT_FACTORY,
} from './cdpCswWrap';
import type { CdpSignOpts, CdpSendOpts } from './cdpConfig';

const POLL_INTERVAL_MS = 1500;
const POLL_TIMEOUT_MS = 90_000;

/** A single call in a UserOperation batch (EIP-5792 / ethers tx shape). */
export interface CdpCall {
  to: string;
  value?: bigint;
  data?: string;
}

/** Current smart-account address from the CDP hooks bridge, falling back to the
 *  address captured at connect time. */
export function cdpGetAddress(smartAccount: string): string {
  return getCdpState().evmAddress ?? smartAccount;
}

/**
 * personal_sign for a Coinbase Smart Wallet: sign the EIP-191 hash wrapped in
 * the CSW replay-safe envelope (chainId = `opts.chainId`, the chain the verifier
 * runs on), then ERC-6492-wrap so a counterfactual account can be deployed inside
 * the verifier's eth_call. `readProvider` is used only to probe the factory
 * CREATE2 address; null falls back to nonce 0.
 *
 * The provider passes its own `cfg.chainId`; a caller whose verifier lives on a
 * different chain (e.g. an off-chain ERC-1271 verifier that only runs on mainnet)
 * passes that chain's id.
 */
export async function cdpSignMessage(
  message: string | Uint8Array,
  smartAccount: string,
  readProvider: ethers.Provider | null,
  opts: CdpSignOpts,
): Promise<string> {
  const eoa = getCdpState().evmEoaAddress;
  if (!eoa) throw new Error('cdpSignMessage: no EOA in CDP state');

  const factory = opts.smartAccountFactory ?? CDP_SMART_ACCOUNT_FACTORY;
  const innerHash = ethers.hashMessage(message);
  const envelope = buildCswReplaySafeTypedDataForHash({
    hash: innerHash,
    smartAccount,
    chainId: opts.chainId,
  });
  const result = await signEvmTypedData({
    evmAccount: eoa as `0x${string}`,
    typedData: envelope as Parameters<typeof signEvmTypedData>[0]['typedData'],
  });
  const innerSig = wrapCswSignature(result.signature);

  const factoryCalldata = await resolveFactoryCalldata(eoa, smartAccount, readProvider, factory);
  return wrapErc6492({
    factory,
    factoryCalldata,
    innerSig,
  });
}

/**
 * Reconstruct the CSW factory `createAccount` calldata that deploys
 * `smartAccount` for `owners = [eoa]`, by probing the factory's pure CREATE2
 * `getAddress` over a small nonce range. Identical on every chain.
 */
async function resolveFactoryCalldata(
  eoa: string,
  smartAccount: string,
  provider: ethers.Provider | null,
  factory: string,
): Promise<string> {
  const owners = [encodeAddressOwner(eoa)];
  const target = ethers.getAddress(smartAccount);
  if (provider) {
    for (let nonce = 0; nonce <= 8; nonce++) {
      try {
        const data = coinbaseFactoryInterface.encodeFunctionData('getAddress', [owners, nonce]);
        const ret = await provider.call({ to: factory, data });
        const [predicted] = coinbaseFactoryInterface.decodeFunctionResult('getAddress', ret);
        if (ethers.getAddress(predicted as string) === target) {
          return buildCoinbaseFactoryCalldata(owners, nonce);
        }
      } catch (err: any) {
        console.warn('[cdp] factory.getAddress probe failed at nonce', nonce, err?.message ?? err);
        break;
      }
    }
    console.warn(
      `[cdp] ERC-6492: could not match ${target} to owners=[${eoa}] over nonce 0..8 — ` +
        'account may carry extra owners (e.g. a passkey). Falling back to nonce 0.',
    );
  }
  return buildCoinbaseFactoryCalldata(owners, 0);
}

/**
 * EIP-712 typed-data signing for a Coinbase Smart Wallet: sign the offer digest
 * wrapped in CSW's replay-safe envelope (chainId = `opts.chainId`, the chain the
 * on-chain verifier runs on) with the owner EOA, then
 * `abi.encode(ownerIndex, sig)`-wrap it for ERC-1271.
 */
export async function cdpSignTypedData(
  domain: TypedDataDomain,
  types: Record<string, TypedDataField[]>,
  value: Record<string, unknown>,
  smartAccount: string,
  opts: CdpSignOpts,
): Promise<string> {
  const primaryType = Object.keys(types).find((k) => k !== 'EIP712Domain');
  if (!primaryType) throw new Error('cdpSignTypedData: no primaryType in types');

  const eoa = getCdpState().evmEoaAddress;
  if (!eoa) throw new Error('cdpSignTypedData: no EOA in CDP state');

  const envelope = buildCswReplaySafeTypedData({
    originalDomain: domain,
    originalTypes: types,
    originalValue: value,
    smartAccount,
    chainId: opts.chainId,
  });
  let inner: string;
  try {
    const result = await signEvmTypedData({
      evmAccount: eoa as `0x${string}`,
      typedData: envelope as Parameters<typeof signEvmTypedData>[0]['typedData'],
    });
    inner = result.signature;
  } catch (err: any) {
    console.error('[cdp] signEvmTypedData failed:', err?.message ?? err);
    if (err?.response) {
      console.error('[cdp] response status:', err.response.status);
      console.error('[cdp] response body:', JSON.stringify(err.response.data));
    }
    throw err;
  }
  return wrapCswSignature(inner);
}

/**
 * Execute one or more calls as a single sponsored UserOperation and return the
 * on-chain transaction hash once the bundler includes it. Throws if the userOp
 * is dropped, fails, or times out.
 *
 * (Send/poll logic lifted from the former `CdpEthersSigner.sendTransaction` +
 * `waitForUserOpTransactionHash`. Returns the hash only; callers that need an
 * `ethers.TransactionResponse` resolve it via their own provider.)
 */
export async function cdpSendCalls(
  calls: CdpCall[],
  smartAccount: string,
  opts: CdpSendOpts,
): Promise<string> {
  if (calls.length === 0) throw new Error('cdpSendCalls: no calls');
  const op = await sendUserOperation({
    evmSmartAccount: smartAccount as `0x${string}`,
    network: opts.cdpNetwork,
    calls: calls.map((c) => ({
      to: c.to as `0x${string}`,
      ...(c.value !== undefined ? { value: c.value } : {}),
      ...(c.data !== undefined ? { data: c.data as `0x${string}` } : {}),
    })),
    useCdpPaymaster: true,
  });
  return waitForUserOpTransactionHash(op.userOperationHash, smartAccount, opts);
}

/**
 * A UserOperation that CDP reports as `failed` or `dropped`.
 *
 * `failed` means the operation was included but its calls reverted, so
 * `transactionHash` names the bundle transaction whose receipt records the
 * revert. `dropped` means it was never included, and `transactionHash` is
 * unset.
 */
export class CdpUserOperationFailedError extends Error {
  readonly userOperationHash: string;
  readonly status: 'failed' | 'dropped';
  readonly transactionHash: string | undefined;

  constructor(userOperationHash: string, status: 'failed' | 'dropped', transactionHash?: string) {
    super(
      `CDP UserOp ${userOperationHash} ${status}${transactionHash ? ` (tx ${transactionHash})` : ''}`,
    );
    this.name = 'CdpUserOperationFailedError';
    this.userOperationHash = userOperationHash;
    this.status = status;
    this.transactionHash = transactionHash;
  }
}

export async function waitForUserOpTransactionHash(
  userOpHash: string,
  smartAccount: string,
  opts: CdpSendOpts,
): Promise<string> {
  const start = Date.now();
  while (Date.now() - start < POLL_TIMEOUT_MS) {
    const state = await getUserOperation({
      userOperationHash: userOpHash as `0x${string}`,
      evmSmartAccount: smartAccount as `0x${string}`,
      network: opts.cdpNetwork,
    });
    // A failed userOp can still carry a transactionHash: the bundle
    // transaction mined, but the operation's own calls reverted inside it. The
    // status check comes first so that outcome is never returned as a hash.
    if (state.status === 'failed' || state.status === 'dropped') {
      throw new CdpUserOperationFailedError(userOpHash, state.status, state.transactionHash || undefined);
    }
    if (state.transactionHash) return state.transactionHash;
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  throw new Error(`CDP UserOp ${userOpHash} timed out waiting for inclusion`);
}
