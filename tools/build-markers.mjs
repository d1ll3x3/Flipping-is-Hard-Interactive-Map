// Adds a marker for every checkpoint and every collectible coin in the level.
//
// These are the two things on the map whose positions the game already knows, so writing
// them by hand in the editor would be transcription work with a wrong answer waiting at
// the end of it. Everything else - skips, routes, notes - is authored in the editor and
// this script never touches it.
//
//   node tools/build-markers.mjs
//
// Re-running is safe: a generated marker keeps whatever has been written on it since
// (notes, video, difficulty, the saved camera) and only its position is refreshed.

import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const SCENE = fileURLToPath(new URL('../raw/scene.json', import.meta.url));
const MARKERS = fileURLToPath(new URL('../web/public/data/markers.json', import.meta.url));

// The same mirroring build-glb.mjs applies to the geometry. Without it every generated
// marker would sit at the level's mirror image of where it belongs.
const toGltfPosition = ([x, y, z]) => [round(-x), round(y), round(z)];
const round = (n) => Math.round(n * 100) / 100;

// Marker ids end up in the URL hash, so they are lowercase and hyphenated throughout.
const slug = (name) => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/-+$/, '');

/**
 * What to pick out of the dump. `mesh` is what identifies the real object: a checkpoint is
 * its floppy disk and a coin its coin mesh, and matching on those skips the containers,
 * triggers and outline shells that share the same subtree.
 */
const SOURCES = [
  {
    mesh: 'SM_FloppyDisk',
    type: 'checkpoint',
    id: (name) => slug(name.replace(/^Interactable_Checkpoint_/, 'checkpoint-')),
    label: (name) => {
      const [number, suffix] = name.replace(/^Interactable_Checkpoint_/, '').split('_');
      return suffix ? `Checkpoint ${number} (${suffix.toLowerCase()})` : `Checkpoint ${number}`;
    },
  },
  {
    mesh: 'SM_Collectible_Coin_LOD0',
    type: 'note',
    id: (name) => slug(name.replace(/^Interactable_Collectible_Coin_/, 'coin-')),
    label: (name) => `Coin — ${name.replace(/^Interactable_Collectible_Coin_/, '').replace('-', ' ')}`,
  },
];

async function main() {
  const dump = JSON.parse(await readFile(SCENE, 'utf8'));
  const existing = JSON.parse(await readFile(MARKERS, 'utf8'));

  const generated = SOURCES.flatMap((source) => collect(dump, source));
  const byId = new Map(existing.markers.map((marker) => [marker.id, marker]));

  let added = 0;
  let moved = 0;

  for (const marker of generated) {
    const previous = byId.get(marker.id);
    if (!previous) {
      byId.set(marker.id, marker);
      added++;
      continue;
    }

    // Only the position is ours to refresh; the rest is whatever an editor has written.
    if (previous.pos.join() !== marker.pos.join()) moved++;
    previous.pos = marker.pos;
    previous.type ??= marker.type;
    previous.name ||= marker.name;
  }

  await writeFile(MARKERS, `${JSON.stringify({ ...existing, markers: [...byId.values()] }, null, 2)}\n`);

  const authored = byId.size - generated.length;
  console.log(`${generated.length} from the level (${added} added, ${moved} repositioned)`);
  console.log(`${authored} authored in the editor, untouched`);
  console.log(`${byId.size} markers -> web/public/data/markers.json`);
}

/**
 * One marker per object, deduplicated by name. Each coin appears twice in the dump - the
 * uncollected one and the collected one, a tenth of a unit apart - and they are one coin.
 */
function collect(dump, { mesh, type, id, label }) {
  const seen = new Map();

  for (const node of dump.Nodes) {
    if (dump.Meshes[node.Mesh]?.Name !== mesh) continue;

    // The object's own name, not the mesh's: 'Interactable_Checkpoint_3' rather than the
    // floppy disk that every checkpoint shares.
    const name = node.Path.split('/')[1];
    if (seen.has(name)) continue;

    seen.set(name, {
      id: id(name),
      type,
      name: label(name),
      pos: toGltfPosition(node.Pos),
      path: [],
      lookAt: null,
      difficulty: null,
      timeSaved: null,
      video: null,
      notes: '',
      sourcePath: node.Path,
    });
  }

  return [...seen.values()];
}

await main();
