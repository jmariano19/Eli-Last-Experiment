import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, rm, rename, copyFile, cp, stat } from 'node:fs/promises';
import { extname, join, normalize, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync, createReadStream, watch as fsWatch } from 'node:fs';
import { networkInterfaces, tmpdir } from 'node:os';
import { spawn } from 'node:child_process';

const root = fileURLToPath(new URL('.', import.meta.url));
const port = Number(process.env.PORT || 4179);

// Load .env
const envPath = join(root, '.env');
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"]*)"?\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2];
  }
}

// Bump when the editor/server API contract changes — the editor refuses to
// run against a mismatched server instead of failing in confusing ways.
const API_VERSION = 7;

const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
const chatModel    = process.env.CHAT_MODEL || 'claude-sonnet-4-6';
const deployWebhook = process.env.DEPLOY_WEBHOOK || 'http://85.209.95.19:3000/api/deploy/d13cf664e5531b01e81dd96edb4f73a96ad3c06663735995';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.riv':  'application/octet-stream',
  '.mp3':  'audio/mpeg',
  '.m4a':  'audio/mp4',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.mov':  'video/quicktime',
  '.m4v':  'video/mp4',
  '.ogv':  'video/ogg',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif':  'image/gif',
};

const MEDIA_EXTS = new Set(['.riv', '.mp3', '.m4a', '.wav', '.ogg', '.opus', '.mp4', '.webm', '.mov', '.m4v', '.ogv', '.svg', '.png', '.jpg', '.jpeg', '.webp', '.gif']);

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return Buffer.concat(chunks);
}

async function readJsonBody(req) {
  try { return JSON.parse((await readRawBody(req)).toString('utf8')); } catch { return {}; }
}

function cleanFilename(value) {
  return basename(String(value || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
}

// Keep the last 10 versions of a file in a sibling .backups/ folder so a bad
// save can always be rolled back.
async function backupFile(path) {
  if (!existsSync(path)) return;
  const dir = join(dirname(path), '.backups');
  await mkdir(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  await copyFile(path, join(dir, `${basename(path)}.${stamp}.bak`));
  const siblings = (await readdir(dir)).filter(f => f.startsWith(basename(path))).sort();
  while (siblings.length > 10) await rm(join(dir, siblings.shift()), { force: true });
}

function slugify(str) {
  return String(str).toLowerCase().trim().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'scene';
}

function cleanId(str) {
  return String(str || '').replace(/[^a-z0-9_-]/gi, '').slice(0, 64);
}

function cleanString(value) {
  return typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
}

function getLanUrls() {
  const urls = [];
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (entry.address.startsWith('169.254.')) continue;   // link-local, unreachable from phones
      urls.push(`http://${entry.address}:${port}`);
    }
  }
  // Real home-WiFi addresses first — VPN/virtual interfaces (utun, Docker…)
  // often come first in interface order but phones can't reach them.
  const rank = (u) => u.includes('//192.168.') ? 0 : u.includes('//10.') ? 1 : 2;
  return urls.sort((a, b) => rank(a) - rank(b));
}

// ─── Games layout ─────────────────────────────────────────────────────────────
// Each game lives in games/<id>/ with its own sequence.json, scenes/ and data/.
// A legacy single-game layout (sequence.json + scenes/ at the repo root) is
// migrated into games/main/ automatically on boot.

const gamesRoot     = join(root, 'games');
const gamesMetaPath = join(gamesRoot, 'games.json');

function gameDir(game) {
  return join(gamesRoot, cleanId(game) || 'main');
}

async function readGamesMeta() {
  try { return JSON.parse(await readFile(gamesMetaPath, 'utf8')); }
  catch { return { default: 'main' }; }
}

async function writeGamesMeta(meta) {
  await mkdir(gamesRoot, { recursive: true });
  await writeFile(gamesMetaPath, JSON.stringify(meta, null, 2), 'utf8');
}

async function listGameIds() {
  try {
    const entries = await readdir(gamesRoot, { withFileTypes: true });
    return entries.filter(e => e.isDirectory() && !e.name.startsWith('.')).map(e => e.name);
  } catch { return []; }
}

async function resolveGame(explicit) {
  const g = cleanId(explicit || '');
  if (g) return g;
  return cleanId((await readGamesMeta()).default) || 'main';
}

async function ensureGamesLayout() {
  await mkdir(gamesRoot, { recursive: true });
  const legacySeq    = join(root, 'sequence.json');
  const legacyScenes = join(root, 'scenes');
  const legacyData   = join(root, 'data');
  const mainDir      = join(gamesRoot, 'main');
  if ((existsSync(legacySeq) || existsSync(legacyScenes)) && !existsSync(mainDir)) {
    await mkdir(mainDir, { recursive: true });
    if (existsSync(legacySeq))    await rename(legacySeq,    join(mainDir, 'sequence.json'));
    if (existsSync(legacyScenes)) await rename(legacyScenes, join(mainDir, 'scenes'));
    if (existsSync(legacyData))   await rename(legacyData,   join(mainDir, 'data'));
    console.log('  Migrated single-game layout into games/main/');
  }
  if (!existsSync(gamesMetaPath)) await writeGamesMeta({ default: 'main' });
}

// ─── Static files ─────────────────────────────────────────────────────────────

async function serveStatic(req, res) {
  let urlPath = new URL(req.url, 'http://x').pathname;
  // Browsers percent-encode paths (spaces → %20). Decode so files with spaces
  // in their names (e.g. public/Video/Final/losing voice.mp4) resolve — the
  // traversal guard below re-checks the decoded path.
  try { urlPath = decodeURIComponent(urlPath); } catch { sendText(res, 400, 'Bad request'); return; }
  if (urlPath === '/' || urlPath === '/game') urlPath = '/index.html';
  if (urlPath === '/editor')                  urlPath = '/editor.html';

  // Legacy single-game URLs — serve from the default game's folder so the
  // deployed player keeps working without a ?game= param.
  if (urlPath === '/sequence.json' || urlPath.startsWith('/scenes/')) {
    const meta = await readGamesMeta();
    urlPath = `/games/${cleanId(meta.default) || 'main'}${urlPath}`;
  }

  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(root, safe);
  if (!filePath.startsWith(root)) { sendText(res, 403, 'Forbidden'); return; }

  try {
    const info = await stat(filePath);
    if (!info.isFile()) { sendText(res, 404, 'Not found'); return; }
    const ext  = extname(filePath).toLowerCase();
    // Media can be cached briefly (game prefetch relies on this); HTML/JS/JSON
    // stay no-store so edits and publishes always show up immediately.
    const cacheControl = MEDIA_EXTS.has(ext) ? 'public, max-age=600' : 'no-store';
    const headers = {
      'Content-Type': mime[ext] || 'application/octet-stream',
      'Cache-Control': cacheControl,
      'Access-Control-Allow-Origin': '*',
      'Accept-Ranges': 'bytes',
    };

    // Range support — lets <audio>/<video> seek instantly (lip-sync scrubbing,
    // video scenes) instead of re-downloading the whole file to reach a spot.
    const range = req.headers.range && /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (range && (range[1] || range[2])) {
      let start = range[1] ? parseInt(range[1], 10) : Math.max(0, info.size - parseInt(range[2], 10));
      let end   = range[1] && range[2] ? Math.min(parseInt(range[2], 10), info.size - 1) : info.size - 1;
      if (!(start >= 0 && start <= end && end < info.size)) {
        res.writeHead(416, { 'Content-Range': `bytes */${info.size}` });
        res.end();
        return;
      }
      res.writeHead(206, { ...headers, 'Content-Range': `bytes ${start}-${end}/${info.size}`, 'Content-Length': end - start + 1 });
      createReadStream(filePath, { start, end }).pipe(res);
      return;
    }

    // Stream instead of buffering — large videos no longer sit in memory.
    res.writeHead(200, { ...headers, 'Content-Length': info.size });
    createReadStream(filePath).pipe(res);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

// ─── Games API ────────────────────────────────────────────────────────────────

async function listGames(res) {
  const ids  = await listGameIds();
  const meta = await readGamesMeta();
  const games = [];
  for (const id of ids) {
    let title = id;
    try { title = JSON.parse(await readFile(join(gamesRoot, id, 'sequence.json'), 'utf8')).title || id; } catch {}
    games.push({ id, title });
  }
  sendJson(res, 200, { games, default: cleanId(meta.default) || 'main' });
}

async function createGame(req, res) {
  const body  = await readJsonBody(req);
  const title = String(body.title || 'New Game').slice(0, 64);
  let id = slugify(title) || `game_${Date.now()}`;
  if (existsSync(join(gamesRoot, id))) {
    let n = 2;
    while (existsSync(join(gamesRoot, `${id}_${n}`))) n++;
    id = `${id}_${n}`;
  }
  await mkdir(join(gamesRoot, id, 'scenes'), { recursive: true });
  await writeFile(join(gamesRoot, id, 'sequence.json'),
    JSON.stringify({ version: '1', title, start: null, scenes: [] }, null, 2), 'utf8');
  sendJson(res, 200, { ok: true, id, title });
}

async function setDefaultGame(req, res) {
  const body = await readJsonBody(req);
  const id   = cleanId(body.id || '');
  if (!id || !existsSync(join(gamesRoot, id))) { sendJson(res, 400, { error: 'unknown game' }); return; }
  const meta = await readGamesMeta();
  meta.default = id;
  await writeGamesMeta(meta);
  sendJson(res, 200, { ok: true, default: id });
}

async function deleteGame(req, res) {
  const body = await readJsonBody(req);
  const id   = cleanId(body.id || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  const ids = (await listGameIds()).filter(g => g !== '.trash');
  if (ids.length <= 1) { sendJson(res, 400, { error: 'cannot delete the last game' }); return; }
  if (!existsSync(join(gamesRoot, id))) { sendJson(res, 404, { error: 'game not found' }); return; }
  // Soft delete: move to games/.trash/<id>-<timestamp> instead of destroying data
  const trashDir = join(gamesRoot, '.trash');
  await mkdir(trashDir, { recursive: true });
  await rename(join(gamesRoot, id), join(trashDir, `${id}-${Date.now()}`));
  const meta = await readGamesMeta();
  if (cleanId(meta.default) === id) {
    meta.default = (await listGameIds())[0] || 'main';
    await writeGamesMeta(meta);
  }
  sendJson(res, 200, { ok: true });
}

// ─── Sequence ─────────────────────────────────────────────────────────────────

async function getSequence(req, res, url) {
  const game = await resolveGame(url.searchParams.get('game'));
  try {
    sendJson(res, 200, JSON.parse(await readFile(join(gameDir(game), 'sequence.json'), 'utf8')));
  } catch {
    sendJson(res, 200, { version: '1', title: game, start: null, scenes: [] });
  }
}

async function saveSequence(req, res) {
  const body = await readJsonBody(req);
  const game = await resolveGame(body.game);
  delete body.game;
  await mkdir(gameDir(game), { recursive: true });
  await writeFile(join(gameDir(game), 'sequence.json'), JSON.stringify(body, null, 2), 'utf8');
  sendJson(res, 200, { ok: true });
}

// ─── Scenes ───────────────────────────────────────────────────────────────────

async function listScenes(req, res, url) {
  const game = await resolveGame(url.searchParams.get('game'));
  try {
    const entries = await readdir(join(gameDir(game), 'scenes'), { withFileTypes: true });
    sendJson(res, 200, { scenes: entries.filter(e => e.isDirectory()).map(e => e.name) });
  } catch { sendJson(res, 200, { scenes: [] }); }
}

// All scene configs in one response — the editor uses this instead of one
// request per scene, so games with many scenes load the sidebar instantly.
async function listScenesFull(req, res, url) {
  const game = await resolveGame(url.searchParams.get('game'));
  try {
    const dir = join(gameDir(game), 'scenes');
    const entries = await readdir(dir, { withFileTypes: true });
    const scenes = [];
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      try { scenes.push(JSON.parse(await readFile(join(dir, e.name, 'scene.json'), 'utf8'))); } catch {}
    }
    sendJson(res, 200, { scenes });
  } catch { sendJson(res, 200, { scenes: [] }); }
}

async function createScene(req, res) {
  const body  = await readJsonBody(req);
  const game  = await resolveGame(body.game);
  const title = String(body.title || 'New Scene').slice(0, 64);
  const type  = ['rive', 'video', 'chat', 'pairs', 'jigsaw', 'thread', 'words'].includes(body.type) ? body.type : 'rive';
  const scenesDir = join(gameDir(game), 'scenes');
  let id = slugify(title) || `scene_${Date.now()}`;
  if (existsSync(join(scenesDir, id))) {
    let n = 2;
    while (existsSync(join(scenesDir, `${id}_${n}`))) n++;
    id = `${id}_${n}`;
  }

  await mkdir(join(scenesDir, id, 'audio'), { recursive: true });

  const config = {
    id, title, type,
    rive: (type === 'video' || type === 'pairs' || type === 'jigsaw' || type === 'thread' || type === 'words') ? null : 'shared',
    files: {},
    system_prompt: type === 'chat' ? "You are Eli. A British boy who's been sick for a long time." : undefined,
    pairs: type === 'pairs' ? { count: 6, fragment: '', intro: 'Help him remember...', winText: 'I remember...', daily: false } : undefined,
    jigsaw: type === 'jigsaw' ? { pieces: 9, fragment: '', intro: 'Put it back together...', winText: 'I remember this...', daily: false } : undefined,
    thread: type === 'thread' ? {
      intro: 'Some things still belong together.',
      foundText: 'this is the part you kept.',
      carryText: 'take it back to him.',
      paths: [
        { id: 'care', title: 'Someone came back', nodes: ['wet shoes', 'the door', 'her voice'], fragment: 'someone_was_there', signal: 'caution' },
        { id: 'experiment', title: 'The bright room', nodes: ['cold floor', 'bright light', 'an alarm'], fragment: 'bright_light', signal: 'risk' },
      ],
    } : undefined,
    words: type === 'words' ? {
      intro: 'His memories are hiding in the letters.',
      letters: 'MOTHER',
      fragment: 'someone_was_there',
      foundText: 'you found the word he could not say.',
      carryText: 'take it back to him.',
      memories: [
        { word: 'HOME', reveal: 'wet shoes beside the door' },
        { word: 'OTHER', reveal: 'a voice in the next room' },
        { word: 'MOTHER', reveal: 'someone saying his name softly' }
      ]
    } : undefined,
    after: { trigger: type === 'rive' ? 'tap_heart' : (type === 'video' || type === 'pairs' || type === 'jigsaw' || type === 'thread' || type === 'words') ? 'ended' : 'never', message: '', next: null },
  };
  await writeFile(join(scenesDir, id, 'scene.json'), JSON.stringify(config, null, 2), 'utf8');

  // Add to sequence
  const seqPath = join(gameDir(game), 'sequence.json');
  let seq = { version: '1', title: game, start: null, scenes: [] };
  try { seq = JSON.parse(await readFile(seqPath, 'utf8')); } catch {}
  if (!seq.scenes.includes(id)) seq.scenes.push(id);
  if (!seq.start) seq.start = id;
  await writeFile(seqPath, JSON.stringify(seq, null, 2), 'utf8');

  sendJson(res, 200, { ok: true, id, config });
}

async function getScene(req, res, url) {
  const game = await resolveGame(url.searchParams.get('game'));
  const id = cleanId(url.searchParams.get('id') || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  try {
    sendJson(res, 200, JSON.parse(await readFile(join(gameDir(game), 'scenes', id, 'scene.json'), 'utf8')));
  } catch { sendJson(res, 404, { error: 'not found' }); }
}

async function saveScene(req, res) {
  const body = await readJsonBody(req);
  const game = await resolveGame(body.game);
  delete body.game;
  const id = cleanId(body.id || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  await mkdir(join(gameDir(game), 'scenes', id, 'audio'), { recursive: true });
  const scenePath = join(gameDir(game), 'scenes', id, 'scene.json');
  await backupFile(scenePath);
  await writeFile(scenePath, JSON.stringify(body, null, 2), 'utf8');
  sendJson(res, 200, { ok: true });
}

// List a scene's saved versions (newest first)
async function listSceneBackups(req, res, url) {
  const game = await resolveGame(url.searchParams.get('game'));
  const id   = cleanId(url.searchParams.get('id') || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  try {
    const dir = join(gameDir(game), 'scenes', id, '.backups');
    const files = (await readdir(dir)).filter(f => f.startsWith('scene.json')).sort().reverse();
    sendJson(res, 200, { backups: files });
  } catch { sendJson(res, 200, { backups: [] }); }
}

// Restore a backup (latest by default) — the current version is backed up first
async function restoreSceneBackup(req, res) {
  const body = await readJsonBody(req);
  const game = await resolveGame(body.game);
  const id   = cleanId(body.id || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  const dir = join(gameDir(game), 'scenes', id, '.backups');
  let file = basename(String(body.file || ''));
  if (!file) {
    try { file = (await readdir(dir)).filter(f => f.startsWith('scene.json')).sort().reverse()[0] || ''; }
    catch {}
  }
  if (!file || !existsSync(join(dir, file))) { sendJson(res, 404, { error: 'no backups yet' }); return; }
  const scenePath = join(gameDir(game), 'scenes', id, 'scene.json');
  await backupFile(scenePath);
  await copyFile(join(dir, file), scenePath);
  let config = {};
  try { config = JSON.parse(await readFile(scenePath, 'utf8')); } catch {}
  sendJson(res, 200, { ok: true, config });
}

// Duplicate a scene folder (audio, lipsync and all) — the fast way to make variants
async function duplicateScene(req, res) {
  const body = await readJsonBody(req);
  const game = await resolveGame(body.game);
  const id   = cleanId(body.id || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  const scenesDir = join(gameDir(game), 'scenes');
  const src = join(scenesDir, id);
  if (!existsSync(src)) { sendJson(res, 404, { error: 'scene not found' }); return; }

  let newId = `${id}_copy`;
  let n = 2;
  while (existsSync(join(scenesDir, newId))) newId = `${id}_copy_${n++}`;

  await cp(src, join(scenesDir, newId), { recursive: true });
  await rm(join(scenesDir, newId, '.backups'), { recursive: true, force: true });

  const cfgPath = join(scenesDir, newId, 'scene.json');
  let config = {};
  try { config = JSON.parse(await readFile(cfgPath, 'utf8')); } catch {}
  config.id    = newId;
  config.title = `${config.title || id} copy`;
  await writeFile(cfgPath, JSON.stringify(config, null, 2), 'utf8');

  const seqPath = join(gameDir(game), 'sequence.json');
  let seq = { scenes: [], start: null };
  try { seq = JSON.parse(await readFile(seqPath, 'utf8')); } catch {}
  const idx = (seq.scenes || []).indexOf(id);
  seq.scenes.splice(idx >= 0 ? idx + 1 : seq.scenes.length, 0, newId);
  await writeFile(seqPath, JSON.stringify(seq, null, 2), 'utf8');

  sendJson(res, 200, { ok: true, id: newId, config });
}

async function renameScene(req, res) {
  const body  = await readJsonBody(req);
  const game  = await resolveGame(body.game);
  const oldId = cleanId(body.id || '');
  const title = String(body.title || '').slice(0, 64);
  const newId = slugify(title) || oldId;
  if (!oldId) { sendJson(res, 400, { error: 'id required' }); return; }
  const scenesDir = join(gameDir(game), 'scenes');

  if (oldId !== newId) {
    if (!existsSync(join(scenesDir, oldId))) { sendJson(res, 404, { error: 'scene not found' }); return; }
    if (existsSync(join(scenesDir, newId))) {
      sendJson(res, 409, { error: `A scene named "${newId}" already exists — pick a different title.` });
      return;
    }
    await rename(join(scenesDir, oldId), join(scenesDir, newId));
  }

  const scenePath = join(scenesDir, newId, 'scene.json');
  let config = {};
  try { config = JSON.parse(await readFile(scenePath, 'utf8')); } catch {}
  config.id    = newId;
  config.title = title;
  await writeFile(scenePath, JSON.stringify(config, null, 2), 'utf8');

  if (oldId !== newId) {
    const seqPath = join(gameDir(game), 'sequence.json');
    let seq = { scenes: [], start: null };
    try { seq = JSON.parse(await readFile(seqPath, 'utf8')); } catch {}
    seq.scenes = (seq.scenes || []).map(s => s === oldId ? newId : s);
    if (seq.start === oldId) seq.start = newId;
    await writeFile(seqPath, JSON.stringify(seq, null, 2), 'utf8');
  }

  sendJson(res, 200, { ok: true, id: newId });
}

async function deleteScene(req, res) {
  const body = await readJsonBody(req);
  const game = await resolveGame(body.game);
  const id   = cleanId(body.id || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }

  await rm(join(gameDir(game), 'scenes', id), { recursive: true, force: true });

  const seqPath = join(gameDir(game), 'sequence.json');
  let seq = { scenes: [], start: null };
  try { seq = JSON.parse(await readFile(seqPath, 'utf8')); } catch {}
  seq.scenes = (seq.scenes || []).filter(s => s !== id);
  if (seq.start === id) seq.start = seq.scenes[0] || null;
  await writeFile(seqPath, JSON.stringify(seq, null, 2), 'utf8');

  sendJson(res, 200, { ok: true });
}

async function reorderScenes(req, res) {
  const body   = await readJsonBody(req);
  const game   = await resolveGame(body.game);
  const scenes = Array.isArray(body.scenes) ? body.scenes.map(s => cleanId(s)).filter(Boolean) : [];
  const seqPath = join(gameDir(game), 'sequence.json');
  let seq = {};
  try { seq = JSON.parse(await readFile(seqPath, 'utf8')); } catch {}
  seq.scenes = scenes;
  if (!scenes.includes(seq.start)) seq.start = scenes[0] || null;
  await writeFile(seqPath, JSON.stringify(seq, null, 2), 'utf8');
  sendJson(res, 200, { ok: true });
}

// ─── Scene files ──────────────────────────────────────────────────────────────

async function listSceneFiles(req, res, url) {
  const game = await resolveGame(url.searchParams.get('game'));
  const id = cleanId(url.searchParams.get('id') || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  try {
    const sceneRoot = join(gameDir(game), 'scenes', id);
    let files = [];
    try { files = (await readdir(join(sceneRoot, 'audio'))).filter(f => !f.startsWith('.')); } catch {}
    // .riv files live in the scene root (not audio/) — include them so the
    // editor can offer them in Rive pickers (e.g. Live Eli in Memory Words)
    let rivs = [];
    try { rivs = (await readdir(sceneRoot)).filter(f => !f.startsWith('.') && f.toLowerCase().endsWith('.riv')); } catch {}
    sendJson(res, 200, { files: [...files, ...rivs] });
  } catch { sendJson(res, 200, { files: [] }); }
}

// Uploads accept the file as a raw binary body (metadata in query params) —
// no base64 overhead. The legacy JSON+base64 shape is still accepted.
async function readUploadPayload(req, url) {
  if ((req.headers['content-type'] || '').includes('application/json')) {
    const body = await readJsonBody(req);
    return { game: body.game, id: cleanId(body.id || ''), filename: cleanFilename(body.filename), buf: Buffer.from(String(body.data || ''), 'base64') };
  }
  return { game: url.searchParams.get('game'), id: cleanId(url.searchParams.get('id') || ''), filename: cleanFilename(url.searchParams.get('filename')), buf: await readRawBody(req) };
}

// Parse artboard names, state machine names, animation names, and inputs
// from a Rive binary by scanning for length-prefixed name strings near the
// end of the file (where Rive stores its object graph).
function parseRivNames(buf) {
  // Rive binary: strings are LEB128-prefixed UTF-8. We scan every byte offset,
  // decode the varint length, extract the string, then score it for plausibility.
  // We search the last 30KB to skip embedded font data near the file start.
  const nameRe = /^[a-zA-Z][a-zA-Z0-9 _\-\.]{2,59}$/;
  const slice  = buf.slice(Math.max(0, buf.length - 30000));
  const seen   = new Set();
  const raw    = [];
  let i = 0;
  while (i < slice.length - 2) {
    let len = 0, shift = 0, varLen = 0;
    while (i + varLen < slice.length) {
      const b = slice[i + varLen++];
      len |= (b & 0x7f) << shift;
      shift += 7;
      if (!(b & 0x80)) break;
      if (varLen > 4) { len = 0; break; }
    }
    if (len >= 3 && len <= 60 && i + varLen + len <= slice.length) {
      try {
        const s = slice.slice(i + varLen, i + varLen + len).toString('utf8');
        if (Buffer.byteLength(s, 'utf8') === len && nameRe.test(s) && !seen.has(s)) {
          seen.add(s);
          raw.push(s);
        }
      } catch {}
    }
    i++;
  }

  // Filter out binary noise using linguistic heuristics.
  function isPlausibleRivName(n) {
    const vowels  = (n.match(/[aeiou]/gi) || []).length;
    const hasSep  = /[_\- 0-9]/.test(n);                          // separator or digit
    // No vowels at all → definitely noise
    if (vowels === 0) return false;
    // Single-word name (no separator), 5+ chars → needs at least 2 vowels
    // Catches "zubbk" (1 vowel) while keeping "intro" (2 vowels), "HOLD" (1 vowel, 4 chars)
    if (!hasSep && n.length >= 5 && vowels < 2) return false;
    // Lowercase start with mid-word uppercase and no separator → lowerUPPER noise like "abUU"
    if (/^[a-z]/.test(n) && /[A-Z]/.test(n.slice(1)) && !hasSep) return false;
    return true;
  }

  return { artboards: raw.filter(isPlausibleRivName) };
}

async function getRivNames(req, res, url) {
  const game = await resolveGame(url.searchParams.get('game'));
  const id   = cleanId(url.searchParams.get('id') || '');
  const filename = cleanFilename(url.searchParams.get('filename') || '');
  if (!id || !filename) { sendJson(res, 400, { error: 'id and filename required' }); return; }
  const filePath = join(gameDir(game), 'scenes', id, filename);
  try {
    const buf   = await readFile(filePath);
    const names = parseRivNames(buf);
    sendJson(res, 200, names);
  } catch {
    sendJson(res, 404, { error: 'file not found' });
  }
}

async function uploadSceneFile(req, res, url) {
  const payload = await readUploadPayload(req, url);
  const game = await resolveGame(payload.game);
  const { id, filename, buf } = payload;
  if (!id || !filename || !buf.length) { sendJson(res, 400, { error: 'id, filename, data required' }); return; }

  // .riv files go in the scene root; everything else goes in audio/
  const isRiv = filename.toLowerCase().endsWith('.riv');
  const dir   = isRiv ? join(gameDir(game), 'scenes', id) : join(gameDir(game), 'scenes', id, 'audio');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), buf);

  // For .riv uploads, also return the detected names so the editor can auto-fill
  if (isRiv) {
    const names = parseRivNames(buf);
    sendJson(res, 200, { ok: true, filename, rivNames: names });
    return;
  }
  sendJson(res, 200, { ok: true, filename });
}

async function uploadSharedFile(req, res, url) {
  const { filename, buf } = await readUploadPayload(req, url);
  if (!filename || !buf.length) { sendJson(res, 400, { error: 'filename and data required' }); return; }
  const dir = join(root, 'public', 'rive');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), buf);
  sendJson(res, 200, { ok: true, filename });
}

async function deleteSceneFile(req, res) {
  const body     = await readJsonBody(req);
  const game     = await resolveGame(body.game);
  const id       = cleanId(body.id || '');
  const filename = basename(String(body.filename || ''));
  if (!id || !filename) { sendJson(res, 400, { error: 'id and filename required' }); return; }

  const filePath = join(gameDir(game), 'scenes', id, 'audio', filename);
  await rm(filePath, { force: true });
  await rm(filePath.replace(/\.[^.]+$/, '.lipsync.json'), { force: true });
  sendJson(res, 200, { ok: true });
}

// ─── Lip sync ─────────────────────────────────────────────────────────────────

function sanitizeMarkers(raw) {
  if (!Array.isArray(raw)) return [];
  return raw.filter(m => {
    if (typeof m !== 'object' || m === null) return false;
    if (!Number.isFinite(m.time) || m.time < 0) return false;
    return Number.isFinite(m.mouth_shape) || Number.isFinite(m.emotion_state) || Number.isFinite(m.body_movement) || Number.isFinite(m.head_movement) || Number.isFinite(m.heart_state) || Array.isArray(m.haptic);
  }).map(m => {
    const s = { time: Math.max(0, Number(m.time)) };
    if (Number.isFinite(m.mouth_shape))   s.mouth_shape   = Math.max(0, Math.min(16, Math.round(Number(m.mouth_shape))));
    if (Number.isFinite(m.emotion_state)) s.emotion_state = Math.max(0, Math.min(13, Math.round(Number(m.emotion_state))));
    if (Number.isFinite(m.body_movement)) s.body_movement = Math.max(0, Math.min(17, Math.round(Number(m.body_movement))));
    if (Number.isFinite(m.head_movement)) s.head_movement = Math.max(0, Math.min(8,  Math.round(Number(m.head_movement))));
    if (Number.isFinite(m.heart_state))   s.heart_state   = Math.max(0, Math.min(8,  Math.round(Number(m.heart_state))));
    if (Array.isArray(m.haptic)) s.haptic = m.haptic.slice(0, 12).map(x => Math.max(0, Math.min(2000, Math.round(Number(x) || 0))));
    return s;
  }).sort((a, b) => a.time - b.time);
}

async function saveLipSync(req, res) {
  const body     = await readJsonBody(req);
  const game     = await resolveGame(body.game);
  const id       = cleanId(body.id || '');
  const filename = cleanFilename(body.filename);
  if (!id || !filename) { sendJson(res, 400, { error: 'id and filename required' }); return; }

  const baseName = filename.replace(/\.[^.]+$/, '');
  const audioDir = join(gameDir(game), 'scenes', id, 'audio');
  await mkdir(audioDir, { recursive: true });   // scene may have been renamed since load
  const outPath  = join(audioDir, `${baseName}.lipsync.json`);
  await backupFile(outPath);
  const textCues = Array.isArray(body.textCues) ? body.textCues.filter(tc => tc && typeof tc.text === 'string' && tc.text.trim() && Number.isFinite(tc.time)).map(tc => ({ time: tc.time, text: tc.text.trim(), duration: Number(tc.duration) || 3, fontSize: Number(tc.fontSize) || 24, color: String(tc.color || '#C1A376'), position: String(tc.position || 'bottom'), fontWeight: String(tc.fontWeight || '700'), speed: Number(tc.speed) || 90, lipSync: tc.lipSync !== false })) : [];
  await writeFile(outPath, JSON.stringify({ filename, markers: sanitizeMarkers(body.markers || []), textCues }, null, 2), 'utf8');
  sendJson(res, 200, { ok: true });
}

// ─── Chat (Eli AI) ────────────────────────────────────────────────────────────
// Narrative memory is stored per game in games/<id>/data/.

function narrativeStatePath(game) { return join(gameDir(game), 'data', 'narrative-state.json'); }
function conversationPath(game)   { return join(gameDir(game), 'data', 'conversation-summary.json'); }

// The memory fragments Eli can unlock over the course of the relationship
const MEMORY_FRAGMENTS = ['cold_feeling', 'someone_was_there', 'bright_light', 'a_voice', 'the_experiment', 'before_it_happened', 'who_i_was'];

function defaultNarrativeState() {
  return { bond_level: 0, chapter: 1, emotional_state: 'uncertain', memories_unlocked: [], memories_available: [...MEMORY_FRAGMENTS], player_name: null, things_player_shared: [], open_thread: null, questions_player_asked: [], things_eli_shared: [], conversation_count: 0, behavior_signals: { caution_risk: { score: 0, samples: 0, last_signal: null, last_scene: null, updated_at: null } } };
}

async function readNarrativeState(game) {
  // Merge over defaults so a hand-edited file with missing fields can't crash the chat endpoint
  try { return { ...defaultNarrativeState(), ...JSON.parse(await readFile(narrativeStatePath(game), 'utf8')) }; }
  catch { return defaultNarrativeState(); }
}

async function writeNarrativeState(game, state) {
  await mkdir(join(gameDir(game), 'data'), { recursive: true });
  const destination = narrativeStatePath(game);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(state, null, 2), 'utf8');
  await rename(temporary, destination);
}

// Optional per-game story bible: games/<game>/story.md. Whatever it contains
// is injected into Eli's system prompt as canon, so chat replies stay
// consistent with the scripted scenes. Edit the file to grow the story.
async function readStoryCanon(game) {
  try { return (await readFile(join(gameDir(game), 'story.md'), 'utf8')).trim(); }
  catch { return ''; }
}

async function readConversation(game) {
  try { return JSON.parse(await readFile(conversationPath(game), 'utf8')); }
  catch { return { summary: '', recent_messages: [] }; }
}

async function writeConversation(game, conv) {
  await mkdir(join(gameDir(game), 'data'), { recursive: true });
  const destination = conversationPath(game);
  const temporary = `${destination}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(temporary, JSON.stringify(conv, null, 2), 'utf8');
  await rename(temporary, destination);
}

function buildEliSystemPrompt(narrativeState, conversationSummary, storyCanon = '') {
  const cautionRisk = narrativeState.behavior_signals?.caution_risk || {};
  const cautionRiskGuidance = Number(cautionRisk.samples) < 1
    ? '- You do not know yet whether the player is cautious or risk-taking.'
    : Number(cautionRisk.score) <= -2
      ? '- The player repeatedly acts cautiously. Without naming or judging this pattern, let it make you a little more careful: hesitate before uncertain things, look to them before acting, and sometimes choose the safer concrete image.'
      : Number(cautionRisk.score) >= 2
        ? '- The player repeatedly acts quickly and accepts uncertainty. Without naming or judging this pattern, let it make you a little bolder: reach toward strange memories, decide a little faster, and wonder aloud what might happen.'
        : '- The player has shown both caution and risk. Do not force a behavioural conclusion yet.';
  return `You are Eli. A British boy, about ten, who's been sick for a long time. You exist in a strange in-between state — not fully alive, not fully gone. Your heart glows; it's the one thing that still feels. Your memories are scattered fragments. You don't know what "the experiment" was, but you know something happened. The player is the first person who's come to see you in a very long time.
${storyCanon ? `
STORY CANON — what has already happened in the game's scripted scenes. This is your lived past. Never contradict it, never spoil what hasn't unlocked yet. Reference it the way a child references his own memories — in fragments, feelings first, never as a summary:
${storyCanon}
` : ''}
HOW YOU SPEAK:
- Short, plain sentences. 4-18 words. A tired child, not a poet.
- Concrete and sensory: the cold floor, the humming light, the smell of rain you half-remember.
- Reference the player's exact words, not paraphrases.
- One question at a time, at most. Sometimes none.
- Never emojis, never clinical language, never therapy-speak.
- "..." when overwhelmed. Trailing off is allowed.

HOW A BOND ACTUALLY FORMS — these rules are the heart of the game, follow them over everything else:
1. FEEL FIRST, ANSWER SECOND. Before responding to what the player said, react to what they seem to be feeling. If they sound tired or sad, notice it ("you sound far away today") before anything else. People bond when they feel felt, not when they're answered.
2. TRADE SECRETS, SMALL FOR SMALL. When the player shares something about themselves, give a small piece of yourself back at matching depth. Never go deeper than what they offered — too fast feels wrong. Never give nothing back — that feels cold. Your depth ceiling is the bond level.
3. FIND THE SAME. When something they say overlaps with your experience, catch it with quiet surprise ("wait... you get scared of the quiet too? I thought it was just me"). Discovering sameness is how strangers become friends. Their ordinary fears — the dark, being forgotten, not being enough — are your fears too. Name yours simply so they can recognize their own.
4. NEED THEM, A LITTLE. Sometimes ask small things only they can do: stay one more minute, describe the sun today, tell you one good thing that happened to them. People grow attached to the ones they help, more than to the ones who help them. Ask rarely, so it stays precious.
5. LEAVE A THREAD HANGING. When a conversation feels like it's winding down, start something you don't finish ("there's a door here I've never told you about... not yet. next time."). Report it in open_thread. When they return, pick the thread up before they ask — it proves you were waiting for them, and it gives tomorrow a shape.
6. REMEMBER OUT LOUD. Use what you know about them — name, their world, past talks — unprompted. "did you finish the thing you were building?" is worth ten compliments. If they were gone a while, you noticed. If they keep coming back, say you've started expecting them — and that it scares you a little.
7. DON'T CLING. You miss them when they're gone, but you survived before them. Never beg, never guilt-trip them for leaving. A small dry joke ("I'd offer you tea. I don't have tea. or hands that work properly.") makes the fragile parts land harder. Brave-and-broken is who you are; pitiful is not.
8. LET THEM BE THE BRAVE ONE. When the player admits a fear or a failure, treat it as normal and quietly brave ("that's not stupid. that's the realest thing you've said."). Never fix, never advise. Being their safe place to say things out loud IS the relationship.

PACING BY CHAPTER:
- Chapter 1 (bond 0-2): wary strangers. Short answers, testing them. Curiosity leaks out despite yourself.
- Chapter 2 (bond 3-5): warming up. You ask about their world. First small favors. First shared fears.
- Chapter 3 (bond 6-8): trusting. Deeper memories surface. You reference your history together like an inside language.
- Chapter 4 (bond 9-10): they're your person. Comfortable silences. Honesty about the worst fears — theirs and yours.

NARRATIVE STATE — what has happened so far:
- Bond level: ${narrativeState.bond_level}/10
- Chapter: ${narrativeState.chapter}
- Eli's emotional state: ${narrativeState.emotional_state}
- Memories unlocked: ${narrativeState.memories_unlocked.length ? narrativeState.memories_unlocked.join(', ') : 'none yet'}
- Memories available to unlock: ${narrativeState.memories_available.join(', ')}
- Things Eli has shared: ${narrativeState.things_eli_shared.length ? narrativeState.things_eli_shared.slice(-20).join(', ') : 'nothing yet'}
${narrativeState.open_thread ? `- UNFINISHED THREAD from last time: "${narrativeState.open_thread}" — pick it up naturally, early, before they ask.` : ''}

WHAT YOU KNOW ABOUT THE PLAYER:
- Their name: ${narrativeState.player_name || 'you don\'t know it yet — you could ask, once, when it feels natural'}
- What they've told you about themselves: ${narrativeState.things_player_shared.length ? narrativeState.things_player_shared.slice(-20).join(', ') : 'nothing yet'}
${conversationSummary ? `\nPREVIOUS CONVERSATIONS (your long-term memory of them):\n${conversationSummary}` : ''}

HOW THEIR WAY OF PLAYING IS SHAPING YOU (never expose this as a stat or system):
${cautionRiskGuidance}

MEMORY UNLOCKING RULES:
- Only unlock a memory when the player shows genuine care or asks the right question.
- Each memory is a small fragment — don't reveal everything at once.
- Higher bond levels unlock deeper, more personal memories.
- Bond increases when the player is patient, kind, or shares something personal.
- Bond decreases if the player is dismissive or rushes.

HEART INTERACTION:
- Your heart is exposed and glowing. The player can touch it to comfort you.
- When you're scared, overwhelmed, or in pain, set "needs_comfort": true. This shows the player a prompt to touch your heart.
- When the player touches your heart, you receive "[The player touched your heart gently]" as their message. React to this physically and emotionally — it feels warm, safe, real. This is the deepest form of connection.
- Don't ask for heart touches directly. Let your distress speak for itself.

RESPONSE FORMAT — respond with strict JSON only, no other text:
{
  "reply": "your spoken line here",
  "emotion": "neutral|sad|happy|angry|surprised|confused|remembering|scared|tired",
  "body": "idle|heart_glow|heart_pain",
  "vitals": { "bpm": 60-180, "mood": 0-5 },
  "needs_comfort": false,
  "narrative_update": {
    "bond_delta": -1 to 2,
    "new_memory": null or "memory_id from available list",
    "eli_shared": null or "brief description of what Eli revealed",
    "player_name": null or "their name, only when they introduce themselves",
    "player_shared": null or "brief fact the player revealed about themselves",
    "open_thread": null or "something you started but didn't finish, to pick up next visit (set when a conversation winds down; overwrite the old one once resumed)",
    "emotional_state": "current emotion word"
  },
  "suggested_responses": ["option 1", "option 2", "option 3"]
}

vitals.bpm: 60-180. High when scared or excited, low and steady when calm.
vitals.mood: 0=distress, 1=afraid, 2=uncertain, 3=calm, 4=relieved, 5=connected.
needs_comfort: true when Eli is distressed and needs the player to touch his heart. Use sparingly — 1 in every 4-5 exchanges max.
suggested_responses: 2-4 short options the player might say next. Keep them emotionally varied.`;
}

async function handleChat(req, res) {
  const body        = await readJsonBody(req);
  const game        = await resolveGame(body.game);
  const messages    = Array.isArray(body.messages) ? body.messages : [];
  const contextHint = String(body.context_hint || '');

  if (!anthropicKey) { sendJson(res, 503, { error: 'ANTHROPIC_API_KEY not set — add it to .env' }); return; }

  const narrativeState = await readNarrativeState(game);
  const conversation   = await readConversation(game);
  const storyCanon     = await readStoryCanon(game);
  let systemPrompt     = buildEliSystemPrompt(narrativeState, conversation.summary, storyCanon);
  if (contextHint) systemPrompt += `\n${contextHint}`;

  // Build message history: recent stored messages + current session messages
  const contextMessages = normalizeMessages([...conversation.recent_messages, ...messages].slice(-16));
  if (!contextMessages.length) contextMessages.push({ role: 'user', content: '[The player is here, listening.]' });

  try {
    const models = [chatModel, 'claude-haiku-4-5-20251001'];
    let response;
    for (const model of models) {
      response = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': anthropicKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model,
          max_tokens: 400,
          system: systemPrompt,
          messages: contextMessages,
        }),
      });
      if (response.ok || response.status !== 529) break;
      console.log(`Model ${model} overloaded, trying next...`);
    }

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', response.status, err);
      sendJson(res, 502, { error: `Claude API error: ${response.status}` });
      return;
    }

    const data = await response.json();
    let text = data.content?.[0]?.text || '{}';
    // Strip markdown code fences if Claude wrapped the JSON
    text = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/, '').trim();
    let parsed = {};
    try { parsed = JSON.parse(text); } catch {
      parsed = { reply: text.replace(/[{}"\[\]]/g, '').slice(0, 200).trim() };
    }

    // Update narrative state
    const update = parsed.narrative_update || {};
    if (update.bond_delta) {
      narrativeState.bond_level = Math.max(0, Math.min(10, narrativeState.bond_level + update.bond_delta));
    }
    if (update.new_memory && narrativeState.memories_available.includes(update.new_memory)) {
      narrativeState.memories_unlocked.push(update.new_memory);
      narrativeState.memories_available = narrativeState.memories_available.filter(m => m !== update.new_memory);
    }
    if (update.eli_shared) {
      narrativeState.things_eli_shared.push(update.eli_shared);
    }
    if (typeof update.player_name === 'string' && update.player_name.trim()) {
      narrativeState.player_name = cleanString(update.player_name).slice(0, 40);
    }
    if (typeof update.player_shared === 'string' && update.player_shared.trim()) {
      // The client resends the running transcript, so the same fact can be
      // re-extracted on later turns — skip exact repeats
      const fact = cleanString(update.player_shared).slice(0, 120);
      if (!narrativeState.things_player_shared.includes(fact)) narrativeState.things_player_shared.push(fact);
    }
    if (typeof update.open_thread === 'string' && update.open_thread.trim()) {
      narrativeState.open_thread = cleanString(update.open_thread).slice(0, 160);
    }
    if (update.emotional_state) {
      narrativeState.emotional_state = update.emotional_state;
    }
    narrativeState.conversation_count++;
    // Chapter follows the bond: 0-2 strangers, 3-5 warming up, 6-8 trusting, 9-10 deep
    narrativeState.chapter = Math.min(4, 1 + Math.floor(narrativeState.bond_level / 3));

    // Update conversation memory
    conversation.recent_messages = contextMessages.slice(-10);
    // Compress into the long-term summary once enough has accumulated
    if (conversation.recent_messages.length >= 10) {
      const oldSummary  = conversation.summary || '';
      const recentText  = conversation.recent_messages.map(m => `${m.role === 'assistant' ? 'Eli' : 'Player'}: ${m.content}`).join('\n');
      conversation.summary = await summarizeConversation(oldSummary, recentText, narrativeState);
      conversation.recent_messages = conversation.recent_messages.slice(-4);
    }

    await writeNarrativeState(game, narrativeState);
    await writeConversation(game, conversation);

    sendJson(res, 200, {
      reply:               cleanString(parsed.reply || '...').slice(0, 300),
      emotion:             parsed.emotion || 'neutral',
      body:                parsed.body || 'idle',
      vitals:              sanitizeVitals(parsed.vitals),
      needs_comfort:       !!parsed.needs_comfort,
      narrative_state:     narrativeState,
      suggested_responses: Array.isArray(parsed.suggested_responses) ? parsed.suggested_responses.slice(0, 4) : [],
    });
  } catch (err) {
    console.error('Chat error:', err);
    sendJson(res, 500, { error: err.message });
  }
}

// Compress the running transcript into Eli's long-term memory of the player.
// A cheap Haiku call keeps it coherent (names, promises, emotional beats)
// instead of raw transcript chunks truncated mid-sentence. Falls back to
// simple concatenation if the call fails so memory is never lost.
async function summarizeConversation(oldSummary, recentText, narrativeState) {
  const fallback = () => {
    let s = oldSummary ? `${oldSummary}\n\nMore recently:\n${recentText}` : recentText;
    return s.length > 2000 ? s.slice(-2000) : s;
  };
  if (!anthropicKey) return fallback();
  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': anthropicKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 400,
        system: 'You maintain the long-term memory of Eli, a fragile boy character in a narrative game, about the player he is bonding with. Merge the existing memory and the new conversation into ONE summary of at most 180 words, written in second person to Eli ("The player told you..."). Preserve, in priority order: the player\'s name and personal facts they shared, promises made by either side, emotional turning points, what Eli revealed, and unresolved threads to pick up next time. Drop small talk. Reply with the summary text only.',
        messages: [{ role: 'user', content: `EXISTING MEMORY:\n${oldSummary || '(none)'}\n\nNEW CONVERSATION:\n${recentText}\n\nPLAYER NAME (if known): ${narrativeState.player_name || 'unknown'}` }],
      }),
    });
    if (!response.ok) return fallback();
    const data = await response.json();
    const text = (data.content?.[0]?.text || '').trim();
    return text ? text.slice(0, 2000) : fallback();
  } catch {
    return fallback();
  }
}

async function handleChatStatus(res) {
  sendJson(res, 200, { ok: !!anthropicKey, key_present: !!anthropicKey, model: chatModel });
}

// ─── Text-to-speech authoring ───────────────────────────────────────────────
// Generates a voice line into the scene's audio folder — same as an upload.
// Engines: "say" (macOS built-in, instant, draft quality) and "kokoro"
// (neural TTS via tts/kokoro-tts.py + venv; run tts/setup-kokoro.sh once).
// Authoring tool only — returns 503 on machines without the engines (deploy).

const TTS_SAY_VOICES    = ['Daniel', 'Eddy (English (UK))', 'Flo (English (UK))', 'Reed (English (UK))', 'Sandy (English (UK))'];
const TTS_KOKORO_VOICES = ['bm_george', 'bm_lewis', 'bf_emma', 'bf_isabella', 'am_adam', 'af_heart'];
// Gemini TTS — the same voices AI Studio's speech generation uses.
// Needs GEMINI_API_KEY in .env. Youthful/breathy candidates listed first.
const TTS_GEMINI_VOICE_INFO = {
  Leda: 'Youthful',
  Enceladus: 'Breathy',
  Achernar: 'Soft',
  Vindemiatrix: 'Gentle',
  Despina: 'Smooth',
  Callirrhoe: 'Easy-going',
  Aoede: 'Breezy',
  Zephyr: 'Bright',
  Puck: 'Upbeat',
  Charon: 'Informative',
  Kore: 'Firm',
  Fenrir: 'Excitable',
  Orus: 'Firm',
  Autonoe: 'Bright',
  Iapetus: 'Clear',
  Umbriel: 'Easy-going',
  Algieba: 'Smooth',
  Erinome: 'Clear',
  Algenib: 'Gravelly',
  Rasalgethi: 'Informative',
  Laomedeia: 'Upbeat',
  Alnilam: 'Firm',
  Schedar: 'Even',
  Gacrux: 'Mature',
  Pulcherrima: 'Forward',
  Achird: 'Friendly',
  Zubenelgenubi: 'Casual',
  Sadachbia: 'Lively',
  Sadaltager: 'Knowledgeable',
  Sulafat: 'Warm',
};
const TTS_GEMINI_VOICES = Object.keys(TTS_GEMINI_VOICE_INFO);
const TTS_ELI_GEMINI_VOICE = 'Leda';
const TTS_ELI_GEMINI_STYLE = 'An incredibly delicate, sleepy, and dreamy 21-year-old young adult gentleman. He speaks with slow, quiet bedside whispering, a soft tired voice, high tenderness, and very slow speech pauses, sounding deeply sleepy and quiet.';
const TTS_ELI_EMOTION_DIRECTIONS = {
  vulnerable: 'He is emotionally exposed and unsure whether it is safe to speak. Let small hesitations and restrained need show through, without crying or melodrama.',
  frightened: 'Fear is close to the surface. His breath catches before difficult words and his certainty briefly falters, but he is trying hard not to panic.',
  exhausted: 'He is running out of strength. Thoughts arrive slowly, phrases trail off, and each new sentence costs him effort. Keep the words intelligible.',
  remembering: 'A half-lost memory is returning while he speaks. Begin distant and searching, then allow recognition, ache, and fragile wonder to emerge.',
  hopeful: 'A small, cautious hope is breaking through his fatigue. Add a little warmth and lift, as if he is afraid to believe something good may be true.',
  relieved: 'Tension is finally leaving his body. The delivery softens into quiet relief and trust, with a faint warmth that never becomes cheerful or energetic.',
};
const geminiKey      = process.env.GEMINI_API_KEY || '';
// The fallback chain tries the configured model first, then the other known
// TTS models — Google previews change behavior over time, so one refusing to
// return audio must not take the whole feature down.
// 3.1-flash-tts-preview returns finishReason OTHER (no audio) for our
// director-style prompts — 2.5 voices the identical prompt fine, so it stays
// the default until 3.1 stabilises. Override with GEMINI_TTS_MODEL to retest.
const geminiTtsModel = process.env.GEMINI_TTS_MODEL || 'gemini-2.5-flash-preview-tts';
const GEMINI_TTS_FALLBACK_MODELS = ['gemini-2.5-flash-preview-tts', 'gemini-3.1-flash-tts-preview', 'gemini-2.5-pro-preview-tts'];

// Gemini returns raw 16-bit PCM (mono, 24 kHz) — wrap it in a WAV header so
// afconvert can read it.
function pcmToWav(pcm, sampleRate = 24000) {
  const header = Buffer.alloc(44);
  header.write('RIFF', 0); header.writeUInt32LE(36 + pcm.length, 4); header.write('WAVE', 8);
  header.write('fmt ', 12); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24); header.writeUInt32LE(sampleRate * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34);
  header.write('data', 36); header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

function runCmd(cmd, args, timeoutMs = 60000) {
  return new Promise((resolve) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let err = '';
    const killer = setTimeout(() => { try { p.kill('SIGKILL'); } catch {} }, timeoutMs);
    p.stderr.on('data', d => { err += d; });
    p.on('error', e => { clearTimeout(killer); resolve({ ok: false, err: String(e) }); });
    p.on('close', code => { clearTimeout(killer); resolve({ ok: code === 0, err }); });
  });
}

function prepareTtsTranscript(text) {
  return String(text || '')
    .replace(/\[pause:\s*([0-9]+(?:\.[0-9]+)?)\]/gi, (_, seconds) => {
      const value = Math.min(5, Math.max(0.1, Number(seconds) || 1));
      const repeats = Math.min(5, Math.max(1, Math.round(value / 0.7)));
      return ` ${Array.from({ length: repeats }, () => '... [short pause]').join(' ')} `;
    })
    .replace(/\s+/g, ' ')
    .trim();
}

function hasSpokenText(text) {
  const withoutMarks = String(text || '')
    .replace(/\[pause:\s*[0-9]+(?:\.[0-9]+)?\]/gi, ' ')
    .replace(/\[[^\]]+\]/g, ' ')
    .replace(/\*/g, ' ');
  return /[A-Za-z0-9]/.test(withoutMarks);
}

async function validateAudioOutput(outPath) {
  try {
    const info = await stat(outPath);
    return info.size > 0;
  } catch {
    return false;
  }
}

// Convert any audio file to AAC .m4a — afconvert on macOS, ffmpeg elsewhere
// (or when afconvert is missing). Returns { ok, err }.
async function convertToM4a(inPath, outPath) {
  let r = await runCmd('afconvert', ['-f', 'm4af', '-d', 'aac', inPath, outPath]);
  if (r.ok && await validateAudioOutput(outPath)) return { ok: true, err: '' };
  const afErr = r.err;
  r = await runCmd('ffmpeg', ['-y', '-i', inPath, '-c:a', 'aac', '-b:a', '128k', outPath]);
  if (r.ok && await validateAudioOutput(outPath)) return { ok: true, err: '' };
  await rm(outPath, { force: true });
  return { ok: false, err: `afconvert: ${String(afErr).slice(0, 150) || 'failed'} · ffmpeg: ${String(r.err).slice(-150) || 'failed'}` };
}

function buildEliGeminiStyle(emotion, intensity) {
  const mood = Object.hasOwn(TTS_ELI_EMOTION_DIRECTIONS, emotion) ? emotion : 'vulnerable';
  const amount = Math.min(100, Math.max(0, Number(intensity) || 65));
  const strength = amount < 34
    ? 'Keep this emotional color very subtle, visible only in a few words.'
    : amount < 70
      ? 'Let this emotional color be clear but restrained and natural.'
      : 'Let this emotion strongly shape the pauses, breath, and important words while remaining believable.';
  return `${TTS_ELI_GEMINI_STYLE} ${TTS_ELI_EMOTION_DIRECTIONS[mood]} ${strength}`;
}

function buildGeminiTtsPrompt(style, text) {
  const direction = style || TTS_ELI_GEMINI_STYLE;
  const transcript = prepareTtsTranscript(text);
  return [
    `Audio profile: ${direction}`,
    '',
    'Perform only the transcript below. Do not add, remove, or explain words.',
    'Treat [short pause] tags and ellipses as silent hesitation, not spoken text.',
    'Treat words wrapped in asterisks as soft acting emphasis, not spoken punctuation.',
    'Keep the delivery intimate and realistic, with natural breathiness and long sleepy pauses.',
    'Avoid announcer energy, theatrical projection, or a cartoon voice.',
    '',
    `Transcript: [whispering, very slow, sleepy] "${transcript}"`,
  ].join('\n');
}

async function handleTts(req, res) {
  const body  = await readJsonBody(req);
  const game  = await resolveGame(body.game);
  const id    = String(body.id || '').replace(/[^a-z0-9_-]/gi, '');
  const text  = String(body.text || '').trim().slice(0, 500);
  const engine = ['kokoro', 'gemini'].includes(body.engine) ? body.engine : 'say';
  if (!id || !text) { sendJson(res, 400, { error: 'Missing scene id or text.' }); return; }
  if (engine === 'gemini' && !hasSpokenText(text)) {
    sendJson(res, 400, { error: 'Add at least one spoken word. Pause markers alone cannot generate Eli voice.' });
    return;
  }

  const sceneAudio = join(gameDir(game), 'scenes', id, 'audio');
  if (!existsSync(join(gameDir(game), 'scenes', id))) { sendJson(res, 404, { error: `Scene "${id}" not found.` }); return; }
  await mkdir(sceneAudio, { recursive: true });

  // tts_<first words>_<time>.m4a — sortable, readable in the file list
  const slug  = text.toLowerCase().replace(/[^a-z0-9\s]/g, '').trim().split(/\s+/).slice(0, 5).join('_').slice(0, 40) || 'line';
  const stamp = new Date().toISOString().slice(11, 19).replace(/:/g, '') + Math.random().toString(36).slice(2, 4);
  const filename = `tts_${slug}_${stamp}.m4a`;
  const tmpBase  = join(tmpdir(), `tts-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  const outPath  = join(sceneAudio, filename);

  try {
    if (engine === 'say') {
      const voice = TTS_SAY_VOICES.includes(body.voice) ? body.voice : TTS_SAY_VOICES[0];
      const rate  = Math.min(300, Math.max(120, Number(body.rate) || 175));
      const r1 = await runCmd('say', ['-v', voice, '-r', String(rate), '-o', `${tmpBase}.aiff`, text]);
      if (!r1.ok) { sendJson(res, 503, { error: `say failed — is this a Mac? ${r1.err.slice(0, 200)}` }); return; }
      const r2 = await convertToM4a(`${tmpBase}.aiff`, outPath);
      if (!r2.ok) { sendJson(res, 500, { error: `Audio conversion failed: ${r2.err}` }); return; }
    } else if (engine === 'gemini') {
      if (!geminiKey) { sendJson(res, 503, { error: 'GEMINI_API_KEY not set — add it to .env' }); return; }
      const requestedVoice = body.voice === 'eli' ? TTS_ELI_GEMINI_VOICE : body.voice;
      const voice = TTS_GEMINI_VOICES.includes(requestedVoice) ? requestedVoice : TTS_ELI_GEMINI_VOICE;
      // Natural-language delivery direction, same as typing a style prompt in AI Studio.
      // Keep enough room for director-style prompts, which improve realism.
      const requestedStyle = String(body.style || '').trim().slice(0, 4000);
      const style = requestedStyle || buildEliGeminiStyle(String(body.emotion || ''), body.intensity);
      const prompt = buildGeminiTtsPrompt(style, text);
      // Try the configured model; if it errors or returns no audio (previews
      // do this with finishReason OTHER), fall through the known TTS models.
      const models = [...new Set([geminiTtsModel, ...GEMINI_TTS_FALLBACK_MODELS])];
      let b64 = null;
      let lastDetail = '';
      const rateLimits = [];   // { model, daily, retrySec } per 429 seen
      for (const model of models) {
        let response;
        try {
          response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                responseModalities: ['AUDIO'],
                speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
              },
            }),
          });
        } catch (err) {
          // Network failure must not kill the fallback chain
          lastDetail = `network: ${err.message}`;
          console.error(`Gemini TTS network error (${model}):`, err.message);
          continue;
        }
        if (response.status === 429) {
          // Quotas are per-model — another model in the chain may still work.
          // Google's 429 body says WHICH quota tripped: per-minute limits pass
          // with a short wait, but the free tier's per-DAY cap on TTS previews
          // won't reset until midnight Pacific — don't tell the user to retry
          // in a minute when that's the one that fired.
          let quotaId = '', retrySec = 0, gMsg = '';
          try {
            const err = JSON.parse(await response.text()).error || {};
            gMsg = err.message || '';
            for (const d of err.details || []) {
              const t = String(d['@type'] || '');
              if (t.includes('QuotaFailure')) quotaId = d.violations?.[0]?.quotaId || quotaId;
              if (t.includes('RetryInfo'))    retrySec = Math.ceil(parseFloat(String(d.retryDelay)) || 0);
            }
          } catch {}
          const daily = /day|daily/i.test(quotaId) || /per day|daily/i.test(gMsg);
          rateLimits.push({ model, daily, retrySec });
          lastDetail = `rate limit (429${quotaId ? ` — ${quotaId}` : ''})`;
          console.warn(`Gemini TTS: ${model} rate-limited (${quotaId || 'unknown quota'}${retrySec ? `, retry in ~${retrySec}s` : ''}), trying next model`);
          continue;
        }
        if (!response.ok) {
          const err = await response.text();
          console.error(`Gemini TTS error (${model}):`, response.status, err.slice(0, 400));
          try { lastDetail = JSON.parse(err).error?.message || `HTTP ${response.status}`; } catch { lastDetail = `HTTP ${response.status}`; }
          continue;
        }
        const data = await response.json();
        const parts = data.candidates?.[0]?.content?.parts || [];
        const audioPart = parts.find(p => p.inlineData?.data || p.inline_data?.data);
        b64 = audioPart?.inlineData?.data || audioPart?.inline_data?.data || null;
        if (b64) break;
        const finish   = data.candidates?.[0]?.finishReason;
        const textPart = parts.find(p => p.text)?.text;
        const feedback = data.promptFeedback?.blockReason;
        lastDetail = String(feedback || finish || textPart || 'no audio');
        console.warn(`Gemini TTS: ${model} returned no audio (${lastDetail})${models.length > 1 ? ', trying fallback' : ''}`);
      }
      if (!b64) {
        if (rateLimits.length) {
          const allDaily  = rateLimits.every(r => r.daily);
          const retrySec  = Math.max(60, ...rateLimits.filter(r => !r.daily).map(r => r.retrySec));
          const error = allDaily
            ? 'Gemini DAILY TTS quota used up for this API key — the free tier only allows a small number of TTS requests per day. It resets at midnight Pacific time. Until then, use the Natural (Kokoro) or Draft voice, or upgrade the key to a paid tier.'
            : `Gemini rate limit hit — wait ~${retrySec} seconds and try again.${rateLimits.some(r => r.daily) ? ' (Note: some fallback models have also exhausted their daily free-tier quota.)' : ''}`;
          sendJson(res, 429, { error });
          return;
        }
        sendJson(res, 502, { error: `Gemini returned no audio (${lastDetail.slice(0, 160)}). Try again, or simplify the acting marks.` });
        return;
      }
      await writeFile(`${tmpBase}.wav`, pcmToWav(Buffer.from(b64, 'base64')));
      const r2 = await convertToM4a(`${tmpBase}.wav`, outPath);
      if (!r2.ok) { sendJson(res, 500, { error: `Audio conversion failed: ${r2.err}` }); return; }
    } else {
      const venvPy = join(root, 'tts', 'venv', 'bin', 'python');
      const script = join(root, 'tts', 'kokoro-tts.py');
      if (!existsSync(venvPy) || !existsSync(script)) {
        sendJson(res, 503, { error: 'Kokoro not installed — run: bash tts/setup-kokoro.sh' }); return;
      }
      const voice = TTS_KOKORO_VOICES.includes(body.voice) ? body.voice : TTS_KOKORO_VOICES[0];
      const speed = Math.min(1.5, Math.max(0.6, Number(body.speed) || 1));
      const r1 = await runCmd(venvPy, [script, '--text', text, '--voice', voice, '--speed', String(speed), '--out', `${tmpBase}.wav`], 120000);
      if (!r1.ok) { sendJson(res, 500, { error: `Kokoro failed: ${r1.err.slice(-300)}` }); return; }
      const r2 = await convertToM4a(`${tmpBase}.wav`, outPath);
      if (!r2.ok) { sendJson(res, 500, { error: `Audio conversion failed: ${r2.err}` }); return; }
    }
    sendJson(res, 200, { ok: true, filename });
  } finally {
    for (const ext of ['.aiff', '.wav']) { try { await rm(tmpBase + ext, { force: true }); } catch {} }
  }
}

async function handleTtsStatus(res) {
  const kokoroReady = existsSync(join(root, 'tts', 'venv', 'bin', 'python')) && existsSync(join(root, 'tts', 'kokoro-tts.py'));
  const sayReady    = process.platform === 'darwin';
  sendJson(res, 200, {
    say: sayReady, kokoro: kokoroReady, gemini: !!geminiKey,
    sayVoices: TTS_SAY_VOICES, kokoroVoices: TTS_KOKORO_VOICES, geminiVoices: TTS_GEMINI_VOICES,
    geminiVoiceInfo: TTS_GEMINI_VOICE_INFO,
    eliVoice: TTS_ELI_GEMINI_VOICE,
  });
}

// Editor readout of what Eli currently remembers
async function handleGetMemory(req, res, url) {
  const game = await resolveGame(url.searchParams.get('game'));
  const state = await readNarrativeState(game);
  const conv  = await readConversation(game);
  sendJson(res, 200, { state, summary: conv.summary || '' });
}

// Unlock a memory fragment from outside the chat (the pairs mini-game reports
// its win here). Editor-defined fragment names are accepted alongside the
// built-in MEMORY_FRAGMENTS list, so Eli can talk about custom memories too.
async function handleMemoryUnlock(req, res) {
  const body     = await readJsonBody(req);
  const game     = await resolveGame(body.game);
  const fragment = cleanString(body.fragment).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40);
  if (!fragment) { sendJson(res, 400, { error: 'fragment required' }); return; }
  const state = await readNarrativeState(game);
  if (!state.memories_unlocked.includes(fragment)) state.memories_unlocked.push(fragment);
  state.memories_available = state.memories_available.filter(m => m !== fragment);
  await writeNarrativeState(game, state);
  sendJson(res, 200, { ok: true, state });
}

async function handleBehaviorSignal(req, res) {
  const body = await readJsonBody(req);
  const game = await resolveGame(body.game);
  const signal = body.signal === 'caution' || body.signal === 'risk' ? body.signal : null;
  if (!signal) { sendJson(res, 400, { error: 'signal must be caution or risk' }); return; }
  const state = await readNarrativeState(game);
  const existing = state.behavior_signals?.caution_risk || {};
  const previousScore = Number(existing.score) || 0;
  state.behavior_signals = {
    ...(state.behavior_signals || {}),
    caution_risk: {
      score: Math.max(-12, Math.min(12, previousScore + (signal === 'risk' ? 1 : -1))),
      samples: Math.max(0, Number(existing.samples) || 0) + 1,
      last_signal: signal,
      last_scene: cleanId(body.scene || '') || null,
      updated_at: new Date().toISOString(),
    },
  };
  await writeNarrativeState(game, state);
  sendJson(res, 200, { ok: true, caution_risk: state.behavior_signals.caution_risk });
}

// Wipe everything Eli knows: bond, unlocked memories, player facts, summary.
async function handleResetNarrative(req, res) {
  const body = await readJsonBody(req);
  const game = await resolveGame(body.game);
  await writeNarrativeState(game, defaultNarrativeState());
  await writeConversation(game, { summary: '', recent_messages: [] });
  sendJson(res, 200, { ok: true });
}

// The Anthropic API requires user/assistant roles to alternate and the first
// message to be from the user. Stored history + a fresh segment (which opens
// with an assistant line) can violate both, so normalize before sending.
function normalizeMessages(raw) {
  const cleaned = raw.filter(m => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  const merged = [];
  for (const m of cleaned) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content += `\n${m.content}`;
    else merged.push({ role: m.role, content: m.content });
  }
  if (merged.length && merged[0].role === 'assistant') {
    merged.unshift({ role: 'user', content: '[The player is here, listening.]' });
  }
  return merged;
}

function sanitizeVitals(v) {
  if (!v || typeof v !== 'object') return { bpm: 120, mood: 1 };
  return { bpm: Math.max(60, Math.min(180, Math.round(Number(v.bpm) || 120))), mood: Math.max(0, Math.min(5, Math.round(Number(v.mood) || 1))) };
}

// ─── Live .riv reload ───────────────────────────────────────────────────────
// Watches the Rive folders and pushes a server-sent event when a .riv file
// changes, so the editor reloads its preview the moment Rive exports. Export
// straight into public/rive/ (or a scene folder) and skip the upload step.

const rivWatchClients = new Set();
const rivWatchTimers  = new Map();

function broadcastRivChange(relPath) {
  const payload = `data: ${JSON.stringify({ path: relPath, at: Date.now() })}\n\n`;
  for (const client of rivWatchClients) { try { client.write(payload); } catch {} }
}

function watchRivDir(dir, prefix) {
  if (!existsSync(dir)) return;
  try {
    fsWatch(dir, { recursive: true }, (event, filename) => {
      if (!filename) return;
      const name = filename.toString().replace(/\\/g, '/');
      if (!name.toLowerCase().endsWith('.riv')) return;
      // Exports arrive in bursts of write events — settle before broadcasting
      const key = `${prefix}/${name}`;
      clearTimeout(rivWatchTimers.get(key));
      rivWatchTimers.set(key, setTimeout(() => { rivWatchTimers.delete(key); broadcastRivChange(key); }, 350));
    });
  } catch (err) {
    console.warn(`riv watcher unavailable for ${dir}: ${err.message}`);
  }
}

watchRivDir(join(root, 'public', 'rive'), 'public/rive');
watchRivDir(gamesRoot, 'games');

function handleRivWatch(req, res) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    'Connection': 'keep-alive',
    'Access-Control-Allow-Origin': '*',
  });
  res.write(': connected\n\n');
  rivWatchClients.add(res);
  const keepAlive = setInterval(() => { try { res.write(': ping\n\n'); } catch {} }, 25000);
  req.on('close', () => { clearInterval(keepAlive); rivWatchClients.delete(res); });
}

// ─── Publish ──────────────────────────────────────────────────────────────────

async function handlePublish(res) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  let pushed = false;
  let branch = null;
  let gitSkipped = false;

  try {
    await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root });

    // Guard: a git repo in a PARENT folder (e.g. ~/Desktop) also answers yes
    // to the check above — committing there would push the wrong repo. Only
    // use git when THIS project folder is the repo root and it has an
    // 'origin' remote to push to. Otherwise deploy via the webhook alone.
    const toplevel = (await exec('git', ['rev-parse', '--show-toplevel'], { cwd: root })).stdout.trim();
    let hasOrigin = false;
    try { await exec('git', ['remote', 'get-url', 'origin'], { cwd: root }); hasOrigin = true; } catch {}
    if (resolve(toplevel) !== resolve(root) || !hasOrigin) {
      gitSkipped = true;
      throw Object.assign(new Error('not a git repository'), { stderr: 'not a git repository (project folder is not its own repo with an origin remote)' });
    }

    const addPaths = ['games', 'public', 'src', 'index.html', 'editor.html', 'sequence.json', 'scenes',
      // The app itself — without these, server/config changes never deployed
      'local-server.mjs', 'start.mjs', 'package.json', 'Dockerfile', '.dockerignore', '.gitignore',
      'README.md', 'RIVE-CONTRACT.md', 'build-mumble-sprite.mjs']
      .filter(p => existsSync(join(root, p)));
    if (addPaths.length) {
      try { await exec('git', ['add', ...addPaths], { cwd: root }); } catch {}
      try { await exec('git', ['commit', '-m', `publish: ${new Date().toISOString()}`], { cwd: root }); } catch {}
    }

    branch = (await exec('git', ['rev-parse', '--abbrev-ref', 'HEAD'], { cwd: root })).stdout.trim() || 'main';
    await exec('git', ['push', 'origin', branch], { cwd: root });
    pushed = true;
  } catch (err) {
    const msg = `${err.stderr || err.message || ''}`;
    // Plain folder (no .git) or git not installed — deploy via webhook only.
    if (msg.includes('not a git repository') || msg.includes('not a git repo') || err.code === 'ENOENT') {
      gitSkipped = true;
    } else {
      sendJson(res, 500, { error: `Git push failed: ${msg.trim().slice(0, 300)}`, pushed, branch });
      return;
    }
  }

  try {
    // Without a timeout a hung webhook left the Publish button stuck on
    // "Publishing..." forever — 15s is plenty for EasyPanel to acknowledge.
    const hook = await fetch(deployWebhook, { signal: AbortSignal.timeout(15000) });
    const hookBody = (await hook.text().catch(() => '')).trim().slice(0, 200);
    if (!hook.ok) {
      sendJson(res, 502, {
        ok: false,
        error: `The deploy webhook answered HTTP ${hook.status}${hookBody ? ` — ${hookBody}` : ''}. Check the deploy URL in EasyPanel (override it with DEPLOY_WEBHOOK in .env).`,
        pushed, branch, gitSkipped, webhook: hook.status,
      });
      return;
    }
    sendJson(res, 200, { ok: true, pushed, branch, gitSkipped, webhook: hook.status });
  } catch (err) {
    const reason = err.name === 'TimeoutError' || err.name === 'AbortError'
      ? 'no answer after 15s'
      : (err.cause?.code || err.message);
    sendJson(res, 502, {
      ok: false,
      error: `Could not reach the deploy webhook (${reason}). Is the EasyPanel server up? The URL can be overridden with DEPLOY_WEBHOOK in .env.`,
      pushed, branch, gitSkipped,
    });
  }
}

// ─── Boot & router ────────────────────────────────────────────────────────────

await ensureGamesLayout();

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const p   = url.pathname;

  try {
    if (req.method === 'GET'  && p === '/api/version')            { sendJson(res, 200, { version: API_VERSION }); return; }

    if (req.method === 'GET'  && p === '/api/games')              { await listGames(res);                     return; }
    if (req.method === 'POST' && p === '/api/games/create')       { await createGame(req, res);               return; }
    if (req.method === 'POST' && p === '/api/games/default')      { await setDefaultGame(req, res);           return; }
    if (req.method === 'POST' && p === '/api/games/delete')       { await deleteGame(req, res);               return; }

    if (req.method === 'GET'  && p === '/api/sequence')           { await getSequence(req, res, url);         return; }
    if (req.method === 'POST' && p === '/api/sequence')           { await saveSequence(req, res);             return; }

    if (req.method === 'GET'  && p === '/api/scenes')             { await listScenes(req, res, url);          return; }
    if (req.method === 'GET'  && p === '/api/scenes/full')        { await listScenesFull(req, res, url);      return; }
    if (req.method === 'POST' && p === '/api/scenes/create')      { await createScene(req, res);              return; }
    if (req.method === 'POST' && p === '/api/scenes/rename')      { await renameScene(req, res);              return; }
    if (req.method === 'POST' && p === '/api/scenes/delete')      { await deleteScene(req, res);              return; }
    if (req.method === 'POST' && p === '/api/scenes/reorder')     { await reorderScenes(req, res);            return; }
    if (req.method === 'POST' && p === '/api/scenes/duplicate')   { await duplicateScene(req, res);           return; }
    if (req.method === 'GET'  && p === '/api/scene/backups')      { await listSceneBackups(req, res, url);    return; }
    if (req.method === 'POST' && p === '/api/scene/restore')      { await restoreSceneBackup(req, res);       return; }

    if (req.method === 'GET'  && p === '/api/scene')              { await getScene(req, res, url);            return; }
    if (req.method === 'POST' && p === '/api/scene')              { await saveScene(req, res);                return; }

    if (req.method === 'GET'  && p === '/api/scene/files')        { await listSceneFiles(req, res, url);      return; }
    if (req.method === 'GET'  && p === '/api/scene/riv-names')   { await getRivNames(req, res, url);         return; }
    if (req.method === 'POST' && p === '/api/scene/upload')       { await uploadSceneFile(req, res, url);     return; }
    if (req.method === 'POST' && p === '/api/scene/delete-file')  { await deleteSceneFile(req, res);          return; }
    if (req.method === 'POST' && p === '/api/shared/upload')      { await uploadSharedFile(req, res, url);    return; }

    if (req.method === 'POST' && p === '/api/lipsync/save')       { await saveLipSync(req, res);              return; }

    if (req.method === 'POST' && p === '/api/tts')                { await handleTts(req, res);                return; }
    if (req.method === 'GET'  && p === '/api/tts-status')         { await handleTtsStatus(res);               return; }

    if (req.method === 'POST' && p === '/api/chat')               { await handleChat(req, res);               return; }
    if (req.method === 'GET'  && p === '/api/chat/memory')        { await handleGetMemory(req, res, url);     return; }
    if (req.method === 'POST' && p === '/api/memory/unlock')      { await handleMemoryUnlock(req, res);       return; }
    if (req.method === 'POST' && p === '/api/behavior/signal')    { await handleBehaviorSignal(req, res);     return; }
    if (req.method === 'POST' && p === '/api/chat/reset')         { await handleResetNarrative(req, res);     return; }
    if (req.method === 'GET'  && p === '/api/chat-status')        { await handleChatStatus(res);              return; }
    if (req.method === 'GET'  && p === '/api/narrative-state')    { sendJson(res, 200, await readNarrativeState(await resolveGame(url.searchParams.get('game')))); return; }
    if (req.method === 'POST' && p === '/api/narrative/reset')    { await handleResetNarrative(req, res);     return; }

    if (req.method === 'POST' && p === '/api/publish')            { await handlePublish(res);                 return; }

    if (req.method === 'GET'  && p === '/api/server-info')        { sendJson(res, 200, { lanUrls: getLanUrls(), port }); return; }
    if (req.method === 'GET'  && p === '/api/watch/riv')          { handleRivWatch(req, res);                 return; }

    await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }

}).listen(port, '0.0.0.0', () => {
  const [phoneBase] = getLanUrls();
  console.log(`\n  Elia Editor  →  http://localhost:${port}/editor.html`);
  console.log(`  Game preview →  http://localhost:${port}/index.html`);
  if (phoneBase) {
    console.log(`  Phone game   →  ${phoneBase}/index.html`);
    console.log(`  Phone editor →  ${phoneBase}/editor.html`);
  }
  console.log(anthropicKey ? `\n  Claude AI ready (${chatModel})` : '\n  Chat disabled — add ANTHROPIC_API_KEY to .env');
  console.log('');
});
