/**
 * Talks to the Worker that commits markers.json. See worker/ for the other side.
 *
 * The passphrase travels with every request rather than being exchanged for a session:
 * there is one caller, it already holds the passphrase, and a token would only be another
 * thing to keep and expire.
 */
import { passphrase } from './access.js';

// Printed by `wrangler deploy`. Not a secret: it answers only to the origins listed in the
// Worker's ALLOWED_ORIGINS, and only to the passphrase. Empty would mean "saving is not set
// up here", which the editor shows instead of failing on click.
const SAVE_URL = 'https://fih-map-editor.fih-map-editor-worker.workers.dev/';

export const savingConfigured = () => SAVE_URL !== '';

/** The revision the editor started from, so a concurrent save is caught rather than lost. */
let baseSha = null;

export async function loadBaseSha() {
  const { sha } = await call({ action: 'sha' });
  baseSha = sha;
  return sha;
}

export async function saveMarkers(scene, markers) {
  const result = await call({ action: 'save', scene, markers, baseSha });

  // Keep the new revision, so a second save in the same session is not rejected as stale.
  baseSha = result.sha;
  return result;
}

/**
 * The editors' shared note. It is not in the repository - see worker/ - so it is read
 * through the same call the saves go through, and the passphrase is what makes it visible.
 */
export async function loadNotes() {
  return call({ action: 'notes' });
}

/** `baseAt` is the note's own timestamp when it was loaded, so a save cannot land on top
 * of a version this editor never saw. */
export async function saveNotes(text, baseAt) {
  return call({ action: 'notes-save', text, baseAt });
}

async function call(body) {
  const response = await fetch(SAVE_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, passphrase: passphrase() }),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);

  return payload;
}
