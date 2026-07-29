const statusEl = document.getElementById('status');
const exportAllBtn = document.getElementById('exportAll');
const exportCurrentBtn = document.getElementById('exportCurrent');
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
    exportCurrentBtn.disabled = !tab.url.includes('/c/');
  } else {
    statusEl.className = 'status warn';
    statusEl.innerHTML =
      'Open <a href="https://chatgpt.com" target="_blank">chatgpt.com</a> first';
  }
}

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
    statusEl.textContent = `✓ Exported ${response.stats.conversationCount} conversations`;
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

chrome.runtime.onMessage.addListener((msg) => {
  if (msg.type === 'CHATLIBERATE_PROGRESS') {
    const pct = msg.total ? Math.round((msg.current / msg.total) * 90) + 5 : 10;
    showProgress(msg.message, pct);
  }
});

init();
