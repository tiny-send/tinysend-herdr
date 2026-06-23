// Event hook: fires on pane.agent_status_changed. On a status in NOTIFY_ON,
// emails you a useful summary — what the agent is asking / just did (LLM one-liner
// when ANTHROPIC_API_KEY is set, cleaned scrollback otherwise) and how to resume —
// then remembers message-id -> pane so your reply routes back.
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

const raw = await paneRead(paneId);
// an LLM one-liner is both the summary AND what identifies this agent; fall back
// to a cleaned scrollback tail when no ANTHROPIC_API_KEY is configured.
const summary = (await summarize(raw, agent, status)) || tailLines(raw, 14) || '(no recent output)';

const emoji = status === 'blocked' ? '⚠️' : status === 'failed' ? '✗' : '✅';
const headline = status === 'blocked' ? `${agent} needs you`
  : status === 'done' ? `${agent} finished`
  : status === 'failed' ? `${agent} failed`
  : `${agent} is ${status}`;
const resume = status === 'blocked'
  ? 'Reply to this email with your answer — it gets typed straight into the agent.'
  : 'Reply with your next instruction and it resumes this agent.';

const sessionLine = [space, tab && `tab ${tab}`, paneShort && `pane ${paneShort}`, dir].filter(Boolean).join(' · ');
const subject = `${emoji} ${agent} ${status} · ${space}${tab ? '/' + tab : ''}`;
const body = [
  `${emoji} ${headline}.`,
  '',
  summary,
  '',
  `session: ${sessionLine}`,
  '',
  resume,
].join('\n');

// HTML twin — inline styles (email clients strip <style>); summary in a code block
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const htmlBody = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;font-size:15px;line-height:1.5;color:#111;max-width:640px">
<p style="font-size:17px;font-weight:600;margin:0 0 14px">${emoji} ${esc(headline)}</p>
<pre style="background:#f6f6f7;border:1px solid #e5e5e7;border-radius:8px;padding:12px 14px;margin:0 0 14px;font-size:13px;line-height:1.45;white-space:pre-wrap;word-break:break-word;font-family:ui-monospace,SFMono-Regular,Menlo,monospace">${esc(summary)}</pre>
<p style="margin:0 0 14px;color:#888;font-size:12px">${esc(sessionLine)}</p>
<p style="margin:0;color:#333;font-size:14px">↩ ${esc(resume)}</p>
</div>`;

const ts = tinysend(key);
try {
  const sent = await ts.mailboxes.emails.create(mailboxId, {
    to_address: notifyTo,
    subject,
    text_body: body,
    html_body: htmlBody,
    tags: [
      { name: 'channel', value: 'herdr' },
      { name: 'status', value: status },
      ...(paneId ? [{ name: 'pane', value: paneId }] : []),
    ],
  });
  if (paneId && sent?.message_id) savePending(sent.message_id, paneId);
} catch (err) {
  console.error('tinysend send failed:', err?.message || err);
  process.exit(0);
}

// --- LLM summary (Claude Haiku) — turns raw scrollback into one useful line ---
async function summarize(text, agentName, st) {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey || !text || text.trim().length < 20) return null;
  const ask = st === 'blocked'
    ? `is STOPPED waiting for the user. In one short sentence say plainly what it is asking the user to decide. If it offered options, list them after on one line.`
    : st === 'failed'
      ? `just FAILED. In one short sentence say plainly what it was doing and what went wrong.`
      : `just FINISHED a task. In one short sentence say plainly what it accomplished.`;
  const prompt = `This is the recent terminal output of a coding agent ("${agentName}") that ${ask}\nBe specific and concrete (name the file/feature). No preamble, no markdown.\n\n----- terminal -----\n${text.slice(-5000)}`;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-api-key': apiKey, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({
        model: process.env.ANTHROPIC_MODEL?.trim() || 'claude-haiku-4-5-20251001',
        max_tokens: 250,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    if (!r.ok) { console.error('summarize http', r.status); return null; }
    const j = await r.json();
    return j?.content?.find?.((b) => b.type === 'text')?.text?.trim() || null;
  } catch (e) {
    console.error('summarize failed:', e?.message || e);
    return null;
  }
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
// cleaned scrollback tail — drop Claude Code chrome, diffs, box-drawing, blanks
function tailLines(text, n) {
  if (!text) return '';
  const noise = /^(\s*\d+\s*[+-]|Ran \d+ shell|⏺|✻|❯|⎿|▸|▶|bypass permissions|esc to interrupt|Auto-update|Tip:|Brewed for|Found \d+ |Enter to select|↑\/↓)/;
  const lines = text.split(/\r?\n/)
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l.trim() && !noise.test(l.trim()) && !/^[\s─-╿·|]+$/.test(l));
  return lines.slice(-n).join('\n');
}
