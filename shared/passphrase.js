/**
 * The editor's passphrase check, shared by both Workers.
 *
 * One copy rather than two: the editor Worker guards commits with it and the video Worker
 * guards uploads with it, and security code that exists twice is security code that gets
 * fixed once.
 */

/**
 * Compares SHA-256 digests rather than the passphrase itself, so a Worker never has to hold
 * it in plain text - not in its configuration and not in memory.
 *
 * The comparison takes the same time whichever byte differs. That matters little against a
 * 96-bit random passphrase, but timing-safe comparison is free and the alternative is a
 * habit worth not having.
 */
export async function passphraseMatches(passphrase, expected) {
  if (typeof passphrase !== 'string' || !expected) return false;

  const digest = await sha256(passphrase);
  if (digest.length !== expected.length) return false;

  let difference = 0;
  for (let i = 0; i < digest.length; i++) difference |= digest.charCodeAt(i) ^ expected.charCodeAt(i);

  return difference === 0;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
