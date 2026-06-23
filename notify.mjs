// Event hook: fires on pane.agent_status_changed. On a status in NOTIFY_ON,
// emails you a useful summary — which session, what it's doing/asking, and how
// to resume — then remembers message-id -> pane so your reply routes back.
import { loadDotEnv, config, modeEnabled, tinysend, paneRead, savePending } from './lib.mjs';

loadDotEnv();
if (!modeEnabled()) process.exit(0);

const { key, mailboxId, notifyTo, notifyOn } = config();
if (!key || !mailboxId || !notifyTo) {
  console.error('missing TINYSEND_KEY / TINYSEND_MAILBOX_ID / NOTIFY_TO');
  process.exit(0);
}

const event = readJson('HERDR_PLUGIN_EVENT_JSON');
const context = readJson('HERDR_PLUGIN_CONTEXT_JSON');

const status = (event?.data?.agent_status ?? '').toString().toLowerCase();
if (!status || !notifyOn.includes(status)) process.exit(0);

const paneId = event?.data?.pane_id ?? context?.focused_pane_id ?? null;
const agent = titleCase(event?.data?.agent ?? context?.focused_pane_agent ?? 'agent');
const space = context?.workspace_label ?? context?.workspace_id ?? 'workspace';
const tab = context?.tab_label ?? '';
const paneShort = paneId ? paneId.split(':').pop() : '';
const dir = shortHome(context?.focused_pane_cwd ?? context?.workspace_cwd ?? '');

// the recent pane buffer is the summary — strip TUI chrome, keep the tail
const recent = tailLines(await paneRead(paneId), 26);

const emoji = status === 'blocked' ? '⚠️' : status === 'failed' ? '✗' : '✅';
const verb = status === 'blocked' ? 'is blocked and waiting on you'
  : status === 'done' ? 'finished'
  : status === 'failed' ? 'failed'
  : `is ${status}`;
const resume = status === 'blocked'
  ? 'Reply to this email with your answer — it gets typed straight into the agent.'
  : 'Reply with your next instruction and it resumes this agent.';

const sessionLine = [space, tab && `tab ${tab}`, paneShort && `pane ${paneShort}`].filter(Boolean).join(' · ');
const subject = `${emoji} ${agent} ${status} · ${space}${tab ? '/' + tab : ''}`;
const body = [
  `${agent} ${verb}.`,
  `session: ${sessionLine}`,
  dir && `dir: ${dir}`,
  '',
  '— recent output —',
  recent || '(nothing captured)',
  '',
  resume,
].filter((l) => l !== false && l !== undefined).join('\n');

const ts = tinysend(key);
try {
  const sent = await ts.mailboxes.emails.create(mailboxId, {
    to_address: notifyTo,
    subject,
    text_body: body,
    tags: [
      { name: 'channel', value: 'herdr' },
      { name: 'status', value: status },
      ...(paneId ? [{ name: 'pane', value: paneId }] : []),
    ],
  });
  // remember the pane so watch.mjs can route your reply (works for blocked + done)
  if (paneId && sent?.message_id) savePending(sent.message_id, paneId);
} catch (err) {
  console.error('tinysend send failed:', err?.message || err);
  process.exit(0);
}

function readJson(name) {
  try { return JSON.parse(process.env[name] || '{}'); } catch { return {}; }
}
function titleCase(v) {
  const t = String(v).trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Agent';
}
function shortHome(p) {
  if (!p) return '';
  return process.env.HOME ? p.replace(process.env.HOME, '~') : p;
}
// keep the last N meaningful lines; drop pure box-drawing / blank lines
function tailLines(text, n) {
  if (!text) return '';
  const lines = text.split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !/^[\s─-╿·]+$/.test(l));
  return lines.slice(-n).join('\n');
}
