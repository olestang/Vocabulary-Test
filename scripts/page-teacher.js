import { APP_CONFIG } from './config.js';
import { loadAppData, buildCanonicalQuestions, getPrompt, getDirectionLabel } from './data.js';
import { gradeAttempt, acceptedAnswers } from './grading.js';
import { storage } from './storage.js';
import { decodeCheckedPayload, encodeCheckedPayload, encryptForPin, receiptFromToken, verifySignedToken, signSignedToken, privateKeyMatchesPublic } from './cryptography.js';
import { makeUnlockCode, normalizeFiveLetters } from './unlock-codes.js';
import {
  $, normalizeAnswer, parseHashParams, formatDuration, formatDateTime, setStatus, downloadText, sha256Hex, packBits
} from './utilities.js';

const state = {
  data: null,
  teacherData: null,
  selectedTestId: null,
  correction: null,
  pendingSubmissionToken: null
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
  if (externalPupilName && pupil && externalPupilName.trim() !== visibleNameToken(pupil.name)) {
    warnings.push(`Possible identity substitution: the visible URL name “${externalPupilName}” does not match the submission identity “${pupil.name}”.`);
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
    setStatus($('#import-status'), 'Submission imported and checksum verified.', 'success');
  }
  $('#import-correct').onclick = () => openCorrection(test.id, pupil.id);
}

async function importFromHashIfPresent() {
  const params = parseHashParams();
  const token = params.get('s');
  if (!token) return;
  const visibleName = new URL(location.href).searchParams.get('pupil') || '';
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
    button.append(title, small);
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
  $('#selected-test-title').textContent = test.label;
  $('#stat-submitted').textContent = `${submittedCount}/${active.length}`;
  $('#stat-missing').textContent = String(active.length - submittedCount);
  $('#stat-corrected').textContent = `${correctedCount}/${submittedCount}`;

  const tbody = $('#pupil-table-body');
  tbody.replaceChildren();
  for (const pupil of active) {
    const submission = submissions[pupil.id];
    const correction = corrections[pupil.id];
    const tr = document.createElement('tr');
    const cells = [
      pupil.name,
      submission ? 'Submitted' : 'Missing',
      submission ? `${submission.grading.estimatedCorrect}+${submission.grading.uncertain}? / ${submission.grading.total}` : '-',
      correction?.completedAt ? `${correction.finalScore}/${test.questionCount}` : submission ? 'Needs correction' : '-',
      submission ? formatDuration((submission.payload.f - submission.payload.s) / 1000) : '-',
      submission ? String(submission.payload.x || 0) : '-'
    ];
    cells.forEach((text, idx) => {
      const td = document.createElement('td');
      td.textContent = text;
      if (idx === 1 && submission?.suspicious) td.className = 'danger-text';
      tr.appendChild(td);
    });
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
    : submission.grading.details.map(detail => detail.band === 'correct' ? true : null);
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
  setStatus($('#correction-status'), `Correction complete: ${correction.finalScore}/${c.test.questionCount}.`, 'success');
  $('#correction-panel').hidden = true;
  $('#dashboard-panel').hidden = false;
  state.correction = null;
  renderDashboard();
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
    const available = test.vocabularyIds.filter(id => state.data.vocabById.has(id)).length;
    if (available < test.questionCount) warnings.push(`${test.label}: only ${available} valid words for ${test.questionCount} questions.`);
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
      total: test.questionCount,
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
  if (!privateKey) {
    setStatus($('#results-link-status'), 'This browser has teacher access, but result signing has not been set up. Open the one-click teacher setup link again.', 'warning');
    return;
  }
  if (!(await privateKeyMatchesPublic(privateKey))) {
    setStatus($('#results-link-status'), 'The saved teacher signing key does not match this site. Open the current one-click teacher setup link again.', 'error');
    return;
  }

  const bundleHash = await sha256Hex(token);
  const signatureToken = await signSignedToken({
    v: 1,
    kind: APP_CONFIG.teacherTokenKinds.resultBundle,
    bundleHash,
    issuedAt: Date.now()
  }, privateKey);
  $('#result-bundle-signature').value = signatureToken;
  await finalizeResultsLink();
}

async function finalizeResultsLink() {
  const pending = state.pendingResultsBundle;
  const bundleToken = $('#result-bundle-token').value.trim();
  const signatureToken = $('#result-bundle-signature').value.trim();
  if (!bundleToken || !signatureToken) {
    setStatus($('#results-link-status'), 'Generate a package and paste its signed result-bundle token first.', 'warning');
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
    setStatus($('#results-link-status'), `Class result link is ready for ${bundle.entries.length} pupil record(s).`, 'success');
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
      if (!submission) continue;
      rows.push({
        pupilId: pupil.id,
        pupilName: pupil.name,
        submittedAt: submission.payload.f,
        durationSeconds: Math.round((submission.payload.f - submission.payload.s) / 1000),
        integrityEvents: submission.payload.x || 0,
        suspicious: !!submission.suspicious,
        corrected: !!correction?.completedAt,
        score: correction?.completedAt ? correction.finalScore : null,
        total: correction?.completedAt ? test.questionCount : null
      });
    }
    if (rows.length) tests.push({ testId: test.id, label: test.label, rows });
  }
  downloadText(`vocabulary-results-only-${new Date().toISOString().slice(0, 10)}.json`, JSON.stringify({ schema: 1, exportedAt: new Date().toISOString(), tests }, null, 2));
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
