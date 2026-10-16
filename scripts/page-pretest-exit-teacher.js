import { makePreTestExitCode } from './pretest-exit-codes.js';

const button = document.getElementById('pretest-exit-generate');
const output = document.getElementById('pretest-exit-output');
const status = document.getElementById('pretest-exit-status');

button?.addEventListener('click', () => {
  const code = makePreTestExitCode();
  if (!code) return;

  if (output) output.value = code;
  if (status) {
    status.textContent = `Give ${code} to pupils who are on the locked pre-test screen. The code will not unlock an active test.`;
    status.dataset.kind = 'success';
    status.hidden = false;
  }
});