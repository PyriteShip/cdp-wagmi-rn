/**
 * EIP-1193 provider errors for the CDP wallet.
 *
 * viem (and so wagmi) turns a provider error into a typed error by its numeric
 * `code`: 4001 becomes `UserRejectedRequestError`, 4100 `UnauthorizedProviderError`,
 * 4200 `UnsupportedProviderMethodError`, 4900 `ProviderDisconnectedError`, 4901
 * `ChainDisconnectedError`. A CDP failure that reaches viem without one of these
 * codes lands as a generic `UnknownRpcError`, and a host cannot tell "the user
 * closed the MFA sheet" from "the signing service is down".
 *
 * `toProviderRpcError` classifies what the CDP SDK throws. It recognises
 * cdp-core's `MfaError` and cdp-api-client's `APIError` by shape (`name` plus
 * their own discriminant field), never by `instanceof`: the peer range reaches
 * back to cdp-core releases that predate MFA, and a host may resolve a second
 * copy of either package. Anything it does not recognise is returned unchanged
 * — in particular `CdpUserOperationFailedError`, which hosts decode for the
 * on-chain revert, and API failures such as rate limiting that carry no
 * EIP-1193 meaning.
 */

export const PROVIDER_ERROR_CODES = {
  /** The user rejected the request. */
  userRejectedRequest: 4001,
  /** The requested method and/or account has not been authorized by the user. */
  unauthorized: 4100,
  /** The provider does not support the requested method. */
  unsupportedMethod: 4200,
  /** The provider is disconnected from all chains. */
  disconnected: 4900,
  /** The provider is not connected to the requested chain. */
  chainDisconnected: 4901,
} as const;

export type ProviderErrorCode = (typeof PROVIDER_ERROR_CODES)[keyof typeof PROVIDER_ERROR_CODES];

/** An EIP-1193 `ProviderRpcError`. `cause` holds the CDP error it classifies. */
export class CdpProviderRpcError extends Error {
  readonly code: ProviderErrorCode;
  readonly data?: unknown;
  /** The CDP error this classifies. Declared here: the build's `lib` predates ES2022 `Error.cause`. */
  readonly cause?: unknown;

  constructor(code: ProviderErrorCode, message: string, data?: unknown, cause?: unknown) {
    super(message);
    this.name = 'ProviderRpcError';
    this.code = code;
    if (data !== undefined) this.data = data;
    if (cause !== undefined) this.cause = cause;
  }
}

const MESSAGES: Record<ProviderErrorCode, string> = {
  4001: 'User rejected the request.',
  4100: 'The requested method and/or account has not been authorized by the user.',
  4200: 'The provider does not support the requested method.',
  4900: 'The provider is disconnected from all chains.',
  4901: 'The provider is not connected to the requested chain.',
};

/** cdp-api-client `errorType`s that have an EIP-1193 meaning. */
const API_ERROR_CODES: Record<string, ProviderErrorCode> = {
  unauthorized: 4100,
  forbidden: 4100,
  mfa_required: 4100,
  mfa_not_enrolled: 4100,
  mfa_invalid_code: 4100,
  mfa_flow_expired: 4100,
  network_mismatch: 4901,
  service_unavailable: 4900,
  bad_gateway: 4900,
  endpoint_unavailable: 4900,
};

/** Builds a provider error with the code's standard message and CDP detail. */
export function providerRpcError(code: ProviderErrorCode, detail?: string, data?: unknown, cause?: unknown) {
  const message = detail ? `${MESSAGES[code]} ${detail}` : MESSAGES[code];
  return new CdpProviderRpcError(code, message, data, cause);
}

function mfaCode(reason: string): ProviderErrorCode {
  // Closing the verification sheet is the user declining. Every other MFA
  // outcome — superseded by a newer prompt, or no listener to show one — means
  // the request was never verified, which is not a decision the user made.
  return reason === 'CANCELLED' ? 4001 : 4100;
}

export function toProviderRpcError(err: unknown): unknown {
  if (!(err instanceof Error)) return err;
  const e = err as Error & { code?: unknown; errorType?: unknown; statusCode?: unknown };

  if (e instanceof CdpProviderRpcError) return e;

  if (e.name === 'MfaError' && typeof e.code === 'string') {
    return providerRpcError(mfaCode(e.code), e.message, { source: 'MfaError', reason: e.code }, e);
  }

  if (e.name === 'APIError' && typeof e.errorType === 'string') {
    const code = API_ERROR_CODES[e.errorType];
    if (code === undefined) return e;
    return providerRpcError(
      code,
      e.message,
      { source: 'APIError', reason: e.errorType, statusCode: e.statusCode },
      e,
    );
  }

  return e;
}
