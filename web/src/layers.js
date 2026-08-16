/**
 * Show/hide the level's areas. The builder groups every object under a node named after
 * its area, so toggling one is just flipping that node's visibility.
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
  { name: 'NW_L1_Tutorial_Area_v6_Combined', label: 'L1 · Tutorial', on: true },
  { name: 'NW_L2_Military_Area_v2_Combined', label: 'L2 · Military', on: true },
  { name: 'NW_L3_Playground_Area_Demo_v5_Combined', label: 'L3 · Playground', on: true },
  { name: 'NW_LowestGround_Area_v2_Combined', label: 'Trash mountains', on: false },
];

export class Layers {
  constructor(level, container) {
    this.groups = new Map();

    // three sanitizes node names on import, so match on the sanitized form too.
    for (const area of AREAS) {
      const object = level.children.find((child) => child.name === sanitize(area.name));
      if (!object) continue;

      object.visible = area.on;
      this.groups.set(area.name, { object, label: area.label });
    }

    this.render(container);
  }

  render(container) {
    container.replaceChildren();

    for (const [name, group] of this.groups) {
      const label = document.createElement('label');
      label.className = 'layer';

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = group.object.visible;
      input.addEventListener('change', () => {
        group.object.visible = input.checked;
      });

      const text = document.createElement('span');
      text.textContent = group.label;

      label.append(input, text);
      label.title = name;
      container.append(label);
    }
  }
}

const sanitize = (s) => s.replace(/[\/\.\[\]:]/g, '');
