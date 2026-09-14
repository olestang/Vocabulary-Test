import { APP_CONFIG } from './config.js';
import { loadAppData, buildCanonicalQuestions, getPrompt, getDirectionLabel } from './data.js';
import { gradeAttempt, gradeAnswer, acceptedAnswers } from './grading.js';
import { storage } from './storage.js';
import { decodeCheckedPayload, receiptFromToken, verifySignedToken } from './cryptography.js';
import { $, setStatus } from './utilities.js';

const state = { data: null, pupil: null, attempt: null, test: null, canonical: [], practice: null };

function latestSubmittedAttempt(pupilId) {
  const active = storage.getActiveAttempt();
  if (active?.submitted && active.pupilId === pupilId) return active;
  return Object.values(storage.getCompletedAttempts())
    .filter(a => a?.submitted && a.pupilId === pupilId)
    .sort((a, b) => (b.finishTime || 0) - (a.finishTime || 0))[0] || null;
}

function saveAttempt() {
  if (!state.attempt) return;
  storage.saveCompletedAttempt(state.attempt.testId, state.attempt);
  const active = storage.getActiveAttempt();
  if (active?.attemptId === state.attempt.attemptId) storage.saveActiveAttempt(state.attempt);
}

function renderSubmission() {
  $('#no-submission').hidden = true;
  $('#submission-screen').hidden = false;
  $('#practice-screen').hidden = true;
  $('#finished-test-label').textContent = state.test.label;
  $('#receipt-code').textContent = state.attempt.receipt || '-';
  $('#submission-url').value = state.attempt.submissionUrl || '';
  const confirmed = !!state.attempt.confirmedHandIn;
  $('#finished-before-confirm').hidden = confirmed;
  $('#finished-after-confirm').hidden = !confirmed;
  document.body.classList.toggle('finished-green', confirmed);
  setStatus($('#copy-status'), '', '');
  setStatus($('#release-status'), '', '');
}

async function copySubmissionUrl() {
  try {
    await navigator.clipboard.writeText($('#submission-url').value);
    setStatus($('#copy-status'), 'Link copied. You can verify it before handing it in.', 'success');
  } catch {
    $('#submission-url').focus();
    $('#submission-url').select();
    setStatus($('#copy-status'), 'Select and copy the link shown above.', 'warning');
  }
}

async function verifyOwnSubmissionLink() {
  try {
    const url = new URL($('#submission-url').value);
    const params = new URLSearchParams(url.hash.slice(1));
    const token = params.get('s');
    if (!token) throw new Error('The link has no submission data.');
    const payload = await decodeCheckedPayload(token);
    if (payload.p !== state.pupil.id || payload.t !== state.test.id || !payload.f) throw new Error('The link does not match this pupil and test.');
    setStatus($('#copy-status'), `Verified. Receipt ${await receiptFromToken(token)} matches this submitted attempt.`, 'success');
  } catch (error) {
    setStatus($('#copy-status'), `Could not verify the link: ${error.message}`, 'error');
  }
}

function confirmHandIn() {
  state.attempt.confirmedHandIn = true;
  saveAttempt();
  renderSubmission();
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
  setStatus($('#release-status'), 'Results release code accepted.', 'success');
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

function startPractice() {
  const practiceTestId = state.test.practiceTestId;
  if (!practiceTestId) {
    setStatus($('#release-status'), 'No next-week practice test is configured.', 'error');
    return;
  }
  const practiceTest = state.data.testById.get(practiceTestId);
  if (!practiceTest) {
    setStatus($('#release-status'), 'The configured practice test could not be found.', 'error');
    return;
  }
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
  $('#submission-screen').hidden = true;
  $('#practice-screen').hidden = false;
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

function goToNewTest() {
  const active = storage.getActiveAttempt();
  if (active?.attemptId === state.attempt.attemptId) storage.clearActiveAttempt();
  location.href = '../';
}

function bindEvents() {
  $('#copy-url').addEventListener('click', copySubmissionUrl);
  $('#verify-url').addEventListener('click', verifyOwnSubmissionLink);
  $('#confirm-handin').addEventListener('click', confirmHandIn);
  $('#release-button').addEventListener('click', showEstimatedResultsFromRelease);
  $('#practice-button').addEventListener('click', startPractice);
  $('#new-test-button').addEventListener('click', goToNewTest);
  $('#practice-check').addEventListener('click', checkPracticeAnswer);
  $('#practice-answer').addEventListener('keydown', event => { if (event.key === 'Enter') { event.preventDefault(); checkPracticeAnswer(); } });
  $('#practice-next').addEventListener('click', renderPracticeQuestion);
  $('#practice-back').addEventListener('click', renderSubmission);
  $('#practice-complete-back').addEventListener('click', renderSubmission);
}

async function init() {
  try {
    state.data = await loadAppData();
    bindEvents();
    const identity = storage.getPupilIdentity();
    state.pupil = identity ? state.data.pupilById.get(identity.id) : null;
    if (!state.pupil?.active) {
      $('#no-submission').hidden = false;
      $('#no-submission h1').textContent = 'Register your pupil name first';
      $('#no-submission .lead').textContent = 'Go back to the test page and choose your name before using the submission page.';
      return;
    }
    $('#current-pupil').textContent = state.pupil.name;
    state.attempt = latestSubmittedAttempt(state.pupil.id);
    if (!state.attempt) {
      $('#no-submission').hidden = false;
      return;
    }
    state.test = state.data.testById.get(state.attempt.testId);
    if (!state.test) throw new Error('The test configuration for the last submitted attempt no longer exists.');
    state.canonical = buildCanonicalQuestions(state.data, state.test);
    renderSubmission();
  } catch (error) {
    document.body.innerHTML = `<main class="fatal"><h1>Could not open the submission page</h1><p>${error.message}</p></main>`;
  }
}

init();
