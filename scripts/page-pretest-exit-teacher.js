import { makePreTestExitCode, makeUniversalUnlockCode } from './pretest-exit-codes.js';

const button = document.getElementById('pretest-exit-generate');
const output = document.getElementById('pretest-exit-output');
const status = document.getElementById('pretest-exit-status');

button?.addEventListener('click', () => {
  const code = makePreTestExitCode();
  if (!code) return;

  if (output) output.value = code;
  if (status) {
    status.textContent = `Give ${code} to pupils on the locked pre-test or completed-test permission screen. It ends their session without allowing another attempt. The code will not unlock an active test.`;
    status.dataset.kind = 'success';
    status.hidden = false;
  }
});

const universalOutput = document.getElementById('universal-unlock-output');
const universalStatus = document.getElementById('universal-unlock-status');
let expiryTimer;

document.getElementById('universal-unlock-generate')?.addEventListener('click', () => {
  const issuedAt = Math.floor(Date.now() / 1000) * 1000;
  const code = makeUniversalUnlockCode(issuedAt);
  if (!code) return;
  const expiresAt = issuedAt + 120000;
  clearInterval(expiryTimer);
  if (universalOutput) universalOutput.value = code;

  const updateExpiry = () => {
    const seconds = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    if (universalStatus) {
      universalStatus.textContent = seconds
        ? `Give ${code} to pupils. Expires in ${seconds} seconds. It does not allow another attempt at a completed test.`
        : 'This code has expired. Create a new code if needed.';
      universalStatus.dataset.kind = seconds ? 'success' : 'info';
      universalStatus.hidden = false;
    }
    if (!seconds) {
      clearInterval(expiryTimer);
      if (universalOutput) universalOutput.value = '';
    }
  };
  updateExpiry();
  expiryTimer = setInterval(updateExpiry, 1000);
});
