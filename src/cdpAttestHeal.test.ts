/**
 * Recovery from a wedged iOS App Attest key: the native module caches the
 * key ID in the Keychain before backend registration succeeds, and
 * createAssertion signs with it regardless of registration state — so a
 * single failed registration leaves every subsequent CDP auth request
 * carrying an assertion the backend rejects ("Attestation Key Not
 * registered. Please re-register the device"), with no SDK-side auto-heal.
 * The heal clears the dead key and runs the full attest+register flow so
 * the next attempt carries a key the backend knows.
 */
import {
  isAttestationWedgeError,
  healAttestationWedge,
  withAttestationHeal,
} from './cdpAttestHeal';

const mockAttestModule = {
  clearAttestation: jest.fn(),
  attest: jest.fn(),
  confirmRegistration: jest.fn(),
};
const mockApiClient = {
  generateAttestationChallenge: jest.fn(),
  registerAttestation: jest.fn(),
};

jest.mock('@coinbase/cdp-app-attest', () => mockAttestModule, { virtual: true });
jest.mock('@coinbase/cdp-api-client', () => mockApiClient, { virtual: true });

const PROJECT_ID = 'test-project-id';

beforeEach(() => {
  jest.clearAllMocks();
  mockAttestModule.clearAttestation.mockResolvedValue(undefined);
  mockAttestModule.attest.mockResolvedValue({
    ios: { keyId: 'new-key', attestation: 'att-b64', bundleId: 'com.example.app' },
  });
  mockAttestModule.confirmRegistration.mockResolvedValue(undefined);
  mockApiClient.generateAttestationChallenge.mockResolvedValue({ challenge: 'chal-b64' });
  mockApiClient.registerAttestation.mockResolvedValue({});
});

describe('isAttestationWedgeError', () => {
  test('matches the exact server message', () => {
    expect(
      isAttestationWedgeError('Attestation Key Not registered. Please re-register the device'),
    ).toBe(true);
  });

  test('matches case and phrasing variants', () => {
    expect(isAttestationWedgeError('attestation key not registered')).toBe(true);
    expect(isAttestationWedgeError('Please re-register the device')).toBe(true);
  });

  test('rejects unrelated auth errors', () => {
    expect(isAttestationWedgeError('Invalid or expired OTP')).toBe(false);
    expect(isAttestationWedgeError('Network request failed')).toBe(false);
    expect(isAttestationWedgeError(undefined)).toBe(false);
    expect(isAttestationWedgeError(null)).toBe(false);
    expect(isAttestationWedgeError('')).toBe(false);
  });
});

describe('healAttestationWedge', () => {
  test('clears the dead key, then attests and registers a fresh one', async () => {
    await expect(healAttestationWedge(PROJECT_ID)).resolves.toBe(true);

    // Clear must precede attest so the native module generates a NEW key
    // instead of reusing the cached (already-attested, unregistered) one.
    expect(mockAttestModule.clearAttestation.mock.invocationCallOrder[0]).toBeLessThan(
      mockAttestModule.attest.mock.invocationCallOrder[0],
    );
    expect(mockApiClient.generateAttestationChallenge).toHaveBeenCalledWith(PROJECT_ID);
    expect(mockAttestModule.attest).toHaveBeenCalledWith('chal-b64');
    expect(mockApiClient.registerAttestation).toHaveBeenCalledWith(PROJECT_ID, {
      challenge: 'chal-b64',
      ios: { keyId: 'new-key', attestation: 'att-b64', bundleId: 'com.example.app' },
    });
    expect(mockAttestModule.confirmRegistration).toHaveBeenCalledWith('new-key');
  });

  test('returns false without confirming when registration fails', async () => {
    mockApiClient.registerAttestation.mockRejectedValue(new Error('registration rejected'));
    await expect(healAttestationWedge(PROJECT_ID)).resolves.toBe(false);
    expect(mockAttestModule.confirmRegistration).not.toHaveBeenCalled();
  });

  test('returns false when the platform yields no iOS attestation (Android)', async () => {
    mockAttestModule.attest.mockResolvedValue({ android: { integrityToken: 'tok' } });
    await expect(healAttestationWedge(PROJECT_ID)).resolves.toBe(false);
    expect(mockApiClient.registerAttestation).not.toHaveBeenCalled();
  });

  test('returns false when the attest module is unavailable', async () => {
    mockAttestModule.clearAttestation.mockImplementation(() => {
      throw new Error('native module missing');
    });
    await expect(healAttestationWedge(PROJECT_ID)).resolves.toBe(false);
  });
});

describe('withAttestationHeal', () => {
  test('passes a success straight through without touching attestation', async () => {
    const fn = jest.fn().mockResolvedValue('ok');
    await expect(withAttestationHeal(fn, PROJECT_ID)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockAttestModule.clearAttestation).not.toHaveBeenCalled();
  });

  test('rethrows non-wedge errors without healing', async () => {
    const fn = jest.fn().mockRejectedValue(new Error('Invalid or expired OTP'));
    await expect(withAttestationHeal(fn, PROJECT_ID)).rejects.toThrow('Invalid or expired OTP');
    expect(fn).toHaveBeenCalledTimes(1);
    expect(mockAttestModule.clearAttestation).not.toHaveBeenCalled();
  });

  test('heals and retries once on the wedge error', async () => {
    const fn = jest
      .fn()
      .mockRejectedValueOnce(new Error('Attestation Key Not registered. Please re-register the device'))
      .mockResolvedValueOnce('ok');
    await expect(withAttestationHeal(fn, PROJECT_ID)).resolves.toBe('ok');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockAttestModule.clearAttestation).toHaveBeenCalledTimes(1);
  });

  test('rethrows the original error when the heal itself fails', async () => {
    mockApiClient.registerAttestation.mockRejectedValue(new Error('registration rejected'));
    const wedge = new Error('Attestation Key Not registered. Please re-register the device');
    const fn = jest.fn().mockRejectedValue(wedge);
    await expect(withAttestationHeal(fn, PROJECT_ID)).rejects.toBe(wedge);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  test('heals at most once — a second wedge error surfaces', async () => {
    const fn = jest
      .fn()
      .mockRejectedValue(new Error('Attestation Key Not registered. Please re-register the device'));
    await expect(withAttestationHeal(fn, PROJECT_ID)).rejects.toThrow('re-register');
    expect(fn).toHaveBeenCalledTimes(2);
    expect(mockAttestModule.clearAttestation).toHaveBeenCalledTimes(1);
  });
});
