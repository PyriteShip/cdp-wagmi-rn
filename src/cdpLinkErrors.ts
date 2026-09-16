/**
 * Recognises a CDP refusal to link an email or phone that already belongs to
 * a different CDP user.
 *
 * CDP reports it as an API error (`@coinbase/cdp-api-client`'s `APIError`)
 * with `errorType: 'already_exists'` and a message such as "This email is
 * already linked to another account." — at the verify step, after the code
 * was sent. There is no `code` field on that error; `METHOD_ALREADY_LINKED`
 * in `code` is the SDK-side shape and is accepted too. The message match is
 * the last resort for an error that carries neither.
 */
export function isAlreadyLinkedError(e: unknown): boolean {
  if (typeof e !== 'object' || e === null) return false;
  const err = e as { code?: unknown; errorType?: unknown; errorMessage?: unknown; message?: unknown };
  if (err.code === 'METHOD_ALREADY_LINKED') return true;
  if (err.errorType === 'already_exists') return true;
  const text = [err.errorMessage, err.message].filter((v): v is string => typeof v === 'string').join(' ');
  return /already linked/i.test(text);
}
