import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Markers } from './markers.js';
import { Ui } from './ui.js';
import { Editor } from './editor.js';
import { Layers } from './layers.js';
import { KeyboardMove } from './keyboard.js';
import { unlockEditor } from './access.js';

const viewport = document.getElementById('viewport');
const loading = document.getElementById('loading');
const progress = document.getElementById('progress');

const renderer = new THREE.WebGLRenderer({ antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.outputColorSpace = THREE.SRGBColorSpace;
// Without tone mapping every lit surface above 1.0 clips straight to white, which turned
// the level's light woods and stone into flat grey.
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 1.1;
viewport.append(renderer.domElement);

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0e1116);

const camera = new THREE.PerspectiveCamera(60, 1, 0.1, 5000);

const controls = new OrbitControls(camera, renderer.domElement);
controls.enableDamping = true;
controls.maxPolarAngle = Math.PI * 0.495; // don't let the camera go under the level

// Two lights, no shadows: the level's textures already carry baked shading, so this only
// has to keep unlit faces from going flat black.
scene.add(new THREE.HemisphereLight(0xbfd4ff, 0x30302a, 1.1));
const sun = new THREE.DirectionalLight(0xffffff, 1.3);
sun.position.set(1, 2, 1.5);
scene.add(sun);

// ──────────────────────────────────────────────────────────────────────── level ──

const markers = new Markers(scene, camera, controls);
const keyboard = new KeyboardMove(camera, controls);
let level = null;

// After markers exists: resize also hands it the canvas size, which its path lines need.
resize();
addEventListener('resize', resize);

function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  // No third argument: three then sets the canvas CSS size as well as its buffer. Skipping it
  // leaves the element laid out at buffer size, so on a phone at devicePixelRatio 2 the canvas
  // is twice the screen and you are looking at the top-left quarter of the map.
  renderer.setSize(w, h);
  camera.aspect = w / h;
  camera.updateProjectionMatrix();
  // The path lines are drawn a fixed number of pixels wide, which their shader can only
  // work out from the canvas size.
  markers.setResolution(w, h);
}

const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

// BASE_URL, not a relative path: on Pages the site is served from /<repo>/, and a deep
// link like /fih-map/#skip-1 would otherwise resolve the asset against the wrong folder.
const asset = (name) => `${import.meta.env.BASE_URL}${name}`;

start();

/**
 * Wrapped in a function rather than awaited at module level: top-level await is not
 * available in the browsers this build targets.
 */
async function start() {
  // Cache-busted by build time. Browsers hold on to a multi-megabyte .glb hard, so without
  // this a rebuilt map keeps showing the old one until a forced reload - locally and,
  // worse, for every visitor after a deploy.
  //
  // no-cache on the metadata itself, or the whole scheme is decorative: a cached
  // scene-meta.json hands back the previous build's timestamp, the .glb URL comes out
  // identical, and F5 shows the old map. It only means "revalidate", so an unchanged file
  // costs a 304 and no download.
  const meta = await fetch(asset('scene-meta.json'), { cache: 'no-cache' })
    .then((r) => r.json())
    .catch((error) => {
      loading.innerHTML = `<p>Could not load the map: ${error.message ?? error}</p>`;
      throw error;
    });

  loadLevel(meta);
}

/**
 * Brings the level in piece by piece.
 *
 * The camera is framed from the metadata rather than from the geometry, so it is pointing
 * at the right place before any of it has arrived and does not jump as each piece lands.
 * The panel opens as soon as the first piece is on screen; the rest fill in behind it.
 */
async function loadLevel(meta) {
  level = new THREE.Group();
  level.name = 'level';
  scene.add(level);

  const version = meta.builtAt;
  const eager = meta.chunks.filter((chunk) => chunk.eager);
  frameCamera(union(eager.map((chunk) => chunk.bounds)));

  const layers = new Layers(level, document.getElementById('layers'), (name) => fetchChunk(name));
  const loaded = new Set();
  const loading_ = new Map();

  // Shared by the eager pass and by a layer switched on later, so asking for the same piece
  // twice waits on the first fetch instead of downloading it again.
  function fetchChunk(name) {
    if (loaded.has(name)) return Promise.resolve();
    if (loading_.has(name)) return loading_.get(name);

    const url = `${asset(`scene/${name}.glb`)}?v=${encodeURIComponent(version)}`;
    const job = new Promise((resolve, reject) => {
      loader.load(url, resolve, undefined, reject);
    })
      .then((gltf) => {
        level.add(gltf.scene);
        loaded.add(name);
        layers.apply();
      })
      .finally(() => loading_.delete(name));

    loading_.set(name, job);
    return job;
  }

  // All at once rather than one after another: they are independent files and the browser
  // pipelines them, so the last one lands far sooner than it would in a queue.
  let arrived = 0;
  const all = eager.map((chunk) =>
    fetchChunk(chunk.file).then(() => {
      arrived++;
      progress.value = (arrived / eager.length) * 100;
      // The first piece on screen is the end of the loading screen. Waiting for all of them
      // is what the single-file version did, and it is most of the wait.
      loading.classList.add('done');
    })
  );

  const sceneName = await markers.load(asset('data/markers.json')).catch((error) => {
    console.warn(error);
    return null;
  });

  const ui = new Ui(markers);
  ui.renderList();

  if (new URLSearchParams(location.search).get('edit') === '1' && (await unlockEditor())) {
    editor = new Editor(markers, camera, controls, sceneName ?? 'Scene_Game_NW-DemoLive');
    editor.attachUi(ui);
  }

  const results = await Promise.allSettled(all);
  const failed = results.filter((r) => r.status === 'rejected');
  if (failed.length === eager.length) {
    loading.classList.remove('done');
    loading.innerHTML = `<p>Could not load the map: ${failed[0].reason?.message ?? failed[0].reason}</p>`;
    return;
  }
  // Some of it arrived and some did not: the map is usable, but saying nothing would leave
  // a hole in the level looking like the level.
  for (const { reason } of failed) console.error('A piece of the level failed to load:', reason);

  selectFromHash();
}

/** One box around several. */
function union(boxes) {
  const box = new THREE.Box3();
  for (const { min, max } of boxes) {
    box.expandByPoint(new THREE.Vector3().fromArray(min));
    box.expandByPoint(new THREE.Vector3().fromArray(max));
  }
  return box;
}

let editor = null;

// Which way the camera looks in from: one corner, a little above. The length is set from how
// big the level turns out to be.
const CORNER = new THREE.Vector3(1, 0.6, 1);

/** Puts the level in frame, looking slightly down at it. */
function frameCamera(box) {
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  // How far back the camera has to sit for the level to fit, worked out for each direction
  // and then whichever needs more room. The field of view is measured vertically, so the
  // sideways one is divided by the aspect - which is why a phone held upright needs so much
  // more distance than a laptop, and why it used to lose half the level off the edges.
  const half = Math.tan((camera.fov * Math.PI) / 360);
  const across = Math.hypot(size.x, size.z); // the camera comes in from a corner, diagonally
  const distance = 1.25 * Math.max(size.y / (2 * half), across / (2 * half * camera.aspect));

  camera.position.copy(center).add(CORNER.clone().setLength(distance));
  camera.far = distance * 12;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

// ──────────────────────────────────────────────────────────────────── selection ──

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
let pressedAt = null;

renderer.domElement.addEventListener('pointerdown', (event) => {
  pressedAt = { x: event.clientX, y: event.clientY };
});

renderer.domElement.addEventListener('pointerup', (event) => {
  // Orbiting ends in a pointerup too; only a click that barely moved is a selection.
  if (!pressedAt) return;
  const moved = Math.hypot(event.clientX - pressedAt.x, event.clientY - pressedAt.y);
  pressedAt = null;
  // A finger never lands as still as a mouse, so a tap gets more slack than a click before
  // it counts as a drag.
  if (moved > (event.pointerType === 'mouse' ? 4 : 12) || !level) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(pointer, camera);

  // The level first, because how far away it is decides whether a marker at this pixel is
  // one you can actually see - a marker hidden behind a wall is not drawn and must not be
  // selectable through it either.
  const ground = raycaster.intersectObject(level, true)[0];

  const marker = markers.pick(raycaster, ground?.distance);
  if (marker) {
    markers.select(marker);
    location.hash = marker.id;
    return;
  }

  if (editor?.handleClick(ground?.point)) return;
});

addEventListener('hashchange', selectFromHash);

function selectFromHash() {
  const id = location.hash.slice(1);
  if (!id) return;

  const marker = markers.items.find((m) => m.id === id);
  if (marker) markers.select(marker);
}

const clock = new THREE.Clock();

renderer.setAnimationLoop(() => {
  // Time-based, not per-frame: otherwise holding W crosses the level twice as fast on a
  // 120 Hz screen as on a 60 Hz one.
  const delta = clock.getDelta();
  keyboard.update(delta);
  controls.update();
  // Which markers merge into a group, and how big each one is, both depend on where the
  // camera ended up this frame.
  markers.updateView(delta);
  renderer.render(scene, camera);
});
