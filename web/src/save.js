/**
 * Talks to the Worker that commits markers.json. See worker/ for the other side.
 *
 * The passphrase travels with every request rather than being exchanged for a session:
 * there is one caller, it already holds the passphrase, and a token would only be another
 * thing to keep and expire.
 */
import { passphrase } from './access.js';

// Set after deploying the Worker - `wrangler deploy` prints the URL. Empty until then,
// which the editor reads as "saving is not set up here" rather than failing on click.
const SAVE_URL = '';

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
