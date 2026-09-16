import { isAlreadyLinkedError } from './cdpLinkErrors';

describe('isAlreadyLinkedError', () => {
  // Observed from CDP: linking an email that belongs to a different CDP user
  // fails at the VERIFY step with this exact shape and no `code` field. Missing
  // it reports a generic "wrong code" for a contact that is simply taken, which
  // sends the user round the OTP loop forever.
  it('recognises the CDP API error with errorType already_exists and no code', () => {
    expect(isAlreadyLinkedError({
      statusCode: 409,
      errorType: 'already_exists',
      errorMessage: 'This email is already linked to another account.',
      message: 'This email is already linked to another account.',
    })).toBe(true);
  });

  it('recognises the SDK-side METHOD_ALREADY_LINKED code', () => {
    expect(isAlreadyLinkedError({ code: 'METHOD_ALREADY_LINKED', message: 'x' })).toBe(true);
  });

  it('falls back to the message when neither field is present', () => {
    expect(isAlreadyLinkedError(new Error('This phone number is already linked to another account.'))).toBe(true);
  });

  it('does not match an ordinary verification failure', () => {
    expect(isAlreadyLinkedError({ errorType: 'invalid_request', errorMessage: 'Invalid OTP' })).toBe(false);
    expect(isAlreadyLinkedError(new Error('Verification timed out after 30s'))).toBe(false);
  });

  it('is false for non-objects', () => {
    expect(isAlreadyLinkedError(undefined)).toBe(false);
    expect(isAlreadyLinkedError('already linked')).toBe(false);
  });
});
