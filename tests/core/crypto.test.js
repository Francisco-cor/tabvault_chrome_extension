// tests/core/crypto.test.js — Fase 8.2: cifrado AES-GCM/PBKDF2 de respaldos.
import { describe, it, expect } from 'vitest';
import { encryptWithPassphrase, decryptToText, looksEncrypted } from '../../core/crypto.js';

const SECRET = JSON.stringify({ sessions: { a: { name: 'TOPSECRET-session' } } });

describe('encryptWithPassphrase / decryptToText', () => {
  it('round-trip: cifra y descifra al texto original', async () => {
    const blob = await encryptWithPassphrase(SECRET, 'correct horse');
    const plain = await decryptToText(blob, 'correct horse');
    expect(plain).toBe(SECRET);
  });

  it('magic TBVE reconocible por looksEncrypted', async () => {
    const blob = await encryptWithPassphrase(SECRET, 'pw');
    expect(looksEncrypted(blob)).toBe(true);
    expect(looksEncrypted(new TextEncoder().encode('{"_tabvault":true}'))).toBe(false);
    // ArrayBuffer también aceptado
    const buf = blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength);
    expect(looksEncrypted(/** @type {ArrayBuffer} */ (buf))).toBe(true);
  });

  it('passphrase incorrecta → Error amigable (GCM auth)', async () => {
    const blob = await encryptWithPassphrase(SECRET, 'right');
    await expect(decryptToText(blob, 'wrong')).rejects.toThrow(/Wrong passphrase or corrupted/);
  });

  it('blob alterado → fallo de autenticación', async () => {
    const blob = await encryptWithPassphrase(SECRET, 'pw');
    const copy = Uint8Array.from(blob);
    copy[copy.length - 1] ^= 0xff;
    await expect(decryptToText(copy, 'pw')).rejects.toThrow();
  });

  it('criterio de aceptación: el blob NO contiene plaintext verificable', async () => {
    const blob = await encryptWithPassphrase(SECRET, 'pw');
    const asText = Array.from(blob)
      .map((b) => String.fromCharCode(b))
      .join('');
    expect(asText).not.toContain('TOPSECRET');
    expect(asText).not.toContain('sessions');
    expect(asText).not.toContain('_tabvault');
  });

  it('salt/iv aleatorios: dos cifrados del mismo texto difieren', async () => {
    const a = await encryptWithPassphrase(SECRET, 'pw');
    const b = await encryptWithPassphrase(SECRET, 'pw');
    expect(a.length === b.length && a.every((v, i) => v === b[i])).toBe(false);
  });

  it('header inválido → "Not a TabVault encrypted backup"', async () => {
    const junk = new TextEncoder().encode('plain text file');
    await expect(decryptToText(junk, 'pw')).rejects.toThrow(/Not a TabVault encrypted backup/);
    await expect(decryptToText(new Uint8Array(10), 'pw')).rejects.toThrow();
  });

  it('passphrase vacía rechazada antes de derivar', async () => {
    await expect(encryptWithPassphrase(SECRET, '   ')).rejects.toThrow(/passphrase is required/i);
  });
});
