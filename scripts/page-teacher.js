import { APP_CONFIG } from './config.js';
import { loadAppData, buildCanonicalQuestions, getPrompt, getDirectionLabel, isGradedTest, getActiveClasses, getActivePupils, getClass, getPupil, pupilKey, resolveClassTiming } from './data.js';
import { gradeAttempt, acceptedAnswers } from './grading.js';
import { storage } from './storage.js';
import { decodeCheckedPayload, encodeCheckedPayload, encryptForPin, receiptFromToken, verifySignedToken, signTeacherToken, privateKeyMatchesPublic } from './cryptography.js';
import { makeUnlockCode, makeLeaveCode, normalizeFiveLetters } from './unlock-codes.js';
import { classTestCode, lateTestCode, localHourInputValue } from './access-codes.js';
import {
  $, normalizeAnswer, parseHashParams, formatDuration, formatDateTime, setStatus, downloadText, sha256Hex, packBits
} from './utilities.js';

const state = {
  data: null,
  teacherData: null,
  selectedClassId: null,
  selectedTestId: null,
  correction: null,
  pendingSubmissionToken: null,
  correctAllMode: false
};

function showAuth(message = '') {
  $('#teacher-auth').hidden = false;
  if ($('#open-settings')) $('#open-settings').hidden = true;
  const authLink = $('#teacher-auth-link');
  if (authLink) authLink.href = `../become-teacher/?return=${encodeURIComponent(location.href)}`;
  $('#teacher-main').hidden = true;
  setStatus($('#teacher-auth-status'), message, message ? 'error' : '');
}

function showMain() {
  $('#teacher-auth').hidden = true;
  $('#teacher-main').hidden = false;
  if ($('#open-settings')) $('#open-settings').hidden = false;
}

function hideActivityPanel() {
  const panel = $('#activity-panel');
  if (panel) panel.hidden = true;
}

function setSettingsMenuOpen(open) {
  const button = $('#open-settings');
  const menu = $('#settings-menu');
  if (!button || !menu) return;
  menu.hidden = !open;
  button.setAttribute('aria-expanded', open ? 'true' : 'false');
}

function openSettingsSection(sectionId) {
  activateDashboardView('settings');
  setSettingsMenuOpen(false);
  requestAnimationFrame(() => {
    const section = document.getElementById(sectionId);
    if (!section) return;
    section.scrollIntoView({ behavior: 'smooth', block: 'start' });
    section.focus({ preventScroll: true });
  });
}

async function validateTeacherAccess(token) {
  return verifySignedToken(token, APP_CONFIG.teacherTokenKinds.access);
}

async function enterTeacherMode(token) {
  const result = await validateTeacherAccess(token);
  if (!result.ok) {
    showAuth(result.reason);
    return false;
  }
  storage.setTeacherAccessToken(token);
  showMain();
  renderDashboard();
  await importFromHashIfPresent();
  return true;
}

function currentClass() {
  return getClass(state.data, state.selectedClassId);
}

function activePupils(classId = state.selectedClassId) {
  return getActivePupils(state.data, classId);
}

function recordKey(classId, pupilId) {
  return pupilKey(classId || currentClass()?.id || 'default', pupilId);
}

function getSubmission(testId, pupilId, classId = state.selectedClassId) {
  const bucket = state.teacherData.submissions?.[testId] || {};
  return bucket[recordKey(classId, pupilId)] || (classId === state.data.roster.classes[0]?.id ? bucket[pupilId] : null) || null;
}

function getCorrection(testId, pupilId, classId = state.selectedClassId) {
  const bucket = state.teacherData.corrections?.[testId] || {};
  return bucket[recordKey(classId, pupilId)] || (classId === state.data.roster.classes[0]?.id ? bucket[pupilId] : null) || null;
}

function setSubmission(testId, classId, pupilId, value) {
  ensureBuckets(testId);
  state.teacherData.submissions[testId][recordKey(classId, pupilId)] = value;
}

function setCorrection(testId, classId, pupilId, value) {
  ensureBuckets(testId);
  state.teacherData.corrections[testId][recordKey(classId, pupilId)] = value;
}

function saveTeacherData() {
  storage.saveTeacherData(state.teacherData);
}

function ensureBuckets(testId) {
  state.teacherData.submissions[testId] ||= {};
  state.teacherData.corrections[testId] ||= {};
}

function visibleNameToken(name) { return String(name || '').trim().replace(/\s+/g, '-'); }

function validateSubmissionPayload(payload, externalPupilName, test, classRecord, pupil, canonical) {
  const warnings = [];
  let suspicious = false;
  if (payload.v !== APP_CONFIG.submissionFormatVersion) warnings.push(`Unknown submission format v${payload.v}.`);
  if (!test) warnings.push('The test ID in the payload is not configured on this site.');
  if (!pupil) warnings.push('The pupil ID in the payload is not in the roster.');
  const cleanExternalName = String(externalPupilName || '').split('&')[0].trim();
  if (cleanExternalName && pupil && cleanExternalName !== visibleNameToken(pupil.name)) {
    warnings.push(`Possible identity substitution: the visible URL name “${cleanExternalName}” does not match the submission identity “${pupil.name}”.`);
    suspicious = true;
  }
  if (test && payload.cv !== test.configVersion) warnings.push(`Config version mismatch: payload ${payload.cv}, current ${test.configVersion}.`);
  if (!Array.isArray(payload.r) || (canonical && payload.r.length !== canonical.length)) warnings.push('Answer count does not match the configured question count.');
  if (!/^\d{4}$/.test(String(payload.c || ''))) warnings.push('The pupil result PIN is not a four-digit code.');
  if (!Number.isFinite(payload.s) || !Number.isFinite(payload.f) || payload.f < payload.s) {
    warnings.push('Impossible or missing timestamps.');
    suspicious = true;
  } else {
    const duration = payload.f - payload.s;
    if (duration > 6 * 60 * 60 * 1000) warnings.push('Attempt duration is over six hours.');
    if (payload.f > Date.now() + 5 * 60 * 1000) {
      warnings.push('Finish time is unexpectedly in the future.');
      suspicious = true;
    }
    if (test && classRecord && payload.cl) {
      const cutoffValue = resolveClassTiming(test, classRecord.id).countAsRetakeAfter;
      const cutoff = cutoffValue ? new Date(cutoffValue).getTime() : NaN;
      if (Number.isFinite(cutoff)) {
        if (payload.s >= cutoff && payload.l !== 1) warnings.push('This class/test started after its retake cutoff but the submission is not marked as taken later.');
        if (payload.l === 1 && payload.s < cutoff) warnings.push('The submission is marked as taken later even though its saved start time is before the configured cutoff.');
      }
    }
  }
  if (payload.l === 1 && !Number.isFinite(payload.m)) {
    warnings.push('Taken-later submission is missing its millisecond randomization seed.');
    suspicious = true;
  } else if (payload.l === 1 && Number.isFinite(payload.s) && payload.m !== payload.s) {
    warnings.push('Taken-later millisecond seed does not match the saved attempt start time.');
    suspicious = true;
  }
  return { warnings, suspicious };
}

async function importSubmissionToken(token, externalPupilName = '') {
  let payload;
  try {
    payload = await decodeCheckedPayload(token);
  } catch (error) {
    setStatus($('#import-status'), `Invalid or damaged submission URL: ${error.message}`, 'error');
    $('#import-panel').hidden = false;
    return;
  }
  const test = state.data.testById.get(payload.t);
  const classRecord = payload.cl ? state.data.classById.get(String(payload.cl)) : state.data.roster.classes[0];
  const pupil = classRecord ? getPupil(state.data, classRecord.id, payload.p) : null;
  const canonical = test ? buildCanonicalQuestions(state.data, test, { attemptSeed: payload.m ?? null }) : [];
  const validation = validateSubmissionPayload(payload, externalPupilName, test, classRecord, pupil, canonical);
  if (!test || !classRecord || !pupil) {
    if (!classRecord) validation.warnings.push('The class ID in the payload is not configured on this site.');
    setStatus($('#import-status'), validation.warnings.join(' '), 'error');
    $('#import-panel').hidden = false;
    return;
  }
  const grading = gradeAttempt(canonical, payload.r || [], test.grading);
  const record = {
    token,
    payload,
    importedAt: Date.now(),
    warnings: validation.warnings,
    suspicious: validation.suspicious,
    grading,
    receipt: await receiptFromToken(token)
  };
  setSubmission(test.id, classRecord.id, pupil.id, record);
  // Preserve existing correction only if it still matches the same attempt.
  const existingCorrection = getCorrection(test.id, pupil.id, classRecord.id);
  if (existingCorrection && existingCorrection.attemptId !== payload.a) {
    delete state.teacherData.corrections[test.id][recordKey(classRecord.id, pupil.id)];
  }
  saveTeacherData();
  state.selectedClassId = classRecord.id;
  storage.setTeacherActiveClassId(classRecord.id);
  state.selectedTestId = test.id;
  renderDashboard();
  renderImportPanel(test, classRecord, pupil, record);
}

function renderImportPanel(test, classRecord, pupil, record) {
  const { payload, grading, warnings, suspicious } = record;
  $('#import-panel').hidden = false;
  $('#import-title').textContent = `${classRecord.label} · ${pupil.name} — ${test.label}`;
  $('#import-meta').replaceChildren();
  const values = [
    ['Attempt', payload.l === 1 ? 'Taken later' : payload.rp === 1 ? 'Repeat attempt' : 'Normal'],
    ['Estimated', `${grading.estimatedCorrect} accepted + ${grading.uncertain} uncertain / ${grading.total}`],
    ['Duration', formatDuration((payload.f - payload.s) / 1000)],
    ['Finished', formatDateTime(payload.f)],
    ['Integrity events', String(payload.x || 0)],
    ['Receipt', record.receipt]
  ];
  for (const [label, value] of values) {
    const box = document.createElement('div');
    box.className = 'metric';
    const strong = document.createElement('strong'); strong.textContent = value;
    const span = document.createElement('span'); span.textContent = label;
    box.append(strong, span);
    $('#import-meta').appendChild(box);
  }
  if (warnings.length) {
    setStatus($('#import-status'), `${suspicious ? 'Possible cheating/tampering warning: ' : 'Validation warning: '}${warnings.join(' ')}`, suspicious ? 'error' : 'warning');
  } else {
    setStatus($('#import-status'), 'Submission link checked and imported.', 'success');
  }
  $('#import-correct').onclick = () => openCorrection(test.id, pupil.id, false, classRecord.id);
}

async function importFromHashIfPresent() {
  const rawHash = location.hash.replace(/^#/, '');
  const params = parseHashParams();
  const token = params.get('s') || (rawHash && !rawHash.includes('=') ? decodeURIComponent(rawHash) : '');
  if (!token) return;
  const currentUrl = new URL(location.href);
  const visibleName = (currentUrl.searchParams.get('p') || currentUrl.searchParams.get('pupil') || currentUrl.search.slice(1) || '').split('&')[0];
  await importSubmissionToken(token, visibleName);
}

function renderClassSelect() {
  const select = $('#class-select');
  select.replaceChildren();
  const classes = getActiveClasses(state.data);
  const activeIds = new Set(classes.map(classRecord => classRecord.id));
  if (!state.selectedClassId || !activeIds.has(state.selectedClassId)) {
    const saved = storage.getTeacherActiveClassId();
    state.selectedClassId = activeIds.has(saved) ? saved : (classes[0]?.id || null);
  }
  for (const classRecord of classes) {
    const option = document.createElement('option');
    option.value = classRecord.id;
    option.textContent = classRecord.label;
    select.appendChild(option);
  }
  select.value = state.selectedClassId || '';
}

function renderTestSelect() {
  const select = $('#test-select');
  select.replaceChildren();
  for (const test of state.data.tests.tests) {
    const option = document.createElement('option');
    option.value = test.id;
    option.textContent = `${test.label} (${classTestCode(test, currentClass())})`;
    select.appendChild(option);
  }
  if (!state.selectedTestId || !state.data.testById.has(state.selectedTestId)) {
    state.selectedTestId = state.data.tests.tests[0]?.id || null;
  }
  select.value = state.selectedTestId || '';
}

function renderDashboard() {
  if (!state.data || !state.teacherData) return;
  hideActivityPanel();
  renderClassSelect();
  renderTestSelect();
  renderTestOverviewCards();
  renderSelectedTest();
  renderPreflight();
}

function renderTestOverviewCards() {
  const wrap = $('#test-overview');
  wrap.replaceChildren();
  const classRecord = currentClass();
  const active = activePupils();
  for (const test of state.data.tests.tests) {
    const subs = active.filter(pupil => getSubmission(test.id, pupil.id, classRecord.id)).length;
    const corrections = active.filter(pupil => getCorrection(test.id, pupil.id, classRecord.id)?.completedAt).length;
    const button = document.createElement('button');
    button.className = `test-card ${test.id === state.selectedTestId ? 'selected' : ''}`;
    button.type = 'button';
    const title = document.createElement('strong'); title.textContent = test.label;
    const small = document.createElement('span'); small.textContent = `${subs}/${active.length} submitted · ${corrections} corrected`;
    const chips = document.createElement('div'); chips.className = 'chip-row';
    const graded = document.createElement('span'); graded.className = `status-chip ${isGradedTest(test) ? 'graded' : 'ungraded'}`; graded.textContent = isGradedTest(test) ? 'Graded' : 'Not graded';
    const timing = resolveClassTiming(test, classRecord.id);
    const now = Date.now();
    const openingMs = timing.openingTime ? new Date(timing.openingTime).getTime() : NaN;
    const closingMs = timing.closingTime ? new Date(timing.closingTime).getTime() : NaN;
    const isBeforeOpen = Number.isFinite(openingMs) && now < openingMs;
    const isPastClose = Number.isFinite(closingMs) && now > closingMs;
    const isOpen = !!test.active && !isBeforeOpen && !isPastClose;
    const open = document.createElement('span'); open.className = `status-chip ${isOpen ? 'open' : 'closed'}`;
    const closeText = timing.closingTime && !isPastClose ? ` until ${new Intl.DateTimeFormat('nb-NO', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }).format(new Date(timing.closingTime))}` : '';
    open.textContent = !test.active || isPastClose ? 'Closed' : isBeforeOpen ? 'Scheduled' : `Open${closeText}`;
    chips.append(graded, open);
    button.append(title, small, chips);
    button.addEventListener('click', () => {
      state.selectedTestId = test.id;
      renderDashboard();
    });
    wrap.appendChild(button);
  }
}

function renderSelectedTest() {
  const test = state.data.testById.get(state.selectedTestId);
  const classRecord = currentClass();
  if (!test || !classRecord) return;
  const active = activePupils();
  const submitted = active.map(pupil => ({ pupil, submission: getSubmission(test.id, pupil.id, classRecord.id), correction: getCorrection(test.id, pupil.id, classRecord.id) }));
  const submittedCount = submitted.filter(row => row.submission).length;
  const correctedCount = submitted.filter(row => row.correction?.completedAt).length;
  const lateCount = submitted.filter(row => row.submission?.payload?.l === 1).length;
  const durations = submitted
    .map(row => row.submission)
    .filter(submission => submission && submission.payload?.l !== 1)
    .map(submission => submission.payload.f - submission.payload.s)
    .filter(ms => Number.isFinite(ms) && ms >= 0)
    .sort((a,b)=>a-b);
  const medianDuration = durations.length ? (durations.length % 2 ? durations[(durations.length-1)/2] : (durations[durations.length/2-1] + durations[durations.length/2]) / 2) : 0;
  const lateThreshold = Math.max(12 * 60 * 1000, medianDuration * 1.75, medianDuration + 5 * 60 * 1000);
  const timing = resolveClassTiming(test, classRecord.id);
  const now = Date.now();
  const openingMs = timing.openingTime ? new Date(timing.openingTime).getTime() : NaN;
  const closingMs = timing.closingTime ? new Date(timing.closingTime).getTime() : NaN;
  const isBeforeOpen = Number.isFinite(openingMs) && now < openingMs;
  const isPastClose = Number.isFinite(closingMs) && now > closingMs;
  const availabilityLabel = !test.active || isPastClose ? 'Closed' : isBeforeOpen ? 'Scheduled' : 'Open';
  const scheduleParts = [];
  if (timing.openingTime) scheduleParts.push(`opens ${formatDateTime(new Date(timing.openingTime).getTime())}`);
  if (timing.countAsRetakeAfter) scheduleParts.push(`retake after ${formatDateTime(new Date(timing.countAsRetakeAfter).getTime())}`);
  if (timing.closingTime) scheduleParts.push(`closes ${formatDateTime(new Date(timing.closingTime).getTime())}`);
  $('#selected-test-title').textContent = `${test.label} · ${classRecord.label}`;
  $('#selected-test-meta').textContent = `${isGradedTest(test) ? 'Graded' : 'Not graded'} · ${availabilityLabel} · code ${classTestCode(test, classRecord)}${scheduleParts.length ? ` · ${scheduleParts.join(' · ')}` : ''}`;
  $('#results-selected-test').textContent = `Selected: ${classRecord.label} · ${test.label} · ${isGradedTest(test) ? 'Graded' : 'Not graded'}`;
  $('#stat-submitted').textContent = `${submittedCount}/${active.length}`;
  $('#stat-missing').textContent = String(active.length - submittedCount);
  $('#stat-late').textContent = String(lateCount);
  $('#stat-corrected').textContent = `${correctedCount}/${submittedCount}`;
  renderAccessCodePanel();

  const tbody = $('#pupil-table-body');
  tbody.replaceChildren();
  for (const { pupil, submission, correction } of submitted) {
    const tr = document.createElement('tr');
    const durationMs = submission ? submission.payload.f - submission.payload.s : 0;
    const lockoutEvents = submission ? (submission.payload.e || []).filter(ev => Array.isArray(ev) && ev[2] === 1).length : 0;
    const takenLater = submission?.payload?.l === 1;
    const suspiciousNow = !!submission && (!!submission.suspicious || lockoutEvents > 0 || (!takenLater && medianDuration > 0 && durationMs > lateThreshold));
    const status = !submission ? 'Missing' : takenLater ? 'Taken later' : submission.payload?.rp === 1 ? 'Repeat attempt' : 'Submitted';
    const cells = [
      pupil.name,
      status,
      submission ? `${submission.grading.estimatedCorrect}+${submission.grading.uncertain}? / ${submission.grading.total}` : '-',
      correction?.completedAt ? `${correction.finalScore}/${submission?.grading?.total ?? correction.finalBits.length}` : submission ? 'Needs correction' : '-'
    ];
    cells.forEach(text => {
      const td = document.createElement('td'); td.textContent = text; tr.appendChild(td);
    });
    const check = document.createElement('td');
    if (submission) {
      const checkButton = document.createElement('button'); checkButton.type = 'button';
      checkButton.className = `btn btn-small suspicion-button ${suspiciousNow ? 'suspicious' : ''}`;
      checkButton.textContent = suspiciousNow ? 'Check activity' : takenLater ? 'Taken later' : 'Activity';
      checkButton.addEventListener('click', () => showActivityDetails(test, classRecord, pupil, submission, medianDuration, lateThreshold));
      check.appendChild(checkButton);
    }
    tr.appendChild(check);
    const action = document.createElement('td');
    if (submission) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'btn btn-small';
      if (submission.rawPurged) {
        button.textContent = 'Details purged';
        button.disabled = true;
      } else {
        button.textContent = correction?.completedAt ? 'Review' : 'Correct';
        button.addEventListener('click', () => openCorrection(test.id, pupil.id, !!correction?.completedAt, classRecord.id));
      }
      action.appendChild(button);
    }
    tr.appendChild(action);
    tbody.appendChild(tr);
  }
}

function buildCorrectionState(testId, pupilId, reviewAll = false, classId = state.selectedClassId) {
  const test = state.data.testById.get(testId);
  const submission = getSubmission(testId, pupilId, classId);
  const canonical = buildCanonicalQuestions(state.data, test, { attemptSeed: submission?.payload?.m ?? null });
  const existing = getCorrection(testId, pupilId, classId);
  const decisions = existing?.attemptId === submission.payload.a
    ? [...existing.decisions]
    : submission.grading.details.map((detail, index) => {
        if (detail.band === 'correct') return true;
        const source = canonical[index];
        if (!source?.sourceTestId) return null;
        const sourceCorrection = getCorrection(source.sourceTestId, pupilId, classId);
        const sourceSubmission = getSubmission(source.sourceTestId, pupilId, classId);
        const sourceTest = state.data.testById.get(source.sourceTestId);
        if (!sourceCorrection || !sourceTest) return null;
        if (sourceSubmission && sourceCorrection.attemptId && sourceCorrection.attemptId !== sourceSubmission.payload?.a) return null;
        let sourceDecisionIndex = source.sourceIndex;
        if (sourceSubmission) {
          const sourceCanonical = buildCanonicalQuestions(state.data, sourceTest, { attemptSeed: sourceSubmission.payload?.m ?? null });
          sourceDecisionIndex = sourceCanonical.findIndex(candidate => candidate.wordId === source.wordId && candidate.direction === source.direction);
          if (sourceDecisionIndex < 0) return null;
        }
        const sourceDecision = sourceCorrection.decisions?.[sourceDecisionIndex];
        if (sourceDecision === true || sourceDecision === false) return sourceDecision;
        return sourceCorrection.finalBits?.[sourceDecisionIndex] === true ? true : sourceCorrection.finalBits?.[sourceDecisionIndex] === false ? false : null;
      });
  const queue = canonical.map((_, index) => index).filter(index => reviewAll || submission.grading.details[index].band !== 'correct');
  return { test, classId, pupilId, submission, canonical, decisions, queue, queuePosition: 0, reviewAll };
}

function openCorrection(testId, pupilId, reviewAll = false, classId = state.selectedClassId) {
  state.correction = buildCorrectionState(testId, pupilId, reviewAll, classId);
  $('#correction-panel').hidden = false;
  $('#dashboard-panel').hidden = true;
  renderCorrectionItem();
}

function remainingClassCorrections(testId, classId = state.selectedClassId) {
  let count = 0;
  for (const pupil of activePupils(classId)) {
    const record = getSubmission(testId, pupil.id, classId);
    if (!record || record.rawPurged) continue;
    const correction = getCorrection(testId, pupil.id, classId);
    record.grading.details.forEach((detail, idx) => {
      if (detail.band !== 'correct' && !(correction?.decisions?.[idx] === true || correction?.decisions?.[idx] === false)) count += 1;
    });
  }
  return count;
}

function renderCorrectionItem() {
  const c = state.correction;
  const pupil = getPupil(state.data, c.classId, c.pupilId);
  const classRecord = getClass(state.data, c.classId);
  const unresolved = c.queue.filter(idx => c.decisions[idx] !== true && c.decisions[idx] !== false);
  if (!unresolved.length && !c.reviewAll) {
    finishCorrection();
    return;
  }
  let index;
  if (c.reviewAll) {
    c.queuePosition = Math.max(0, Math.min(c.queuePosition, c.queue.length - 1));
    index = c.queue[c.queuePosition];
  } else {
    const nextPos = c.queue.findIndex((idx, pos) => pos >= c.queuePosition && c.decisions[idx] !== true && c.decisions[idx] !== false);
    if (nextPos === -1) {
      const anyPos = c.queue.findIndex(idx => c.decisions[idx] !== true && c.decisions[idx] !== false);
      if (anyPos === -1) { finishCorrection(); return; }
      c.queuePosition = anyPos;
    } else c.queuePosition = nextPos;
    index = c.queue[c.queuePosition];
  }
  c.currentIndex = index;
  const q = c.canonical[index];
  const detail = c.submission.grading.details[index];
  const raw = c.submission.payload.r[index] || '';
  $('#correction-title').textContent = `${classRecord.label} · ${pupil.name} — ${c.test.label}`;
  $('#correction-progress').textContent = `Item ${c.queuePosition + 1}/${c.queue.length} · ${unresolved.length} unresolved for this pupil · ${remainingClassCorrections(c.test.id, c.classId)} class items remaining`;
  $('#correction-direction').textContent = getDirectionLabel(q);
  $('#correction-prompt').textContent = getPrompt(q);
  $('#correction-answer').textContent = raw || '(blank)';
  $('#correction-accepted').textContent = acceptedAnswers(q).join(' / ');
  $('#correction-band').textContent = `${detail.band} · similarity ${Math.round((detail.similarity || 0) * 100)}%`;
  const edits = c.submission.payload.z?.[index] || 0;
  $('#correction-edits').textContent = edits ? `Pupil changed this answer ${edits} time${edits === 1 ? '' : 's'} after first advancing from it.` : 'No back-navigation answer change recorded.';
  $('#correction-panel').classList.toggle('correction-uncertain', detail.band === 'uncertain');
  $('#correction-panel').classList.toggle('correction-wrong', detail.band === 'wrong' || detail.band === 'blank');
  $('#correction-decision').textContent = c.decisions[index] === true ? 'Marked right' : c.decisions[index] === false ? 'Marked wrong' : 'Not decided';
  $('#correction-prev').disabled = c.queuePosition <= 0;
  $('#correction-next').disabled = c.queuePosition >= c.queue.length - 1;
}

function persistCorrectionProgress(completedAt = null) {
  const c = state.correction;
  const finalBits = c.decisions.map((decision, idx) => {
    if (decision === true || decision === false) return decision;
    return c.submission.grading.details[idx].band === 'correct';
  });
  const finalScore = finalBits.filter(Boolean).length;
  setCorrection(c.test.id, c.classId, c.pupilId, {
    attemptId: c.submission.payload.a,
    decisions: c.decisions,
    finalBits,
    finalScore,
    completedAt: completedAt || getCorrection(c.test.id, c.pupilId, c.classId)?.completedAt || null,
    updatedAt: Date.now()
  });
  saveTeacherData();
}

function applyDecision(isCorrect) {
  const c = state.correction;
  if (!c) return;
  const idx = c.currentIndex;
  c.decisions[idx] = isCorrect;
  if ($('#bulk-identical').checked) {
    applyDecisionToIdenticalAnswers(c.test.id, idx, c.submission.payload.r[idx] || '', isCorrect, c.pupilId, c.classId, c.canonical[idx]);
  }
  persistCorrectionProgress();
  if (c.reviewAll) c.queuePosition = Math.min(c.queuePosition + 1, c.queue.length - 1);
  renderCorrectionItem();
}

function sameQuestion(a, b) {
  return !!a && !!b && a.wordId === b.wordId && a.direction === b.direction && (a.sourceTestId || '') === (b.sourceTestId || '');
}

function applyDecisionToIdenticalAnswers(testId, sourceIndex, rawAnswer, isCorrect, sourcePupilId, classId, sourceQuestion) {
  const normalized = normalizeAnswer(rawAnswer);
  if (!normalized) return;
  const test = state.data.testById.get(testId);
  for (const pupil of activePupils(classId)) {
    if (String(pupil.id) === String(sourcePupilId)) continue;
    const submission = getSubmission(testId, pupil.id, classId);
    if (!submission || submission.rawPurged || !Array.isArray(submission.payload.r)) continue;
    const canonical = buildCanonicalQuestions(state.data, test, { attemptSeed: submission.payload.m ?? null });
    const matchingIndex = canonical.findIndex(question => sameQuestion(question, sourceQuestion));
    if (matchingIndex < 0 || normalizeAnswer(submission.payload.r[matchingIndex] || '') !== normalized) continue;
    let correction = getCorrection(testId, pupil.id, classId);
    if (!correction || correction.attemptId !== submission.payload.a) {
      correction = {
        attemptId: submission.payload.a,
        decisions: submission.grading.details.map(d => d.band === 'correct' ? true : null),
        finalBits: [], finalScore: 0, completedAt: null, updatedAt: Date.now()
      };
    }
    correction.decisions[matchingIndex] = isCorrect;
    correction.updatedAt = Date.now();
    setCorrection(testId, classId, pupil.id, correction);
  }
  saveTeacherData();
}

function finishCorrection() {
  const c = state.correction;
  // Any remaining non-high-confidence item must have a decision to count as completed.
  const unresolved = c.submission.grading.details.map((d, i) => ({ d, i }))
    .filter(({ d, i }) => d.band !== 'correct' && c.decisions[i] !== true && c.decisions[i] !== false);
  if (unresolved.length) {
    setStatus($('#correction-status'), `${unresolved.length} non-high-confidence answer(s) still need a Right/Wrong decision.`, 'warning');
    c.queue = unresolved.map(x => x.i);
    c.queuePosition = 0;
    c.reviewAll = false;
    renderCorrectionItem();
    return;
  }
  persistCorrectionProgress(Date.now());
  const correction = getCorrection(c.test.id, c.pupilId, c.classId);
  setStatus($('#correction-status'), `Correction complete: ${correction.finalScore}/${correction.finalBits.length}.`, 'success');
  $('#correction-panel').hidden = true;
  $('#dashboard-panel').hidden = false;
  state.correction = null;
  renderDashboard();
  if (state.correctAllMode) openNextClassCorrection(c.test.id, c.classId);
}

function renderPreflight() {
  const warnings = [];
  const active = getActiveClasses(state.data).flatMap(classRecord => getActivePupils(state.data, classRecord.id));
  const ids = new Set();
  const synonymOwners = new Map();
  for (const item of state.data.vocabulary.items) {
    if (ids.has(item.id)) warnings.push(`Duplicate vocabulary ID ${item.id}.`);
    ids.add(item.id);
    if (!item.en || !item.no) warnings.push(`Vocabulary ${item.id} has a missing translation.`);
    if (normalizeAnswer(item.en) === normalizeAnswer(item.no)) warnings.push(`Vocabulary ${item.id} has identical English/Norwegian text.`);
    if (!item.definition) warnings.push(`Vocabulary ${item.id} has no definition.`);
    for (const synonym of [...(item.synonymsEn || []), ...(item.synonymsNo || [])]) {
      const normalizedSynonym = normalizeAnswer(synonym);
      if (!normalizedSynonym) continue;
      const owners = synonymOwners.get(normalizedSynonym) || [];
      owners.push(item.id);
      synonymOwners.set(normalizedSynonym, owners);
    }
    const def = normalizeAnswer(item.definition);
    const forbidden = [item.en, item.no, ...(item.synonymsEn || []), ...(item.synonymsNo || [])]
      .map(normalizeAnswer).filter(Boolean);
    for (const answer of forbidden) {
      if (answer.length >= 4 && def.includes(answer)) {
        warnings.push(`Definition for vocabulary ${item.id} may reveal “${answer}”.`);
        break;
      }
    }
  }
  for (const [synonym, owners] of synonymOwners.entries()) {
    const uniqueOwners = [...new Set(owners)];
    if (uniqueOwners.length > 1) warnings.push(`Synonym “${synonym}” is accepted for multiple vocabulary items: ${uniqueOwners.join(', ')}.`);
  }
  const classCodeOwners = new Map();
  for (const classRecord of getActiveClasses(state.data)) {
    for (const test of state.data.tests.tests.filter(candidate => candidate.active !== false)) {
      const code = classTestCode(test, classRecord);
      const ownerKey = `${classRecord.id}|${code}`;
      const previous = classCodeOwners.get(ownerKey);
      if (previous) warnings.push(`${classRecord.label}: generated five-letter code ${code} is shared by “${previous}” and “${test.label}”. Change one test's base code or a class identifier.`);
      else classCodeOwners.set(ownerKey, test.label);
    }
  }
  for (const test of state.data.tests.tests) {
    const canonical = buildCanonicalQuestions(state.data, test);
    const wanted = Number(test.merge_amount ?? test.mergeAmount ?? test.questionCount ?? 0);
    if (canonical.length < wanted) warnings.push(`${test.label}: only ${canonical.length} valid questions for ${wanted} requested.`);
    for (const classRecord of getActiveClasses(state.data)) {
      const timing = resolveClassTiming(test, classRecord.id);
      for (const [field, value] of Object.entries(timing)) {
        if (value && Number.isNaN(new Date(value).getTime())) warnings.push(`${test.label} / ${classRecord.label}: invalid ${field}.`);
      }
      if (timing.openingTime && timing.countAsRetakeAfter && new Date(timing.countAsRetakeAfter) < new Date(timing.openingTime)) {
        warnings.push(`${test.label} / ${classRecord.label}: retake cutoff is before opening time.`);
      }
      if (timing.countAsRetakeAfter && timing.closingTime && new Date(timing.closingTime) < new Date(timing.countAsRetakeAfter)) {
        warnings.push(`${test.label} / ${classRecord.label}: closing time is before the retake cutoff.`);
      }
    }
  }
  $('#preflight-summary').textContent = `${getActiveClasses(state.data).length} active class(es) · ${active.length} active pupils · ${state.data.vocabulary.items.length} vocabulary entries · ${state.data.tests.tests.length} tests · ${warnings.length} warning(s)`;
  const ul = $('#preflight-list');
  ul.replaceChildren();
  if (!warnings.length) {
    const li = document.createElement('li'); li.textContent = 'No configuration warnings found.'; ul.appendChild(li);
  } else {
    warnings.slice(0, 30).forEach(text => { const li = document.createElement('li'); li.textContent = text; ul.appendChild(li); });
  }
}


function showActivityDetails(test, classRecord, pupil, submission, medianDuration, lateThreshold) {
  const durationMs = submission.payload.f - submission.payload.s;
  const lockouts = (submission.payload.e || []).filter(ev => Array.isArray(ev) && ev[2] === 1).length || Number(submission.payload.x || 0);
  const takenLater = submission.payload.l === 1;
  const unusuallyLong = !takenLater && medianDuration > 0 && durationMs > lateThreshold;
  const identityWarning = (submission.warnings || []).find(w => w.includes('identity substitution')) || '';
  const suspicious = !!identityWarning || lockouts > 0 || unusuallyLong || !!submission.suspicious;
  $('#activity-title').textContent = `${classRecord.label} · ${pupil.name} - ${test.label}`;
  let message;
  if (suspicious) {
    message = `Possible cheating/activity concern.${identityWarning ? ` ${identityWarning}` : ''}${unusuallyLong ? ' The test took significantly longer than the normal-session class median.' : ''}`;
  } else if (takenLater) {
    message = 'Taken later. Its duration is intentionally not compared with the normal-session median.';
  } else {
    message = 'No automatic warning was triggered for this submission.';
  }
  setStatus($('#activity-warning'), message, suspicious ? 'error' : takenLater ? 'warning' : 'success');
  const metrics = $('#activity-metrics'); metrics.replaceChildren();
  const values = [
    ['Attempt', takenLater ? 'Taken later' : submission.payload.rp === 1 ? 'Repeat attempt' : 'Normal'],
    ['Lockout events', String(lockouts)],
    ['Time spent', formatDuration(durationMs / 1000)],
    ['Clicked submit', formatDateTime(submission.payload.f)],
    ['Normal-session median', takenLater ? 'Not compared' : (medianDuration ? formatDuration(medianDuration / 1000) : '-')]
  ];
  values.forEach(([label,value]) => { const box=document.createElement('div'); box.className='metric'; const strong=document.createElement('strong'); strong.textContent=value; const span=document.createElement('span'); span.textContent=label; box.append(strong,span); metrics.appendChild(box); });
  $('#activity-panel').hidden = false;
  $('#activity-panel').scrollIntoView({ behavior:'smooth', block:'start' });
}

function openNextClassCorrection(testId, classId = state.selectedClassId) {
  for (const pupil of activePupils(classId)) {
    const submission = getSubmission(testId, pupil.id, classId);
    const correction = getCorrection(testId, pupil.id, classId);
    if (!submission || submission.rawPurged || correction?.completedAt) continue;
    openCorrection(testId, pupil.id, false, classId);
    return;
  }
  state.correctAllMode = false;
  renderDashboard();
  setStatus($('#backup-status'), '', '');
  alert('All submitted work for this class and test has been corrected.');
}

function startCorrectAll() {
  const testId = state.selectedTestId;
  state.correctAllMode = true;
  openNextClassCorrection(testId, state.selectedClassId);
}

function pdfEscape(text) {
  return String(text).replace(/\\/g,'\\\\').replace(/\(/g,'\\(').replace(/\)/g,'\\)').replace(/[–—]/g,'-');
}
function latin1Bytes(text) {
  const map = { '€':128, '’':146, '“':147, '”':148, '•':149 };
  const out = new Uint8Array(text.length);
  for (let i=0;i<text.length;i++) { const c=text[i]; const code=map[c] ?? c.charCodeAt(0); out[i] = code <= 255 ? code : 63; }
  return out;
}
function downloadSimplePdf(filename, title, lines) {
  const pages=[]; for(let i=0;i<lines.length;i+=42) pages.push(lines.slice(i,i+42)); if(!pages.length) pages.push([]);
  const objs=[]; const pageIds=[]; const contentIds=[]; const fontId=3;
  let nextId=4;
  pages.forEach(()=>{pageIds.push(nextId++); contentIds.push(nextId++);});
  objs[1]='<< /Type /Catalog /Pages 2 0 R >>';
  objs[2]=`<< /Type /Pages /Kids [${pageIds.map(id=>`${id} 0 R`).join(' ')}] /Count ${pages.length} >>`;
  objs[fontId]='<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>';
  pages.forEach((page,pi)=>{
    const commands=['BT','/F1 16 Tf','50 790 Td',`(${pdfEscape(title)}) Tj`,'/F1 10 Tf','0 -24 Td'];
    page.forEach((line,idx)=>{ if(idx) commands.push('0 -16 Td'); commands.push(`(${pdfEscape(line)}) Tj`); }); commands.push('ET');
    const stream=commands.join('\n');
    objs[pageIds[pi]]=`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 ${fontId} 0 R >> >> /Contents ${contentIds[pi]} 0 R >>`;
    objs[contentIds[pi]]=`<< /Length ${latin1Bytes(stream).length} >>\nstream\n${stream}\nendstream`;
  });
  let pdf='%PDF-1.4\n'; const offsets=[0];
  for(let i=1;i<objs.length;i++){ if(!objs[i]) continue; offsets[i]=latin1Bytes(pdf).length; pdf+=`${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref=latin1Bytes(pdf).length; pdf+=`xref\n0 ${objs.length}\n0000000000 65535 f \n`;
  for(let i=1;i<objs.length;i++) pdf+=`${String(offsets[i]||0).padStart(10,'0')} 00000 n \n`;
  pdf+=`trailer\n<< /Size ${objs.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  const blob=new Blob([latin1Bytes(pdf)],{type:'application/pdf'}); const url=URL.createObjectURL(blob); const a=document.createElement('a'); a.href=url; a.download=filename; a.click(); setTimeout(()=>URL.revokeObjectURL(url),1000);
}
function downloadFinalResultsPdf() {
  const test = state.data.testById.get(state.selectedTestId);
  const classRecord = currentClass();
  if (!test || !classRecord) return;
  const timing = resolveClassTiming(test, classRecord.id);
  const lines = [
    `Class: ${classRecord.label}`,
    `Test: ${test.label}`,
    `Type: ${isGradedTest(test)?'Graded':'Not graded'}`,
    `Normal code: ${classTestCode(test, classRecord)}`,
    `Retake after: ${timing.countAsRetakeAfter ? formatDateTime(new Date(timing.countAsRetakeAfter).getTime()) : 'Not set'}`,
    ''
  ];
  for (const pupil of activePupils()) {
    const sub = getSubmission(test.id, pupil.id, classRecord.id);
    const corr = getCorrection(test.id, pupil.id, classRecord.id);
    const result = !sub ? '' : corr?.completedAt ? `${corr.finalScore}/${corr.finalBits.length}${sub.payload.l === 1 ? ' (taken later)' : ''}` : 'Not corrected';
    lines.push(`${pupil.name}: ${result}`);
  }
  downloadSimplePdf(`final-results-${classRecord.id}-${test.id}.pdf`, 'VG1 Vocabulary - Final results', lines);
}

async function generateResultsLink() {
  const test = state.data.testById.get(state.selectedTestId);
  const classRecord = currentClass();
  const entries = [];
  for (const pupil of activePupils()) {
    const submission = getSubmission(test.id, pupil.id, classRecord.id);
    const correction = getCorrection(test.id, pupil.id, classRecord.id);
    if (!submission || !correction?.completedAt) continue;
    const record = {
      v: APP_CONFIG.resultFormatVersion,
      t: test.id,
      cl: classRecord.id,
      p: pupil.id,
      b: packBits(correction.finalBits.map(Boolean)),
      s: correction.finalScore,
      n: correction.finalBits.length,
      at: correction.completedAt
    };
    if (submission.payload.m != null) record.m = submission.payload.m;
    const encrypted = await encryptForPin(record, String(submission.payload.c), `${test.id}|${classRecord.id}|${pupil.id}`);
    entries.push({ p: pupil.id, e: encrypted });
  }
  if (!entries.length) {
    setStatus($('#results-link-status'), 'No corrected pupil results are available for this class and test yet.', 'warning');
    return;
  }
  const bundle = { v: 2, t: test.id, cl: classRecord.id, cv: test.configVersion, createdAt: Date.now(), entries };
  const token = await encodeCheckedPayload(bundle);
  state.pendingResultsBundle = { testId: test.id, classId: classRecord.id, token, entryCount: entries.length };
  $('#result-bundle-token').value = token;
  $('#result-bundle-signature').value = '';
  $('#results-link').value = '';

  const privateKey = storage.getTeacherPrivateKey();
  if (!privateKey || !(await privateKeyMatchesPublic(privateKey))) {
    setStatus($('#results-link-status'), `Package generated with ${entries.length} encrypted pupil record(s), but this browser has no matching teacher signing key. Re-open the one-click teacher setup link on this browser.`, 'warning');
    return;
  }

  const bundleHash = await sha256Hex(token);
  const signatureToken = await signTeacherToken(privateKey, {
    v: 1,
    kind: APP_CONFIG.teacherTokenKinds.resultBundle,
    issuedAt: Date.now(),
    bundleHash
  });
  $('#result-bundle-signature').value = signatureToken;
  await finalizeResultsLink();
}

async function finalizeResultsLink() {
  const pending = state.pendingResultsBundle;
  const bundleToken = $('#result-bundle-token').value.trim();
  const signatureToken = $('#result-bundle-signature').value.trim();
  if (!bundleToken || !signatureToken) {
    setStatus($('#results-link-status'), 'Create the class results link first.', 'warning');
    return;
  }
  try {
    const bundleHash = await sha256Hex(bundleToken);
    const verified = await verifySignedToken(signatureToken, APP_CONFIG.teacherTokenKinds.resultBundle, { bundleHash });
    if (!verified.ok) throw new Error(verified.reason);
    const bundle = await decodeCheckedPayload(bundleToken);
    if (pending && (pending.testId !== bundle.t || pending.classId !== (bundle.cl || state.data.roster.classes[0]?.id))) throw new Error('The package no longer matches the selected class/test.');
    const url = new URL('../results/', location.href);
    url.hash = `${bundleToken}~${signatureToken}`;
    $('#results-link').value = url.href;
    setStatus($('#results-link-status'), `Class results link is ready for ${bundle.entries.length} pupil result(s). Pupils use their four-digit result code to open their own result.`, 'success');
  } catch (error) {
    setStatus($('#results-link-status'), `Could not finalize result link: ${error.message}`, 'error');
  }
}

function exportBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    schema: 2,
    teacherData: state.teacherData
  };
  downloadText(`vocabulary-teacher-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
}

function exportResultsOnly() {
  const classes = [];
  for (const classRecord of getActiveClasses(state.data)) {
    const tests = [];
    for (const test of state.data.tests.tests) {
      const rows = [];
      for (const pupil of getActivePupils(state.data, classRecord.id)) {
        const submission = getSubmission(test.id, pupil.id, classRecord.id);
        const correction = getCorrection(test.id, pupil.id, classRecord.id);
        rows.push({
          pupilId: pupil.id,
          pupilName: pupil.name,
          submitted: !!submission,
          takenLater: submission?.payload?.l === 1,
          repeatAttempt: submission?.payload?.rp === 1,
          submittedAt: submission?.payload?.f || null,
          durationSeconds: submission ? Math.round((submission.payload.f - submission.payload.s) / 1000) : null,
          integrityEvents: submission?.payload?.x || 0,
          suspicious: !!submission?.suspicious,
          corrected: !!correction?.completedAt,
          score: correction?.completedAt ? correction.finalScore : null,
          total: correction?.completedAt ? correction.finalBits.length : null
        });
      }
      tests.push({ testId: test.id, label: test.label, graded: isGradedTest(test), active: !!test.active, timing: resolveClassTiming(test, classRecord.id), rows });
    }
    classes.push({ classId: classRecord.id, classLabel: classRecord.label, tests });
  }
  downloadText(`vocabulary-results-only-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ schema: 3, exportedAt: new Date().toISOString(), classes }, null, 2));
}

function purgeSelectedTestDetails() {
  const testId = state.selectedTestId;
  const test = state.data.testById.get(testId);
  const classRecord = currentClass();
  if (!test || !classRecord) return;
  if (!confirm(`Permanently purge raw answers and detailed integrity events for corrected pupils in “${classRecord.label} · ${test.label}” on this browser? Export a full backup first if you may need them later.`)) return;
  let purged = 0;
  for (const pupil of activePupils()) {
    const submission = getSubmission(testId, pupil.id, classRecord.id);
    const correction = getCorrection(testId, pupil.id, classRecord.id);
    if (!submission || !correction?.completedAt || submission.rawPurged) continue;
    submission.token = null;
    submission.payload.r = null;
    submission.payload.e = [];
    submission.payload.z = [];
    submission.grading = {
      estimatedCorrect: submission.grading.estimatedCorrect,
      uncertain: submission.grading.uncertain,
      wrong: submission.grading.wrong,
      total: submission.grading.total,
      details: []
    };
    submission.rawPurged = true;
    purged += 1;
  }
  saveTeacherData();
  setStatus($('#backup-status'), `Purged detailed raw data for ${purged} corrected submission(s) in the selected class. Scores, PINs, timestamps, violation counts, and final correctness remain so result links can still be generated.`, 'success');
  renderDashboard();
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed.teacherData || ![1, 2].includes(parsed.schema)) throw new Error('Not a recognized teacher backup file.');
    state.teacherData = parsed.teacherData;
    state.teacherData.submissions ||= {};
    state.teacherData.corrections ||= {};
    saveTeacherData();
    setStatus($('#backup-status'), 'Backup imported successfully.', 'success');
    renderDashboard();
  } catch (error) {
    setStatus($('#backup-status'), `Could not import backup: ${error.message}`, 'error');
  }
}

function renderAccessCodePanel() {
  const test = state.data.testById.get(state.selectedTestId);
  const classRecord = currentClass();
  if (!test || !classRecord) return;
  const timing = resolveClassTiming(test, classRecord.id);
  $('#normal-test-code').textContent = classTestCode(test, classRecord);
  $('#retake-cutoff-display').textContent = timing.countAsRetakeAfter ? formatDateTime(new Date(timing.countAsRetakeAfter).getTime()) : 'Not set';
  if (!$('#late-code-hour').value) $('#late-code-hour').value = localHourInputValue();
  $('#late-code-output').value = '';
  setStatus($('#late-code-status'), '', '');
}

function generateLateTestCode() {
  const test = state.data.testById.get(state.selectedTestId);
  const classRecord = currentClass();
  if (!test || !classRecord) return;
  const value = $('#late-code-hour').value;
  const when = value ? new Date(value) : new Date();
  if (Number.isNaN(when.getTime())) {
    setStatus($('#late-code-status'), 'Choose a valid year, month, date, and hour.', 'warning');
    return;
  }
  const code = lateTestCode(test, classRecord, when);
  $('#late-code-output').value = code;
  const timing = resolveClassTiming(test, classRecord.id);
  if (!timing.countAsRetakeAfter) {
    setStatus($('#late-code-status'), `Generated ${code}, but this class/test has no “Count as retake after” time configured, so pupils will continue using the normal code.`, 'warning');
    return;
  }
  const cutoff = new Date(timing.countAsRetakeAfter).getTime();
  const hourStart = new Date(when);
  hourStart.setMinutes(0, 0, 0);
  const hourEnd = hourStart.getTime() + 60 * 60 * 1000;
  const closing = timing.closingTime ? new Date(timing.closingTime).getTime() : NaN;
  let kind = 'success';
  let note = '';
  if (hourEnd <= cutoff) {
    kind = 'warning';
    note = ' This entire hour is before the configured retake cutoff, so pupils will still need the normal class code.';
  } else if (hourStart.getTime() < cutoff) {
    note = ` This is the cutoff hour; the late code starts working at ${formatDateTime(cutoff)}.`;
  }
  if (Number.isFinite(closing) && hourStart.getTime() > closing) {
    kind = 'warning';
    note = ' The test is already closed during this hour, so the code will not be accepted.';
  } else if (Number.isFinite(closing) && closing < hourEnd) {
    note += ` The test closes at ${formatDateTime(closing)}, so the code stops working then.`;
  }
  setStatus($('#late-code-status'), `Give ${code} only during the selected hour. It is derived from the class’s normal five-letter code plus year-month-date-hour.${note}`, kind);
}

function generateFiveLetterTeacherResponse(requestId, outputId, statusId, purpose, makeResponse = makeUnlockCode) {
  const requestInput = document.getElementById(requestId);
  const output = document.getElementById(outputId);
  const status = document.getElementById(statusId);
  const request = normalizeFiveLetters(requestInput?.value || '');
  if (request.length !== 5) {
    setStatus(status, 'Enter the five-letter request shown on the matching pupil screen.', 'warning');
    if (output) output.value = '';
    return;
  }
  const response = makeResponse(request);
  if (output) output.value = response;
  setStatus(status, `Give ${response} to the pupil. This ${purpose} code only applies to request ${request}.`, 'success');
}

function activateDashboardView(viewName) {
  document.querySelectorAll('[data-dashboard-view]').forEach(section => {
    section.hidden = section.dataset.dashboardView !== viewName;
  });
  document.querySelectorAll('[data-dashboard-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.dashboardTab === viewName);
    button.setAttribute('aria-pressed', button.dataset.dashboardTab === viewName ? 'true' : 'false');
  });
  if (viewName !== 'overview') hideActivityPanel();
  setSettingsMenuOpen(false);
}

function bindEvents() {
  document.querySelectorAll('[data-dashboard-tab]').forEach(button => button.addEventListener('click', () => activateDashboardView(button.dataset.dashboardTab)));
  $('#open-settings')?.addEventListener('click', event => {
    event.stopPropagation();
    setSettingsMenuOpen($('#settings-menu')?.hidden !== false);
  });
  $('#settings-menu')?.addEventListener('click', event => event.stopPropagation());
  document.querySelectorAll('[data-settings-target]').forEach(button => button.addEventListener('click', () => openSettingsSection(button.dataset.settingsTarget)));
  document.addEventListener('click', event => {
    if (!event.target.closest?.('#settings-menu-wrap')) setSettingsMenuOpen(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && $('#settings-menu')?.hidden === false) {
      setSettingsMenuOpen(false);
      $('#open-settings')?.focus();
    }
  });
  $('#late-code-generate')?.addEventListener('click', generateLateTestCode);
  $('#unlock-generate')?.addEventListener('click', () => generateFiveLetterTeacherResponse('unlock-request-input', 'unlock-response-output', 'unlock-generator-status', 'unlock'));
  $('#leave-generate')?.addEventListener('click', () => generateFiveLetterTeacherResponse('leave-request-input', 'leave-response-output', 'leave-generator-status', 'leave', makeLeaveCode));
  $('#retake-generate')?.addEventListener('click', () => generateFiveLetterTeacherResponse('retake-request-input', 'retake-response-output', 'retake-generator-status', 'repeat-attempt'));
  $('#unlock-request-input')?.addEventListener('input', event => { event.target.value = normalizeFiveLetters(event.target.value); });
  $('#leave-request-input')?.addEventListener('input', event => { event.target.value = normalizeFiveLetters(event.target.value); });
  $('#retake-request-input')?.addEventListener('input', event => { event.target.value = normalizeFiveLetters(event.target.value); });
  $('#teacher-auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    await enterTeacherMode($('#teacher-token').value.trim());
  });
  $('#clear-teacher-access').addEventListener('click', () => {
    storage.clearTeacherAccessToken();
    storage.clearTeacherPrivateKey();
    location.reload();
  });
  $('#class-select').addEventListener('change', event => {
    state.selectedClassId = event.target.value;
    storage.setTeacherActiveClassId(state.selectedClassId);
    state.pendingResultsBundle = null;
    renderDashboard();
  });
  $('#test-select').addEventListener('change', event => {
    state.selectedTestId = event.target.value;
    renderDashboard();
  });
  $('#correction-right').addEventListener('click', () => applyDecision(true));
  $('#correction-wrong').addEventListener('click', () => applyDecision(false));
  $('#correction-skip').addEventListener('click', () => {
    const c = state.correction;
    if (!c) return;
    c.queuePosition = (c.queuePosition + 1) % c.queue.length;
    renderCorrectionItem();
  });
  $('#correction-prev').addEventListener('click', () => { if (state.correction) { state.correction.queuePosition -= 1; renderCorrectionItem(); } });
  $('#correction-next').addEventListener('click', () => { if (state.correction) { state.correction.queuePosition += 1; renderCorrectionItem(); } });
  $('#correction-close').addEventListener('click', () => {
    if (state.correction) persistCorrectionProgress();
    state.correction = null;
    state.correctAllMode = false;
    $('#correction-panel').hidden = true;
    $('#dashboard-panel').hidden = false;
    renderDashboard();
  });
  document.addEventListener('keydown', event => {
    if (!state.correction || ['INPUT', 'TEXTAREA', 'SELECT'].includes(document.activeElement?.tagName)) return;
    const key = event.key.toLowerCase();
    if (key === 'r' || event.key === 'ArrowRight') { event.preventDefault(); applyDecision(true); }
    if (key === 'w' || event.key === 'ArrowLeft') { event.preventDefault(); applyDecision(false); }
    if (key === 'y') { event.preventDefault(); $('#correction-skip').click(); }
  });
  $('#correct-all')?.addEventListener('click', startCorrectAll);
  $('#activity-close')?.addEventListener('click', () => { $('#activity-panel').hidden = true; });
  $('#download-results-pdf')?.addEventListener('click', downloadFinalResultsPdf);
  $('#generate-results').addEventListener('click', generateResultsLink);
  $('#finalize-results-link').addEventListener('click', finalizeResultsLink);
  $('#copy-results-link').addEventListener('click', async () => {
    if (!$('#results-link').value) return;
    await navigator.clipboard.writeText($('#results-link').value);
    setStatus($('#results-link-status'), 'Result link copied.', 'success');
  });
  $('#export-backup').addEventListener('click', exportBackup);
  $('#export-results-only').addEventListener('click', exportResultsOnly);
  $('#purge-details').addEventListener('click', purgeSelectedTestDetails);
  $('#import-backup-file').addEventListener('change', event => {
    const file = event.target.files?.[0];
    if (file) importBackup(file);
    event.target.value = '';
  });
}

async function init() {
  try {
    state.data = await loadAppData();
    state.teacherData = storage.getTeacherData();
    state.teacherData.version = Math.max(2, Number(state.teacherData.version) || 1);
    state.teacherData.submissions ||= {};
    state.teacherData.corrections ||= {};
    const classes = getActiveClasses(state.data);
    const activeIds = new Set(classes.map(classRecord => classRecord.id));
    const savedClassId = storage.getTeacherActiveClassId();
    state.selectedClassId = activeIds.has(savedClassId) ? savedClassId : (classes[0]?.id || null);
    bindEvents();
    activateDashboardView('overview');
    const rawHash = location.hash.replace(/^#/, '');
    const params = parseHashParams();
    state.pendingSubmissionToken = params.get('s') || (rawHash && !rawHash.includes('=') ? decodeURIComponent(rawHash) : null);
    const saved = storage.getTeacherAccessToken();
    if (saved) {
      const ok = await enterTeacherMode(saved);
      if (ok) return;
    }
    showAuth(state.pendingSubmissionToken ? 'A pupil submission is waiting. Add a valid teacher-access token to open it.' : 'Add a signed teacher-access token to use the dashboard on this browser.');
  } catch (error) {
    document.body.innerHTML = `<main class="fatal"><h1>Teacher dashboard could not start</h1><p>${error.message}</p></main>`;
  }
}

init();
