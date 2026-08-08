# Changelog

## 0.1.4

### Improved — cleaner copy output for "Branch in new chat" forks

- **Stripped ChatGPT's `Branch · ` title noise.** Branched chats arrive titled `Branch · Branch · SEO for React Apps`; the copied block now shows just `SEO for React Apps`.
- **Rephrased the branch-split headers for the target model.** The ChatGPT-internal `#### Branched from Branch · …` label is replaced with plain framing — `Earlier context (carried over from a previous chat)` and `This branch continues from here` — so Claude/Gemini reads clean context instead of ChatGPT UI jargon.
- **Hardened the branch split point.** A very short first branch message (e.g. `hey`) now requires an exact match, so it can't accidentally split on an earlier turn.
- **Reasoning traces no longer leak into the copy.** ChatGPT's internal "thinking" is dropped from the pasted context block (it's still kept in the Markdown archive).

### Fixed

- **Works on `chat.openai.com`, not just `chatgpt.com`.** The backend origin is now derived from the page instead of being hardcoded, avoiding a cross-origin failure.
- **Export resume actually resumes now.** An interrupted "Export All" saves each downloaded conversation (and its files) as it goes; the next run skips what's already saved and merges everything into one complete ZIP. Adds the `unlimitedStorage` permission to hold the cache.

## 0.1.3

### Fixed — one-click "Copy for Claude/Gemini"

- **Copying a single chat no longer re-indexes your entire account.** `exportSingleConversation` now fetches the one conversation directly instead of paging your whole history first — the copy is near-instant.
- **Archived and Project chats can now be copied.** They previously returned an empty context block (silently) because the single-chat path forced an index that excluded them.
- **Regenerated branches no longer duplicate the shared history.** All-branch copy/export now prints the common history once under a "Shared history" heading, then only each branch's divergent tail. This drastically cuts token bloat.
- **Long chats no longer copy as empty.** When a conversation exceeds the character limit, the copy now keeps the most recent turns (trimmed to a clean message boundary) with a truncation marker, instead of dropping the whole thing.
- **The "Branch in new chat" divider is preserved even when a chat also has regenerated branches.** The branched-from split is applied to the shared history rather than being dropped.

### Changed

- Version is now single-sourced from the extension manifest (no more drift between the manifest and export metadata).
- The saved-progress button is now labelled honestly ("Clear saved progress …") — it clears interrupted-export bookkeeping; it does not resume.
