import { TYPES } from './markers.js';

/** The visitor-facing side panel: filterable list plus the detail card of what is selected. */
export class Ui {
  constructor(markers) {
    this.markers = markers;

    this.list = document.getElementById('list');
    this.detail = document.getElementById('detail');
    this.search = document.getElementById('search');
    this.filters = document.getElementById('filters');
    this.count = document.getElementById('count');

    // Which sections the visitor has opened or closed, so re-rendering the list does not
    // undo it.
    this.openSections = {};

    this.buildFilters();

    this.search.addEventListener('input', () => {
      this.markers.setFilter({ text: this.search.value.trim() });
      this.renderList();
    });

    markers.onSelect = (marker) => this.renderDetail(marker);
    markers.onChange = () => this.renderList();
  }

  buildFilters() {
    for (const [type, meta] of Object.entries(TYPES)) {
      const label = document.createElement('label');
      label.className = 'chip';
      label.style.setProperty('--chip', meta.color);

      const input = document.createElement('input');
      input.type = 'checkbox';
      // Read from the filter rather than assumed on: not every type starts visible.
      input.checked = this.markers.filter.types.has(type);
      input.addEventListener('change', () => {
        const types = this.markers.filter.types;
        input.checked ? types.add(type) : types.delete(type);
        this.markers.setFilter({ types });
        this.renderList();
      });

      label.append(input, meta.label);
      this.filters.append(label);
    }
  }

  renderList() {
    const visible = this.markers.items.filter((m) => this.markers.matches(m));
    this.count.textContent = `${visible.length} of ${this.markers.items.length}`;
    this.list.replaceChildren();

    if (visible.length === 0) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = this.markers.items.length
        ? 'No markers match the filter.'
        : 'No markers yet.';
      this.list.append(empty);
      return;
    }

    // Most time saved first: on a speedrun map that is the useful order.
    visible.sort((a, b) => (b.timeSaved ?? -1) - (a.timeSaved ?? -1));

    // One section per type. Forty-five rows in a single column is a scroll with no
    // landmarks; grouped, the shape of the list is visible before reading any of it.
    for (const [type, meta] of Object.entries(TYPES)) {
      const ofType = visible.filter((marker) => marker.type === type);
      if (ofType.length === 0) continue;

      const section = document.createElement('details');
      section.className = 'section';
      // Sections start open only while they are short enough to take in at a glance.
      section.open = this.openSections[type] ?? ofType.length <= 12;
      section.addEventListener('toggle', () => (this.openSections[type] = section.open));

      const summary = document.createElement('summary');
      summary.style.setProperty('--chip', meta.color);
      summary.textContent = `${meta.label}s (${ofType.length})`;
      section.append(summary);

      for (const marker of ofType) section.append(this.row(marker));
      this.list.append(section);
    }
  }

  /** One clickable entry in the list. */
  row(marker) {
    const row = document.createElement('button');
    row.className = 'row';
    row.classList.toggle('active', this.markers.selected?.id === marker.id);
    row.style.setProperty('--chip', TYPES[marker.type].color);

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = marker.name;

    const meta = document.createElement('span');
    meta.className = 'row-meta';
    meta.textContent = [
      marker.timeSaved != null ? `-${marker.timeSaved}s` : null,
      marker.difficulty != null ? '★'.repeat(marker.difficulty) : null,
    ]
      .filter(Boolean)
      .join('  ');

    row.append(name, meta);
    row.addEventListener('click', () => {
      this.markers.select(marker);
      location.hash = marker.id;
      this.renderList();
    });

    return row;
  }

  renderDetail(marker) {
    this.detail.replaceChildren();
    this.detail.classList.toggle('open', Boolean(marker));
    if (!marker) return;

    const title = document.createElement('h2');
    title.textContent = marker.name;

    const tags = document.createElement('p');
    tags.className = 'tags';
    tags.textContent = [
      TYPES[marker.type].label,
      marker.timeSaved != null ? `saves ${marker.timeSaved}s` : null,
      marker.difficulty != null ? `difficulty ${marker.difficulty}/5` : null,
    ]
      .filter(Boolean)
      .join(' · ');

    this.detail.append(title, tags);

    if (marker.video) {
      const embed = toEmbedUrl(marker.video);
      if (embed) {
        const frame = document.createElement('iframe');
        frame.src = embed;
        frame.allow = 'accelerometer; encrypted-media; picture-in-picture';
        frame.allowFullscreen = true;
        this.detail.append(frame);
      } else {
        const link = document.createElement('a');
        link.href = marker.video;
        link.target = '_blank';
        link.rel = 'noopener noreferrer';
        link.textContent = 'Watch video';
        this.detail.append(link);
      }
    }

    if (marker.notes) {
      const notes = document.createElement('p');
      notes.className = 'notes';
      notes.textContent = marker.notes;
      this.detail.append(notes);
    }

    const close = document.createElement('button');
    close.className = 'close';
    close.textContent = '×';
    close.title = 'Close';
    close.addEventListener('click', () => {
      this.markers.select(null, { fly: false });
      location.hash = '';
      this.renderList();
    });
    this.detail.append(close);
  }
}

/**
 * YouTube watch/share links to their embed form, keeping the start time. Anything else is
 * left alone and shown as a plain link.
 */
function toEmbedUrl(raw) {
  let url;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }

  const id =
    url.hostname === 'youtu.be'
      ? url.pathname.slice(1)
      : /(?:www\.)?youtube\.com$/.test(url.hostname)
        ? url.searchParams.get('v')
        : null;

  if (!id) return null;

  const start = url.searchParams.get('t') ?? url.searchParams.get('start');
  const seconds = start ? parseInt(start, 10) : null;

  return `https://www.youtube-nocookie.com/embed/${id}${seconds ? `?start=${seconds}` : ''}`;
}
