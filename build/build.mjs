#!/usr/bin/env node
// Build the static family-tree site from a GEDCOM file.
//
//   node build/build.mjs [--gedcom path/to/tree.ged] [--out dist]
//
// Output: a folder of plain static files (index.html, app.js, styles.css,
// data/*.js, media/*) that any static host can serve, or that opens straight
// from disk.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import ELK from 'elkjs/lib/elk.bundled.js';
import { readGedcom } from './gedcom.mjs';
import { parseFrontmatter, renderMarkdown } from './markdown.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = Object.fromEntries(
  process.argv.slice(2).reduce((acc, a, i, arr) => (a.startsWith('--') ? [...acc, [a.slice(2), arr[i + 1]]] : acc), []),
);
const config = JSON.parse(fs.readFileSync(path.join(ROOT, 'site.config.json'), 'utf8'));
const OUT = path.resolve(ROOT, args.out || 'dist');
const NOW_YEAR = new Date().getFullYear();
const warn = (...m) => console.warn('  ! ' + m.join(' '));

// ---------------------------------------------------------------- input
const candidates = args.gedcom ? [args.gedcom] : config.gedcom;
const gedPath = candidates.map((p) => path.resolve(ROOT, p)).find((p) => fs.existsSync(p));
if (!gedPath) throw new Error('No GEDCOM found. Tried: ' + candidates.join(', '));
console.log('GEDCOM:', gedPath);
const { people, families } = readGedcom(fs.readFileSync(gedPath, 'utf8'));
console.log(`  ${people.size} people, ${families.size} families`);

const gazetteer = JSON.parse(fs.readFileSync(path.join(ROOT, 'content/places.json'), 'utf8')).places;
const gazLower = Object.fromEntries(Object.entries(gazetteer).map(([k, v]) => [k.toLowerCase(), v]));

// ---------------------------------------------------------------- helpers
const yearOf = (p, tags) => {
  for (const t of tags) {
    const e = p.events.find((e) => e.tag === t && e.date?.year);
    if (e) return e.date.year;
  }
  return null;
};
const eventOf = (p, tags) => tags.map((t) => p.events.find((e) => e.tag === t)).find(Boolean) || null;
const parentsOf = (id) =>
  people.get(id).famc.flatMap((fid) => [families.get(fid).husb, families.get(fid).wife]).filter((x) => x && people.has(x));
const childrenOf = (id) => people.get(id).fams.flatMap((fid) => families.get(fid).children);
const spousesOf = (id) =>
  people.get(id).fams.map((fid) => families.get(fid)).flatMap((f) => [f.husb, f.wife]).filter((x) => x && x !== id && people.has(x));
const fullName = (p) => [p.name.given, p.name.surname].filter(Boolean).join(' ');
const norm = (s) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');

// ---------------------------------------------------------------- root person
const rc = config.root || {};
let rootId = rc.id && people.has(rc.id) ? rc.id : null;
if (!rootId) {
  let best = -1;
  for (const p of people.values()) {
    let s = 0;
    if (rc.given && norm(p.name.given).split(' ')[0] === norm(rc.given)) s += 2;
    if (rc.surname && norm(p.name.surname) === norm(rc.surname)) s += 1;
    if (rc.birthYear && yearOf(p, ['BIRT']) === rc.birthYear) s += 2;
    if (s > best) [best, rootId] = [s, p.id];
  }
}
console.log('Root person:', rootId, fullName(people.get(rootId)));

function findPerson(spec) {
  if (!spec) return null;
  if (spec.id && people.has(spec.id)) return spec.id;
  let best = 0, hit = null;
  for (const p of people.values()) {
    let s = 0;
    if (spec.given && norm(p.name.given).split(' ')[0] === norm(spec.given)) s += 2;
    if (spec.surname && norm(p.name.surname) === norm(spec.surname)) s += 1;
    if (spec.birthYear && yearOf(p, ['BIRT']) === spec.birthYear) s += 2;
    if (s > best) [best, hit] = [s, p.id];
  }
  return best >= 3 ? hit : null;
}

// ---------------------------------------------------------------- living / privacy
const est = new Map();
for (const p of people.values()) {
  const b = yearOf(p, ['BIRT', 'CHR', 'BAPM']);
  if (b) est.set(p.id, b);
}
for (let pass = 0; pass < 8; pass++) {
  for (const p of people.values()) {
    if (est.has(p.id)) continue;
    const guesses = [];
    for (const q of parentsOf(p.id)) if (est.has(q)) guesses.push(est.get(q) + 28);
    for (const c of childrenOf(p.id)) if (est.has(c)) guesses.push(est.get(c) - 28);
    for (const s of spousesOf(p.id)) if (est.has(s)) guesses.push(est.get(s));
    for (const fid of p.fams) {
      const m = families.get(fid).events.find((e) => e.tag === 'MARR' && e.date?.year);
      if (m) guesses.push(m.date.year - 24);
    }
    const d = yearOf(p, ['DEAT', 'BURI']);
    if (d) guesses.push(d - 60);
    if (guesses.length) est.set(p.id, Math.round(guesses.reduce((a, b) => a + b, 0) / guesses.length));
  }
}
const isDeceased = (p) => p.events.some((e) => ['DEAT', 'BURI', 'CREM'].includes(e.tag));
const living = new Set();
for (const p of people.values()) {
  if (['privacy', 'confidential'].includes(p.resn)) living.add(p.id);
  else if (!isDeceased(p)) {
    const e = est.get(p.id);
    if (e == null || e > NOW_YEAR - (config.privacy.presumeLivingIfBornWithinYears ?? 100)) living.add(p.id);
  }
}

// ---------------------------------------------------------------- blood relationships
function upDistances(start) {
  const dist = new Map([[start, 0]]);
  const queue = [start];
  while (queue.length) {
    const id = queue.shift();
    for (const par of parentsOf(id)) {
      if (!dist.has(par)) {
        dist.set(par, dist.get(id) + 1);
        queue.push(par);
      }
    }
  }
  return dist;
}
const rootUp = upDistances(rootId);
const ancestors = new Set(rootUp.keys());

const descendantsOfRoot = new Set();
(function walk(id) {
  for (const c of childrenOf(id)) if (!descendantsOfRoot.has(c)) descendantsOfRoot.add(c), walk(c);
})(rootId);

const gendered = (sex, f, m, n) => (sex === 'F' ? f : sex === 'M' ? m : n);
function relationship(id) {
  if (id === rootId) return '';
  const p = people.get(id);
  const up = upDistances(id);
  let best = null;
  for (const [anc, d2] of up) {
    if (!rootUp.has(anc)) continue;
    const d1 = rootUp.get(anc);
    if (!best || d1 + d2 < best.d1 + best.d2) best = { d1, d2 };
  }
  if (!best) return null;
  const { d1, d2 } = best;
  const s = p.sex;
  if (d2 === 0) {
    if (d1 === 1) return gendered(s, 'mother', 'father', 'parent');
    if (d1 === 2) return gendered(s, 'grandmother', 'grandfather', 'grandparent');
    if (d1 === 3) return gendered(s, 'great-grandmother', 'great-grandfather', 'great-grandparent');
    return `${ordinal(d1 - 2)} great-` + gendered(s, 'grandmother', 'grandfather', 'grandparent');
  }
  if (d1 === 0) {
    if (d2 === 1) return gendered(s, 'daughter', 'son', 'child');
    if (d2 === 2) return gendered(s, 'granddaughter', 'grandson', 'grandchild');
    if (d2 === 3) return gendered(s, 'great-granddaughter', 'great-grandson', 'great-grandchild');
    return `${ordinal(d2 - 2)} great-` + gendered(s, 'granddaughter', 'grandson', 'grandchild');
  }
  if (d2 === 1) {
    if (d1 === 1) return gendered(s, 'sister', 'brother', 'sibling');
    const base = gendered(s, 'aunt', 'uncle', 'aunt or uncle');
    if (d1 === 2) return base;
    if (d1 === 3) return 'great-' + base;
    return `${ordinal(d1 - 2)} great-${base}`;
  }
  if (d1 === 1) {
    const base = gendered(s, 'niece', 'nephew', 'niece or nephew');
    return d2 === 2 ? base : d2 === 3 ? 'grand' + base : `${ordinal(d2 - 3)} great-grand${base}`;
  }
  const degree = Math.min(d1, d2) - 1;
  const removed = Math.abs(d1 - d2);
  return `${ordinal(degree)} cousin` + (removed ? ` ${removed === 1 ? 'once' : removed === 2 ? 'twice' : removed + ' times'} removed` : '');
}

// ---------------------------------------------------------------- who is published
const keep = new Set();
for (const p of people.values()) {
  if (p.id !== rootId && descendantsOfRoot.has(p.id) && !config.privacy.showDescendantsOfRoot) continue;
  if (living.has(p.id) && !ancestors.has(p.id) && !config.privacy.showLivingCollaterals) continue;
  keep.add(p.id);
}
// Drop anyone left floating with no published relative (keeps the canvas tidy).
for (const id of [...keep]) {
  const linked = [...parentsOf(id), ...childrenOf(id), ...spousesOf(id)].some((x) => keep.has(x));
  if (!linked && id !== rootId) keep.delete(id);
}
const hiddenCount = (ids) => ids.filter((x) => !keep.has(x)).length;

// ---------------------------------------------------------------- places
const placeIndex = {};
function placeRef(place) {
  if (!place) return null;
  const key = place.name;
  if (!placeIndex[key]) {
    let lat = place.lat, lon = place.lon, region = false;
    if (lat == null) {
      const g = gazLower[key.toLowerCase()];
      if (g) [lat, lon, region] = [g[0], g[1], g[2] === 'region'];
    }
    placeIndex[key] = { name: key, short: key.split(',')[0].trim(), lat: lat ?? null, lon: lon ?? null, region, origin: originOf(key) };
    if (lat == null) warn('no coordinates for place:', key);
  }
  return key;
}

const US_REGIONS = [
  ['West', /\b(wa|washington|id|idaho|or|oregon|ca|california|mt|montana|nv|ut|az|alaska|ak|hawaii)\b/],
  ['Appalachia', /\b(tn|tennessee|southwest territory|nc|north carolina|va|virginia|ky|kentucky|wv|west virginia|ga|georgia)\b/],
  ['Colonies', /\b(pa|pennsylvania|ma|massachusetts|sc|south carolina|ny|new york|nj|new jersey|md|maryland|de|delaware|ct|connecticut|nh|new hampshire|ri|rhode island|colony)\b/],
];
const COUNTRIES = [
  ['Sweden', /sweden|sverige|j[aä]mtland|jempland|norrland/],
  ['Norway', /norway|norge/],
  ['Germany', /germany|deutschland|pfalz|palatinate|bavaria|bayern|w[uü]rttemberg|prussia|hesse|baden|rhineland/],
  ['Switzerland', /switzerland|schweiz/],
  ['Ireland', /ireland|ulster|donegal|antrim|tyrone|derry|armagh|down\b|fermanagh/],
  ['Scotland', /scotland/],
  ['Wales', /wales/],
  ['England', /england|britain|\buk\b/],
  ['France', /france/],
  ['Netherlands', /netherlands|holland/],
];
function originOf(name) {
  const s = name.toLowerCase();
  if (/southwest territory/.test(s)) return 'Appalachia';
  for (const [c, re] of COUNTRIES) if (re.test(s)) return c;
  const parts = s.split(',').map((x) => x.trim()).reverse();
  for (const part of parts) for (const [r, re] of US_REGIONS) if (re.test(part)) return r;
  if (/united states|usa|america/.test(s)) return 'Elsewhere in America';
  return null;
}

// ---------------------------------------------------------------- media
const gedDir = path.dirname(gedPath);
const mediaOut = path.join(OUT, 'media');
const mediaDirs = [gedDir, path.join(ROOT, 'content')];
const copiedMedia = new Map();
const dedupeMedia = (list) => list.filter((m, i) => list.findIndex((x) => x.src === m.src) === i);
function mediaRef(m) {
  const rel = m.file.replace(/\\/g, '/');
  const found = mediaDirs.map((d) => path.resolve(d, rel)).find((f) => fs.existsSync(f))
    || mediaDirs.map((d) => path.join(d, 'media', path.basename(rel))).find((f) => fs.existsSync(f));
  if (!found) {
    warn('media file not found:', m.file);
    return null;
  }
  if (!copiedMedia.has(found)) {
    let name = path.basename(found).toLowerCase().replace(/[^a-z0-9._-]/g, '_');
    while ([...copiedMedia.values()].includes('media/' + name)) name = '_' + name;
    copiedMedia.set(found, 'media/' + name);
  }
  const kind = /\.(jpe?g|png|gif|webp|avif|svg)$/i.test(found) ? 'image' : /\.pdf$/i.test(found) ? 'pdf' : 'file';
  const src = copiedMedia.get(found);
  const thumb = /\.(jpe?g|png|webp)$/i.test(found) ? src.replace(/^media\//, 'media/thumbs/') : kind === 'image' ? src : undefined;
  return { src, thumb, title: m.title, kind };
}

// ---------------------------------------------------------------- published records
const mode = config.privacy.living || 'hidden';
const out = { people: {}, families: {} };
const ev = (e) => ({
  label: e.label,
  tag: e.tag,
  value: e.value || undefined,
  date: e.date?.text || undefined,
  year: e.date?.year || undefined,
  sort: e.date?.sort || undefined,
  place: placeRef(e.place) || undefined,
  notes: e.notes.length ? e.notes : undefined,
  sources: e.sources.length ? e.sources : undefined,
});

for (const id of keep) {
  const p = people.get(id);
  const isLiving = living.has(id);
  const rec = { id, sex: p.sex, living: isLiving || undefined };
  if (isLiving) {
    const first = (p.name.given || '').split(' ')[0];
    rec.given = mode === 'hidden' ? 'Living' : mode === 'given' ? first || 'Living' : p.name.given || 'Living';
    rec.surname = mode === 'full' ? p.name.surname : '';
    if (mode === 'full' && p.name.nick) rec.nick = p.name.nick;
    rec.events = [];
    const details = config.privacy.livingDetails || 'none';
    if ((details === 'birth' || details === 'year') && mode !== 'hidden') {
      const b = eventOf(p, ['BIRT']);
      if (b) {
        // 'year' publishes the birth year only: no day or month anywhere in the output.
        const y = b.date?.year || undefined;
        const date = details === 'year' ? (y ? String(y) : undefined) : b.date?.text || undefined;
        const sort = details === 'year' ? (y ? y * 10000 : undefined) : b.date?.sort || undefined;
        rec.events = [{ label: 'Born', tag: 'BIRT', date, year: y, sort, place: placeRef(b.place) || undefined }];
        rec.born = b.date?.year || undefined;
        rec.birthPlace = placeRef(b.place) || undefined;
        rec.origin = rec.birthPlace ? placeIndex[rec.birthPlace].origin || undefined : undefined;
      }
    }
  } else {
    Object.assign(rec, {
      given: p.name.given,
      surname: p.name.surname,
      suffix: p.name.suffix || undefined,
      nick: p.name.nick || undefined,
      events: p.events.map(ev).sort((a, b) => (a.sort ?? 1e9) - (b.sort ?? 1e9)),
      notes: p.notes.length ? p.notes : undefined,
      sources: p.sources.length ? p.sources : undefined,
      media: dedupeMedia([
        ...p.media,
        ...p.fams.map((fid) => families.get(fid))
          .filter((f) => ![f.husb, f.wife].some((x) => x && living.has(x)))
          .flatMap((f) => f.media || []),
      ].map(mediaRef).filter(Boolean)),
    });
    const b = eventOf(p, ['BIRT', 'CHR', 'BAPM']);
    const d = eventOf(p, ['DEAT', 'BURI']);
    rec.born = b?.date?.year || undefined;
    rec.died = d?.date?.year || undefined;
    rec.diedText = d && !d.date?.year && d.date?.text ? d.date.text : undefined;
    rec.birthPlace = placeRef(b?.place) || undefined;
    rec.origin = rec.birthPlace ? placeIndex[rec.birthPlace].origin || undefined : undefined;
    if (!rec.media.length) delete rec.media;
  }
  rec.estBorn = !isLiving && !rec.born && est.has(id) ? est.get(id) : undefined;
  rec.rel = relationship(id) ?? undefined;
  rec.gen = rootUp.has(id) ? rootUp.get(id) : undefined;
  rec.famc = p.famc.filter((fid) => { const f = families.get(fid); return [f.husb, f.wife].some((x) => keep.has(x)); });
  rec.fams = p.fams.filter((fid) => { const f = families.get(fid); return [f.husb, f.wife, ...f.children].some((x) => x !== id && keep.has(x)); });
  const hiddenKids = hiddenCount(childrenOf(id));
  const hiddenSpouses = hiddenCount(spousesOf(id));
  if (id !== rootId && hiddenKids + hiddenSpouses) rec.hidden = { children: hiddenKids || undefined, spouses: hiddenSpouses || undefined };
  out.people[id] = rec;
}
// Spouse relationship for people who married in.
for (const rec of Object.values(out.people)) {
  if (rec.rel != null || rec.id === rootId) continue;
  const sp = spousesOf(rec.id).find((s) => out.people[s]?.rel || s === rootId);
  if (sp) rec.relVia = sp;
}

for (const f of families.values()) {
  const husb = keep.has(f.husb) ? f.husb : null;
  const wife = keep.has(f.wife) ? f.wife : null;
  const children = f.children.filter((c) => keep.has(c));
  if (!husb && !wife) continue;
  if (!children.length && !(husb && wife)) continue;
  const anyLiving = [f.husb, f.wife].some((x) => x && living.has(x));
  out.families[f.id] = {
    id: f.id,
    husb,
    wife,
    children,
    hidden: hiddenCount(f.children) || undefined,
    events: anyLiving ? [] : f.events.map(ev),
    notes: !anyLiving && f.notes.length ? f.notes : undefined,
  };
}
for (const rec of Object.values(out.people)) {
  rec.famc = rec.famc.filter((fid) => out.families[fid]);
  rec.fams = rec.fams.filter((fid) => out.families[fid]);
}
// Children of the root are hidden, so the root's own family record above
// can be dropped when it holds nobody but the root.
console.log(`  publishing ${Object.keys(out.people).length} people (${[...keep].filter((x) => living.has(x)).length} living, ${mode === 'hidden' ? 'shown as "Living"' : { birth: 'shown with name and birth date and place only', year: 'shown with name, birth year and birthplace only' }[config.privacy.livingDetails] || 'shown by name only'})`);

// ---------------------------------------------------------------- layout
const CARD_W = 188, CARD_H = 76, GAP = 28;
async function layout() {
  const ids = Object.keys(out.people);
  // Group people joined by marriage into one horizontal block.
  const parent = Object.fromEntries(ids.map((i) => [i, i]));
  const find = (x) => (parent[x] === x ? x : (parent[x] = find(parent[x])));
  for (const f of Object.values(out.families)) if (f.husb && f.wife) parent[find(f.husb)] = find(f.wife);
  const groups = {};
  for (const id of ids) (groups[find(id)] ||= []).push(id);

  const adj = {};
  for (const f of Object.values(out.families)) if (f.husb && f.wife) {
    (adj[f.husb] ||= []).push(f.wife);
    (adj[f.wife] ||= []).push(f.husb);
  }
  const clusters = [];
  const where = {};
  for (const members of Object.values(groups)) {
    let order;
    if (members.length === 1) order = members;
    else {
      const start = members.find((m) => (adj[m] || []).length === 1 && out.people[m].sex === 'M')
        || members.find((m) => (adj[m] || []).length === 1) || members[0];
      order = [];
      const seen = new Set();
      (function dfs(m) {
        seen.add(m);
        order.push(m);
        for (const n of adj[m] || []) if (!seen.has(n)) dfs(n);
      })(start);
    }
    const cid = 'c' + clusters.length;
    order.forEach((m, i) => (where[m] = { cid, i }));
    clusters.push({ id: cid, members: order });
  }
  const genOf = (c) => {
    const ys = c.members.map((m) => out.people[m].born || out.people[m].estBorn || est.get(m) || 3000);
    return Math.min(...ys);
  };
  // Order blocks like a pedigree: father's side left, mother's side right,
  // each direct ancestor's brothers and sisters on the outside of the line,
  // with their descendants hanging beneath them.
  const byId = Object.fromEntries(clusters.map((c) => [c.id, c]));
  const born = (id) => out.people[id].born || out.people[id].estBorn || est.get(id) || 3000;
  const seq = [];
  const emitted = new Set();
  const doneFam = new Set();
  const emitCluster = (cid) => !emitted.has(cid) && (emitted.add(cid), seq.push(byId[cid]));
  const emitCoupleOf = (pid) => {
    const c = byId[where[pid].cid];
    if (emitted.has(c.id)) return;
    const half = Math.ceil(c.members.length / 2);
    c.members.slice(0, half).forEach((m) => emitParents(m));
    emitCluster(c.id);
    c.members.slice(half).forEach((m) => emitParents(m));
  };
  const emitDesc = (pid) => {
    const c = byId[where[pid].cid];
    if (emitted.has(c.id)) return;
    c.members.filter((m) => m !== pid).forEach((m) => emitParents(m));
    emitCluster(c.id);
    const kids = c.members.flatMap((m) => out.people[m].fams.map((fid) => out.families[fid]))
      .flatMap((f) => f.children);
    [...new Set(kids)].sort((a, b) => born(a) - born(b)).forEach(emitDesc);
  };
  function emitParents(pid) {
    const fid = out.people[pid].famc[0];
    if (!fid || doneFam.has(fid)) return;
    doneFam.add(fid);
    const f = out.families[fid];
    emitCoupleOf(f.husb || f.wife);
    f.children.filter((c) => c !== pid && !ancestors.has(c)).sort((a, b) => born(a) - born(b)).forEach(emitDesc);
  }
  emitCoupleOf(rootId);
  for (const m of byId[where[rootId].cid].members)
    out.people[m].fams.flatMap((fid) => out.families[fid].children).sort((a, b) => born(a) - born(b)).forEach(emitDesc);
  clusters.filter((c) => !emitted.has(c.id)).sort((a, b) => genOf(a) - genOf(b)).forEach((c) => emitDesc(c.members[0]));
  clusters.splice(0, clusters.length, ...seq);

  const unionPort = {};
  const nodes = clusters.map((c) => {
    const ports = [];
    c.members.forEach((m, i) => {
      if (out.people[m].famc.length) ports.push({ id: 'in_' + m, x: i * (CARD_W + GAP) + CARD_W / 2, y: 0, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'NORTH' } });
    });
    for (const f of Object.values(out.families)) {
      if (!f.children.length) continue;
      const ps = [f.husb, f.wife].filter(Boolean);
      if (!ps.length || where[ps[0]].cid !== c.id) continue;
      let x;
      if (ps.length === 2) {
        const [a, b] = ps.map((p) => where[p].i).sort((u, v) => u - v);
        x = b === a + 1 ? a * (CARD_W + GAP) + CARD_W + GAP / 2 : ((a + b) / 2) * (CARD_W + GAP) + CARD_W / 2;
      } else x = where[ps[0]].i * (CARD_W + GAP) + CARD_W / 2;
      unionPort[f.id] = 'u_' + f.id;
      ports.push({ id: 'u_' + f.id, x, y: CARD_H, width: 1, height: 1, layoutOptions: { 'elk.port.side': 'SOUTH' } });
    }
    return {
      id: c.id,
      width: c.members.length * CARD_W + (c.members.length - 1) * GAP,
      height: CARD_H,
      ports,
      layoutOptions: { 'elk.portConstraints': 'FIXED_POS' },
    };
  });
  const edges = [];
  for (const f of Object.values(out.families)) {
    if (!unionPort[f.id]) continue;
    const kids = [...f.children].sort((a, b) => (out.people[a].born || out.people[a].estBorn || 0) - (out.people[b].born || out.people[b].estBorn || 0));
    for (const c of kids) edges.push({ id: `e_${f.id}_${c}`, sources: [unionPort[f.id]], targets: ['in_' + c], fam: f.id, child: c });
  }

  const elk = new ELK();
  const graph = await elk.layout({
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.mergeEdges': 'true',
      'elk.layered.spacing.nodeNodeBetweenLayers': '84',
      'elk.layered.spacing.edgeNodeBetweenLayers': '22',
      'elk.spacing.nodeNode': '36',
      'elk.spacing.edgeEdge': '10',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.layered.considerModelOrder.strategy': 'NODES_AND_EDGES',
      'elk.layered.crossingMinimization.forceNodeModelOrder': process.env.ELK_FORCE_ORDER === '0' ? 'false' : 'true',
      'elk.layered.thoroughness': '30',
      'elk.padding': '[top=60,left=60,bottom=60,right=60]',
    },
    children: nodes,
    edges: edges.map(({ id, sources, targets }) => ({ id, sources, targets })),
  });

  const pos = Object.fromEntries(graph.children.map((n) => [n.id, n]));
  for (const c of clusters) {
    const n = pos[c.id];
    c.members.forEach((m, i) => {
      out.people[m].x = Math.round(n.x + i * (CARD_W + GAP));
      out.people[m].y = Math.round(n.y);
    });
  }
  const r = (v) => Math.round(v * 10) / 10;
  const edgePaths = graph.edges.map((e) => {
    const meta = edges.find((x) => x.id === e.id);
    const pts = e.sections.flatMap((s) => [s.startPoint, ...(s.bendPoints || []), s.endPoint]);
    return {
      fam: meta.fam,
      child: meta.child,
      direct: ancestors.has(meta.child) || undefined,
      pts: pts.map((p) => [r(p.x), r(p.y)]),
    };
  });
  // Marriage connectors drawn between partners' cards.
  const marriages = Object.values(out.families)
    .filter((f) => f.husb && f.wife)
    .map((f) => {
      const [a, b] = [out.people[f.husb], out.people[f.wife]].sort((u, v) => u.x - v.x);
      return {
        fam: f.id,
        x1: a.x + CARD_W, x2: b.x, y: a.y + CARD_H / 2,
        drop: unionPort[f.id] ? true : undefined,
        direct: (ancestors.has(f.husb) && ancestors.has(f.wife)) || undefined,
      };
    });
  const singles = Object.values(out.families)
    .filter((f) => !(f.husb && f.wife) && unionPort[f.id])
    .map((f) => ({ fam: f.id }));
  return { width: Math.ceil(graph.width), height: Math.ceil(graph.height), cardW: CARD_W, cardH: CARD_H, gap: GAP, edges: edgePaths, marriages, singles };
}

// ---------------------------------------------------------------- stories
// Match 'Name' or 'Name (birth year)' to one published, non-living person.
function makeResolver(what) {
  const index = new Map();
  for (const rec of Object.values(out.people)) {
    if (rec.living) continue;
    const p = people.get(rec.id);
    const variants = [p.name, ...(p.altNames || [])];
    const names = new Set();
    for (const n of variants) {
      names.add(`${n.given} ${n.surname}`);
      names.add(`${(n.given || '').split(' ')[0]} ${n.surname}`);
      if (p.name.nick) names.add(`${p.name.nick} ${n.surname}`);
    }
    for (const n of names) {
      const k = norm(n);
      (index.get(k) || index.set(k, []).get(k)).push(rec);
    }
  }
  const resolve = (raw) => {
    const m = raw.match(/^(.*?)\s*\((\d{3,4})\)\s*$/);
    const name = m ? m[1] : raw;
    let hits = [...new Set(index.get(norm(name)) || [])];
    if (m && hits.length > 1) hits = hits.filter((h) => (h.born || h.estBorn) && Math.abs((h.born || h.estBorn) - Number(m[2])) <= 3);
    if (hits.length > 1 && hits.filter((h) => h.gen != null).length === 1) hits = hits.filter((h) => h.gen != null);
    if (hits.length !== 1) {
      warn(`${what} "${raw}" matched ${hits.length} people`);
      return null;
    }
    return hits[0];
  };
  return resolve;
}

// Credits for story pictures, keyed by file name: content/media/stories/credits.json
// and <gedcom folder>/media/stories/credits.json, each {"file.jpg": {"credit", "url"}}.
const storyCredits = Object.assign({}, ...[path.join(ROOT, 'content/media/stories/credits.json'), path.join(gedDir, 'media/stories/credits.json')]
  .filter((f) => fs.existsSync(f)).map((f) => JSON.parse(fs.readFileSync(f, 'utf8'))));
const escAttr = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
function creditHtml(file) {
  const c = storyCredits[path.basename(file)];
  if (!c || !c.credit) return '';
  const text = escAttr(c.credit);
  return `<span class="credit">${c.url ? `<a href="${escAttr(c.url)}" target="_blank" rel="noopener">${text}</a>` : text}</span>`;
}
// Copy each picture a story uses and point it at the published copy, with its credit.
function storyPictures(html) {
  return html.replace(/<figure class="story-fig"><img src="([^"]+)"([^>]*)>(?:<figcaption>([\s\S]*?)<\/figcaption>)?<\/figure>|<img src="([^"]+)"/g,
    (all, figSrc, rest, cap, bareSrc) => {
      const file = (figSrc || bareSrc).replace(/&amp;/g, '&');
      if (/^(https?:|data:)/.test(file)) return all;
      const m = mediaRef({ file, title: '' });
      // A picture that isn't there yet is left out rather than shown broken.
      if (!m) return figSrc ? '' : all;
      if (bareSrc) return `<img src="${m.src}"`;
      const credit = creditHtml(file);
      const capHtml = cap || credit ? `<figcaption>${cap || ''}${credit}</figcaption>` : '';
      return `<figure class="story-fig"><img src="${m.src}"${rest} data-full="${m.src}">${capHtml}</figure>`;
    });
}

function buildStories() {
  const dirs = [path.join(ROOT, 'content/stories'), path.join(path.dirname(gedPath), 'stories')].filter((d) => fs.existsSync(d));
  const resolve = makeResolver('story link');
  return dirs
    .flatMap((dir) => fs.readdirSync(dir).filter((f) => f.endsWith('.md')).map((f) => [dir, f]))
    .map(([dir, f]) => {
      const { data, body } = parseFrontmatter(fs.readFileSync(path.join(dir, f), 'utf8'));
      const rendered = renderMarkdown(body, resolve);
      const html = storyPictures(rendered.html).replace(/<div class="fig-row">(<figure[\s\S]*?<\/figure>)<\/div>/g, (all, one) => (/<\/figure><figure/.test(one) ? all : one)).replace(/<div class="fig-row"><\/div>/g, '');
      const linked = rendered.people;
      const cover = data.image ? mediaRef({ file: data.image, title: '' }) : null;
      const route = (Array.isArray(data.route) ? data.route : []).map((line) => {
        const [place, year, label] = line.split('|').map((s) => s.trim());
        const key = placeRef({ name: place });
        return { place: key, year: year ? Number(year) || year : undefined, label: label || undefined };
      });
      return {
        slug: f.replace(/\.md$/, '').replace(/[^a-z0-9-]/gi, '-').toLowerCase(),
        title: data.title || f,
        summary: data.summary || '',
        kicker: data.kicker || '',
        order: Number(data.order) || 99,
        era: data.era || '',
        html,
        cover: cover ? { src: cover.src, thumb: cover.thumb, position: data.imagePosition || undefined } : undefined,
        people: linked,
        route,
      };
    })
    .sort((a, b) => a.order - b.order);
}

// ---------------------------------------------------------------- write
const layoutData = await layout();
const stories = buildStories();
// Only keep places something on the site refers to.
const usedPlaces = new Set([
  ...Object.values(out.people).flatMap((p) => (p.events || []).map((e) => e.place)),
  ...Object.values(out.families).flatMap((f) => f.events.map((e) => e.place)),
  ...stories.flatMap((s) => s.route.map((r) => r.place)),
].filter(Boolean));
const places = Object.fromEntries(Object.entries(placeIndex).filter(([k]) => usedPlaces.has(k)));

// Portraits for tree cards: face crops from content/portraits.json (photos named there
// are also added to that person's photos), then automatic crops of photos of one person.
const portraitJobs = new Map();
{
  const specs = [path.join(ROOT, 'content/portraits.json'), path.join(gedDir, 'portraits.json')]
    .filter((f) => fs.existsSync(f))
    .flatMap((f) => JSON.parse(fs.readFileSync(f, 'utf8')).portraits || []);
  const resolve = makeResolver('portrait for');
  for (const spec of specs) {
    const rec = resolve(spec.person);
    if (!rec) continue;
    const m = mediaRef({ file: spec.file, title: spec.title || '' });
    if (!m || m.kind !== 'image') continue;
    rec.media = rec.media || [];
    const have = rec.media.find((x) => x.src === m.src);
    if (!have) rec.media.push(m);
    else if (!have.title && m.title) have.title = m.title;
    portraitJobs.set(rec.id, { src: m.src, face: spec.face || null, size: spec.size || null });
  }
}

const gallery = [];
for (const rec of Object.values(out.people)) {
  for (const m of rec.media || []) {
    if (m.kind !== 'image') continue;
    let g = gallery.find((x) => x.src === m.src);
    if (!g) gallery.push((g = { src: m.src, thumb: m.thumb, title: m.title, people: [] }));
    if (!g.title && m.title) g.title = m.title;
    g.people.push(rec.id);
  }
}
// Documents (letters, records, clippings) never become portraits.
const DOCUMENT = /\b(pedigree|diary|obituary|pension|register|flyttningsbevis|marriage|certificate|letter|census|record|deed|will|map|bible|sketch|clipping|newspaper|news|journal|article|license|licence|page|document|form|chart|sheet|book|notice|card)s?\b/i;
const isDocument = (g) => DOCUMENT.test(`${g.src.replace(/^media\//, '').replace(/[_-]/g, ' ')} ${g.title || ''}`);
// Photos of several people (named in the title) need a face crop from portraits.json.
// A "detail" is already cut down to one person.
const isGroup = (g) => /\b(and|with|family|group|children|granddaughters|grandsons|brothers|sisters)\b/i.test(g.title || '') && !/\bdetail\b/i.test(g.title || '');
for (const g of gallery)
  if (g.people.length === 1 && !portraitJobs.has(g.people[0]) && !isDocument(g) && !isGroup(g)) portraitJobs.set(g.people[0], { src: g.src, face: null, size: null });
for (const [id] of portraitJobs) out.people[id].portrait = `media/portraits/${id}.jpg`;
const bornOf = (id) => out.people[id].born || out.people[id].estBorn || 3000;
gallery.sort((a, b) => Math.min(...a.people.map(bornOf)) - Math.min(...b.people.map(bornOf)));

const bundle = {
  meta: {
    title: config.title,
    subtitle: config.subtitle,
    rootId,
    rootLabel: config.rootLabel || out.people[rootId].given,
    rootSex: out.people[rootId].sex,
    featuredId: (() => { const f = findPerson(config.featured); return f && out.people[f] && !out.people[f].living ? f : undefined; })(),
    sourcesNote: config.sourcesNote || '',
    contactNote: config.contactNote || '',
    privacy: { living: config.privacy.living, livingDetails: config.privacy.livingDetails || 'none' },
    built: new Date().toISOString().slice(0, 10),
    counts: {
      people: Object.keys(out.people).length,
      ancestors: Object.keys(out.people).filter((id) => ancestors.has(id) && id !== rootId).length,
      generations: Math.max(...[...ancestors].map((a) => rootUp.get(a))) + 1,
      earliest: Math.min(...Object.values(out.people).map((p) => p.born || 9999)),
    },
  },
  people: out.people,
  families: out.families,
  layout: layoutData,
  places,
  stories,
  gallery,
};

fs.rmSync(OUT, { recursive: true, force: true });
fs.mkdirSync(path.join(OUT, 'data'), { recursive: true });
fs.mkdirSync(path.join(OUT, 'vendor'), { recursive: true });
fs.mkdirSync(mediaOut, { recursive: true });
fs.writeFileSync(path.join(OUT, 'data/family.json'), JSON.stringify(bundle));

// Map outlines: Natural Earth countries (world-atlas) and US state lines (us-atlas),
// converted to plain GeoJSON with coordinates rounded to ~1 km.
const topo = await import('topojson-client');
const round = (geom) => {
  const rc = (c) => (typeof c[0] === 'number' ? [Math.round(c[0] * 100) / 100, Math.round(c[1] * 100) / 100] : c.map(rc));
  return { ...geom, coordinates: rc(geom.coordinates) };
};
const world = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/world-atlas/countries-110m.json'), 'utf8'));
const states = JSON.parse(fs.readFileSync(path.join(ROOT, 'node_modules/us-atlas/states-10m.json'), 'utf8'));
const countries = topo.feature(world, world.objects.countries);
const mapData = {
  countries: countries.features.map((f) => ({ type: 'Feature', properties: { name: f.properties.name }, geometry: round(f.geometry) })),
  borders: round(topo.mesh(world, world.objects.countries, (a, b) => a !== b)),
  states: round(topo.mesh(states, states.objects.states, (a, b) => a !== b)),
};
fs.writeFileSync(path.join(OUT, 'data/map.json'), JSON.stringify(mapData));

for (const [src, rel] of copiedMedia) fs.copyFileSync(src, path.join(OUT, rel));
// Small copies of photos for tree cards and the gallery (needs Python with Pillow;
// falls back to the full-size image when unavailable).
{
  const thumbs = path.join(OUT, 'media/thumbs');
  fs.mkdirSync(thumbs, { recursive: true });
  const images = [...copiedMedia.values()].filter((r) => /\.(jpe?g|png|webp)$/i.test(r));
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync('python3', ['-I', path.join(ROOT, 'tools/thumbs.py'), thumbs, ...images.map((r) => path.join(OUT, r))], { encoding: 'utf8' });
  if (res.status !== 0) {
    warn('thumbnails not made, using full-size images:', (res.stderr || res.error || '').toString().trim().split('\n').pop());
    for (const r of images) fs.copyFileSync(path.join(OUT, r), path.join(thumbs, path.basename(r)));
  }
}
{
  const dir = path.join(OUT, 'media/portraits');
  fs.mkdirSync(dir, { recursive: true });
  const jobs = [...portraitJobs].map(([id, j]) => ({ src: path.join(OUT, j.src), out: path.join(dir, `${id}.jpg`), face: j.face, size: j.size }));
  const { spawnSync } = await import('node:child_process');
  const res = spawnSync('python3', ['-I', path.join(ROOT, 'tools/portraits.py')], { input: JSON.stringify(jobs), encoding: 'utf8' });
  if (res.status !== 0) {
    warn('portraits not made, using whole photos:', (res.stderr || res.error || '').toString().trim().split('\n').pop());
    for (const j of jobs) fs.copyFileSync(j.src, j.out);
  }
}
for (const f of fs.readdirSync(path.join(ROOT, 'web'))) fs.copyFileSync(path.join(ROOT, 'web', f), path.join(OUT, f));
fs.copyFileSync(path.join(ROOT, 'node_modules/d3/dist/d3.min.js'), path.join(OUT, 'vendor/d3.min.js'));
fs.writeFileSync(path.join(OUT, '.nojekyll'), '');

// A single-page preview variant: no document wrapper, CSS and app inlined,
// d3 from cdnjs (for hosts that wrap the page themselves).
const html = fs.readFileSync(path.join(OUT, 'index.html'), 'utf8');
const inner = html
  .replace(/<!doctype html>\s*/i, '')
  .replace(/<html[^>]*>\s*/i, '').replace(/<\/html>\s*/i, '')
  .replace(/<head>\s*/i, '').replace(/<\/head>\s*/i, '')
  .replace(/<body>\s*/i, '').replace(/<\/body>\s*/i, '')
  .replace(/<meta charset[^>]*>\s*/i, '').replace(/<meta name="viewport"[^>]*>\s*/i, '')
  .replace('<link rel="stylesheet" href="styles.css">', () => '<style>\n' + fs.readFileSync(path.join(OUT, 'styles.css'), 'utf8') + '\n</style>')
  .replace('<script src="vendor/d3.min.js"></script>', '<script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.9.0/d3.min.js"></script>')
  .replace('<script src="app.js"></script>', () => '<script>\n' + fs.readFileSync(path.join(OUT, 'app.js'), 'utf8') + '\n</script>');
fs.writeFileSync(path.join(OUT, 'preview.html'), inner);

const kb = (f) => Math.round(fs.statSync(path.join(OUT, f)).size / 1024) + ' KB';
console.log(`Built ${OUT}: ${bundle.meta.counts.people} people, ${stories.length} stories, ${copiedMedia.size} media files, layout ${layoutData.width}x${layoutData.height}; family.json ${kb('data/family.json')}, map.json ${kb('data/map.json')}`);
