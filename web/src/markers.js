import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

/** The kinds of thing a marker can be, and how each one reads on the map. */
export const TYPES = {
  skip: { label: 'Skip', color: '#ff6b4e' },
  route: { label: 'Route', color: '#4ea1ff' },
  checkpoint: { label: 'Checkpoint', color: '#48d597' },
  note: { label: 'Note', color: '#f5c451' },
};

const RADIUS = 22; // sprite size in pixels, constant regardless of distance

// The line drawn along a marker's path, and the dot closing it off at the far end.
// Both in pixels, like the sprites: a route across the whole level has to stay readable
// from the overview as well as from up close.
const PATH_WIDTH = 7;
const PATH_END_RADIUS = 14;

/**
 * Owns the marker list, its sprites and the selection. The editor mutates the same list
 * through add/update/remove, so both modes always agree on what exists.
 */
export class Markers {
  constructor(scene, camera, controls) {
    this.scene = scene;
    this.camera = camera;
    this.controls = controls;

    this.items = [];
    this.selected = null;
    this.filter = { types: new Set(Object.keys(TYPES)), text: '' };
    this.onChange = () => {};
    this.onSelect = () => {};

    this.group = new THREE.Group();
    this.group.name = 'markers';
    scene.add(this.group);

    this.textures = new Map();

    // Fat lines are drawn in a shader that needs the canvas size to work out how many
    // pixels wide to be. main.js keeps this in step with the viewport.
    this.resolution = new THREE.Vector2(1, 1);
  }

  setResolution(width, height) {
    this.resolution.set(width, height);
  }

  async load(url) {
    // no-cache, because this file changes every time someone presses Save and a stale copy
    // is indistinguishable from the save having failed. It only forces revalidation, and
    // the file is a few kB, so the usual answer is a 304.
    const response = await fetch(url, { cache: 'no-cache' });
    if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);

    return this.replaceAll(await response.json());
  }

  /**
   * Swaps the whole list for the contents of a markers.json, whether fetched or imported
   * from a file. Returns the scene the file says it belongs to, which the caller may want
   * to check against the level actually on screen.
   */
  replaceAll(data) {
    this.items = (data.markers ?? []).map(normalize);
    this.selected = null;
    this.rebuild();
    this.onChange();

    return data.scene ?? null;
  }

  // ─────────────────────────────────────────────────────────────────── mutation ──

  add(marker) {
    const item = normalize({ ...marker, id: marker.id || mintId(this.items, marker.type) });
    this.items.push(item);
    this.rebuild();
    this.onChange();
    return item;
  }

  update(id, patch) {
    const item = this.items.find((m) => m.id === id);
    if (!item) return null;

    Object.assign(item, patch);
    this.rebuild();
    this.onChange();
    return item;
  }

  remove(id) {
    this.items = this.items.filter((m) => m.id !== id);
    if (this.selected?.id === id) this.selected = null;
    this.rebuild();
    this.onChange();
  }

  toJSON(scene) {
    return JSON.stringify({ scene, markers: this.items }, null, 2);
  }

  // ──────────────────────────────────────────────────────────────────── display ──

  rebuild() {
    // Sprites and lines are cheap and the list is small; rebuilding wholesale keeps what
    // is drawn and the data in step without diffing.
    for (const object of [...this.group.children]) {
      this.group.remove(object);
      object.material.dispose();
      object.geometry?.dispose();
    }

    for (const item of this.items) {
      if (!this.matches(item)) continue;

      // The path first, so the marker's own dot ends up drawn over it.
      if (item.path.length) {
        this.group.add(this.pathLine(item), this.dot(item, lastOf(item.path), PATH_END_RADIUS));
      }

      this.group.add(this.dot(item, item.pos, RADIUS));
    }
  }

  /**
   * The line running from a marker to the end of its path.
   *
   * The marker itself is the start - `path` holds only the points after it - so a skip
   * cannot end up with its line starting somewhere its dot is not.
   */
  pathLine(item) {
    const geometry = new LineGeometry().setPositions([item.pos, ...item.path].flat());

    const line = new Line2(
      geometry,
      new LineMaterial({
        color: new THREE.Color(TYPES[item.type]?.color ?? '#ffffff'),
        linewidth: PATH_WIDTH,
        resolution: this.resolution,
        depthTest: false,
        transparent: true,
      })
    );

    line.computeLineDistances();
    line.renderOrder = 9;
    // Clicking the line selects the skip it belongs to, same as clicking either end.
    line.userData.marker = item;

    return line;
  }

  /** One of a marker's round handles: its own position, or the far end of its path. */
  dot(item, pos, radius) {
    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        map: this.textureFor(item.type),
        sizeAttenuation: false,
        depthTest: false, // markers stay visible through the level
        transparent: true,
      })
    );

    sprite.position.fromArray(pos);
    sprite.scale.setScalar(radius / 500);
    sprite.renderOrder = 10;
    sprite.userData.marker = item;

    return sprite;
  }

  matches(item) {
    if (!this.filter.types.has(item.type)) return false;
    if (!this.filter.text) return true;

    const haystack = `${item.name} ${item.notes ?? ''}`.toLowerCase();
    return haystack.includes(this.filter.text.toLowerCase());
  }

  setFilter(patch) {
    Object.assign(this.filter, patch);
    this.rebuild();
  }

  /** One canvas circle per type, cached - a texture per marker would be wasteful. */
  textureFor(type) {
    if (this.textures.has(type)) return this.textures.get(type);

    const size = 64;
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d');
    const color = TYPES[type]?.color ?? '#ffffff';

    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.lineWidth = 5;
    ctx.strokeStyle = 'rgba(10,12,16,0.85)';
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(type, texture);
    return texture;
  }

  // ────────────────────────────────────────────────────────────────── selection ──

  /** The marker under the pointer, or null. */
  pick(raycaster) {
    const hit = raycaster.intersectObjects(this.group.children, false)[0];
    return hit ? hit.object.userData.marker : null;
  }

  select(marker, { fly = true } = {}) {
    this.selected = marker;
    if (marker && fly) this.flyTo(marker);
    this.onSelect(marker);
  }

  /**
   * Moves the camera to look at a marker from its `lookAt` point when it has one, or from
   * a sensible offset when it does not.
   */
  flyTo(marker) {
    const target = new THREE.Vector3().fromArray(marker.pos);
    const from = marker.lookAt
      ? new THREE.Vector3().fromArray(marker.lookAt)
      : target.clone().add(new THREE.Vector3(18, 12, 18));

    animate(this.camera.position.clone(), from, this.controls.target.clone(), target, (p, t) => {
      this.camera.position.copy(p);
      this.controls.target.copy(t);
      this.controls.update();
    });
  }
}

function animate(fromPos, toPos, fromTarget, toTarget, apply, ms = 700) {
  const start = performance.now();

  const step = (now) => {
    const t = Math.min((now - start) / ms, 1);
    const eased = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2; // ease-in-out

    apply(
      fromPos.clone().lerp(toPos, eased),
      fromTarget.clone().lerp(toTarget, eased)
    );

    if (t < 1) requestAnimationFrame(step);
  };

  requestAnimationFrame(step);
}

function normalize(marker) {
  return {
    id: marker.id,
    type: TYPES[marker.type] ? marker.type : 'note',
    name: marker.name ?? 'Unnamed',
    pos: marker.pos ?? [0, 0, 0],
    // The points the route passes through after `pos`, which is its start. Empty for a
    // marker that is just a spot on the map rather than a run from one place to another.
    path: (marker.path ?? []).filter((point) => Array.isArray(point) && point.length === 3),
    lookAt: marker.lookAt ?? null,
    difficulty: marker.difficulty ?? null,
    timeSaved: marker.timeSaved ?? null,
    video: marker.video ?? null,
    notes: marker.notes ?? '',
    sourcePath: marker.sourcePath ?? null,
  };
}

const lastOf = (list) => list[list.length - 1];

function mintId(items, type) {
  const base = type ?? 'marker';
  let n = items.length + 1;
  while (items.some((m) => m.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}
