import { TYPES, LEVELS, difficultyLevel } from './markers.js';

/** The visitor-facing side panel: filterable list plus the detail card of what is selected. */
export class Ui {
  constructor(markers) {
    this.markers = markers;

    this.list = document.getElementById('list');
    this.detail = document.getElementById('detail');
    this.search = document.getElementById('search');
    this.filters = document.getElementById('filters');
    this.levels = document.getElementById('levels');
    this.count = document.getElementById('count');

    // Which sections the visitor has opened or closed, so re-rendering the list does not
    // undo it.
    this.openSections = {};

    // The types whose sections have been opened, most recent first. What you just opened is
    // what you are reading, so it goes to the top instead of leaving you scrolling to it.
    this.recentSections = [];

    this.buildFilters();
    this.buildLevels();

    // On a phone the panel is a sheet that starts closed - see the media query in style.css.
    // Its header is the handle: tapping it slides the list up over the map. On a desktop the
    // class does nothing, because there the panel is always open.
    document
      .querySelector('#panel header')
      .addEventListener('click', () => document.body.classList.toggle('panel-open'));

    this.search.addEventListener('input', () => {
      this.markers.setFilter({ text: this.search.value.trim() });
      this.renderList();
    });

    markers.onSelect = (marker) => this.showSelection(marker);
    markers.onChange = () => this.renderList();
  }

  buildFilters() {
    for (const [type, meta] of chipOrder()) {
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
        // Switching a type on is asking to see it, so its section opens even when it is a
        // long one the list would otherwise have started collapsed, and it opens on top.
        if (input.checked) {
          this.openSections[type] = true;
          this.promote(type);
        }
        this.markers.setFilter({ types });
        this.renderList();
      });

      label.append(input, meta.label);
      this.filters.append(label);
    }
  }

  /**
   * The difficulty filter: one strip of five stars, each its own switch.
   *
   * Five chips reading ★ to ★★★★★ said the same thing and took four lines of the panel
   * between them and the types. Lit up, the strip doubles as the legend for the stars in
   * the list, which is why the colours match those and not the chips.
   */
  buildLevels() {
    for (const value of LEVELS) {
      const star = document.createElement('label');
      star.className = 'level';
      star.style.setProperty('--level', DIFFICULTY[value - 1]);
      star.title = `Difficulty ${value} of 5`;

      const input = document.createElement('input');
      input.type = 'checkbox';
      input.checked = this.markers.filter.levels.has(value);
      input.addEventListener('change', () => {
        const levels = this.markers.filter.levels;
        input.checked ? levels.add(value) : levels.delete(value);
        this.markers.setFilter({ levels });
        this.renderList();
      });

      star.append(input, '★');
      this.levels.append(star);
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
    for (const type of this.orderedTypes()) {
      const meta = TYPES[type];
      const ofType = visible.filter((marker) => marker.type === type);
      if (ofType.length === 0) continue;

      const section = document.createElement('details');
      section.className = 'section';
      section.dataset.type = type;
      // Sections start open only while they are short enough to take in at a glance.
      section.open = this.openSections[type] ?? ofType.length <= 12;
      section.addEventListener('toggle', () => (this.openSections[type] = section.open));

      const summary = document.createElement('summary');
      summary.style.setProperty('--chip', meta.color);
      summary.textContent = `${meta.label}s (${ofType.length})`;
      section.append(summary);

      // Opening moves the section to the top, which means rebuilding the list rather than
      // just unfolding in place. The click is cancelled because it is the rebuilt section
      // that opens - letting both happen would toggle the new one straight back shut.
      // Closing is left alone: it says nothing about what you want to read next.
      summary.addEventListener('click', (event) => {
        if (section.open) return;
        event.preventDefault();
        this.openSections[type] = true;
        this.promote(type);
        this.renderList();
      });

      for (const marker of ofType) section.append(this.row(marker));
      this.list.append(section);
    }
  }

  /**
   * The types in the order their sections go down the panel: the ones that have been opened
   * first, most recent at the top, and the rest in the order TYPES declares them.
   */
  orderedTypes() {
    const known = Object.keys(TYPES);
    const recent = this.recentSections.filter((type) => known.includes(type));

    return [...recent, ...known.filter((type) => !recent.includes(type))];
  }

  /** Moves a type to the front of that order. */
  promote(type) {
    this.recentSections = [type, ...this.recentSections.filter((other) => other !== type)];
  }

  /** One clickable entry in the list. */
  row(marker) {
    const row = document.createElement('button');
    row.className = 'row';
    row.dataset.id = marker.id;
    row.classList.toggle('active', this.markers.selected?.id === marker.id);
    row.style.setProperty('--chip', TYPES[marker.type].color);

    const name = document.createElement('span');
    name.className = 'row-name';
    name.textContent = marker.name;

    const meta = document.createElement('span');
    meta.className = 'row-meta';

    if (marker.timeSaved != null) {
      const time = document.createElement('span');
      time.textContent = `-${marker.timeSaved}s`;
      meta.append(time);
    }

    if (marker.difficulty != null) meta.append(stars(marker.difficulty));

    row.append(name, meta);
    row.addEventListener('click', () => {
      this.markers.select(marker);
      location.hash = marker.id;
      this.renderList();
      // The sheet gets out of the way: you picked a marker in order to look at where it is.
      document.body.classList.remove('panel-open');
    });

    return row;
  }

  /**
   * Everything that has to happen when the selection changes: the card, and the list.
   *
   * One entry point rather than two, because the editor replaces markers.onSelect with its
   * own handler and would otherwise have to remember to do both halves.
   */
  showSelection(marker) {
    this.renderDetail(marker);
    this.highlight(marker);
  }

  /**
   * Marks the selected marker's row and brings it into view, so picking something on the
   * map points at it in the list too.
   *
   * The class is moved rather than the list re-rendered: re-rendering would throw away the
   * scroll position, which is the one thing that has to survive for scrolling to it to mean
   * anything.
   */
  highlight(marker) {
    for (const row of this.list.querySelectorAll('.row.active')) row.classList.remove('active');
    if (!marker) return;

    // A marker in a collapsed section has a row, but one nothing can scroll to.
    const section = this.list.querySelector(`.section[data-type="${marker.type}"]`);
    if (section && !section.open) {
      this.openSections[marker.type] = true;
      this.promote(marker.type);
      this.renderList();
    }

    const row = this.list.querySelector(`.row[data-id="${cssEscape(marker.id)}"]`);
    if (!row) return;

    row.classList.add('active');
    row.scrollIntoView({ block: 'nearest' });
  }

  renderDetail(marker) {
    this.detail.replaceChildren();
    this.detail.classList.toggle('open', Boolean(marker));
    if (!marker) return;

    const title = document.createElement('h2');
    title.textContent = marker.name;

    // Built up node by node rather than as one string, because the difficulty carries its
    // own colour and the rest of the line does not.
    const tags = document.createElement('p');
    tags.className = 'tags';
    tags.append(TYPES[marker.type].label);
    if (marker.timeSaved != null) tags.append(` · saves ${marker.timeSaved}s`);

    if (marker.difficulty != null) {
      const level = document.createElement('span');
      level.className = 'difficulty';
      level.style.setProperty('--level', difficultyColor(marker.difficulty));
      level.textContent = `difficulty ${marker.difficulty}/5`;
      tags.append(' · ', level);
    }

    this.detail.append(title, tags);

    if (marker.video && isVideoFile(marker.video)) {
      // A clip we host ourselves, played in the page. Muted and looping because these are a
      // few seconds of a trick seen over and over, not something you sit and watch once.
      const video = document.createElement('video');
      video.src = marker.video;
      video.controls = true;
      video.loop = true;
      video.muted = true;
      video.playsInline = true;
      video.preload = 'metadata';
      this.detail.append(video);
    } else if (marker.video) {
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
 * Difficulty 1 to 5, green through to red. Anchored on colours the map already uses - the
 * checkpoint green at one end, the coin yellow in the middle and the skip red at the other -
 * so the panel does not turn into a second palette of its own.
 */
/**
 * The filter chips in their own order, three to a row: what the level comes with on the
 * first, what people write on the second. The list below keeps the order in TYPES, where
 * skips come first because they are what the map is for.
 *
 * Anything missing from here still gets a chip - a new type should appear on its own, not
 * wait for somebody to remember this line.
 */
const CHIPS = ['coin', 'skin', 'checkpoint', 'npc', 'skip', 'route', 'note'];

const chipOrder = () => {
  const ordered = CHIPS.filter((type) => TYPES[type]);
  const rest = Object.keys(TYPES).filter((type) => !ordered.includes(type));

  return [...ordered, ...rest].map((type) => [type, TYPES[type]]);
};

/** CSS.escape, for the ids that go into a querySelector. */
const cssEscape = (value) => (window.CSS?.escape ? CSS.escape(value) : value);

const DIFFICULTY = ['#48d597', '#a5d65c', '#f5c451', '#ff9a4e', '#ff6b4e'];

const difficultyColor = (difficulty) => DIFFICULTY[difficultyLevel(difficulty) - 1];

/** The difficulty as stars, coloured by how hard it is. */
function stars(difficulty) {
  const span = document.createElement('span');
  span.className = 'stars';
  span.style.setProperty('--level', difficultyColor(difficulty));
  span.textContent = '★'.repeat(difficultyLevel(difficulty));
  span.title = `Difficulty ${difficulty}/5`;

  return span;
}

/**
 * Whether the video is a file to play rather than a page to embed. Judged by the extension,
 * because that is all a bare URL to a bucket gives you to go on.
 */
const isVideoFile = (url) => /\.(mp4|webm|mov)(\?|#|$)/i.test(url);

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
