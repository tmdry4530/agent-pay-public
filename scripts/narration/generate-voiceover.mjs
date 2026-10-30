#!/usr/bin/env node
// Generate one ElevenLabs clip per cue from docs/submission/voiceover.md.
// Cue lines look like "> @<anchorSeconds> <text>" under "### S<n> ..." headings; cue ids are S<n>.<k>.
// Writes <outDir>/<cueId>.mp3 and <outDir>/cues.json (id, scene, anchor, text) for mux-voiceover.mjs.
// The API key is read only from ELEVENLABS_API_KEY and is never printed or written.
// Usage: node scripts/narration/generate-voiceover.mjs <outDir> [S1 | S1.2 ...]
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const VOICE_ID = process.env.VOICE_ID || 'cjVigY5qzO86Huf0OWal'; // Eric (premade)
const MODEL_ID = process.env.MODEL_ID || 'eleven_multilingual_v2';
const SPEED = Number(process.env.VOICE_SPEED || '0.92');
const key = process.env.ELEVENLABS_API_KEY;
if (!key) {
  console.error('error: ELEVENLABS_API_KEY is not set');
  process.exit(1);
}

const outDir = process.argv[2];
if (!outDir) {
  console.error('usage: generate-voiceover.mjs <outDir> [S1 | S1.2 ...]');
  process.exit(1);
}
const only = new Set(process.argv.slice(3));

/** Parse "### S<n> ..." headings and the "> @<anchor> <text>" cue lines under each. */
export function parseVoiceover(md) {
  const cues = [];
  let scene = null;
  let k = 0;
  for (const line of md.split('\n')) {
    const h = /^### (S\d+)\b/.exec(line);
    if (h) {
      scene = h[1];
      k = 0;
      continue;
    }
    const c = /^>\s?@(\d+(?:\.\d+)?)\s+(.+)$/.exec(line);
    if (scene && c) {
      k += 1;
      cues.push({ id: `${scene}.${k}`, scene, anchor: Number(c[1]), text: c[2].trim() });
    }
  }
  return cues;
}

const cues = parseVoiceover(
  fs.readFileSync(path.join(repoRoot, 'docs', 'submission', 'voiceover.md'), 'utf8'),
);
fs.mkdirSync(outDir, { recursive: true });
fs.writeFileSync(path.join(outDir, 'cues.json'), JSON.stringify(cues, null, 2) + '\n');

let chars = 0;
for (const s of cues) {
  if (only.size && !only.has(s.id) && !only.has(s.scene)) continue;
  const res = await fetch(
    `https://api.elevenlabs.io/v1/text-to-speech/${VOICE_ID}?output_format=mp3_44100_128`,
    {
      method: 'POST',
      headers: { 'xi-api-key': key, 'content-type': 'application/json', accept: 'audio/mpeg' },
      body: JSON.stringify({
        text: s.text,
        model_id: MODEL_ID,
        voice_settings: { stability: 0.5, similarity_boost: 0.75, style: 0.15, use_speaker_boost: true, speed: SPEED },
      }),
    },
  );
  if (!res.ok) {
    console.error(`${s.id}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
    process.exit(1);
  }
  const buf = Buffer.from(await res.arrayBuffer());
  fs.writeFileSync(path.join(outDir, `${s.id}.mp3`), buf);
  chars += s.text.length;
  const words = s.text.split(' ').length;
  console.log(`${s.id}: ${words} words, ${s.text.length} chars -> ${s.id}.mp3 (${buf.length} bytes)`);
}
console.log(`total chars sent: ${chars}`);
