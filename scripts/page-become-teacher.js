import { APP_CONFIG } from './config.js';
import { storage } from './storage.js';
import { verifySignedToken, privateKeyMatchesPublic } from './cryptography.js';
import { $, setStatus } from './utilities.js';

async function saveTeacherSetup(token, privateKeyText = '', auto = false) {
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

  let privateKey = null;
  if (privateKeyText) {
    try {
      privateKey = JSON.parse(privateKeyText);
    } catch {
      setStatus($('#teacher-status'), 'The teacher signing key in the setup link could not be read.', 'error');
      return false;
    }
    if (!(await privateKeyMatchesPublic(privateKey))) {
      setStatus($('#teacher-status'), 'The teacher signing key does not match this site.', 'error');
      return false;
    }
  }

  storage.setTeacherAccessToken(value);
  if (privateKey) storage.setTeacherPrivateKey(privateKey);
  const signingText = privateKey || storage.getTeacherPrivateKey() ? ' Result signing is also ready.' : '';
  setStatus($('#teacher-status'), `Teacher mode is enabled on this browser.${signingText} Opening the teacher dashboard…`, 'success');
  const returnTo = new URL(location.href).searchParams.get('return');
  setTimeout(() => { location.href = returnTo || '../teacher/'; }, auto ? 350 : 700);
  return true;
}

$('#teacher-form').addEventListener('submit', async event => {
  event.preventDefault();
  await saveTeacherSetup($('#teacher-token').value);
});

const hash = new URLSearchParams(location.hash.slice(1));
const bootstrapToken = hash.get('teacherToken');
const bootstrapKey = hash.get('teacherKey');
if (bootstrapToken) {
  $('#teacher-token').value = bootstrapToken;
  saveTeacherSetup(bootstrapToken, bootstrapKey || '', true);
}
