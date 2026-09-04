// core/crypto.js — Cifrado de respaldos con WebCrypto (Fase 8.2).
// Formato binario .tabvault.enc:
//   bytes 0-3   magic ASCII "TBVE"
//   byte  4     versión de formato (1)
//   bytes 5-20  salt PBKDF2 (16)
//   bytes 21-32 iv AES-GCM (12)
//   resto       ciphertext AES-GCM-256
//
// Derivación: PBKDF2(SHA-256) 250k iteraciones → clave AES-GCM 256.
// GCM autentica: passphrase incorrecta o blob alterado ⇒ fallo de decrypt.

const MAGIC = /** @type {Uint8Array} */ (new TextEncoder().encode('TBVE'));
const FORMAT_VERSION = 1;
const SALT_BYTES = 16;
const IV_BYTES = 12;

export const PBKDF2_ITERATIONS = 250_000;
const PASSPHRASE_MAX = 1024;

const enc = new TextEncoder();
const dec = new TextDecoder();

/** @returns {SubtleCrypto} */
function subtle() {
  const c = /** @type {any} */ (globalThis.crypto);
  if (!c?.subtle) throw new Error('WebCrypto unavailable in this context');
  return c.subtle;
}

/**
 * Deriva una clave AES-GCM 256 desde la passphrase y el salt.
 * @param {string} passphrase @param {Uint8Array} salt @param {number} iterations
 * @returns {Promise<CryptoKey>}
 */
async function deriveKey(passphrase, salt, iterations) {
  const pwBytes = /** @type {BufferSource} */ (/** @type {unknown} */ (enc.encode(passphrase)));
  const base = await subtle().importKey('raw', pwBytes, 'PBKDF2', false, ['deriveKey']);
  return subtle().deriveKey(
    {
      name: 'PBKDF2',
      salt: /** @type {BufferSource} */ (/** @type {unknown} */ (salt)),
      iterations,
      hash: 'SHA-256',
    },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

/**
 * Cifra texto con passphrase. Salt/iv aleatorios por llamada (nunca reutilizados).
 * @param {string} text
 * @param {string} passphrase
 * @param {{ iterations?: number }} [opts] iteraciones inyectables (tests)
 * @returns {Promise<Uint8Array>}
 */
export async function encryptWithPassphrase(text, passphrase, opts = {}) {
  assertPassphrase(passphrase);
  const iterations = opts.iterations ?? PBKDF2_ITERATIONS;
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const key = await deriveKey(passphrase, salt, iterations);
  const ciphertext = new Uint8Array(await subtle().encrypt({ name: 'AES-GCM', iv }, key, enc.encode(text)));

  const out = new Uint8Array(MAGIC.length + 1 + salt.length + iv.length + ciphertext.length);
  let o = 0;
  out.set(MAGIC, o);
  o += MAGIC.length;
  out[o++] = FORMAT_VERSION;
  out.set(salt, o);
  o += salt.length;
  out.set(iv, o);
  o += iv.length;
  out.set(ciphertext, o);
  return out;
}

/**
 * Descifra un blob producido por encryptWithPassphrase.
 * Lanza Error amigable si la passphrase es incorrecta o el archivo está corrupto.
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} passphrase
 * @param {{ iterations?: number }} [opts]
 * @returns {Promise<string>}
 */
export async function decryptToText(bytes, passphrase, opts = {}) {
  assertPassphrase(passphrase);
  const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  const headerLen = MAGIC.length + 1 + SALT_BYTES + IV_BYTES;
  if (
    data.length <= headerLen ||
    !MAGIC.every((b, i) => data[i] === b) ||
    data[MAGIC.length] !== FORMAT_VERSION
  ) {
    throw new Error('Not a TabVault encrypted backup');
  }
  const salt = data.slice(MAGIC.length + 1, MAGIC.length + 1 + SALT_BYTES);
  const iv = data.slice(MAGIC.length + 1 + SALT_BYTES, headerLen);
  const ciphertext = data.slice(headerLen);

  const key = await deriveKey(passphrase, salt, opts.iterations ?? PBKDF2_ITERATIONS);
  try {
    const plain = await subtle().decrypt({ name: 'AES-GCM', iv }, key, ciphertext);
    return dec.decode(plain);
  } catch {
    throw new Error('Wrong passphrase or corrupted file');
  }
}

/** ¿El buffer empieza con el magic .tabvault.enc? Sirve para detectar el formato sin leerlo como texto.
 * @param {ArrayBuffer|Uint8Array} bytes */
export function looksEncrypted(bytes) {
  const data = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : bytes;
  return data.length > MAGIC.length && MAGIC.every((b, i) => data[i] === b);
}

/** @param {string} passphrase */
function assertPassphrase(passphrase) {
  if (typeof passphrase !== 'string' || passphrase.trim().length === 0) {
    throw new Error('A passphrase is required');
  }
  if (passphrase.length > PASSPHRASE_MAX) throw new Error('Passphrase too long');
}

/** @param {number} n */
function randomBytes(n) {
  const c = /** @type {any} */ (globalThis.crypto);
  if (!c?.getRandomValues) throw new Error('WebCrypto unavailable in this context');
  return c.getRandomValues(new Uint8Array(n));
}
