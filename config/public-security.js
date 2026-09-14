/** PUBLIC configuration: safe to deploy. */
export const PUBLIC_SECURITY = Object.freeze({
  publicSigningKey: Object.freeze({
    "crv": "P-256",
    "ext": true,
    "key_ops": [
      "verify"
    ],
    "kty": "EC",
    "x": "v7IXhLAD8JsktAJsh0IoM13fHS9YexhIYuDA3WCW0YI",
    "y": "IO9m3ReIM0yz4iFGwzBZFWYejhB1iLpTLCiBp43qqk0"
  }),
  publicKeySha256: '677a9dd8eabe49bd8f36451ae14635304f0811c32984b9c47be3b74b2d4d7e29',
  classUnlockKey: 'AZKBGUXWV3W7GH85Q5AX',
  hashedValues: Object.freeze({})
});
