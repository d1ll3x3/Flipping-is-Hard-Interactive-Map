/**
 * Gate in front of the marker editor.
 *
 * Be clear about what this is and is not. The site is static - there is no server to ask,
 * and everything in this file ships to the browser - so this cannot authenticate anyone.
 * What it does is keep the editor out of the hands of a visitor who stumbles onto ?edit=1,
 * without putting the passphrase itself in the repository: only its SHA-256 is here, and
 * the passphrase is long and random enough that the hash is not worth attacking.
 *
 * Saving to the repository is guarded by the same passphrase, but by the Worker rather
 * than by this file - see worker/. The hash below cannot stand in for it there: the hash
 * is public, so a Worker that accepted it would accept anyone who read this bundle.
 *
 * To change the passphrase, replace the hash below with the output of:
 *   node -e "console.log(require('crypto').createHash('sha256').update('YOUR PASSPHRASE').digest('hex'))"
 * and set the same value as the Worker's EDITOR_HASH secret.
 */
const EDITOR_HASH = 'b0db1f3c15d7e9807d8dfea881db7a96e2166c787f14cb379c8970552595a7eb';

// Per tab, not persisted beyond it: an editor who closes the tab is asked again, and
// nothing survives on a shared machine. The passphrase itself is kept, not just the fact
// that it was right, because the Worker has to be given it on every save.
const STORED = 'fih-map.editor';

/** True once the passphrase has been entered correctly in this tab. */
export async function unlockEditor() {
  if (await isValid(sessionStorage.getItem(STORED))) return true;

  const entered = prompt('Editor passphrase:');
  if (!entered) return false;

  if (!(await isValid(entered))) {
    alert('Wrong passphrase.');
    return false;
  }

  sessionStorage.setItem(STORED, entered);
  return true;
}

/** The passphrase this tab was unlocked with, for the Worker to check in turn. */
export const passphrase = () => sessionStorage.getItem(STORED) ?? '';

const isValid = async (candidate) => Boolean(candidate) && (await sha256(candidate)) === EDITOR_HASH;

/**
 * crypto.subtle only exists in a secure context - https, or localhost during development.
 * Both are how this site is ever served, so a missing crypto.subtle means something is
 * wrong rather than something to work around.
 */
async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
