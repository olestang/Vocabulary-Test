import { APP_CONFIG } from './config.js';
import { storage } from './storage.js';
import { verifySignedToken } from './cryptography.js';
import { $, setStatus } from './utilities.js';

async function saveTeacherToken(token, auto = false) {
  const value = String(token || '').trim();
  if (!value) {
    setStatus($('#teacher-status'), 'Paste a teacher access token first.', 'warning');
    return false;
  }
  const result = await verifySignedToken(value, APP_CONFIG.teacherTokenKinds.access);
  if (!result.ok) {
    setStatus($('#teacher-status'), result.reason, 'error');
    return false;
  }
  storage.setTeacherAccessToken(value);
  setStatus($('#teacher-status'), 'Teacher mode is enabled on this browser. Opening the teacher dashboard…', 'success');
  const returnTo = new URL(location.href).searchParams.get('return');
  setTimeout(() => { location.href = returnTo || '../teacher/'; }, auto ? 350 : 700);
  return true;
}

$('#teacher-form').addEventListener('submit', async event => {
  event.preventDefault();
  await saveTeacherToken($('#teacher-token').value);
});

const hash = new URLSearchParams(location.hash.slice(1));
const bootstrapToken = hash.get('teacherToken');
if (bootstrapToken) {
  $('#teacher-token').value = bootstrapToken;
  saveTeacherToken(bootstrapToken, true);
}
