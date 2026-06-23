// shared helpers: config, mode state, pending map, the herdr socket client, tinysend.
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { Tinysend } from 'tinysend';

export const pluginRoot = dirname(fileURLToPath(import.meta.url));

// --- config (.env in HERDR_PLUGIN_CONFIG_DIR, falling back to the plugin dir) ---

export function loadDotEnv() {
  const paths = [];
  if (process.env.HERDR_PLUGIN_CONFIG_DIR) paths.push(join(process.env.HERDR_PLUGIN_CONFIG_DIR, '.env'));
  paths.push(join(pluginRoot, '.env'));
  for (const path of [...new Set(paths)]) {
    let content;
    try { content = readFileSync(path, 'utf8'); } catch { continue; }
    for (const raw of content.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      let val = line.slice(eq + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      if (key && process.env[key] === undefined) process.env[key] = val;
    }
  }
}

export function config() {
  const key = process.env.TINYSEND_KEY?.trim();
  const mailboxId = process.env.TINYSEND_MAILBOX_ID?.trim();
  const notifyTo = process.env.NOTIFY_TO?.trim();
  const notifyOn = (process.env.NOTIFY_ON || 'blocked,done,failed')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean);
  return { key, mailboxId, notifyTo, notifyOn };
}

export function tinysend(key) {
  return new Tinysend(key);
}

// --- mode state (enable/disable, a file the toggle action writes) ---

function stateDir() {
  if (process.env.HERDR_PLUGIN_STATE_DIR) return process.env.HERDR_PLUGIN_STATE_DIR;
  const home = process.env.XDG_STATE_HOME || (process.env.HOME ? join(process.env.HOME, '.local', 'state') : pluginRoot);
  return join(home, 'tinysend-herdr');
}

const modeFile = () => join(stateDir(), 'enabled');

export function modeEnabled() {
  try {
    const raw = readFileSync(modeFile(), 'utf8').trim().toLowerCase();
    return !['0', 'false', 'no', 'off', 'disabled'].includes(raw);
  } catch { return true; } // default on
}

export function setMode(enabled) {
  mkdirSync(dirname(modeFile()), { recursive: true });
  writeFileSync(modeFile(), enabled ? 'enabled\n' : 'disabled\n', 'utf8');
}

// --- pending map: outbound message-id -> pane id, so a reply finds its agent ---

const pendingFile = () => join(stateDir(), 'pending.json');

const stripBrackets = (s) => String(s || '').replace(/^<|>$/g, '').trim();

function readPending() {
  try { return JSON.parse(readFileSync(pendingFile(), 'utf8')); } catch { return {}; }
}
function writePending(map) {
  mkdirSync(dirname(pendingFile()), { recursive: true });
  writeFileSync(pendingFile(), JSON.stringify(map, null, 2), 'utf8');
}

export function savePending(messageId, paneId) {
  const key = stripBrackets(messageId);
  if (!key || !paneId) return;
  const map = readPending();
  map[key] = { paneId, at: new Date().toISOString() };
  writePending(map);
}

export function takePending(inReplyTo) {
  const key = stripBrackets(inReplyTo);
  if (!key) return null;
  const map = readPending();
  const hit = map[key];
  if (!hit) return null;
  delete map[key];
  writePending(map);
  return hit.paneId;
}

// --- herdr socket: newline-delimited JSON {id, method, params} -> {id, result|error} ---

let reqCounter = 0;

export function herdrCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const socketPath = process.env.HERDR_SOCKET_PATH;
    if (!socketPath) return reject(new Error('HERDR_SOCKET_PATH not set (run inside herdr)'));
    const id = `req_${Date.now()}_${reqCounter++}`;
    const client = net.connect(socketPath);
    let buf = '';
    const done = (fn, arg) => { try { client.end(); } catch {} fn(arg); };
    client.on('connect', () => client.write(JSON.stringify({ id, method, params }) + '\n'));
    client.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let msg; try { msg = JSON.parse(line); } catch { continue; }
        if (msg.id !== id) continue;
        if (msg.error) return done(reject, new Error(`${msg.error.code}: ${msg.error.message}`));
        return done(resolve, msg.result);
      }
    });
    client.on('error', reject);
  });
}

export async function paneRead(paneId, lines = 120) {
  if (!paneId) return '';
  try {
    const res = await herdrCall('pane.read', { pane_id: paneId, source: 'recent', lines });
    // result shape isn't strictly specified; pull whatever text-ish field is present.
    return (res?.text ?? res?.content ?? res?.lines?.join?.('\n') ?? '').toString().trim();
  } catch { return ''; }
}

export const paneSendText = (paneId, text) => herdrCall('pane.send_text', { pane_id: paneId, text });
export const paneSendKeys = (paneId, keys) => herdrCall('pane.send_keys', { pane_id: paneId, keys });
