/**
 * Recovery from a wedged iOS App Attest key.
 *
 * The @coinbase/cdp-app-attest native module caches its App Attest key ID in
 * the Keychain the moment the key is generated — before Apple attestation and
 * CDP backend registration succeed — and createAssertion signs with that
 * cached key regardless of registration state. The Keychain survives app
 * uninstall/reinstall, so one failed registration leaves the device
 * permanently sending assertions the backend rejects with "Attestation Key
 * Not registered. Please re-register the device". The SDK's built-in retry
 * only covers a 404 thrown from assertion generation or an Apple
 * `devicecheck error 2`, neither of which fires here (the rejection arrives
 * on the auth endpoint), so the wedge never self-heals.
 *
 * The heal is safe by construction: it runs only after the backend has
 * already rejected the stored key, so that key has no standing to lose. The
 * account credential is the SMS/email OTP — the attestation key is a
 * device-integrity gate, not an account key — and clearing it touches
 * neither the refresh token nor any wallet material. Clearing + fresh
 * attest/register is also exactly the recovery Coinbase's own SDK performs
 * for the error paths it does detect.
 *
 * Everything is lazy-required and fail-soft. A build where the attest module
 * is absent — a simulator, a sideload, any host that opts out of App Attest —
 * cannot raise the wedge error in the first place; if the heal is reached
 * there anyway it reports failure without throwing. `@coinbase/cdp-app-attest`
 * and `@coinbase/cdp-api-client` are therefore optional peers: required only
 * inside the try, never at module load.
 */

const WEDGE_RE = /attestation key not registered|re-register the device/i;

export function isAttestationWedgeError(message: string | null | undefined): boolean {
  return !!message && WEDGE_RE.test(message);
}

/**
 * Clear the dead key and run the full attest+register flow so the device
 * ends holding a key the CDP backend recognizes. Returns false (never
 * throws) if any step fails — the caller then surfaces the original error.
 */
export async function healAttestationWedge(projectId: string): Promise<boolean> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const attestMod = require('@coinbase/cdp-app-attest');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const apiClient = require('@coinbase/cdp-api-client');

    await attestMod.clearAttestation();
    const { challenge } = await apiClient.generateAttestationChallenge(projectId);
    if (!challenge) return false;
    const result = await attestMod.attest(challenge);
    if (!result?.ios) return false;
    await apiClient.registerAttestation(projectId, {
      challenge,
      ios: {
        keyId: result.ios.keyId,
        attestation: result.ios.attestation,
        bundleId: result.ios.bundleId,
      },
    });
    await attestMod.confirmRegistration(result.ios.keyId);
    console.log('[cdpAttestHeal] re-registered App Attest key');
    return true;
  } catch (e) {
    console.warn('[cdpAttestHeal] heal failed', e instanceof Error ? e.message : e);
    return false;
  }
}

/**
 * Run an auth call; if it fails with the wedge error, heal and retry once.
 * A failed heal — or a second wedge — rethrows the original error so the
 * caller's normal error path handles it.
 */
export async function withAttestationHeal<T>(
  fn: () => Promise<T>,
  projectId: string,
): Promise<T> {
  try {
    return await fn();
  } catch (e: unknown) {
    const message = e instanceof Error ? e.message : undefined;
    if (!isAttestationWedgeError(message)) throw e;
    console.warn('[cdpAttestHeal] wedged App Attest key detected — clearing and re-registering');
    const healed = await healAttestationWedge(projectId);
    if (!healed) throw e;
    return await fn();
  }
}
