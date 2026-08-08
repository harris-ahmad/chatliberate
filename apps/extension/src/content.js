import {
  exportAllConversations,
  exportSingleConversation,
  fetchMemories,
  fetchCustomInstructions,
  fetchSessionFromPage,
  memoriesToMarkdown,
  customInstructionsToMarkdown,
  toMarkdownExportLayout,
  toOpenAIExportFormat,
  toContextBlock,
  chunkMarkdown,
  countBranches,
} from '@chatliberate/core';
import { zipSync, strToU8 } from 'fflate';

function getCurrentConversationId() {
  const match = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
  return match?.[1];
}

// ---- Resume cache -----------------------------------------------------------
// Each downloaded conversation is persisted to chrome.storage.local under its
// own key so an interrupted "Export All" can pick up where it left off. Binary
// files are base64-encoded. Requires the "unlimitedStorage" permission.
const RESUME_PREFIX = 'resume:conv:';

function u8ToBase64(u8) {
  let s = '';
  const CHUNK = 0x8000;
  for (let i = 0; i < u8.length; i += CHUNK) {
    s += String.fromCharCode.apply(null, u8.subarray(i, i + CHUNK));
  }
  return btoa(s);
}

function base64ToU8(b64) {
  const bin = atob(b64);
  const u8 = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
  return u8;
}

async function resumeKeys() {
  const all = await chrome.storage.local.get(null);
  return Object.keys(all).filter((k) => k.startsWith(RESUME_PREFIX));
}

async function loadResumeCache() {
  const all = await chrome.storage.local.get(null);
  const convs = [];
  const files = new Map();
  const fileMeta = new Map();
  for (const [key, val] of Object.entries(all)) {
    if (!key.startsWith(RESUME_PREFIX) || !val?.conv) continue;
    convs.push(val.conv);
    for (const [fileId, b64] of Object.entries(val.files ?? {})) {
      if (!files.has(fileId)) files.set(fileId, base64ToU8(b64));
    }
    for (const [fileId, meta] of Object.entries(val.fileMeta ?? {})) {
      if (!fileMeta.has(fileId)) fileMeta.set(fileId, meta);
    }
  }
  const ids = convs.map((c) => c.conversation_id ?? c.id).filter(Boolean);
  return { convs, files, fileMeta, ids };
}

async function persistDownloadedConversation({ conversation, files, fileMeta }) {
  const id = conversation.conversation_id ?? conversation.id;
  if (!id) return;
  const filesObj = {};
  for (const [fileId, data] of files) filesObj[fileId] = u8ToBase64(data);
  const metaObj = {};
  for (const [fileId, meta] of fileMeta) metaObj[fileId] = meta;
  try {
    await chrome.storage.local.set({
      [RESUME_PREFIX + id]: { conv: conversation, files: filesObj, fileMeta: metaObj, savedAt: Date.now() },
    });
  } catch (err) {
    // Out of quota or similar — resume just won't cover this chat; don't abort the export.
    console.warn('[ChatLiberate] could not persist resume state for', id, err);
  }
}

async function clearResumeCache() {
  const keys = await resumeKeys();
  if (keys.length) await chrome.storage.local.remove(keys);
  // Drop the legacy progress key from older versions too.
  await chrome.storage.local.remove('exportProgress');
}

/** Merge previously-saved conversations with the freshly downloaded ones. */
function mergeExportResults(cache, fresh) {
  const files = new Map(fresh.files);
  for (const [k, v] of cache.files) if (!files.has(k)) files.set(k, v);
  const fileMeta = new Map(fresh.fileMeta);
  for (const [k, v] of cache.fileMeta) if (!fileMeta.has(k)) fileMeta.set(k, v);

  // Fresh wins on id collisions (shouldn't happen — cached ids are skipped).
  const byId = new Map();
  for (const c of cache.convs) byId.set(c.conversation_id ?? c.id, c);
  for (const c of fresh.conversations) byId.set(c.conversation_id ?? c.id, c);
  const conversations = [...byId.values()];

  return {
    conversations,
    files,
    fileMeta,
    index: fresh.index ?? [],
    stats: {
      conversationCount: conversations.length,
      fileCount: files.size,
      branchCount: conversations.reduce((n, c) => n + countBranches(c), 0),
      archivedCount: conversations.filter((c) => c.is_archived === true).length,
      projectCount: conversations.filter((c) => c.gizmo_id).length,
    },
  };
}

/**
 * ChatGPT's "Branch in new chat" shows a divider like
 * "Branched from Branch · SEO for React Apps". That fork is usually ONE
 * linear path in the API — detect the divider in the DOM so we can split
 * shared history vs this branch's new turns when copying.
 */
function detectChatBranchFromDom() {
  const candidates = Array.from(document.querySelectorAll('a, button, span, div'));
  const divider = candidates.find((el) => {
    const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
    return /^Branched from\b/i.test(text) && text.length < 160;
  });
  if (!divider) return null;

  const label = (divider.textContent || '').replace(/\s+/g, ' ').trim();

  // First user bubble after the divider in document order
  const all = Array.from(document.querySelectorAll('div[data-message-author-role], [data-message-author-role]'));
  let passedDivider = false;
  let firstUserText = '';
  for (const el of all) {
    if (divider === el || divider.contains(el) || el.contains(divider)) {
      passedDivider = true;
      continue;
    }
    // Compare document position
    const pos = divider.compareDocumentPosition(el);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) {
      passedDivider = true;
    }
    if (!passedDivider && !(pos & Node.DOCUMENT_POSITION_FOLLOWING)) continue;
    const role = el.getAttribute('data-message-author-role');
    if (role === 'user') {
      firstUserText = (el.innerText || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (firstUserText) break;
    }
  }

  // Fallback: walk next siblings from divider's block
  if (!firstUserText) {
    let node = divider.parentElement;
    for (let depth = 0; depth < 6 && node; depth++, node = node.parentElement) {
      let sib = node.nextElementSibling;
      while (sib) {
        const user = sib.querySelector?.('[data-message-author-role="user"]') ||
          (sib.getAttribute?.('data-message-author-role') === 'user' ? sib : null);
        if (user) {
          firstUserText = (user.innerText || user.textContent || '').replace(/\s+/g, ' ').trim();
          if (firstUserText) break;
        }
        sib = sib.nextElementSibling;
      }
      if (firstUserText) break;
    }
  }

  return { label, firstUserText: firstUserText || undefined };
}

function downloadBlob(filename, blob) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

async function buildZip(result, extras = {}) {
  const files = {};

  // 1. Official OAI-format JSON (Memory Forge / context-pack compatible)
  const oai = toOpenAIExportFormat(result.conversations);
  files['conversations.json'] = JSON.stringify(oai, null, 2);

  // 2. Markdown tree — projects/archived folders + Obsidian filenames
  const layout = toMarkdownExportLayout(result.conversations, {
    fileMeta: result.fileMeta,
    index: result.index,
  });
  files['INDEX.md'] = layout.indexMarkdown;

  for (const [path, md] of layout.files) {
    files[path] = md;

    // Large conversation: also write chunked versions beside the original file
    const chunks = chunkMarkdown(md, 320_000);
    if (chunks.length > 1) {
      chunks.forEach((chunk, i) => {
        files[path.replace(/\.md$/, `-part${i + 1}.md`)] = chunk;
      });
    }
  }

  // 3. Downloaded images / attachments
  for (const [fileId, data] of result.files) {
    const meta = result.fileMeta.get(fileId);
    const ext = meta?.fileName ? meta.fileName.split('.').pop() : 'bin';
    files[`files/${fileId}.${ext}`] = data;
  }

  // 4. Memories
  if (extras.memories?.length) {
    files['memory.json'] = JSON.stringify(extras.memories, null, 2);
    files['memory.md'] = memoriesToMarkdown(extras.memories);
  }

  // 5. Custom instructions
  if (extras.customInstructions) {
    files['custom-instructions.json'] = JSON.stringify(extras.customInstructions, null, 2);
    files['custom-instructions.md'] = customInstructionsToMarkdown(extras.customInstructions);
  }

  // Build fileExtMap for context block
  const fileExtMap = new Map();
  for (const [fileId, meta] of result.fileMeta) {
    let ext = '';
    if (meta.fileName) {
      const dot = meta.fileName.lastIndexOf('.');
      if (dot !== -1) ext = meta.fileName.slice(dot);
    } else if (meta.contentType) {
      const mime = { 'image/jpeg': '.jpeg', 'image/jpg': '.jpeg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
      ext = mime[meta.contentType.split(';')[0].trim()] ?? '';
    }
    if (ext) fileExtMap.set(fileId, ext);
  }

  // 6. Import-ready context block for Claude/Gemini
  const contextBlock = toContextBlock(result.conversations, {
    maxChars: 60_000,
    fileExtMap,
    includeAllBranches: Boolean(extras.includeBranches),
  });
  files['import-context-for-claude-gemini.md'] = contextBlock;

  // 7. Stats
  const projectNames = new Set(
    layout.entries.filter((e) => e.projectName).map((e) => e.projectName),
  );
  files['export-stats.json'] = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      ...result.stats,
      tool: 'chatliberate',
      version: chrome.runtime.getManifest().version,
      accountType: document.cookie.includes('_account=') ? 'teams/business' : 'personal',
      memoriesCount: extras.memories?.length ?? 0,
      hasCustomInstructions: Boolean(extras.customInstructions?.about_user || extras.customInstructions?.about_model),
      projectNames: [...projectNames],
      indexEntries: layout.entries.length,
    },
    null,
    2,
  );

  const zipInput = {};
  for (const [name, content] of Object.entries(files)) {
    zipInput[name] = typeof content === 'string' ? strToU8(content) : content;
  }
  const zipped = zipSync(zipInput, { level: 0 });
  return new Blob([zipped], { type: 'application/zip' });
}

// Broadcast to the popup (if open) and the background worker (badge). Swallow
// "no receiver" rejections — they're expected when the popup is closed.
function broadcast(payload) {
  try {
    chrome.runtime.sendMessage(payload)?.catch?.(() => {});
  } catch {
    // ignore
  }
}

function sendProgress(event) {
  broadcast({
    type: 'CHATLIBERATE_PROGRESS',
    message: event.message,
    current: event.current,
    total: event.total,
  });
}

async function runExport(mode, options) {
  const session = await fetchSessionFromPage();

  // Fetch memories + custom instructions in parallel (non-fatal if they fail)
  const [memories, customInstructions] = await Promise.all([
    fetchMemories(session).catch(() => []),
    fetchCustomInstructions(session).catch(() => null),
  ]);

  let result;

  if (mode === 'current') {
    const id = getCurrentConversationId();
    if (!id) throw new Error('Open a conversation first (URL should contain /c/)');
    result = await exportSingleConversation(session, id, {
      downloadFiles: options.downloadImages,
      downloadImages: options.downloadImages,
      onProgress: sendProgress,
    });
  } else {
    // Resume: reuse conversations saved by a previous (interrupted) run, and
    // only download what's still missing. Each new chat is persisted as it
    // completes, so a crash/close mid-export loses nothing.
    const cache = await loadResumeCache();

    const fresh = await exportAllConversations(session, {
      includeArchived: options.includeArchived,
      includeProjects: options.includeProjects,
      downloadFiles: options.downloadImages,
      downloadImages: options.downloadImages,
      throttleMs: 1200,
      skipIds: cache.ids,
      onProgress: sendProgress,
      onConversationDownloaded: persistDownloadedConversation,
    });

    result = cache.convs.length ? mergeExportResults(cache, fresh) : fresh;

    // Export finished successfully — clear the resume cache.
    await clearResumeCache();
  }

  const zip = await buildZip(result, {
    memories,
    customInstructions,
    includeBranches: options.includeBranches,
  });
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(`chatliberate-export-${date}.zip`, zip);

  return { ok: true, stats: { ...result.stats, memoriesCount: memories.length } };
}

async function copyContextForCurrent(options) {
  const id = getCurrentConversationId();
  if (!id) throw new Error('Open a conversation first');

  const session = await fetchSessionFromPage();
  const result = await exportSingleConversation(session, id, {
    downloadFiles: false,
    downloadImages: false,
  });

  const fileExtMap = new Map();
  for (const [fileId, meta] of result.fileMeta) {
    const mime = { 'image/jpeg': '.jpeg', 'image/png': '.png', 'image/gif': '.gif', 'image/webp': '.webp' };
    const ext = (meta.fileName ? meta.fileName.slice(meta.fileName.lastIndexOf('.')) : mime[meta.contentType?.split(';')[0].trim()]) ?? '';
    if (ext) fileExtMap.set(fileId, ext);
  }

  const chatBranch = detectChatBranchFromDom();

  const context = toContextBlock(result.conversations, {
    maxChars: 120_000,
    fileExtMap,
    includeAllBranches: Boolean(options?.includeBranches),
    chatBranch: chatBranch || undefined,
  });

  // Count unique images referenced in the conversation
  const imgPattern = /\[image attached separately\]/g;
  const imageCount = (context.match(imgPattern) || []).length;
  const branchCount = result.conversations.reduce(
    (n, c) => n + (options?.includeBranches ? countBranches(c) : 1),
    0,
  );
  const dagBranches = options?.includeBranches && context.includes('regenerated branches preserved');
  const chatFork = Boolean(chatBranch) && context.includes('This branch continues from here');

  return {
    ok: true,
    context,
    imageCount,
    includeAllBranches: Boolean(options?.includeBranches),
    branchNote: dagBranches || chatFork,
    branchCount: dagBranches ? branchCount : chatFork ? 2 : branchCount,
    chatFork,
    chatBranchLabel: chatBranch?.label,
  };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'CHATLIBERATE_EXPORT') {
    runExport(msg.mode, msg.options)
      .then((result) => {
        // Tell the background worker so the badge resolves even if the popup is closed.
        broadcast({ type: 'CHATLIBERATE_DONE', stats: result.stats });
        sendResponse(result);
      })
      .catch((err) => {
        broadcast({ type: 'CHATLIBERATE_ERROR', error: err.message });
        sendResponse({ ok: false, error: err.message });
      });
    return true;
  }

  if (msg.type === 'CHATLIBERATE_COPY_CONTEXT') {
    copyContextForCurrent(msg.options)
      .then((result) => sendResponse(result))
      .catch((err) => {
        console.error('[ChatLiberate] copyContext error:', err);
        sendResponse({ ok: false, error: err?.message ?? String(err) });
      });
    return true;
  }

  if (msg.type === 'CHATLIBERATE_PRINT') {
    const id = getCurrentConversationId();
    if (id) {
      // 1. Click every "Show more" button to expand truncated user messages
      const expandSelectors = [
        'button[data-testid="show-more-button"]',
        'button.show-more',
        'button[aria-label="Show more"]',
        // ChatGPT renders truncated messages inside a max-h container with a gradient overlay;
        // the expand button sits right after the truncated content div
      ];
      for (const sel of expandSelectors) {
        document.querySelectorAll(sel).forEach((btn) => btn.click());
      }
      // Generic fallback: click any button whose visible text is exactly "Show more"
      document.querySelectorAll('button').forEach((btn) => {
        if (btn.textContent.trim().toLowerCase() === 'show more') btn.click();
      });

      // 2. Also force-expand any element using max-height truncation (ChatGPT wraps long
      //    user messages in a div with a hard max-h via Tailwind, e.g. max-h-[something])
      document.querySelectorAll('[class*="max-h-"]').forEach((el) => {
        // Only touch elements that look like truncated message bodies
        if (el.scrollHeight > el.clientHeight + 4) {
          el.style.setProperty('max-height', 'none', 'important');
          el.style.setProperty('overflow', 'visible', 'important');
        }
      });

      // 3. Inject print stylesheet
      const style = document.createElement('style');
      style.id = 'chatliberate-print-style';
      style.textContent = `
        @media print {
          nav, aside, header,
          [data-testid="conversation-header"],
          [data-testid="composer"],
          /* hide all buttons except inside message content */
          body > * button,
          .group\\/conversation-turn > div:last-child { display: none !important; }
          body { background: white !important; color: black !important; }
          main { max-width: 100% !important; padding: 0 !important; }
          /* ensure nothing is clipped in print */
          * { max-height: none !important; overflow: visible !important; }
        }
      `;
      document.head.appendChild(style);

      // Small delay to let the DOM settle after clicks before print dialog opens
      setTimeout(() => {
        window.print();
        setTimeout(() => {
          style.remove();
          // Restore any inline styles we set
          document.querySelectorAll('[data-cl-expanded]').forEach((el) => {
            el.style.removeProperty('max-height');
            el.style.removeProperty('overflow');
            el.removeAttribute('data-cl-expanded');
          });
        }, 3000);
      }, 300);
    }
    sendResponse({ ok: true });
    return true;
  }
});
