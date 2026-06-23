# tinysend → herdr

A [herdr](https://herdr.dev) plugin that emails you when an agent blocks, finishes,
or fails — and lets you reply to that email to type an answer straight into the
blocked agent. Your phone's Mail app becomes the remote control for agents running
over SSH. Powered by [tinysend](https://tinysend.com).

## how it works

```
agent blocks ─▶ pane.agent_status_changed ─▶ notify.mjs reads the prompt,
             emails you from your tinysend mailbox, remembers message-id → pane
you reply (Gmail / Apple Mail) ─▶ tinysend mailbox receives it
watch.mjs polls inbound ─▶ matches reply.in_reply_to to the pane
             ─▶ pane.send_text + send_keys enter ─▶ agent unblocks
```

The reply comes back by polling the mailbox (the herdr socket is local), so no
inbound webhook or public URL is needed.

## setup

1. In tinysend, create a mailbox and a mailbox-scoped key (`sk_mbx_...`).
2. Install and configure:

```sh
herdr plugin install tiny-send/tinysend-herdr
cp .env.example "$(herdr plugin config-dir tinysend.herdr)/.env"   # then edit it
```

`.env`:

```sh
TINYSEND_KEY=sk_mbx_...
TINYSEND_MAILBOX_ID=mbx_...
NOTIFY_TO=you@example.com
NOTIFY_ON=blocked,done,failed
```

3. Open the reply-watcher pane once (keep it running):

```sh
herdr plugin pane open --plugin tinysend.herdr --entrypoint watcher
```

Tip: connect the tinysend mailbox to Apple Mail (one-tap profile) and you can read
and reply on your phone in the native Mail app.

## mute

```sh
herdr plugin action invoke toggle --plugin tinysend.herdr
```

Or bind a key in herdr:

```toml
[[keys.command]]
key = "prefix+shift+t"
type = "plugin_action"
command = "tinysend.herdr.toggle"
```

## notes

- Node 18+. One dependency: the `tinysend` SDK (installed at plugin install).
- Sends only on the statuses in `NOTIFY_ON`. Only `blocked` arms a reply-to-unblock.
- Replies match the original by `In-Reply-To` ↔ `Message-ID`; tags every send
  `channel=herdr` so you can filter them in tinysend.
