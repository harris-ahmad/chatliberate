# Contributing to ChatLiberate

Thanks for helping out. ChatLiberate exports **all** of a user's ChatGPT history
(including Business/Teams) and copies conversation context into other LLMs.

## Read this first: one file is generated

`apps/extension/content.js` is **build output**, not source. It is produced by
`scripts/build-extension.mjs` (esbuild), which bundles
`apps/extension/src/content.js` together with `packages/core/dist`.

It is committed to the repo so the extension can be loaded unpacked without a
build step — but **editing it by hand does not work**. The next
`npm run build:extension` regenerates it and your change disappears silently:
no error, no merge conflict, no failing test.

If you change logic, change it in **source**:

| What you want to change | Where it actually lives |
| --- | --- |
| Export engine, API calls, auth, rate limiting, formatting, branches | `packages/core/src/*.ts` |
| In-page UI: buttons, copy flow, resume cache, messaging | `apps/extension/src/content.js` |
| Popup UI | `apps/extension/popup.{html,css,js}` |
| Manifest, permissions | `apps/extension/manifest.json` |
| CLI | `apps/cli/bin/chatliberate.js` |
| Generated bundle — **never edit** | `apps/extension/content.js` |

Note that `packages/core` is shared by **both** the extension and the CLI, so a
fix there usually fixes both surfaces at once. That is normally what you want.

## Repo layout

```
packages/core/        TypeScript export engine (tsup -> dist/, consumed by both apps)
apps/extension/       Chrome MV3 extension  (src/ = source, content.js = generated)
apps/cli/             Node CLI
scripts/              build-extension.mjs (esbuild bundle + icon rasterization)
```

## Build and test

```bash
npm install
npm test                  # builds core, then runs the core test suite
npm run build:extension   # rebuilds packages/core AND regenerates apps/extension/content.js
```

After any source change that affects the extension, run `npm run build:extension`
and **commit the regenerated `apps/extension/content.js` in the same commit** as
the source change, so source and artifact never drift apart. CI enforces this.

`npm run build:extension` also rasterizes icons from `icons/icon.svg` using
`rsvg-convert`. If librsvg is not installed it keeps the existing PNGs and warns —
that is fine and expected.

## Security-sensitive areas

This extension holds a ChatGPT session bearer JWT and the user's entire
conversation history. A leaked token means full account takeover. Take extra care
in these places, and please call out the security reasoning in your PR:

- `packages/core/src/auth.ts` — token handling, header construction, origin checks
- `packages/core/src/api.ts` — every outbound request; which origins receive credentials
- `apps/extension/manifest.json` — permissions and host permissions
- the resume cache in `apps/extension/src/content.js` — what gets persisted to `chrome.storage.local`

Rules of thumb:
- Never attach `Authorization` or `chatgpt-account-id` to a non-ChatGPT origin.
  File downloads use pre-signed URLs that authenticate themselves via query string.
- Prefer exact hostname checks over `endsWith` / `includes` / substring matching.
- Never log a token, and never put one in a URL query string.
- Do not add a permission without saying in the PR why it is required.

## Pull requests

- Keep each PR to one concern.
- Make the description map 1:1 to the diff. If a bullet does not correspond to a
  hunk, drop the bullet. Reviewers read diffs, not prose — an inaccurate
  description costs trust and review time.
- Run `npm test` before pushing.
- Add a test when you fix a bug, where it is practical.
- Do not bump the version or edit `CHANGELOG.md` — the maintainer handles releases.

## Reporting a vulnerability

Please do not open a public issue for an exploitable security bug. Open a GitHub
security advisory on the repo, or contact the maintainer directly, so it can be
fixed before disclosure.
