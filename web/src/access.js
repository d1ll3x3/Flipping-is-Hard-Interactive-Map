/**
 * Gate in front of the marker editor.
 *
 * Be clear about what this is and is not. The site is static - there is no server to ask,
 * and everything in this file ships to the browser - so this cannot authenticate anyone.
 * What it does is keep the editor out of the hands of a visitor who stumbles onto ?edit=1,
 * without putting the passphrase itself in the repository: only its SHA-256 is here, and
 * the passphrase is long and random enough that the hash is not worth attacking.
 *
 * The real protection is elsewhere and always was: the editor has no backend and can only
 * download a markers.json, so a change reaches the site through a commit, and who may
 * commit is decided by the repository's permissions.
 *
 * To change the passphrase, replace the hash below with the output of:
 *   node -e "console.log(require('crypto').createHash('sha256').update('YOUR PASSPHRASE').digest('hex'))"
 */
const EDITOR_HASH = 'b0db1f3c15d7e9807d8dfea881db7a96e2166c787f14cb379c8970552595a7eb';

// Per tab, not persisted: an editor who closes the tab is asked again, and nothing about
// the passphrase survives on a shared machine.
const UNLOCKED = 'fih-map.editor';

/** True once the passphrase has been entered correctly in this tab. */
export async function unlockEditor() {
  if (sessionStorage.getItem(UNLOCKED) === EDITOR_HASH) return true;

  const passphrase = prompt('Editor passphrase:');
  if (!passphrase) return false;

  if ((await sha256(passphrase)) !== EDITOR_HASH) {
    alert('Wrong passphrase.');
    return false;
  }

  sessionStorage.setItem(UNLOCKED, EDITOR_HASH);
  return true;
}

/**
 * crypto.subtle only exists in a secure context - https, or localhost during development.
 * Both are how this site is ever served, so a missing crypto.subtle means something is
 * wrong rather than something to work around.
 */
async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
