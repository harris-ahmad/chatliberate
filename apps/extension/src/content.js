import {
  exportAllConversations,
  exportSingleConversation,
  fetchSessionFromPage,
  toMarkdownBundle,
  toOpenAIExportFormat,
} from '@chatliberate/core';

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

async function buildZip(result, options) {
  const files = {};

  const oai = toOpenAIExportFormat(result.conversations);
  files['conversations.json'] = JSON.stringify(oai, null, 2);

  const mdBundle = toMarkdownBundle(result.conversations);
  for (const [id, md] of mdBundle) {
    const conv = result.conversations.find((c) => (c.conversation_id ?? c.id) === id);
    const name = (conv?.title ?? id).replace(/[<>:"/\\|?*]/g, '_').slice(0, 60);
    files[`markdown/${name}_${id.slice(0, 8)}.md`] = md;
  }

  for (const [fileId, data] of result.files) {
    const meta = result.fileMeta.get(fileId);
    const ext = meta?.fileName ? meta.fileName.split('.').pop() : 'bin';
    files[`files/${fileId}.${ext}`] = data;
  }

  files['export-stats.json'] = JSON.stringify(
    {
      exportedAt: new Date().toISOString(),
      ...result.stats,
      tool: 'chatliberate',
      version: '0.1.0',
      accountType: document.cookie.includes('_account=') ? 'teams/business' : 'personal',
    },
    null,
    2,
  );

  return createZip(files);
}

function createZip(fileMap) {
  const encoder = new TextEncoder();
  const entries = [];
  let offset = 0;
  const chunks = [];

  function crc32(data) {
    let crc = 0xffffffff;
    for (let i = 0; i < data.length; i++) {
      crc ^= data[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
      }
    }
    return (crc ^ 0xffffffff) >>> 0;
  }

  for (const [name, content] of Object.entries(fileMap)) {
    const nameBytes = encoder.encode(name);
    const data = typeof content === 'string' ? encoder.encode(content) : content;
    const crc = crc32(data);

    const local = new Uint8Array(30 + nameBytes.length);
    const view = new DataView(local.buffer);
    view.setUint32(0, 0x04034b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(26, nameBytes.length, true);
    view.setUint32(18, crc, true);
    view.setUint32(22, data.length, true);
    view.setUint32(26, data.length, true);
    local.set(nameBytes, 30);

    const localOffset = offset;
    chunks.push(local, data);
    offset += local.length + data.length;

    entries.push({ name, nameBytes, crc, size: data.length, offset: localOffset });
  }

  const centralStart = offset;
  for (const entry of entries) {
    const central = new Uint8Array(46 + entry.nameBytes.length);
    const view = new DataView(central.buffer);
    view.setUint32(0, 0x02014b50, true);
    view.setUint16(4, 20, true);
    view.setUint16(6, 20, true);
    view.setUint16(28, entry.nameBytes.length, true);
    view.setUint32(16, entry.crc, true);
    view.setUint32(20, entry.size, true);
    view.setUint32(24, entry.size, true);
    view.setUint32(42, entry.offset, true);
    central.set(entry.nameBytes, 46);
    chunks.push(central);
    offset += central.length;
  }

  const end = new Uint8Array(22);
  const endView = new DataView(end.buffer);
  endView.setUint32(0, 0x06054b50, true);
  endView.setUint16(8, entries.length, true);
  endView.setUint16(10, entries.length, true);
  endView.setUint32(12, offset - centralStart, true);
  endView.setUint32(16, centralStart, true);
  chunks.push(end);

  const total = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(total);
  let pos = 0;
  for (const chunk of chunks) {
    out.set(chunk, pos);
    pos += chunk.length;
  }

  return new Blob([out], { type: 'application/zip' });
}

async function runExport(mode, options) {
  const session = await fetchSessionFromPage();

  const progress = (event) => {
    chrome.runtime.sendMessage({
      type: 'CHATLIBERATE_PROGRESS',
      message: event.message,
      current: event.current,
      total: event.total,
    });
  };

  let result;
  if (mode === 'current') {
    const id = getCurrentConversationId();
    if (!id) throw new Error('Open a conversation first (URL should contain /c/)');
    result = await exportSingleConversation(session, id, {
      downloadFiles: options.downloadImages,
      downloadImages: options.downloadImages,
      onProgress: progress,
    });
  } else {
    result = await exportAllConversations(session, {
      includeArchived: options.includeArchived,
      includeProjects: options.includeProjects,
      downloadFiles: options.downloadImages,
      downloadImages: options.downloadImages,
      throttleMs: 1200,
      onProgress: progress,
    });
  }

  const zip = await buildZip(result, options);
  const date = new Date().toISOString().slice(0, 10);
  downloadBlob(`chatliberate-export-${date}.zip`, zip);

  return { ok: true, stats: result.stats };
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type !== 'CHATLIBERATE_EXPORT') return;

  runExport(msg.mode, msg.options)
    .then((result) => sendResponse(result))
    .catch((err) => sendResponse({ ok: false, error: err.message }));

  return true;
});
