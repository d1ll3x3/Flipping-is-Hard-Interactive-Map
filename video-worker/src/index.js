/**
 * Serves the map's video clips out of R2, and takes new ones from the editor.
 *
 * Separate from the editor Worker on purpose: that one holds a GitHub token and only ever
 * answers the handful of people with the passphrase, this one answers everybody for reads.
 * There is no reason for them to share a deployment, and every reason not to.
 *
 * R2 has a managed r2.dev address that would do the reading half, but it is rate limited and
 * Cloudflare says not to use it in production. This is a couple of dozen lines and has
 * neither problem, and it is where the upload has to live anyway.
 */
import { passphraseMatches } from '../../shared/passphrase.js';

// A clip is a few seconds of a trick and a photo is one screen. Anything this size is a
// mistake - a full recording picked by accident, most likely - and it is kinder to say so
// than to store it.
const MAX_UPLOAD = 60 * 1024 * 1024;

const TYPES = {
  'video/mp4': 'mp4',
  'video/webm': 'webm',
  'image/webp': 'webp',
  'image/jpeg': 'jpg',
  'image/png': 'png',
};

export default {
  async fetch(request, env) {
    if (request.method === 'PUT') return upload(request, env);
    if (request.method === 'DELETE') return remove(request, env);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(request, env) });
    }

    if (request.method !== 'GET' && request.method !== 'HEAD') {
      return new Response('Only GET, PUT and DELETE', {
        status: 405,
        headers: { Allow: 'GET, HEAD, PUT, DELETE' },
      });
    }

    if (new URL(request.url).searchParams.has('list')) return list(request, env);

    return serve(request, env);
  },
};

// ────────────────────────────────────────────────────────────────────────── read ──

async function serve(request, env) {
  const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
  if (!key) return new Response('Nothing here. Ask for a clip by name.', { status: 404 });

  // range: a browser scrubbing a video asks for the part it needs rather than the whole
  // file, and without this every drag of the scrub bar would download it again from the top.
  // onlyIf: turns a reload into a 304 when the clip has not changed.
  const ranged = request.headers.has('range');
  const object = await env.VIDEOS.get(key, {
    ...(ranged ? { range: request.headers } : {}),
    onlyIf: request.headers,
  });

  if (!object) return new Response(`No clip called "${key}".`, { status: 404 });

  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set('etag', object.httpEtag);
  // Clips are written once under a name and never edited - a re-upload gets a new name - so
  // they can be cached hard.
  headers.set('cache-control', 'public, max-age=31536000, immutable');
  headers.set('access-control-allow-origin', '*');
  headers.set('accept-ranges', 'bytes');

  // No body means the range or the etag matched and there is nothing to send.
  if (!('body' in object)) return new Response(null, { status: 304, headers });

  // Whether this is partial is decided by what was asked for, not by what R2 handed back:
  // R2 fills in `range` either way, so trusting it answers every plain GET with a 206.
  if (ranged && object.range && 'offset' in object.range) {
    const start = object.range.offset;
    const end = start + object.range.length - 1;
    headers.set('content-range', `bytes ${start}-${end}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }

  headers.set('content-length', String(object.size));
  return new Response(object.body, { status: 200, headers });
}

// ────────────────────────────────────────────────────────────────────── listing ──

/**
 * Everything in the bucket, for finding the files nothing points at any more.
 *
 * Behind the passphrase, unlike the reads: a clip is public to anyone who has its address,
 * but the list of every address is not something a visitor needs, and a bucket that
 * enumerates itself is a bucket somebody can copy wholesale.
 */
async function list(request, env) {
  if (!(await passphraseMatches(request.headers.get('X-Passphrase'), env.EDITOR_HASH))) {
    return json({ error: 'Wrong passphrase' }, 401, request, env);
  }

  const objects = [];
  let cursor;

  // R2 answers a page at a time, so this walks to the end of them. A few hundred clips fit
  // in one request comfortably; this is not a bucket that needs paging of its own.
  do {
    const page = await env.VIDEOS.list({ cursor, limit: 1000 });
    for (const object of page.objects) {
      objects.push({ key: object.key, size: object.size, uploaded: object.uploaded });
    }
    cursor = page.truncated ? page.cursor : null;
  } while (cursor);

  return json({ objects }, 200, request, env);
}

// ──────────────────────────────────────────────────────────────────────── write ──

/**
 * Takes a clip from the editor.
 *
 * The passphrase and the name ride in headers rather than in a form body, so the video
 * itself stays the whole request and never has to be held in memory to be parsed out of a
 * multipart envelope - R2 gets the stream as it arrives.
 */
async function upload(request, env) {
  const origin = allowedOrigin(request.headers.get('Origin'), env);
  if (request.headers.get('Origin') && !origin) {
    return json({ error: 'Origin not allowed' }, 403, request, env);
  }

  if (!(await passphraseMatches(request.headers.get('X-Passphrase'), env.EDITOR_HASH))) {
    return json({ error: 'Wrong passphrase' }, 401, request, env);
  }

  const type = (request.headers.get('Content-Type') ?? '').split(';')[0].trim();
  if (!TYPES[type]) {
    return json({ error: `Clips and photos only - got ${type || 'nothing'}` }, 415, request, env);
  }

  const length = Number(request.headers.get('Content-Length') ?? 0);
  if (length > MAX_UPLOAD) {
    return json({ error: `That file is ${mb(length)} MB. The limit is ${mb(MAX_UPLOAD)} MB.` }, 413, request, env);
  }

  const name = safeName(request.headers.get('X-Clip-Name'), TYPES[type]);
  if (!name) return json({ error: 'X-Clip-Name is missing or unusable' }, 400, request, env);

  if (!request.body) return json({ error: 'No video in the request' }, 400, request, env);

  await env.VIDEOS.put(name, request.body, { httpMetadata: { contentType: type } });

  return json({ name, url: new URL(`/${name}`, request.url).href }, 200, request, env);
}

/**
 * Takes a file out of the bucket for good.
 *
 * Guarded like the upload rather than like a read, and deliberately unforgiving about what
 * it will delete: only a plain key, so a path cannot walk anywhere, and R2 keeps no copy of
 * what goes. The map's own history does not help here either - the file is not in git.
 */
async function remove(request, env) {
  const origin = allowedOrigin(request.headers.get('Origin'), env);
  if (request.headers.get('Origin') && !origin) {
    return json({ error: 'Origin not allowed' }, 403, request, env);
  }

  if (!(await passphraseMatches(request.headers.get('X-Passphrase'), env.EDITOR_HASH))) {
    return json({ error: 'Wrong passphrase' }, 401, request, env);
  }

  const key = decodeURIComponent(new URL(request.url).pathname.slice(1));
  if (!key || key.includes('/')) return json({ error: 'Ask for one clip by name' }, 400, request, env);

  // head first, so deleting something that is already gone says so instead of reporting a
  // success that did nothing.
  if (!(await env.VIDEOS.head(key))) return json({ error: `No clip called "${key}".` }, 404, request, env);

  await env.VIDEOS.delete(key);

  return json({ deleted: key }, 200, request, env);
}

/**
 * A key that cannot escape the bucket or collide with an existing clip.
 *
 * Everything but letters, digits and dashes goes, which rules out the slashes and dots that
 * would otherwise let a name reach somewhere it should not. The random tail is what makes a
 * re-upload a new file: clips are served with a year of immutable caching, so replacing one
 * under its old name would leave everybody looking at the old clip until that expired.
 */
function safeName(raw, extension) {
  const base = (raw ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);

  if (!base) return null;

  const tail = Math.random().toString(36).slice(2, 7);
  return `${base}-${tail}.${extension}`;
}

const mb = (bytes) => Math.round(bytes / 1048576);

// ───────────────────────────────────────────────────────────────────────── http ──

/** Reads are open to everyone; writes only from the sites the editor runs on. */
function allowedOrigin(sent, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((o) => o.trim());
  return sent && allowed.includes(sent) ? sent : null;
}

function cors(request, env) {
  const origin = allowedOrigin(request.headers.get('Origin'), env);

  return {
    'Access-Control-Allow-Origin': origin ?? '*',
    'Access-Control-Allow-Methods': 'GET, HEAD, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Passphrase, X-Clip-Name',
    'Access-Control-Max-Age': '86400',
  };
}

const json = (body, status, request, env) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(request, env) },
  });
