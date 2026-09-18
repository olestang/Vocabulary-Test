import { APP_CONFIG } from './config.js';
import { loadAppData, buildCanonicalQuestions, getPrompt, getDirectionLabel, isGradedTest } from './data.js';
import { gradeAttempt, acceptedAnswers } from './grading.js';
import { storage } from './storage.js';
import { decodeCheckedPayload, encodeCheckedPayload, encryptForPin, receiptFromToken, verifySignedToken, signTeacherToken, privateKeyMatchesPublic } from './cryptography.js';
import { makeUnlockCode, normalizeFiveLetters } from './unlock-codes.js';
import {
  $, normalizeAnswer, parseHashParams, formatDuration, formatDateTime, setStatus, downloadText, sha256Hex, packBits
} from './utilities.js';

const state = {
  data: null,
  teacherData: null,
  selectedTestId: null,
  correction: null,
  pendingSubmissionToken: null,
  correctAllMode: false
};

function showAuth(message = '') {
  $('#teacher-auth').hidden = false;
  const authLink = $('#teacher-auth-link');
  if (authLink) authLink.href = `../become-teacher/?return=${encodeURIComponent(location.href)}`;
  $('#teacher-main').hidden = true;
  setStatus($('#teacher-auth-status'), message, message ? 'error' : '');
}

function showMain() {
  $('#teacher-auth').hidden = true;
  $('#teacher-main').hidden = false;
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

function getSubmission(testId, pupilId) {
  return state.teacherData.submissions?.[testId]?.[pupilId] || null;
}

function getCorrection(testId, pupilId) {
  return state.teacherData.corrections?.[testId]?.[pupilId] || null;
}

function saveTeacherData() {
  storage.saveTeacherData(state.teacherData);
}

function ensureBuckets(testId) {
  state.teacherData.submissions[testId] ||= {};
  state.teacherData.corrections[testId] ||= {};
}

function visibleNameToken(name) { return String(name || '').trim().replace(/\s+/g, '-'); }

function validateSubmissionPayload(payload, externalPupilName, test, pupil, canonical) {
  const warnings = [];
  let suspicious = false;
  if (payload.v !== APP_CONFIG.submissionFormatVersion) warnings.push(`Unknown submission format v${payload.v}.`);
  if (!test) warnings.push('The test ID in the payload is not configured on this site.');
  if (!pupil) warnings.push('The pupil ID in the payload is not in the roster.');
  const cleanExternalName = decodeURIComponent(String(externalPupilName || '').split('&')[0]).trim();
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
  const pupil = state.data.pupilById.get(payload.p);
  const canonical = test ? buildCanonicalQuestions(state.data, test) : [];
  const validation = validateSubmissionPayload(payload, externalPupilName, test, pupil, canonical);
  if (!test || !pupil) {
    setStatus($('#import-status'), validation.warnings.join(' '), 'error');
    $('#import-panel').hidden = false;
    return;
  }
  const grading = gradeAttempt(canonical, payload.r || [], test.grading);
  ensureBuckets(test.id);
  state.teacherData.submissions[test.id][pupil.id] = {
    token,
    payload,
    importedAt: Date.now(),
    warnings: validation.warnings,
    suspicious: validation.suspicious,
    grading,
    receipt: await receiptFromToken(token)
  };
  // Preserve existing correction only if it still matches the same attempt.
  const existingCorrection = getCorrection(test.id, pupil.id);
  if (existingCorrection && existingCorrection.attemptId !== payload.a) {
    delete state.teacherData.corrections[test.id][pupil.id];
  }
  saveTeacherData();
  state.selectedTestId = test.id;
  $('#test-select').value = test.id;
  renderImportPanel(test, pupil, state.teacherData.submissions[test.id][pupil.id]);
  renderDashboard();
}

function renderImportPanel(test, pupil, record) {
  const { payload, grading, warnings, suspicious } = record;
  $('#import-panel').hidden = false;
  $('#import-title').textContent = `${pupil.name} — ${test.label}`;
  $('#import-meta').replaceChildren();
  const values = [
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
  $('#import-correct').onclick = () => openCorrection(test.id, pupil.id);
}

async function importFromHashIfPresent() {
  const params = parseHashParams();
  const token = params.get('s');
  if (!token) return;
  const currentUrl = new URL(location.href);
  const visibleName = (currentUrl.searchParams.get('pupil') || currentUrl.search.slice(1) || '').split('&')[0];
  await importSubmissionToken(token, visibleName);
}

function renderTestSelect() {
  const select = $('#test-select');
  select.replaceChildren();
  for (const test of state.data.tests.tests) {
    const option = document.createElement('option');
    option.value = test.id;
    option.textContent = `${test.label} (${test.code})`;
    select.appendChild(option);
  }
  if (!state.selectedTestId || !state.data.testById.has(state.selectedTestId)) {
    state.selectedTestId = state.data.tests.tests[0]?.id || null;
  }
  select.value = state.selectedTestId || '';
}

function renderDashboard() {
  if (!state.data || !state.teacherData) return;
  renderTestSelect();
  renderTestOverviewCards();
  renderSelectedTest();
  renderPreflight();
}

function renderTestOverviewCards() {
  const wrap = $('#test-overview');
  wrap.replaceChildren();
  const activeCount = state.data.roster.pupils.filter(p => p.active).length;
  for (const test of state.data.tests.tests) {
    const subs = Object.keys(state.teacherData.submissions?.[test.id] || {}).length;
    const corrections = Object.values(state.teacherData.corrections?.[test.id] || {}).filter(c => c.completedAt).length;
    const button = document.createElement('button');
    button.className = `test-card ${test.id === state.selectedTestId ? 'selected' : ''}`;
    button.type = 'button';
    const title = document.createElement('strong'); title.textContent = test.label;
    const small = document.createElement('span'); small.textContent = `${subs}/${activeCount} submitted · ${corrections} corrected`;
    const chips = document.createElement('div'); chips.className = 'chip-row';
    const graded = document.createElement('span'); graded.className = `status-chip ${isGradedTest(test) ? 'graded' : 'ungraded'}`; graded.textContent = isGradedTest(test) ? 'Graded' : 'Not graded';
    const isPastClose = test.closingTime && Date.now() > new Date(test.closingTime).getTime();
    const isOpen = !!test.active && !isPastClose;
    const open = document.createElement('span'); open.className = `status-chip ${isOpen ? 'open' : 'closed'}`;
    const closeText = test.closingTime && !isPastClose ? ` until ${new Intl.DateTimeFormat('nb-NO', { day:'2-digit', month:'2-digit', hour:'2-digit', minute:'2-digit' }).format(new Date(test.closingTime))}` : '';
    open.textContent = isOpen ? `Open${closeText}` : 'Closed';
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
  if (!test) return;
  const active = state.data.roster.pupils.filter(p => p.active);
  const submissions = state.teacherData.submissions?.[test.id] || {};
  const corrections = state.teacherData.corrections?.[test.id] || {};
  const submittedCount = active.filter(p => submissions[p.id]).length;
  const correctedCount = active.filter(p => corrections[p.id]?.completedAt).length;
  const durations = active.map(p => submissions[p.id]).filter(Boolean).map(sub => sub.payload.f - sub.payload.s).filter(ms => Number.isFinite(ms) && ms >= 0).sort((a,b)=>a-b);
  const medianDuration = durations.length ? (durations.length % 2 ? durations[(durations.length-1)/2] : (durations[durations.length/2-1] + durations[durations.length/2]) / 2) : 0;
  const lateThreshold = Math.max(12 * 60 * 1000, medianDuration * 1.75, medianDuration + 5 * 60 * 1000);
  $('#selected-test-title').textContent = test.label;
  $('#selected-test-meta').textContent = `${isGradedTest(test) ? 'Graded' : 'Not graded'} · ${(test.active && !(test.closingTime && Date.now() > new Date(test.closingTime).getTime())) ? 'Open' : 'Closed'}${test.closingTime ? ` until ${formatDateTime(new Date(test.closingTime).getTime())}` : ''}`;
  $('#results-selected-test').textContent = `Selected test: ${test.label} · ${isGradedTest(test) ? 'Graded' : 'Not graded'}`;
  $('#stat-submitted').textContent = `${submittedCount}/${active.length}`;
  $('#stat-missing').textContent = String(active.length - submittedCount);
  $('#stat-corrected').textContent = `${correctedCount}/${submittedCount}`;

  const tbody = $('#pupil-table-body');
  tbody.replaceChildren();
  for (const pupil of active) {
    const submission = submissions[pupil.id];
    const correction = corrections[pupil.id];
    const tr = document.createElement('tr');
    const durationMs = submission ? submission.payload.f - submission.payload.s : 0;
    const lockoutEvents = submission ? (submission.payload.e || []).filter(ev => Array.isArray(ev) && ev[2] === 1).length : 0;
    const suspiciousNow = !!submission && (!!submission.suspicious || lockoutEvents > 0 || (medianDuration > 0 && durationMs > lateThreshold));
    const cells = [
      pupil.name,
      submission ? 'Submitted' : 'Missing',
      submission ? `${submission.grading.estimatedCorrect}+${submission.grading.uncertain}? / ${submission.grading.total}` : '-',
      correction?.completedAt ? `${correction.finalScore}/${test.questionCount ?? submission?.grading?.total ?? 0}` : submission ? 'Needs correction' : '-'
    ];
    cells.forEach((text, idx) => {
      const td = document.createElement('td'); td.textContent = text; tr.appendChild(td);
    });
    const check = document.createElement('td');
    if (submission) {
      const checkButton = document.createElement('button'); checkButton.type = 'button';
      checkButton.className = `btn btn-small suspicion-button ${suspiciousNow ? 'suspicious' : ''}`;
      checkButton.textContent = suspiciousNow ? 'Check activity' : 'Activity';
      checkButton.addEventListener('click', () => showActivityDetails(test, pupil, submission, medianDuration, lateThreshold));
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
        button.addEventListener('click', () => openCorrection(test.id, pupil.id, !!correction?.completedAt));
      }
      action.appendChild(button);
    }
    tr.appendChild(action);
    tbody.appendChild(tr);
  }
}

function buildCorrectionState(testId, pupilId, reviewAll = false) {
  const test = state.data.testById.get(testId);
  const submission = getSubmission(testId, pupilId);
  const canonical = buildCanonicalQuestions(state.data, test);
  const existing = getCorrection(testId, pupilId);
  const decisions = existing?.attemptId === submission.payload.a
    ? [...existing.decisions]
    : submission.grading.details.map((detail, index) => {
        if (detail.band === 'correct') return true;
        const source = canonical[index];
        if (!source?.sourceTestId) return null;
        const sourceCorrection = getCorrection(source.sourceTestId, pupilId);
        if (!sourceCorrection) return null;
        const sourceDecision = sourceCorrection.decisions?.[source.sourceIndex];
        if (sourceDecision === true || sourceDecision === false) return sourceDecision;
        return sourceCorrection.finalBits?.[source.sourceIndex] === true ? true : sourceCorrection.finalBits?.[source.sourceIndex] === false ? false : null;
      });
  const queue = canonical.map((_, index) => index).filter(index => reviewAll || submission.grading.details[index].band !== 'correct');
  return { test, pupilId, submission, canonical, decisions, queue, queuePosition: 0, reviewAll };
}

function openCorrection(testId, pupilId, reviewAll = false) {
  state.correction = buildCorrectionState(testId, pupilId, reviewAll);
  $('#correction-panel').hidden = false;
  $('#dashboard-panel').hidden = true;
  renderCorrectionItem();
}

function remainingClassCorrections(testId) {
  const submissions = state.teacherData.submissions?.[testId] || {};
  const corrections = state.teacherData.corrections?.[testId] || {};
  let count = 0;
  for (const [pupilId, record] of Object.entries(submissions)) {
    const correction = corrections[pupilId];
    record.grading.details.forEach((detail, idx) => {
      if (detail.band !== 'correct' && !(correction?.decisions?.[idx] === true || correction?.decisions?.[idx] === false)) count += 1;
    });
  }
  return count;
}

function renderCorrectionItem() {
  const c = state.correction;
  const pupil = state.data.pupilById.get(c.pupilId);
  const unresolved = c.queue.filter(idx => c.decisions[idx] !== true && c.decisions[idx] !== false);
  if (!unresolved.length && !c.reviewAll) {
    finishCorrection();
    return;
  }
  // Find next unresolved at or after current queue position; in review-all mode allow revisiting.
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
  $('#correction-title').textContent = `${pupil.name} — ${c.test.label}`;
  $('#correction-progress').textContent = `Item ${c.queuePosition + 1}/${c.queue.length} · ${unresolved.length} unresolved for this pupil · ${remainingClassCorrections(c.test.id)} class items remaining`;
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
  ensureBuckets(c.test.id);
  const finalBits = c.decisions.map((decision, idx) => {
    if (decision === true || decision === false) return decision;
    return c.submission.grading.details[idx].band === 'correct';
  });
  const finalScore = finalBits.filter(Boolean).length;
  state.teacherData.corrections[c.test.id][c.pupilId] = {
    attemptId: c.submission.payload.a,
    decisions: c.decisions,
    finalBits,
    finalScore,
    completedAt: completedAt || getCorrection(c.test.id, c.pupilId)?.completedAt || null,
    updatedAt: Date.now()
  };
  saveTeacherData();
}

function applyDecision(isCorrect) {
  const c = state.correction;
  if (!c) return;
  const idx = c.currentIndex;
  c.decisions[idx] = isCorrect;
  if ($('#bulk-identical').checked) applyDecisionToIdenticalAnswers(c.test.id, idx, c.submission.payload.r[idx] || '', isCorrect, c.pupilId);
  persistCorrectionProgress();
  if (c.reviewAll) {
    c.queuePosition = Math.min(c.queuePosition + 1, c.queue.length - 1);
    renderCorrectionItem();
  } else {
    renderCorrectionItem();
  }
}

function applyDecisionToIdenticalAnswers(testId, canonicalIndex, rawAnswer, isCorrect, sourcePupilId) {
  const normalized = normalizeAnswer(rawAnswer);
  if (!normalized) return;
  const submissions = state.teacherData.submissions?.[testId] || {};
  for (const [pupilIdText, submission] of Object.entries(submissions)) {
    const pupilId = Number(pupilIdText);
    if (pupilId === sourcePupilId) continue;
    if (normalizeAnswer(submission.payload.r[canonicalIndex] || '') !== normalized) continue;
    ensureBuckets(testId);
    let correction = state.teacherData.corrections[testId][pupilId];
    if (!correction || correction.attemptId !== submission.payload.a) {
      correction = {
        attemptId: submission.payload.a,
        decisions: submission.grading.details.map(d => d.band === 'correct' ? true : null),
        finalBits: [], finalScore: 0, completedAt: null, updatedAt: Date.now()
      };
    }
    correction.decisions[canonicalIndex] = isCorrect;
    correction.updatedAt = Date.now();
    state.teacherData.corrections[testId][pupilId] = correction;
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
  const correction = getCorrection(c.test.id, c.pupilId);
  setStatus($('#correction-status'), `Correction complete: ${correction.finalScore}/${correction.finalBits.length}.`, 'success');
  $('#correction-panel').hidden = true;
  $('#dashboard-panel').hidden = false;
  state.correction = null;
  renderDashboard();
  if (state.correctAllMode) openNextClassCorrection(c.test.id);
}

function renderPreflight() {
  const warnings = [];
  const active = state.data.roster.pupils.filter(p => p.active);
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
  for (const test of state.data.tests.tests) {
    const canonical = buildCanonicalQuestions(state.data, test);
    const wanted = Number(test.merge_amount ?? test.mergeAmount ?? test.questionCount ?? 0);
    if (canonical.length < wanted) warnings.push(`${test.label}: only ${canonical.length} valid questions for ${wanted} requested.`);
    if (test.openingTime && Number.isNaN(new Date(test.openingTime).getTime())) warnings.push(`${test.label}: invalid openingTime.`);
  }
  $('#preflight-summary').textContent = `${active.length} active pupils · ${state.data.vocabulary.items.length} vocabulary entries · ${state.data.tests.tests.length} tests · ${warnings.length} warning(s)`;
  const ul = $('#preflight-list');
  ul.replaceChildren();
  if (!warnings.length) {
    const li = document.createElement('li'); li.textContent = 'No configuration warnings found.'; ul.appendChild(li);
  } else {
    warnings.slice(0, 30).forEach(text => { const li = document.createElement('li'); li.textContent = text; ul.appendChild(li); });
  }
}


function showActivityDetails(test, pupil, submission, medianDuration, lateThreshold) {
  const durationMs = submission.payload.f - submission.payload.s;
  const lockouts = (submission.payload.e || []).filter(ev => Array.isArray(ev) && ev[2] === 1).length || Number(submission.payload.x || 0);
  const late = medianDuration > 0 && durationMs > lateThreshold;
  const identityWarning = (submission.warnings || []).find(w => w.includes('identity substitution')) || '';
  const suspicious = !!identityWarning || lockouts > 0 || late || !!submission.suspicious;
  $('#activity-title').textContent = `${pupil.name} - ${test.label}`;
  setStatus($('#activity-warning'), suspicious ? `Possible cheating/activity concern.${identityWarning ? ` ${identityWarning}` : ''}${late ? ' The test took significantly longer than the class median.' : ''}` : 'No automatic warning was triggered for this submission.', suspicious ? 'error' : 'success');
  const metrics = $('#activity-metrics'); metrics.replaceChildren();
  const values = [
    ['Lockout events', String(lockouts)],
    ['Time spent', formatDuration(durationMs / 1000)],
    ['Clicked submit', formatDateTime(submission.payload.f)],
    ['Class median', medianDuration ? formatDuration(medianDuration / 1000) : '-']
  ];
  values.forEach(([label,value]) => { const box=document.createElement('div'); box.className='metric'; const strong=document.createElement('strong'); strong.textContent=value; const span=document.createElement('span'); span.textContent=label; box.append(strong,span); metrics.appendChild(box); });
  $('#activity-panel').hidden = false;
  $('#activity-panel').scrollIntoView({ behavior:'smooth', block:'start' });
}

function openNextClassCorrection(testId) {
  const submissions = state.teacherData.submissions?.[testId] || {};
  const corrections = state.teacherData.corrections?.[testId] || {};
  for (const pupil of state.data.roster.pupils.filter(p => p.active)) {
    const submission = submissions[pupil.id];
    if (!submission || submission.rawPurged || corrections[pupil.id]?.completedAt) continue;
    openCorrection(testId, pupil.id);
    return;
  }
  state.correctAllMode = false;
  renderDashboard();
  setStatus($('#backup-status'), '', '');
  alert('All submitted work for this test has been corrected.');
}

function startCorrectAll() {
  const testId = state.selectedTestId;
  state.correctAllMode = true;
  openNextClassCorrection(testId);
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
  const test=state.data.testById.get(state.selectedTestId); if(!test) return;
  const submissions=state.teacherData.submissions?.[test.id]||{}; const corrections=state.teacherData.corrections?.[test.id]||{};
  const lines=[`Test: ${test.label}`,`Type: ${isGradedTest(test)?'Graded':'Not graded'}`,`Status: ${test.active?'Open':'Closed'}${test.closingTime ? ` until ${formatDateTime(new Date(test.closingTime).getTime())}` : ''}`,''];
  for(const pupil of state.data.roster.pupils.filter(p=>p.active)) { const sub=submissions[pupil.id]; const corr=corrections[pupil.id]; const result=!sub?'':corr?.completedAt?`${corr.finalScore}/${corr.finalBits.length}`:'Not corrected'; lines.push(`${pupil.name}: ${result}`); }
  downloadSimplePdf(`final-results-${test.id}.pdf`, 'VG1 Vocabulary - Final results', lines);
}

async function generateResultsLink() {
  const test = state.data.testById.get(state.selectedTestId);
  const submissions = state.teacherData.submissions?.[test.id] || {};
  const corrections = state.teacherData.corrections?.[test.id] || {};
  const entries = [];
  for (const pupil of state.data.roster.pupils.filter(p => p.active)) {
    const submission = submissions[pupil.id];
    const correction = corrections[pupil.id];
    if (!submission || !correction?.completedAt) continue;
    const record = {
      v: APP_CONFIG.resultFormatVersion,
      testId: test.id,
      pupilId: pupil.id,
      bits: packBits(correction.finalBits.map(Boolean)),
      score: correction.finalScore,
      total: correction.finalBits.length,
      graded: isGradedTest(test),
      correctedAt: correction.completedAt
    };
    const encrypted = await encryptForPin(record, String(submission.payload.c), `${test.id}|${pupil.id}`);
    entries.push({ p: pupil.id, e: encrypted });
  }
  if (!entries.length) {
    setStatus($('#results-link-status'), 'No corrected pupil results are available for this test yet.', 'warning');
    return;
  }
  const bundle = { v: 1, t: test.id, cv: test.configVersion, createdAt: Date.now(), entries };
  const token = await encodeCheckedPayload(bundle);
  state.pendingResultsBundle = { testId: test.id, token, entryCount: entries.length };
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
    if (pending && pending.testId !== bundle.t) throw new Error('The package no longer matches the selected generated test.');
    const url = new URL('../results/', location.href);
    url.hash = `r=${encodeURIComponent(bundleToken)}&s=${encodeURIComponent(signatureToken)}`;
    $('#results-link').value = url.href;
    setStatus($('#results-link-status'), `Class results link is ready for ${bundle.entries.length} pupil result(s). Pupils use their four-digit result code to open their own result.`, 'success');
  } catch (error) {
    setStatus($('#results-link-status'), `Could not finalize result link: ${error.message}`, 'error');
  }
}

function exportBackup() {
  const payload = {
    exportedAt: new Date().toISOString(),
    schema: 1,
    teacherData: state.teacherData
  };
  downloadText(`vocabulary-teacher-backup-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify(payload, null, 2));
}

function exportResultsOnly() {
  const tests = [];
  for (const test of state.data.tests.tests) {
    const rows = [];
    const submissions = state.teacherData.submissions?.[test.id] || {};
    const corrections = state.teacherData.corrections?.[test.id] || {};
    for (const pupil of state.data.roster.pupils.filter(p => p.active)) {
      const submission = submissions[pupil.id];
      const correction = corrections[pupil.id];
      rows.push({
        pupilId: pupil.id, pupilName: pupil.name, submitted: !!submission,
        submittedAt: submission?.payload?.f || null,
        durationSeconds: submission ? Math.round((submission.payload.f - submission.payload.s) / 1000) : null,
        integrityEvents: submission?.payload?.x || 0,
        suspicious: !!submission?.suspicious,
        corrected: !!correction?.completedAt,
        score: correction?.completedAt ? correction.finalScore : null,
        total: correction?.completedAt ? correction.finalBits.length : null
      });
    }
    tests.push({ testId: test.id, label: test.label, graded: isGradedTest(test), active: !!test.active, closingTime: test.closingTime || null, rows });
  }
  downloadText(`vocabulary-results-only-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ schema: 2, exportedAt: new Date().toISOString(), tests }, null, 2));
}

function purgeSelectedTestDetails() {
  const testId = state.selectedTestId;
  const test = state.data.testById.get(testId);
  if (!test) return;
  if (!confirm(`Permanently purge raw answers and detailed integrity events for corrected pupils in “${test.label}” on this browser? Export a full backup first if you may need them later.`)) return;
  const submissions = state.teacherData.submissions?.[testId] || {};
  const corrections = state.teacherData.corrections?.[testId] || {};
  let purged = 0;
  for (const [pupilId, submission] of Object.entries(submissions)) {
    if (!corrections[pupilId]?.completedAt || submission.rawPurged) continue;
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
  setStatus($('#backup-status'), `Purged detailed raw data for ${purged} corrected submission(s). Scores, PINs, timestamps, violation counts, and final correctness remain so result links can still be generated.`, 'success');
  renderDashboard();
}

async function importBackup(file) {
  try {
    const text = await file.text();
    const parsed = JSON.parse(text);
    if (!parsed.teacherData || parsed.schema !== 1) throw new Error('Not a recognized teacher backup file.');
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

function generateFiveLetterUnlock() {
  const request = normalizeFiveLetters($('#unlock-request-input')?.value || '');
  if (request.length !== 5) {
    setStatus($('#unlock-generator-status'), 'Enter the five-letter request shown on the pupil screen.', 'warning');
    $('#unlock-response-output').value = '';
    return;
  }
  const response = makeUnlockCode(request);
  $('#unlock-response-output').value = response;
  setStatus($('#unlock-generator-status'), `Give ${response} to the pupil. It only applies to the request ${request}.`, 'success');
}

function activateDashboardView(viewName) {
  document.querySelectorAll('[data-dashboard-view]').forEach(section => {
    section.hidden = section.dataset.dashboardView !== viewName;
  });
  document.querySelectorAll('[data-dashboard-tab]').forEach(button => {
    button.classList.toggle('active', button.dataset.dashboardTab === viewName);
    button.setAttribute('aria-pressed', button.dataset.dashboardTab === viewName ? 'true' : 'false');
  });
}

function bindEvents() {
  document.querySelectorAll('[data-dashboard-tab]').forEach(button => button.addEventListener('click', () => activateDashboardView(button.dataset.dashboardTab)));
  $('#unlock-generate')?.addEventListener('click', generateFiveLetterUnlock);
  $('#unlock-request-input')?.addEventListener('input', event => { event.target.value = normalizeFiveLetters(event.target.value); });
  $('#teacher-auth-form').addEventListener('submit', async event => {
    event.preventDefault();
    await enterTeacherMode($('#teacher-token').value.trim());
  });
  $('#clear-teacher-access').addEventListener('click', () => {
    storage.clearTeacherAccessToken();
    storage.clearTeacherPrivateKey();
    location.reload();
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
    state.teacherData.submissions ||= {};
    state.teacherData.corrections ||= {};
    bindEvents();
    activateDashboardView('overview');
    const params = parseHashParams();
    state.pendingSubmissionToken = params.get('s');
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
