// Folds the NPCs of several scene dumps into one.
//
// A dump is a snapshot of what the game had loaded, and NPCs spawn as the player comes
// near: with seven of them spread across the level there is no moment when a single dump
// holds them all - the one taken on 2026-08-20 had two. So you take a dump per corner of
// the level (the mod keeps the older ones in Export/dumps instead of overwriting them) and
// this pulls the NPCs out of the extras into the base dump, which is what the rip and the
// glb build read.
//
//   node tools/merge-dumps.mjs
//
// Only NPC subtrees cross over. The rest of an extra dump is the same level in a slightly
// different state - other areas streamed in, sibling indices shifted - and merging that
// wholesale would leave a second copy of half the scenery a metre from the first.
//
// Re-running is safe: an NPC already in the base dump is left where it is.

import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAW = fileURLToPath(new URL('../raw/', import.meta.url));
const BASE = join(RAW, 'scene.json');
const EXTRAS = join(RAW, 'dumps');
// Written by the mod's NPC key: the NPCs' own geometry, which the level dump loses.
const NPC_SCENE = join(RAW, 'npc-scene.json');

// The same prefix build-markers.mjs matches on: the game's own name for an NPC object.
const NPC_PREFIX = 'InteractableNPC_';

// The far LODs of an object. The level dump drops these inside the game, but the NPC
// capture deliberately does not - it takes everything and leaves the choice here, where it
// can be changed without another trip through the game.
const FAR_LOD = /_LOD[1-9]d*$/;

async function main() {
  const base = JSON.parse(await readFile(BASE, 'utf8'));
  const extras = [...(await npcScene()), ...(await extraDumps())];

  if (extras.length === 0) {
    console.log(`Neither raw/npc-scene.json nor any dump in ${EXTRAS} - nothing to merge.`);
    return;
  }

  const known = new Set(base.Nodes.map((node) => node.Path));
  const meshes = index(base.Meshes, meshKey);
  const materials = index(base.Materials, materialKey);
  let added = 0;

  for (const { name, dump } of extras) {
    const npcs = dump.Nodes.filter(
    (node) => isNpc(node) && !known.has(node.Path) && !FAR_LOD.test(dump.Meshes[node.Mesh]?.Name ?? '')
  );
    if (npcs.length === 0) {
      console.log(`${name}: nothing new`);
      continue;
    }

    for (const node of npcs) {
      base.Nodes.push({
        ...node,
        Mesh: adopt(base.Meshes, meshes, dump.Meshes[node.Mesh], meshKey),
        Materials: (node.Materials ?? []).map((i) =>
          adopt(base.Materials, materials, dump.Materials[i], materialKey)
        ),
      });
      known.add(node.Path);
      added++;
    }

    console.log(`${name}: ${npcs.length} nodes from ${new Set(npcs.map(owner)).size} NPCs`);
  }

  base.Stats.Nodes = base.Nodes.length;
  await writeFile(BASE, `${JSON.stringify(base, null, 2)}\n`);

  const owners = [...new Set(base.Nodes.filter(isNpc).map(owner))];
  console.log(`\n${added} nodes merged, ${base.Meshes.length} meshes -> raw/scene.json`);
  console.log(`${owners.length} NPCs in the dump now: ${owners.join(', ')}`);
}

/** Every dump in raw/dumps, oldest first, so the first sighting of an NPC is the one kept. */
async function extraDumps() {
  let files;
  try {
    files = (await readdir(EXTRAS)).filter((file) => file.endsWith('.json')).sort();
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }

  return Promise.all(
    files.map(async (name) => ({ name, dump: JSON.parse(await readFile(join(EXTRAS, name), 'utf8')) }))
  );
}

/** The NPC capture, if there is one. It is a dump of the same shape, only much smaller. */
async function npcScene() {
  try {
    return [{ name: 'npc-scene.json', dump: JSON.parse(await readFile(NPC_SCENE, 'utf8')) }];
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw error;
  }
}

const isNpc = (node) => node.Path.split('/').some((part) => part.startsWith(NPC_PREFIX));

const owner = (node) => node.Path.split('/').find((part) => part.startsWith(NPC_PREFIX));

/**
 * The index of an asset in the base dump's table, appending it when it is not there yet.
 *
 * The tables are referenced by position, so an NPC's mesh arrives carrying an index that
 * means something else in the base: it has to be looked up by what it is, not by where it
 * sat in the dump it came from.
 */
function adopt(table, seen, asset, key) {
  if (!asset) return -1;

  const id = key(asset);
  if (seen.has(id)) return seen.get(id);

  const at = table.length;
  table.push({ ...asset, Id: at });
  seen.set(id, at);

  return at;
}

const index = (table, key) => new Map(table.map((asset, at) => [key(asset), at]));

// Name plus vertex count: the level has thirteen meshes called LOD0, and this is how the
// rip already tells them apart.
const meshKey = (mesh) => `${mesh.Name}#${mesh.VertexCount}`;
const materialKey = (material) => `${material.Name}#${material.Shader}`;

await main();
