// Recompresses a folder of screen recordings and puts them in the R2 bucket the map reads
// its videos from.
//
//   node tools/publish-clips.mjs "D:/videos/Speedruns"
//   node tools/publish-clips.mjs "D:/videos/Speedruns" --write     also fills in markers.json
//   node tools/publish-clips.mjs "D:/videos/Speedruns" --dry       says what it would do
//
// Two things have to happen to a recording before it belongs on the map:
//
//   Its bitrate has to come down. A capture card writes whatever it likes - the first clips
//   were 18 Mbps for seven seconds of a flat-shaded game - and at CRF 23 the same clip is a
//   third of the size with an SSIM of 0.986 against the original, which is not a difference
//   anyone can see.
//
//   Its index has to move to the front. Recorders leave `moov` at the end of the file, and
//   a browser cannot start playing until it has that, so without -movflags +faststart the
//   viewer waits for the whole download before the first frame.

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const MARKERS = fileURLToPath(new URL('../web/public/data/markers.json', import.meta.url));
const WORKER = fileURLToPath(new URL('../video-worker', import.meta.url));
const STAGING = fileURLToPath(new URL('../raw/clips', import.meta.url));

const BUCKET = 'fih-map-videos';
const SERVED_FROM = 'https://fih-map-videos.fih-map-editor-worker.workers.dev/';
const SOURCES = new Set(['.mp4', '.mov', '.mkv', '.webm', '.avi']);

const [folder, ...flags] = process.argv.slice(2);
const dry = flags.includes('--dry');
const write = flags.includes('--write');
const crf = Number(flags.find((f) => f.startsWith('--crf='))?.split('=')[1] ?? 23);

if (!folder) {
  console.error('Which folder? node tools/publish-clips.mjs "D:/videos/Speedruns" [--write] [--dry]');
  process.exit(1);
}

const ffmpeg = findFfmpeg();

/**
 * winget puts ffmpeg on the PATH but only for shells started afterwards, so the run right
 * after installing it would otherwise fail with nothing but "not found" to go on.
 */
function findFfmpeg() {
  const candidates = [
    'ffmpeg',
    join(
      process.env.LOCALAPPDATA ?? '',
      'Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-9.0-full_build/bin/ffmpeg.exe'
    ),
  ];

  for (const candidate of candidates) {
    try {
      execFileSync(candidate, ['-version'], { stdio: 'ignore' });
      return candidate;
    } catch {
      // try the next one
    }
  }

  console.error('No ffmpeg. Install it with:  winget install Gyan.FFmpeg');
  console.error('If you just installed it, open a new terminal - the PATH change only');
  console.error('reaches shells started afterwards.');
  process.exit(1);
}

const slug = (name) =>
  name
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

const mb = (bytes) => (bytes / 1048576).toFixed(2);

async function main() {
  const clips = readdirSync(folder)
    .filter((f) => SOURCES.has(extname(f).toLowerCase()))
    .sort();

  if (clips.length === 0) {
    console.log(`Nothing to publish: no video files in ${folder}`);
    return;
  }

  const data = JSON.parse(readFileSync(MARKERS, 'utf8'));
  mkdirSync(STAGING, { recursive: true });

  const done = [];
  let before = 0;
  let after = 0;

  for (const clip of clips) {
    const source = join(folder, clip);
    const key = `${slug(basename(clip, extname(clip)))}.mp4`;
    const out = join(STAGING, key);

    const wasBytes = statSync(source).size;
    before += wasBytes;

    if (dry) {
      console.log(`${clip}  ->  ${key}  (${mb(wasBytes)} MB, would re-encode and upload)`);
      done.push({ clip, key, marker: match(data.markers, clip) });
      continue;
    }

    process.stdout.write(`${clip}: encoding… `);
    execFileSync(
      ffmpeg,
      [
        '-y', '-loglevel', 'error',
        '-i', source,
        '-c:v', 'libx264', '-preset', 'slow', '-crf', String(crf),
        // Some captures come out in a pixel format Safari will not touch. This is the one
        // every browser plays.
        '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '96k',
        '-movflags', '+faststart',
        out,
      ],
      { stdio: ['ignore', 'ignore', 'inherit'] }
    );

    const nowBytes = statSync(out).size;
    after += nowBytes;

    process.stdout.write(`${mb(wasBytes)} -> ${mb(nowBytes)} MB, uploading… `);
    // Quoted because npx has to go through a shell on Windows and the checkout lives in a
    // folder with a space in its name, which the shell would otherwise split in two.
    execFileSync(
      'npx',
      ['wrangler', 'r2', 'object', 'put', `${BUCKET}/${key}`, '--file', `"${out}"`, '--content-type', 'video/mp4', '--remote'],
      { cwd: WORKER, stdio: ['ignore', 'ignore', 'inherit'], shell: true }
    );
    console.log('done');

    done.push({ clip, key, marker: match(data.markers, clip) });
  }

  if (!dry) {
    console.log(`\n${done.length} clips, ${mb(before)} MB in, ${mb(after)} MB out (${(before / after).toFixed(1)}x smaller)`);
    rmSync(STAGING, { recursive: true, force: true });
  }

  report(data, done);
}

/**
 * The marker a clip belongs to, or null.
 *
 * A file named after a marker's id is taken at its word. Otherwise the name has to slugify
 * to exactly one marker name - "Alt Gap Jump.mp4" finds its marker, "Alt Gap.mp4" does not,
 * and guessing at near misses is how a clip ends up silently on the wrong skip.
 */
function match(markers, clip) {
  const name = slug(basename(clip, extname(clip)));

  const byId = markers.find((m) => m.id === name);
  if (byId) return byId;

  const byName = markers.filter((m) => slug(m.name) === name);
  return byName.length === 1 ? byName[0] : null;
}

function report(data, done) {
  const matched = done.filter((d) => d.marker);
  const missed = done.filter((d) => !d.marker);

  if (matched.length) {
    console.log(`\nMatched to a marker:`);
    for (const { key, marker } of matched) console.log(`  ${marker.id.padEnd(20)} ${marker.name.trim()}  <-  ${key}`);
  }

  if (missed.length) {
    console.log(`\nNo marker of that name - set the video by hand in the editor:`);
    for (const { clip, key } of missed) console.log(`  ${clip}  ->  ${SERVED_FROM}${key}`);
  }

  if (!write || dry) {
    if (matched.length) console.log(`\nRun again with --write to put these URLs in markers.json.`);
    return;
  }

  let changed = 0;
  for (const { key, marker } of matched) {
    const url = SERVED_FROM + key;
    if (marker.video === url) continue;
    marker.video = url;
    changed++;
  }

  writeFileSync(MARKERS, `${JSON.stringify(data, null, 2)}\n`);
  console.log(`\n${changed} marker${changed === 1 ? '' : 's'} updated in markers.json. Commit it, or press Save in the editor.`);
}

if (!existsSync(folder)) {
  console.error(`No such folder: ${folder}`);
  process.exit(1);
}

await main();
