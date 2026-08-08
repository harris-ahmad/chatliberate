// Background service worker.
//
// The export itself runs in the ChatGPT tab's content script, so it keeps going
// after the popup closes. This worker just mirrors its progress onto the toolbar
// icon's badge, so a long "Export All" stays visible while you're on other tabs —
// and it downloads the ZIP as usual when it finishes. No extra permissions.

const BADGE_OK = '#10a37f';
const BADGE_ERR = '#d93b3b';
const BADGE_WAIT = '#e08a00';

function setBadge(text, color) {
  chrome.action.setBadgeBackgroundColor({ color: color ?? BADGE_OK });
  chrome.action.setBadgeText({ text: text ?? '' });
}

// Clears after a delay. The worker stays alive ~30s after handling a message,
// so a few-second timer fires reliably without needing the "alarms" permission.
function clearBadgeAfter(ms) {
  setTimeout(() => chrome.action.setBadgeText({ text: '' }), ms);
}

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || typeof msg.type !== 'string') return;

  switch (msg.type) {
    case 'CHATLIBERATE_PROGRESS': {
      if (msg.phase === 'rate-limited') {
        setBadge('429', BADGE_WAIT);
        break;
      }
      let text = '…';
      if (msg.total && Number.isFinite(msg.current)) {
        const pct = Math.min(99, Math.max(0, Math.round((msg.current / msg.total) * 100)));
        text = `${pct}%`;
      } else if (Number.isFinite(msg.current)) {
        text = String(msg.current);
      }
      setBadge(text, BADGE_OK);
      break;
    }
    case 'CHATLIBERATE_DONE':
      setBadge('✓', BADGE_OK);
      clearBadgeAfter(5000);
      break;
    case 'CHATLIBERATE_ERROR':
      setBadge('!', BADGE_ERR);
      clearBadgeAfter(8000);
      break;
  }
});
