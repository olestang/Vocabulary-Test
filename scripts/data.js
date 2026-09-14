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
  return data.tests.tests.find(t => t.active && t.code.toLocaleUpperCase('en-US') === normalized) || null;
}

export function buildCanonicalQuestions(data, test) {
  const pool = test.vocabularyIds.filter(id => data.vocabById.has(id));
  const selectedIds = seededShuffle(pool, `${test.seed}|select`).slice(0, test.questionCount);
  return selectedIds.map(id => {
    const direction = (hash32(`${test.seed}|direction|${id}`) & 1) === 0 ? 'en-no' : 'no-en';
    return { wordId: id, direction, item: data.vocabById.get(id) };
  });
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
