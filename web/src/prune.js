/**
 * Taking objects off the map: props left over from older builds of the demo, which the
 * dump still carries because the game still has them in the level.
 *
 * This file never reaches a visitor. It is imported only under import.meta.env.DEV, so it
 * is not in the built bundle at all - the published site has no removal tool, with or
 * without the editor passphrase. What the site gets is the result: build-glb.mjs reads the
 * same hidden.json and leaves those objects out of the geometry, so they are not even
 * downloaded.
 *
 * Objects are identified by hierarchy path - the same identity the mod, build-markers and
 * the glb builder use - because that is what survives a rebuild. A position or an index
 * into the geometry does not: the next dump renumbers everything.
 *
 * Two lists in one:
 *
 *   data/hidden.json  what has been committed, and what the build reads
 *   localStorage      what has been clicked away in this browser and not exported yet
 *
 * The second is a scratchpad, so a cleanup survives a reload while it is being done. What
 * makes a removal real is exporting the file over the first one.
 */
const STORE = 'fih-map:hidden';

export class Prune {
  /** `panel` is the editor's, where the controls are added. */
  constructor(level, panel) {
    this.level = level;
    this.committed = new Set();
    this.pending = new Set(read());
    this.armed = false;

    this.build(panel);
  }

  build(panel) {
    const section = document.createElement('fieldset');
    section.innerHTML = `
      <legend>Remove objects <span id="hiddenCount"></span></legend>
      <p class="hint">For props the demo still ships and the map should not show. Click the
        button, then click the object: it goes, and stays gone in this browser. Export
        writes hidden.json - put it in web/public/data and the next glb build leaves those
        objects out of the map for good. Local only: this is not on the published site.</p>
      <div class="row-buttons">
        <button type="button" id="removeObject">Remove object</button>
        <button type="button" id="undoRemove">Undo</button>
        <button type="button" id="exportHidden">Export list</button>
      </div>
      <p class="hint" id="removeHint"></p>
    `;
    panel.append(section);

    this.hint = section.querySelector('#removeHint');
    this.count = section.querySelector('#hiddenCount');
    this.button = section.querySelector('#removeObject');
    this.button.addEventListener('click', () => this.arm(!this.armed));
    section.querySelector('#undoRemove').addEventListener('click', () => this.undo());
    section.querySelector('#exportHidden').addEventListener('click', () => this.export());
    this.showCount();
  }

  /**
   * Arms or disarms the next click. Stays armed once it is: these come in runs, and having
   * to press the button between each one makes clearing out a corner of the level tedious.
   */
  arm(armed) {
    this.armed = armed;
    this.button.classList.toggle('primary', armed);
    this.hint.textContent = armed ? 'Click the objects to remove.' : '';
    document.body.classList.toggle('placing', armed);
  }

  /** Returns true when it consumed the click, like the editor's own handler. */
  handleClick(object) {
    if (!this.armed) return false;

    const path = object ? this.hide(object) : null;
    this.hint.textContent = path
      ? `Removed ${path.split('/').slice(-2).join('/')}`
      : 'That is not a level object - click one of the props.';
    this.showCount();

    return true;
  }

  undo() {
    const last = [...this.pending].pop();
    if (!last) {
      this.hint.textContent = 'Nothing left to undo.';
      return;
    }

    this.pending.delete(last);
    write(this.pending);
    this.level.traverse((object) => {
      if (object.userData?.name === last) object.visible = true;
    });

    this.hint.textContent = `Back: ${last.split('/').slice(-2).join('/')}`;
    this.showCount();
  }

  export() {
    const json = `${JSON.stringify({ hidden: [...this.paths].sort() }, null, 2)}\n`;
    const url = URL.createObjectURL(new Blob([json], { type: 'application/json' }));
    const link = Object.assign(document.createElement('a'), { href: url, download: 'hidden.json' });
    link.click();
    URL.revokeObjectURL(url);

    this.hint.textContent = 'Put it in web/public/data/hidden.json, then rebuild the glb.';
  }

  /** How many are gone, and how many of those only in this browser. */
  showCount() {
    const pending = this.pending.size;
    this.count.textContent = pending ? `(${this.paths.size}, ${pending} not exported)` : `(${this.paths.size})`;
  }

  /** The committed list. A missing file just means nothing has been removed yet. */
  async load(url) {
    try {
      const response = await fetch(url, { cache: 'no-cache' });
      if (!response.ok) return;

      const { hidden } = await response.json();
      for (const path of hidden ?? []) this.committed.add(path);
    } catch (error) {
      console.warn(`Could not read the hidden list: ${error.message}`);
    }
  }

  get paths() {
    return new Set([...this.committed, ...this.pending]);
  }

  /**
   * Pushes the list onto whatever geometry has arrived so far.
   *
   * Called again as each piece lands, like the layer switches: a chunk fetched later has
   * never seen the list.
   */
  apply() {
    const paths = this.paths;
    this.level.traverse((object) => {
      const path = object.userData?.name;
      if (path && paths.has(path)) object.visible = false;
    });
  }

  /**
   * Removes the object a click landed on, and returns its path.
   *
   * The click lands on a mesh, which for an object with several materials is one primitive
   * of it rather than the object itself. userData.name is what says which is which: the
   * loader puts the glTF node's own name there, unsanitized, while object.name has had its
   * slashes taken out.
   */
  hide(object) {
    const node = nodeOf(object);
    if (!node) return null;

    this.pending.add(node.userData.name);
    write(this.pending);
    node.visible = false;

    return node.userData.name;
  }

}

function nodeOf(object) {
  let node = object;
  while (node && !node.userData?.name) node = node.parent;

  // The area nodes and the chunk scenes have no glTF name of their own, so walking off the
  // top means the click landed on something that is not a level object.
  return node?.userData?.name ? node : null;
}

const read = () => {
  try {
    return JSON.parse(localStorage.getItem(STORE) ?? '[]');
  } catch {
    return [];
  }
};

const write = (paths) => {
  try {
    localStorage.setItem(STORE, JSON.stringify([...paths]));
  } catch (error) {
    // Private browsing, a full quota: the removals still work for this session.
    console.warn(`Could not remember the removals: ${error.message}`);
  }
};
