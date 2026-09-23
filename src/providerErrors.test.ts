/**
 * toProviderRpcError classifies CDP failures into the EIP-1193 provider error
 * codes. Inputs are duck-typed replicas of cdp-core's `MfaError` and
 * cdp-api-client's `APIError` — the peer range starts below the release that
 * introduced MFA, so the classifier must not depend on either class existing.
 */

jest.mock('@coinbase/cdp-core', () => ({}));

import {
  CdpProviderRpcError,
  PROVIDER_ERROR_CODES,
  toProviderRpcError,
} from './providerErrors';
import { CdpUserOperationFailedError } from './cdpAccount';

/** The classifier returns `unknown` (pass-through keeps the caller's type); tests read the mapped shape. */
const map = (err: unknown) => toProviderRpcError(err) as CdpProviderRpcError;

function mfaError(code: string): Error {
  const err = new Error(`mfa ${code}`) as Error & { code: string };
  err.name = 'MfaError';
  err.code = code;
  return err;
}

function apiError(errorType: string, statusCode = 400): Error {
  const err = new Error(`api ${errorType}`) as Error & { errorType: string; statusCode: number };
  err.name = 'APIError';
  err.errorType = errorType;
  err.statusCode = statusCode;
  return err;
}

test('codes match EIP-1193', () => {
  expect(PROVIDER_ERROR_CODES).toEqual({
    userRejectedRequest: 4001,
    unauthorized: 4100,
    unsupportedMethod: 4200,
    disconnected: 4900,
    chainDisconnected: 4901,
  });
});

test('a cancelled MFA prompt is a user rejection', () => {
  const original = mfaError('CANCELLED');
  const mapped = map(original);
  expect(mapped).toBeInstanceOf(CdpProviderRpcError);
  expect(mapped.code).toBe(4001);
  expect(mapped.cause).toBe(original);
  expect(mapped.data).toEqual({ source: 'MfaError', reason: 'CANCELLED' });
});

test.each(['SUPERSEDED', 'LISTENER_REQUIRED', 'NO_LISTENER_MATCHED', 'SOME_FUTURE_CODE'])(
  'an MFA verification that did not complete (%s) is unauthorized, not a rejection',
  (code) => {
    const mapped = map(mfaError(code));
    expect(mapped.code).toBe(4100);
    expect(mapped.data).toEqual({ source: 'MfaError', reason: code });
  },
);

test.each([
  ['unauthorized', 401, 4100],
  ['forbidden', 403, 4100],
  ['mfa_required', 403, 4100],
  ['mfa_not_enrolled', 400, 4100],
  ['mfa_invalid_code', 400, 4100],
  ['mfa_flow_expired', 400, 4100],
  ['network_mismatch', 400, 4901],
  ['service_unavailable', 503, 4900],
  ['bad_gateway', 502, 4900],
  ['endpoint_unavailable', 503, 4900],
])('APIError %s → %d', (errorType, status, code) => {
  const mapped = map(apiError(errorType, status));
  expect(mapped.code).toBe(code);
  expect(mapped.data).toEqual({ source: 'APIError', reason: errorType, statusCode: status });
});

test.each([
  ['rate_limit_exceeded', 429],
  ['timed_out', 504],
  ['request_canceled', 499],
  ['invalid_request', 400],
])('an APIError with no EIP-1193 meaning (%s) keeps its identity', (errorType, status) => {
  const original = apiError(errorType, status);
  expect(toProviderRpcError(original)).toBe(original);
});

test('a failed userOp passes through so hosts can decode the revert', () => {
  const original = new CdpUserOperationFailedError('0xop', 'failed', '0xtx');
  expect(toProviderRpcError(original)).toBe(original);
});

test('an error that already carries a provider code passes through', () => {
  const original = new CdpProviderRpcError(4200, 'nope');
  expect(toProviderRpcError(original)).toBe(original);
});

test('unrelated errors pass through', () => {
  const original = new Error('boom');
  expect(toProviderRpcError(original)).toBe(original);
  expect(toProviderRpcError('str')).toBe('str');
  expect(toProviderRpcError(null)).toBe(null);
});

test('the error serialises as a provider RPC error', () => {
  const err = new CdpProviderRpcError(4001, 'User rejected the request.', { reason: 'x' });
  expect(err.name).toBe('ProviderRpcError');
  expect(err.message).toBe('User rejected the request.');
  expect(err).toBeInstanceOf(Error);
});
