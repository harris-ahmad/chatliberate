const statusEl = document.getElementById('status');
const exportAllBtn = document.getElementById('exportAll');
const exportCurrentBtn = document.getElementById('exportCurrent');
const copyContextBtn = document.getElementById('copyContext');
const exportPdfBtn = document.getElementById('exportPdf');
const clearResumeBtn = document.getElementById('clearResume');
const progressEl = document.getElementById('progress');
const barFill = document.getElementById('barFill');
const progressText = document.getElementById('progressText');
const bgHint = document.getElementById('bgHint');

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

    // If an export is already running in this tab, reflect it so the user can't
    // start a second one (which would double the request rate and hit 429s).
    try {
      const st = await chrome.tabs.sendMessage(tab.id, { type: 'CHATLIBERATE_STATUS' });
      if (st?.exporting) {
        exportAllBtn.disabled = true;
        exportCurrentBtn.disabled = true;
        showProgress('Export running in the background…', 10);
        bgHint.classList.remove('hidden');
      }
    } catch {
      // Content script not ready yet — ignore.
    }
  } else {
    statusEl.className = 'status warn';
    statusEl.innerHTML =
      'Open <a href="https://chatgpt.com" target="_blank">chatgpt.com</a> first';
  }

  // Show resume state if a previous export was interrupted
  const all = await chrome.storage.local.get(null);
  const resumeCount = Object.keys(all).filter((k) => k.startsWith('resume:conv:')).length;
  if (resumeCount) {
    clearResumeBtn.classList.remove('hidden');
    clearResumeBtn.textContent = `${resumeCount} chats saved — next export resumes. Click to discard & start fresh`;
  }
}

clearResumeBtn.addEventListener('click', async () => {
  const all = await chrome.storage.local.get(null);
  const keys = Object.keys(all).filter((k) => k.startsWith('resume:conv:'));
  keys.push('exportProgress'); // clear legacy key too
  await chrome.storage.local.remove(keys);
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
  // "Export All" can take minutes — let the user know it survives closing the popup.
  bgHint.classList.toggle('hidden', mode !== 'all');

  try {
    const response = await chrome.tabs.sendMessage(activeTab.id, {
      type: 'CHATLIBERATE_EXPORT',
      mode,
      options: getOptions(),
    });

    if (response?.alreadyRunning) {
      // Not a failure — an export is already in flight in the tab.
      statusEl.className = 'status ok';
      statusEl.textContent = response.error;
      showProgress('Export already running…', 10);
      bgHint.classList.remove('hidden');
      return;
    }

    if (!response?.ok) {
      throw new Error(response?.error ?? 'Export failed');
    }

    showProgress('Download started!', 100);
    bgHint.classList.add('hidden');
    statusEl.className = 'status ok';
    const memNote = response.stats.memoriesCount ? ` + ${response.stats.memoriesCount} memories` : '';
    statusEl.textContent = `✓ Exported ${response.stats.conversationCount} conversations${memNote}`;
  } catch (err) {
    statusEl.className = 'status error';
    statusEl.textContent = err.message;
    showProgress('Export failed', 0);
    bgHint.classList.add('hidden');
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
    const bits = [];
    if (response.chatFork) {
      bits.push('branched-from split');
    } else if (response.includeAllBranches) {
      if (response.branchNote) bits.push(`${response.branchCount} regenerated branches`);
      else bits.push('1 path — no regenerate forks (try Branch-in-new-chat divider or Regenerate 1/2)');
    } else {
      bits.push('active path only');
    }
    if (response.imageCount) bits.push(`${response.imageCount} images — upload from ZIP separately`);
    statusEl.textContent = `✓ Copied ${chars} chars (${bits.join('; ')})`;
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
