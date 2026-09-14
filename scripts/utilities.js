export const $ = (selector, root = document) => root.querySelector(selector);
export const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

export function setHidden(el, hidden) {
  if (!el) return;
  el.hidden = hidden;
}

export async function loadJson(path) {
  const response = await fetch(path, { cache: 'no-cache' });
  if (!response.ok) throw new Error(`Could not load ${path} (${response.status})`);
  return response.json();
}

export function normalizeAnswer(value) {
  return String(value ?? '')
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('nb-NO')
    .replace(/[“”"'`´]/g, '')
    .replace(/[.,!?;:()[\]{}]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function levenshtein(a, b) {
  a = normalizeAnswer(a);
  b = normalizeAnswer(b);
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  const curr = new Array(b.length + 1);
  for (let i = 1; i <= a.length; i += 1) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(curr[j - 1] + 1, prev[j] + 1, prev[j - 1] + cost);
    }
    for (let j = 0; j <= b.length; j += 1) prev[j] = curr[j];
  }
  return prev[b.length];
}

export function similarity(a, b) {
  const na = normalizeAnswer(a);
  const nb = normalizeAnswer(b);
  const maxLen = Math.max(na.length, nb.length);
  if (!maxLen) return 1;
  return 1 - levenshtein(na, nb) / maxLen;
}

export function hash32(input) {
  let h = 2166136261 >>> 0;
  const text = String(input);
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededShuffle(items, seedText) {
  const out = [...items];
  const rand = mulberry32(hash32(seedText));
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  return `{${Object.keys(value).sort().map(k => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
}

export function bytesToBase64Url(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

export function base64UrlToBytes(value) {
  const base64 = value.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  return Uint8Array.from(binary, c => c.charCodeAt(0));
}

export function textToBase64Url(text) {
  return bytesToBase64Url(new TextEncoder().encode(text));
}

export function base64UrlToText(value) {
  return new TextDecoder().decode(base64UrlToBytes(value));
}

export function packBits(bits) {
  const bytes = new Uint8Array(Math.ceil(bits.length / 8));
  bits.forEach((bit, index) => {
    if (bit) bytes[Math.floor(index / 8)] |= (1 << (index % 8));
  });
  return bytesToBase64Url(bytes);
}

export function unpackBits(value, count) {
  const bytes = base64UrlToBytes(value);
  return Array.from({ length: count }, (_, index) => Boolean(bytes[Math.floor(index / 8)] & (1 << (index % 8))));
}

export async function sha256Bytes(value) {
  const bytes = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value));
  return new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
}

export async function sha256Hex(value) {
  const bytes = await sha256Bytes(value);
  return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
}

export function randomId(length = 12) {
  const bytes = crypto.getRandomValues(new Uint8Array(Math.ceil(length * 0.75) + 2));
  return bytesToBase64Url(bytes).slice(0, length);
}

export function formatDuration(seconds) {
  const total = Math.max(0, Math.round(Number(seconds) || 0));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

export function formatDateTime(timestamp) {
  if (!timestamp) return '-';
  return new Intl.DateTimeFormat('nb-NO', { dateStyle: 'medium', timeStyle: 'medium' }).format(new Date(timestamp));
}

export function parseHashParams() {
  return new URLSearchParams(location.hash.replace(/^#/, ''));
}

export function setStatus(el, message, kind = 'info') {
  if (!el) return;
  el.textContent = message;
  el.dataset.kind = kind;
  el.hidden = !message;
}

export function downloadText(filename, text, mime = 'application/json') {
  const blob = new Blob([text], { type: mime });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}
