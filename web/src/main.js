import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Markers } from './markers.js';
import { Ui } from './ui.js';
import { Editor } from './editor.js';
import { Layers } from './layers.js';
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
let level = null;

// After markers exists: resize also hands it the canvas size, which its path lines need.
resize();
addEventListener('resize', resize);

function resize() {
  const { clientWidth: w, clientHeight: h } = viewport;
  renderer.setSize(w, h, false);
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
  const version = await fetch(asset('scene-meta.json'), { cache: 'no-cache' })
    .then((r) => r.json())
    .then((meta) => meta.builtAt)
    .catch(() => Date.now());

  loadLevel(version);
}

function loadLevel(version) {
  loader.load(
    `${asset('scene.glb')}?v=${encodeURIComponent(version)}`,
  async (gltf) => {
    level = gltf.scene;
    scene.add(level);

    // Layers first: the trash mountains start hidden, and framing the camera around them
    // would leave the playable level a speck in the middle of the screen.
    new Layers(level, document.getElementById('layers'));

    frameCamera(level);
    loading.classList.add('done');

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

    selectFromHash();
  },
  (event) => {
    if (event.lengthComputable) progress.value = (event.loaded / event.total) * 100;
  },
    (error) => {
      loading.innerHTML = `<p>Could not load the map: ${error.message ?? error}</p>`;
      console.error(error);
    }
  );
}

let editor = null;

/** Puts the visible level in frame, looking slightly down at it. */
function frameCamera(root) {
  const box = visibleBounds(root);
  const size = box.getSize(new THREE.Vector3());
  const center = box.getCenter(new THREE.Vector3());
  const distance = Math.max(size.x, size.y, size.z) * 0.9;

  camera.position.set(center.x + distance, center.y + distance * 0.6, center.z + distance);
  camera.far = distance * 12;
  camera.updateProjectionMatrix();

  controls.target.copy(center);
  controls.update();
}

/**
 * Bounds of what is actually on screen. Box3.setFromObject walks hidden children too, so
 * with the trash mountains switched off it would still frame the camera around them.
 */
function visibleBounds(root) {
  const box = new THREE.Box3();

  root.traverseVisible((object) => {
    if (object.isMesh) box.expandByObject(object);
  });

  return box.isEmpty() ? new THREE.Box3().setFromObject(root) : box;
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
  if (moved > 4 || !level) return;

  const rect = renderer.domElement.getBoundingClientRect();
  pointer.set(
    ((event.clientX - rect.left) / rect.width) * 2 - 1,
    -((event.clientY - rect.top) / rect.height) * 2 + 1
  );
  raycaster.setFromCamera(pointer, camera);

  // A marker always wins over the geometry behind it.
  const hit = markers.pick(raycaster);
  if (hit?.cluster) {
    markers.zoomToCluster(hit.cluster);
    return;
  }
  if (hit?.marker) {
    markers.select(hit.marker);
    location.hash = hit.marker.id;
    return;
  }

  const ground = raycaster.intersectObject(level, true)[0];
  if (editor?.handleClick(ground?.point)) return;
});

addEventListener('hashchange', selectFromHash);

function selectFromHash() {
  const id = location.hash.slice(1);
  if (!id) return;

  const marker = markers.items.find((m) => m.id === id);
  if (marker) markers.select(marker);
}

renderer.setAnimationLoop(() => {
  controls.update();
  // Which markers merge into a group, and how big each one is, both depend on where the
  // camera ended up this frame.
  markers.updateView();
  renderer.render(scene, camera);
});
