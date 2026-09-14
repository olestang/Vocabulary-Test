import { APP_CONFIG } from './config.js';
import { loadAppData, findTestByCode, buildCanonicalQuestions, buildPupilOrder, getPrompt, getDirectionLabel } from './data.js';
import { gradeAttempt, gradeAnswer, acceptedAnswers } from './grading.js';
import { storage } from './storage.js';
import { encodeCheckedPayload, decodeCheckedPayload, receiptFromToken, verifySignedToken } from './cryptography.js';
import { makeUnlockRequest, verifyUnlockCode, normalizeFiveLetters } from './unlock-codes.js';
import {
  $, $$, setHidden, normalizeAnswer, randomId, formatDuration, formatDateTime, setStatus, sha256Hex
} from './utilities.js';

const state = {
  data: null,
  pupil: null,
  test: null,
  canonical: [],
  attempt: null,
  entrySession: null,
  monitorActive: false,
  countdownTimer: null,
  nextEnabledAt: 0,
  practice: null
};

const screens = ['registration', 'ready', 'code', 'rules', 'test', 'submit', 'finished', 'practice'];

function showScreen(name) {
  for (const screen of screens) setHidden($(`#screen-${screen}`), screen !== name);
  document.body.dataset.screen = name;
  const active = ['code', 'rules', 'test', 'submit'].includes(name) && (!!state.entrySession || !!(state.attempt && !state.attempt.submitted));
  document.body.classList.toggle('test-session-active', active);
}

function activePupils() {
  return state.data.roster.pupils.filter(p => p.active);
}

function renderRegistration() {
  const select = $('#pupil-select');
  select.replaceChildren();
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = 'Choose your name';
  select.appendChild(placeholder);
  for (const pupil of activePupils()) {
    const option = document.createElement('option');
    option.value = String(pupil.id);
    option.textContent = pupil.name;
    select.appendChild(option);
  }
  showScreen('registration');
}

function setPupil(pupil) {
  state.pupil = pupil;
  storage.setPupilIdentity({ id: pupil.id, name: pupil.name, registeredAt: Date.now() });
  $('#current-pupil').textContent = pupil.name;
}

function showReadyScreen(message = '') {
  state.monitorActive = false;
  showScreen('ready');
  $('#current-pupil').textContent = state.pupil?.name || '';
  setStatus($('#ready-status'), message, message ? 'info' : '');
}

function persistEntrySession() {
  if (state.entrySession) storage.saveEntrySession(state.entrySession);
}

function createEntrySession() {
  return {
    v: 1,
    sessionId: randomId(10),
    pupilId: state.pupil.id,
    startedAt: Date.now(),
    violationCount: 0,
    violationEvents: [],
    locked: false,
    unlockRequest: null,
    stage: 'code',
    testId: null
  };
}

async function beginSecureSession() {
  state.entrySession = createEntrySession();
  persistEntrySession();
  showCodeScreen();

  // Protection starts immediately after the pupil confirms the session,
  // before the test code is entered.
  state.monitorActive = true;

  try {
    if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
  } catch {
    addViolation('fullscreen-start-failed', true);
  }
}

function showCodeScreen(message = '') {
  showScreen('code');
  $('#current-pupil').textContent = state.pupil?.name || '';
  setStatus($('#code-status'), message, message ? 'info' : '');
  $('#test-code').focus();
}

function configureRules(test) {
  $('#rules-test-label').textContent = test.label;
  $('#rules-count').textContent = String(test.questionCount);
  $('#rules-fullscreen').textContent = test.requireFullscreen ? 'Full-screen is required.' : 'Full-screen is recommended.';
  updateStartAvailability();
  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(updateStartAvailability, 1000);
  showScreen('rules');
}

function updateStartAvailability() {
  if (!state.test) return;
  const startButton = $('#start-test');
  const countdown = $('#opening-countdown');
  if (!state.test.openingTime) {
    startButton.disabled = false;
    countdown.textContent = 'The test is open.';
    return;
  }
  const opening = new Date(state.test.openingTime).getTime();
  const remaining = opening - Date.now();
  if (remaining <= 0) {
    startButton.disabled = false;
    countdown.textContent = 'The test is open.';
  } else {
    startButton.disabled = true;
    const seconds = Math.ceil(remaining / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    countdown.textContent = `The test opens in ${mins}:${String(secs).padStart(2, '0')}.`;
  }
}

function createAttempt() {
  state.canonical = buildCanonicalQuestions(state.data, state.test);
  const order = buildPupilOrder(state.canonical, state.test, state.pupil.id);
  return {
    v: 1,
    attemptId: randomId(10),
    testId: state.test.id,
    pupilId: state.pupil.id,
    configVersion: state.test.configVersion,
    startTime: Date.now(),
    finishTime: null,
    violationCount: state.entrySession?.violationCount || 0,
    violationEvents: [...(state.entrySession?.violationEvents || [])],
    locked: false,
    answers: Array(state.canonical.length).fill(''),
    answerEdits: Array(state.canonical.length).fill(0),
    committedAnswers: Array(state.canonical.length).fill(null),
    questionOrder: order,
    position: 0,
    furthestPosition: 0,
    submitted: false,
    confirmedHandIn: false,
    pin: null,
    submissionToken: null,
    receipt: null
  };
}

function getCurrentCanonicalIndex() {
  return state.attempt.questionOrder[state.attempt.position];
}

function renderQuestion() {
  const a = state.attempt;
  const canonicalIndex = getCurrentCanonicalIndex();
  const question = state.canonical[canonicalIndex];
  $('#question-progress').textContent = `${a.position + 1} of ${a.questionOrder.length}`;
  $('#question-direction').textContent = getDirectionLabel(question);
  $('#question-prompt').textContent = getPrompt(question);
  $('#answer-input').value = a.answers[canonicalIndex] || '';
  $('#definition-text').textContent = question.item.definition || 'No definition is available.';
  setHidden($('#definition-wrap'), true);
  $('#definition-toggle').hidden = !state.test.allowDefinitions || !question.item.definition;
  $('#back-button').disabled = !(a.position > 0 && a.position === a.furthestPosition);
  $('#next-button').textContent = a.position === a.questionOrder.length - 1 ? 'Review & submit' : 'Next';
  $('#violation-pill').textContent = `${a.violationCount} interruption${a.violationCount === 1 ? '' : 's'}`;
  state.nextEnabledAt = Date.now() + APP_CONFIG.nextButtonDelayMs;
  $('#next-button').disabled = true;
  setTimeout(() => {
    if (state.attempt && !state.attempt.locked && Date.now() >= state.nextEnabledAt) $('#next-button').disabled = false;
  }, APP_CONFIG.nextButtonDelayMs);
  $('#answer-input').focus();
}

function persistAttempt() {
  if (state.attempt) storage.saveActiveAttempt(state.attempt);
}

function recordAnswerFromInput() {
  if (!state.attempt) return;
  const index = getCurrentCanonicalIndex();
  const newValue = $('#answer-input').value;
  const oldValue = state.attempt.answers[index] || '';
  if (newValue !== oldValue) {
    state.attempt.answers[index] = newValue;
    persistAttempt();
  }
}

function commitCurrentAnswer() {
  if (!state.attempt) return;
  const index = getCurrentCanonicalIndex();
  const raw = state.attempt.answers[index] || '';
  const previous = state.attempt.committedAnswers[index];
  if (previous !== null && previous !== raw) {
    state.attempt.answerEdits[index] = (state.attempt.answerEdits[index] || 0) + 1;
  }
  state.attempt.committedAnswers[index] = raw;
}

function openBlankDialog(onConfirm) {
  const overlay = $('#blank-dialog');
  overlay.hidden = false;
  const yes = $('#blank-confirm');
  const no = $('#blank-cancel');
  const cleanup = () => {
    overlay.hidden = true;
    yes.onclick = null;
    no.onclick = null;
  };
  yes.onclick = () => { cleanup(); onConfirm(); };
  no.onclick = () => { cleanup(); $('#answer-input').focus(); };
}

function advanceQuestion() {
  commitCurrentAnswer();
  const a = state.attempt;
  if (a.position < a.furthestPosition) {
    a.position += 1;
  } else if (a.position < a.questionOrder.length - 1) {
    a.position += 1;
    a.furthestPosition = Math.max(a.furthestPosition, a.position);
  } else {
    persistAttempt();
    showSubmissionScreen();
    return;
  }
  persistAttempt();
  renderQuestion();
}

function handleNext() {
  if (!state.attempt || Date.now() < state.nextEnabledAt || state.attempt.locked) return;
  recordAnswerFromInput();
  const raw = state.attempt.answers[getCurrentCanonicalIndex()] || '';
  if (!normalizeAnswer(raw)) {
    openBlankDialog(advanceQuestion);
  } else {
    advanceQuestion();
  }
}

function handleBack() {
  const a = state.attempt;
  if (!a || a.position <= 0 || a.position !== a.furthestPosition) return;
  recordAnswerFromInput();
  commitCurrentAnswer();
  a.position -= 1;
  persistAttempt();
  renderQuestion();
}

function currentGuardRecord() {
  if (state.attempt && !state.attempt.submitted) return state.attempt;
  return state.entrySession;
}

function persistGuardRecord(record) {
  if (!record) return;
  if (record === state.attempt) persistAttempt();
  else persistEntrySession();
}

function addViolation(type, lock = true) {
  const record = currentGuardRecord();
  if (!record || record.submitted || record.locked) return;
  const now = Date.now();
  const last = record.violationEvents.at(-1);
  if (last && last.type === type && now - last.at < 800) return;
  const recentLockIncident = lock && [...record.violationEvents].reverse().find(ev => ev.lockEligible && now - ev.at < 1500);
  const lockEligible = !!lock && !recentLockIncident;
  record.violationCount += 1;
  record.violationEvents.push({ type, at: now, lockEligible });
  if (lockEligible) record.locked = true;
  persistGuardRecord(record);
  if (record.locked) showLock();
  else if (state.attempt && $('#violation-pill')) $('#violation-pill').textContent = `${record.violationCount} interruptions`;
}

function showLock() {
  const record = currentGuardRecord();
  if (!record) return;

  // Do not let an optional piece of display text prevent the actual lock
  // overlay from appearing. Older/newer HTML versions may not show a count.
  const lockCount = $('#lock-count');
  if (lockCount) lockCount.textContent = String(record.violationCount || 0);

  const id = record.attemptId || record.sessionId;
  record.unlockRequest = record.unlockRequest || makeUnlockRequest(id, record.violationCount || 0);
  persistGuardRecord(record);

  const requestEl = $('#unlock-request');
  const tokenEl = $('#unlock-token');
  const lockScreen = $('#lock-screen');
  if (requestEl) requestEl.textContent = record.unlockRequest;
  if (tokenEl) tokenEl.value = '';
  setStatus($('#unlock-status'), '', '');

  // The overlay is the important part: show it even if optional lock text is missing.
  if (lockScreen) lockScreen.hidden = false;
  document.body.classList.add('is-locked');
}

function hideLock() {
  const lockScreen = $('#lock-screen');
  if (lockScreen) lockScreen.hidden = true;
  document.body.classList.remove('is-locked');
}

async function unlockAttempt() {
  const record = currentGuardRecord();
  const code = normalizeFiveLetters($('#unlock-token').value);
  if (!record?.unlockRequest || !verifyUnlockCode(record.unlockRequest, code)) {
    setStatus($('#unlock-status'), 'That five-letter code is not valid for this request.', 'error');
    return;
  }

  record.locked = false;
  record.violationEvents.push({ type: 'teacher-unlock', at: Date.now(), lockEligible: false });
  record.unlockRequest = null;
  hideLock();

  if (record === state.entrySession && !state.attempt) {
    storage.clearEntrySession();
    state.entrySession = null;
    state.test = null;
    state.canonical = [];
    state.monitorActive = false;
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    showReadyScreen('Your teacher ended the test session. You can start again when ready.');
    return;
  }

  persistAttempt();
  if (state.test?.requireFullscreen && !document.fullscreenElement) {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      setStatus($('#test-status'), 'The test could not return to full-screen. Ask your teacher before continuing.', 'warning');
    }
  }
  renderQuestion();
}

function installIntegrityMonitors() {
  document.addEventListener('visibilitychange', () => {
    if (!state.monitorActive || document.visibilityState !== 'hidden') return;
    addViolation('tab-or-window-hidden', true);
  });
  document.addEventListener('fullscreenchange', () => {
    const record = currentGuardRecord();
    const fullscreenRequired = !!state.entrySession || !!state.test?.requireFullscreen;
    if (!state.monitorActive || !record || !fullscreenRequired || document.fullscreenElement) return;
    addViolation('fullscreen-exit', true);
  });
  // Losing browser focus during a protected session is treated as a lock event.
  // A short delay avoids locking on transient focus changes caused by browser UI,
  // while still catching Alt+Tab / switching applications reliably.
  window.addEventListener('blur', () => {
    if (!state.monitorActive) return;
    window.setTimeout(() => {
      const record = currentGuardRecord();
      if (!state.monitorActive || !record || record.locked || record.submitted) return;
      if (!document.hasFocus()) addViolation('window-blur', true);
    }, 150);
  });

  // If the page becomes visible/focused again with a persisted locked state,
  // force the red lock overlay back on screen immediately.
  window.addEventListener('focus', () => {
    const record = currentGuardRecord();
    if (state.monitorActive && record?.locked) showLock();
  });

  window.addEventListener('pageshow', () => {
    const record = currentGuardRecord();
    if (state.monitorActive && record?.locked) showLock();
  });

  window.addEventListener('pagehide', () => {
    const record = currentGuardRecord();
    if (!state.monitorActive || !record || record.submitted || record.locked) return;
    const now = Date.now();
    record.violationCount = (record.violationCount || 0) + 1;
    record.violationEvents ||= [];
    record.violationEvents.push({ type: 'page-hidden-or-left', at: now, lockEligible: true });
    record.locked = true;
    persistGuardRecord(record);
  });
  window.addEventListener('beforeunload', event => {
    const record = currentGuardRecord();
    if (!state.monitorActive || !record || record.submitted || record.locked) return;
    const now = Date.now();
    record.violationCount = (record.violationCount || 0) + 1;
    record.violationEvents ||= [];
    record.violationEvents.push({ type: 'page-left', at: now, lockEligible: true });
    record.locked = true;
    persistGuardRecord(record);
    event.preventDefault();
    event.returnValue = '';
  });
}

async function startTest() {
  clearInterval(state.countdownTimer);
  state.attempt = createAttempt();
  storage.clearEntrySession();
  state.entrySession = null;
  persistAttempt();
  showScreen('test');
  if (state.test.requireFullscreen && !document.fullscreenElement) {
    try {
      await document.documentElement.requestFullscreen();
    } catch {
      addViolation('fullscreen-denied', true);
    }
  }
  state.monitorActive = true;
  renderQuestion();
}

function showSubmissionScreen() {
  recordAnswerFromInput();
  showScreen('submit');
  $('#submit-test-label').textContent = state.test.label;
  $('#submit-answer-count').textContent = `${state.attempt.answers.filter(a => normalizeAnswer(a)).length} of ${state.attempt.answers.length} answered`;
  $('#submit-duration').textContent = formatDuration((Date.now() - state.attempt.startTime) / 1000);
  $('#pin-code').value = '';
  setStatus($('#submit-status'), '', '');
}

async function finalizeSubmission() {
  const pin = $('#pin-code').value.trim();
  if (!/^\d{4}$/.test(pin)) {
    setStatus($('#submit-status'), 'Choose exactly four digits. You will need the same code to open your final result.', 'error');
    return;
  }
  const a = state.attempt;
  a.finishTime = Date.now();
  a.pin = pin;
  a.submitted = true;
  state.monitorActive = false;
  document.body.classList.remove('test-session-active');
  const payload = {
    v: APP_CONFIG.submissionFormatVersion,
    t: a.testId,
    p: a.pupilId,
    a: a.attemptId,
    cv: a.configVersion,
    s: a.startTime,
    f: a.finishTime,
    x: a.violationCount,
    e: a.violationEvents.map(ev => [ev.type, ev.at, ev.lockEligible ? 1 : 0]),
    z: a.answerEdits,
    c: pin,
    r: a.answers
  };
  const token = await encodeCheckedPayload(payload);
  const url = new URL('./', location.href);
  // Keep the pupil name visibly at the beginning of the submission URL after the GitHub Pages base.
  // Opening this link routes to the teacher dashboard, which independently checks the visible name.
  const visibleName = state.pupil.name.trim().replace(/\s+/g, '-');
  url.search = `?${encodeURIComponent(visibleName)}`;
  url.hash = `s=${encodeURIComponent(token)}`;
  a.submissionToken = token;
  a.submissionUrl = url.href;
  a.receipt = await receiptFromToken(token);
  persistAttempt();
  storage.saveCompletedAttempt(a.testId, a);
  if (document.fullscreenElement) await document.exitFullscreen().catch(() => {});
  location.href = new URL('./submit/', location.href).href;
}

function renderFinished(confirmed = state.attempt?.confirmedHandIn) {
  showScreen('finished');
  $('#finished-test-label').textContent = state.test.label;
  $('#receipt-code').textContent = state.attempt.receipt || '-';
  $('#submission-url').value = state.attempt.submissionUrl || '';
  $('#finished-before-confirm').hidden = !!confirmed;
  $('#finished-after-confirm').hidden = !confirmed;
  if (confirmed) document.body.classList.add('finished-green');
  else document.body.classList.remove('finished-green');
  setStatus($('#copy-status'), '', '');
  setStatus($('#release-status'), '', '');
}

async function verifyOwnSubmissionLink() {
  try {
    const url = new URL($('#submission-url').value);
    const params = new URLSearchParams(url.hash.slice(1));
    const token = params.get('s');
    const payload = await decodeCheckedPayload(token);
    if (payload.p !== state.pupil.id || payload.t !== state.test.id || !payload.f) throw new Error('The copied link does not match this pupil/test.');
    setStatus($('#copy-status'), `Verified. Receipt ${await receiptFromToken(token)} matches this submitted attempt.`, 'success');
  } catch (error) {
    setStatus($('#copy-status'), `Could not verify the copied link: ${error.message}`, 'error');
  }
}

function confirmHandIn() {
  state.attempt.confirmedHandIn = true;
  persistAttempt();
  storage.saveCompletedAttempt(state.attempt.testId, state.attempt);
  renderFinished(true);
}

async function showEstimatedResultsFromRelease() {
  const token = $('#release-token').value.trim();
  const result = await verifySignedToken(token, APP_CONFIG.teacherTokenKinds.release, { testId: state.test.id });
  if (!result.ok) {
    setStatus($('#release-status'), result.reason, 'error');
    return;
  }
  if (state.test.releaseExpiry) {
    const configuredExpiry = new Date(state.test.releaseExpiry).getTime();
    if (!Number.isFinite(configuredExpiry) || Date.now() > configuredExpiry || (result.payload.expiresAt && result.payload.expiresAt > configuredExpiry)) {
      setStatus($('#release-status'), 'This release is outside the expiry window configured for the test.', 'error');
      return;
    }
  }
  const grading = gradeAttempt(state.canonical, state.attempt.answers, state.test.grading);
  const list = $('#estimated-list');
  list.replaceChildren();
  grading.details.forEach((detail, index) => {
    const q = state.canonical[index];
    const row = document.createElement('div');
    row.className = `result-row result-${detail.band}`;
    const label = document.createElement('span');
    label.textContent = `${getPrompt(q)} → ${state.attempt.answers[index] || '(blank)'}`;
    const badge = document.createElement('strong');
    badge.textContent = detail.band === 'correct' ? 'likely correct' : detail.band === 'uncertain' ? 'needs review' : 'likely wrong';
    row.append(label, badge);
    list.appendChild(row);
  });
  $('#estimated-summary').textContent = `${grading.estimatedCorrect} automatically accepted, ${grading.uncertain} uncertain, ${grading.wrong} likely wrong. This is an estimate until teacher correction is final.`;
  $('#estimated-results').hidden = false;
  setStatus($('#release-status'), 'Release token verified.', 'success');
}

function choosePracticeQuestion() {
  const p = state.practice;
  const pending = p.questions.filter((_, idx) => (p.sessionCorrect[idx] || 0) < 2);
  if (!pending.length) return null;
  pending.sort((qa, qb) => {
    const ia = p.questions.indexOf(qa); const ib = p.questions.indexOf(qb);
    const ma = p.mastery[p.keys[ia]] || 0; const mb = p.mastery[p.keys[ib]] || 0;
    if ((p.sessionCorrect[ia] || 0) !== (p.sessionCorrect[ib] || 0)) return (p.sessionCorrect[ia] || 0) - (p.sessionCorrect[ib] || 0);
    return ma - mb;
  });
  const top = pending.slice(0, Math.min(5, pending.length));
  return top[Math.floor(Math.random() * top.length)];
}

function renderPracticeQuestion() {
  const p = state.practice;
  const question = choosePracticeQuestion();
  if (!question) {
    $('#practice-card').hidden = true;
    $('#practice-complete').hidden = false;
    return;
  }
  p.currentIndex = p.questions.indexOf(question);
  $('#practice-card').hidden = false;
  $('#practice-complete').hidden = true;
  $('#practice-direction').textContent = getDirectionLabel(question);
  $('#practice-prompt').textContent = getPrompt(question);
  $('#practice-answer').value = '';
  $('#practice-feedback').hidden = true;
  $('#practice-answer').disabled = false;
  $('#practice-check').disabled = false;
  const completed = p.sessionCorrect.filter(n => n >= 2).length;
  $('#practice-progress').textContent = `${completed} of ${p.questions.length} words completed for this practice round`;
  const level = p.mastery[p.keys[p.currentIndex]] || 0;
  $('#practice-mastery').textContent = ['New', 'Learning', 'Almost learned', 'Strong'][Math.max(0, Math.min(3, Math.round(level)))];
  $('#practice-answer').focus();
}

async function startPractice() {
  const practiceTestId = state.test.practiceTestId;
  if (!practiceTestId) {
    setStatus($('#release-status'), 'No next-week practice test is configured.', 'error');
    return;
  }
  const practiceTest = state.data.testById.get(practiceTestId);
  if (!practiceTest) return;
  const questions = buildCanonicalQuestions(state.data, practiceTest);
  const mastery = storage.getPracticeMastery();
  state.practice = {
    test: practiceTest,
    questions,
    keys: questions.map(q => `${practiceTest.id}:${q.wordId}:${q.direction}`),
    mastery,
    sessionCorrect: Array(questions.length).fill(0),
    currentIndex: 0
  };
  $('#practice-title').textContent = `Practice: ${practiceTest.label}`;
  showScreen('practice');
  renderPracticeQuestion();
}

function checkPracticeAnswer() {
  const p = state.practice;
  const idx = p.currentIndex;
  const q = p.questions[idx];
  const raw = $('#practice-answer').value;
  const grade = gradeAnswer(q, raw, p.test.grading);
  const feedback = $('#practice-feedback');
  feedback.hidden = false;
  feedback.className = `feedback feedback-${grade.band}`;
  const expected = acceptedAnswers(q)[0];
  if (grade.band === 'correct') {
    feedback.textContent = 'Correct.';
    p.sessionCorrect[idx] += 1;
    p.mastery[p.keys[idx]] = Math.min(3, (p.mastery[p.keys[idx]] || 0) + 1);
  } else if (grade.band === 'uncertain') {
    feedback.textContent = `Nearly correct. Expected: ${expected}`;
    p.mastery[p.keys[idx]] = Math.max(0, p.mastery[p.keys[idx]] || 0);
  } else {
    feedback.textContent = `Not correct. Expected: ${expected}`;
    p.sessionCorrect[idx] = Math.max(0, p.sessionCorrect[idx] - 1);
    p.mastery[p.keys[idx]] = Math.max(0, (p.mastery[p.keys[idx]] || 0) - 1);
  }
  storage.savePracticeMastery(p.mastery);
  $('#practice-answer').disabled = true;
  $('#practice-check').disabled = true;
  $('#practice-next').focus();
}

function resetIdentity() {
  if (!confirm('Reset the pupil identity on this browser? This also clears pupil-local attempts, saved result history, and practice progress on this browser.')) return;
  storage.clearPupilIdentity();
  storage.clearEntrySession();
  storage.clearActiveAttempt();
  storage.clearCompletedAttempts();
  storage.clearPupilHistory();
  storage.clearPracticeMastery();
  location.reload();
}

function returnToCodeScreen() {
  state.monitorActive = false;
  storage.clearActiveAttempt();
  state.attempt = null;
  state.test = null;
  state.canonical = [];
  state.practice = null;
  document.body.classList.remove('finished-green');
  $('#estimated-results').hidden = true;
  $('#test-code').value = '';
  showReadyScreen('Ready for another test when you are.');
}

async function restoreEntrySessionIfNeeded() {
  const saved = storage.getEntrySession();
  if (!saved || saved.pupilId !== state.pupil.id) return false;
  state.entrySession = saved;
  state.entrySession.violationCount = (state.entrySession.violationCount || 0) + 1;
  state.entrySession.violationEvents ||= [];
  state.entrySession.violationEvents.push({ type: 'page-reload-or-resume', at: Date.now(), lockEligible: true });
  state.entrySession.locked = true;
  persistEntrySession();
  state.monitorActive = true;
  if (saved.testId) {
    state.test = state.data.testById.get(saved.testId) || null;
    if (state.test) {
      state.canonical = buildCanonicalQuestions(state.data, state.test);
      configureRules(state.test);
    } else {
      showCodeScreen();
    }
  } else {
    showCodeScreen();
  }
  showLock();
  return true;
}

async function restoreAttemptIfNeeded() {
  const saved = storage.getActiveAttempt();
  if (!saved || saved.pupilId !== state.pupil.id) return false;
  const test = state.data.testById.get(saved.testId);
  if (!test) return false;
  state.test = test;
  state.canonical = buildCanonicalQuestions(state.data, test);
  state.attempt = saved;
  state.attempt.answerEdits ||= Array(state.canonical.length).fill(0);
  state.attempt.committedAnswers ||= state.attempt.answers.map(answer => answer || null);
  if (saved.submitted) {
    location.replace(new URL('./submit/', location.href).href);
    return true;
  }
  // Opening the page during an unfinished attempt counts as a refresh/re-entry event.
  state.attempt.violationCount += 1;
  state.attempt.violationEvents.push({ type: 'page-reload-or-resume', at: Date.now(), lockEligible: true });
  state.attempt.locked = true;
  persistAttempt();
  showScreen('test');
  state.monitorActive = true;
  renderQuestion();
  if (state.attempt.locked) showLock();
  return true;
}

function bindEvents() {
  $('#register-button').addEventListener('click', () => {
    const id = Number($('#pupil-select').value);
    const pupil = state.data.pupilById.get(id);
    if (!pupil?.active) return;
    setPupil(pupil);
    showReadyScreen();
  });
  $('#begin-secure-session').addEventListener('click', beginSecureSession);
  $('#request-session-exit').addEventListener('click', () => addViolation('teacher-exit-request', true));
  $('#code-form').addEventListener('submit', event => {
    event.preventDefault();
    const test = findTestByCode(state.data, $('#test-code').value);
    if (!test) {
      setStatus($('#code-status'), 'That test code is not active or is not recognized.', 'error');
      return;
    }
    state.test = test;
    state.canonical = buildCanonicalQuestions(state.data, test);
    if (state.entrySession) { state.entrySession.stage = 'rules'; state.entrySession.testId = test.id; persistEntrySession(); }
    configureRules(test);
  });
  $('#start-test').addEventListener('click', startTest);
  $('#answer-input').addEventListener('input', recordAnswerFromInput);
  $('#answer-input').addEventListener('paste', event => {
    event.preventDefault();
    setStatus($('#test-status'), 'Pasting is disabled during the test.', 'warning');
    setTimeout(() => setStatus($('#test-status'), '', ''), 1800);
  });
  $('#answer-input').addEventListener('keydown', event => {
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'v') event.preventDefault();
    if (event.key === 'Enter') { event.preventDefault(); handleNext(); }
  });
  $('#next-button').addEventListener('click', handleNext);
  $('#back-button').addEventListener('click', handleBack);
  $('#definition-toggle').addEventListener('click', () => {
    const wrap = $('#definition-wrap');
    wrap.hidden = !wrap.hidden;
  });
  $('#unlock-button').addEventListener('click', unlockAttempt);
  $('#submit-final').addEventListener('click', finalizeSubmission);
  $('#back-to-last-question').addEventListener('click', async () => {
    showScreen('test');
    if (state.test.requireFullscreen && !document.fullscreenElement) {
      try { await document.documentElement.requestFullscreen(); } catch { addViolation('fullscreen-reentry-denied', true); }
    }
    state.monitorActive = true;
    renderQuestion();
  });
  $('#copy-url').addEventListener('click', async () => {
    await navigator.clipboard.writeText($('#submission-url').value);
    setStatus($('#copy-status'), 'Link copied. Use “Verify copied link” before handing it in.', 'success');
  });
  $('#verify-url').addEventListener('click', verifyOwnSubmissionLink);
  $('#confirm-handin').addEventListener('click', confirmHandIn);
  $('#release-button').addEventListener('click', showEstimatedResultsFromRelease);
  $('#practice-button').addEventListener('click', startPractice);
  $('#new-test-button').addEventListener('click', returnToCodeScreen);
  $('#practice-check').addEventListener('click', checkPracticeAnswer);
  $('#practice-answer').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); checkPracticeAnswer(); } });
  $('#practice-next').addEventListener('click', renderPracticeQuestion);
  $('#practice-back').addEventListener('click', () => renderFinished(true));
  $('#practice-complete-back').addEventListener('click', () => renderFinished(true));
  $('#access-large-text').addEventListener('change', event => document.body.classList.toggle('a11y-large', event.target.checked));
  $('#access-high-contrast').addEventListener('change', event => document.body.classList.toggle('a11y-high-contrast', event.target.checked));
  $('#reset-pupil').addEventListener('click', resetIdentity);
}

async function init() {
  try {
    state.data = await loadAppData();
    bindEvents();
    installIntegrityMonitors();
    const savedIdentity = storage.getPupilIdentity();
    const pupil = savedIdentity ? state.data.pupilById.get(savedIdentity.id) : null;
    if (!pupil?.active) {
      renderRegistration();
      return;
    }
    state.pupil = pupil;
    $('#current-pupil').textContent = pupil.name;
    if (await restoreAttemptIfNeeded()) return;
    if (await restoreEntrySessionIfNeeded()) return;
    showReadyScreen();
  } catch (error) {
    console.error('Vocabulary site startup failed:', error);
    document.body.innerHTML = `<main class="fatal"><h1>Could not start the vocabulary site</h1><p>Please refresh the page. If the problem continues, ask your teacher for help.</p></main>`;
  }
}

init();
