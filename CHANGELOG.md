# Changelog

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
