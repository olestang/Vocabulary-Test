import { APP_CONFIG } from './config.js';
import { loadAppData, buildCanonicalQuestions, getPrompt } from './data.js';
import { acceptedAnswers } from './grading.js';
import { storage } from './storage.js';
import { decodeCheckedPayload, decryptForPin, verifySignedToken } from './cryptography.js';
import { $, parseHashParams, setStatus, formatDateTime, sha256Hex, unpackBits } from './utilities.js';

const state = { data: null, pupil: null, bundle: null, entry: null };

function renderResult(record) {
  const test = state.data.testById.get(record.testId);
  if (!test) throw new Error('This result refers to a test that is not in the current configuration.');
  const canonical = buildCanonicalQuestions(state.data, test);
  if (typeof record.bits !== 'string' || record.total !== canonical.length) throw new Error('The result has an unexpected question format or count.');
  const bitArray = unpackBits(record.bits, canonical.length);
  $('#result-title').textContent = test.label;
  $('#result-score').textContent = `${record.score}/${record.total}`;
  $('#result-corrected').textContent = `Corrected ${formatDateTime(record.correctedAt)}`;
  const list = $('#result-list');
  list.replaceChildren();
  bitArray.forEach((correct, index) => {
    const q = canonical[index];
    const row = document.createElement('div');
    row.className = `final-result-row ${correct ? 'final-correct' : 'final-wrong'}`;
    const word = document.createElement('div');
    const strong = document.createElement('strong');
    strong.textContent = getPrompt(q);
    const small = document.createElement('small');
    small.textContent = `Correct answer: ${acceptedAnswers(q)[0]}`;
    word.append(strong, small);
    const mark = document.createElement('span');
    mark.textContent = correct ? 'Correct' : 'Wrong';
    row.append(word, mark);
    list.appendChild(row);
  });
  $('#result-view').hidden = false;
  $('#unlock-view').hidden = true;
  storage.savePupilHistoryRecord({
    testId: record.testId,
    pupilId: record.pupilId,
    bits: bitArray,
    score: record.score,
    total: record.total,
    correctedAt: record.correctedAt,
    verifiedAt: Date.now()
  });
}

async function unlockResult() {
  const pin = $('#result-pin').value.trim();
  if (!/^\d{4}$/.test(pin)) {
    setStatus($('#result-status'), 'Enter the four-digit code you chose when submitting the test.', 'error');
    return;
  }
  try {
    const record = await decryptForPin(state.entry.e, pin, `${state.bundle.t}|${state.pupil.id}`);
    if (record.pupilId !== state.pupil.id || record.testId !== state.bundle.t) throw new Error('The decrypted record does not match this pupil/test.');
    renderResult(record);
  } catch {
    setStatus($('#result-status'), 'The code did not unlock this result. Check the four digits and try again.', 'error');
  }
}

async function init() {
  try {
    state.data = await loadAppData();
    const saved = storage.getPupilIdentity();
    state.pupil = saved ? state.data.pupilById.get(saved.id) : null;
    if (!state.pupil?.active) {
      $('#identity-warning').hidden = false;
      $('#unlock-view').hidden = true;
      return;
    }
    $('#result-pupil').textContent = state.pupil.name;
    const hashParams = parseHashParams();
    const token = hashParams.get('r');
    const signatureToken = hashParams.get('s');
    if (!token || !signatureToken) throw new Error('This result URL is missing its package or teacher signature.');
    const bundleHash = await sha256Hex(token);
    const signature = await verifySignedToken(signatureToken, APP_CONFIG.teacherTokenKinds.resultBundle, { bundleHash });
    if (!signature.ok) throw new Error(`Teacher signature could not be verified: ${signature.reason}`);
    state.bundle = await decodeCheckedPayload(token);
    if (state.bundle.v !== 1 || !Array.isArray(state.bundle.entries)) throw new Error('This result package format is not supported.');
    state.entry = state.bundle.entries.find(entry => entry.p === state.pupil.id);
    if (!state.entry) {
      setStatus($('#global-result-status'), 'This class result link does not contain a corrected record for the pupil registered on this browser.', 'warning');
      return;
    }
    $('#unlock-view').hidden = false;
    $('#result-pin').focus();
    $('#result-form').addEventListener('submit', event => { event.preventDefault(); unlockResult(); });
  } catch (error) {
    setStatus($('#global-result-status'), error.message, 'error');
  }
}

init();
