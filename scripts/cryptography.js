import { APP_CONFIG } from './config.js';
import {
  stableStringify,
  textToBase64Url,
  base64UrlToText,
  bytesToBase64Url,
  base64UrlToBytes,
  sha256Hex
} from './utilities.js';

export async function encodeCheckedPayload(payload) {
  const json = stableStringify(payload);
  const body = textToBase64Url(json);
  const checksum = (await sha256Hex(json)).slice(0, 16);
  return `${body}.${checksum}`;
}

export async function decodeCheckedPayload(token) {
  const [body, checksum] = String(token || '').split('.');
  if (!body || !checksum) throw new Error('Payload has the wrong format.');
  const json = base64UrlToText(body);
  const expected = (await sha256Hex(json)).slice(0, 16);
  if (expected !== checksum) throw new Error('Payload checksum does not match.');
  return JSON.parse(json);
}

export async function receiptFromToken(token, length = APP_CONFIG.receiptLength) {
  return (await sha256Hex(String(token))).slice(0, length).toLocaleUpperCase('en-US');
}

async function importPublicKey() {
  return crypto.subtle.importKey(
    'jwk',
    APP_CONFIG.publicSigningKey,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

export async function verifySignedToken(token, expectedKind, constraints = {}) {
  try {
    const [payloadPart, signaturePart] = String(token || '').trim().split('.');
    if (!payloadPart || !signaturePart) return { ok: false, reason: 'Malformed signed token.' };
    const payloadBytes = base64UrlToBytes(payloadPart);
    const payload = JSON.parse(new TextDecoder().decode(payloadBytes));
    const key = await importPublicKey();
    const validSignature = await crypto.subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      base64UrlToBytes(signaturePart),
      payloadBytes
    );
    if (!validSignature) return { ok: false, reason: 'Signature is invalid.' };
    if (payload.kind !== expectedKind) return { ok: false, reason: `Token kind is ${payload.kind || 'missing'}.` };
    const now = Date.now();
    if (payload.expiresAt && now > payload.expiresAt) return { ok: false, reason: 'Token has expired.' };
    if (payload.notBefore && now < payload.notBefore) return { ok: false, reason: 'Token is not active yet.' };
    for (const [keyName, expectedValue] of Object.entries(constraints)) {
      if (expectedValue === undefined || expectedValue === null) continue;
      if (payload[keyName] !== expectedValue) {
        return { ok: false, reason: `Token does not match ${keyName}.` };
      }
    }
    return { ok: true, payload };
  } catch (error) {
    return { ok: false, reason: error.message || 'Could not verify token.' };
  }
}


export async function privateKeyMatchesPublic(privateJwk) {
  try {
    if (!privateJwk || privateJwk.kty !== 'EC' || privateJwk.crv !== 'P-256' || !privateJwk.d) return false;
    if (privateJwk.x !== APP_CONFIG.publicSigningKey.x || privateJwk.y !== APP_CONFIG.publicSigningKey.y) return false;
    await crypto.subtle.importKey(
      'jwk',
      privateJwk,
      { name: 'ECDSA', namedCurve: 'P-256' },
      false,
      ['sign']
    );
    return true;
  } catch {
    return false;
  }
}

export async function signTeacherToken(privateJwk, payload) {
  if (!(await privateKeyMatchesPublic(privateJwk))) {
    throw new Error('Saved teacher signing key does not match this site.');
  }
  const key = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
  const payloadBytes = new TextEncoder().encode(stableStringify(payload));
  const signature = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    payloadBytes
  ));
  return `${bytesToBase64Url(payloadBytes)}.${bytesToBase64Url(signature)}`;
}

async function derivePinKey(pin, context, salt, usages) {
  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(`${pin}|${context}`),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: APP_CONFIG.pinIterations },
    keyMaterial,
    { name: 'AES-GCM', length: 256 },
    false,
    usages
  );
}

export async function encryptForPin(value, pin, context) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const key = await derivePinKey(pin, context, salt, ['encrypt']);
  const plaintext = new TextEncoder().encode(stableStringify(value));
  const cipher = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, plaintext));
  return {
    s: bytesToBase64Url(salt),
    i: bytesToBase64Url(iv),
    c: bytesToBase64Url(cipher)
  };
}

export async function decryptForPin(record, pin, context) {
  const salt = base64UrlToBytes(record.s);
  const iv = base64UrlToBytes(record.i);
  const cipher = base64UrlToBytes(record.c);
  const key = await derivePinKey(pin, context, salt, ['decrypt']);
  const plaintext = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
  return JSON.parse(new TextDecoder().decode(plaintext));
}
