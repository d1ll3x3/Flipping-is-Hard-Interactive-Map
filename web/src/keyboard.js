import * as THREE from 'three';

/**
 * WASD on top of the orbit controls, not instead of them.
 *
 * Orbiting is the right way to look at one spot from every side, and a poor way to get from
 * the tutorial to the playground: dragging around the level's centre swings you the long way
 * round every time. These keys slide the camera and the point it orbits together, so you
 * walk across the map and then keep orbiting around wherever you ended up.
 */
const KEYS = {
  KeyW: 'forward',
  KeyS: 'back',
  KeyA: 'left',
  KeyD: 'right',
  KeyE: 'up',
  KeyQ: 'down',
};

// Speed follows how far out you are zoomed: crossing the whole level from the overview and
// nudging along a ledge from up close both want to feel the same. In level units per second,
// per unit of orbit distance, clamped so neither extreme becomes unusable.
const SPEED = 1.2;
const SLOWEST = 6;
const FASTEST = 260;

const UP = new THREE.Vector3(0, 1, 0);

export class KeyboardMove {
  constructor(camera, controls) {
    this.camera = camera;
    this.controls = controls;
    this.held = new Set();

    this.forward = new THREE.Vector3();
    this.right = new THREE.Vector3();
    this.step = new THREE.Vector3();

    addEventListener('keydown', (event) => {
      if (accepts(event)) this.held.add(KEYS[event.code]);
    });
    addEventListener('keyup', (event) => this.held.delete(KEYS[event.code]));
    // Alt-tabbing away with a key down never delivers the keyup, and the camera would drift
    // off on its own until you came back and pressed it again.
    addEventListener('blur', () => this.held.clear());
  }

  /** Moves the camera for one frame. `delta` is in seconds. */
  update(delta) {
    if (this.held.size === 0) return;

    // Forward is where the camera looks, flattened onto the ground plane: from a map view
    // you are looking down at the level, and W should cross it rather than dive into it.
    this.forward.set(0, 0, -1).applyQuaternion(this.camera.quaternion);
    this.forward.y = 0;
    if (this.forward.lengthSq() < 1e-8) {
      // Straight down, where flat forward means nothing: use whichever way is up on screen.
      this.forward.copy(UP).applyQuaternion(this.camera.quaternion);
      this.forward.y = 0;
    }
    this.forward.normalize();
    this.right.crossVectors(this.forward, UP).normalize();

    this.step.set(0, 0, 0);
    if (this.held.has('forward')) this.step.add(this.forward);
    if (this.held.has('back')) this.step.sub(this.forward);
    if (this.held.has('right')) this.step.add(this.right);
    if (this.held.has('left')) this.step.sub(this.right);
    if (this.held.has('up')) this.step.y += 1;
    if (this.held.has('down')) this.step.y -= 1;
    if (this.step.lengthSq() === 0) return;

    const distance = this.camera.position.distanceTo(this.controls.target);
    const speed = THREE.MathUtils.clamp(distance * SPEED, SLOWEST, FASTEST);
    this.step.normalize().multiplyScalar(speed * delta);

    this.camera.position.add(this.step);
    // The target moves with it, or the camera would swing round to keep facing the spot it
    // started from and W would end up orbiting instead of walking.
    this.controls.target.add(this.step);
  }
}

/** Whether a key press is ours: not a shortcut, and not someone typing in the editor. */
function accepts(event) {
  if (!KEYS[event.code] || event.ctrlKey || event.metaKey || event.altKey) return false;

  const target = event.target;
  return !(target instanceof HTMLElement && (target.isContentEditable || FIELDS.has(target.tagName)));
}

const FIELDS = new Set(['INPUT', 'TEXTAREA', 'SELECT']);
