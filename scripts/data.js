import { loadJson, seededShuffle, hash32 } from './utilities.js';
import { classTestCode, lateTestCode, normalizeTestCode, hourKey } from './access-codes.js';

let cache = null;

function fallbackClassId(label = 'Class') {
  const slug = String(label).normalize('NFKD').replace(/[^\w\s-]/g, '').trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
  return slug || 'class-1';
}

function normalizeRoster(raw) {
  const sourceClasses = Array.isArray(raw?.classes) && raw.classes.length
    ? raw.classes
    : [{ id: fallbackClassId(raw?.classLabel), label: raw?.classLabel || 'Class 1', active: true, pupils: raw?.pupils || [] }];
  const usedIds = new Set();
  const classes = sourceClasses.map((source, index) => {
    let id = String(source.id || fallbackClassId(source.label || `Class ${index + 1}`));
    if (usedIds.has(id)) id = `${id}-${index + 1}`;
    usedIds.add(id);
    const pupils = (source.pupils || []).map(pupil => ({ ...pupil, classId: id }));
    return {
      ...source,
      id,
      label: source.label || `Class ${index + 1}`,
      active: source.active !== false,
      pupils
    };
  });
  return {
    ...raw,
    version: Math.max(2, Number(raw?.version) || 1),
    classes,
    // These compatibility fields keep older ancillary code/config tooling useful.
    classLabel: classes[0]?.label || '',
    pupils: classes.flatMap(classRecord => classRecord.pupils)
  };
}

export function pupilKey(classId, pupilId) {
  return `${String(classId)}|${String(pupilId)}`;
}

export async function loadAppData() {
  if (cache) return cache;
  const [rawRoster, vocabulary, tests] = await Promise.all([
    loadJson(new URL('../config/class-roster.json', import.meta.url)),
    loadJson(new URL('../config/vocabulary.json', import.meta.url)),
    loadJson(new URL('../config/tests.json', import.meta.url))
  ]);
  const roster = normalizeRoster(rawRoster);
  const vocabById = new Map(vocabulary.items.map(item => [item.id, item]));
  const classById = new Map(roster.classes.map(classRecord => [classRecord.id, classRecord]));
  const pupilByKey = new Map();
  const pupilById = new Map();
  for (const classRecord of roster.classes) {
    for (const pupil of classRecord.pupils) {
      pupilByKey.set(pupilKey(classRecord.id, pupil.id), pupil);
      if (!pupilById.has(pupil.id)) pupilById.set(pupil.id, pupil);
    }
  }
  const testById = new Map(tests.tests.map(test => [test.id, test]));
  cache = { roster, vocabulary, tests, vocabById, classById, pupilByKey, pupilById, testById };
  return cache;
}

export function getActiveClasses(data) {
  return data.roster.classes.filter(classRecord => classRecord.active !== false);
}

export function getClass(data, classId) {
  if (classId && data.classById.has(String(classId))) return data.classById.get(String(classId));
  return getActiveClasses(data)[0] || data.roster.classes[0] || null;
}

export function getActivePupils(data, classId) {
  const classRecord = getClass(data, classId);
  return classRecord ? classRecord.pupils.filter(pupil => pupil.active !== false) : [];
}

export function getPupil(data, classId, pupilId) {
  const classRecord = getClass(data, classId);
  if (!classRecord) return null;
  return data.pupilByKey.get(pupilKey(classRecord.id, pupilId)) || null;
}

export function resolveClassTiming(test, classId) {
  const classTimes = test?.classTimes || test?.classTiming || {};
  const override = (classId && classTimes && typeof classTimes === 'object') ? (classTimes[classId] || {}) : {};
  return {
    openingTime: override.openingTime ?? test?.openingTime ?? null,
    countAsRetakeAfter: override.countAsRetakeAfter ?? override.retakeAfter ?? test?.countAsRetakeAfter ?? test?.retakeAfter ?? null,
    closingTime: override.closingTime ?? test?.closingTime ?? null
  };
}

export function isAfterRetakeCutoff(test, classId, now = Date.now()) {
  const value = resolveClassTiming(test, classId).countAsRetakeAfter;
  if (!value) return false;
  const cutoff = new Date(value).getTime();
  return Number.isFinite(cutoff) && now >= cutoff;
}

export function findTestByCode(data, code, classId, now = Date.now()) {
  const normalized = normalizeTestCode(code);
  const classRecord = getClass(data, classId);
  if (!normalized || !classRecord) return null;
  for (const test of data.tests.tests) {
    if (!test.active) continue;
    const timing = resolveClassTiming(test, classRecord.id);
    const closing = timing.closingTime ? new Date(timing.closingTime).getTime() : null;
    if (Number.isFinite(closing) && now > closing) continue;
    const late = isAfterRetakeCutoff(test, classRecord.id, now);
    const expected = late ? lateTestCode(test, classRecord, now) : classTestCode(test, classRecord);
    if (normalized === expected) {
      return { test, mode: late ? 'late' : 'normal', code: expected, accessHour: late ? hourKey(now) : null };
    }
  }
  return null;
}

function questionSeed(test, attemptSeed = null) {
  return attemptSeed == null ? String(test.seed) : `${test.seed}|late|${attemptSeed}`;
}

export function buildCanonicalQuestions(data, test, options = {}) {
  const attemptSeed = options?.attemptSeed ?? null;
  const seed = questionSeed(test, attemptSeed);
  // Merge tests reuse source questions/directions; selection from that source pool
  // changes for late attempts while ordinary test-day attempts stay deterministic.
  const mergeSources = Array.isArray(test.merge_test) ? test.merge_test : (Array.isArray(test.mergeTests) ? test.mergeTests : []);
  if (mergeSources.length) {
    const sourceQuestions = [];
    for (const sourceId of mergeSources) {
      const source = data.testById.get(sourceId);
      if (!source || source.id === test.id) continue;
      buildCanonicalQuestions(data, source).forEach((question, sourceIndex) => {
        sourceQuestions.push({ ...question, sourceTestId: source.id, sourceIndex });
      });
    }
    const amount = Math.max(0, Number(test.merge_amount ?? test.mergeAmount ?? test.questionCount ?? sourceQuestions.length));
    return seededShuffle(sourceQuestions, `${seed}|merge-select`).slice(0, amount);
  }

  const pool = (test.vocabularyIds || []).filter(id => data.vocabById.has(id));
  const selectedIds = seededShuffle(pool, `${seed}|select`).slice(0, test.questionCount);
  return selectedIds.map(id => {
    const item = data.vocabById.get(id);
    const direction = item.showOnlyEnglish ? 'en-no' : ((hash32(`${seed}|direction|${id}`) & 1) === 0 ? 'en-no' : 'no-en');
    return { wordId: id, direction, item };
  });
}

export function isGradedTest(test) {
  return test?.graded !== false;
}

export function buildPupilOrder(canonicalQuestions, test, pupilId, options = {}) {
  const attemptSeed = options?.attemptSeed ?? null;
  const seed = questionSeed(test, attemptSeed);
  return seededShuffle(canonicalQuestions.map((_, index) => index), `${seed}|order|${pupilId}`);
}

export function getPrompt(question) {
  return question.direction === 'en-no' ? question.item.en : question.item.no;
}

export function getDirectionLabel(question) {
  return question.direction === 'en-no' ? 'English → Norwegian' : 'Norwegian → English';
}
