/**
 * EIP-1193 provider over the CDP capability core (`cdpAccount.ts`).
 *
 * This is the wallet boundary the wagmi connector consumes: `createConnector`'s
 * `getProvider()` returns exactly this shape, and viem builds its WalletClient
 * from it. Non-wagmi hosts can use it directly.
 *
 * It routes the wallet-affecting JSON-RPC methods to the CDP core and forwards
 * everything else (reads) to an injected read client (`CdpReadClient`).
 * Smart-account sends are exposed both as legacy `eth_sendTransaction` and as
 * EIP-5792 `wallet_sendCalls` (the idiomatic account-abstraction path wagmi
 * prefers).
 *
 * Failures carry EIP-1193 provider error codes (see `providerErrors.ts`): 4001
 * when the user closes the MFA prompt, 4100 when there is no signed-in account
 * or the request was never verified, 4200 for a method this wallet cannot
 * serve, 4900 when the CDP signing service is unreachable, and 4901 for a
 * request naming a chain other than `cfg.chainId`.
 */

import { hexToBytes, type Hex } from 'viem';
import {
  cdpGetAddress,
  cdpSignMessage,
  cdpSignTypedData,
  cdpSendCalls,
  type CdpCall,
} from './cdpAccount';
import type { CdpReadClient, CdpWalletConfig } from './cdpConfig';
import { providerRpcError, toProviderRpcError } from './providerErrors';

/** The EIP-1193 provider shape `createCdpEip1193Provider` returns. */
export interface CdpEip1193Provider {
  request(args: { method: string; params?: any[] | Record<string, any> }): Promise<any>;
}

interface Params {
  smartAccount: string;
  readClient: CdpReadClient;
  cfg: CdpWalletConfig;
}

/** The fields of a JSON-RPC `eth_getTransactionReceipt` result this provider reads. */
interface RpcReceipt {
  transactionHash: Hex;
  blockHash: Hex;
  blockNumber: Hex;
  gasUsed: Hex;
  status: Hex;
  logs: unknown[];
}

/**
 * Signing methods a smart account cannot serve: `eth_sign` signs raw hashes (a
 * phishing vector every major wallet disables), a smart account has no
 * transaction of its own to sign, and v1/v3 typed data predate the v4 encoding
 * the ERC-1271 envelope wraps. Rejected here so they never reach the read
 * client, which would answer for an account it does not hold.
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

export function createCdpEip1193Provider({ smartAccount, readClient, cfg }: Params): CdpEip1193Provider {
  const CHAIN_ID_HEX = `0x${cfg.chainId.toString(16)}`;
  // Sign-envelope opts: a normal wallet signs against its own chain.
  const signOpts = { chainId: cfg.chainId, smartAccountFactory: cfg.smartAccountFactory };
  const sendOpts = { cdpNetwork: cfg.cdpNetwork };

  // The JSON-RPC passthrough for reads; guarded for a client without `request`.
  const passthrough =
    typeof readClient?.request === 'function'
      ? (method: string, params: unknown[]) => readClient.request({ method, params })
      : undefined;

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
        const message = typeof raw === 'string' && raw.startsWith('0x') ? hexToBytes(raw as Hex) : raw;
        return await cdpSignMessage(message, account, readClient, signOpts);
      }

      case 'eth_signTypedData_v4': {
        // params: [address, typedDataJSONorObject]
        requireAccount();
        const td = typeof p[1] === 'string' ? JSON.parse(p[1]) : p[1];
        return await cdpSignTypedData(td.domain, td.types, td.message, account, signOpts, td.primaryType);
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
        const receipt = passthrough
          ? ((await passthrough('eth_getTransactionReceipt', [id])) as RpcReceipt | null)
          : null;
        if (!receipt) return { status: 'PENDING', receipts: [] };
        // viem's getCallsStatus hex-decodes `blockNumber` AND `gasUsed`
        // (`hexToBigInt`) unconditionally, so both must be present hex strings
        // or it throws "Invalid argument to BigInt()" the moment a batch
        // confirms. The JSON-RPC receipt already carries them as hex; `logs`
        // are forwarded for hosts that parse events out of the batch.
        return {
          status: 'CONFIRMED',
          receipts: [{
            transactionHash: receipt.transactionHash,
            blockHash: receipt.blockHash,
            blockNumber: receipt.blockNumber,
            gasUsed: receipt.gasUsed,
            status: receipt.status,
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
        // Wallet methods are this provider's to answer; the read client is a
        // node and would answer for an account it does not hold.
        if (method.startsWith('wallet_')) throw providerRpcError(4200, `"${method}"`);
        if (!passthrough) throw providerRpcError(4200, `"${method}" (no read client).`);
        return await passthrough(method, p);
      }
    }
  }

  return { request };
}
