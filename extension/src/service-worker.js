// Holds no state. Its entire job is the per-tab badge.
//
// The snapshot lives in the bridge content script's memory. Nothing is written
// to chrome.storage and nothing is cached here, so a service worker that gets
// evicted mid-session costs nothing.

import { WORKER_MSG } from './lib/protocol.js';

const BADGE_TEXT = '✓';
// Matches the icon tile, so the badge reads as part of it rather than a blob
// stuck on top. Changing one without the other is the bug this comment exists
// to prevent.
const BADGE_COLOR = '#ff7a59';

chrome.runtime.onMessage.addListener((message, sender) => {
  if (!message || message.type !== WORKER_MSG.CAPTURED) return;

  const tabId = sender.tab && sender.tab.id;
  if (tabId == null) return;

  chrome.action.setBadgeText({ tabId, text: BADGE_TEXT }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: BADGE_COLOR }).catch(() => {});
});

// A reload discards the snapshot, so the badge has to go with it. Otherwise the
// check mark outlives the capture it is advertising.
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (changeInfo.status !== 'loading') return;
  chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
});
