/**
 * Commits the map's markers.json on behalf of the web editor.
 *
 * The site is static, so it has no way to write to the repository by itself, and a token
 * shipped in its JavaScript would be a token handed to every visitor. This Worker is where
 * that token lives instead: the browser sends the passphrase and the markers, the Worker
 * checks the passphrase and does the commit.
 *
 * Everything it needs is configured in wrangler.toml and, for the two secrets, with
 * `wrangler secret put` - see worker/README.md.
 */
import { passphraseMatches } from '../../shared/passphrase.js';

export default {
  async fetch(request, env) {
    const sent = request.headers.get('Origin');
    const origin = allowedOrigin(sent, env);

    // A browser would refuse to read a reply with no matching CORS header, but it would
    // already have sent the request - and a save is done by the time the reply is refused.
    // Turning an unknown origin away here means the commit never happens either.
    if (sent && !origin) return json({ error: 'Origin not allowed' }, 403, null);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors(origin) });
    }

    if (request.method !== 'POST') {
      return json({ error: 'POST only' }, 405, origin);
    }

    let body;
    try {
      body = await request.json();
    } catch {
      return json({ error: 'Body is not JSON' }, 400, origin);
    }

    if (!(await passphraseMatches(body.passphrase, env.EDITOR_HASH))) {
      return json({ error: 'Wrong passphrase' }, 401, origin);
    }

    if (body.action !== 'sha' && body.action !== 'save') {
      return json({ error: `Unknown action: ${body.action}` }, 400, origin);
    }

    if (body.action === 'save' && !Array.isArray(body.markers)) {
      return json({ error: 'markers must be an array' }, 400, origin);
    }

    try {
      const result = body.action === 'sha' ? { sha: await currentSha(env) } : await save(body, env);
      return json(result, 200, origin);
    } catch (error) {
      // The message carries GitHub's own words, which is what makes a failed save
      // diagnosable from the editor instead of just "something went wrong".
      return json({ error: error.message }, 502, origin);
    }
  },
};

// ───────────────────────────────────────────────────────────────────────── github ──

/**
 * Commits an editor's markers, merging rather than replacing.
 *
 * Two people editing at once used to mean the second one was turned away with "reload and
 * redo your changes" - fine when that is a typo, an afternoon of work when it is not. So
 * what the editor sends is not treated as the new file; it is treated as a set of changes
 * against the revision it started from, and only those changes are applied to whatever is
 * in the repository now.
 *
 * The revision it started from is fetched from git rather than sent by the browser: the
 * editor already reports that sha, and reading the file at that sha is what makes this a
 * real three-way merge instead of a guess.
 */
async function save({ markers, scene, baseSha }, env) {
  const current = await github(env, `contents/${env.FILE_PATH}?ref=${env.BRANCH}`);

  // Nobody committed in between, so there is nothing to merge and what arrived is the file.
  const merged =
    !baseSha || baseSha === current.sha
      ? { markers, scene, changed: null }
      : await merge(markers, scene, baseSha, current, env);

  const content = `${JSON.stringify({ scene: merged.scene, markers: merged.markers }, null, 2)}\n`;

  const result = await github(env, `contents/${env.FILE_PATH}`, {
    method: 'PUT',
    body: {
      message: 'Update markers from the web editor',
      content: base64(content),
      // The revision just read, not the one the editor started from: the merge is already
      // on top of it, and passing the older one would have GitHub reject a write that is
      // no longer in conflict with anything.
      sha: current.sha,
      branch: env.BRANCH,
      // Otherwise GitHub attributes the commit to whoever owns the token, personal email
      // and all, in a public repository. These commits are made by the editor, not by a
      // person, and the address is GitHub's own no-reply.
      author: { name: env.COMMIT_NAME, email: env.COMMIT_EMAIL },
      committer: { name: env.COMMIT_NAME, email: env.COMMIT_EMAIL },
    },
  });

  return {
    sha: result.content.sha,
    commit: result.commit.html_url,
    markers: merged.markers.length,
    merged: merged.changed,
    // Only when a merge happened, and then it matters: the editor's own list is missing
    // whatever the other person added, and saving again from that list would read those as
    // deletions and take them straight back out. The editor adopts this instead.
    list: merged.changed ? merged.markers : undefined,
  };
}

/**
 * Applies one editor's changes on top of someone else's.
 *
 * Everything is decided per marker, by id. What this editor added, edited or deleted is
 * worked out by comparing what it sent against the revision it loaded, and only that is
 * applied - so a marker it never touched keeps whatever the other editor did to it, even
 * if this editor's copy of it is stale.
 *
 * Where both edited the same marker, the one saving now wins. There is no sensible way to
 * merge two versions of a name or a path, and the alternative - refusing the save - is the
 * behaviour this replaced.
 */
async function merge(markers, scene, baseSha, current, env) {
  const base = parse(await github(env, `git/blobs/${baseSha}`), 'the revision you started from');
  const theirs = parse(current, 'the current file');

  const was = new Map(base.markers.map((m) => [m.id, m]));
  const mine = new Map(markers.map((m) => [m.id, m]));
  const result = new Map(theirs.markers.map((m) => [m.id, m]));

  let added = 0;
  let edited = 0;
  let deleted = 0;

  for (const [id, marker] of mine) {
    if (!was.has(id)) {
      result.set(id, marker);
      added++;
    } else if (JSON.stringify(was.get(id)) !== JSON.stringify(marker)) {
      result.set(id, marker);
      edited++;
    }
  }

  for (const id of was.keys()) {
    if (!mine.has(id) && result.delete(id)) deleted++;
  }

  const untouched = result.size - added - edited;

  return {
    markers: [...result.values()],
    // The scene name belongs to the level, not to an editor, so the file keeps its own.
    scene: theirs.scene ?? scene,
    changed: { added, edited, deleted, untouched: Math.max(untouched, 0) },
  };
}

/** The markers inside a base64 blob from the contents or blobs API. */
function parse(payload, what) {
  try {
    const text = new TextDecoder().decode(
      Uint8Array.from(atob(payload.content.replace(/\n/g, '')), (c) => c.charCodeAt(0))
    );
    const data = JSON.parse(text);
    if (!Array.isArray(data.markers)) throw new Error('no markers array');

    return data;
  } catch (error) {
    throw new Error(`Could not read ${what}: ${error.message}`);
  }
}

async function currentSha(env) {
  const file = await github(env, `contents/${env.FILE_PATH}?ref=${env.BRANCH}`);
  return file.sha;
}

async function github(env, path, { method = 'GET', body } = {}) {
  const response = await fetch(`https://api.github.com/repos/${env.REPO}/${path}`, {
    method,
    headers: {
      // Trimmed: a token pasted into a terminal easily arrives with a trailing newline or
      // space, and GitHub answers a malformed Authorization header with a bare 400 that
      // says nothing about why.
      Authorization: `Bearer ${(env.GITHUB_TOKEN ?? '').trim()}`,
      Accept: 'application/vnd.github+json',
      // GitHub rejects API requests without one.
      'User-Agent': 'fih-map-editor',
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  const payload = await response.json().catch(() => ({}));

  if (!response.ok) {
    const detail = payload.message ?? response.statusText;
    if (response.status === 409) {
      // Reached only when someone commits between this Worker reading the file and writing
      // it back - a second or two. Saving again merges against the newer revision.
      throw new Error('Someone saved at the same moment. Press Save again.');
    }
    throw new Error(`GitHub ${response.status}: ${detail}`);
  }

  return payload;
}

const base64 = (text) => {
  const bytes = new TextEncoder().encode(text);
  return btoa(String.fromCharCode(...bytes));
};

// ─────────────────────────────────────────────────────────────────────────── http ──

/**
 * The Worker answers only the origins it is configured for. This is not what keeps the
 * repository safe - the passphrase is - but it stops another site from quietly using a
 * visitor's browser to reach it.
 *
 * A request with no Origin at all is not a browser, so there is no other site to protect
 * anyone from; it is let through and the passphrase decides, as it does for curl.
 */
function allowedOrigin(sent, env) {
  const allowed = (env.ALLOWED_ORIGINS ?? '').split(',').map((s) => s.trim());

  return allowed.includes(sent) ? sent : null;
}

const cors = (origin) =>
  origin
    ? {
        'Access-Control-Allow-Origin': origin,
        'Access-Control-Allow-Methods': 'POST, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Access-Control-Max-Age': '86400',
        Vary: 'Origin',
      }
    : { Vary: 'Origin' };

const json = (payload, status, origin) =>
  new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json', ...cors(origin) },
  });
