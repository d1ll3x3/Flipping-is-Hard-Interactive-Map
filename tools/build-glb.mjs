// Assembles the two halves of the export into the single scene.glb the web map loads.
//
//   raw/scene.json     where every object of the played level sits (from the mod)
//   raw/meshes/*.glb   the geometry, one file per unique mesh (from AssetRipper)
//   raw/textures/*.png the textures (from AssetRipper)
//        |
//        v
//   web/public/scene.glb
//
// Run after rip-assets.mjs:  node tools/build-glb.mjs

import { readFile, writeFile, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Document, NodeIO, TextureInfo } from '@gltf-transform/core';
import { dedup, prune, quantize, textureCompress } from '@gltf-transform/functions';
import { EXTMeshoptCompression, EXTTextureWebP } from '@gltf-transform/extensions';
import { MeshoptEncoder } from 'meshoptimizer';
import sharp from 'sharp';
import { pickAlbedoTexture, pickBaseColor, pickDetailTexture } from './albedo.mjs';

const RAW = fileURLToPath(new URL('../raw/', import.meta.url));
const OUT = fileURLToPath(new URL('../web/public/', import.meta.url));

// Most of the level's textures are 2048², which is far more than a map view ever shows.
const MAX_TEXTURE = Number(process.env.MAX_TEXTURE ?? 1024);

// The player and its attachments are not level geometry.
const SKIP_PATHS_ALWAYS = [/^NetworkPlayer/];

// Collision proxies, which must not reach the map.
//
// renderer.enabled alone is NOT the test, however tempting: the game also uses it for
// dynamic culling, so 1002 of the 1009 disabled renderers were live level geometry -
// SM_FlatStick_01/02 (312 planks of walkway), SM_Castlebox_*, SM_GroundBlock_08. Filtering
// on it deleted the floor.
//
// What actually marks a collider is its name: either it says so, or it is an untouched
// primitive ('Cube', 'Mesh') that the artists never renamed. The primitive names only
// count as colliders when the renderer is off too, since a visible 'Cube' is scenery.
// Anywhere in the name, not just as a _Collider suffix: the level also has
// ColliderHighJumpFriction and plain Colliders, which a suffix pattern let straight through.
const COLLIDER_NAMES = /collider/i;
const UNNAMED_PRIMITIVES = /^(Cube|Mesh|Sphere|Capsule|Cylinder|Plane|Quad)$/;

/**
 * An area counts as streamed out when hardly any of it was switched on at dump time.
 *
 * The level splits cleanly in two: L2_Military came back 8% active and HallOfChampions 2%
 * (the game had streamed them out because the player was far away - they belong on the
 * map), while L3_Playground was 94% and L1_Tutorial 97% (there, an inactive object is
 * inactive on purpose - spare parts and alternate states that should stay hidden).
 */
const STREAMED_OUT_BELOW = 0.5;

// Layers that are never level geometry. TransparentFX carries the sky dome and fog
// spheres, which would swallow the camera in a map view.
const SKIP_LAYERS = new Set(['TransparentFX', 'UI', 'Water']);

// Anything parked far outside the playable level. The respawn pipe sequence has a section
// ~2700 units away, which alone stretched the map's bounding box by a factor of seven and
// left the level a speck on screen.
//
// This is a distance test, not a path one. Excluding the whole NW_RespawnPipeZones_Area
// subtree also deleted the pipes that ARE in the level - the grey tunnel. 2918 of 2935
// objects sit within 600 units of the centre, so the gap between "level" and "parked far
// away" is wide and unambiguous.
const MAX_DISTANCE = Number(process.env.MAX_DISTANCE ?? 900);

async function main() {
  const dump = JSON.parse(await readFile(join(RAW, 'scene.json'), 'utf8'));
  const index = JSON.parse(await readFile(join(RAW, 'rip-index.json'), 'utf8'));

  const document = new Document();
  document.createBuffer();
  const scene = document.createScene(dump.Scene);

  const streamed = streamedOutAreas(dump);
  const centre = levelCentre(dump.Nodes);
  const kept = dump.Nodes.filter((node) => keep(node, dump.Materials, streamed, centre));

  const textures = await loadTextures(document, palettesIn(dump));
  const materials = createMaterials(document, dump, textures);
  const meshes = await loadMeshes(document, index, dump.Materials, materials, await layerTints(dump), variantsOf(kept));

  const placed = placeNodes(document, scene, dump, meshes, streamed, centre);

  await optimize(document, palettesIn(dump));

  // After optimisation, never before: dedup merges samplers and hands the palettes back a
  // linear filter, which blends neighbouring colour cells into colours the level does not
  // contain.
  const pointSampled = enforcePointSampling(document, palettesIn(dump));
  console.log(`palettes  ${pointSampled} materials point-sampled`);

  await mkdir(OUT, { recursive: true });
  // Both extensions must be registered for writing: the textures are WebP and the
  // geometry is meshopt-compressed, and an unregistered extension is silently dropped
  // from extensionsUsed, leaving a file viewers refuse to load.
  const io = new NodeIO()
    .registerExtensions([EXTMeshoptCompression, EXTTextureWebP])
    .registerDependencies({ 'meshopt.encoder': MeshoptEncoder });
  const glb = await io.writeBinary(document);
  await writeFile(join(OUT, 'scene.glb'), glb);

  await writeMeta(dump, placed, glb.length, streamed);

  console.log(`\nscene.glb  ${(glb.length / 1048576).toFixed(1)} MB`);
  console.log(`  nodes    ${placed.count} placed, ${placed.skipped} skipped`);
  console.log(`  meshes   ${document.getRoot().listMeshes().length}`);
  console.log(`  textures ${document.getRoot().listTextures().length}`);
  console.log(`  vertices ${placed.vertices.toLocaleString()}`);
}

// ─────────────────────────────────────────────────────────────────────── textures ──

/** File names of the textures used as UV1 palette atlases, which need special handling. */
function palettesIn(dump) {
  const names = dump.Materials.map(pickAlbedoTexture)
    .filter((albedo) => albedo?.texCoord === 1)
    .map((albedo) => safeName(albedo.texture));

  return new Set(names);
}

async function loadTextures(document, paletteNames) {
  const files = (await readdir(join(RAW, 'textures'))).filter((f) => f.endsWith('.png'));
  const byName = new Map();

  for (const file of files) {
    const source = await readFile(join(RAW, 'textures', file));
    const name = file.replace(/\.png$/, '');

    // Palette atlases keep their full size and are never resampled: every texel is a flat
    // colour cell, and blending two neighbours produces a colour that exists nowhere in
    // the level.
    const isPalette = paletteNames.has(name);

    const image = isPalette
      ? await sharp(source).png({ compressionLevel: 9 }).toBuffer()
      : // Resize here rather than leaving it to textureCompress: shrinking before
        // encoding keeps peak memory sane across ~60 2048² images.
        await sharp(source)
          .resize(MAX_TEXTURE, MAX_TEXTURE, { fit: 'inside', withoutEnlargement: true })
          .png({ compressionLevel: 9 })
          .toBuffer();

    const texture = document.createTexture(name).setImage(image).setMimeType('image/png');
    byName.set(name, texture);
  }

  console.log(`textures  ${byName.size} loaded (max ${MAX_TEXTURE}px, ${paletteNames.size} palettes kept full)`);
  return byName;
}

const safeName = (name) => name.replace(/[^A-Za-z0-9._-]/g, '_');

const escapeRegExp = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A pattern matching every name the given one does not - textureCompress has no "except". */
const invert = (pattern) => new RegExp(`^(?!${pattern.source.replace(/^\^|\$$/g, '')}$).*$`);

// ────────────────────────────────────────────────────────────────────── materials ──

function createMaterials(document, dump, textures) {
  return dump.Materials.map((source) => {
    const material = document.createMaterial(source.Name || `material_${source.Id}`);

    const color = pickBaseColor(source);
    const albedo = pickAlbedoTexture(source);

    if (color) material.setBaseColorFactor(color);

    if (albedo) {
      const texture = textures.get(safeName(albedo.texture));
      if (texture) {
        material.setBaseColorTexture(texture);

        if (albedo.texCoord === 1) {
          const info = material.getBaseColorTextureInfo();
          // The palette atlas is addressed by UV1, and must be point-sampled: any
          // interpolation bleeds neighbouring colour cells into each other.
          info.setTexCoord(1);
          info.setMagFilter(TextureInfo.MagFilter.NEAREST);
          info.setMinFilter(TextureInfo.MinFilter.NEAREST);
        }
      }
    }

    // The game's shaders are stylized PBR; without roughness data of their own, a matte
    // non-metal reads far closer to the game than glTF's shiny metal default.
    material.setMetallicFactor(0).setRoughnessFactor(0.9);

    if (color && color[3] < 1) {
      material.setAlphaMode('BLEND');
    }

    return material;
  });
}

// ───────────────────────────────────────────────────────────────────────── meshes ──

/**
 * The identity of a placement as far as geometry goes: which mesh, painted with which
 * materials. Two nodes sharing it can share one glTF mesh; two nodes differing in it
 * cannot, however much the geometry matches.
 */
const variantKey = (node) => `${node.Mesh}:${(node.Materials ?? []).join(',')}`;

/**
 * The distinct material sets each mesh is actually instanced with, keyed by mesh id.
 *
 * 41 of the level's 338 meshes are painted more than one way, and the difference is the
 * whole point of the object: SM_Phone_v4_Full_LOD0 is a phone with M_Phone_Base_Demo and a
 * microwave with M_Phone_Microwave, SM_GroundBlock_07 is bare rock with M_Oasis_Stone and
 * grass with M_Oasis_GrassyDirt. Picking one set per mesh - what this used to do - turned
 * the microwaves into phones and half the ground into stone.
 */
function variantsOf(nodes) {
  const wanted = new Map();

  for (const node of nodes) {
    const variants = wanted.get(node.Mesh) ?? new Map();
    variants.set(variantKey(node), node.Materials ?? []);
    wanted.set(node.Mesh, variants);
  }

  return wanted;
}

/**
 * Imports the ripped geometry, once per mesh and material set. The returned meshes are
 * shared by every node that instances them, which is what keeps 4,436 placements down to
 * a few hundred meshes on disk.
 */
async function loadMeshes(document, index, dumpMaterials, materials, tints, wanted) {
  const io = new NodeIO();
  const meshes = new Map();

  let loaded = 0;
  for (const entry of index.meshes) {
    const variants = wanted.get(entry.id);
    if (!entry.file || !variants) continue;

    const source = await io.readBinary(await readFile(join(RAW, 'meshes', entry.file)));
    const submeshes = submeshesOf(source);
    if (!submeshes.length) continue;

    for (const [key, assigned] of variants) {
      const mesh = document.createMesh(entry.name);

      // Submesh i is drawn with material i - the same order Unity hands renderer.sharedMaterials.
      submeshes.forEach((sourcePrimitive, i) => {
        const materialId = assigned[i] ?? assigned[0];
        // An outline submesh inside an otherwise ordinary mesh, which the node-level test
        // cannot catch. The combined Military chunks have one, and it arrived as a white
        // crust over the entrance now that every submesh is imported.
        if (isOutline(dumpMaterials[materialId] ?? {})) return;

        const primitive = copyPrimitive(document, sourcePrimitive);
        const material = materials[materialId];
        if (material) primitive.setMaterial(material);

        const tint = tints.get(materialId);
        if (tint) bakeLayerBlend(document, primitive, tint);

        mesh.addPrimitive(primitive);
      });

      meshes.set(key, mesh);
      loaded++;
    }
  }

  console.log(`meshes    ${loaded} imported (${wanted.size} distinct, the rest repainted variants)`);
  return meshes;
}

/**
 * Average colour of each two-layer material's detail texture relative to its base, keyed
 * by material id. Multiplying the base texture by this reproduces the detail layer's tone.
 */
async function layerTints(dump) {
  const tints = new Map();

  for (const material of dump.Materials) {
    const detail = pickDetailTexture(material);
    const base = pickAlbedoTexture(material);
    if (!detail || !base) continue;

    const [detailMean, baseMean] = await Promise.all([
      meanColor(detail),
      meanColor(base.texture),
    ]);
    if (!detailMean || !baseMean) continue;

    // Guard against a near-black base, where the ratio would explode.
    tints.set(
      material.Id,
      detailMean.map((c, i) => clamp(c / Math.max(baseMean[i], 8), 0, 4))
    );
  }

  return tints;
}

async function meanColor(textureName) {
  try {
    const stats = await sharp(join(RAW, 'textures', `${safeName(textureName)}.png`)).stats();
    return stats.channels.slice(0, 3).map((channel) => channel.mean);
  } catch {
    return null;
  }
}

const clamp = (n, lo, hi) => Math.min(Math.max(n, lo), hi);

/**
 * Bakes a two-layer material's blend into COLOR_0, which glTF multiplies over the base
 * colour texture.
 *
 * The game's shader blends by surface orientation - the detail layer covers what faces up,
 * which is why the ground blocks are rock on their sides and grass on top. glTF cannot
 * express two layers, and picking either one alone was wrong in both directions: the base
 * left every block flat grey, the detail turned them entirely green. Tinting by the
 * vertex normal keeps both.
 *
 * The normal is the mesh's own, so a block rotated on its side gets grass on what is now a
 * wall. That is rare here and far less wrong than a uniformly coloured level.
 */
function bakeLayerBlend(document, primitive, tint) {
  const normals = primitive.getAttribute('NORMAL');
  if (!normals) return;

  const count = normals.getCount();
  const colors = new Float32Array(count * 3);
  const normal = [0, 0, 0];

  for (let i = 0; i < count; i++) {
    normals.getElement(i, normal);

    // Fully detail on flat-up faces, fully base on anything vertical or below.
    const up = clamp((normal[1] - 0.35) / 0.35, 0, 1);
    const weight = up * up * (3 - 2 * up); // smoothstep

    for (let c = 0; c < 3; c++) {
      colors[i * 3 + c] = 1 + (tint[c] - 1) * weight;
    }
  }

  primitive.setAttribute(
    'COLOR_0',
    document.createAccessor().setType('VEC3').setArray(colors)
  );
}

/**
 * The primitives of a ripped mesh, in Unity submesh order.
 *
 * AssetRipper does not put the submeshes of one Unity mesh into one glTF mesh: it writes a
 * root node named after the mesh with one child per submesh - 'SubMesh_0', 'SubMesh_1' -
 * each pointing at a glTF mesh of its own. Reading only the first of them, which is what
 * this used to do, silently dropped everything past submesh 0 on 65 of the level's 337
 * meshes: the TV lost its screen and casing, the bridges half their span, and the combined
 * Military and Hall of Champions chunks most of themselves.
 *
 * None of those child nodes carries a transform, so their primitives can be taken as they
 * are; this asserts nothing and simply reads them in tree order.
 */
function submeshesOf(source) {
  const primitives = [];

  for (const scene of source.getRoot().listScenes()) {
    scene.traverse((node) => {
      const mesh = node.getMesh();
      if (mesh) primitives.push(...mesh.listPrimitives());
    });
  }

  return primitives;
}

function copyPrimitive(document, source) {
  const primitive = document.createPrimitive().setMode(source.getMode());

  for (const name of source.listSemantics()) {
    // Tangents and UV sets past the second cost bytes the map view never spends. UV1
    // stays: it is what addresses the palette atlas (see albedo.mjs). Colours stay too -
    // some of the level's props are vertex-coloured with no texture at all.
    if (name === 'TANGENT' || /^TEXCOORD_[2-9]/.test(name)) continue;

    const source_ = source.getAttribute(name);
    const accessor = document
      .createAccessor()
      .setType(source_.getType())
      .setArray(source_.getArray().slice());
    if (source_.getNormalized()) accessor.setNormalized(true);

    primitive.setAttribute(name, accessor);
  }

  const indices = source.getIndices();
  if (indices) {
    primitive.setIndices(
      document.createAccessor().setType(indices.getType()).setArray(indices.getArray().slice())
    );
  }

  return primitive;
}

// ────────────────────────────────────────────────────────────────────────── nodes ──

/** Median position of the level, as a robust centre that outliers cannot drag. */
function levelCentre(nodes) {
  const axis = (i) => {
    const values = nodes.map((n) => n.Pos[i]).sort((a, b) => a - b);
    return values[Math.floor(values.length / 2)];
  };

  return nodes.length ? [axis(0), axis(1), axis(2)] : null;
}

const distanceTo = (pos, centre) => Math.hypot(pos[0] - centre[0], pos[1] - centre[1], pos[2] - centre[2]);

/**
 * Which areas the game had streamed out at dump time, by share of active objects.
 * Their inactive objects are kept; everywhere else, inactive means hidden on purpose.
 */
function streamedOutAreas(dump) {
  const tally = new Map();

  for (const node of dump.Nodes) {
    const area = areaOf(node.Path);
    const counts = tally.get(area) ?? { active: 0, total: 0 };
    if (node.ObjectActive ?? node.Active) counts.active++;
    counts.total++;
    tally.set(area, counts);
  }

  const streamed = new Set();
  for (const [area, { active, total }] of tally) {
    if (active / total < STREAMED_OUT_BELOW) streamed.add(area);
  }

  return streamed;
}

// '(Clone)' and the '#n' that disambiguates same-named siblings are noise here: without
// stripping both, the level's four cannons each became their own area.
const areaOf = (path) => path.split('/')[0].replace(/\(Clone\)(#\d+)?$/, '');

/**
 * Where to put a node. Skinned meshes are placed by their bones in the game, not by their
 * own transform, so their transform points somewhere unrelated - exporting the boosters
 * and buttons on it scattered them across the level in their bind pose. The renderer's
 * world bounds is where the thing is actually drawn.
 */
function placementOf(node) {
  return node.Skinned && node.WorldBoundsCenter ? node.WorldBoundsCenter : node.Pos;
}

/** The one place that decides what belongs on the map, used for geometry and bounds alike. */
function keep(node, materials, streamed, centre) {
  const name = node.Name ?? '';
  if (COLLIDER_NAMES.test(name)) return false;
  if (node.RendererEnabled === false && UNNAMED_PRIMITIVES.test(name)) return false;

  // Inactive objects are kept, wherever they are. The game switches things off for two
  // reasons that look identical here - streaming a far area out, and holding a prop until
  // its networked interactable spawns - and the second is real level content: 22
  // SM_Prop_BoostPad_01, the body of every boost pad in the playground, came back inactive
  // and vanished from the map, leaving their rings and plates floating on their own.
  //
  // What should not be on the map is filtered by name above, which is a test that does not
  // depend on what happened to be switched on the moment the dump was taken.

  if (SKIP_LAYERS.has(node.LayerName)) return false;
  if (SKIP_PATHS_ALWAYS.some((re) => re.test(node.Path))) return false;
  if (centre && distanceTo(node.Pos, centre) > MAX_DISTANCE) return false;

  // Outline shells: Unity draws them inverted and back-face only, so they hug the object
  // invisibly. glTF has no such trick, so they arrive as an opaque white crust that hides
  // the real geometry underneath - which is why the rocks looked untextured.
  if (paintedOnlyWith(node, materials, isOutline)) return false;

  // Collision hulls, trigger volumes and the audio zones around the phone callers: every
  // one of the level's 76 such nodes wears the untextured default grey, and nothing that
  // is meant to be seen does. This is what put grey cubes over the playground slides.
  if (paintedOnlyWith(node, materials, isBareDefault)) return false;

  // Greybox left over from blockout. The 25 SM_Prop_BoostPad_01 slabs are the designer's
  // stand-in for the boost pads and the game keeps them switched off; the pad you actually
  // see is the SM_Booster next to them, which stays.
  if (paintedOnlyWith(node, materials, isPrototype)) return false;

  // Effect volumes - the toy chest's fog and the help beams. Their shaders are additive
  // and depth-faded, which glTF cannot express, so they arrive as solid slabs: five
  // 105-unit purple boxes sitting over the playground.
  return !paintedOnlyWith(node, materials, isEffect);
}

function paintedOnlyWith(node, materials, predicate) {
  const used = (node.Materials ?? []).map((i) => materials[i]).filter(Boolean);
  return used.length > 0 && used.every(predicate);
}

const isOutline = (material) => /SG_Outline/i.test(material.Shader ?? '');

const isPrototype = (material) => /Prototype/i.test(material.Name ?? '');

const isEffect = (material) => /SG_Fog|\/VFX\//i.test(material.Shader ?? '');

const isBareDefault = (material) =>
  material.Name === 'Lit' && Object.keys(material.Textures ?? {}).length === 0;

function placeNodes(document, scene, dump, meshes, streamed, centre) {
  let count = 0;
  let skipped = 0;
  let vertices = 0;

  // One parent per level area, so the web app can show and hide them as layers - the
  // trash mountains that ring the level are one of these and are the main thing people
  // want out of the way.
  const areas = new Map();

  for (const source of dump.Nodes) {
    if (!keep(source, dump.Materials, streamed, centre)) {
      skipped++;
      continue;
    }

    const mesh = meshes.get(variantKey(source));
    if (!mesh) {
      skipped++;
      continue;
    }

    const name = areaOf(source.Path);
    if (!areas.has(name)) {
      const area = document.createNode(name);
      scene.addChild(area);
      areas.set(name, area);
    }

    const node = document
      .createNode(source.Path)
      .setMesh(mesh)
      .setTranslation(toGltfPosition(placementOf(source)))
      .setRotation(toGltfRotation(source.Rot))
      .setScale(source.Scale);

    areas.get(name).addChild(node);
    count++;
    vertices += meshVertices(mesh);
  }

  console.log(`nodes     ${count} placed, ${skipped} skipped, ${areas.size} areas`);
  return { count, skipped, vertices, areas: [...areas.keys()] };
}

// Unity is left-handed, glTF is right-handed, so one axis has to be mirrored. Which one
// is not a free choice: it has to match whatever AssetRipper did to the vertices, or the
// level comes out mirrored against its own geometry.
//
// Verified against the dump rather than assumed - comparing each mesh's Unity bounds with
// its ripped glTF bounds shows Z identical and X negated, so AssetRipper mirrors X.
// Mirroring Z here instead put the whole map back-to-front.
const toGltfPosition = ([x, y, z]) => [-x, y, z];
const toGltfRotation = ([x, y, z, w]) => [x, -y, -z, w];

function meshVertices(mesh) {
  return mesh
    .listPrimitives()
    .reduce((sum, primitive) => sum + (primitive.getAttribute('POSITION')?.getCount() ?? 0), 0);
}

// ─────────────────────────────────────────────────────────────────────── optimize ──

async function optimize(document, paletteNames) {
  await MeshoptEncoder.ready;

  const isPalette = paletteNames.size
    ? new RegExp(`^(${[...paletteNames].map(escapeRegExp).join('|')})$`)
    : /$^/;

  await document.transform(
    // Materials are deliberately excluded from dedup. The palette ones look identical to
    // it - same texture, same colour, same finish - so it merged all ten into one and the
    // survivor lost the UV1 binding and the point sampling, which repainted the slides in
    // random palette colours. Accessors and textures are where the savings are anyway.
    dedup({ propertyTypes: ['Accessor', 'Texture', 'Mesh', 'Skin'] }),
    // keepAttributes:true so UV1 survives on the meshes whose material samples it.
    prune({ keepAttributes: true }),
    // Ordinary textures: resized and lossy, which is where the size savings are.
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      resize: [MAX_TEXTURE, MAX_TEXTURE],
      pattern: invert(isPalette),
    }),
    // Palettes: lossless and at full size, because a lossy codec invents colours between
    // neighbouring cells and each cell is a distinct material colour.
    textureCompress({
      encoder: sharp,
      targetFormat: 'webp',
      quality: 100,
      effort: 6,
      pattern: isPalette,
    }),
    // Quantization is what makes meshopt pay off; on its own meshopt only entropy-codes.
    // TEXCOORD_1 is deliberately not quantized: it addresses a palette atlas, where a
    // rounding error of one texel lands on a different colour cell entirely (it turned
    // the toy chest pink).
    quantize({ pattern: /^(POSITION|NORMAL|TEXCOORD_0|COLOR_0)$/ })
  );

  // Meshopt over Draco: three.js decodes it far faster and the loader is smaller.
  document
    .createExtension(EXTMeshoptCompression)
    .setRequired(true)
    .setEncoderOptions({ method: EXTMeshoptCompression.EncoderMethod.QUANTIZE });
}

// ─────────────────────────────────────────────────────────────────────────── meta ──

/** Companion file for the web app: bounds to frame the camera, and provenance. */
async function writeMeta(dump, placed, bytes, streamed) {
  const bounds = dump.Nodes.filter((n) => keep(n, dump.Materials, streamed, levelCentre(dump.Nodes))).reduce(
    (box, node) => {
      const [x, y, z] = toGltfPosition(placementOf(node));
      box.min = [Math.min(box.min[0], x), Math.min(box.min[1], y), Math.min(box.min[2], z)];
      box.max = [Math.max(box.max[0], x), Math.max(box.max[1], y), Math.max(box.max[2], z)];
      return box;
    },
    { min: [Infinity, Infinity, Infinity], max: [-Infinity, -Infinity, -Infinity] }
  );

  const meta = {
    scene: dump.Scene,
    exportedAt: dump.ExportedAt,
    builtAt: new Date().toISOString(),
    lodLevel: dump.LodLevel,
    nodes: placed.count,
    vertices: placed.vertices,
    bytes,
    bounds,
    areas: placed.areas,
  };

  await writeFile(join(OUT, 'scene-meta.json'), JSON.stringify(meta, null, 2));
}

await main();

/**
 * Forces NEAREST filtering on every material that paints with a palette atlas, and
 * returns how many there were.
 */
function enforcePointSampling(document, paletteNames) {
  let count = 0;

  for (const material of document.getRoot().listMaterials()) {
    const texture = material.getBaseColorTexture();
    if (!texture || !paletteNames.has(texture.getName())) continue;

    const info = material.getBaseColorTextureInfo();
    info.setMagFilter(TextureInfo.MagFilter.NEAREST);
    info.setMinFilter(TextureInfo.MinFilter.NEAREST);
    count++;
  }

  return count;
}
