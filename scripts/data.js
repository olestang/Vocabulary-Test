import { loadJson, seededShuffle, hash32 } from './utilities.js';

let cache = null;

export async function loadAppData() {
  if (cache) return cache;
  const [roster, vocabulary, tests] = await Promise.all([
    loadJson(new URL('../config/class-roster.json', import.meta.url)),
    loadJson(new URL('../config/vocabulary.json', import.meta.url)),
    loadJson(new URL('../config/tests.json', import.meta.url))
  ]);
  const vocabById = new Map(vocabulary.items.map(item => [item.id, item]));
  const pupilById = new Map(roster.pupils.map(pupil => [pupil.id, pupil]));
  const testById = new Map(tests.tests.map(test => [test.id, test]));
  cache = { roster, vocabulary, tests, vocabById, pupilById, testById };
  return cache;
}

export function findTestByCode(data, code) {
  const normalized = String(code || '').trim().toLocaleUpperCase('en-US');
  return data.tests.tests.find(t => t.active && !(t.closingTime && Date.now() > new Date(t.closingTime).getTime()) && t.code.toLocaleUpperCase('en-US') === normalized) || null;
}

export function buildCanonicalQuestions(data, test) {
  // Merge tests reuse the exact questions (including direction) from earlier tests.
  // This lets teacher corrections from those source tests be reused safely.
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
    return seededShuffle(sourceQuestions, `${test.seed}|merge-select`).slice(0, amount);
  }

  const pool = (test.vocabularyIds || []).filter(id => data.vocabById.has(id));
  const selectedIds = seededShuffle(pool, `${test.seed}|select`).slice(0, test.questionCount);
  return selectedIds.map(id => {
    const item = data.vocabById.get(id);
    // showOnlyEnglish means English is always the prompt, never the expected answer.
    const direction = item.showOnlyEnglish ? 'en-no' : ((hash32(`${test.seed}|direction|${id}`) & 1) === 0 ? 'en-no' : 'no-en');
    return { wordId: id, direction, item };
  });
}

export function isGradedTest(test) {
  return test?.graded !== false;
}

export function buildPupilOrder(canonicalQuestions, test, pupilId) {
  return seededShuffle(canonicalQuestions.map((_, index) => index), `${test.seed}|order|${pupilId}`);
}

export function getPrompt(question) {
  return question.direction === 'en-no' ? question.item.en : question.item.no;
}

export function getDirectionLabel(question) {
  return question.direction === 'en-no' ? 'English → Norwegian' : 'Norwegian → English';
}
