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

### Who can edit

`?edit=1` asks for a passphrase before opening the editor. **This is not authentication** and
does not pretend to be: the site is static and all of its JavaScript is public, so the only
thing it achieves is that a visitor who stumbles onto the parameter does not find the editor
open. Only the SHA-256 is in the repository (`web/src/access.js`), never the passphrase; that
is shared over another channel with whoever needs to edit.

What actually controls that reaches the map is the repository's permissions: the editor only
downloads a `markers.json`, and that file gets in through a commit. To change the passphrase,
replace the hash in `web/src/access.js` with the one printed by the command documented there.

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

The code is our own. The game's assets belong to **Elegant Horse Studios**.

`raw/` is in `.gitignore` — hundreds of MB of raw meshes and textures, regenerated with
`rip-assets.mjs`. But **`web/public/scene.glb` does have to be committed**: the Pages workflow
cannot rebuild it, because that needs the game installed and a session running. It is ~9 MB,
no trouble for git.

That means publishing the site distributes the game's geometry and textures, even in a derived
and reduced form. This repository is public, so the studio should be told.
