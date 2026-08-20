/**
 * Shrinks a screenshot to something worth putting on the map, in the browser.
 *
 * The same argument as video.js: what comes off a capture is far bigger than the map needs -
 * a 4K PNG of a flat-shaded game is several megabytes of a picture that will be shown in a
 * panel a few hundred pixels wide. Canvas does this on its own, so there is no library here
 * either.
 */

// Wide enough to open full size and still read the geometry, small enough that a photo is
// a fraction of what a clip costs.
const MAX_SIDE = 1600;

// WebP first: on the flat colours of this game it is roughly half of what JPEG costs at a
// quality nobody can tell apart. JPEG is the fallback for browsers that do not encode WebP,
// which canvas signals by handing back a PNG instead.
const FORMATS = ['image/webp', 'image/jpeg'];
const QUALITY = 0.82;

/** Whether the browser can do the shrinking at all. */
export const canShrink = () => typeof createImageBitmap === 'function';

/**
 * Re-encodes `file` no wider or taller than MAX_SIDE.
 *
 * Resolves to the original when that is already the smaller file: a screenshot someone has
 * already cropped and compressed only loses by going round again.
 */
export async function shrink(file) {
  const bitmap = await createImageBitmap(file).catch(() => {
    throw new Error('That file is not an image this browser can read.');
  });

  try {
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);

    for (const type of FORMATS) {
      const blob = await toBlob(canvas, type);
      // A browser that cannot encode the type asked for returns a PNG instead of failing.
      if (blob?.type !== type) continue;

      return blob.size < file.size ? blob : file;
    }

    return file;
  } finally {
    bitmap.close();
  }
}

const toBlob = (canvas, type) => new Promise((resolve) => canvas.toBlob(resolve, type, QUALITY));
