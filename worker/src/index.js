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

// ─────────────────────────────────────────────────────────────────────────── auth ──

/**
 * Compares SHA-256 digests rather than the passphrase itself, so the Worker never has to
 * hold it in plain text - not in its configuration and not in memory.
 *
 * The comparison takes the same time whichever byte differs. That matters little against a
 * 96-bit random passphrase, but timing-safe comparison is free and the alternative is a
 * habit worth not having.
 */
async function passphraseMatches(passphrase, expected) {
  if (typeof passphrase !== 'string' || !expected) return false;

  const digest = await sha256(passphrase);
  if (digest.length !== expected.length) return false;

  let difference = 0;
  for (let i = 0; i < digest.length; i++) difference |= digest.charCodeAt(i) ^ expected.charCodeAt(i);

  return difference === 0;
}

async function sha256(text) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));

  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// ───────────────────────────────────────────────────────────────────────── github ──

async function save({ markers, scene, baseSha }, env) {
  const content = `${JSON.stringify({ scene, markers }, null, 2)}\n`;

  // baseSha is the revision the editor started from. Passing it makes GitHub refuse the
  // write if anyone committed in between, which is the difference between two editors
  // merging their work and one of them silently losing an afternoon.
  const result = await github(env, `contents/${env.FILE_PATH}`, {
    method: 'PUT',
    body: {
      message: 'Update markers from the web editor',
      content: base64(content),
      sha: baseSha ?? (await currentSha(env)),
      branch: env.BRANCH,
      // Otherwise GitHub attributes the commit to whoever owns the token, personal email
      // and all, in a public repository. These commits are made by the editor, not by a
      // person, and the address is GitHub's own no-reply.
      author: { name: env.COMMIT_NAME, email: env.COMMIT_EMAIL },
      committer: { name: env.COMMIT_NAME, email: env.COMMIT_EMAIL },
    },
  });

  return { sha: result.content.sha, commit: result.commit.html_url, markers: markers.length };
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
      throw new Error('Someone else saved since you loaded the page. Reload and redo your changes.');
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
