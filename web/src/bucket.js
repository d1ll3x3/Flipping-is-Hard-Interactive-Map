/**
 * Putting a file in the map's own storage.
 *
 * One place for it because clips and photos go to the same bucket through the same Worker,
 * which is what checks the passphrase, the type and the size - see video-worker/.
 */
import { passphrase } from './access.js';

const UPLOAD_URL = 'https://fih-map-videos.fih-map-editor-worker.workers.dev/';

/**
 * A name a header can carry.
 *
 * Header values are latin-1 and the marker names are not: every generated one has an em
 * dash in it ("NPC - Game Dude" is written with the long dash), and fetch refuses to send
 * that at all - it throws before anything leaves the browser, which is what "String contains
 * non ISO-8859-1 code point" was.
 *
 * Accents are folded rather than dropped, so "Tunel" written with one keeps its letters.
 * That is what the two passes are for: NFKD splits a letter into its base and a combining
 * mark, so the marks go first and only then does everything else left outside ASCII become
 * a space - taking the marks out with the same brush turned "Tunel" into "Tu nel".
 *
 * Whatever is left costs nothing: the Worker keeps [a-z0-9] and hyphenates the rest anyway.
 */
export const headerSafe = (name) =>
  (name ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^\x20-\x7E]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim() || 'file';

/**
 * Puts a file in the bucket and returns the address the map should point at.
 *
 * `name` only suggests the file name - the Worker sanitises it and adds a random tail, so
 * two people uploading "gap jump" do not overwrite each other and a re-upload is never
 * hidden behind the year-long cache these are served with.
 */
/**
 * Everything in the bucket, newest first.
 *
 * The Worker will not list itself to a stranger, so this needs the passphrase like an
 * upload does - which is why the media page asks for it before it shows anything.
 */
export async function list() {
  const response = await fetch(`${UPLOAD_URL}?list=1`, {
    headers: { 'X-Passphrase': passphrase() },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);

  return payload.objects.sort((a, b) => String(b.uploaded).localeCompare(String(a.uploaded)));
}

/**
 * Takes a file out of the bucket. There is no undo: R2 keeps no copy, and the file is not
 * in the repository either.
 */
export async function remove(key) {
  const response = await fetch(UPLOAD_URL + encodeURIComponent(key), {
    method: 'DELETE',
    headers: { 'X-Passphrase': passphrase() },
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `HTTP ${response.status}`);

  return payload.deleted;
}

/** The address a bucket key is served at, and the key behind an address. */
export const addressOf = (key) => UPLOAD_URL + encodeURIComponent(key);
export const keyOf = (url) => (url.startsWith(UPLOAD_URL) ? decodeURIComponent(url.slice(UPLOAD_URL.length)) : null);

export async function upload(blob, name) {
  const response = await fetch(UPLOAD_URL, {
    method: 'PUT',
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'X-Passphrase': passphrase(),
      'X-Clip-Name': headerSafe(name),
    },
    body: blob,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Upload failed: HTTP ${response.status}`);

  return payload.url;
}
