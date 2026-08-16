import { TYPES } from './markers.js';
import { loadBaseSha, saveMarkers, savingConfigured } from './save.js';

/**
 * Marker authoring, enabled with ?edit=1. Clicking the level places a marker where the
 * ray hits it; the form edits the selection; Export downloads the markers.json to commit.
 *
 * There is no backend on purpose - the site is static, so the round trip is
 * edit -> export -> commit.
 */
export class Editor {
  constructor(markers, camera, controls, sceneName) {
    this.markers = markers;
    this.camera = camera;
    this.controls = controls;
    this.sceneName = sceneName;

    this.panel = document.getElementById('editor');
    this.panel.hidden = false;
    document.body.classList.add('editing');

    // What the next click on the level does: nothing, start a new marker, or extend the
    // selected marker's path.
    this.mode = null;
    this.build();
  }

  build() {
    this.panel.innerHTML = `
      <h2>Editor</h2>
      <button id="place" class="primary">Place marker</button>
      <p class="hint" id="hint">Click the button, then click the map.</p>
      <form id="form" hidden>
        <label>Name <input name="name" required></label>
        <label>Type
          <select name="type">
            ${Object.entries(TYPES).map(([k, v]) => `<option value="${k}">${v.label}</option>`).join('')}
          </select>
        </label>
        <label>Seconds saved <input name="timeSaved" type="number" step="0.1" min="0"></label>
        <label>Difficulty <input name="difficulty" type="number" min="1" max="5"></label>
        <label>Video <input name="video" type="url" placeholder="https://youtu.be/...?t=42"></label>
        <label>Notes <textarea name="notes" rows="3"></textarea></label>
        <fieldset>
          <legend>Path <span id="pathCount"></span></legend>
          <p class="hint">The route drawn on the map. It starts at the marker; each point
            you add continues the line, and the last one is the end of the skip.</p>
          <div class="row-buttons">
            <button type="button" id="addPoint">Add point</button>
            <button type="button" id="undoPoint">Undo point</button>
            <button type="button" id="clearPath">Clear</button>
          </div>
        </fieldset>
        <div class="row-buttons">
          <button type="button" id="setLookAt">Save this view as the marker's camera</button>
          <button type="button" id="delete" class="danger">Delete</button>
        </div>
      </form>
      <button id="save" class="primary">Save to the repo</button>
      <p class="hint" id="saveHint"></p>
      <div class="row-buttons">
        <button id="export">Export</button>
        <button id="import">Import</button>
      </div>
      <input type="file" id="importFile" accept="application/json,.json" hidden>
      <p class="hint" id="fileHint">Export downloads the marker list as a file; Import loads
        one back in. An import replaces everything on the map but changes nothing in the
        repo until you press Save.</p>
    `;

    this.form = this.panel.querySelector('#form');
    this.hint = this.panel.querySelector('#hint');
    this.pathCount = this.panel.querySelector('#pathCount');

    this.panel.querySelector('#place').addEventListener('click', () => this.setMode('marker'));
    this.panel.querySelector('#addPoint').addEventListener('click', () => this.setMode('path'));
    this.panel.querySelector('#undoPoint').addEventListener('click', () => this.undoPoint());
    this.panel.querySelector('#clearPath').addEventListener('click', () => this.clearPath());
    this.panel.querySelector('#export').addEventListener('click', () => this.export());
    this.fileHint = this.panel.querySelector('#fileHint');
    this.importFile = this.panel.querySelector('#importFile');
    this.panel.querySelector('#import').addEventListener('click', () => this.importFile.click());
    this.importFile.addEventListener('change', () => this.import(this.importFile.files[0]));
    this.saveButton = this.panel.querySelector('#save');
    this.saveHint = this.panel.querySelector('#saveHint');
    this.saveButton.addEventListener('click', () => this.save());
    this.setUpSaving();
    this.panel.querySelector('#setLookAt').addEventListener('click', () => this.setLookAt());
    this.panel.querySelector('#delete').addEventListener('click', () => this.deleteSelected());

    // Live edit: every field writes straight through to the selected marker.
    this.form.addEventListener('input', () => this.apply());

    this.markers.onSelect = (marker) => {
      this.showForm(marker);
      this.ui?.renderDetail(marker);
    };
  }

  /** Lets the visitor UI keep rendering the detail card while editing. */
  attachUi(ui) {
    this.ui = ui;
  }

  /** Arms the next click on the level, or disarms it when the mode is already on. */
  setMode(mode) {
    if (mode === 'path' && !this.markers.selected) {
      this.hint.textContent = 'Select a marker first.';
      return;
    }

    this.mode = this.mode === mode ? null : mode;
    this.hint.textContent = HINTS[this.mode] ?? HINTS.idle;
    document.body.classList.toggle('placing', this.mode !== null);
  }

  /**
   * Handles a click on the level. Returns true when it consumed the click, so the caller
   * knows not to treat it as a selection.
   */
  handleClick(point) {
    if (!this.mode || !point) return false;

    if (this.mode === 'path') {
      const marker = this.markers.selected;
      // Points stay armed between clicks: a route is several of them in a row, and having
      // to press the button again for each one made drawing one tedious.
      this.markers.update(marker.id, { path: [...marker.path, roundedTriple(point)] });
      this.showPath(marker);
      return true;
    }

    const marker = this.markers.add({
      type: this.form.elements.type.value || 'skip',
      name: 'New marker',
      pos: roundedTriple(point),
    });

    this.setMode(null);
    this.markers.select(marker, { fly: false });
    return true;
  }

  undoPoint() {
    const marker = this.markers.selected;
    if (!marker?.path.length) return;

    this.markers.update(marker.id, { path: marker.path.slice(0, -1) });
    this.showPath(marker);
  }

  clearPath() {
    const marker = this.markers.selected;
    if (!marker) return;

    this.markers.update(marker.id, { path: [] });
    this.showPath(marker);
  }

  showForm(marker) {
    this.form.hidden = !marker;
    if (!marker) return;

    const { elements } = this.form;
    elements.name.value = marker.name;
    elements.type.value = marker.type;
    elements.timeSaved.value = marker.timeSaved ?? '';
    elements.difficulty.value = marker.difficulty ?? '';
    elements.video.value = marker.video ?? '';
    elements.notes.value = marker.notes ?? '';
    this.showPath(marker);
  }

  showPath(marker) {
    const points = marker.path.length;
    this.pathCount.textContent = points ? `— ${points} point${points === 1 ? '' : 's'}` : '— none yet';
  }

  apply() {
    const marker = this.markers.selected;
    if (!marker) return;

    const { elements } = this.form;
    this.markers.update(marker.id, {
      name: elements.name.value || 'Unnamed',
      type: elements.type.value,
      timeSaved: numberOrNull(elements.timeSaved.value),
      difficulty: numberOrNull(elements.difficulty.value),
      video: elements.video.value || null,
      notes: elements.notes.value,
    });
  }

  setLookAt() {
    const marker = this.markers.selected;
    if (!marker) return;

    const { x, y, z } = this.camera.position;
    this.markers.update(marker.id, { lookAt: [round(x), round(y), round(z)] });
    this.hint.textContent = `Opening "${marker.name}" will now fly the camera to this view.`;
  }

  deleteSelected() {
    const marker = this.markers.selected;
    if (!marker) {
      this.hint.textContent = 'Select a marker first.';
      return;
    }

    // Nothing is selected after this, so a still-armed path mode would have no marker to
    // add points to.
    this.setMode(null);
    this.markers.remove(marker.id);

    // remove() clears the selection but fires no onSelect, so the form and the detail
    // card would both stay on screen showing a marker that no longer exists.
    this.showForm(null);
    this.ui?.renderDetail(null);
    if (location.hash.slice(1) === marker.id) history.replaceState(null, '', location.pathname + location.search);

    this.hint.textContent = `Deleted "${marker.name}".`;
  }

  /**
   * Asks the Worker which revision of markers.json we are starting from. Doing it now
   * rather than at save time is what lets a save be rejected when someone else got there
   * first, instead of quietly overwriting them.
   */
  async setUpSaving() {
    if (!savingConfigured()) {
      this.saveButton.disabled = true;
      this.saveHint.textContent = 'Saving is not set up on this deployment. Use Export instead.';
      return;
    }

    try {
      await loadBaseSha();
      this.saveHint.textContent = 'Commits markers.json to main. The site republishes in about a minute.';
    } catch (error) {
      this.saveButton.disabled = true;
      this.saveHint.textContent = `Cannot reach the save service: ${error.message}`;
    }
  }

  async save() {
    this.saveButton.disabled = true;
    this.saveHint.textContent = 'Saving…';

    try {
      const result = await saveMarkers(this.sceneName, this.markers.items);
      this.saveHint.innerHTML =
        `Saved ${result.markers} marker${result.markers === 1 ? '' : 's'}. ` +
        `<a href="${result.commit}" target="_blank" rel="noopener">See the commit</a>. ` +
        'The site republishes in about a minute.';
    } catch (error) {
      this.saveHint.textContent = `Not saved: ${error.message}`;
    } finally {
      this.saveButton.disabled = false;
    }
  }

  /**
   * Loads a markers.json back in, replacing what is on the map.
   *
   * Replacing rather than merging, because the file Export writes is the whole list and
   * merging two of them would need an answer for every id that appears in both. Nothing is
   * committed either way, so an import that turns out to be the wrong file is undone by
   * reloading the page.
   */
  async import(file) {
    if (!file) return;
    // Cleared so that picking the same file twice in a row still fires a change event.
    this.importFile.value = '';

    try {
      const data = JSON.parse(await file.text());
      if (!Array.isArray(data.markers)) throw new Error('there is no "markers" array in it');

      const before = this.markers.items.length;
      const scene = this.markers.replaceAll(data);

      this.showForm(null);
      this.ui?.renderDetail(null);

      const after = this.markers.items.length;
      const mismatch =
        scene && scene !== this.sceneName ? ` It says it belongs to ${scene}, not ${this.sceneName}.` : '';

      this.fileHint.textContent =
        `Imported ${after} marker${after === 1 ? '' : 's'}, replacing ${before}.` +
        `${mismatch} Nothing is saved until you press Save.`;
    } catch (error) {
      this.fileHint.textContent = `Could not import ${file.name}: ${error.message}`;
    }
  }

  export() {
    const blob = new Blob([this.markers.toJSON(this.sceneName)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = Object.assign(document.createElement('a'), { href: url, download: 'markers.json' });
    link.click();
    URL.revokeObjectURL(url);
  }
}

const HINTS = {
  idle: 'Click the button, then click the map.',
  marker: 'Click the map to place it.',
  path: 'Click the map to add points. Press Add point again when you are done.',
};

const numberOrNull = (value) => (value === '' ? null : Number(value));
const round = (n) => Math.round(n * 100) / 100;

// Centimetre precision on a level hundreds of units across is already more than anyone can
// aim for, and it keeps markers.json readable in a diff.
const roundedTriple = ({ x, y, z }) => [round(x), round(y), round(z)];
