// Build Eli's mumble sprite from voice-acted recordings.
//
// Slices syllable-sized chunks (~130ms) out of real voice lines and packs
// them into one small WAV + JSON manifest. The game plays these instead of
// synthesized formants, so the mumble keeps the actor's human timbre.
//
// Usage:
//   node build-mumble-sprite.mjs <voice1.mp3> [voice2.mp3 ...]
// Output:
//   public/audio/mumble/eli-mumble.wav   (audio sprite, mono 22050 Hz)
//   public/audio/mumble/eli-mumble.json  (chunk offsets + hiss/voiced class)
//
// Re-run whenever you record new voice lines you want the mumble to draw from.

import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const OUT_DIR   = join(__dirname, 'public', 'audio', 'mumble');
const SR        = 22050;   // sprite sample rate — plenty for voice, half the size
const FRAME     = Math.round(SR * 0.010);   // 10 ms analysis frames
const CHUNK_S   = 0.130;   // target chunk length (seconds)
const CHUNK_MIN = 0.090;
const FADE_S    = 0.008;
const MAX_CHUNKS = 28;

const inputs = process.argv.slice(2);
if (!inputs.length) {
  console.error('Usage: node build-mumble-sprite.mjs <voice1.mp3> [voice2.mp3 ...]');
  process.exit(1);
}

// ─── WAV helpers ──────────────────────────────────────────────────────────────

function decodeToPcm(file) {
  const tmp = join(tmpdir(), `mumble-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`);
  const r = spawnSync('afconvert', ['-f', 'WAVE', '-d', `LEI16@${SR}`, '-c', '1', file, tmp]);
  if (r.status !== 0) throw new Error(`afconvert failed for ${file}: ${r.stderr}`);
  const buf = readFileSync(tmp);
  rmSync(tmp, { force: true });
  // Locate the data chunk (header layout can vary)
  let off = 12;
  while (off < buf.length - 8) {
    const id   = buf.toString('ascii', off, off + 4);
    const size = buf.readUInt32LE(off + 4);
    if (id === 'data') {
      const n = Math.floor(size / 2);
      const pcm = new Float32Array(n);
      for (let i = 0; i < n; i++) pcm[i] = buf.readInt16LE(off + 8 + i * 2) / 32768;
      return pcm;
    }
    off += 8 + size + (size % 2);
  }
  throw new Error(`No data chunk in ${file}`);
}

function writeWav(path, samples) {
  const buf = Buffer.alloc(44 + samples.length * 2);
  buf.write('RIFF', 0); buf.writeUInt32LE(36 + samples.length * 2, 4); buf.write('WAVE', 8);
  buf.write('fmt ', 12); buf.writeUInt32LE(16, 16); buf.writeUInt16LE(1, 20); buf.writeUInt16LE(1, 22);
  buf.writeUInt32LE(SR, 24); buf.writeUInt32LE(SR * 2, 28); buf.writeUInt16LE(2, 32); buf.writeUInt16LE(16, 34);
  buf.write('data', 36); buf.writeUInt32LE(samples.length * 2, 40);
  for (let i = 0; i < samples.length; i++) {
    buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  }
  writeFileSync(path, buf);
}

// ─── Syllable detection ───────────────────────────────────────────────────────

function findChunks(pcm, sourceName) {
  const frames = Math.floor(pcm.length / FRAME);
  const rms = new Float32Array(frames);
  for (let f = 0; f < frames; f++) {
    let sum = 0;
    for (let i = f * FRAME; i < (f + 1) * FRAME; i++) sum += pcm[i] * pcm[i];
    rms[f] = Math.sqrt(sum / FRAME);
  }
  const sorted = [...rms].sort((a, b) => a - b);
  const p95    = sorted[Math.floor(sorted.length * 0.95)] || 0;
  const thresh = p95 * 0.25;

  // Contiguous voiced runs, then energy peaks within them ≥170 ms apart
  const chunks = [];
  let runStart = -1;
  for (let f = 0; f <= frames; f++) {
    const voiced = f < frames && rms[f] > thresh;
    if (voiced && runStart < 0) runStart = f;
    if (!voiced && runStart >= 0) {
      const runLen = f - runStart;
      if (runLen * 0.010 >= CHUNK_MIN) {
        let lastPeak = -Infinity;
        for (let p = runStart; p < f; p++) {
          const isPeak = rms[p] >= rms[Math.max(runStart, p - 1)] && rms[p] >= rms[Math.min(f - 1, p + 1)];
          if (isPeak && rms[p] > thresh * 1.6 && (p - lastPeak) * 0.010 >= 0.170) {
            lastPeak = p;
            const half   = Math.round((CHUNK_S / 2) * SR);
            const center = Math.round((p + 0.5) * FRAME);
            const start  = Math.max(0, center - half);
            const end    = Math.min(pcm.length, center + half);
            if ((end - start) / SR >= CHUNK_MIN) {
              chunks.push({ start, end, energy: rms[p], sourceName });
            }
          }
        }
      }
      runStart = -1;
    }
  }
  return chunks;
}

function zeroCrossingRate(pcm, start, end) {
  let z = 0;
  for (let i = start + 1; i < end; i++) if ((pcm[i] >= 0) !== (pcm[i - 1] >= 0)) z++;
  return z / (end - start);
}

// ─── Build ────────────────────────────────────────────────────────────────────

const all = [];
for (const file of inputs) {
  const pcm = decodeToPcm(file);
  const found = findChunks(pcm, basename(file));
  for (const c of found) all.push({ ...c, pcm });
  console.log(`${basename(file)}: ${found.length} candidate syllables`);
}
if (!all.length) { console.error('No syllables found — are the files silent?'); process.exit(1); }

// Round-robin across source files (ordered by energy within each) for variety
const byFile = new Map();
for (const c of all.sort((a, b) => b.energy - a.energy)) {
  if (!byFile.has(c.sourceName)) byFile.set(c.sourceName, []);
  byFile.get(c.sourceName).push(c);
}
const picked = [];
const lists  = [...byFile.values()];
for (let round = 0; picked.length < MAX_CHUNKS; round++) {
  let any = false;
  for (const list of lists) {
    if (list[round]) { picked.push(list[round]); any = true; }
    if (picked.length >= MAX_CHUNKS) break;
  }
  if (!any) break;
}

// Pack: normalize each chunk, cosine fades, concatenate
const fadeN = Math.round(FADE_S * SR);
const sprite = [];
const manifest = [];
for (const c of picked) {
  const seg = c.pcm.slice(c.start, c.end);
  let peak = 0;
  for (const s of seg) peak = Math.max(peak, Math.abs(s));
  const norm = peak > 0 ? 0.7 / peak : 1;
  for (let i = 0; i < seg.length; i++) {
    let g = norm;
    if (i < fadeN)              g *= 0.5 - 0.5 * Math.cos(Math.PI * i / fadeN);
    if (i >= seg.length - fadeN) g *= 0.5 - 0.5 * Math.cos(Math.PI * (seg.length - i) / fadeN);
    seg[i] *= g;
  }
  const zcr = zeroCrossingRate(c.pcm, c.start, c.end);
  manifest.push({
    start: sprite.length / SR,
    dur:   seg.length / SR,
    kind:  zcr > 0.22 ? 'hiss' : 'voiced',
  });
  for (const s of seg) sprite.push(s);
}

mkdirSync(OUT_DIR, { recursive: true });
writeWav(join(OUT_DIR, 'eli-mumble.wav'), Float32Array.from(sprite));
writeFileSync(join(OUT_DIR, 'eli-mumble.json'), JSON.stringify({ sampleRate: SR, chunks: manifest }, null, 2));

const voiced = manifest.filter(c => c.kind === 'voiced').length;
console.log(`\nSprite: ${manifest.length} chunks (${voiced} voiced, ${manifest.length - voiced} hiss), ` +
  `${(sprite.length / SR).toFixed(1)}s, ${Math.round((44 + sprite.length * 2) / 1024)} KB`);
console.log(`→ ${join(OUT_DIR, 'eli-mumble.wav')}`);
console.log(`→ ${join(OUT_DIR, 'eli-mumble.json')}`);
