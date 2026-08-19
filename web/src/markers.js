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

// Routes are drawn as arrows running along the line rather than a line between two dots: a
// route is a way through the level, and a line on its own does not say which way round to
// walk it. Skips keep the dots - a skip is one move, and where it starts and ends is the
// whole of it.
//
// The spacing is in pixels, like everything else here. An arrow every so many level units is
// a solid wall of them seen from the overview and a single lonely arrow from up close.
const ARROW_SIZE = 20;
const ARROW_SPACING = 46;

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

      if (item.path.length) {
        this.paths.add(this.pathLine(item));

        if (item.type === 'route') {
          // No dot at the far end: the last arrow already points at it, and a dot there
          // would say something ends here without saying which end you are looking at.
          this.routes.push(item);
        } else {
          // The far end of a skip gets a dot of its own, sized and highlighted like any other.
          this.shown.push({ marker: item, pos: lastOf(item.path), radius: PATH_END_RADIUS });
        }
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
  updateView() {
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

    this.updateArrows();
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
  updateArrows() {
    const { x: width, y: height } = this.resolution;
    let used = 0;

    for (const item of this.routes) {
      const points = [item.pos, ...item.path];
      const world = points.map((point, i) => {
        const vector = (scratch[i] ??= new THREE.Vector3()).fromArray(point);
        nudge(vector, this.camera.position);
        return vector;
      });

      const screen = world.map((vector) => this.toScreen(vector, width, height));
      const selected = item === this.selected;
      const texture = this.arrowTexture(item.type, selected);

      // Half a gap in, so a route does not open with an arrow sitting on its own marker.
      let carry = ARROW_SPACING / 2;

      for (let i = 0; i < screen.length - 1; i++) {
        const from = screen[i];
        const to = screen[i + 1];

        // A segment with an end behind the camera projects to nonsense. Skip it, and start
        // the spacing over on the far side rather than carrying a bogus leftover across.
        if (from.behind || to.behind) {
          carry = ARROW_SPACING / 2;
          continue;
        }

        const dx = to.x - from.x;
        const dy = to.y - from.y;
        const length = Math.hypot(dx, dy);
        if (length < 1) continue;

        // Screen y grows downwards and sprite rotation is measured the other way round.
        const angle = Math.atan2(-dy, dx);

        let along = carry;
        while (along < length) {
          this.placeArrow(used++, item, world[i], world[i + 1], along / length, angle, texture, selected);
          along += ARROW_SPACING;
        }
        carry = along - length;

        // The tip. Without it a route can stop a whole gap short of where it really ends.
        if (i === screen.length - 2) {
          this.placeArrow(used++, item, world[i], world[i + 1], 1, angle, texture, selected);
        }
      }
    }

    for (let i = used; i < this.arrowPool.length; i++) this.arrowPool[i].visible = false;
  }

  /** One arrow, a fraction t of the way from one point to the next, turned to face along it. */
  placeArrow(index, item, from, to, t, angle, texture, selected) {
    const sprite = this.arrowAt(index);

    sprite.visible = true;
    sprite.position.lerpVectors(from, to, t);
    sprite.material.map = texture;
    sprite.material.rotation = angle;
    sprite.material.needsUpdate = true;
    // Constant size, because the line it rides on is a constant number of pixels wide too.
    sprite.scale.setScalar(ARROW_SIZE / 500);
    sprite.material.depthTest = !selected;
    sprite.renderOrder = selected ? 10.5 : 9.5;
    // Tapping an arrow opens its route, same as tapping the line or the marker it starts at.
    sprite.userData.marker = item;
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

const toCamera = new THREE.Vector3();
const project = new THREE.Vector3();
const view = new THREE.Vector3();
// The nudged points of whichever route updateArrows is walking, reused across frames.
const scratch = [];

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
