/** PUBLIC configuration: safe to deploy. */
export const PUBLIC_SECURITY = Object.freeze({
  publicSigningKey: Object.freeze({
    "crv": "P-256",
    "ext": true,
    "key_ops": [
      "verify"
    ],
    "kty": "EC",
    "x": "ZO2HbUjAFPZahHxEWIz6RhBA-Q2innNhEtsxfBlqui4",
    "y": "2yHbhFXDvP1a06w5L21x02WSvZ808-SBELgOsxfwAkg"
  }),
  publicKeySha256: '0106f2e856174acc1be693d5f0a3458750a5c8a1a5ee90c91736c9a87bf823e9',
  classUnlockKey: 'AZKBGUXWV3W7GH85Q5AX',
  hashedValues: Object.freeze({})
});
