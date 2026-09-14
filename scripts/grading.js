import { normalizeAnswer, similarity, levenshtein } from './utilities.js';

export function acceptedAnswers(question) {
  if (question.direction === 'en-no') {
    return [question.item.no, ...(question.item.synonymsNo || [])];
  }
  return [question.item.en, ...(question.item.synonymsEn || [])];
}

export function gradeAnswer(question, rawAnswer, gradingConfig = {}) {
  const normalized = normalizeAnswer(rawAnswer);
  const accepted = acceptedAnswers(question);
  if (!normalized) {
    return { band: 'blank', correct: false, similarity: 0, distance: null, matched: null, reason: 'blank' };
  }

  const exact = accepted.find(value => normalizeAnswer(value) === normalized);
  if (exact) {
    return { band: 'correct', correct: true, similarity: 1, distance: 0, matched: exact, reason: 'exact' };
  }

  let best = { similarity: -1, distance: Infinity, matched: accepted[0] || '' };
  for (const candidate of accepted) {
    const sim = similarity(normalized, candidate);
    const dist = levenshtein(normalized, candidate);
    if (sim > best.similarity || (sim === best.similarity && dist < best.distance)) {
      best = { similarity: sim, distance: dist, matched: candidate };
    }
  }

  const highSimilarity = gradingConfig.highSimilarity ?? 0.90;
  const uncertainSimilarity = gradingConfig.uncertainSimilarity ?? 0.72;
  const maxHighEditDistance = gradingConfig.maxHighEditDistance ?? 1;

  if (best.similarity >= highSimilarity && best.distance <= maxHighEditDistance) {
    return { band: 'correct', correct: true, ...best, reason: 'high-confidence-fuzzy' };
  }
  if (best.similarity >= uncertainSimilarity) {
    return { band: 'uncertain', correct: null, ...best, reason: 'close-spelling' };
  }
  return { band: 'wrong', correct: false, ...best, reason: 'low-similarity' };
}

export function gradeAttempt(canonicalQuestions, rawAnswers, gradingConfig = {}) {
  const details = canonicalQuestions.map((question, index) => gradeAnswer(question, rawAnswers[index] ?? '', gradingConfig));
  const estimatedCorrect = details.filter(d => d.band === 'correct').length;
  const uncertain = details.filter(d => d.band === 'uncertain').length;
  const wrong = details.length - estimatedCorrect - uncertain;
  return { details, estimatedCorrect, uncertain, wrong, total: details.length };
}
