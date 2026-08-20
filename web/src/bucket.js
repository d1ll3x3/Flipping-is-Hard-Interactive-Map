/**
 * Putting a file in the map's own storage.
 *
 * One place for it because clips and photos go to the same bucket through the same Worker,
 * which is what checks the passphrase, the type and the size - see video-worker/.
 */
import { passphrase } from './access.js';

const UPLOAD_URL = 'https://fih-map-videos.fih-map-editor-worker.workers.dev/';

/**
 * Puts a file in the bucket and returns the address the map should point at.
 *
 * `name` only suggests the file name - the Worker sanitises it and adds a random tail, so
 * two people uploading "gap jump" do not overwrite each other and a re-upload is never
 * hidden behind the year-long cache these are served with.
 */
export async function upload(blob, name) {
  const response = await fetch(UPLOAD_URL, {
    method: 'PUT',
    headers: {
      'Content-Type': blob.type || 'application/octet-stream',
      'X-Passphrase': passphrase(),
      'X-Clip-Name': name,
    },
    body: blob,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Upload failed: HTTP ${response.status}`);

  return payload.url;
}
