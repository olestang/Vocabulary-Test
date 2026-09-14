import { APP_CONFIG } from './config.js';
import { loadAppData, buildCanonicalQuestions } from './data.js';
import { gradeAnswer } from './grading.js';
import { encodeCheckedPayload, decodeCheckedPayload, verifySignedToken, encryptForPin, decryptForPin } from './cryptography.js';
import { $, setStatus } from './utilities.js';

const DIAGNOSTIC_SIGNED_TOKEN = 'eyJraW5kIjoiZGlhZ25vc3RpYyIsIm1lc3NhZ2UiOiJ2ZzEtdm9jYWIta2V5LWNoZWNrIiwidiI6MX0.7wyavTTjdw_NG4cZXdU9AfgA-X0kiQcc0ZziKqDNvw1IZGbjF_Sf4nlFE928uQBX2vl0LAWWJTr9XxmemXPNDQ';

function addResult(name, ok, detail = '') {
  const li = document.createElement('li');
  li.className = ok ? 'diag-ok' : 'diag-fail';
  li.textContent = `${ok ? 'PASS' : 'FAIL'} — ${name}${detail ? `: ${detail}` : ''}`;
  $('#diagnostic-list').appendChild(li);
}

async function run() {
  $('#diagnostic-list').replaceChildren();
  try {
    const data = await loadAppData();
    addResult('Load roster, vocabulary, and tests', true, `${data.roster.pupils.length} pupils, ${data.vocabulary.items.length} words`);
    const test = data.tests.tests[0];
    const questions = buildCanonicalQuestions(data, test);
    addResult('Deterministic question selection', questions.length === test.questionCount, `${questions.length} questions`);

    const checked = await encodeCheckedPayload({ v: 1, hello: 'world', n: 42 });
    const decoded = await decodeCheckedPayload(checked);
    addResult('Checked payload round trip', decoded.hello === 'world' && decoded.n === 42);

    const encrypted = await encryptForPin({ ok: true, value: 7 }, '1234', 'diagnostic');
    const decrypted = await decryptForPin(encrypted, '1234', 'diagnostic');
    addResult('PIN encryption/decryption round trip', decrypted.ok === true && decrypted.value === 7);

    const q = questions[0];
    const answer = q.direction === 'en-no' ? q.item.no : q.item.en;
    const grade = gradeAnswer(q, answer, test.grading);
    addResult('Known correct grading example', grade.band === 'correct', `${grade.reason}`);

    let storageOk = true;
    try {
      localStorage.setItem('vg1vocab.diagnostic', '1');
      storageOk = localStorage.getItem('vg1vocab.diagnostic') === '1';
      localStorage.removeItem('vg1vocab.diagnostic');
    } catch { storageOk = false; }
    addResult('localStorage availability', storageOk);

    let publicKeyOk = true;
    try {
      await crypto.subtle.importKey('jwk', APP_CONFIG.publicSigningKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    } catch { publicKeyOk = false; }
    addResult('Teacher public signing key imports', publicKeyOk);

    const signedCheck = await verifySignedToken(DIAGNOSTIC_SIGNED_TOKEN, 'diagnostic', { message: 'vg1-vocab-key-check' });
    addResult('Known P-256 signature verifies', signedCheck.ok, signedCheck.ok ? 'public/private key pair matches' : signedCheck.reason);

    const fake = await verifySignedToken('not.a-token', APP_CONFIG.teacherTokenKinds.access);
    addResult('Invalid signed token fails closed', fake.ok === false);

    setStatus($('#diagnostic-status'), 'Diagnostics finished. Review any failed checks before classroom use.', 'success');
  } catch (error) {
    addResult('Diagnostics runner', false, error.message);
    setStatus($('#diagnostic-status'), error.message, 'error');
  }
}

$('#run-diagnostics').addEventListener('click', run);
run();
