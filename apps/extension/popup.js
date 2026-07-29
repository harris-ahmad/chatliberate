const statusEl = document.getElementById('status');
const exportAllBtn = document.getElementById('exportAll');
const exportCurrentBtn = document.getElementById('exportCurrent');
const copyContextBtn = document.getElementById('copyContext');
const exportPdfBtn = document.getElementById('exportPdf');
const clearResumeBtn = document.getElementById('clearResume');
const progressEl = document.getElementById('progress');
const barFill = document.getElementById('barFill');
const progressText = document.getElementById('progressText');

let activeTab = null;

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  activeTab = tab;

  const onChatGPT =
    tab?.url?.includes('chatgpt.com') || tab?.url?.includes('chat.openai.com');

  if (onChatGPT) {
    statusEl.className = 'status ok';
    statusEl.textContent = '✓ Connected to ChatGPT';
    exportAllBtn.disabled = false;
    const onConvo = tab.url.includes('/c/');
    exportCurrentBtn.disabled = !onConvo;
    copyContextBtn.disabled = !onConvo;
    exportPdfBtn.disabled = !onConvo;
  } else {
    statusEl.className = 'status warn';
    statusEl.innerHTML =
      'Open <a href="https://chatgpt.com" target="_blank">chatgpt.com</a> first';
  }

  // Show resume button if there's saved progress
  const stored = await chrome.storage.local.get('exportProgress');
  if (stored.exportProgress?.downloadedIds?.length) {
    const count = stored.exportProgress.downloadedIds.length;
    clearResumeBtn.classList.remove('hidden');
    clearResumeBtn.textContent = `Resume from ${count} already downloaded — or clear`;
  }
}

clearResumeBtn.addEventListener('click', async () => {
  await chrome.storage.local.remove('exportProgress');
  clearResumeBtn.classList.add('hidden');
});

function getOptions() {
  return {
    includeArchived: document.getElementById('includeArchived').checked,
    includeProjects: document.getElementById('includeProjects').checked,
    downloadImages: document.getElementById('downloadImages').checked,
    includeBranches: document.getElementById('includeBranches').checked,
  };
}

function showProgress(text, pct = 0) {
  progressEl.classList.remove('hidden');
  barFill.style.width = `${pct}%`;
  progressText.textContent = text;
}

async function sendExport(mode) {
  exportAllBtn.disabled = true;
  exportCurrentBtn.disabled = true;
  showProgress('Starting export…', 5);

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: 'CHATLIBERATE_EXPORT',
      mode,
      options: getOptions(),
    });

    if (!response?.ok) {
      throw new Error(response?.error ?? 'Export failed');
    }

    showProgress('Download started!', 100);
    statusEl.className = 'status ok';
    const memNote = response.stats.memoriesCount ? ` + ${response.stats.memoriesCount} memories` : '';
    statusEl.textContent = `✓ Exported ${response.stats.conversationCount} conversations${memNote}`;
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message;
    showProgress('Export failed', 0);
  } finally {
    exportAllBtn.disabled = false;
    exportCurrentBtn.disabled = !activeTab?.url?.includes('/c/');
  }
}

exportAllBtn.addEventListener('click', () => sendExport('all'));
exportCurrentBtn.addEventListener('click', () => sendExport('current'));

copyContextBtn.addEventListener('click', async () => {
  copyContextBtn.disabled = true;
  copyContextBtn.textContent = '…';
  statusEl.className = 'status ok';
  statusEl.textContent = 'Building context…';
  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: 'CHATLIBERATE_COPY_CONTEXT',
      options: getOptions(),
    });
    if (!response?.ok) throw new Error(response?.error ?? 'Copy failed — check the console for details');
    if (!response.context) throw new Error('No context returned');

    // Write to clipboard — must happen while popup has focus
    try {
      await navigator.clipboard.writeText(response.context);
    } catch {
      // Fallback for when clipboard API is blocked (e.g. document not focused)
      const ta = document.createElement('textarea');
      ta.value = response.context;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.focus();
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }

    const chars = response.context.length.toLocaleString();
    copyContextBtn.textContent = '✓ Copied!';
    const imgNote = response.imageCount
      ? ` (${response.imageCount} images — upload from ZIP separately)`
      : '';
    statusEl.textContent = `✓ Copied ${chars} chars${imgNote}`;
    setTimeout(() => {
      copyContextBtn.textContent = '⎘ Copy';
      copyContextBtn.disabled = false;
      statusEl.textContent = '✓ Connected to ChatGPT';
    }, 5000);
  } catch (err) {
    copyContextBtn.textContent = '⎘ Copy';
    copyContextBtn.disabled = false;
    statusEl.className = 'status error';
    statusEl.textContent = err.message;
  }
});

exportPdfBtn.addEventListener('click', async () => {
  // Trigger browser print dialog on the ChatGPT tab — user saves as PDF
  await chrome.tabs.sendMessage(activeTab.id, { type: 'CHATLIBERATE_PRINT' });
  window.close();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CHATLIBERATE_PROGRESS') {
    const pct = msg.total ? Math.round((msg.current / msg.total) * 90) + 5 : 10;
    showProgress(msg.message, pct);
  }
});

init();
