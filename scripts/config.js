import { PUBLIC_SECURITY } from '../config/public-security.js';

export const APP_CONFIG = Object.freeze({
  appName: 'VG1 Vocabulary Test',
  schemaVersion: 1,
  deploymentLabel: 'Static GitHub Pages edition',
  developmentMode: false,
  publicSigningKey: PUBLIC_SECURITY.publicSigningKey,
  publicKeySha256: PUBLIC_SECURITY.publicKeySha256,
  classUnlockKey: PUBLIC_SECURITY.classUnlockKey,
  hashedValues: PUBLIC_SECURITY.hashedValues,
  storagePrefix: 'vg1vocab.v1.',
  submissionFormatVersion: 1,
  resultFormatVersion: 1,
  pinIterations: 120000,
  nextButtonDelayMs: 500,
  receiptLength: 8,
  teacherTokenKinds: {
    access: 'teacher-access',
    unlock: 'unlock',
    release: 'release',
    resultBundle: 'result-bundle'
  }
});
