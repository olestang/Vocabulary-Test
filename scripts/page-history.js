import { loadAppData, buildCanonicalQuestions, getPrompt, isGradedTest } from './data.js';
import { acceptedAnswers } from './grading.js';
import { storage } from './storage.js';
import { $, formatDateTime, downloadText, setStatus } from './utilities.js';

const state = { data: null, pupil: null, history: [], filter: 'graded' };

function renderDetails(record) {
  const test = state.data.testById.get(record.testId);
  if (!test) return;
  const canonical = buildCanonicalQuestions(state.data, test);
  $('#history-detail-title').textContent = `${test.label} — ${record.score}/${record.total}`;
  const list = $('#history-detail-list');
  list.replaceChildren();
  record.bits.forEach((correct, index) => {
    const q = canonical[index];
    const row = document.createElement('div');
    row.className = `final-result-row ${correct ? 'final-correct' : 'final-wrong'}`;
    const left = document.createElement('div');
    const strong = document.createElement('strong'); strong.textContent = getPrompt(q);
    const small = document.createElement('small'); small.textContent = acceptedAnswers(q)[0];
    left.append(strong, small);
    const mark = document.createElement('span'); mark.textContent = correct ? 'Correct' : 'Wrong';
    row.append(left, mark);
    list.appendChild(row);
  });
  $('#history-detail').hidden = false;
  $('#history-detail').scrollIntoView({ behavior: 'smooth', block: 'start' });
}

function renderHistory() {
  const wrap = $('#history-list');
  wrap.replaceChildren();
  if (!state.history.length) {
    const p = document.createElement('p'); p.textContent = 'No verified results are saved on this browser yet.'; wrap.appendChild(p); return;
  }
  const visible = state.filter === 'all' ? state.history : state.history.filter(record => isGradedTest(state.data.testById.get(record.testId)));
  if (!visible.length) { const p = document.createElement('p'); p.textContent = state.filter === 'graded' ? 'No graded final results are saved on this browser yet.' : 'No final results are saved on this browser yet.'; wrap.appendChild(p); return; }
  for (const record of visible) {
    const test = state.data.testById.get(record.testId);
    if (!test) continue;
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'history-card';
    const title = document.createElement('strong'); title.textContent = `${test.label} · ${isGradedTest(test) ? 'Graded' : 'Not graded'}`;
    const score = document.createElement('span'); score.textContent = `${record.score}/${record.total}`;
    const date = document.createElement('small'); date.textContent = `Saved ${formatDateTime(record.verifiedAt)}`;
    button.append(title, score, date);
    button.addEventListener('click', () => renderDetails(record));
    wrap.appendChild(button);
  }
}


function exportHistory() {
  const payload = { v: 1, pupilId: state.pupil.id, exportedAt: Date.now(), history: state.history };
  downloadText(`vocabulary-history-pupil-${state.pupil.id}.json`, JSON.stringify(payload, null, 2));
}

async function importHistory(file) {
  try {
    const parsed = JSON.parse(await file.text());
    if (parsed.v !== 1 || parsed.pupilId !== state.pupil.id || !Array.isArray(parsed.history)) {
      throw new Error('This history file does not match the pupil registered on this browser.');
    }
    let imported = 0;
    for (const record of parsed.history) {
      if (record.pupilId !== state.pupil.id || !state.data.testById.has(record.testId) || !Array.isArray(record.bits)) continue;
      const test = state.data.testById.get(record.testId);
      if (record.bits.length !== buildCanonicalQuestions(state.data, test).length) continue;
      storage.savePupilHistoryRecord(record);
      imported += 1;
    }
    state.history = storage.getPupilHistory().filter(r => r.pupilId === state.pupil.id);
    renderHistory();
    setStatus($('#history-status'), `Imported ${imported} valid history record(s).`, 'success');
  } catch (error) {
    setStatus($('#history-status'), error.message, 'error');
  }
}

async function init() {
  state.data = await loadAppData();
  const saved = storage.getPupilIdentity();
  state.pupil = saved ? state.data.pupilById.get(saved.id) : null;
  if (!state.pupil?.active) {
    $('#pupil-dashboard-main').hidden = true;
    $('#pupil-dashboard-warning').hidden = false;
    return;
  }
  $('#pupil-dashboard-name').textContent = state.pupil.name;
  state.history = storage.getPupilHistory().filter(r => r.pupilId === state.pupil.id);
  renderHistory();
  $('#filter-graded')?.addEventListener('click', () => { state.filter = 'graded'; $('#filter-graded').classList.remove('btn-secondary'); $('#filter-all').classList.add('btn-secondary'); renderHistory(); });
  $('#filter-all')?.addEventListener('click', () => { state.filter = 'all'; $('#filter-all').classList.remove('btn-secondary'); $('#filter-graded').classList.add('btn-secondary'); renderHistory(); });
  $('#export-history').addEventListener('click', exportHistory);
  $('#import-history-file').addEventListener('change', event => { const file = event.target.files?.[0]; if (file) importHistory(file); event.target.value = ''; });
}

init().catch(error => {
  document.body.innerHTML = `<main class="fatal"><h1>Could not open pupil dashboard</h1><p>${error.message}</p></main>`;
});
