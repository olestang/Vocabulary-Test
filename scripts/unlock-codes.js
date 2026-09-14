import { APP_CONFIG } from './config.js';

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // avoids I and O

function fnv1a(text) {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

function lettersFromNumber(number, length = 5) {
  let n = number >>> 0;
  let out = '';
  for (let i = 0; i < length; i += 1) {
    n = (Math.imul(n ^ (n >>> 13), 1597334677) + 3812015801) >>> 0;
    out += ALPHABET[n % ALPHABET.length];
  }
  return out;
}

export function normalizeFiveLetters(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z]/g, '').replace(/[IO]/g, '').slice(0, 5);
}

export function makeUnlockRequest(attemptId, violationCount) {
  return lettersFromNumber(fnv1a(`${attemptId}|${violationCount}|request`), 5);
}

export function makeUnlockCode(requestCode) {
  const request = normalizeFiveLetters(requestCode);
  if (request.length !== 5) return '';
  return lettersFromNumber(fnv1a(`${APP_CONFIG.classUnlockKey}|${request}|unlock`), 5);
}

export function verifyUnlockCode(requestCode, responseCode) {
  return normalizeFiveLetters(responseCode) === makeUnlockCode(requestCode);
}
