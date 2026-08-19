/**
 * Show/hide the level's areas. The builder groups every object under a node named after
 * its area, so toggling one is just flipping that node's visibility.
 *
 * The level arrives in several files, so an area's node may not exist yet when its switch is
 * drawn, and the trash ring's file is not even fetched until somebody asks for it. That is
 * why the wanted state lives here and apply() is called again every time a piece lands,
 * rather than the switches reading the scene.
 */

/**
 * The areas worth a switch, in the order they appear in the panel.
 *
 * Deliberately not every area the builder emits. The cannons, coins, checkpoints, beacons
 * and help beams are a handful of props each - hiding them tells you nothing about the
 * level - and the Hall of Champions is part of the map like any other room. Those stay on
 * screen with no switch; only the three levels and the trash ring are worth toggling.
 */
const AREAS = [
  { name: 'NW_L1_Tutorial_Area_v6_Combined', chunk: 'l1-tutorial', label: 'L1 · Tutorial', on: true },
  { name: 'NW_L2_Military_Area_v2_Combined', chunk: 'l2-military', label: 'L2 · Military', on: true },
  { name: 'NW_L3_Playground_Area_Demo_v5_Combined', chunk: 'l3-playground', label: 'L3 · Playground', on: true },
  { name: 'NW_LowestGround_Area_v2_Combined', chunk: 'trash-mountains', label: 'Trash mountains', on: false },
];

export class Layers {
  /**
   * `level` is the group every chunk is added to; `load(chunk)` fetches one that has not
   * been downloaded yet and resolves once it is in the scene.
   */
  constructor(level, container, load) {
    this.level = level;
    this.load = load;
    this.wanted = new Map(AREAS.map((area) => [area.name, area.on]));

    this.render(container);
    this.apply();
  }

  /** Pushes the wanted state onto whatever geometry has arrived so far. */
  apply() {
    for (const child of this.level.children) {
      // Each chunk file brings its own scene, whose children are the area nodes.
      for (const area of child.children) {
        const wanted = this.wanted.get(unsanitize(area.name, this.wanted));
        if (wanted !== undefined) area.visible = wanted;
      }
    }
  }

  render(container) {
    container.replaceChildren();

    for (const area of AREAS) {
      const label = document.createElement('label');
      label.className = 'layer';
      label.title = area.name;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = area.on;
      input.addEventListener('change', async () => {
        this.wanted.set(area.name, input.checked);
        this.apply();

        // Switched on for the first time: its file was never fetched, so there is nothing
        // to make visible until it arrives.
        if (input.checked) {
          input.disabled = true;
          await this.load(area.chunk);
          input.disabled = false;
          this.apply();
        }
      });

      const text = document.createElement('span');
      text.textContent = area.label;

      label.append(input, text);
      container.append(label);
    }
  }
}

/** three sanitizes node names on import, so match on the sanitized form too. */
const sanitize = (s) => s.replace(/[\/\.\[\]:]/g, '');

/** The original area name behind a sanitized one, or the name itself when it never changed. */
function unsanitize(name, names) {
  if (names.has(name)) return name;
  for (const original of names.keys()) if (sanitize(original) === name) return original;
  return name;
}
