/** PUBLIC configuration: safe to deploy. */
export const PUBLIC_SECURITY = Object.freeze({
  publicSigningKey: Object.freeze({
    "crv": "P-256",
    "ext": true,
    "key_ops": [
      "verify"
    ],
    "kty": "EC",
    "x": "0cyKxJrSL5QuWWZCBmB84HDTaBNzsQDChpXBDatlhCE",
    "y": "bSmjoIBOjt_H-fiiVj20QdKOjXj7C27bNEW4PnWaaG8"
  }),
  publicKeySha256: '486a4c45bdfa442dc711660d4752f0a0f767a9985b9e360a77fdbb4927bc1ae3',
  classUnlockKey: 'AZKBGUXWV3W7GH85Q5AX',
  hashedValues: Object.freeze({})
});
