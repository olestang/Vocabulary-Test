/** PUBLIC configuration: safe to deploy. */
export const PUBLIC_SECURITY = Object.freeze({
  publicSigningKey: Object.freeze({
    "crv": "P-256",
    "ext": true,
    "key_ops": [
      "verify"
    ],
    "kty": "EC",
    "x": "k7l76-DrqAn_XPjhyE32vxV-5if4k_vYW-EvtRGUTqo",
    "y": "TS6ChkN13wdHZ9pCsAE6IM2neVxuDYlZkcK4kLF0__o"
  }),
  publicKeySha256: '728e7c5d1dcfc03f2c6a35de987a71598e4182fd31b11289a5b5388152b715b1',
  classUnlockKey: 'AZKBGUXWV3W7GH85Q5AX',
  hashedValues: Object.freeze({})
});
