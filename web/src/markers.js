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
  skin: { label: 'Skin', color: '#ff7ab6' },
  note: { label: 'Note', color: '#b98cf5' },
};

/**
 * The difficulties a marker can carry. markers.json is hand-written and imported from files,
 * so a 0, a 9 or a 2.5 still has to land on one of these rather than on nothing - both the
 * stars in the panel and the difficulty filter go through difficultyLevel to decide where.
 */
export const LEVELS = [1, 2, 3, 4, 5];
export const difficultyLevel = (difficulty) =>
  Math.min(Math.max(Math.round(difficulty), 1), LEVELS.length);

const RADIUS = 22; // sprite size in pixels when the marker is close to the camera

// The line drawn along a marker's path, and the dot closing it off at the far end.
// Both in pixels, like the sprites: a route across the whole level has to stay readable
// from the overview as well as from up close.
const PATH_WIDTH = 7;
const PATH_END_RADIUS = 14;

// A route is drawn as nothing but arrows running the whole way along it: a route is a way
// through the level, and a line between two dots does not say which way round to walk it.
// Skips keep the line and the dots - a skip is one move, and where it starts and ends is the
// whole of it.
//
// Where the arrows go is fixed to the level: every ARROW_STEP units along the route, worked
// out once. They are painted on the map, so they have to stay where they are put - spacing
// them across the screen instead made them slide along the route as the camera moved.
//
// That leaves them piling up on each other from far away, so each frame only every nth one is
// drawn, picked to come out around ARROW_SPACING pixels apart. n is a power of two, which is
// what keeps this from being the sliding problem again in a different form: the arrows on
// screen are always half or twice the ones before, so the survivors never budge.
const ARROW_SIZE = 20;
const ARROW_STEP = 1;
const ARROW_SPACING = 46;

// The dead zone around that decision. An arrow only changes its mind once what it wants is
// two thirds past the step above or well under the one below, so the camera has to move a
// long way - nearly three times the zoom - before any given arrow flips.
const GROW_AT = 1.7;
const SHRINK_AT = 0.6;

// And it fades rather than switching, over this many seconds. Even with the dead zone an
// arrow does change its mind now and then, and one appearing out of nothing is a blink -
// a few blinks a second anywhere along a route is what reads as the whole thing flickering.
const FADE_SECONDS = 0.18;

// How markers shrink with distance. They are not perspective-scaled - at 45 markers across
// a level 400 units tall, true perspective makes the far ones invisible and the near ones
// enormous - so instead they fade from full size at FULL_SIZE_AT down to SMALLEST of their
// size, which keeps a distant marker findable without letting it shout.
const FULL_SIZE_AT = 70;
const SMALLEST = 0.45;

// What the selection looks like: white, bigger, and a thicker line. White because it is the
// one colour no marker type uses, so the selected one reads as different in kind rather
// than as yet another category.
const SELECTED_COLOR = '#ffffff';
const SELECTED_SCALE = 1.35;

// How far in front of its real position a marker is drawn.
//
// Markers sit on the thing they mark - on a surface you clicked, or on the checkpoint's own
// floppy disk - so half the circle ends up inside it and the depth test cuts that half away.
// The fix is to draw them a little nearer the camera than they really are, in two parts:
//
//   NEAR is a fixed lift in level units, enough to clear the prop the marker is stuck to.
//   FAR is a share of the distance, which keeps the same clearance from the overview, where
//   a marker is small on screen but covers a lot of level.
//
// Both are small next to a level four hundred units tall, so the marker wins against what it
// is touching and still loses to a wall that is genuinely in the way.
const NUDGE_NEAR = 1.5;
const NUDGE_FAR = 0.02;

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
    this.filter = {
      types: new Set(['checkpoint', 'coin', 'skin']),
      levels: new Set(LEVELS),
      text: '',
    };
    this.onChange = () => {};
    this.onSelect = () => {};

    this.group = new THREE.Group();
    this.group.name = 'markers';
    scene.add(this.group);

    // Paths are drawn once per rebuild; the dots are pooled and repositioned every frame,
    // because which of them are drawn at all depends on where the camera is.
    this.paths = new THREE.Group();
    this.dots = new THREE.Group();
    this.arrows = new THREE.Group();
    this.group.add(this.paths, this.dots, this.arrows);

    this.shown = [];
    this.pool = [];
    // The routes needing arrows, and the sprites drawing them. How many arrows a route takes
    // depends on how long it looks on screen, so the pool grows and shrinks as you move.
    this.routes = [];
    this.arrowPool = [];
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
    this.routes = [];

    for (const item of this.items) {
      if (!this.matches(item)) continue;

      // A route with somewhere to go is nothing but its arrows: no line under them and no
      // dots at either end. The arrows already run the whole way and say which direction,
      // and the line and dots only competed with them for the same pixels.
      if (item.type === 'route' && item.path.length) {
        this.routes.push(route(item));
        continue;
      }

      if (item.path.length) {
        this.paths.add(this.pathLine(item));
        // The far end of a skip gets a dot of its own, sized and highlighted like any other.
        this.shown.push({ marker: item, pos: lastOf(item.path), radius: PATH_END_RADIUS });
      }

      // Everything else is a dot where it stands - including a route nobody has drawn a path
      // for yet, which would otherwise have nothing on the map at all.
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
      // The selected route stays visible through the level, same as its markers: a route
      // you have just opened is the one thing you want to follow across the geometry.
      line.material.depthTest = !selected;
      line.renderOrder = selected ? 9.5 : 9;
    }
  }

  /**
   * Sizes and places every dot for the current camera: near ones at full size, far ones
   * smaller.
   *
   * Called every frame, so it reuses a pool of sprites instead of building them. Rebuilding
   * 45 sprites and their materials sixty times a second is how a map like this starts
   * dropping frames while apparently doing nothing.
   */
  updateView(delta = 0) {
    this.camera.updateMatrixWorld();

    this.shown.forEach((dot, i) => {
      const sprite = this.spriteAt(i);
      const selected = dot.marker === this.selected;

      sprite.visible = true;
      sprite.position.fromArray(dot.pos);
      sprite.material.map = this.textureFor(dot.marker.type, selected);
      sprite.material.needsUpdate = true;

      const distance = nudge(sprite.position, this.camera.position);

      sprite.scale.setScalar((dot.radius * shrink(distance) * (selected ? SELECTED_SCALE : 1)) / 500);

      // The selected marker is the exception to being hidden by the level: picking one
      // from the list and having nothing appear because a wall is in the way reads as the
      // click not having worked.
      sprite.material.depthTest = !selected;
      // Above the others, so the selection is never the one hidden underneath.
      sprite.renderOrder = selected ? 11 : 10;
      sprite.userData.marker = dot.marker;
    });

    // Hide whatever the pool still holds from a busier frame.
    for (let i = this.shown.length; i < this.pool.length; i++) this.pool[i].visible = false;

    this.updateArrows(delta);
    this.offsetPaths();
  }

  /**
   * Lifts every route line off the surface it runs along, the same way its markers are
   * lifted. A line drawn over a floor is exactly as buried in it as a marker is, and comes
   * out looking dashed where the wood eats alternate stretches of it.
   *
   * Point by point, not line by line: moving the whole line by one offset makes its far end
   * drift away from the dot that closes it off, because that dot is nudged along its own
   * line to the camera and the two stop agreeing. Writing straight into the vertex buffer
   * keeps it to a handful of numbers per route.
   */
  offsetPaths() {
    const point = new THREE.Vector3();

    for (const line of this.paths.children) {
      const { points } = line.userData;
      // Six floats per segment: the start point, then the end point.
      const array = line.geometry.attributes.instanceStart.data.array;

      for (let i = 0; i < points.length; i++) {
        nudge(point.fromArray(points[i]), this.camera.position);
        // Every point in the middle is the end of one segment and the start of the next.
        if (i < points.length - 1) point.toArray(array, i * 6);
        if (i > 0) point.toArray(array, (i - 1) * 6 + 3);
      }

      line.geometry.attributes.instanceStart.data.needsUpdate = true;
    }
  }

  /**
   * Lays arrows along every route, evenly spaced across the screen and pointing the way the
   * route runs.
   *
   * The walk is done in pixels: each pair of points is projected, and arrows are dropped
   * every ARROW_SPACING pixels along the line they make, carrying the leftover into the next
   * pair so the spacing does not restart at every corner. Where an arrow ends up in the world
   * is then that same fraction along the segment, which puts it exactly on the line whatever
   * perspective does to the spacing.
   */
  updateArrows(delta) {
    const { x: width, y: height } = this.resolution;
    const rate = delta / FADE_SECONDS;
    let used = 0;

    for (const path of this.routes) {
      const selected = path.marker === this.selected;
      const texture = this.arrowTexture(path.marker.type, selected);

      // The corners, projected once: every arrow on a segment faces the same way on screen,
      // so there is no point working that out again for each of them.
      const screen = path.points.map((point) => this.toScreen(point, width, height));

      // Each anchor decides for itself whether it is one of the survivors, from how far away
      // it is. One decision for the whole route packed the far half solid while the near half
      // ran almost empty - a route can easily be nearer at one end than the other.
      //
      // And it fades in or out rather than switching, because an arrow appearing from nothing
      // is a blink, and a handful of blinks a second anywhere on a route is what reads as the
      // whole thing flickering.
      const tip = path.anchors.length - 1;

      for (let i = 0; i < path.anchors.length; i++) {
        const anchor = path.anchors[i];
        // The far end always shows, whatever the thinning left out. Without it a route stops
        // a whole gap short of where it really ends.
        const wanted = i === tip || i % this.arrowStep(anchor, height) === 0 ? 1 : 0;

        anchor.fade = approach(anchor.fade, wanted, rate);
        if (anchor.fade > 0.01) used = this.placeArrow(used, path, i, screen, texture, selected);
      }
    }

    for (let i = used; i < this.arrowPool.length; i++) this.arrowPool[i].visible = false;
  }

  /**
   * How many anchors to skip around this one for the arrows to come out around
   * ARROW_SPACING pixels apart. Always a power of two, so the set on screen is only ever
   * half or twice what it was and the arrows that survive stay exactly where they were.
   */
  arrowStep(anchor, height) {
    toCamera.copy(this.camera.position).sub(anchor.pos);
    const distance = Math.max(toCamera.length(), 1);
    const pixelsPerUnit = height / (2 * Math.tan((this.camera.fov * Math.PI) / 360) * distance);

    // A stretch of route running away from the camera is squashed into far fewer pixels than
    // its length in the level, and without this it comes out as a solid column of arrows.
    // sin of the angle between the route and the line of sight, floored so that a stretch
    // pointing straight at you asks for a step rather than an infinite one.
    const facing = toCamera.divideScalar(distance).dot(anchor.dir);
    const spread = Math.max(Math.sqrt(Math.max(1 - facing * facing, 0)), 0.15);

    const wanted = ARROW_SPACING / (pixelsPerUnit * spread * ARROW_STEP);

    // Each anchor keeps the step it settled on and only doubles or halves it once the camera
    // has moved well past the point where it would flip. Picking the nearest power of two
    // afresh every frame left every arrow sitting near a boundary blinking on and off as the
    // camera drifted, which is far more distracting than a slightly uneven spacing.
    while (wanted > anchor.step * GROW_AT) anchor.step *= 2;
    while (anchor.step > 1 && wanted < anchor.step * SHRINK_AT) anchor.step /= 2;

    return anchor.step;
  }

  /** Draws one anchor of a route, unless the camera cannot see the segment it sits on. */
  placeArrow(used, path, index, screen, texture, selected) {
    const anchor = path.anchors[index];
    const from = screen[anchor.segment];
    const to = screen[anchor.segment + 1];

    // A segment with an end behind the camera projects to nonsense, and there is no sensible
    // direction to turn its arrows to.
    if (from.behind || to.behind) return used;

    const dx = to.x - from.x;
    const dy = to.y - from.y;
    if (Math.hypot(dx, dy) < 1) return used;

    const sprite = this.arrowAt(used);
    sprite.visible = true;
    sprite.position.copy(anchor.pos);
    nudge(sprite.position, this.camera.position);
    sprite.material.map = texture;
    // Screen y grows downwards and sprite rotation is measured the other way round.
    sprite.material.rotation = Math.atan2(-dy, dx);
    sprite.material.opacity = anchor.fade;
    sprite.material.needsUpdate = true;
    // Constant size: an arrow is a label on the map, not a thing standing in the level.
    sprite.scale.setScalar(ARROW_SIZE / 500);
    sprite.material.depthTest = !selected;
    sprite.renderOrder = selected ? 10.5 : 9.5;
    // Tapping an arrow opens its route, same as tapping its name in the list.
    sprite.userData.marker = path.marker;

    return used + 1;
  }

  /** Where a world point lands on the canvas, in pixels, and whether it is behind us. */
  toScreen(vector, width, height) {
    const ndc = project.copy(vector).project(this.camera);
    const behind = view.copy(vector).applyMatrix4(this.camera.matrixWorldInverse).z > -this.camera.near;

    return { x: (ndc.x * 0.5 + 0.5) * width, y: (1 - (ndc.y * 0.5 + 0.5)) * height, behind };
  }

  arrowAt(index) {
    if (this.arrowPool[index]) return this.arrowPool[index];

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({ sizeAttenuation: false, depthTest: true, depthWrite: false, transparent: true })
    );

    this.arrowPool.push(sprite);
    this.arrows.add(sprite);
    return sprite;
  }

  spriteAt(index) {
    if (this.pool[index]) return this.pool[index];

    const sprite = new THREE.Sprite(
      new THREE.SpriteMaterial({
        sizeAttenuation: false,
        // Hidden by whatever is in front of it, so the map only shows the markers on the
        // side you are looking at instead of all three floors at once.
        depthTest: true,
        // ...but not hiding each other: writing depth would make two markers at the same
        // spot fight over which one is drawn, which flickers as the camera moves.
        depthWrite: false,
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
    const points = [item.pos, ...item.path];
    const geometry = new LineGeometry().setPositions(points.flat());

    const line = new Line2(
      geometry,
      new LineMaterial({
        color: new THREE.Color(TYPES[item.type]?.color ?? '#ffffff'),
        linewidth: PATH_WIDTH,
        resolution: this.resolution,
        // Occluded by the level, like the markers themselves. highlightPaths lifts this
        // for the selected route.
        depthTest: true,
        depthWrite: false,
        transparent: true,
      })
    );

    line.computeLineDistances();
    line.renderOrder = 9;
    // Clicking the line selects the skip it belongs to, same as clicking either end.
    line.userData.marker = item;
    // The points as authored. What is in the buffer is these nudged towards the camera, so
    // offsetPaths has to keep the originals to work from.
    line.userData.points = points;

    return line;
  }

  matches(item) {
    if (!this.filter.types.has(item.type)) return false;

    // Difficulty only narrows what has one. A coin is not an easy skip - it is not a skip at
    // all, and dropping it off the map because it has no stars would make no sense.
    if (item.difficulty != null && !this.filter.levels.has(difficultyLevel(item.difficulty))) {
      return false;
    }

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

  /** A triangle pointing right, which placeArrow then turns to face along the route. */
  arrowTexture(type, selected = false) {
    const key = `arrow:${type}:${selected}`;
    if (this.textures.has(key)) return this.textures.get(key);

    const size = 64;
    const canvas = Object.assign(document.createElement('canvas'), { width: size, height: size });
    const ctx = canvas.getContext('2d');

    // A chevron rather than a plain triangle: the notch at the back keeps it from reading as
    // a blob once it is twenty pixels wide and sitting on a line of its own colour.
    ctx.beginPath();
    ctx.moveTo(size - 8, size / 2);
    ctx.lineTo(12, size - 12);
    ctx.lineTo(24, size / 2);
    ctx.lineTo(12, 12);
    ctx.closePath();

    ctx.fillStyle = selected ? SELECTED_COLOR : TYPES[type]?.color ?? '#ffffff';
    ctx.fill();
    // The same dark rim the dots have, so an arrow stays legible on top of its own line.
    ctx.lineWidth = 5;
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(10,12,16,0.85)';
    ctx.stroke();

    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    this.textures.set(key, texture);
    return texture;
  }

  // ────────────────────────────────────────────────────────────────── selection ──

  /**
   * The marker under the pointer, or null. Its path line counts as part of it.
   *
   * `nearest` is how far away the level is at that pixel. A marker behind it is not drawn,
   * so it must not be clickable either - otherwise clicking a wall selects whatever
   * happens to be hidden on the other side of it.
   */
  pick(raycaster, nearest = Infinity) {
    const targets = [...this.dots.children, ...this.paths.children, ...this.arrows.children];
    const hit = raycaster.intersectObjects(targets, false)[0];
    if (!hit) return null;

    // A marker sitting on a surface hits at almost exactly the same depth as the surface,
    // so the comparison needs some slack or every marker resting on the floor is unclickable.
    const selected = hit.object.userData.marker === this.selected;
    return selected || hit.distance <= nearest + 0.5 ? hit.object.userData.marker : null;
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

/** Moves `value` towards `target` by at most `rate`. */
const approach = (value, target, rate) => value + Math.min(Math.abs(target - value), rate) * Math.sign(target - value);

const toCamera = new THREE.Vector3();
const project = new THREE.Vector3();
const view = new THREE.Vector3();

/**
 * A route worked out for drawing: its corners, the spot every ARROW_STEP units along it where
 * an arrow may go, and its middle.
 *
 * Done once when the list changes rather than every frame, because these positions are the
 * whole point - an arrow belongs to a place on the route, and stays there.
 */
function route(marker) {
  const points = [marker.pos, ...marker.path].map((point) => new THREE.Vector3().fromArray(point));
  const anchors = [];
  let carry = 0;

  for (let segment = 0; segment < points.length - 1; segment++) {
    const from = points[segment];
    const to = points[segment + 1];
    const length = from.distanceTo(to);
    // Shared by every anchor on this segment: which way the route runs here, which is what
    // says how much the camera is looking down the length of it.
    const dir = to.clone().sub(from).divideScalar(length || 1);

    // carry, not zero: the spacing runs along the whole route rather than restarting at
    // every corner, which would bunch the arrows up wherever the route turns.
    let along = carry;
    while (along < length) {
      anchors.push({ pos: from.clone().lerp(to, along / length), segment, dir, step: 1, fade: 0 });
      along += ARROW_STEP;
    }
    carry = along - length;
  }

  // The end itself, so the last anchor is always where the route actually stops.
  const last = points.length - 2;
  anchors.push({
    pos: lastOf(points).clone(),
    segment: last,
    dir: lastOf(points).clone().sub(points[last]).normalize(),
    step: 1,
    fade: 0,
  });

  return { marker, points, anchors };
}

/**
 * Moves `point` towards the camera by NUDGE_NEAR + NUDGE_FAR of the distance, in place, and
 * returns how far away it was. Everything drawn on the map goes through here, so a dot and
 * the end of the line it closes off always land on the same spot.
 */
function nudge(point, cameraPosition) {
  toCamera.copy(cameraPosition).sub(point);
  const distance = toCamera.length();

  point.addScaledVector(toCamera.normalize(), NUDGE_NEAR + NUDGE_FAR * distance);
  return distance;
}

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
