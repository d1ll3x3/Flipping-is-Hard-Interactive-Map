import * as THREE from 'three';

/** The kinds of thing a marker can be, and how each one reads on the map. */
export const TYPES = {
  skip: { label: 'Skip', color: '#ff6b4e' },
  route: { label: 'Route', color: '#4ea1ff' },
  checkpoint: { label: 'Checkpoint', color: '#48d597' },
  note: { label: 'Note', color: '#f5c451' },
};

const RADIUS = 22; // sprite size in pixels, constant regardless of distance

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
  }

  async load(url) {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`Could not load ${url}: HTTP ${response.status}`);

    const data = await response.json();
    this.items = (data.markers ?? []).map(normalize);
    this.rebuild();
    return data.scene;
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
    // Sprites are cheap and the list is small; rebuilding wholesale keeps the sprite set
    // and the data in step without diffing.
    for (const sprite of [...this.group.children]) {
      this.group.remove(sprite);
      sprite.material.dispose();
    }

    for (const item of this.items) {
      if (!this.matches(item)) continue;

      const sprite = new THREE.Sprite(
        new THREE.SpriteMaterial({
          map: this.textureFor(item.type),
          sizeAttenuation: false,
          depthTest: false, // markers stay visible through the level
          transparent: true,
        })
      );

      sprite.position.fromArray(item.pos);
      sprite.scale.setScalar(RADIUS / 500);
      sprite.renderOrder = 10;
      sprite.userData.marker = item;
      this.group.add(sprite);
    }
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
    lookAt: marker.lookAt ?? null,
    difficulty: marker.difficulty ?? null,
    timeSaved: marker.timeSaved ?? null,
    video: marker.video ?? null,
    notes: marker.notes ?? '',
    sourcePath: marker.sourcePath ?? null,
  };
}

function mintId(items, type) {
  const base = type ?? 'marker';
  let n = items.length + 1;
  while (items.some((m) => m.id === `${base}-${n}`)) n++;
  return `${base}-${n}`;
}
