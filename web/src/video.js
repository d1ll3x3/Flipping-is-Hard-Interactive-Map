/**
 * Turns a screen recording into a clip the map can serve, without leaving the browser.
 *
 * A recorder writes whatever bitrate it likes - the first clips off the capture were 18 Mbps
 * for seven seconds of a flat-shaded game - and that is what has to come down before a clip
 * is worth uploading. `tools/publish-clips.mjs` does it with ffmpeg for a whole folder at
 * once; this does it for the one clip somebody just picked in the editor, on a machine that
 * has no ffmpeg and no checkout.
 *
 * There is no encoder library here and no WebAssembly. The video is played into a
 * MediaRecorder, which re-encodes it with the browser's own H.264 encoder at the bitrate we
 * ask for. That means it runs in real time - a seven second clip takes seven seconds - which
 * for clips this length is a fair trade against a 30 MB download of somebody else's ffmpeg.
 */
import { passphrase } from './access.js';

const UPLOAD_URL = 'https://fih-map-videos.fih-map-editor-worker.workers.dev/';

// Enough for a game with flat colours and hard edges. Measured against the originals: the
// same clips at this rate are a third of the size and score 0.986 SSIM, which is not a
// difference anyone can see.
const BITRATE = 3_000_000;

// Long enough that a mis-picked full recording is obvious rather than a twenty minute wait.
const MAX_SECONDS = 120;

/** In order of preference: MP4 plays everywhere, WebM is the fallback where it does not. */
const FORMATS = [
  { mimeType: 'video/mp4;codecs=avc1', type: 'video/mp4' },
  { mimeType: 'video/webm;codecs=vp9', type: 'video/webm' },
  { mimeType: 'video/webm', type: 'video/webm' },
];

export const canCompress = () =>
  typeof MediaRecorder !== 'undefined' &&
  'captureStream' in HTMLVideoElement.prototype &&
  FORMATS.some((f) => MediaRecorder.isTypeSupported(f.mimeType));

/**
 * Re-encodes `file` at a sane bitrate. `onProgress` is called with 0..1 as it plays.
 *
 * Resolves to the original file untouched when it is already small enough - re-encoding an
 * already-small clip only loses quality for nothing.
 */
export async function compress(file, onProgress = () => {}) {
  const format = FORMATS.find((f) => MediaRecorder.isTypeSupported(f.mimeType));
  if (!format) throw new Error('This browser cannot re-encode video. Upload a smaller clip.');

  const video = document.createElement('video');
  video.src = URL.createObjectURL(file);
  video.muted = true;

  try {
    await new Promise((resolve, reject) => {
      video.onloadedmetadata = resolve;
      video.onerror = () => reject(new Error('That file is not a video this browser can read.'));
    });

    if (video.duration > MAX_SECONDS) {
      throw new Error(`That clip is ${Math.round(video.duration)}s long. Trim it to under ${MAX_SECONDS}s.`);
    }

    // Already lean: at this size and length there is nothing to gain and quality to lose.
    if (file.size * 8 < video.duration * BITRATE * 1.1) return file;

    const recorder = new MediaRecorder(video.captureStream(), {
      mimeType: format.mimeType,
      videoBitsPerSecond: BITRATE,
    });

    const parts = [];
    recorder.ondataavailable = (event) => event.data.size && parts.push(event.data);

    const stopped = new Promise((resolve, reject) => {
      recorder.onstop = resolve;
      recorder.onerror = () => reject(new Error('The browser stopped re-encoding partway through.'));
    });

    const tick = setInterval(() => onProgress(Math.min(video.currentTime / video.duration, 1)), 200);

    recorder.start();
    await video.play();
    await new Promise((resolve) => (video.onended = resolve));
    recorder.stop();
    await stopped;
    clearInterval(tick);
    onProgress(1);

    const out = new Blob(parts, { type: format.type });
    // A recorder that produced nothing, or produced more than we started with, is not an
    // improvement worth uploading.
    return out.size > 0 && out.size < file.size ? out : file;
  } finally {
    URL.revokeObjectURL(video.src);
  }
}

/**
 * Puts a clip in the bucket and returns the address the map should point at.
 *
 * `name` only suggests the file name - the Worker sanitises it and adds a random tail, so
 * two people uploading "gap jump" do not overwrite each other and a re-upload is never
 * hidden behind the year-long cache the clips are served with.
 */
export async function upload(blob, name) {
  const response = await fetch(UPLOAD_URL, {
    method: 'PUT',
    headers: {
      'Content-Type': blob.type || 'video/mp4',
      'X-Passphrase': passphrase(),
      'X-Clip-Name': name,
    },
    body: blob,
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error ?? `Upload failed: HTTP ${response.status}`);

  return payload.url;
}
