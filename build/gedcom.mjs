// Minimal GEDCOM 5.5.1 reader: lines -> nested records -> people & families.

const MONTHS = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };
const MONTH_NAMES = ['', 'Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function parseLines(text) {
  text = text.replace(/^﻿/, '');
  const roots = [];
  const stack = [];
  for (const raw of text.split(/\r\n|\r|\n/)) {
    if (!raw.trim()) continue;
    const m = raw.match(/^\s*(\d+)\s+(?:(@[^@]+@)\s+)?(\S+)(?: (.*))?$/);
    if (!m) continue;
    const level = Number(m[1]);
    const node = { level, xref: m[2] ? m[2].slice(1, -1) : null, tag: m[3].toUpperCase(), value: m[4] ?? '', children: [] };
    if (node.tag === 'CONC' || node.tag === 'CONT') {
      const parent = stack[level - 1];
      if (parent) parent.value += (node.tag === 'CONT' ? '\n' : '') + node.value;
      continue;
    }
    stack.length = level;
    if (level === 0) roots.push(node);
    else if (stack[level - 1]) stack[level - 1].children.push(node);
    stack[level] = node;
  }
  return roots;
}

const first = (node, tag) => node.children.find((c) => c.tag === tag);
const all = (node, tag) => node.children.filter((c) => c.tag === tag);
const val = (node, tag) => first(node, tag)?.value?.trim() ?? '';
const ptr = (v) => (v || '').trim().replace(/^@|@$/g, '');

export function parseDate(text) {
  if (!text) return null;
  const t = text.trim();
  if (/^\(.*\)$/.test(t)) return { text: t.slice(1, -1), year: null, sort: null };
  let qual = '';
  let rest = t.toUpperCase();
  const q = rest.match(/^(ABT|ABOUT|CAL|EST|BEF|AFT|BET|FROM|TO|INT)\.?\s+/);
  if (q) {
    qual = q[1];
    rest = rest.slice(q[0].length);
  }
  const part = rest.split(/\s+(?:AND|TO)\s+/)[0];
  const toks = part.split(/\s+/);
  let day = null, month = null, year = null;
  for (const tok of toks) {
    if (MONTHS[tok]) month = MONTHS[tok];
    else if (/^\d{3,4}(\/\d{2})?$/.test(tok)) year = parseInt(tok, 10);
    else if (/^\d{1,2}$/.test(tok)) day = parseInt(tok, 10);
  }
  if (!year) return { text: t, year: null, sort: null };
  const label = { ABT: 'about', ABOUT: 'about', CAL: 'about', EST: 'about', BEF: 'before', AFT: 'after', BET: 'between', FROM: 'from', TO: 'to', INT: '' }[qual] ?? '';
  let pretty = [day, month ? MONTH_NAMES[month] : null, year].filter((x) => x != null).join(' ');
  if (qual === 'BET') {
    const second = rest.split(/\s+AND\s+/)[1];
    pretty = `between ${pretty} and ${second ? parseDate(second).text : '?'}`;
  } else if (label) pretty = `${label} ${pretty}`;
  return { text: pretty, year, sort: year * 10000 + (month || 0) * 100 + (day || 0), approx: !!qual };
}

const EVENT_LABELS = {
  BIRT: 'Born', CHR: 'Christened', BAPM: 'Baptized', DEAT: 'Died', BURI: 'Buried', CREM: 'Cremated',
  MARR: 'Married', DIV: 'Divorced', ENGA: 'Engaged', ADOP: 'Adopted', RESI: 'Lived', OCCU: 'Occupation',
  IMMI: 'Immigrated', EMIG: 'Emigrated', NATU: 'Naturalized', CENS: 'Census', EDUC: 'Education',
  GRAD: 'Graduated', RELI: 'Religion', MILI: 'Military service', _MILT: 'Military service',
  PROB: 'Probate', WILL: 'Will', RETI: 'Retired', CONF: 'Confirmed', EVEN: 'Event', FACT: 'Fact',
  TITL: 'Title', PROP: 'Property', DSCR: 'Description', NATI: 'Nationality',
};

function parseSourceCitations(node, sources) {
  return all(node, 'SOUR').map((s) => {
    const id = ptr(s.value);
    const src = sources.get(id);
    return {
      title: src ? src.title : s.value.trim(),
      page: val(s, 'PAGE'),
      text: first(s, 'DATA') ? val(first(s, 'DATA'), 'TEXT') : val(s, 'TEXT'),
      url: src?.url || '',
    };
  });
}

function parseNotes(node, notes) {
  return all(node, 'NOTE')
    .map((n) => (n.value.startsWith('@') ? notes.get(ptr(n.value)) || '' : n.value))
    .map((s) => s.trim())
    .filter(Boolean);
}

function parseMedia(node, objects) {
  return all(node, 'OBJE')
    .map((o) => {
      const rec = o.value.startsWith('@') ? objects.get(ptr(o.value)) : o;
      if (!rec) return null;
      const f = first(rec, 'FILE');
      if (!f) return null;
      return { file: f.value.trim(), title: val(rec, 'TITL') || val(f, 'TITL') || '' };
    })
    .filter(Boolean);
}

function parseEvent(node, ctx) {
  const tag = node.tag;
  const plac = first(node, 'PLAC');
  let place = null;
  if (plac && plac.value.trim()) {
    place = { name: plac.value.trim() };
    const map = first(plac, 'MAP');
    if (map) {
      const lat = val(map, 'LATI'), lon = val(map, 'LONG');
      const num = (s, neg) => (s ? (s[0] === neg ? -1 : 1) * parseFloat(s.replace(/^[NSEW]/, '')) : NaN);
      const la = num(lat, 'S'), lo = num(lon, 'W');
      if (Number.isFinite(la) && Number.isFinite(lo)) Object.assign(place, { lat: la, lon: lo });
    }
  }
  const type = val(node, 'TYPE');
  return {
    tag,
    label: tag === 'EVEN' || tag === 'FACT' ? type || EVENT_LABELS[tag] : EVENT_LABELS[tag] || type || tag,
    value: node.value.trim() && node.value.trim() !== 'Y' ? node.value.trim() : '',
    date: parseDate(val(node, 'DATE')),
    place,
    notes: parseNotes(node, ctx.notes),
    sources: parseSourceCitations(node, ctx.sources),
  };
}

export function readGedcom(text) {
  const roots = parseLines(text);
  const notes = new Map();
  const sources = new Map();
  const objects = new Map();
  for (const r of roots) {
    if (r.tag === 'NOTE' && r.xref) notes.set(r.xref, r.value);
    if (r.tag === 'SOUR' && r.xref)
      sources.set(r.xref, {
        title: val(r, 'TITL') || val(r, 'ABBR') || r.xref,
        author: val(r, 'AUTH'),
        url: val(r, 'WWW') || val(r, '_URL'),
      });
    if (r.tag === 'OBJE' && r.xref) objects.set(r.xref, r);
  }
  const ctx = { notes, sources };
  const people = new Map();
  const families = new Map();
  const SKIP = new Set(['NAME', 'SEX', 'FAMC', 'FAMS', 'NOTE', 'SOUR', 'OBJE', 'RESN', 'CHAN', 'RIN', 'REFN', '_UID', 'UID', 'ASSO', 'SUBM', 'HUSB', 'WIFE', 'CHIL', 'NCHI', 'ALIA', 'ANCI', 'DESI', 'RFN', 'AFN', '_FSFTID']);
  for (const r of roots) {
    if (r.tag === 'INDI') {
      const names = all(r, 'NAME').map((n) => {
        const m = n.value.match(/^([^/]*)\/?([^/]*)\/?(.*)$/) || [];
        const given = val(n, 'GIVN') || (m[1] || '').trim();
        const surname = val(n, 'SURN') || (m[2] || '').trim();
        return { given, surname, suffix: val(n, 'NSFX') || (m[3] || '').trim(), nick: val(n, 'NICK'), type: val(n, 'TYPE') };
      });
      const name = names[0] || { given: '', surname: '', suffix: '', nick: '' };
      people.set(r.xref, {
        id: r.xref,
        name,
        altNames: names.slice(1),
        sex: val(r, 'SEX') || 'U',
        resn: val(r, 'RESN').toLowerCase(),
        events: r.children.filter((c) => !SKIP.has(c.tag) && !c.tag.startsWith('_') || c.tag === '_MILT').map((e) => parseEvent(e, ctx)),
        notes: parseNotes(r, notes),
        sources: parseSourceCitations(r, sources),
        media: parseMedia(r, objects),
        famc: all(r, 'FAMC').map((f) => ptr(f.value)),
        fams: all(r, 'FAMS').map((f) => ptr(f.value)),
      });
    } else if (r.tag === 'FAM') {
      families.set(r.xref, {
        id: r.xref,
        husb: ptr(val(r, 'HUSB')) || null,
        wife: ptr(val(r, 'WIFE')) || null,
        children: all(r, 'CHIL').map((c) => ptr(c.value)),
        events: r.children.filter((c) => !SKIP.has(c.tag) && !c.tag.startsWith('_')).map((e) => parseEvent(e, ctx)),
        notes: parseNotes(r, notes),
        media: parseMedia(r, objects),
        resn: val(r, 'RESN').toLowerCase(),
      });
    }
  }
  // Make links symmetric, whichever side the file recorded.
  for (const f of families.values()) {
    f.children = [...new Set(f.children)].filter((c) => people.has(c));
    for (const p of [f.husb, f.wife]) if (p && people.has(p) && !people.get(p).fams.includes(f.id)) people.get(p).fams.push(f.id);
    for (const c of f.children) if (!people.get(c).famc.includes(f.id)) people.get(c).famc.push(f.id);
  }
  for (const p of people.values()) {
    p.famc = [...new Set(p.famc)].filter((id) => families.has(id));
    p.fams = [...new Set(p.fams)].filter((id) => families.has(id));
    for (const fid of p.famc) {
      const f = families.get(fid);
      if (!f.children.includes(p.id)) f.children.push(p.id);
    }
  }
  return { people, families, sources };
}
