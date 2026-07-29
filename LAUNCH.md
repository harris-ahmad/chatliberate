# Launch checklist for ChatLiberate

## Reddit post (r/OpenAI, r/DataHoarder, r/ChatGPT)

**Title:** I built an open-source exporter that works on Business/Teams accounts (the thing OpenAI won't let you do)

**Body:**
OpenAI doesn't offer data export for ChatGPT Business/Teams. I read [this thread](https://www.reddit.com/r/OpenAI/comments/1pe3p9a/every_way_to_export_chatgpt_conversations_and/) and every tool had gaps — wrong JSON format, missing branches, no images, or required pasting bearer tokens.

So I built **ChatLiberate** — open source, MIT licensed:

- Works on **Business/Teams** (uses the same API the web app uses)
- Outputs official `conversations.json` (Memory Forge compatible)
- Preserves **all regenerated branches**
- Downloads **images and attachments**
- Chrome extension: **one click**, no DevTools
- CLI for automation

GitHub: [link]

Load the extension in 30 seconds:
1. Clone repo, `npm install && npm run build:extension`
2. chrome://extensions → Load unpacked → `apps/extension`
3. Open chatgpt.com → click icon → Export All

Would love feedback from Teams users who've been stuck.

## Hacker News

**Title:** Show HN: Open-source ChatGPT exporter for Business/Teams accounts

**First comment:** OpenAI blocks the standard export for workspace accounts. This uses /backend-api/ with your browser session. Local-first, no server.

## Product Hunt

Tagline: Export ALL your ChatGPT data — even on Business accounts OpenAI won't let you export

## Twitter/X

OpenAI won't let Business users export their chats.

So I built ChatLiberate — open source, one-click, works on every account type.

✅ Teams/Business
✅ conversations.json (Memory Forge compatible)  
✅ All branches + images

[GitHub link]

## Key differentiators to emphasize

1. Solves the exact Reddit thread pain points
2. OAI-compatible format (not exporter-extension JSON)
3. Full branch tree (not just visible path)
4. Zero-friction extension vs bearer token CLI tools
