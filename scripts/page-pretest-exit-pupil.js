import { storage } from './storage.js';
import { verifyPreTestExitCode } from './pretest-exit-codes.js';

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

async function leavePreTestSession() {
  storage.clearEntrySession();

  const exit = document.exitFullscreen || document.webkitExitFullscreen;
  if (fullscreenElement() && exit) {
    try {
      await exit.call(document);
    } catch {
      // The session has already been cleared; reloading still returns to the ready screen.
    }
  }

  location.reload();
}

// Capture the unlock click before page-test.js handles it. This module only
// intervenes for a locked pre-test entry session. Active attempts are left
// entirely to the existing request-specific unlock/leave flow.
document.addEventListener('click', event => {
  const button = event.target.closest?.('#unlock-button');
  if (!button) return;

  const lockScreen = document.getElementById('lock-screen');
  if (!lockScreen || lockScreen.hidden) return;

  const activeAttempt = storage.getActiveAttempt();
  if (activeAttempt && !activeAttempt.submitted) return;

  const entrySession = storage.getEntrySession();
  if (!entrySession?.locked) return;

  const code = document.getElementById('unlock-token')?.value || '';
  if (!verifyPreTestExitCode(code)) return;

  event.preventDefault();
  event.stopImmediatePropagation();
  void leavePreTestSession();
}, true);