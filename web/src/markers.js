import * as THREE from 'three';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';

/** The kinds of thing a marker can be, and how each one reads on the map. */
export const TYPES = {
  skip: { label: 'Skip', color: '#ff6b4e' },
  route: { label: 'Route', color: '#4ea1ff' },
  checkpoint: { label: 'Checkpoint', color: '#48d597' },
  coin: { label: 'Coin', color: '#f5c451' },
  note: { label: 'Note', color: '#b98cf5' },
};

const RADIUS = 22; // sprite size in pixels when the marker is close to the camera

// The line drawn along a marker's path, and the dot closing it off at the far end.
// Both in pixels, like the sprites: a route across the whole level has to stay readable
// from the overview as well as from up close.
const PATH_WIDTH = 7;
const PATH_END_RADIUS = 14;

// How markers shrink with distance. They are not perspective-scaled - at 45 markers across
// a level 400 units tall, true perspective makes the far ones invisible and the near ones
// enormous - so instead they fade from full size at FULL_SIZE_AT down to SMALLEST of their
// size, which keeps a distant marker findable without letting it shout.
const FULL_SIZE_AT = 70;
const SMALLEST = 0.45;

// Markers whose sprites land within this many pixels of each other are drawn as one
// numbered circle. It is a screen-space distance on purpose: what makes the map unreadable
// is sprites overlapping on screen, which has little to do with distance in the level.
const CLUSTER_RADIUS = 24;

// What the selection looks like: white, bigger, and a thicker line. White because it is the
// one colour no marker type uses, so the selected one reads as different in kind rather
// than as yet another category.
const SELECTED_COLOR = '#ffffff';
const SELECTED_SCALE = 1.35;

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
    // Checkpoints and coins to begin with: they are the level's own landmarks and read as
    // a map. The skips and routes are the interesting part but there are dozens of them,
    // and all of it at once was a wall of circles - the visitor switches them on.
    this.filter = { types: new Set(['checkpoint', 'coin']), text: '' };
    this.onChange = () => {};
    this.onSelect = () => {};

    this.group = new THREE.Group();
    this.group.name = 'markers';
    scene.add(this.group);

    // Paths are drawn once per rebuild; the dots are pooled and repositioned every frame,
    // because which of them are drawn at all depends on where the camera is.
    this.paths = new THREE.Group();
    this.dots = new THREE.Group();
    this.group.add(this.paths, this.dots);

    this.shown = [];
    this.pool = [];
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

  /**
   * Works out what is on the map: the paths, drawn once, and the list of dots that
   * updateView then groups and places every frame.
   */
  rebuild() {
    // Lines are cheap and the list is small; rebuilding wholesale keeps what is drawn and
    // the data in step without diffing.
    for (const line of [...this.paths.children]) {
      this.paths.remove(line);
      line.material.dispose();
      line.geometry.dispose();
    }

    this.shown = [];

    for (const item of this.items) {
      if (!this.matches(item)) continue;

      if (item.path.length) {
        this.paths.add(this.pathLine(item));
        // The far end of a path is a dot of its own, and clusters with everything else.
        this.shown.push({ marker: item, pos: lastOf(item.path), radius: PATH_END_RADIUS });
      }

      this.shown.push({ marker: item, pos: item.pos, radius: RADIUS });
    }

    this.highlightPaths();
    this.updateView();
  }

  /**
   * Repaints the paths so the selected one stands out from the rest.
   *
   * Separate from rebuild because selecting is not a change to what exists - rebuilding
   * every line on each click would throw away and re-upload geometry for nothing.
   */
  highlightPaths() {
    for (const line of this.paths.children) {
      const selected = line.userData.marker === this.selected;
      const color = TYPES[line.userData.marker.type]?.color ?? '#ffffff';

      line.material.color.set(selected ? SELECTED_COLOR : color);
      line.material.linewidth = selected ? PATH_WIDTH * 1.5 : PATH_WIDTH;
      line.renderOrder = selected ? 9.5 : 9;
    }
  }

  /**
   * Places the dots for the current camera: near ones at full size, far ones smaller, and
   * any that would overlap on screen merged into one numbered circle.
   *
   * Called every frame, so it reuses a pool of sprites instead of building them. Rebuilding
   * 45 sprites and their materials sixty times a second is how a map like this starts
   * dropping frames while apparently doing nothing.
   */
  updateView() {
    const camera = this.camera;
    camera.updateMatrixWorld();

    const point = new THREE.Vector3();
    const placed = [];

    for (const dot of this.shown) {
      point.fromArray(dot.pos);
      const distance = camera.position.distanceTo(point);
      point.project(camera);

      // Behind the camera or outside the frustum: not drawn, and not clustered either.
      if (point.z > 1) continue;

      const screen = [point.x * this.resolution.x * 0.5, point.y * this.resolution.y * 0.5];
      const group = placed.find((g) => Math.hypot(g.screen[0] - screen[0], g.screen[1] - screen[1]) < CLUSTER_RADIUS);

      if (group) {
        group.dots.push(dot);
        group.distance = Math.min(group.distance, distance);
        continue;
      }

      placed.push({ screen, dots: [dot], distance });
    }

    placed.forEach((group, i) => this.place(this.spriteAt(i), group));

    // Hide whatever the pool still holds from a busier frame.
    for (let i = placed.length; i < this.pool.length; i++) this.pool[i].visible = false;
  }

  /** Points one pooled sprite at one group of dots. */
  place(sprite, group) {
    const [first] = group.dots;
    const single = group.dots.length === 1;
    // A cluster holding the selected marker is highlighted too, so that selecting from the
    // list still tells you where the thing is even when it has been merged into a group.
    const holdsSelection = this.selected && group.dots.some((dot) => dot.marker === this.selected);

    sprite.visible = true;
    sprite.position.fromArray(first.pos);
    sprite.material.map = single
      ? this.textureFor(first.marker.type, holdsSelection)
      : this.clusterTexture(group.dots, holdsSelection);
    sprite.material.needsUpdate = true;

    // A cluster is drawn at the size of a full marker whatever it stands on, so that a
    // knot of far-away markers does not shrink into an unreadable speck.
    const radius = single ? first.radius : RADIUS;
    const emphasis = holdsSelection ? SELECTED_SCALE : 1;
    sprite.scale.setScalar((radius * shrink(group.distance) * emphasis) / 500);

    // Above the others, so the selection is never the one hidden underneath.
    sprite.renderOrder = holdsSelection ? 11 : 10;

    sprite.userData.marker = single ? first.marker : null;
    sprite.userData.cluster = single ? null : group.dots.map((dot) => dot.marker);
  }

  spriteAt(index) {
    if (this.pool[index]) return this.pool[index];

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        sizeAttenuation: false,
        depthTest: false, // markers stay visible through the level
        transparent: true,
      })
    );
    sprite.renderOrder = 10;

    this.pool.push(sprite);
    this.dots.add(sprite);
    return sprite;
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
  textureFor(type, selected = false) {
    const key = `${type}:${selected}`;
    if (this.textures.has(key)) return this.textures.get(key);

    const size = 64;
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d');

    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 6, 0, Math.PI * 2);
    ctx.fillStyle = selected ? SELECTED_COLOR : TYPES[type]?.color ?? '#ffffff';
    ctx.fill();
    // The selected marker keeps its type's colour as the ring around the white, so that
    // selecting one does not hide what kind of thing it is.
    ctx.lineWidth = selected ? 8 : 5;
    ctx.strokeStyle = selected ? TYPES[type]?.color ?? '#ffffff' : 'rgba(10,12,16,0.85)';
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(key, texture);
    return texture;
  }

  /**
   * The circle standing for a group of markers, with how many it holds written in it.
   *
   * Coloured by the type most of them are, so a knot of coins still reads as coins. Cached
   * by that colour and the count, which is what keeps this off the per-frame budget: the
   * same handful of combinations comes back as the camera moves.
   */
  clusterTexture(dots, selected = false) {
    const tally = new Map();
    for (const dot of dots) tally.set(dot.marker.type, (tally.get(dot.marker.type) ?? 0) + 1);
    const [type] = [...tally].sort((a, b) => b[1] - a[1])[0];

    const count = dots.length;
    const key = `cluster:${type}:${count}:${selected}`;
    if (this.textures.has(key)) return this.textures.get(key);

    const size = 96;
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d');
    const color = TYPES[type]?.color ?? '#ffffff';

    ctx.beginPath();
    ctx.arc(size / 2, size / 2, size / 2 - 8, 0, Math.PI * 2);
    ctx.fillStyle = selected ? SELECTED_COLOR : color;
    ctx.fill();
    ctx.lineWidth = selected ? 10 : 7;
    ctx.strokeStyle = selected ? color : 'rgba(10,12,16,0.85)';
    ctx.stroke();

    ctx.fillStyle = '#0e1116';
    ctx.font = `bold ${count > 99 ? 34 : 44}px system-ui, sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(String(count), size / 2, size / 2 + 2);

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(key, texture);
    return texture;
  }

  // ────────────────────────────────────────────────────────────────── selection ──

  /**
   * What is under the pointer: a single marker, a group of them, or nothing. A group is
   * not a selection - there is no one thing to show - so the caller zooms into it instead.
   */
  pick(raycaster) {
    const hit = raycaster.intersectObjects([...this.dots.children, ...this.paths.children], false)[0];
    if (!hit) return null;

    const { marker, cluster } = hit.object.userData;
    return cluster ? { cluster } : { marker };
  }

  /** Moves the camera in on a group until its markers come apart. */
  zoomToCluster(markers) {
    const box = new THREE.Box3();
    for (const marker of markers) box.expandByPoint(new THREE.Vector3().fromArray(marker.pos));

    const target = box.getCenter(new THREE.Vector3());
    const size = box.getSize(new THREE.Vector3());
    // Half the distance to the group, or enough to frame it if it is spread out - whichever
    // is closer, so one click always makes visible progress.
    const distance = Math.min(
      this.camera.position.distanceTo(target) * 0.5,
      Math.max(size.x, size.y, size.z) * 1.6 + 12
    );

    const from = target
      .clone()
      .add(this.camera.position.clone().sub(target).normalize().multiplyScalar(distance));

    animate(this.camera.position.clone(), from, this.controls.target.clone(), target, (p, t) => {
      this.camera.position.copy(p);
      this.controls.target.copy(t);
      this.controls.update();
    });
  }

  select(marker, { fly = true } = {}) {
    this.selected = marker;
    this.highlightPaths();
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

/** How much of its full size a marker gets at a given distance from the camera. */
function shrink(distance) {
  const t = Math.min(FULL_SIZE_AT / Math.max(distance, 1), 1);
  return SMALLEST + (1 - SMALLEST) * t;
}

function mintId(items, type) {
  const base = type ?? 'marker';
  let n = items.length + 1;
  while (items.some((m) => m.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}
