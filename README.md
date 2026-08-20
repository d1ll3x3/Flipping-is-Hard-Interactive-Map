# FIH Map

Interactive 3D map of **Flipping is Hard**, for annotating skips, times, videos and examples
on top of the level's real geometry.

**Live site:** https://d1ll3x3.github.io/Flipping-is-Hard-Interactive-Map/

The site is static: it loads a single `scene.glb` (~9 MB) holding the whole level, plus a
`markers.json` with the annotations.

## Why there are two halves

The game's meshes are not CPU-readable (`Mesh.vertices` comes back empty at runtime), so the
geometry cannot be pulled out from a mod. But much of the level is instantiated at runtime —
every `(Clone)` object — so it is not laid out in any scene file on disk either.

Neither source is enough on its own, hence the split:

| Half | What it provides | Where it comes from |
|---|---|---|
| `mod/` | where every object of the played level sits | BepInEx plugin, inside the game |
| AssetRipper | the meshes and the textures | game files, offline |
| `tools/` | joins the two into one `scene.glb` | Node |

## Full pipeline

```bash
cd mod && ./build.bat
```

Builds the plugin and deploys it to the Demo. Inside a level:

- `F10` — scene diagnostic report (`Export/probe.txt`)
- `F11` — dumps `Export/scene.json`: the position of every object
- `F9` — records the NPCs loaded right now into `Export/npcs.json`, adding to what is
  already there

The NPCs need their own key because they are not in any one dump: the game spawns them as
you come near, so `scene.json` only ever holds the two or three that happened to be loaded.
Walk up to each NPC, press `F9`, and the list fills in across the session. Copy `npcs.json`
into `raw/` next to `scene.json`; `build-markers.mjs` reads it if it is there. `F9` also
writes `npc-scene.json` with the NPCs' own geometry, which the full-scene dump loses;
`node tools/merge-dumps.mjs` folds it into `raw/scene.json` before the rip.

### Removing objects

The demo still ships props from older versions of itself. On a local dev server - and only
there - the editor grows a **Remove objects** section: click the button, then click a prop,
and **Export list** writes `hidden.json` over `web/public/data/hidden.json`. Rebuild with
`build-glb.mjs` and those objects are out of the map's geometry, so nobody downloads them.

The tool is not part of the published site. `web/src/prune.js` is imported behind
`import.meta.env.DEV`, which the build folds to false, so none of it is in the bundle - the
site has no way to remove anything, passphrase or not. `hidden.json` is committed as the
record of what was taken out: without it the next rebuild puts every one of them back.

Both keys and the output folder are configured in `FIHMapExport.cfg`, next to the DLL.

Copy that `scene.json` into `raw/` and start AssetRipper:

```bash
tools/AssetRipper/AssetRipper.GUI.Free.exe --headless --port 7891
```

Load the game's `..._Data` folder in it, then:

```bash
node tools/rip-assets.mjs
```

```bash
node tools/build-glb.mjs
```

The first downloads one `.glb` mesh and one `.png` texture per asset, matching them against
the dump by name and verifying them by vertex count. The second assembles them into
`web/public/scene.glb`.

## The web app

```bash
cd web && npm install && npm run dev
```

Open `http://localhost:5173`. With `?edit=1` the editor appears: place markers by clicking on
the level, fill in their data and export a `markers.json` to commit. There is no backend on
purpose.

### Marker format

```jsonc
{
  "id": "skip-1",
  "type": "skip",              // skip | route | checkpoint | note
  "name": "Tunnel skip",
  "pos": [x, y, z],            // where the marker sits, and where its path starts
  "path": [[x, y, z], ...],    // the rest of the route, in order; last point is the end
  "lookAt": [x, y, z],         // camera position to fly to when the marker is opened
  "difficulty": 3,             // 1-5
  "timeSaved": 2.4,            // seconds
  "video": "https://youtu.be/...?t=42",
  "notes": "short markdown"
}
```

`path` is empty for a marker that is just a spot on the map. When it has points, the map
draws a line from `pos` through each of them, with a dot at both ends. The marker itself is
always the start, so a skip cannot end up with its line beginning somewhere its dot is not.
In the editor, **Add point** stays armed between clicks so a route is drawn in one go.

### Who can edit

`?edit=1` asks for a passphrase before opening the editor. **This is not authentication** and
does not pretend to be: the site is static and all of its JavaScript is public, so the only
thing it achieves is that a visitor who stumbles onto the parameter does not find the editor
open. Only the SHA-256 is in the repository (`web/src/access.js`), never the passphrase; that
is shared over another channel with whoever needs to edit.

The same passphrase also authorises **Save to the repo**, the editor's button that commits
`markers.json` straight to `main` — Pages then republishes the site a minute later. That
commit is made by a small Cloudflare Worker (`worker/`), because a static site cannot write
to a repository and a token shipped in its JavaScript would be a token handed to every
visitor. The Worker holds the token, checks the passphrase and does the commit; see
[worker/README.md](worker/README.md) for deploying it and for what it does and does not
protect. Until it is deployed the button is disabled and **Export markers.json** is the way
to publish, by committing the file by hand.

To change the passphrase, replace the hash in `web/src/access.js` with the one printed by the
command documented there, and set the same value as the Worker's `EDITOR_HASH` secret.

## Things that were hard to find

All of them are commented in the code, but they are worth knowing before touching anything:

- **AssetRipper does not put the submeshes of one mesh into a single glTF mesh.** It writes a
  root node with one child per submesh (`SubMesh_0`, `SubMesh_1`…), each pointing at a mesh of
  its own. Reading only the first one drops everything else on 65 of the level's 337 meshes:
  the microwave was left as its front panel, the boost pad as its spring, the radio as its
  aerial, and the combined Military chunks as almost nothing.
- **The same mesh is painted several ways.** 41 meshes are instanced with different materials
  and the difference is the whole object: `SM_Phone_v4_Full_LOD0` is a phone with
  `M_Phone_Base_Demo` and a microwave with `M_Phone_Microwave`; `SM_GroundBlock_07` is rock or
  grass. A mesh variant per material set is needed, not one material picked for all of them.
- **AssetRipper mirrors the X axis**, not Z, when converting from Unity to glTF. Applying the
  usual convention (negating Z) leaves the whole map mirrored against its own geometry.
  Verified by comparing Unity's bounds with the ripped glTF's.
- **The colour is not in `_MainTex`.** In the `SG_Standard_MSAO` shaders that texture is only
  a near-white detail map; the real colour comes from `T_Global_Atlas`, a palette addressed
  through **UV1**.
- **That palette cannot be resized, lossily compressed or interpolated**, and its UV1 cannot
  be quantized: every texel is a distinct colour cell, so any blend between neighbouring cells
  invents colours the game does not contain.

## Deployment

A `git push` to `main` publishes to GitHub Pages through `.github/workflows/pages.yml`. The
workflow passes the repository name as `BASE` so the paths resolve correctly.

## Licence and assets

The code is our own, under the **GNU AGPL-3.0** — see [LICENSE](LICENSE). It is a network
licence on purpose: this is a site, and anyone who runs a modified copy of it for others has
to publish their changes rather than only having to do so if they hand out the files.

The game's assets belong to **Elegant Horse Studios**. The licence covers the code, not them.

`raw/` is in `.gitignore` — hundreds of MB of raw meshes and textures, regenerated with
`rip-assets.mjs`. But **`web/public/scene.glb` does have to be committed**: the Pages workflow
cannot rebuild it, because that needs the game installed and a session running. It is ~9 MB,
no trouble for git.

That means publishing the site distributes the game's geometry and textures, even in a derived
and reduced form. This repository is public, so the studio should be told.
