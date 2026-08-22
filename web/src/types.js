/**
 * The kinds of thing a marker can be, and how each one reads on the map.
 *
 * On its own rather than in markers.js because the media page needs the names and colours
 * and nothing else: importing them from there pulled three.js into a page that never draws
 * anything, and put half a megabyte in front of a list of files.
 */
export const TYPES = {
  skip: { label: 'Skip', color: '#ff6b4e' },
  route: { label: 'Route', color: '#4ea1ff' },
  checkpoint: { label: 'Checkpoint', color: '#48d597' },
  coin: { label: 'Coin', color: '#f5c451' },
  skin: { label: 'Skin', color: '#ff7ab6' },
  npc: { label: 'NPC', color: '#4ed8e6' },
  note: { label: 'Note', color: '#b98cf5' },
};
