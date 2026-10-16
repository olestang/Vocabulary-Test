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

function normalizeFiveLetters(value) {
  return String(value || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .replace(/[IO]/g, '')
    .slice(0, 5);
}

function localHourKey(value = Date.now()) {
  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return '';

  const yyyy = String(date.getFullYear()).padStart(4, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');

  return `${yyyy}${mm}${dd}${hh}`;
}

export function makePreTestExitCode(value = Date.now()) {
  const hour = localHourKey(value);
  if (!hour) return '';

  return lettersFromNumber(
    fnv1a(`${APP_CONFIG.classUnlockKey}|${hour}|pretest-exit`),
    5
  );
}

export function verifyPreTestExitCode(responseCode, value = Date.now()) {
  const response = normalizeFiveLetters(responseCode);
  if (response.length !== 5) return false;

  const date = value instanceof Date ? new Date(value.getTime()) : new Date(value);
  if (Number.isNaN(date.getTime())) return false;

  return [-1, 0, 1].some(offset => {
    const candidate = new Date(date.getTime());
    candidate.setHours(candidate.getHours() + offset);
    return response === makePreTestExitCode(candidate);
  });
}