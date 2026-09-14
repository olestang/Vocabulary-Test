/** PUBLIC configuration: safe to deploy. */
export const PUBLIC_SECURITY = Object.freeze({
  publicSigningKey: Object.freeze({
    "crv": "P-256",
    "ext": true,
    "key_ops": [
      "verify"
    ],
    "kty": "EC",
    "x": "EDXjwqi8ECuJd63t8Hg7a3jvbcFkW2p3Udm3PZdjIYM",
    "y": "4zKFBkU0ZrKjRtaE6LRj9pormrYnuY552odG4Q80P3Y"
  }),
  publicKeySha256: 'b999b73eae6f38cfe1b997a0bea8afa476db6e5c44cef10ab78b096b3d350949',
  classUnlockKey: 'AZKBGUXWV3W7GH85Q5AX',
  hashedValues: Object.freeze({})
});
