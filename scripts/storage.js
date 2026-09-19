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

function completedLockKey(classId, pupilId, testId) {
  return `${classId || 'default'}|${pupilId}|${testId}`;
}

export const storage = {
  getPupilIdentity() { return read('pupilIdentity'); },
  setPupilIdentity(value) { write('pupilIdentity', value); },
  clearPupilIdentity() { localStorage.removeItem(key('pupilIdentity')); },

  getEntrySession() { return read('entrySession'); },
  saveEntrySession(value) { write('entrySession', value); },
  clearEntrySession() { localStorage.removeItem(key('entrySession')); },

  getActiveAttempt() { return read('activeAttempt'); },
  saveActiveAttempt(value) { write('activeAttempt', value); },
  clearActiveAttempt() { localStorage.removeItem(key('activeAttempt')); },

  getCompletedAttempts() { return read('completedAttempts', {}); },
  saveCompletedAttempt(testId, attempt) {
    const all = read('completedAttempts', {});
    all[testId] = attempt;
    write('completedAttempts', all);
    if (attempt?.submitted && attempt?.pupilId != null) {
      const locks = read('completedTestLocks', {});
      locks[completedLockKey(attempt.classId, attempt.pupilId, testId)] = {
        classId: attempt.classId || null,
        pupilId: attempt.pupilId,
        testId,
        attemptId: attempt.attemptId || null,
        finishTime: attempt.finishTime || Date.now()
      };
      write('completedTestLocks', locks);
    }
  },
  getCompletedAttempt(testId) { return read('completedAttempts', {})[testId] || null; },
  clearCompletedAttempts() { localStorage.removeItem(key('completedAttempts')); },

  hasCompletedTest(classId, pupilId, testId, legacyClassId = classId) {
    const locks = read('completedTestLocks', {});
    const lockKey = completedLockKey(classId, pupilId, testId);
    if (locks[lockKey]) return true;
    // Backward compatibility with the old single-class lock key.
    if ((!legacyClassId || String(classId) === String(legacyClassId)) && locks[`${pupilId}|${testId}`]) return true;

    const attempt = read('completedAttempts', {})[testId];
    const legacyAttemptMatchesClass = !attempt?.classId && (!legacyClassId || String(classId) === String(legacyClassId));
    if (attempt?.submitted && String(attempt.pupilId) === String(pupilId) && (legacyAttemptMatchesClass || !classId || String(attempt.classId) === String(classId))) {
      locks[lockKey] = {
        classId: classId || attempt.classId || null,
        pupilId: attempt.pupilId,
        testId,
        attemptId: attempt.attemptId || null,
        finishTime: attempt.finishTime || Date.now()
      };
      write('completedTestLocks', locks);
      return true;
    }
    return false;
  },
  preserveCompletedTestsForPupil(classId, pupilId, legacyClassId = classId) {
    const locks = read('completedTestLocks', {});
    let changed = false;
    for (const [testId, attempt] of Object.entries(read('completedAttempts', {}))) {
      if (!attempt?.submitted || String(attempt.pupilId) !== String(pupilId)) continue;
      if (attempt.classId && classId && String(attempt.classId) !== String(classId)) continue;
      if (!attempt.classId && legacyClassId && String(classId) !== String(legacyClassId)) continue;
      const lockKey = completedLockKey(classId || attempt.classId, pupilId, testId);
      if (!locks[lockKey]) {
        locks[lockKey] = {
          classId: classId || attempt.classId || null,
          pupilId: attempt.pupilId,
          testId,
          attemptId: attempt.attemptId || null,
          finishTime: attempt.finishTime || Date.now()
        };
        changed = true;
      }
    }
    if (changed) write('completedTestLocks', locks);
  },

  getPupilHistory() { return read('pupilHistory', []); },
  clearPupilHistory() { localStorage.removeItem(key('pupilHistory')); },
  savePupilHistoryRecord(record) {
    const items = read('pupilHistory', []);
    const without = items.filter(item => !(
      item.testId === record.testId &&
      item.pupilId === record.pupilId &&
      String(item.classId || '') === String(record.classId || '')
    ));
    without.push(record);
    without.sort((a, b) => (b.correctedAt || 0) - (a.correctedAt || 0));
    write('pupilHistory', without);
  },

  getPracticeMastery() { return read('practiceMastery', {}); },
  clearPracticeMastery() { localStorage.removeItem(key('practiceMastery')); },
  savePracticeMastery(value) { write('practiceMastery', value); },

  getTeacherData() {
    return read('teacherData', { version: 2, submissions: {}, corrections: {} });
  },
  saveTeacherData(value) { write('teacherData', value); },
  clearTeacherData() { localStorage.removeItem(key('teacherData')); },

  getTeacherActiveClassId() { return localStorage.getItem(key('teacherActiveClassId')) || ''; },
  setTeacherActiveClassId(value) { localStorage.setItem(key('teacherActiveClassId'), String(value || '')); },

  getTeacherAccessToken() { return localStorage.getItem(key('teacherAccessToken')) || ''; },
  setTeacherAccessToken(token) { localStorage.setItem(key('teacherAccessToken'), token); },
  clearTeacherAccessToken() { localStorage.removeItem(key('teacherAccessToken')); },

  getTeacherPrivateKey() { return read('teacherPrivateKey'); },
  setTeacherPrivateKey(value) { write('teacherPrivateKey', value); },
  clearTeacherPrivateKey() { localStorage.removeItem(key('teacherPrivateKey')); }
};
