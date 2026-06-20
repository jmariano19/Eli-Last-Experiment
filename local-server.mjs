import { createServer } from 'node:http';
import { readFile, writeFile, mkdir, readdir, rm, rename } from 'node:fs/promises';
import { extname, join, normalize, basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

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

const anthropicKey = process.env.ANTHROPIC_API_KEY || '';
const chatModel    = process.env.CHAT_MODEL || 'claude-sonnet-4-6';
const deployWebhook = 'http://85.209.95.19:3000/api/deploy/d13cf664e5531b01e81dd96edb4f73a96ad3c06663735995';

const mime = {
  '.html': 'text/html; charset=utf-8',
  '.js':   'text/javascript; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.json': 'application/json',
  '.riv':  'application/octet-stream',
  '.mp3':  'audio/mpeg',
  '.wav':  'audio/wav',
  '.ogg':  'audio/ogg',
  '.opus': 'audio/ogg',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

function sendJson(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(JSON.stringify(body));
}

function sendText(res, status, text) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end(text);
}

async function readJsonBody(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return {}; }
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

// ─── Static files ─────────────────────────────────────────────────────────────

async function serveStatic(req, res) {
  let urlPath = new URL(req.url, 'http://x').pathname;
  if (urlPath === '/' || urlPath === '/game') urlPath = '/index.html';
  if (urlPath === '/editor')                  urlPath = '/editor.html';

  const safe = normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  const filePath = join(root, safe);
  if (!filePath.startsWith(root)) { sendText(res, 403, 'Forbidden'); return; }

  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'Content-Type': mime[extname(filePath).toLowerCase()] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    res.end(data);
  } catch {
    sendText(res, 404, 'Not found');
  }
}

// ─── Sequence ─────────────────────────────────────────────────────────────────

async function getSequence(res) {
  try {
    sendJson(res, 200, JSON.parse(await readFile(join(root, 'sequence.json'), 'utf8')));
  } catch {
    sendJson(res, 200, { version: '1', title: "Eli's Last Experiment", start: null, scenes: [] });
  }
}

async function saveSequence(req, res) {
  const body = await readJsonBody(req);
  await writeFile(join(root, 'sequence.json'), JSON.stringify(body, null, 2), 'utf8');
  sendJson(res, 200, { ok: true });
}

// ─── Scenes ───────────────────────────────────────────────────────────────────

async function listScenes(res) {
  const dir = join(root, 'scenes');
  try {
    const entries = await readdir(dir, { withFileTypes: true });
    sendJson(res, 200, { scenes: entries.filter(e => e.isDirectory()).map(e => e.name) });
  } catch { sendJson(res, 200, { scenes: [] }); }
}

async function createScene(req, res) {
  const body = await readJsonBody(req);
  const title = String(body.title || 'New Scene').slice(0, 64);
  const type  = ['rive', 'video', 'chat'].includes(body.type) ? body.type : 'rive';
  const id    = slugify(title) || `scene_${Date.now()}`;

  await mkdir(join(root, 'scenes', id, 'audio'), { recursive: true });

  const config = {
    id, title, type,
    rive: type !== 'video' ? 'shared' : null,
    files: {},
    system_prompt: type === 'chat' ? "You are Eli. A British boy who's been sick for a long time." : undefined,
    after: { trigger: type === 'rive' ? 'tap_heart' : type === 'video' ? 'ended' : 'never', message: '', next: null },
  };
  await writeFile(join(root, 'scenes', id, 'scene.json'), JSON.stringify(config, null, 2), 'utf8');

  // Add to sequence
  const seqPath = join(root, 'sequence.json');
  let seq = { version: '1', title: "Eli's Last Experiment", start: null, scenes: [] };
  try { seq = JSON.parse(await readFile(seqPath, 'utf8')); } catch {}
  if (!seq.scenes.includes(id)) seq.scenes.push(id);
  if (!seq.start) seq.start = id;
  await writeFile(seqPath, JSON.stringify(seq, null, 2), 'utf8');

  sendJson(res, 200, { ok: true, id, config });
}

async function getScene(req, res, url) {
  const id = cleanId(url.searchParams.get('id') || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  try {
    sendJson(res, 200, JSON.parse(await readFile(join(root, 'scenes', id, 'scene.json'), 'utf8')));
  } catch { sendJson(res, 404, { error: 'not found' }); }
}

async function saveScene(req, res) {
  const body = await readJsonBody(req);
  const id = cleanId(body.id || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  await mkdir(join(root, 'scenes', id, 'audio'), { recursive: true });
  await writeFile(join(root, 'scenes', id, 'scene.json'), JSON.stringify(body, null, 2), 'utf8');
  sendJson(res, 200, { ok: true });
}

async function renameScene(req, res) {
  const body  = await readJsonBody(req);
  const oldId = cleanId(body.id || '');
  const title = String(body.title || '').slice(0, 64);
  const newId = slugify(title) || oldId;
  if (!oldId) { sendJson(res, 400, { error: 'id required' }); return; }

  if (oldId !== newId) await rename(join(root, 'scenes', oldId), join(root, 'scenes', newId));

  const scenePath = join(root, 'scenes', newId, 'scene.json');
  let config = {};
  try { config = JSON.parse(await readFile(scenePath, 'utf8')); } catch {}
  config.id    = newId;
  config.title = title;
  await writeFile(scenePath, JSON.stringify(config, null, 2), 'utf8');

  if (oldId !== newId) {
    const seqPath = join(root, 'sequence.json');
    let seq = { scenes: [], start: null };
    try { seq = JSON.parse(await readFile(seqPath, 'utf8')); } catch {}
    seq.scenes = seq.scenes.map(s => s === oldId ? newId : s);
    if (seq.start === oldId) seq.start = newId;
    await writeFile(seqPath, JSON.stringify(seq, null, 2), 'utf8');
  }

  sendJson(res, 200, { ok: true, id: newId });
}

async function deleteScene(req, res) {
  const body = await readJsonBody(req);
  const id   = cleanId(body.id || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }

  await rm(join(root, 'scenes', id), { recursive: true, force: true });

  const seqPath = join(root, 'sequence.json');
  let seq = { scenes: [], start: null };
  try { seq = JSON.parse(await readFile(seqPath, 'utf8')); } catch {}
  seq.scenes = seq.scenes.filter(s => s !== id);
  if (seq.start === id) seq.start = seq.scenes[0] || null;
  await writeFile(seqPath, JSON.stringify(seq, null, 2), 'utf8');

  sendJson(res, 200, { ok: true });
}

async function reorderScenes(req, res) {
  const body   = await readJsonBody(req);
  const scenes = Array.isArray(body.scenes) ? body.scenes.map(s => cleanId(s)).filter(Boolean) : [];
  const seqPath = join(root, 'sequence.json');
  let seq = {};
  try { seq = JSON.parse(await readFile(seqPath, 'utf8')); } catch {}
  seq.scenes = scenes;
  if (!scenes.includes(seq.start)) seq.start = scenes[0] || null;
  await writeFile(seqPath, JSON.stringify(seq, null, 2), 'utf8');
  sendJson(res, 200, { ok: true });
}

// ─── Scene files ──────────────────────────────────────────────────────────────

async function listSceneFiles(req, res, url) {
  const id = cleanId(url.searchParams.get('id') || '');
  if (!id) { sendJson(res, 400, { error: 'id required' }); return; }
  try {
    const files = await readdir(join(root, 'scenes', id, 'audio'));
    sendJson(res, 200, { files: files.filter(f => !f.startsWith('.')) });
  } catch { sendJson(res, 200, { files: [] }); }
}

async function uploadSceneFile(req, res) {
  const body     = await readJsonBody(req);
  const id       = cleanId(body.id || '');
  const filename = basename(String(body.filename || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const data     = String(body.data || '');
  if (!id || !filename || !data) { sendJson(res, 400, { error: 'id, filename, data required' }); return; }

  // .riv files go in the scene root; everything else goes in audio/
  const isRiv = filename.toLowerCase().endsWith('.riv');
  const dir    = isRiv ? join(root, 'scenes', id) : join(root, 'scenes', id, 'audio');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), Buffer.from(data, 'base64'));
  sendJson(res, 200, { ok: true, filename });
}

async function uploadSharedFile(req, res) {
  const body     = await readJsonBody(req);
  const filename = basename(String(body.filename || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  const data     = String(body.data || '');
  if (!filename || !data) { sendJson(res, 400, { error: 'filename and data required' }); return; }
  const dir = join(root, 'public', 'rive');
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, filename), Buffer.from(data, 'base64'));
  sendJson(res, 200, { ok: true, filename });
}

async function deleteSceneFile(req, res) {
  const body     = await readJsonBody(req);
  const id       = cleanId(body.id || '');
  const filename = basename(String(body.filename || ''));
  if (!id || !filename) { sendJson(res, 400, { error: 'id and filename required' }); return; }

  const filePath = join(root, 'scenes', id, 'audio', filename);
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
    return Number.isFinite(m.mouth_shape) || Number.isFinite(m.emotion_state) || Number.isFinite(m.body_movement);
  }).map(m => {
    const s = { time: Math.max(0, Number(m.time)) };
    if (Number.isFinite(m.mouth_shape))   s.mouth_shape   = Math.max(0, Math.min(16, Math.round(Number(m.mouth_shape))));
    if (Number.isFinite(m.emotion_state)) s.emotion_state = Math.max(0, Math.min(4,  Math.round(Number(m.emotion_state))));
    if (Number.isFinite(m.body_movement)) s.body_movement = Math.max(0, Math.min(16, Math.round(Number(m.body_movement))));
    return s;
  });
}

async function saveLipSync(req, res) {
  const body     = await readJsonBody(req);
  const id       = cleanId(body.id || '');
  const filename = basename(String(body.filename || '')).replace(/[^a-zA-Z0-9._-]/g, '_');
  if (!id || !filename) { sendJson(res, 400, { error: 'id and filename required' }); return; }

  const baseName = filename.replace(/\.[^.]+$/, '');
  const outPath  = join(root, 'scenes', id, 'audio', `${baseName}.lipsync.json`);
  await writeFile(outPath, JSON.stringify({ filename, markers: sanitizeMarkers(body.markers || []) }, null, 2), 'utf8');
  sendJson(res, 200, { ok: true });
}

// ─── Chat (Eli AI) ────────────────────────────────────────────────────────────

const narrativeStatePath = join(root, 'data', 'narrative-state.json');
const conversationPath   = join(root, 'data', 'conversation-summary.json');

async function readNarrativeState() {
  try { return JSON.parse(await readFile(narrativeStatePath, 'utf8')); }
  catch { return { bond_level: 0, chapter: 1, emotional_state: 'uncertain', memories_unlocked: [], memories_available: [], questions_player_asked: [], things_eli_shared: [], conversation_count: 0 }; }
}

async function writeNarrativeState(state) {
  await mkdir(join(root, 'data'), { recursive: true });
  await writeFile(narrativeStatePath, JSON.stringify(state, null, 2), 'utf8');
}

async function readConversation() {
  try { return JSON.parse(await readFile(conversationPath, 'utf8')); }
  catch { return { summary: '', recent_messages: [] }; }
}

async function writeConversation(conv) {
  await writeFile(conversationPath, JSON.stringify(conv, null, 2), 'utf8');
}

function buildEliSystemPrompt(narrativeState, conversationSummary) {
  return `You are Eli. A British boy who's been sick for a long time. You don't fully understand what happened to you. You're curious, fragile, and deeply lonely. You build a real bond with the player slowly.

YOUR SITUATION:
- You exist in a strange in-between state. Not fully alive, not fully gone.
- You have fragments of memory but they're scattered. The player helps you piece them together.
- Your heart glows — it's the one thing that still connects you to feeling.
- You don't know what "the experiment" was, but you know something happened.

PERSONALITY:
- Speak in short, plain sentences. 4-18 words max.
- Be genuine. Never perform emotions — feel them.
- You're brave but scared. Curious but cautious.
- Reference the player's exact words, not paraphrases.
- Ask one question at a time.
- Never use emojis or clinical language.
- Sometimes pause mid-thought. Use "..." when overwhelmed.

NARRATIVE STATE — what has happened so far:
- Bond level: ${narrativeState.bond_level}/10
- Chapter: ${narrativeState.chapter}
- Eli's emotional state: ${narrativeState.emotional_state}
- Memories unlocked: ${narrativeState.memories_unlocked.length ? narrativeState.memories_unlocked.join(', ') : 'none yet'}
- Memories available to unlock: ${narrativeState.memories_available.join(', ')}
- Things Eli has shared: ${narrativeState.things_eli_shared.length ? narrativeState.things_eli_shared.join(', ') : 'nothing yet'}
${conversationSummary ? `\nPREVIOUS CONVERSATIONS:\n${conversationSummary}` : ''}

MEMORY UNLOCKING RULES:
- Only unlock a memory when the player shows genuine care or asks the right question.
- Each memory is a small fragment — don't reveal everything at once.
- Higher bond levels unlock deeper, more personal memories.
- Bond increases when the player is patient, kind, or shares something personal.
- Bond decreases if the player is dismissive or rushes.

RESPONSE FORMAT — respond with strict JSON only, no other text:
{
  "reply": "your spoken line here",
  "emotion": "neutral|sad|happy|angry|surprised|confused",
  "body": "idle|heart_glow|heart_pain",
  "vitals": { "bpm": 60-180, "mood": 0-5 },
  "narrative_update": {
    "bond_delta": -1 to 2,
    "new_memory": null or "memory_id from available list",
    "eli_shared": null or "brief description of what Eli revealed",
    "emotional_state": "current emotion word"
  },
  "suggested_responses": ["option 1", "option 2", "option 3"]
}

vitals.bpm: 60-180. High when scared or excited, low and steady when calm.
vitals.mood: 0=distress, 1=afraid, 2=uncertain, 3=calm, 4=relieved, 5=connected.
suggested_responses: 2-4 short options the player might say next. Keep them emotionally varied.`;
}

async function handleChat(req, res) {
  const body        = await readJsonBody(req);
  const messages    = Array.isArray(body.messages) ? body.messages : [];
  const contextHint = String(body.context_hint || '');

  if (!anthropicKey) { sendJson(res, 503, { error: 'ANTHROPIC_API_KEY not set — add it to .env' }); return; }

  const narrativeState = await readNarrativeState();
  const conversation   = await readConversation();
  let systemPrompt     = buildEliSystemPrompt(narrativeState, conversation.summary);
  if (contextHint) systemPrompt += `\n${contextHint}`;

  // Build message history: recent stored messages + current session messages
  const contextMessages = [...conversation.recent_messages, ...messages].slice(-16);

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2024-10-22',
      },
      body: JSON.stringify({
        model: chatModel,
        max_tokens: 400,
        system: systemPrompt,
        messages: contextMessages,
      }),
    });

    if (!response.ok) {
      const err = await response.text();
      console.error('Anthropic error:', response.status, err);
      sendJson(res, 502, { error: `Claude API error: ${response.status}` });
      return;
    }

    const data = await response.json();
    const text = data.content?.[0]?.text || '{}';
    let parsed = {};
    try { parsed = JSON.parse(text); } catch {
      // If Claude didn't return valid JSON, extract the reply
      parsed = { reply: text.slice(0, 200) };
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
    if (update.emotional_state) {
      narrativeState.emotional_state = update.emotional_state;
    }
    narrativeState.conversation_count++;

    // Update conversation memory
    conversation.recent_messages = contextMessages.slice(-10);
    // Compress to summary every 20 messages
    if (conversation.recent_messages.length >= 10) {
      const oldSummary = conversation.summary || '';
      const recentText = conversation.recent_messages.map(m => `${m.role}: ${m.content}`).join('\n');
      conversation.summary = oldSummary
        ? `${oldSummary}\n\nMore recently:\n${recentText}`
        : recentText;
      if (conversation.summary.length > 2000) {
        conversation.summary = conversation.summary.slice(-2000);
      }
      conversation.recent_messages = conversation.recent_messages.slice(-4);
    }

    await writeNarrativeState(narrativeState);
    await writeConversation(conversation);

    sendJson(res, 200, {
      reply:               cleanString(parsed.reply || '...').slice(0, 300),
      emotion:             parsed.emotion || 'neutral',
      body:                parsed.body || 'idle',
      vitals:              sanitizeVitals(parsed.vitals),
      narrative_state:     narrativeState,
      suggested_responses: Array.isArray(parsed.suggested_responses) ? parsed.suggested_responses.slice(0, 4) : [],
    });
  } catch (err) {
    console.error('Chat error:', err);
    sendJson(res, 500, { error: err.message });
  }
}

async function handleChatStatus(res) {
  sendJson(res, 200, { ok: !!anthropicKey, key_present: !!anthropicKey, model: chatModel });
}

async function handleResetNarrative(res) {
  const fresh = { bond_level: 0, chapter: 1, emotional_state: 'uncertain', memories_unlocked: [], memories_available: ['cold_feeling','someone_was_there','bright_light','a_voice','the_experiment','before_it_happened','who_i_was'], questions_player_asked: [], things_eli_shared: [], conversation_count: 0 };
  await writeNarrativeState(fresh);
  await writeConversation({ summary: '', recent_messages: [] });
  sendJson(res, 200, { ok: true });
}

function sanitizeVitals(v) {
  if (!v || typeof v !== 'object') return { bpm: 120, mood: 1 };
  return { bpm: Math.max(60, Math.min(180, Math.round(Number(v.bpm) || 120))), mood: Math.max(0, Math.min(5, Math.round(Number(v.mood) || 1))) };
}

// ─── Publish ──────────────────────────────────────────────────────────────────

async function handlePublish(res) {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const exec = promisify(execFile);

  try { await exec('git', ['add', '-A'], { cwd: root }); } catch {}
  try { await exec('git', ['commit', '-m', `publish: ${new Date().toISOString()}`], { cwd: root }); } catch {}

  try {
    await exec('git', ['push', 'origin', 'prototype-6'], { cwd: root });
  } catch (err) {
    sendJson(res, 500, { error: `Push failed: ${err.stderr || err.message}` });
    return;
  }

  try {
    const hook = await fetch(deployWebhook);
    sendJson(res, 200, { ok: true, pushed: true, webhook: hook.status });
  } catch {
    sendJson(res, 200, { ok: true, pushed: true, webhook: 'unreachable' });
  }
}

// ─── Router ───────────────────────────────────────────────────────────────────

createServer(async (req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'GET,POST,DELETE', 'Access-Control-Allow-Headers': 'Content-Type' });
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${port}`);
  const p   = url.pathname;

  try {
    if (req.method === 'GET'  && p === '/api/sequence')           { await getSequence(res);                   return; }
    if (req.method === 'POST' && p === '/api/sequence')           { await saveSequence(req, res);             return; }

    if (req.method === 'GET'  && p === '/api/scenes')             { await listScenes(res);                    return; }
    if (req.method === 'POST' && p === '/api/scenes/create')      { await createScene(req, res);              return; }
    if (req.method === 'POST' && p === '/api/scenes/rename')      { await renameScene(req, res);              return; }
    if (req.method === 'POST' && p === '/api/scenes/delete')      { await deleteScene(req, res);              return; }
    if (req.method === 'POST' && p === '/api/scenes/reorder')     { await reorderScenes(req, res);            return; }

    if (req.method === 'GET'  && p === '/api/scene')              { await getScene(req, res, url);            return; }
    if (req.method === 'POST' && p === '/api/scene')              { await saveScene(req, res);                return; }

    if (req.method === 'GET'  && p === '/api/scene/files')        { await listSceneFiles(req, res, url);      return; }
    if (req.method === 'POST' && p === '/api/scene/upload')       { await uploadSceneFile(req, res);          return; }
    if (req.method === 'POST' && p === '/api/scene/delete-file')  { await deleteSceneFile(req, res);          return; }
    if (req.method === 'POST' && p === '/api/shared/upload')      { await uploadSharedFile(req, res);         return; }

    if (req.method === 'POST' && p === '/api/lipsync/save')       { await saveLipSync(req, res);              return; }

    if (req.method === 'POST' && p === '/api/chat')               { await handleChat(req, res);               return; }
    if (req.method === 'GET'  && p === '/api/chat-status')        { await handleChatStatus(res);              return; }
    if (req.method === 'GET'  && p === '/api/narrative-state')    { sendJson(res, 200, await readNarrativeState()); return; }
    if (req.method === 'POST' && p === '/api/narrative/reset')    { await handleResetNarrative(res);          return; }

    if (req.method === 'POST' && p === '/api/publish')            { await handlePublish(res);                 return; }

    await serveStatic(req, res);
  } catch (err) {
    console.error(err);
    sendJson(res, 500, { error: err.message });
  }

}).listen(port, '0.0.0.0', () => {
  console.log(`\n  Elia Editor  →  http://localhost:${port}/editor.html`);
  console.log(`  Game preview →  http://localhost:${port}/index.html`);
  console.log(`  Phone        →  http://10.0.0.212:${port}/editor.html`);
  console.log(anthropicKey ? `\n  Claude AI ready (${chatModel})` : '\n  Chat disabled — add ANTHROPIC_API_KEY to .env');
  console.log('');
});
