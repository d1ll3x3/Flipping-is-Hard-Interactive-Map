# Editor Worker

A Cloudflare Worker that commits `markers.json` for the web editor. The site is static, so
it cannot write to the repository itself; this is where the GitHub token lives instead.

## What it does

The editor sends the passphrase and the marker list. The Worker checks the passphrase
against a SHA-256 it holds, then commits the file to `main` through the GitHub API. Pages
republishes the site a minute later, as it does for any other commit.

Two actions, both `POST /`:

| Body | Answers |
|---|---|
| `{"action": "sha", "passphrase": "…"}` | the revision the editor should start from |
| `{"action": "save", "passphrase": "…", "scene": "…", "markers": [...], "baseSha": "…"}` | the new revision and the commit URL |

`baseSha` is what makes concurrent editing safe: GitHub refuses the write if anyone
committed in between, and the editor is told to reload rather than overwriting their work.

## Deploying

```bash
cd worker && npm install && npx wrangler login
```

Create the GitHub token first: a **fine-grained personal access token**, this repository
only, with **Contents: Read and write** — nothing else. Then:

```bash
npx wrangler secret put GITHUB_TOKEN
```

```bash
npx wrangler secret put EDITOR_HASH
```

`EDITOR_HASH` is the SHA-256 of the editor passphrase, the same value that is in
`web/src/access.js`. Print it with:

```bash
node -e "console.log(require('crypto').createHash('sha256').update('YOUR PASSPHRASE').digest('hex'))"
```

```bash
npx wrangler deploy
```

Deploy prints the Worker's URL. Put it in `SAVE_URL` in `web/src/save.js`, then commit and
push so the published site picks it up.

## What this protects, and what it does not

The token never reaches a browser, and the Worker only answers the origins listed in
`ALLOWED_ORIGINS`. What guards the repository is the passphrase, so:

- anyone with the passphrase can commit to `main`, under the token's identity — the commits
  do not say who actually made them;
- if it leaks, change it in three places (`web/src/access.js`, `wrangler secret put
  EDITOR_HASH`, and whoever you told), and rotate the GitHub token if you think it was the
  token that leaked;
- there is no rate limiting, so guessing is only impractical because the passphrase is 96
  random bits. Do not replace it with something memorable.

Git history is the backstop for everything else: a bad edit is one revert away.
