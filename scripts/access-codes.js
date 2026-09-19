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

export function normalizeTestCode(value) {
  return String(value || '').toUpperCase().replace(/[^A-Z]/g, '').replace(/[IO]/g, '').slice(0, 5);
}

export function classTestCode(test, classRecord) {
  if (!test || !classRecord) return '';
  const classIdentity = `${classRecord.id}|${classRecord.label || ''}`;
  return lettersFromNumber(fnv1a(`${test.code}|${classIdentity}|class-test-code`), 5);
}

export function hourKey(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const yyyy = String(date.getFullYear()).padStart(4, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  return `${yyyy}${mm}${dd}${hh}`;
}

export function lateTestCode(test, classRecord, value = Date.now()) {
  const normal = classTestCode(test, classRecord);
  const hour = hourKey(value);
  if (!normal || !hour) return '';
  return lettersFromNumber(fnv1a(`${normal}|${hour}|late-test-code`), 5);
}

export function localHourInputValue(value = Date.now()) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  const yyyy = String(date.getFullYear()).padStart(4, '0');
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  return `${yyyy}-${mm}-${dd}T${hh}:00`;
}
