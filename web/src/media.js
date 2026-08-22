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
import { addressOf, keyOf, list, remove, upload } from './bucket.js';
import { loadBaseSha, saveMarkers, savingConfigured } from './save.js';
import { canCompress, compress } from './video.js';
import { canShrink, shrink } from './photo.js';
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

// The marker list as it came out of the repository, and what the level is called. Uploading
// from here edits one of these and commits the lot, the same way the editor's Save does.
let markers = [];
let scene = null;
let objects = null;
let saving = false;

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

  const file = await fetch(asset('data/markers.json'))
    .then((response) => response.json())
    .catch((error) => {
      summary.textContent = `Could not read the marker list: ${error.message}`;
      return null;
    });

  if (!file) return;

  markers = file.markers;
  scene = file.scene;

  // The bucket is asked for separately and is allowed to fail on its own: the page is still
  // worth showing without it, it just cannot say what is unused.
  try {
    objects = await list();
  } catch (error) {
    say(`Could not read the bucket, so nothing here is marked as unused: ${error.message}`, true);
  }

  // Which revision an upload from here would be committing against. Without it the button
  // is still shown, but saying why it cannot be used beats a click that fails.
  saving = savingConfigured();
  if (saving) {
    try {
      await loadBaseSha();
    } catch (error) {
      saving = false;
      say(`Uploading is off: the save service is unreachable (${error.message})`, true);
    }
  } else {
    say('Uploading is off: saving is not set up on this deployment.', true);
  }

  rebuild();
  bar.hidden = false;
}

/** Everything on the page, worked out again from the marker list and the bucket listing. */
function rebuild() {
  rows = markers.flatMap((marker) => [
    ...(marker.video ? [entry(marker, marker.video, 'video')] : []),
    ...(marker.image ? [entry(marker, marker.image, 'photo')] : []),
  ]);

  const files = rows.length;
  if (objects) addOrphans(objects);
  addMissing();

  summary.textContent =
    `${files} files across ${markers.length} markers. Click any of them to watch it here.`;

  render();
}

/** A file a marker points at. */
function entry(marker, url, kind) {
  const key = keyOf(url);
  const tube = /youtu\.?be/.test(url) ? youtube(url) : null;

  return {
    id: marker.id,
    name: marker.name,
    type: marker.type,
    // Kept so the file can be taken off the marker again from here.
    marker,
    field: kind === 'video' ? 'video' : 'image',
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

/**
 * The markers with nothing on them at all - no clip and no photo.
 *
 * The question the file list cannot answer on its own: it can only show what exists, and
 * what somebody planning an afternoon of recording wants is the opposite of that.
 */
function addMissing() {
  const empty = markers
    .filter((marker) => !marker.video && !marker.image)
    .map((marker) => ({
      id: marker.id,
      name: marker.name,
      type: 'missing',
      markerType: marker.type,
      kind: 'none',
      url: null,
      key: null,
      file: 'nothing uploaded yet',
      source: 'none',
      embed: '',
      thumb: null,
      inline: false,
      missing: true,
      marker,
    }));

  rows = [...empty, ...rows];
}

const size = (bytes) =>
  bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;

// ───────────────────────────────────────────────────────────────────────── page ──

function render() {
  listEl.replaceChildren();

  // Unused first: it is the half somebody came here to deal with. Then the marker types in
  // the order the map itself uses.
  const groups = [
    { type: 'missing', label: 'Nothing yet', color: 'var(--muted)' },
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
  article.dataset.missing = row.missing ? '1' : '0';
  article.dataset.search = `${row.name} ${row.id} ${row.file}`.toLowerCase();

  const thumb = document.createElement(row.missing ? 'div' : 'button');
  thumb.className = 'thumb';
  if (row.missing) {
    // Nothing to open, so it is not a button: it carries the marker's own colour instead,
    // which is the only thing there is to say about it.
    thumb.classList.add('nothing');
    thumb.style.setProperty('--dot', TYPES[row.markerType]?.color ?? 'var(--muted)');
  } else {
    thumb.type = 'button';
    thumb.setAttribute('aria-label', `Watch ${row.name}`);
    thumb.append(preview(row));
    thumb.insertAdjacentHTML('beforeend', `<span class="play">${row.kind === 'video' ? '&#9654;' : '&#9906;'}</span>`);
    thumb.addEventListener('click', () => open(row));
  }

  // A marker with nothing on it opens on the map instead, which is where you go to see what
  // the skip actually is before recording it.
  const name = document.createElement(row.missing ? 'a' : 'button');
  name.className = 'name';
  name.textContent = row.name;
  if (row.missing) {
    name.href = `${import.meta.env.BASE_URL}#${row.id}`;
    name.target = '_blank';
    name.rel = 'noopener';
  } else {
    name.type = 'button';
    name.addEventListener('click', () => open(row));
  }

  const what = document.createElement('div');
  what.className = 'what';
  what.append(name);
  what.insertAdjacentHTML(
    'beforeend',
    `<p class="meta">${
      row.orphan
        ? `<span class="warn">unused</span> · ${row.kind === 'video' ? 'clip' : 'photo'}`
        : row.missing
          ? `<span class="id"></span> · ${TYPES[row.markerType]?.label ?? row.markerType}`
          : `<span class="id"></span> · ${row.kind === 'video' ? 'clip' : 'photo'} · ${
              row.source === 'bucket' ? 'bucket' : row.source === 'youtube' ? 'YouTube' : 'link'
            }`
    }</p>
     <p class="file">${row.missing ? '<span></span>' : '<a target="_blank" rel="noopener"></a>'}</p>`
  );
  // Set as text rather than interpolated, so a marker named with an angle bracket cannot
  // write markup into the page.
  const id = what.querySelector('.id');
  if (id) id.textContent = row.id;
  const link = what.querySelector('.file a, .file span');
  if (row.missing) {
    link.textContent = row.file;
  } else {
    link.href = row.url;
    link.textContent = row.file;
  }

  article.append(thumb, what, buttons(row, article));
  return article;
}

/** Copy, and for a file of ours, delete; for a marker with nothing on it, upload. */
function buttons(row, article) {
  const box = document.createElement('div');
  box.className = 'actions';

  if (row.missing) {
    for (const [kind, label] of [
      ['video', 'Add clip'],
      ['photo', 'Add photo'],
    ]) {
      const button = document.createElement('button');
      button.type = 'button';
      button.textContent = label;
      button.disabled = !saving;
      button.addEventListener('click', () => add(row, kind, box));
      box.append(button);
    }

    // For a clip that is already somewhere - a YouTube video, or a file in the bucket that
    // came off another marker and is sitting under Unused.
    const link = document.createElement('button');
    link.type = 'button';
    link.textContent = 'Add link';
    link.disabled = !saving;
    link.addEventListener('click', () => paste(row, box));
    box.append(link);

    return box;
  }

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

  // Takes the file off the marker without touching the file itself: it drops into Unused,
  // where it can be put on another marker or deleted on purpose.
  if (row.marker) {
    const off = document.createElement('button');
    off.type = 'button';
    off.textContent = 'Unassign';
    off.disabled = !saving;
    off.addEventListener('click', () => unassign(row, box));
    box.append(off);
  }

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

/**
 * Puts a recording or a screenshot on a marker that has neither, from here.
 *
 * The same three steps the editor does - shrink in the browser, put it in the bucket, commit
 * the marker list - because they are the same functions. Re-encoding a clip runs in real
 * time, so a ten second clip takes ten seconds and the card says so while it happens.
 */
async function add(row, kind, box) {
  const file = await pick(kind === 'video' ? 'video/*' : 'image/*');
  if (!file) return;

  const buttons = [...box.querySelectorAll('button')];
  for (const button of buttons) button.disabled = true;

  const step = (text) => progress(box, text);

  try {
    const was = file.size;
    let blob = file;

    if (kind === 'video' && canCompress()) {
      step(`Re-encoding ${mb(was)} MB… 0%`);
      blob = await compress(file, (done) => step(`Re-encoding ${mb(was)} MB… ${Math.round(done * 100)}%`));
    } else if (kind === 'photo' && canShrink()) {
      step(`Shrinking ${mb(was)} MB…`);
      blob = await shrink(file);
    } else {
      // Worth saying rather than quietly uploading 15 MB: everyone who opens that marker
      // pays for it, and the person here is the only one who can fix it.
      step(`This browser cannot re-encode, uploading ${mb(was)} MB as is…`);
    }

    step(`Uploading ${mb(blob.size)} MB…`);
    const url = await upload(blob, row.name || row.id);

    step('Saving to the repo…');
    await write(row.marker, kind === 'video' ? 'video' : 'image', url);
    done(`Added to "${row.name}". The map republishes in about a minute.`);
  } catch (error) {
    step(`Not added: ${error.message}`);
    for (const button of buttons) button.disabled = false;
    console.error(error);
  }
}

/**
 * Puts a video or photo that already exists on a marker: a YouTube link, or the address of
 * a file under Unused that belongs to this marker after all.
 *
 * Which field it lands in is decided by the address: anything that looks like a picture is
 * one, and everything else is the video. That is the same guess the map makes when it draws
 * the marker, so a wrong one is visible immediately and fixed with Unassign.
 */
async function paste(row, box) {
  const url = prompt(`Link for "${row.name}":

A YouTube address, or the address of a file under Unused.`);
  if (!url) return;

  const trimmed = url.trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    progress(box, 'That is not an http address.');
    return;
  }

  const buttons = [...box.querySelectorAll('button')];
  for (const button of buttons) button.disabled = true;
  progress(box, 'Saving to the repo…');

  try {
    await write(row.marker, /\.(webp|jpe?g|png|gif|avif)$/i.test(trimmed) ? 'image' : 'video', trimmed);
    done(`Linked to "${row.name}". The map republishes in about a minute.`);
  } catch (error) {
    progress(box, `Not saved: ${error.message}`);
    for (const button of buttons) button.disabled = false;
    console.error(error);
  }
}

/**
 * Takes a file off a marker. The file itself is left alone - it turns up under Unused,
 * where it can go on another marker or be deleted on purpose.
 */
async function unassign(row, box) {
  if (!confirm(`Take this ${row.kind === 'video' ? 'video' : 'photo'} off "${row.name}"?

The file stays in storage and moves to Unused.`)) {
    return;
  }

  const buttons = [...box.querySelectorAll('button')];
  for (const button of buttons) button.disabled = true;
  progress(box, 'Saving to the repo…');

  try {
    await write(row.marker, row.field, null);
    done(`Taken off "${row.name}". The map republishes in about a minute.`);
  } catch (error) {
    progress(box, `Not saved: ${error.message}`);
    for (const button of buttons) button.disabled = false;
    console.error(error);
  }
}

/**
 * Writes one field of one marker and commits the list.
 *
 * The whole list goes, as the editor's Save does: the Worker works out what changed against
 * the revision this page loaded, so somebody else's edits in the meantime are merged rather
 * than overwritten.
 */
async function write(marker, field, value) {
  const had = marker[field];
  if (value === null) delete marker[field];
  else marker[field] = value;

  try {
    const result = await saveMarkers(scene, markers);
    // The Worker merged with somebody else's save; its version is the one to keep working
    // from, or the next save from here would read their markers as deletions.
    if (result.list) markers = result.list;
  } catch (error) {
    // Put the marker back the way it was, or the page would show a change that is not in
    // the repository and the next save would carry it in silently.
    if (had === undefined) delete marker[field];
    else marker[field] = had;
    throw error;
  }
}

/** Says how it went, and draws the page again around the change. */
function done(text) {
  note.textContent = text;
  note.classList.remove('warn');
  rebuild();
}

/** The line inside a card that says what is happening to it. */
function progress(box, text) {
  const line =
    box.parentElement.querySelector('.progress') ??
    Object.assign(document.createElement('p'), { className: 'progress' });
  line.textContent = text;
  box.before(line);
}

/** The file picker, as a promise. A cancelled pick never resolves, and nothing waits on it. */
function pick(accept) {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.addEventListener('change', () => resolve(input.files[0] ?? null), { once: true });
    input.click();
  });
}

const mb = (bytes) => (bytes / 1048576).toFixed(1);

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
    missing: of((row) => row.missing),
  };

  for (const tab of bar.querySelectorAll('.tab')) {
    tab.querySelector('.n').textContent = numbers[tab.dataset.filter];
    // A tab for something there is none of is a tab that only ever says zero.
    if (tab.dataset.filter === 'orphans') tab.hidden = !numbers.orphans;
    if (tab.dataset.filter === 'missing') tab.hidden = !numbers.missing;
  }
}

function matches(article) {
  if (filter === 'clips') return article.dataset.kind === 'video' && article.dataset.source === 'bucket';
  if (filter === 'youtube') return article.dataset.source === 'youtube';
  if (filter === 'photos') return article.dataset.kind === 'photo';
  if (filter === 'orphans') return article.dataset.orphan === '1';
  if (filter === 'missing') return article.dataset.missing === '1';
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
