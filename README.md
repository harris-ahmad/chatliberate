<p align="center">
  <img src="assets/logo-512.png" alt="ChatLiberate logo" width="120" height="120" />
</p>

<h1 align="center">ChatLiberate</h1>

<p align="center">
  <strong>Your chats. Your data. Every account.</strong><br />
  The open-source ChatGPT exporter that actually works on Business &amp; Teams.
</p>

<p align="center">
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-MIT-green.svg" alt="License: MIT" /></a>
  <a href="PRIVACY.md"><img src="https://img.shields.io/badge/Privacy-Local--first-0d8c6d" alt="Privacy: Local-first" /></a>
  <img src="https://img.shields.io/badge/Chrome-Extension-10a37f?logo=googlechrome&logoColor=white" alt="Chrome Extension" />
  <img src="https://img.shields.io/badge/CLI-Node.js-339933?logo=nodedotjs&logoColor=white" alt="CLI" />
</p>

OpenAI blocks data export for [ChatGPT Business and Teams](https://www.reddit.com/r/OpenAI/comments/1pe3p9a/every_way_to_export_chatgpt_conversations_and/) users. Third-party tools produce incompatible formats. Images get lost. Regenerated replies vanish. ChatLiberate fixes all of it.

## What it solves

| Problem | ChatLiberate |
|---------|-------------|
| **Business/Teams accounts can't export** | Uses ChatGPT's own API with your browser session — no Settings → Export needed |
| **Memory Forge rejects exporter JSON** | Outputs official `conversations.json` format |
| **Regenerated branches disappear** | Preserves every branch in the conversation tree |
| **Images not included in exports** | Downloads DALL-E images, uploads, and canvas files |
| **Project chats missing** | Exports GPT Projects and archived conversations |
| **Manual bearer token hell** | Chrome extension: one click, zero copy-paste |

## Quick start (Chrome extension)

1. Clone and build:
   ```bash
   git clone https://github.com/harris-ahmad/chatliberate.git
   cd chatliberate
   npm install
   npm run build
   node scripts/build-extension.mjs
   ```

2. Load in Chrome:
   - Go to `chrome://extensions`
   - Enable **Developer mode**
   - Click **Load unpacked** → select `apps/extension/`

3. Open [chatgpt.com](https://chatgpt.com), log in, click the ChatLiberate icon → **Export All Conversations**

You get a ZIP with:
- `INDEX.md` — searchable list of every chat (grouped by project)
- `conversations.json` — OpenAI-compatible, works with Memory Forge, context-pack, Obsidian plugins
- `markdown/` — human-readable exports with all branches
  - `markdown/projects/<project>/` — chats that belong to a GPT Project
  - `markdown/archived/` — archived chats
- `files/` — images and attachments (linked from markdown)
- `export-stats.json` — metadata

## CLI (for power users & automation)

```bash
# Get bearer token: DevTools → Network → filter "conversations" → copy Authorization header
export CHATGPT_BEARER_TOKEN="eyJ..."

npx chatliberate -o ./my-backup
```

### CLI options

```
--bearer <token>       Bearer token (or CHATGPT_BEARER_TOKEN env)
--account-id <id>      Teams/Business account ID (auto-detected)
-o, --output <dir>     Output directory (default: ./chatliberate-export)
--format <fmt>         json | markdown | both (default: both)
--no-archived          Skip archived conversations
--no-projects          Skip project conversations
--no-files             Skip image/file downloads
--throttle <ms>        API delay in ms (default: 1500)
```

## Teams / Business accounts

Personal accounts use Settings → Data Controls → Export. **Business and Teams accounts don't have this option** — that's the whole point of this tool.

ChatLiberate works because it calls the same `/backend-api/` endpoints the ChatGPT web app uses. If you can see your chats in the browser, you can export them.

For CLI on Teams accounts, the tool auto-detects your `chatgpt-account-id` header. If detection fails:

```bash
# Find account ID in DevTools → Application → Cookies → _account
chatliberate --bearer "eyJ..." --account-id "your-account-uuid"
```

## Why this exists

From [this Reddit thread](https://www.reddit.com/r/OpenAI/comments/1pe3p9a/every_way_to_export_chatgpt_conversations_and/):

> *"For teams/business accounts you have to find a way to actually get the export from OAI unfortunately."* — Memory Forge team

> *"OpenAI doesn't send me an email of backups... every road ends with a cliff for me"* — frustrated user

> *"I don't think any of them do [preserve images]"* — on export tools

ChatLiberate is the answer: open source, local-first, works everywhere.

## Architecture

```
packages/core/     @chatliberate/core — export engine (TypeScript)
apps/extension/    Chrome MV3 extension (one-click export)
apps/cli/          Node.js CLI (headless, scriptable)
```

The core library:
- Authenticates via `/api/auth/session` (extension) or bearer token (CLI)
- Paginates `/backend-api/conversations` including archived
- Fetches project chats via `/backend-api/gizmos/`
- Downloads files via `/backend-api/files/download/`
- Traverses the full conversation DAG (all branches, not just `children[0]`)

## Comparison

| Tool | Business/Teams | OAI JSON | Branches | Images | One-click |
|------|---------------|----------|----------|--------|-----------|
| OpenAI Settings Export | No | Yes | Yes | Partial | No (email wait) |
| ChatGPT Exporter ext | Partial | No | No | No | Yes |
| export-chatgpt CLI | Yes | No | No | Yes | No (token paste) |
| Memory Forge | Needs OAI export | Import only | ? | ? | No |
| **ChatLiberate** | **Yes** | **Yes** | **Yes** | **Yes** | **Yes** |

## Development

```bash
npm install
npm run build          # Build core + CLI
node scripts/build-extension.mjs   # Bundle extension
npm test               # Run tests
```

## Legal

This tool accesses ChatGPT's unofficial backend API — the same endpoints the web UI uses. You are exporting **your own data** for personal backup and portability (GDPR Article 20). Use responsibly. OpenAI's API may change without notice.

## Contributing

PRs welcome. Priority areas:
- Firefox extension
- Resume/pause for interrupted exports
- Import into Claude/Gemini
- Better icon assets

## License

MIT — your data, your rules.
