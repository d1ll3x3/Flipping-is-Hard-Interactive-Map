/**
 * The media page: every clip and photo the map uses, plus everything sitting in the bucket
 * that no marker points at.
 *
 * It is a page of the site rather than a file somebody generates, because the point is that
 * the other editors can open it - and because the interesting half, what is in the bucket,
 * can only be asked for at the moment somebody with the passphrase is looking.
 *
 * Nothing is shown before that passphrase is right: the list of every file in the bucket is
 * not something a visitor needs, and the Worker refuses to hand it over anyway.
 */
import { TYPES } from './types.js';
import { addressOf, keyOf, list, remove } from './bucket.js';
import { unlockEditor } from './access.js';

const asset = (name) => `${import.meta.env.BASE_URL}${name}`;

const summary = document.getElementById('summary');
const note = document.getElementById('note');
const bar = document.getElementById('bar');
const listEl = document.getElementById('list');
const empty = document.getElementById('empty');
const search = document.getElementById('search');

let rows = [];
let filter = 'all';

// What the note says when nothing has just gone wrong: the standing warning about markers
// whose file is missing, or nothing at all. A failed delete writes over it, and a delete
// that works puts it back rather than leaving its own error on screen.
let standing = '';

start();

async function start() {
  if (!(await unlockEditor())) {
    summary.textContent = 'This page is for editors. Reload to try the passphrase again.';
    return;
  }

  summary.textContent = 'Loading…';

  const markers = await fetch(asset('data/markers.json'))
    .then((response) => response.json())
    .catch((error) => {
      summary.textContent = `Could not read the marker list: ${error.message}`;
      return null;
    });

  if (!markers) return;

  rows = markers.markers.flatMap((marker) => [
    ...(marker.video ? [entry(marker, marker.video, 'video')] : []),
    ...(marker.image ? [entry(marker, marker.image, 'photo')] : []),
  ]);

  // The bucket is asked for separately and is allowed to fail on its own: the page is still
  // worth showing without it, it just cannot say what is unused.
  let objects = null;
  try {
    objects = await list();
  } catch (error) {
    say(`Could not read the bucket, so nothing here is marked as unused: ${error.message}`, true);
  }

  if (objects) addOrphans(objects);

  summary.textContent =
    `${rows.filter((row) => !row.orphan).length} files across ${markers.markers.length} markers. ` +
    'Click any of them to watch it here.';

  render();
  bar.hidden = false;
}

/** A file a marker points at. */
function entry(marker, url, kind) {
  const key = keyOf(url);
  const tube = /youtu\.?be/.test(url) ? youtube(url) : null;

  return {
    id: marker.id,
    name: marker.name,
    type: marker.type,
    kind,
    url,
    key,
    // The bucket keeps the name whoever uploaded it typed, plus a random tail; that name is
    // what makes a row recognisable at a glance.
    file: key ?? new URL(url).host.replace(/^www\./, ''),
    source: key ? 'bucket' : tube ? 'youtube' : 'link',
    embed: tube?.embed ?? '',
    thumb: kind === 'photo' && key ? url : (tube?.thumb ?? null),
    // Only a file in the bucket can be played as a file; a YouTube page cannot.
    inline: Boolean(key) && kind === 'video',
  };
}

/** youtu.be/ID, watch?v=ID and an embed all come down to the id and a start time. */
function youtube(url) {
  const parsed = new URL(url);
  const id = parsed.searchParams.get('v') ?? parsed.pathname.split('/').filter(Boolean).pop();
  if (!id) return null;

  // Both spellings are in the file: ?t=42 and ?t=42s.
  const start = (parsed.searchParams.get('t') ?? '').replace(/[^0-9]/g, '');

  return {
    id,
    thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg`,
    // nocookie: this is a list of links and does not need to hand YouTube a profile of who
    // read it.
    embed: `https://www.youtube-nocookie.com/embed/${id}?autoplay=1${start ? `&start=${start}` : ''}`,
  };
}

/**
 * What is in the bucket that no marker uses.
 *
 * Almost always a re-upload: every upload gets a new name on purpose, so a second take
 * leaves the first one behind with nothing pointing at it.
 */
function addOrphans(objects) {
  const used = new Set(rows.map((row) => row.key).filter(Boolean));
  const there = new Set(objects.map((object) => object.key));

  const orphans = objects
    .filter((object) => !used.has(object.key))
    .map((object) => ({
      id: object.key,
      name: object.key,
      type: 'orphan',
      kind: /\.(mp4|webm)$/i.test(object.key) ? 'video' : 'photo',
      url: addressOf(object.key),
      key: object.key,
      file: `${size(object.size)} · uploaded ${object.uploaded.slice(0, 10)}`,
      source: 'bucket',
      embed: '',
      thumb: /\.(mp4|webm)$/i.test(object.key) ? null : addressOf(object.key),
      inline: /\.(mp4|webm)$/i.test(object.key),
      orphan: true,
    }));

  // The other half of the same question: a marker pointing at a file that is not there any
  // more. Worth saying out loud - that marker shows a broken video to everyone.
  const missing = rows.filter((row) => row.key && !there.has(row.key));
  if (missing.length) {
    say(
      `${missing.length} marker${missing.length === 1 ? '' : 's'} point at a file that is no longer ` +
        `in the bucket: ${missing.map((row) => row.id).join(', ')}.`,
      true
    );
  }

  rows = [...orphans, ...rows];
}

/** Says something in the note line, and remembers it as what should be there. */
function say(text, warn) {
  standing = text;
  note.textContent = text;
  note.classList.toggle('warn', Boolean(warn));
}

const size = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

// ───────────────────────────────────────────────────────────────────────── page ──

function render() {
  listEl.replaceChildren();

  // Unused first: it is the half somebody came here to deal with. Then the marker types in
  // the order the map itself uses.
  const groups = [
    { type: 'orphan', label: 'Unused', color: 'var(--warn)' },
    ...Object.entries(TYPES).map(([type, meta]) => ({ type, label: meta.label, color: meta.color })),
  ];

  for (const group of groups) {
    const mine = rows.filter((row) => row.type === group.type);
    if (!mine.length) continue;

    const section = document.createElement('section');
    section.dataset.type = group.type;
    section.style.setProperty('--dot', group.color);
    section.innerHTML = `<h2>${group.label} <span class="n">${mine.length}</span></h2>`;

    const grid = document.createElement('div');
    grid.className = 'grid';
    grid.append(...mine.map(card));
    section.append(grid);
    listEl.append(section);
  }

  counts();
  apply();
}

function card(row) {
  const article = document.createElement('article');
  article.className = 'card';
  article.dataset.kind = row.kind;
  article.dataset.source = row.source;
  article.dataset.orphan = row.orphan ? '1' : '0';
  article.dataset.search = `${row.name} ${row.id} ${row.file}`.toLowerCase();

  const thumb = document.createElement('button');
  thumb.type = 'button';
  thumb.className = 'thumb';
  thumb.setAttribute('aria-label', `Watch ${row.name}`);
  thumb.append(preview(row));
  thumb.insertAdjacentHTML('beforeend', `<span class="play">${row.kind === 'video' ? '&#9654;' : '&#9906;'}</span>`);
  thumb.addEventListener('click', () => open(row));

  const name = document.createElement('button');
  name.type = 'button';
  name.className = 'name';
  name.textContent = row.name;
  name.addEventListener('click', () => open(row));

  const what = document.createElement('div');
  what.className = 'what';
  what.append(name);
  what.insertAdjacentHTML(
    'beforeend',
    `<p class="meta">${
      row.orphan
        ? `<span class="warn">unused</span> · ${row.kind === 'video' ? 'clip' : 'photo'}`
        : `<span class="id"></span> · ${row.kind === 'video' ? 'clip' : 'photo'} · ${
            row.source === 'bucket' ? 'bucket' : row.source === 'youtube' ? 'YouTube' : 'link'
          }`
    }</p>
     <p class="file"><a target="_blank" rel="noopener"></a></p>`
  );
  // Set as text rather than interpolated, so a marker named with an angle bracket cannot
  // write markup into the page.
  const id = what.querySelector('.id');
  if (id) id.textContent = row.id;
  const link = what.querySelector('.file a');
  link.href = row.url;
  link.textContent = row.file;

  article.append(thumb, what, buttons(row, article));
  return article;
}

/** Copy, and for a file of ours, delete. */
function buttons(row, article) {
  const box = document.createElement('div');
  box.className = 'actions';

  const copy = document.createElement('button');
  copy.type = 'button';
  copy.className = 'copy';
  copy.textContent = 'Copy';
  copy.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(row.url);
      copy.textContent = 'Copied';
    } catch (error) {
      copy.textContent = 'No';
      console.warn('Clipboard refused:', error);
    }
    setTimeout(() => {
      copy.textContent = 'Copy';
    }, 1200);
  });
  box.append(copy);

  // Only files in our own bucket can be deleted, and a file a marker still uses is not
  // offered at all: taking it out would leave that marker showing a broken video.
  if (row.key && row.orphan) {
    const kill = document.createElement('button');
    kill.type = 'button';
    kill.className = 'delete';
    kill.textContent = 'Delete';
    kill.addEventListener('click', () => destroy(row, article, kill));
    box.append(kill);
  }

  return box;
}

/**
 * Deletes a file from the bucket, after asking. There is no undo anywhere - not in R2, not
 * in git - so the confirmation spells out the name and the fact that it is final.
 */
async function destroy(row, article, button) {
  if (!confirm(`Delete "${row.key}" from the bucket?\n\nThis cannot be undone.`)) return;

  button.disabled = true;
  button.textContent = 'Deleting…';

  try {
    await remove(row.key);
    // Whatever the last failure said is no longer true.
    note.textContent = standing;
    note.classList.toggle('warn', Boolean(standing));
    rows = rows.filter((other) => other !== row);
    article.remove();
    counts();
    // The section it was in may have just become empty.
    for (const section of listEl.querySelectorAll('section')) {
      if (!section.querySelector('.card')) section.remove();
    }
  } catch (error) {
    button.disabled = false;
    button.textContent = 'Delete';
    note.textContent = `Could not delete ${row.key}: ${error.message}`;
    note.classList.add('warn');
    console.error(error);
  }
}

function preview(row) {
  if (row.inline) {
    // muted and playsinline so a browser is willing to show the frame at all; no controls,
    // because the card is a thumbnail and not a player. metadata is the first frame and no
    // more - the whole bucket would otherwise be downloaded to look at a list.
    const video = document.createElement('video');
    video.src = row.url;
    video.preload = 'metadata';
    video.muted = true;
    video.playsInline = true;
    return video;
  }

  if (row.thumb) {
    const image = document.createElement('img');
    image.src = row.thumb;
    image.alt = '';
    image.loading = 'lazy';
    return image;
  }

  const glyph = document.createElement('span');
  glyph.className = 'glyph';
  glyph.textContent = '▶';
  return glyph;
}

function counts() {
  const of = (test) => rows.filter(test).length;
  const numbers = {
    all: rows.length,
    clips: of((row) => row.inline && !row.orphan),
    youtube: of((row) => row.source === 'youtube'),
    photos: of((row) => row.kind === 'photo' && !row.orphan),
    orphans: of((row) => row.orphan),
  };

  for (const tab of bar.querySelectorAll('.tab')) {
    tab.querySelector('.n').textContent = numbers[tab.dataset.filter];
    if (tab.dataset.filter === 'orphans') tab.hidden = !numbers.orphans;
  }
}

function matches(article) {
  if (filter === 'clips') return article.dataset.kind === 'video' && article.dataset.source === 'bucket';
  if (filter === 'youtube') return article.dataset.source === 'youtube';
  if (filter === 'photos') return article.dataset.kind === 'photo';
  if (filter === 'orphans') return article.dataset.orphan === '1';
  return true;
}

function apply() {
  const query = search.value.trim().toLowerCase();
  let shown = 0;

  for (const article of listEl.querySelectorAll('.card')) {
    const ok = matches(article) && (!query || article.dataset.search.includes(query));
    article.hidden = !ok;
    if (ok) shown++;
  }

  // A whole type with nothing left in it is a heading over a gap, so it goes too.
  for (const section of listEl.querySelectorAll('section')) {
    section.hidden = ![...section.querySelectorAll('.card')].some((article) => !article.hidden);
  }

  empty.hidden = shown > 0;
}

for (const tab of bar.querySelectorAll('.tab')) {
  tab.addEventListener('click', () => {
    filter = tab.dataset.filter;
    for (const other of bar.querySelectorAll('.tab')) {
      other.setAttribute('aria-pressed', String(other === tab));
    }
    apply();
  });
}

search.addEventListener('input', apply);

// ─────────────────────────────────────────────────────────────────────── viewer ──

const viewer = document.getElementById('viewer');
const stage = document.getElementById('stage');
const viewerName = document.getElementById('viewerName');
const viewerLink = document.getElementById('viewerLink');

function open(row) {
  viewerName.textContent = row.name;
  viewerLink.href = row.url;
  // Built now rather than kept hidden in the page: an iframe that exists is an iframe that
  // has already called YouTube, times forty-three.
  stage.replaceChildren(player(row));
  viewer.showModal();
}

function player(row) {
  if (row.embed) {
    const frame = document.createElement('iframe');
    frame.src = row.embed;
    frame.allow = 'autoplay; fullscreen; encrypted-media';
    frame.allowFullscreen = true;
    return frame;
  }

  if (row.kind === 'photo') {
    const image = document.createElement('img');
    image.src = row.url;
    image.alt = '';
    return image;
  }

  const video = document.createElement('video');
  video.src = row.url;
  video.controls = true;
  video.autoplay = true;
  video.loop = true;
  return video;
}

document.getElementById('viewerShut').addEventListener('click', () => viewer.close());
// Emptying the stage is what stops the sound: a closed dialog still holds a playing video,
// and removing the iframe is the only way to stop a YouTube one. Esc closes the dialog by
// itself, so this hangs off close rather than off the button.
viewer.addEventListener('close', () => stage.replaceChildren());
viewer.addEventListener('click', (event) => {
  if (event.target === viewer) viewer.close();
});
