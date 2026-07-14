// Launcher for the Elia editor.
//
//   npm start   →  1. stops any stale server holding the port
//                  2. starts the server (auto-restarts it if it crashes)
//                  3. opens the editor in your browser once it's ready
//
// The server itself lives in local-server.mjs and can still be run directly
// (that's what the Dockerfile does).

import { spawn, execSync } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root      = fileURLToPath(new URL('.', import.meta.url));
const port      = Number(process.env.PORT || 4179);
const editorUrl = `http://localhost:${port}/editor.html`;

let child        = null;
let shuttingDown = false;
let restarts     = 0;
let opened       = false;

// 1 — Free the port. A stale server from an earlier session is the #1 cause
// of "the editor is empty" — it serves old code that can't see current data.
function freePort() {
  try {
    const out = execSync(`lsof -ti :${port}`, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'ignore'] }).trim();
    if (!out) return;
    for (const pid of out.split('\n')) {
      const n = Number(pid);
      if (n && n !== process.pid) { try { process.kill(n, 'SIGTERM'); } catch {} }
    }
    console.log(`  Stopped stale server on port ${port}`);
    execSync('sleep 0.6');
  } catch {} // lsof exits non-zero when the port is free — that's fine
}

// 2 — Run the server, restarting on crashes (up to 5 times).
function startServer() {
  child = spawn(process.execPath, [join(root, 'local-server.mjs')], { stdio: 'inherit', env: process.env });
  keepAwake(child.pid);
  child.on('exit', (code, signal) => {
    if (shuttingDown || code === 0) process.exit(code || 0);
    if (++restarts > 5) {
      console.error('\n  Server crashed 5 times in a row — check the errors above.\n');
      process.exit(1);
    }
    console.log(`\n  Server exited unexpectedly (${code ?? signal}) — restarting…\n`);
    setTimeout(startServer, 1000);
  });
}

// Keep the Mac awake while the server runs, so phones on the WiFi can always
// reach it. caffeinate -w ties itself to the server's lifetime: quit the
// server and normal sleep behavior returns. (-i no idle sleep, -s no system
// sleep while on AC power. The display may still sleep — that's fine.)
function keepAwake(pid) {
  if (process.platform !== 'darwin' || !pid) return;
  try {
    const p = spawn('caffeinate', ['-i', '-s', '-w', String(pid)], { stdio: 'ignore', detached: true });
    p.on('error', () => {});
    p.unref();
    console.log('  Mac will stay awake while the server is running (display may still sleep)');
  } catch {}
}

// 3 — Open the editor once the server answers.
async function waitReady(timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const res = await fetch(`http://localhost:${port}/api/version`);
      if (res.ok) return true;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  return false;
}

function openBrowser(url) {
  const cmd = process.platform === 'darwin' ? 'open'
            : process.platform === 'win32'  ? 'start'
            : 'xdg-open';
  try {
    const p = spawn(cmd, [url], { stdio: 'ignore', detached: true, shell: process.platform === 'win32' });
    p.on('error', () => {});
    p.unref();
  } catch {}
}

process.on('SIGINT',  () => { shuttingDown = true; if (child) child.kill('SIGTERM'); process.exit(0); });
process.on('SIGTERM', () => { shuttingDown = true; if (child) child.kill('SIGTERM'); process.exit(0); });

freePort();
startServer();
if (await waitReady()) {
  if (!opened) { opened = true; openBrowser(editorUrl); }
} else {
  console.error(`  Server did not become ready — open ${editorUrl} manually once it does.`);
}
