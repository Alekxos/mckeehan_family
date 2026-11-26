// Encrypt a built site so it opens only with the family password.
//
// Everything under data/ and media/ (the tree, stories, photos, portraits) is
// encrypted with a fresh random key for each build and saved under x/ with a
// random name. That key is encrypted with the public key from content/lock.json,
// whose private half only the password unlocks (see tools/set-password.mjs and
// web/lock.js). The page shell, app code and styles stay readable; they hold no
// family data.

import fs from 'node:fs';
import path from 'node:path';
import { webcrypto, randomBytes } from 'node:crypto';

const { subtle } = webcrypto;
const PROTECTED = ['data', 'media'];
const TYPES = {
  '.json': 'application/json', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.png': 'image/png', '.gif': 'image/gif',
  '.webp': 'image/webp', '.avif': 'image/avif', '.svg': 'image/svg+xml', '.pdf': 'application/pdf', '.txt': 'text/plain',
};

function walk(dir, rel = '') {
  const out = [];
  for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const r = rel ? `${rel}/${e.name}` : e.name;
    if (e.isDirectory()) out.push(...walk(dir, r));
    else out.push(r);
  }
  return out;
}

export async function lockSite(OUT, lockPath) {
  const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8'));
  const pub = await subtle.importKey('jwk', lock.publicKey, { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['encrypt']);
  const raw = randomBytes(32);
  const key = await subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt']);
  const ek = Buffer.from(await subtle.encrypt({ name: 'RSA-OAEP' }, pub, raw));
  raw.fill(0);

  const seal = async (bytes, aad) => {
    const iv = randomBytes(12);
    const ct = await subtle.encrypt({ name: 'AES-GCM', iv, additionalData: Buffer.from(aad) }, key, bytes);
    const name = `x/${randomBytes(12).toString('hex')}.bin`;
    fs.writeFileSync(path.join(OUT, name), Buffer.concat([iv, Buffer.from(ct)]));
    return name;
  };

  fs.mkdirSync(path.join(OUT, 'x'), { recursive: true });
  const manifest = {};
  let bytes = 0;
  for (const top of PROTECTED) {
    if (!fs.existsSync(path.join(OUT, top))) continue;
    for (const rel of walk(OUT, top)) {
      const data = fs.readFileSync(path.join(OUT, rel));
      bytes += data.length;
      manifest[rel] = { f: await seal(data, rel), t: TYPES[path.extname(rel).toLowerCase()] || 'application/octet-stream' };
    }
    fs.rmSync(path.join(OUT, top), { recursive: true, force: true });
  }
  const manifestFile = await seal(Buffer.from(JSON.stringify(manifest)), 'manifest');
  fs.rmSync(path.join(OUT, 'preview.html'), { force: true });

  fs.writeFileSync(path.join(OUT, 'lock.json'), JSON.stringify({
    v: 1,
    keyId: lock.keyId,
    kdf: lock.kdf,
    wrapped: lock.wrapped,
    ek: ek.toString('base64'),
    manifest: manifestFile,
  }));

  // The shell loads lock.js before the app, and says nothing about the family.
  const indexPath = path.join(OUT, 'index.html');
  let html = fs.readFileSync(indexPath, 'utf8');
  if (!html.includes('<script src="app.js"></script>')) throw new Error('index.html has no app.js script tag to put lock.js before');
  html = html
    .replace('<script src="app.js"></script>', '<script src="lock.js"></script>\n<script src="app.js"></script>')
    .replace(/<meta name="description"[^>]*>/, '<meta name="description" content="A private family site. Ask the family for the password.">');
  fs.writeFileSync(indexPath, html);

  // Never publish a locked build that still holds readable family data.
  const leftovers = walk(OUT).filter((f) => PROTECTED.some((t) => f.startsWith(t + '/')) || /\.(jpe?g|png|gif|webp|avif|pdf)$/i.test(f));
  if (leftovers.length) throw new Error('Unencrypted files left in the locked build: ' + leftovers.slice(0, 5).join(', '));
  return { files: Object.keys(manifest).length, bytes, keyId: lock.keyId };
}
