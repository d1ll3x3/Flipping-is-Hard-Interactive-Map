// Pulls the geometry and textures the mod cannot read out of the running game.
//
// The game's meshes are not CPU-readable, so scene.json (from the mod) says WHERE every
// object sits but carries no vertices. This script asks a running AssetRipper for the
// missing half: one .glb per unique mesh, one .png per texture, matched by name against
// the dump and verified by vertex count.
//
//   1. start AssetRipper:  AssetRipper.GUI.Free.exe --headless --port 7891
//   2. load the game's _Data folder in it (see load-game.mjs)
//   3. node tools/rip-assets.mjs

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pickAlbedoTexture, pickPaletteTexture, pickDetailTexture } from './albedo.mjs';

const HOST = process.env.RIPPER_HOST ?? 'http://localhost:7891';
// fileURLToPath, not URL.pathname: the project path contains a space.
const RAW = fileURLToPath(new URL('../raw/', import.meta.url));

// AssetRipper is a local single-process server; a handful of parallel requests keeps it
// busy without making its search pages fight each other for memory.
const CONCURRENCY = 4;

async function main() {
  const dump = JSON.parse(await readFile(join(RAW, 'scene.json'), 'utf8'));
  console.log(`scene ${dump.Scene}: ${dump.Meshes.length} meshes, ${dump.Materials.length} materials`);

  await mkdir(join(RAW, 'meshes'), { recursive: true });
  await mkdir(join(RAW, 'textures'), { recursive: true });

  const meshes = await ripMeshes(dump);
  const textures = await ripTextures(dump);

  const index = {
    scene: dump.Scene,
    rippedAt: new Date().toISOString(),
    meshes,
    textures,
  };
  await writeFile(join(RAW, 'rip-index.json'), JSON.stringify(index, null, 2));

  report(meshes, textures);
}

// ─────────────────────────────────────────────────────────────────────── meshes ──

async function ripMeshes(dump) {
  return mapLimit(dump.Meshes, CONCURRENCY, async (mesh) => {
    const result = { id: mesh.Id, name: mesh.Name, expectedVertices: mesh.VertexCount };

    try {
      const candidates = await search(mesh.Name, 'Mesh');
      if (candidates.length === 0) {
        result.status = 'not-found';
        return result;
      }

      // Names are not unique across bundles. Download each candidate and keep the one
      // whose vertex count matches what the game reported for this exact mesh.
      for (const candidate of candidates) {
        const glb = await fetchBinary('/Assets/Model.glb', { Path: candidate.path });
        const vertices = countVertices(glb);

        if (vertices === mesh.VertexCount || candidates.length === 1) {
          const file = `${mesh.Id}.glb`;
          await writeFile(join(RAW, 'meshes', file), glb);

          result.file = file;
          result.vertices = vertices;
          result.bytes = glb.length;
          result.collection = candidate.collection;
          result.status = vertices === mesh.VertexCount ? 'ok' : 'vertex-mismatch';
          return result;
        }
      }

      result.status = 'no-match';
      result.candidates = candidates.length;
    } catch (error) {
      result.status = 'error';
      result.error = error.message;
    }

    return result;
  });
}

/** Vertex count straight out of the glTF header, without decoding the buffers. */
function countVertices(glb) {
  const json = readGlbJson(glb);
  let total = 0;

  for (const mesh of json.meshes ?? []) {
    for (const primitive of mesh.primitives ?? []) {
      const accessor = json.accessors?.[primitive.attributes?.POSITION];
      if (accessor) total += accessor.count;
    }
  }

  return total;
}

function readGlbJson(glb) {
  if (glb.toString('ascii', 0, 4) !== 'glTF') throw new Error('not a glb');
  const jsonLength = glb.readUInt32LE(12);
  return JSON.parse(glb.toString('utf8', 20, 20 + jsonLength));
}

// ───────────────────────────────────────────────────────────────────── textures ──

async function ripTextures(dump) {
  // Albedo, the UV1 palette and the second layer of the terrain shaders. Each texture
  // once, however many materials share it. Ripping every declared property would pull in
  // normal maps and masks the map view never uses.
  const names = [
    ...new Set(
      dump.Materials.flatMap((m) => [
        pickAlbedoTexture(m)?.texture,
        pickPaletteTexture(m),
        pickDetailTexture(m),
      ]).filter(Boolean)
    ),
  ];

  return mapLimit(names, CONCURRENCY, async (name) => {
    const result = { name };

    try {
      const candidates = await search(name, 'Texture2D');
      if (candidates.length === 0) {
        result.status = 'not-found';
        return result;
      }

      const png = await fetchBinary('/Assets/Image', { Path: candidates[0].path, Extension: 'png' });
      const file = `${safeName(name)}.png`;
      await writeFile(join(RAW, 'textures', file), png);

      result.file = file;
      result.bytes = png.length;
      result.status = 'ok';
      if (candidates.length > 1) result.candidates = candidates.length;
    } catch (error) {
      result.status = 'error';
      result.error = error.message;
    }

    return result;
  });
}

const safeName = (name) => name.replace(/[^A-Za-z0-9._-]/g, '_');

// ────────────────────────────────────────────────────────────────── asset ripper ──

/**
 * Assets whose name matches exactly and whose class is `className`. AssetRipper's search
 * page has no server-side class filter, so the rows carry it as data-class and we filter
 * here.
 */
async function search(name, className) {
  const html = await fetchText('/Search/View', { q: name });
  const rows = html.match(/<tr[^>]*data-class="[^"]*"[\s\S]*?<\/tr>/g) ?? [];
  const found = [];

  for (const row of rows) {
    if (!row.includes(`data-class="${className}"`)) continue;

    const link = row.match(/href="\/Assets\/View\?Path=([^"]+)"/);
    if (!link) continue;

    // The anchor text is the asset name; skip partial matches the search brought along.
    const label = row.match(/class="btn btn-dark p-0 m-0">([^<]*)<\/a>/);
    if (label && decodeEntities(label[1]) !== name) continue;

    const collection = row.match(/\/Collections\/View\?Path=[^"]*"[^>]*>([^<]*)</);
    found.push({
      path: decodeURIComponent(link[1]),
      collection: collection ? collection[1] : null,
    });
  }

  return found;
}

const decodeEntities = (s) =>
  s.replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&#(\d+);/g, (_, c) => String.fromCharCode(c));

async function fetchText(path, params) {
  const response = await request(path, params);
  return response.text();
}

async function fetchBinary(path, params) {
  const response = await request(path, params);
  return Buffer.from(await response.arrayBuffer());
}

async function request(path, params) {
  const url = new URL(path, HOST);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${path} -> HTTP ${response.status}`);
  return response;
}

// ────────────────────────────────────────────────────────────────────── plumbing ──

/** Runs `worker` over `items` with at most `limit` in flight, preserving order. */
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;

  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const index = next++;
        results[index] = await worker(items[index], index);

        if (++done % 25 === 0 || done === items.length) {
          process.stdout.write(`\r  ${done}/${items.length}`);
        }
      }
    })
  );

  if (items.length) process.stdout.write('\n');
  return results;
}

function report(meshes, textures) {
  const tally = (list) =>
    list.reduce((acc, item) => ((acc[item.status] = (acc[item.status] ?? 0) + 1), acc), {});

  const bytes = (list) => list.reduce((sum, item) => sum + (item.bytes ?? 0), 0);

  console.log('\nmeshes  ', JSON.stringify(tally(meshes)), `${(bytes(meshes) / 1048576).toFixed(1)} MB`);
  console.log('textures', JSON.stringify(tally(textures)), `${(bytes(textures) / 1048576).toFixed(1)} MB`);

  const failed = [...meshes, ...textures].filter((item) => item.status !== 'ok');
  if (failed.length === 0) return;

  console.log(`\n${failed.length} needing attention:`);
  for (const item of failed.slice(0, 20)) {
    console.log(`  ${item.status.padEnd(16)} ${item.name}${item.error ? ` - ${item.error}` : ''}`);
  }
  if (failed.length > 20) console.log(`  ... and ${failed.length - 20} more (see rip-index.json)`);
}

await main();
