#!/usr/bin/env node
// Place per-cue narration clips (from generate-voiceover.mjs) on the video timeline and mux them with the
// submission video. The video stream is copied, not re-encoded.
//
// Placement: each clip is shifted so its speech onset (leading silence skipped) lands on the cue anchor, or
// GAP seconds after the previous cue's speech ends if that is later. The script fails if any scene's speech
// would end less than MIN_TAIL seconds before the next scene starts.
// Loudness: two-pass linear loudnorm to -16 LUFS (measured on the opus file) with a true-peak ceiling (TP), so the opus file stays
// at or below -1.5 dBTP.
//
// Usage: node scripts/narration/mux-voiceover.mjs <clipDir> [video.webm] [placement.json]
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';

const SCENE_STARTS = { S1: 0, S2: 20, S3: 45, S4: 65, S5: 90, S6: 110, S7: 130, S8: 150 }; // video-script.md
const TOTAL = 170;
const GAP = 0.35;
const MIN_TAIL = 1.0;
const TP = Number(process.env.TRUE_PEAK || '-2.5');
// loudnorm target; the opus file measures about 0.2 LU below it, so -15.8 lands on -16 LUFS.
const LUFS = Number(process.env.LUFS || '-15.8');

const [clipDir, video = 'docs/demo/agent-pay-submission.webm', placementOut] = process.argv.slice(2);
if (!clipDir) {
  console.error('usage: mux-voiceover.mjs <clipDir> [video.webm] [placement.json]');
  process.exit(1);
}
const cues = JSON.parse(fs.readFileSync(path.join(clipDir, 'cues.json'), 'utf8'));

/** Run ffmpeg and return its stderr (where filters log). */
function ffmpeg(args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-nostats', ...args], { encoding: 'utf8', maxBuffer: 64 << 20 });
  if (r.status !== 0) throw new Error(r.stderr.slice(-2000));
  return r.stderr;
}

const duration = (f) =>
  Number(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf8' }));

/** Leading and trailing silence of a clip (below -45 dB). */
function speechBounds(f) {
  const dur = duration(f);
  const log = ffmpeg(['-i', f, '-af', 'silencedetect=n=-45dB:d=0.05', '-f', 'null', '-']);
  const starts = [...log.matchAll(/silence_start: (-?[\d.]+)/g)].map((m) => Number(m[1]));
  const ends = [...log.matchAll(/silence_end: ([\d.]+)/g)].map((m) => Number(m[1]));
  const lead = starts.length && starts[0] <= 0.01 && ends.length ? ends[0] : 0;
  // Trailing silence either runs to the end, or is followed only by a short blip (< 0.2 s) before the end.
  const lastStart = starts.length ? starts[starts.length - 1] : dur;
  const lastEnd = starts.length > ends.length ? dur : ends[ends.length - 1];
  const speechEnd = starts.length && dur - lastEnd < 0.2 && lastStart > lead ? lastStart : dur;
  return { dur, lead, speechEnd };
}

const sceneIds = Object.keys(SCENE_STARTS);
const placed = [];
let prevEnd = -Infinity;
for (const c of cues) {
  const f = path.join(clipDir, `${c.id}.mp3`);
  const b = speechBounds(f);
  const speechStart = Math.max(c.anchor, prevEnd + GAP);
  const clipStart = speechStart - b.lead;
  const speechEnd = clipStart + b.speechEnd;
  placed.push({ ...c, file: f, clipStart: +clipStart.toFixed(3), speechStart: +speechStart.toFixed(3), speechEnd: +speechEnd.toFixed(3) });
  prevEnd = speechEnd;
}
let bad = false;
for (const s of sceneIds) {
  const i = sceneIds.indexOf(s);
  const limit = (i + 1 < sceneIds.length ? SCENE_STARTS[sceneIds[i + 1]] : TOTAL) - MIN_TAIL;
  const pc = placed.filter((p) => p.scene === s);
  if (!pc.length) continue;
  const first = pc[0].speechStart;
  const last = pc[pc.length - 1].speechEnd;
  const ok = first >= SCENE_STARTS[s] && last <= limit;
  if (!ok) bad = true;
  console.log(`${s}: speech ${first.toFixed(2)}–${last.toFixed(2)} s (limit ${limit}) ${ok ? 'ok' : 'OVERRUN'}`);
  for (const p of pc) console.log(`  ${p.id} @${p.anchor} -> ${p.speechStart.toFixed(2)}–${p.speechEnd.toFixed(2)}`);
}
if (bad) {
  console.error('error: a scene overruns; shorten or speed up a cue');
  process.exit(1);
}
if (placementOut) fs.writeFileSync(placementOut, JSON.stringify(placed, null, 2) + '\n');

const inputs = placed.flatMap((p) => ['-i', p.file]);
let mix = '';
placed.forEach((p, i) => {
  mix += `[${i + 1}:a]aresample=48000,aformat=channel_layouts=mono,adelay=${Math.round(p.clipStart * 1000)}:all=1[a${i}];`;
});
mix += placed.map((_, i) => `[a${i}]`).join('') + `amix=inputs=${placed.length}:normalize=0:dropout_transition=0,`;
mix += `apad=whole_dur=${TOTAL},atrim=0:${TOTAL},asetpts=N/SR/TB`;

// Pass 1: measure.
const log1 = ffmpeg(['-i', video, ...inputs, '-filter_complex', `${mix},loudnorm=I=${LUFS}:TP=${TP}:LRA=11:print_format=json[aout]`, '-map', '[aout]', '-f', 'null', '-']);
const m = JSON.parse(log1.slice(log1.lastIndexOf('{'), log1.lastIndexOf('}') + 1));
const ln = `loudnorm=I=${LUFS}:TP=${TP}:LRA=11:linear=true:measured_I=${m.input_i}:measured_TP=${m.input_tp}:measured_LRA=${m.input_lra}:measured_thresh=${m.input_thresh}:offset=${m.target_offset}`;

// Pass 2: normalize and mux.
const tmp = path.join(os.tmpdir(), `vo-${process.pid}.webm`);
ffmpeg([
  '-y', '-i', video, ...inputs,
  '-filter_complex', `${mix},${ln},aresample=48000,atrim=0:${TOTAL}[aout]`,
  '-map', '0:v:0', '-map', '[aout]', '-c:v', 'copy', '-c:a', 'libopus', '-b:a', '96k', '-ac', '1', '-t', String(TOTAL), tmp,
]);
fs.copyFileSync(tmp, video);
fs.unlinkSync(tmp);
fs.chmodSync(video, 0o644);
console.log(execFileSync('ffprobe', ['-v', 'error', '-show_entries', 'stream=index,codec_type,codec_name,channels,sample_rate', '-show_entries', 'format=duration,size', '-of', 'compact', video], { encoding: 'utf8' }));
