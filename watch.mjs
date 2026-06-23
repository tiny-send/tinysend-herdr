// Long-running pane: polls the tinysend mailbox for inbound replies and types
// each one into the agent that asked. Match: reply.in_reply_to == the message-id
// notify.mjs saved for that pane. Open once: herdr plugin pane open --plugin tinysend.herdr --entrypoint watcher
import { loadDotEnv, config, tinysend, takePending, paneSendText, paneSendKeys } from './lib.mjs';

loadDotEnv();
const { key, mailboxId, notifyTo } = config();
if (!key || !mailboxId) {
  console.log('missing TINYSEND_KEY / TINYSEND_MAILBOX_ID — set them in the plugin config .env');
  process.exit(0);
}

const POLL_MS = Number(process.env.HERDR_POLL_MS || 5000);
const ts = tinysend(key);

console.log('tinysend replies — watching', mailboxId);
console.log(`notify → ${notifyTo || '(unset)'} · reply to unblock · poll ${POLL_MS}ms`);
console.log('');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

while (true) {
  try {
    const inbound = await ts.mailboxes.emails.list(mailboxId, { direction: 'inbound', status: 'received' });
    // oldest first so multi-turn replies land in order
    for (const summary of [...inbound].reverse()) {
      const email = await ts.mailboxes.emails.get(mailboxId, summary.id);
      const paneId = takePending(email.in_reply_to);
      if (!paneId) continue; // not a reply to one of our blocked-agent emails

      const answer = firstMeaningfulLine(email.text_body);
      if (answer) {
        await paneSendText(paneId, answer);
        await paneSendKeys(paneId, 'enter');
        console.log(`${stamp()} ↩ ${summary.from_address} → pane ${paneId}: ${truncate(answer)}`);
      }
      await ts.mailboxes.emails.update(mailboxId, summary.id, { status: 'read' });
    }
  } catch (err) {
    console.error(`${stamp()} poll error:`, err?.message || err);
  }
  await sleep(POLL_MS);
}

// strip quoted-reply lines (">", "On ... wrote:") and take the first real line
function firstMeaningfulLine(body) {
  if (!body) return '';
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('>') || /^On .*wrote:$/.test(line)) continue;
    return line;
  }
  return '';
}
function truncate(s) { return s.length > 60 ? s.slice(0, 57) + '…' : s; }
function stamp() { return new Date().toISOString().slice(11, 19); }
