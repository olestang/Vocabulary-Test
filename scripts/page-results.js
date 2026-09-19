import { APP_CONFIG } from './config.js';
import { loadAppData, buildCanonicalQuestions, getPrompt, getClass, getPupil } from './data.js';
import { acceptedAnswers } from './grading.js';
import { storage } from './storage.js';
import { decodeCheckedPayload, decryptForPin, verifySignedToken } from './cryptography.js';
import { $, parseHashParams, setStatus, formatDateTime, sha256Hex, unpackBits } from './utilities.js';

const state = { data: null, classRecord: null, pupil: null, bundle: null, entry: null };

function normalizeResultRecord(record) {
  if (record?.v === 2 && record.t != null) {
    return {
      v: 2,
      testId: record.t,
      classId: record.cl,
      pupilId: record.p,
      attemptSeed: record.m ?? null,
      bits: record.b,
      score: record.s,
      total: record.n,
      correctedAt: record.at
    };
  }
  return record;
}

function renderResult(record) {
  const test = state.data.testById.get(record.testId);
  if (!test) throw new Error('This result refers to a test that is not in the current configuration.');
  const canonical = buildCanonicalQuestions(state.data, test, { attemptSeed: record.m ?? record.attemptSeed ?? null });
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
    classId: record.classId || state.classRecord.id,
    pupilId: record.pupilId,
    attemptSeed: record.m ?? record.attemptSeed ?? null,
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
    const context = state.bundle.v >= 2 ? `${state.bundle.t}|${state.classRecord.id}|${state.pupil.id}` : `${state.bundle.t}|${state.pupil.id}`;
    const rawRecord = await decryptForPin(state.entry.e, pin, context);
    const record = normalizeResultRecord(rawRecord);
    if (String(record.pupilId) !== String(state.pupil.id) || record.testId !== state.bundle.t || (record.classId && record.classId !== state.classRecord.id)) throw new Error('The decrypted record does not match this pupil/test.');
    renderResult(record);
  } catch {
    setStatus($('#result-status'), 'The code did not unlock this result. Check the four digits and try again.', 'error');
  }
}

async function init() {
  try {
    state.data = await loadAppData();
    const saved = storage.getPupilIdentity();
    state.classRecord = saved ? getClass(state.data, saved.classId) : null;
    state.pupil = saved ? getPupil(state.data, state.classRecord?.id, saved.id) : null;
    if (!state.classRecord?.active || !state.pupil?.active) {
      $('#identity-warning').hidden = false;
      $('#unlock-view').hidden = true;
      return;
    }
    $('#result-pupil').textContent = `${state.classRecord.label} · ${state.pupil.name}`;
    const rawHash = location.hash.replace(/^#/, '');
    let token = '';
    let signatureToken = '';
    if (rawHash.includes('~')) {
      [token, signatureToken] = rawHash.split('~', 2).map(decodeURIComponent);
    } else {
      const hashParams = parseHashParams();
      token = hashParams.get('r') || '';
      signatureToken = hashParams.get('s') || '';
    }
    if (!token || !signatureToken) throw new Error('This result URL is missing its package or teacher signature.');
    const bundleHash = await sha256Hex(token);
    const signature = await verifySignedToken(signatureToken, APP_CONFIG.teacherTokenKinds.resultBundle, { bundleHash });
    if (!signature.ok) throw new Error(`Teacher signature could not be verified: ${signature.reason}`);
    state.bundle = await decodeCheckedPayload(token);
    if (![1, 2].includes(state.bundle.v) || !Array.isArray(state.bundle.entries)) throw new Error('This result package format is not supported.');
    const bundleClassId = state.bundle.cl || state.data.roster.classes[0]?.id;
    if (bundleClassId !== state.classRecord.id) {
      setStatus($('#global-result-status'), 'This result link belongs to a different class than the one registered on this browser.', 'warning');
      return;
    }
    state.entry = state.bundle.entries.find(entry => String(entry.p) === String(state.pupil.id));
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
