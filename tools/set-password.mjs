#!/usr/bin/env node
// Set (or change) the family password for the locked site.
//
//   SITE_PASSWORD='the password' node tools/set-password.mjs [--out content/lock.json]
//
// or run it without SITE_PASSWORD and type the password when asked.
//
// The password itself is never written anywhere. This makes a key pair: the
// public half lets any later build encrypt the site without knowing the
// password, and the private half is stored only in wrapped (encrypted) form,
// unlocked by the password in the visitor's browser. Everything in the output
// file is safe to publish, but the protection is only as strong as the
// password, because the wrapped key can be guessed at offline.
//
// Changing the password makes a new key pair, so every device has to unlock
// again with the new password.

import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { webcrypto, randomBytes, createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const { subtle } = webcrypto;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const i = process.argv.indexOf('--out');
const out = path.resolve(ROOT, i > 0 ? process.argv[i + 1] : 'content/lock.json');
const ITERATIONS = 600000;

// Must match normalizePassword() in web/lock.js: capitals and spaces do not count.
const normalizePassword = (pw) => pw.normalize('NFC').toLowerCase().replace(/\s+/g, '');

async function ask() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const answer = await new Promise((res) => rl.question('Family password: ', res));
  rl.close();
  return answer;
}

const pw = normalizePassword(process.env.SITE_PASSWORD || (await ask()));
if (pw.length < 8) throw new Error('Use a password of at least 8 letters (a few words works well).');

const salt = randomBytes(16);
const base = await subtle.importKey('raw', new TextEncoder().encode(pw), 'PBKDF2', false, ['deriveKey']);
const kek = await subtle.deriveKey(
  { name: 'PBKDF2', hash: 'SHA-256', salt, iterations: ITERATIONS },
  base,
  { name: 'AES-GCM', length: 256 },
  false,
  ['wrapKey'],
);
const pair = await subtle.generateKey(
  { name: 'RSA-OAEP', modulusLength: 3072, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
  true,
  ['encrypt', 'decrypt'],
);
const iv = randomBytes(12);
const wrapped = Buffer.from(await subtle.wrapKey('pkcs8', pair.privateKey, kek, { name: 'AES-GCM', iv }));
const publicKey = await subtle.exportKey('jwk', pair.publicKey);
const keyId = createHash('sha256').update(publicKey.n).digest('hex').slice(0, 16);

const lock = {
  _note: 'Made by tools/set-password.mjs. Safe to publish; the password is not stored here. Run that tool again to change the password.',
  v: 1,
  keyId,
  created: new Date().toISOString().slice(0, 10),
  kdf: { name: 'PBKDF2', hash: 'SHA-256', iterations: ITERATIONS, salt: salt.toString('base64') },
  wrapped: { alg: 'AES-GCM', iv: iv.toString('base64'), data: wrapped.toString('base64') },
  publicKey,
};
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(lock, null, 2) + '\n');
console.log(`Wrote ${path.relative(ROOT, out)} (key ${keyId}). Rebuild and publish the site to use it.`);
