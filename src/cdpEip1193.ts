/**
 * EIP-1193 provider over the CDP capability core (`cdpAccount.ts`).
 *
 * This is the wallet boundary a wagmi connector consumes: `createConnector`'s
 * `getProvider()` returns exactly this shape, and viem builds its WalletClient
 * from it. A future `cdp-wagmi-rn` package lifts this module almost verbatim
 * into its connector — which is why it lives standalone rather than inside the
 * ethers signer.
 *
 * It routes the wallet-affecting JSON-RPC methods to the CDP core and forwards
 * everything else (reads) to an injected ethers provider. Smart-account sends
 * are exposed both as legacy `eth_sendTransaction` and as EIP-5792
 * `wallet_sendCalls` (the idiomatic account-abstraction path wagmi prefers).
 *
 * Failures carry EIP-1193 provider error codes (see `providerErrors.ts`): 4001
 * when the user closes the MFA prompt, 4100 when there is no signed-in account
 * or the request was never verified, 4200 for a method this wallet cannot
 * serve, 4900 when the CDP signing service is unreachable, and 4901 for a
 * request naming a chain other than `cfg.chainId`.
 */

import { ethers } from 'ethers';
import type { Eip1193Provider } from 'ethers';
import {
  cdpGetAddress,
  cdpSignMessage,
  cdpSignTypedData,
  cdpSendCalls,
  type CdpCall,
} from './cdpAccount';
import type { CdpWalletConfig } from './cdpConfig';
import { providerRpcError, toProviderRpcError } from './providerErrors';

interface Params {
  smartAccount: string;
  readProvider: ethers.Provider;
  cfg: CdpWalletConfig;
}

/**
 * Signing methods a smart account cannot serve: `eth_sign` signs raw hashes (a
 * phishing vector every major wallet disables), a smart account has no
 * transaction of its own to sign, and v1/v3 typed data predate the v4 encoding
 * the ERC-1271 envelope wraps. Rejected here so they never reach the read
 * provider, which would answer for an account it does not hold.
 */
const UNSUPPORTED_METHODS = new Set([
  'eth_sign',
  'eth_signTransaction',
  'eth_signTypedData',
  'eth_signTypedData_v1',
  'eth_signTypedData_v3',
]);

/** Parses an EIP-155 chain id given as hex or decimal; undefined when absent. */
function parseChainId(v: unknown): number | undefined {
  if (v == null || v === '') return undefined;
  if (typeof v === 'number') return v;
  if (typeof v === 'bigint') return Number(v);
  if (typeof v === 'string') return Number(v.startsWith('0x') || v.startsWith('0X') ? BigInt(v) : v);
  return NaN;
}

function toBigIntOrUndefined(v: unknown): bigint | undefined {
  if (v == null || v === '0x' || v === '') return undefined;
  return BigInt(v as string | number | bigint);
}

/** Normalize a raw `eth_sendTransaction` / `wallet_sendCalls` call object. */
function toCdpCall(call: any): CdpCall {
  return {
    to: call.to,
    value: toBigIntOrUndefined(call.value),
    data: call.data ?? undefined,
  };
}

export function createCdpEip1193Provider({ smartAccount, readProvider, cfg }: Params): Eip1193Provider {
  const CHAIN_ID_HEX = `0x${cfg.chainId.toString(16)}`;
  // Sign-envelope opts: a normal wallet signs against its own chain.
  const signOpts = { chainId: cfg.chainId, smartAccountFactory: cfg.smartAccountFactory };
  const sendOpts = { cdpNetwork: cfg.cdpNetwork };

  // `.send(method, params)` is the JSON-RPC passthrough for reads. Present on
  // JsonRpcProvider (what the connector passes); guarded for other providers.
  const passthrough = (readProvider as unknown as {
    send?: (method: string, params: any[]) => Promise<any>;
  }).send?.bind(readProvider);

  /** Rejects a request that names a chain this wallet is not connected to. */
  function assertChain(requested: unknown): void {
    const id = parseChainId(requested);
    if (id !== undefined && id !== cfg.chainId) {
      throw providerRpcError(4901, `Requested chain ${String(requested)}, connected to ${cfg.chainId}.`);
    }
  }

  async function request(args: { method: string; params?: any[] | Record<string, any> }): Promise<any> {
    try {
      return await route(args);
    } catch (err) {
      throw toProviderRpcError(err);
    }
  }

  async function route({ method, params }: { method: string; params?: any[] | Record<string, any> }): Promise<any> {
    const p = (Array.isArray(params) ? params : []) as any[];
    if (UNSUPPORTED_METHODS.has(method)) throw providerRpcError(4200, `"${method}"`);
    // Resolve the smart-account address LIVE per request (from the CDP bridge),
    // not the value captured when this provider was built. wagmi may call
    // getProvider() before the bridge has surfaced the address, so the captured
    // `smartAccount` can be '' — which would land as an empty verifyingContract /
    // evmAccount and fail CDP's address-schema validation.
    const account = cdpGetAddress(smartAccount);
    // Every method that acts as the account needs one; with no CDP session
    // there is nothing to sign with, and passing '' on fails CDP's address
    // schema with an error that reads like a bug rather than "signed out".
    const requireAccount = () => {
      if (!account) throw providerRpcError(4100, 'No CDP session is signed in.');
      return account;
    };
    switch (method) {
      case 'eth_accounts':
        return account ? [account] : [];

      case 'eth_requestAccounts':
        return [requireAccount()];

      case 'eth_chainId':
        return CHAIN_ID_HEX;

      case 'personal_sign': {
        // params: [message, address]. Message is hex-encoded data per spec;
        // pass raw bytes when hex so the EIP-191 hash matches.
        requireAccount();
        const raw = p[0];
        const message = typeof raw === 'string' && raw.startsWith('0x') ? ethers.getBytes(raw) : raw;
        return await cdpSignMessage(message, account, readProvider, signOpts);
      }

      case 'eth_signTypedData_v4': {
        // params: [address, typedDataJSONorObject]
        requireAccount();
        const td = typeof p[1] === 'string' ? JSON.parse(p[1]) : p[1];
        return await cdpSignTypedData(td.domain, td.types, td.message, account, signOpts);
      }

      case 'eth_sendTransaction': {
        requireAccount();
        assertChain(p[0]?.chainId);
        return await cdpSendCalls([toCdpCall(p[0])], account, sendOpts);
      }

      // ── EIP-5792 (the AA-native path wagmi's useSendCalls uses) ──────────
      case 'wallet_sendCalls': {
        requireAccount();
        const req = p[0] ?? {};
        assertChain(req.chainId);
        const calls = (req.calls ?? []).map(toCdpCall);
        const txHash = await cdpSendCalls(calls, account, sendOpts);
        return { id: txHash };
      }

      case 'wallet_getCallsStatus': {
        const id = p[0];
        const receipt = passthrough ? await readProvider.getTransactionReceipt(id) : null;
        if (!receipt) return { status: 'PENDING', receipts: [] };
        // viem's getCallsStatus hex-decodes `blockNumber` AND `gasUsed`
        // (`hexToBigInt`) unconditionally — omitting gasUsed makes it call
        // `BigInt(undefined)` → "Invalid argument to BigInt()" the moment a
        // CDP batch (extend/start) confirms. Pass every field it reads as hex,
        // and forward `logs` so the batched startRental event parse works.
        return {
          status: 'CONFIRMED',
          receipts: [{
            transactionHash: receipt.hash,
            blockHash: receipt.blockHash,
            blockNumber: `0x${receipt.blockNumber.toString(16)}`,
            gasUsed: `0x${receipt.gasUsed.toString(16)}`,
            status: receipt.status === 1 ? '0x1' : '0x0',
            logs: receipt.logs,
          }],
        };
      }

      case 'wallet_getCapabilities':
        // Sponsored gas via CDP's paymaster + EIP-5792 atomic batch (one userOp
        // executes multiple calls atomically) on the rental chain.
        return {
          [CHAIN_ID_HEX]: {
            paymasterService: { supported: true },
            atomic: { status: 'supported' },
          },
        };

      // A wallet on one chain: switching to it is a no-op, switching away is
      // not possible.
      case 'wallet_switchEthereumChain':
        assertChain(p[0]?.chainId);
        return null;

      default: {
        // Wallet methods are this provider's to answer; the read provider is a
        // node and would answer for an account it does not hold.
        if (method.startsWith('wallet_')) throw providerRpcError(4200, `"${method}"`);
        if (!passthrough) throw providerRpcError(4200, `"${method}" (no read provider).`);
        return await passthrough(method, p);
      }
    }
  }

  return { request };
}
