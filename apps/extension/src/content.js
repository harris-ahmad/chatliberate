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
} from '@chatliberate/core';
import { zipSync, strToU8 } from 'fflate';

function getCurrentConversationId() {
  const match = window.location.pathname.match(/\/c\/([a-f0-9-]+)/i);
  return match?.[1];
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
  const contextBlock = toContextBlock(result.conversations, { maxChars: 60_000, fileExtMap });
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
      version: '0.1.2',
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

function sendProgress(event) {
  chrome.runtime.sendMessage({
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
    // Incremental resume: load previously downloaded IDs from chrome.storage
    const stored = await chrome.storage.local.get('exportProgress');
    const prevProgress = stored.exportProgress ?? {};
    const skipIds = new Set(prevProgress.downloadedIds ?? []);

    const abortController = new AbortController();

    result = await exportAllConversations(session, {
      includeArchived: options.includeArchived,
      includeProjects: options.includeProjects,
      downloadFiles: options.downloadImages,
      downloadImages: options.downloadImages,
      throttleMs: 1200,
      signal: abortController.signal,
      onProgress: (event) => {
        sendProgress(event);
        // Persist progress so a future session can resume
        if (event.phase === 'downloading' && event.conversationId) {
          const ids = [...(prevProgress.downloadedIds ?? []), event.conversationId];
          chrome.storage.local.set({ exportProgress: { downloadedIds: ids, lastExport: Date.now() } });
        }
        if (event.phase === 'complete') {
          chrome.storage.local.remove('exportProgress');
        }
      },
    });
  }

  const zip = await buildZip(result, { memories, customInstructions });
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

  const context = toContextBlock(result.conversations, {
    maxChars: 120_000,
    fileExtMap,
  });

  // Count unique images referenced in the conversation
  const imgPattern = /\[image attached separately\]/g;
  const imageCount = (context.match(imgPattern) || []).length;

  return { ok: true, context, imageCount };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'CHATLIBERATE_EXPORT') {
    runExport(msg.mode, msg.options)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ ok: false, error: err.message }));
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
