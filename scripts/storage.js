import { APP_CONFIG } from './config.js';

const key = suffix => `${APP_CONFIG.storagePrefix}${suffix}`;

function read(suffix, fallback = null) {
  try {
    const raw = localStorage.getItem(key(suffix));
    return raw === null ? fallback : JSON.parse(raw);
  } catch {
    return fallback;
  }
}

function write(suffix, value) {
  localStorage.setItem(key(suffix), JSON.stringify(value));
}

export const storage = {
  getPupilIdentity() { return read('pupilIdentity'); },
  setPupilIdentity(value) { write('pupilIdentity', value); },
  clearPupilIdentity() { localStorage.removeItem(key('pupilIdentity')); },

  getActiveAttempt() { return read('activeAttempt'); },
  saveActiveAttempt(value) { write('activeAttempt', value); },
  clearActiveAttempt() { localStorage.removeItem(key('activeAttempt')); },

  getCompletedAttempts() { return read('completedAttempts', {}); },
  saveCompletedAttempt(testId, attempt) {
    const all = read('completedAttempts', {});
    all[testId] = attempt;
    write('completedAttempts', all);
  },
  getCompletedAttempt(testId) { return read('completedAttempts', {})[testId] || null; },
  clearCompletedAttempts() { localStorage.removeItem(key('completedAttempts')); },

  getPupilHistory() { return read('pupilHistory', []); },
  clearPupilHistory() { localStorage.removeItem(key('pupilHistory')); },
  savePupilHistoryRecord(record) {
    const items = read('pupilHistory', []);
    const without = items.filter(item => !(item.testId === record.testId && item.pupilId === record.pupilId));
    without.push(record);
    without.sort((a, b) => (b.correctedAt || 0) - (a.correctedAt || 0));
    write('pupilHistory', without);
  },

  getPracticeMastery() { return read('practiceMastery', {}); },
  clearPracticeMastery() { localStorage.removeItem(key('practiceMastery')); },
  savePracticeMastery(value) { write('practiceMastery', value); },

  getTeacherData() {
    return read('teacherData', { version: 1, submissions: {}, corrections: {} });
  },
  saveTeacherData(value) { write('teacherData', value); },
  clearTeacherData() { localStorage.removeItem(key('teacherData')); },

  getTeacherAccessToken() { return localStorage.getItem(key('teacherAccessToken')) || ''; },
  setTeacherAccessToken(token) { localStorage.setItem(key('teacherAccessToken'), token); },
  clearTeacherAccessToken() { localStorage.removeItem(key('teacherAccessToken')); }
};
