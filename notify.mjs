// Event hook: fires on pane.agent_status_changed. On a status we care about,
// emails you from the tinysend mailbox. For 'blocked', remembers the message-id
// -> pane so watch.mjs can route your reply back.
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

const paneId = event?.data?.pane_id ?? context?.focused_pane_id ?? context?.pane_id ?? null;
const agent = titleCase(event?.data?.display_agent ?? event?.data?.agent ?? context?.focused_pane_agent ?? 'agent');
const where = context?.workspace_label ?? context?.workspace_id ?? 'workspace';

const question = await paneRead(paneId);
const emoji = status === 'blocked' ? '⚠️' : status === 'failed' ? '✗' : '✅';

const body = [
  `${emoji} ${agent} is ${status} — ${where}`,
  '',
  question || '(no recent output captured)',
  '',
  status === 'blocked' ? 'Reply to this email and your answer is typed into the agent.' : '',
].join('\n').trim();

const ts = tinysend(key);
try {
  const sent = await ts.mailboxes.emails.create(
    mailboxId,
    {
      to_address: notifyTo,
      subject: `[${agent} ${status}] ${where}`,
      text_body: body,
      tags: [{ name: 'channel', value: 'herdr' }, { name: 'status', value: status }],
    },
    { idempotencyKey: `herdr:${paneId}:${status}:${event?.data?.at ?? ''}`.slice(0, 256) },
  );
  // only blocked agents are waiting on a reply
  if (status === 'blocked' && paneId && sent?.message_id) savePending(sent.message_id, paneId);
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
