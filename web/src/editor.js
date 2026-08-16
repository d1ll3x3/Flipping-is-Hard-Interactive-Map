import { TYPES } from './markers.js';

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

    this.placing = false;
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
        <div class="row-buttons">
          <button type="button" id="setLookAt">Save camera</button>
          <button type="button" id="delete" class="danger">Delete</button>
        </div>
      </form>
      <button id="export">Export markers.json</button>
    `;

    this.form = this.panel.querySelector('#form');
    this.hint = this.panel.querySelector('#hint');

    this.panel.querySelector('#place').addEventListener('click', () => this.togglePlacing());
    this.panel.querySelector('#export').addEventListener('click', () => this.export());
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

  togglePlacing() {
    this.placing = !this.placing;
    this.hint.textContent = this.placing
      ? 'Click the map to place it.'
      : 'Click the button, then click the map.';
    document.body.classList.toggle('placing', this.placing);
  }

  /**
   * Handles a click on the level. Returns true when it consumed the click, so the caller
   * knows not to treat it as a selection.
   */
  handleClick(point) {
    if (!this.placing || !point) return false;

    const marker = this.markers.add({
      type: this.form.elements.type.value || 'skip',
      name: 'New marker',
      pos: [point.x, point.y, point.z],
    });

    this.togglePlacing();
    this.markers.select(marker, { fly: false });
    return true;
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
    this.hint.textContent = 'Camera saved.';
  }

  deleteSelected() {
    const marker = this.markers.selected;
    if (!marker) {
      this.hint.textContent = 'Select a marker first.';
      return;
    }

    this.markers.remove(marker.id);

    // remove() clears the selection but fires no onSelect, so the form and the detail
    // card would both stay on screen showing a marker that no longer exists.
    this.showForm(null);
    this.ui?.renderDetail(null);
    if (location.hash.slice(1) === marker.id) history.replaceState(null, '', location.pathname + location.search);

    this.hint.textContent = `Deleted "${marker.name}".`;
  }

  export() {
    const blob = new Blob([this.markers.toJSON(this.sceneName)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);

    const link = Object.assign(document.createElement('a'), { href: url, download: 'markers.json' });
    link.click();
    URL.revokeObjectURL(url);
  }
}

const numberOrNull = (value) => (value === '' ? null : Number(value));
const round = (n) => Math.round(n * 100) / 100;
