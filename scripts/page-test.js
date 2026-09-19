import { APP_CONFIG } from './config.js';
import { hourKey } from './access-codes.js';
import { loadAppData, findTestByCode, buildCanonicalQuestions, buildPupilOrder, getPrompt, getDirectionLabel, isGradedTest, getActiveClasses, getActivePupils, getClass, getPupil, resolveClassTiming, isAfterRetakeCutoff } from './data.js';
import { gradeAttempt, gradeAnswer, acceptedAnswers } from './grading.js';
import { storage } from './storage.js';
import { encodeCheckedPayload, decodeCheckedPayload, receiptFromToken, verifySignedToken } from './cryptography.js';
import { makeUnlockRequest, makeLeaveRequest, verifyUnlockCode, verifyLeaveCode, normalizeFiveLetters } from './unlock-codes.js';
import {
  $, $$, setHidden, normalizeAnswer, randomId, formatDuration, formatDateTime, setStatus, sha256Hex
} from './utilities.js';

const state = {
  data: null,
  classRecord: null,
  pupil: null,
  test: null,
  accessMode: 'normal',
  accessHour: null,
  canonical: [],
  attempt: null,
  entrySession: null,
  monitorActive: false,
  countdownTimer: null,
  nextEnabledAt: 0,
  practice: null,
  guardTimer: null,
  fullscreenTransitionPending: false
};

const screens = ['registration', 'ready', 'code', 'rules', 'test', 'submit', 'finished', 'practice'];

function showScreen(name) {
  for (const screen of screens) setHidden($(`#screen-${screen}`), screen !== name);
  document.body.dataset.screen = name;
  const active = ['code', 'rules', 'test', 'submit'].includes(name) && (!!state.entrySession || !!(state.attempt && !state.attempt.submitted));
  document.body.classList.toggle('test-session-active', active);
}

function activePupils() {
  return getActivePupils(state.data, state.classRecord?.id);
}

function renderPupilChoices() {
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
}

function renderRegistration() {
  const classSelect = $('#class-select');
  classSelect.replaceChildren();
  const classes = getActiveClasses(state.data);
  for (const classRecord of classes) {
    const option = document.createElement('option');
    option.value = classRecord.id;
    option.textContent = classRecord.label;
    classSelect.appendChild(option);
  }
  state.classRecord = classes[0] || null;
  classSelect.value = state.classRecord?.id || '';
  renderPupilChoices();
  showScreen('registration');
}

function setPupil(pupil) {
  state.pupil = pupil;
  storage.setPupilIdentity({ classId: state.classRecord.id, id: pupil.id, name: pupil.name, registeredAt: Date.now() });
  $('#current-pupil').textContent = `${state.classRecord.label} · ${pupil.name}`;
}

function showReadyScreen(message = '') {
  state.monitorActive = false;
  showScreen('ready');
  $('#current-pupil').textContent = state.pupil ? `${state.classRecord?.label || ''} · ${state.pupil.name}` : '';
  setStatus($('#ready-status'), message, message ? 'info' : '');
}

function persistEntrySession() {
  if (state.entrySession) storage.saveEntrySession(state.entrySession);
}

function createEntrySession() {
  return {
    v: 1,
    sessionId: randomId(10),
    classId: state.classRecord.id,
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

  const enteredFullscreen = await enterProtectedFullscreen();
  if (!enteredFullscreen) addViolation('fullscreen-start-failed', true);
}

function showCodeScreen(message = '') {
  showScreen('code');
  $('#current-pupil').textContent = state.pupil ? `${state.classRecord?.label || ''} · ${state.pupil.name}` : '';
  setStatus($('#code-status'), message, message ? 'info' : '');
  $('#test-code').focus();
}

function showRetakeGate(test) {
  if (!state.entrySession) return;

  // This is a teacher-permission waiting screen, not an active test stage.
  // Pupils may need to switch to the teacher's window/device to obtain the code,
  // so focus/full-screen monitoring must be paused until permission is accepted.
  state.monitorActive = false;
  const requestSeed = `retake|${state.entrySession.sessionId}|${state.classRecord.id}|${state.pupil.id}|${test.id}`;
  state.entrySession.retakeRequest = state.entrySession.retakeRequest || makeUnlockRequest(requestSeed, 0);
  state.entrySession.stage = 'retake';
  state.entrySession.testId = test.id;
  state.entrySession.accessMode = state.accessMode;
  state.entrySession.accessHour = state.accessHour;
  state.entrySession.locked = false;
  state.entrySession.unlockRequest = null;
  persistEntrySession();

  $('#retake-test-label').textContent = test.label;
  $('#retake-request').textContent = state.entrySession.retakeRequest;
  $('#retake-token').value = '';
  setStatus($('#retake-status'), '', '');
  $('#retake-screen').hidden = false;
  document.body.classList.add('is-locked');
  $('#retake-token').focus();
}

function hideRetakeGate() {
  $('#retake-screen').hidden = true;
  document.body.classList.remove('is-locked');
}

function cancelRetakeGate() {
  state.monitorActive = false;
  hideRetakeGate();
  storage.clearEntrySession();
  state.entrySession = null;
  state.test = null;
  state.canonical = [];
  state.accessMode = 'normal';
  state.accessHour = null;
  $('#test-code').value = '';
  if (fullscreenElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) Promise.resolve(exit.call(document)).catch(() => {});
  }
  showReadyScreen('No repeat attempt was started.');
}

async function authorizeRetake() {
  const request = state.entrySession?.retakeRequest;
  const code = normalizeFiveLetters($('#retake-token').value);
  if (!request || !verifyUnlockCode(request, code)) {
    setStatus($('#retake-status'), 'That five-letter teacher code is not valid for this request.', 'error');
    return;
  }

  // Keep monitoring paused while restoring the protected full-screen session.
  // requestFullscreen is deliberately called from this button click so browsers
  // accept it as a user-initiated action. Do not authorize the retake until the
  // secure view has actually been restored.
  state.monitorActive = false;
  const restored = await enterProtectedFullscreen();
  if (!restored) {
    setStatus(
      $('#retake-status'),
      'The teacher code is correct, but full-screen could not be restored. Click “Allow another attempt” again and allow full-screen if the browser asks.',
      'error'
    );
    return;
  }

  state.entrySession.retakeAuthorizedTestId = state.test.id;
  state.entrySession.retakeRequest = null;
  state.entrySession.stage = 'rules';
  state.entrySession.locked = false;
  state.entrySession.unlockRequest = null;
  state.entrySession.violationEvents ||= [];
  state.entrySession.violationEvents.push({ type: 'teacher-authorized-retake', at: Date.now(), lockEligible: false });
  persistEntrySession();

  hideRetakeGate();
  configureRules(state.test);
  state.monitorActive = true;
  checkIntegrityNow('retake-authorized');
}

function configureRules(test) {
  $('#rules-test-label').textContent = test.label;
  $('#rules-count').textContent = String(test.questionCount ?? test.merge_amount ?? test.mergeAmount ?? 0);
  const gradeBadge = $('#rules-grade-badge');
  if (gradeBadge) { gradeBadge.textContent = isGradedTest(test) ? 'Graded test' : 'Practice / not graded'; gradeBadge.dataset.graded = isGradedTest(test) ? 'true' : 'false'; }
  $('#rules-fullscreen').textContent = test.requireFullscreen ? 'Full-screen is required.' : 'Full-screen is recommended.';
  const lateNote = $('#rules-late-note');
  if (state.accessMode === 'late') {
    lateNote.textContent = 'This attempt is being recorded as taken later. Its question selection is randomized separately from the normal test session.';
    lateNote.hidden = false;
  } else {
    lateNote.hidden = true;
  }
  updateStartAvailability();
  clearInterval(state.countdownTimer);
  state.countdownTimer = setInterval(updateStartAvailability, 1000);
  showScreen('rules');
}

function updateStartAvailability() {
  if (!state.test) return;
  const startButton = $('#start-test');
  const countdown = $('#opening-countdown');
  const backButton = $('#rules-back-code');
  const timing = resolveClassTiming(state.test, state.classRecord.id);
  const now = Date.now();
  if (timing.closingTime) {
    const closing = new Date(timing.closingTime).getTime();
    if (Number.isFinite(closing) && now > closing) {
      startButton.disabled = true;
      backButton.hidden = false;
      countdown.textContent = 'This test is closed for your class.';
      return;
    }
  }
  if (state.accessMode === 'late' && state.accessHour && hourKey(now) !== state.accessHour) {
    startButton.disabled = true;
    backButton.hidden = false;
    countdown.textContent = 'This hourly late/retake code has expired. Go back and enter the code for the current hour.';
    return;
  }
  if (state.accessMode !== 'late' && isAfterRetakeCutoff(state.test, state.classRecord.id, now)) {
    startButton.disabled = true;
    backButton.hidden = false;
    countdown.textContent = 'The normal test time has ended. Go back and enter the current late/retake code from your teacher.';
    return;
  }
  backButton.hidden = true;
  if (!timing.openingTime) {
    startButton.disabled = false;
    countdown.textContent = state.accessMode === 'late' ? 'Late/retake access is open.' : 'The test is open.';
    return;
  }
  const opening = new Date(timing.openingTime).getTime();
  const remaining = opening - now;
  if (remaining <= 0) {
    startButton.disabled = false;
    countdown.textContent = state.accessMode === 'late' ? 'Late/retake access is open.' : 'The test is open.';
  } else {
    startButton.disabled = true;
    const seconds = Math.ceil(remaining / 1000);
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    countdown.textContent = `The test opens in ${mins}:${String(secs).padStart(2, '0')}.`;
  }
}

function createAttempt() {
  const startedAt = Date.now();
  const attemptSeed = state.accessMode === 'late' ? startedAt : null;
  state.canonical = buildCanonicalQuestions(state.data, state.test, { attemptSeed });
  const order = buildPupilOrder(state.canonical, state.test, state.pupil.id, { attemptSeed });
  return {
    v: 2,
    attemptId: randomId(10),
    testId: state.test.id,
    classId: state.classRecord.id,
    pupilId: state.pupil.id,
    lateAttempt: state.accessMode === 'late',
    repeatAttempt: state.entrySession?.retakeAuthorizedTestId === state.test.id,
    attemptSeed,
    configVersion: state.test.configVersion,
    startTime: startedAt,
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

function showPupilLeaveGate() {
  const attempt = state.attempt;
  if (!attempt || attempt.submitted || attempt.locked) return;

  recordAnswerFromInput();
  attempt.leaveRequest = attempt.leaveRequest || makeLeaveRequest(attempt.attemptId);
  persistAttempt();

  $('#leave-request').textContent = attempt.leaveRequest;
  $('#leave-token').value = '';
  setStatus($('#leave-status'), '', '');
  $('#leave-test-screen').hidden = false;
  document.body.classList.add('is-leave-request');
  $('#leave-token').focus();
}

function hidePupilLeaveGate({ focusAnswer = true } = {}) {
  const screen = $('#leave-test-screen');
  if (screen) screen.hidden = true;
  document.body.classList.remove('is-leave-request');
  setStatus($('#leave-status'), '', '');
  if (focusAnswer && state.attempt && !state.attempt.locked && document.body.dataset.screen === 'test') $('#answer-input')?.focus();
}

async function abandonCurrentSession(eventType, message) {
  const record = currentGuardRecord();
  if (!record) return;

  state.monitorActive = false;
  record.locked = false;
  record.violationEvents ||= [];
  record.violationEvents.push({ type: eventType, at: Date.now(), lockEligible: false });
  record.unlockRequest = null;
  if (record === state.attempt) record.leaveRequest = null;
  persistGuardRecord(record);

  hidePupilLeaveGate({ focusAnswer: false });
  hideLock();
  hideRetakeGate();
  clearInterval(state.countdownTimer);
  storage.clearEntrySession();
  storage.clearActiveAttempt();
  state.entrySession = null;
  state.attempt = null;
  state.test = null;
  state.canonical = [];
  state.practice = null;
  state.accessMode = 'normal';
  state.accessHour = null;
  $('#test-code').value = '';
  $('#unlock-token').value = '';
  $('#leave-token').value = '';

  if (fullscreenElement()) {
    const exit = document.exitFullscreen || document.webkitExitFullscreen;
    if (exit) {
      try { await exit.call(document); } catch { /* The unfinished session is already safely abandoned. */ }
    }
  }
  showReadyScreen(message);
}

async function authorizePupilLeave() {
  const attempt = state.attempt;
  const code = normalizeFiveLetters($('#leave-token').value);
  if (!attempt?.leaveRequest || !verifyLeaveCode(attempt.leaveRequest, code)) {
    setStatus($('#leave-status'), 'That five-letter code is not a valid leave code for this request. Ask the teacher to use “Approve leaving a test,” not “Unlock a pupil.”', 'error');
    return;
  }
  await abandonCurrentSession('teacher-authorized-pupil-leave', 'Your teacher approved leaving the unfinished test. You can start a new session when ready.');
}

async function hasValidTeacherAccess() {
  const token = storage.getTeacherAccessToken();
  if (!token) return false;
  try {
    const result = await verifySignedToken(token, APP_CONFIG.teacherTokenKinds.access);
    return !!result.ok;
  } catch {
    return false;
  }
}

async function refreshLockedTeacherControls() {
  const controls = $('#locked-teacher-controls');
  if (!controls) return;

  // Never expose no-code teacher actions on a pupil browser. The controls are
  // hidden by default and only revealed after the browser's saved teacher
  // access token has been cryptographically verified.
  controls.hidden = true;
  controls.open = false;
  if (await hasValidTeacherAccess()) controls.hidden = false;
}

function showLock() {
  const record = currentGuardRecord();
  if (!record) return;
  hidePupilLeaveGate({ focusAnswer: false });
  void refreshLockedTeacherControls();

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

function fullscreenElement() {
  return document.fullscreenElement || document.webkitFullscreenElement || null;
}

async function enterProtectedFullscreen() {
  if (fullscreenElement()) return true;
  const root = document.documentElement;
  const request = root.requestFullscreen || root.webkitRequestFullscreen;
  if (!request) return false;

  state.fullscreenTransitionPending = true;
  try {
    const result = request.call(root);
    if (result?.then) await result;
    return !!fullscreenElement();
  } catch {
    return false;
  } finally {
    state.fullscreenTransitionPending = false;
  }
}

async function unlockAttempt() {
  const record = currentGuardRecord();
  const code = normalizeFiveLetters($('#unlock-token').value);
  if (!record?.unlockRequest || !verifyUnlockCode(record.unlockRequest, code)) {
    setStatus($('#unlock-status'), 'That five-letter code is not valid for this request.', 'error');
    return;
  }

  // During the entry/code stage, a teacher unlock intentionally ends the secure
  // session rather than returning the pupil to the test.
  if (record === state.entrySession && !state.attempt) {
    record.locked = false;
    record.violationEvents.push({ type: 'teacher-unlock', at: Date.now(), lockEligible: false });
    record.unlockRequest = null;
    persistEntrySession();
    hideLock();
    hideRetakeGate();
    storage.clearEntrySession();
    state.entrySession = null;
    state.test = null;
    state.canonical = [];
    state.monitorActive = false;
    if (fullscreenElement()) {
      const exit = document.exitFullscreen || document.webkitExitFullscreen;
      if (exit) Promise.resolve(exit.call(document)).catch(() => {});
    }
    showReadyScreen('Your teacher ended the test session. You can start again when ready.');
    return;
  }

  // For an active test that requires full-screen, restore full-screen *before*
  // clearing the lock. This prevents a valid teacher code from leaving the pupil
  // able to continue in a normal browser window if requestFullscreen is blocked.
  if (state.test?.requireFullscreen && !fullscreenElement()) {
    const restored = await enterProtectedFullscreen();
    if (!restored) {
      showLock();
      setStatus(
        $('#unlock-status'),
        'The unlock code is correct, but full-screen could not be restored. Click “Unlock test” again and allow full-screen if the browser asks.',
        'error'
      );
      return;
    }
  }

  record.locked = false;
  record.violationEvents.push({ type: 'teacher-unlock', at: Date.now(), lockEligible: false });
  record.unlockRequest = null;
  persistAttempt();
  hideLock();
  renderQuestion();
}

async function leaveLockedTest() {
  const record = currentGuardRecord();
  if (!record) return;

  // Defense in depth: hiding the button is not the authorization check. Even a
  // programmatic click must have a valid saved teacher-access token.
  if (!(await hasValidTeacherAccess())) {
    await refreshLockedTeacherControls();
    setStatus($('#unlock-status'), 'Ending a locked test without a code is available only in verified teacher mode.', 'error');
    return;
  }

  const confirmed = window.confirm(
    'Teacher only: end this locked test without a code?\n\nThis permanently discards the unfinished attempt on this browser. Choose Cancel if you meant to unlock the pupil instead.'
  );
  if (!confirmed) return;

  await abandonCurrentSession('teacher-left-locked-test', 'Your teacher ended the unfinished test. You can start a new session when ready.');
}

function protectedSessionNeedsFullscreen() {
  return !!state.entrySession || !!state.test?.requireFullscreen;
}

function checkIntegrityNow(source = 'guard-check') {
  if (!state.monitorActive) return;
  const record = currentGuardRecord();
  if (!record || record.submitted) return;

  if (record.locked) {
    const lockScreen = $('#lock-screen');
    if (lockScreen?.hidden || !document.body.classList.contains('is-locked')) showLock();
    return;
  }

  if (document.visibilityState === 'hidden') {
    addViolation('tab-or-window-hidden', true);
    return;
  }

  if (protectedSessionNeedsFullscreen() && !state.fullscreenTransitionPending && !fullscreenElement()) {
    addViolation(source === 'fullscreenchange' ? 'fullscreen-exit' : 'fullscreen-missing', true);
    return;
  }

  // hasFocus() catches application/window switches that do not always produce a
  // useful visibilitychange in every browser. Do not use it while entering
  // full-screen because that transition can briefly move focus itself.
  if (!state.fullscreenTransitionPending && !document.hasFocus()) {
    addViolation('window-blur', true);
  }
}

function installIntegrityMonitors() {
  document.addEventListener('visibilitychange', () => checkIntegrityNow('visibilitychange'));

  const onFullscreenChange = () => checkIntegrityNow('fullscreenchange');
  document.addEventListener('fullscreenchange', onFullscreenChange);
  document.addEventListener('webkitfullscreenchange', onFullscreenChange);

  window.addEventListener('blur', () => checkIntegrityNow('window-blur'));
  window.addEventListener('focus', () => checkIntegrityNow('window-focus'));
  window.addEventListener('pageshow', () => checkIntegrityNow('pageshow'));

  // Browser full-screen/focus events can occasionally be skipped during rapid
  // Escape/Alt+Tab transitions. Keep a lightweight watchdog while a protected
  // session is active so the page cannot silently remain usable outside full-screen.
  clearInterval(state.guardTimer);
  state.guardTimer = window.setInterval(() => checkIntegrityNow('watchdog'), 200);

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
  if (state.accessMode === 'late' && state.accessHour && hourKey(Date.now()) !== state.accessHour) {
    updateStartAvailability();
    return;
  }
  if (state.accessMode !== 'late' && isAfterRetakeCutoff(state.test, state.classRecord.id)) {
    updateStartAvailability();
    return;
  }
  clearInterval(state.countdownTimer);
  state.attempt = createAttempt();
  storage.clearEntrySession();
  state.entrySession = null;
  persistAttempt();
  showScreen('test');
  state.monitorActive = true;

  if (state.test.requireFullscreen && !fullscreenElement()) {
    const enteredFullscreen = await enterProtectedFullscreen();
    if (!enteredFullscreen) addViolation('fullscreen-denied', true);
  }

  if (state.attempt.locked) showLock();
  else renderQuestion();
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
    cl: a.classId,
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
  if (a.lateAttempt) { payload.l = 1; payload.m = a.attemptSeed; }
  if (a.repeatAttempt) payload.rp = 1;
  const token = await encodeCheckedPayload(payload);
  const url = new URL('./', location.href);
  // Keep the pupil name visibly at the beginning of the submission URL after the GitHub Pages base.
  // Opening this link routes to the teacher dashboard, which independently checks the visible name.
  const visibleName = state.pupil.name.trim().replace(/\s+/g, '-');
  url.search = `?${encodeURIComponent(visibleName)}`;
  url.hash = token;
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
    const rawHash = url.hash.slice(1);
    const params = new URLSearchParams(rawHash);
    const token = params.get('s') || (rawHash && !rawHash.includes('=') ? decodeURIComponent(rawHash) : '');
    const payload = await decodeCheckedPayload(token);
    if (payload.p !== state.pupil.id || payload.t !== state.test.id || (payload.cl && payload.cl !== state.classRecord.id) || !payload.f) throw new Error('The copied link does not match this pupil/test.');
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
  if (!confirm('Reset the pupil identity on this browser? This clears pupil-local attempts, saved result history, and practice progress. Finished tests will still require teacher permission before the same pupil can take them again.')) return;
  if (state.pupil?.id != null) storage.preserveCompletedTestsForPupil(state.classRecord?.id, state.pupil.id, state.data.roster.classes[0]?.id);
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
  hideRetakeGate();
  storage.clearActiveAttempt();
  state.attempt = null;
  state.test = null;
  state.canonical = [];
  state.practice = null;
  document.body.classList.remove('finished-green');
  if ($('#estimated-results')) $('#estimated-results').hidden = true;
  $('#test-code').value = '';
  showReadyScreen('Ready for another test when you are.');
}

async function restoreEntrySessionIfNeeded() {
  const saved = storage.getEntrySession();
  if (!saved || saved.pupilId !== state.pupil.id || (saved.classId && saved.classId !== state.classRecord.id)) return false;
  state.entrySession = saved;

  // A retake-permission screen is intentionally outside the protected test
  // session. Reloading/returning to it must not create a second lock screen.
  if (saved.stage === 'retake' && saved.testId) {
    state.test = state.data.testById.get(saved.testId) || null;
    if (state.test) {
      state.accessMode = saved.accessMode || (isAfterRetakeCutoff(state.test, state.classRecord.id) ? 'late' : 'normal');
      state.accessHour = saved.accessHour || (state.accessMode === 'late' ? hourKey(Date.now()) : null);
      state.canonical = buildCanonicalQuestions(state.data, state.test);
      state.entrySession.locked = false;
      state.entrySession.unlockRequest = null;
      persistEntrySession();
      showRetakeGate(state.test);
      return true;
    }
  }

  state.entrySession.violationCount = (state.entrySession.violationCount || 0) + 1;
  state.entrySession.violationEvents ||= [];
  state.entrySession.violationEvents.push({ type: 'page-reload-or-resume', at: Date.now(), lockEligible: true });
  state.entrySession.locked = true;
  persistEntrySession();
  state.monitorActive = true;
  if (saved.testId) {
    state.test = state.data.testById.get(saved.testId) || null;
    if (state.test) {
      state.accessMode = saved.accessMode || (isAfterRetakeCutoff(state.test, state.classRecord.id) ? 'late' : 'normal');
      state.accessHour = saved.accessHour || (state.accessMode === 'late' ? hourKey(Date.now()) : null);
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
  if (!saved || saved.pupilId !== state.pupil.id || (saved.classId && saved.classId !== state.classRecord.id)) return false;
  const test = state.data.testById.get(saved.testId);
  if (!test) return false;
  state.test = test;
  state.accessMode = saved.lateAttempt ? 'late' : 'normal';
  state.accessHour = null;
  state.canonical = buildCanonicalQuestions(state.data, test, { attemptSeed: saved.attemptSeed ?? null });
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
  $('#class-select').addEventListener('change', event => {
    state.classRecord = getClass(state.data, event.target.value);
    renderPupilChoices();
  });
  $('#register-button').addEventListener('click', () => {
    const rawId = $('#pupil-select').value;
    const id = /^-?\d+$/.test(rawId) ? Number(rawId) : rawId;
    const pupil = getPupil(state.data, state.classRecord?.id, id);
    if (!pupil?.active) return;
    setPupil(pupil);
    showReadyScreen();
  });
  $('#begin-secure-session').addEventListener('click', beginSecureSession);
  $('#request-session-exit').addEventListener('click', () => addViolation('teacher-exit-request', true));
  $('#code-form').addEventListener('submit', event => {
    event.preventDefault();
    const access = findTestByCode(state.data, $('#test-code').value, state.classRecord.id);
    if (!access) {
      setStatus($('#code-status'), 'That five-letter code is not active for this class and time.', 'error');
      return;
    }
    const test = access.test;
    state.test = test;
    state.accessMode = access.mode;
    state.accessHour = access.accessHour || null;
    state.canonical = buildCanonicalQuestions(state.data, test);

    const alreadyFinished = storage.hasCompletedTest(state.classRecord.id, state.pupil.id, test.id, state.data.roster.classes[0]?.id);
    const authorizedForRetake = state.entrySession?.retakeAuthorizedTestId === test.id;
    if (alreadyFinished && !authorizedForRetake) {
      showRetakeGate(test);
      return;
    }

    if (state.entrySession) { state.entrySession.stage = 'rules'; state.entrySession.testId = test.id; state.entrySession.accessMode = state.accessMode; state.entrySession.accessHour = state.accessHour; persistEntrySession(); }
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
  $('#request-leave-test').addEventListener('click', showPupilLeaveGate);
  $('#leave-cancel').addEventListener('click', () => hidePupilLeaveGate());
  $('#leave-confirm').addEventListener('click', authorizePupilLeave);
  $('#leave-token').addEventListener('input', event => { event.target.value = normalizeFiveLetters(event.target.value); });
  $('#leave-token').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); authorizePupilLeave(); } });
  $('#definition-toggle').addEventListener('click', () => {
    const wrap = $('#definition-wrap');
    wrap.hidden = !wrap.hidden;
  });
  $('#unlock-button').addEventListener('click', unlockAttempt);
  const lockedTeacherControls = $('#locked-teacher-controls');
  if (lockedTeacherControls) {
    lockedTeacherControls.addEventListener('toggle', () => {
      if (!lockedTeacherControls.open) return;
      requestAnimationFrame(() => {
        const card = lockedTeacherControls.closest('.lock-card');
        if (!card) return;
        card.scrollTo({ top: card.scrollHeight, behavior: 'smooth' });
      });
    });
  }
  $('#leave-locked-test').addEventListener('click', leaveLockedTest);
  $('#retake-button').addEventListener('click', authorizeRetake);
  $('#retake-back').addEventListener('click', cancelRetakeGate);
  $('#rules-back-code').addEventListener('click', () => {
    clearInterval(state.countdownTimer);
    state.test = null;
    state.accessMode = 'normal';
    state.accessHour = null;
    if (state.entrySession) { state.entrySession.stage = 'code'; state.entrySession.testId = null; state.entrySession.accessMode = 'normal'; state.entrySession.accessHour = null; persistEntrySession(); }
    $('#test-code').value = '';
    showCodeScreen();
  });
  $('#retake-token').addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); authorizeRetake(); }
  });
  $('#submit-final').addEventListener('click', finalizeSubmission);
  $('#back-to-last-question').addEventListener('click', async () => {
    showScreen('test');
    if (state.test.requireFullscreen && !fullscreenElement()) {
      const enteredFullscreen = await enterProtectedFullscreen();
      if (!enteredFullscreen) addViolation('fullscreen-reentry-denied', true);
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
  $('#release-button')?.addEventListener('click', showEstimatedResultsFromRelease);
  $('#back-to-link')?.addEventListener('click', () => { state.attempt.confirmedHandIn = false; persistAttempt(); storage.saveCompletedAttempt(state.attempt.testId, state.attempt); renderFinished(false); });
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
    state.classRecord = savedIdentity ? getClass(state.data, savedIdentity.classId) : null;
    const pupil = savedIdentity ? getPupil(state.data, state.classRecord?.id, savedIdentity.id) : null;
    if (!state.classRecord?.active || !pupil?.active) {
      renderRegistration();
      return;
    }
    state.pupil = pupil;
    $('#current-pupil').textContent = `${state.classRecord.label} · ${pupil.name}`;
    storage.preserveCompletedTestsForPupil(state.classRecord.id, pupil.id, state.data.roster.classes[0]?.id);
    if (await restoreAttemptIfNeeded()) return;
    if (await restoreEntrySessionIfNeeded()) return;
    showReadyScreen();
  } catch (error) {
    console.error('Vocabulary site startup failed:', error);
    document.body.innerHTML = `<main class="fatal"><h1>Could not start the vocabulary site</h1><p>Please refresh the page. If the problem continues, ask your teacher for help.</p></main>`;
  }
}

init();
