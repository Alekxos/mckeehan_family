// Unlock the family site with the family password.
//
// The build encrypts the tree data, stories and photos (build/lock.mjs). This
// script asks for the password, unlocks the site's private key with it, and
// then decrypts files as the app asks for them: fetch() calls for data, and
// <img src> or SVG <image href> pointing at media/ for photos. A device can
// remember the unlocked key (in IndexedDB, as a key the page cannot read back
// out) so the family does not have to type the password every visit.
(() => {
  'use strict';
  const enc = new TextEncoder();
  const b64 = (s) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));
  // Must match tools/set-password.mjs: capitals and spaces do not count.
  const normalizePassword = (pw) => pw.normalize('NFC').toLowerCase().replace(/\s+/g, '');
  const SESSION = 'family-lock-session';

  let resolveReady;
  const ready = new Promise((r) => (resolveReady = r));
  const S = { cfg: null, key: null, manifest: null, urls: new Map() };
  window.siteLock = { ready, lock: forget };

  // ------------------------------------------------------------ device memory
  const db = () => new Promise((res, rej) => {
    const r = indexedDB.open('family-lock', 1);
    r.onupgradeneeded = () => r.result.createObjectStore('keys');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  async function store(mode, fn) {
    const d = await db();
    return new Promise((res, rej) => {
      const t = d.transaction('keys', mode);
      const q = fn(t.objectStore('keys'));
      t.oncomplete = () => { d.close(); res(q && q.result); };
      t.onerror = t.onabort = () => { d.close(); rej(t.error); };
    });
  }
  const recall = () => store('readonly', (s) => s.get('device')).catch(() => undefined);
  const remember = (v) => store('readwrite', (s) => s.put(v, 'device')).catch(() => undefined);
  const clear = () => store('readwrite', (s) => s.delete('device')).catch(() => undefined);
  const sessionGet = () => { try { return sessionStorage.getItem(SESSION); } catch { return null; } };
  const sessionSet = (v) => { try { sessionStorage.setItem(SESSION, v); } catch { /* private mode */ } };

  // ------------------------------------------------------------ crypto
  async function unwrap(password) {
    const { kdf, wrapped } = S.cfg;
    const base = await crypto.subtle.importKey('raw', enc.encode(normalizePassword(password)), 'PBKDF2', false, ['deriveKey']);
    const kek = await crypto.subtle.deriveKey(
      { name: 'PBKDF2', hash: kdf.hash, salt: b64(kdf.salt), iterations: kdf.iterations },
      base, { name: 'AES-GCM', length: 256 }, false, ['unwrapKey'],
    );
    return crypto.subtle.unwrapKey('pkcs8', b64(wrapped.data), kek, { name: 'AES-GCM', iv: b64(wrapped.iv) },
      { name: 'RSA-OAEP', hash: 'SHA-256' }, false, ['decrypt']);
  }
  async function open(privateKey) {
    try {
      const raw = await crypto.subtle.decrypt({ name: 'RSA-OAEP' }, privateKey, b64(S.cfg.ek));
      S.key = await crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['decrypt']);
      S.manifest = JSON.parse(new TextDecoder().decode(await decryptFile(S.cfg.manifest, 'manifest')));
      return true;
    } catch {
      S.key = S.manifest = null;
      return false;
    }
  }
  async function decryptFile(file, aad) {
    const r = await realFetch(file);
    if (!r.ok) throw new Error(`${file}: ${r.status}`);
    const buf = await r.arrayBuffer();
    return crypto.subtle.decrypt({ name: 'AES-GCM', iv: buf.slice(0, 12), additionalData: enc.encode(aad) }, S.key, buf.slice(12));
  }

  // ------------------------------------------------------------ serving files
  const base = new URL('.', location.href);
  // Media addresses inside the decrypted data are rewritten to lock:media/...,
  // which the browser cannot fetch, so it never asks the server for files that
  // are not there; swap() then puts in the decrypted copy.
  function protectedPath(value) {
    if (!value || !S.manifest) return null;
    if (value.startsWith('lock:')) return S.manifest[value.slice(5)] ? value.slice(5) : null;
    let u;
    try { u = new URL(value, location.href); } catch { return null; }
    if (u.protocol !== base.protocol || u.origin !== base.origin || !u.pathname.startsWith(base.pathname)) return null;
    const rel = decodeURIComponent(u.pathname.slice(base.pathname.length));
    return S.manifest[rel] ? rel : null;
  }
  const bytesOf = (rel) => decryptFile(S.manifest[rel].f, rel);
  function blobUrl(rel) {
    if (!S.urls.has(rel)) {
      S.urls.set(rel, bytesOf(rel).then((b) => URL.createObjectURL(new Blob([b], { type: S.manifest[rel].t }))));
      S.urls.get(rel).catch(() => S.urls.delete(rel));
    }
    return S.urls.get(rel);
  }

  const realFetch = window.fetch.bind(window);
  window.fetch = async (input, init) => {
    const rel = protectedPath(typeof input === 'string' ? input : input && input.url);
    if (!rel) return realFetch(input, init);
    let body = await bytesOf(rel);
    if (S.manifest[rel].t === 'application/json') body = new TextDecoder().decode(body).replace(/(["'])media\//g, '$1lock:media/');
    return new Response(body, { headers: { 'Content-Type': S.manifest[rel].t } });
  };

  // Photos: swap a media/ address for a decrypted copy. Images due to load
  // lazily wait until they come near the screen.
  const ATTR = { img: 'src', image: 'href' };
  async function swap(el) {
    const attr = ATTR[el.localName];
    const value = el.getAttribute(attr);
    const rel = protectedPath(value);
    if (!rel) return;
    try {
      const url = await blobUrl(rel);
      if (el.getAttribute(attr) === value) {
        el.setAttribute('data-src', value);
        el.setAttribute(attr, url);
      }
    } catch { /* leave the broken image; the rest of the page still works */ }
  }
  const near = 'IntersectionObserver' in window
    ? new IntersectionObserver((entries) => entries.forEach((e) => { if (e.isIntersecting) { near.unobserve(e.target); swap(e.target); } }), { rootMargin: '800px' })
    : null;
  function consider(el) {
    const attr = ATTR[el.localName];
    if (!attr || !protectedPath(el.getAttribute(attr))) return;
    if (near && el.getAttribute('loading') === 'lazy') near.observe(el);
    else swap(el);
  }
  function watch() {
    const scan = (root) => {
      if (root.nodeType !== 1) return;
      consider(root);
      root.querySelectorAll('img, image').forEach(consider);
    };
    new MutationObserver((list) => {
      for (const m of list) {
        if (m.type === 'attributes') consider(m.target);
        else m.addedNodes.forEach(scan);
      }
    }).observe(document.documentElement, { subtree: true, childList: true, attributes: true, attributeFilter: ['src', 'href'] });
    scan(document.documentElement);
    // Links to documents (PDFs and the like) open a decrypted copy.
    document.addEventListener('click', (e) => {
      const a = e.target.closest && e.target.closest('a[href]');
      const rel = a && protectedPath(a.getAttribute('href'));
      if (!rel) return;
      e.preventDefault();
      const w = window.open('', '_blank');
      blobUrl(rel).then((url) => { if (w) w.location = url; else location.href = url; });
    }, true);
  }

  // ------------------------------------------------------------ screen
  function screen() {
    const el = document.createElement('div');
    el.className = 'lock';
    el.innerHTML = `<form class="lock-card" autocomplete="on">
      <h1 class="lock-title"></h1>
      <p>This family site is private. Enter the family password to open it.</p>
      <input type="text" name="username" value="family" autocomplete="username" hidden>
      <label class="lock-field"><span>Family password</span>
        <input type="password" name="password" autocomplete="current-password" autocapitalize="none" spellcheck="false" required></label>
      <label class="lock-keep"><input type="checkbox" name="keep" checked> Keep this device unlocked</label>
      <button class="btn lock-go" type="submit">Open the family site</button>
      <p class="lock-msg" role="status" aria-live="polite"></p>
    </form>`;
    el.querySelector('.lock-title').textContent = document.title;
    document.body.appendChild(el);
    document.documentElement.classList.add('locked');
    const form = el.querySelector('form');
    const msg = el.querySelector('.lock-msg');
    const go = el.querySelector('.lock-go');
    form.password.focus();
    form.addEventListener('submit', async (e) => {
      e.preventDefault();
      go.disabled = true;
      msg.className = 'lock-msg';
      msg.textContent = 'Unlocking…';
      let priv = null;
      try { priv = await unwrap(form.password.value); } catch { priv = null; }
      if (!priv || !(await open(priv))) {
        go.disabled = false;
        msg.className = 'lock-msg bad';
        msg.textContent = 'That password did not work. Capitals and spaces do not matter, so check the spelling.';
        form.password.select();
        return;
      }
      const keep = form.keep.checked;
      const session = keep ? null : crypto.getRandomValues(new Uint32Array(4)).join('-');
      if (session) sessionSet(session);
      await remember({ keyId: S.cfg.keyId, priv, session });
      el.remove();
      done();
    });
  }

  function done() {
    document.documentElement.classList.remove('locked');
    watch();
    addLockButton();
    resolveReady();
  }

  function addLockButton() {
    const bar = document.querySelector('header.bar');
    if (!bar || bar.querySelector('.lock-btn')) return;
    const b = document.createElement('button');
    b.className = 'lock-btn';
    b.type = 'button';
    b.title = 'Lock the site on this device';
    b.setAttribute('aria-label', 'Lock the site on this device');
    b.innerHTML = '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
    b.addEventListener('click', forget);
    bar.appendChild(b);
  }

  async function forget() {
    await clear();
    try { sessionStorage.removeItem(SESSION); } catch { /* ignore */ }
    S.urls.forEach((p) => p.then((u) => URL.revokeObjectURL(u)).catch(() => {}));
    location.replace(location.pathname);
  }

  // ------------------------------------------------------------ start
  async function start() {
    try {
      S.cfg = await (await realFetch('lock.json', { cache: 'no-cache' })).json();
    } catch {
      document.body.insertAdjacentHTML('beforeend', '<p class="lock-error">The site could not be loaded. Please reload the page.</p>');
      return;
    }
    if (!window.crypto || !crypto.subtle) {
      document.body.insertAdjacentHTML('beforeend', '<p class="lock-error">This browser cannot open the family site. Please try an up-to-date Chrome, Safari, Edge or Firefox.</p>');
      return;
    }
    const saved = await recall();
    if (saved && saved.keyId === S.cfg.keyId && saved.priv) {
      const sessionOk = !saved.session || saved.session === sessionGet();
      if (sessionOk && (await open(saved.priv))) return done();
    }
    if (saved) await clear();
    screen();
  }

  document.documentElement.classList.add('lockable', 'locked');
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
