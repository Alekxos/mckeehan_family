/* The McKeehan Family: interactive tree viewer.
   Reads data/family.json (built from the GEDCOM by build/build.mjs) and
   data/map.json (country and state outlines). No framework; d3 for zoom,
   arcs and map projections. */
(function () {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* storage unavailable */ } },
  };
  const ordinal = (n) => n + (n % 100 >= 11 && n % 100 <= 13 ? 'th' : ['th', 'st', 'nd', 'rd'][n % 10] || 'th');
  const norm = (s) => String(s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
  const isDesktop = () => window.matchMedia('(min-width: 761px)').matches;
  const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let F, P, FAM, L, META, ROOT;
  const S = { view: null, selected: null, baseHash: 'tree', built: {}, story: null, map: null, mapPromise: null, zooms: {} };

  const REGIONS = [
    ['West', 'Pacific Northwest & West', '--r-west'],
    ['Appalachia', 'Tennessee & Appalachia', '--r-appalachia'],
    ['Colonies', 'Colonial America', '--r-colonies'],
    ['Elsewhere in America', 'Elsewhere in America', '--r-other'],
    ['England', 'England', '--r-england'],
    ['Ireland', 'Ireland', '--r-ireland'],
    ['Scotland', 'Scotland', '--r-other'],
    ['Wales', 'Wales', '--r-other'],
    ['Germany', 'Germany', '--r-germany'],
    ['Switzerland', 'Switzerland', '--r-other'],
    ['France', 'France', '--r-other'],
    ['Netherlands', 'Netherlands', '--r-other'],
    ['Norway', 'Norway', '--r-other'],
    ['Sweden', 'Sweden', '--r-sweden'],
  ];
  const regionVar = (o) => (REGIONS.find((r) => r[0] === o) || [0, 0, '--r-none'])[2];
  const regionLabel = (o) => (REGIONS.find((r) => r[0] === o) || [0, 'Birthplace unknown'])[1];

  // ------------------------------------------------------------ people helpers
  const fullName = (p) => (p.living ? [p.given, p.surname].filter(Boolean).join(' ') || 'Living' : [p.given, p.surname, p.suffix].filter(Boolean).join(' '));
  const firstName = (p) => (p.given || '').split(' ')[0] || fullName(p);
  function lifespan(p, short) {
    if (p.living) return p.born ? (short ? `b. ${p.born}` : `born ${p.born}`) : '';
    const b = p.born, d = p.died, dt = p.diedText;
    if (b && d) return `${b} – ${d}`;
    if (b && dt) return `${b} – ${short ? dt.toLowerCase() : 'died ' + dt.toLowerCase()}`;
    if (b) return short ? `b. ${b}` : `born ${b}`;
    if (d) return short ? `d. ${d}` : `died ${d}`;
    return short ? 'dates unknown' : 'Dates not yet known';
  }
  function relText(p) {
    if (p.id === ROOT) return 'Where this tree begins';
    if (p.rel) return `${META.rootLabel}’s ${p.rel}`;
    if (p.relVia && P[p.relVia]) return `Married to ${fullName(P[p.relVia])}`;
    return '';
  }
  const isDirect = (p) => p.gen != null;
  const parentsOf = (p) => (p.famc || []).map((f) => FAM[f]).filter(Boolean).flatMap((f) => [f.husb, f.wife]).filter(Boolean);
  const famsOf = (p) => (p.fams || []).map((f) => FAM[f]).filter(Boolean);
  function genName(g) {
    if (g === 0) return META.rootLabel;
    if (g === 1) return 'Parents';
    if (g === 2) return 'Grandparents';
    if (g === 3) return 'Great-grandparents';
    return `${ordinal(g - 2)} great-grandparents`;
  }
  const go = (hash) => {
    if (location.hash.slice(1) === hash) route();
    else location.hash = hash;
  };

  // ------------------------------------------------------------ boot
  async function boot() {
    try {
      F = window.FAMILY || (await (await fetch('data/family.json')).json());
    } catch (e) {
      document.querySelector('main').innerHTML = '<p style="padding:24px">The family data could not be loaded. Please reload the page.</p>';
      return;
    }
    P = F.people; FAM = F.families; L = F.layout; META = F.meta; ROOT = META.rootId;
    $('#brand-title').textContent = META.title;
    $('#brand-sub').textContent = `${META.subtitle || 'Family tree'} · ${META.counts.generations} generations · since ${META.counts.earliest}`;
    $('#key-line').textContent = `${META.rootLabel}’s direct line`;
    const pv = META.privacy || {};
    $('#key-living').textContent = pv.living === 'hidden' ? 'Living, details private' : pv.livingDetails === 'birth' ? 'Living (name and birth only)' : 'Living (name only)';
    if (!Object.values(P).some((p) => p.hidden)) $('#key-hidden').remove();
    document.title = META.title;
    setupSearch();
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && !$('#panel').hidden) closePanel();
    });
    window.addEventListener('hashchange', route);
    route();
  }

  // ------------------------------------------------------------ routing
  const VIEWS = ['tree', 'fan', 'map', 'photos', 'stories', 'people'];
  function route() {
    const h = decodeURIComponent(location.hash.slice(1));
    if (h.startsWith('person-') && P[h.slice(7)]) {
      if (!S.view) showView('tree');
      openPerson(h.slice(7));
      return;
    }
    if (h.startsWith('story-')) {
      S.baseHash = h;
      showView('stories');
      openStory(h.slice(6));
      hidePanel();
      return;
    }
    const v = VIEWS.includes(h) ? h : 'tree';
    S.baseHash = v;
    showView(v);
    if (v === 'stories') renderStoryList();
    hidePanel();
  }

  function showView(v) {
    S.view = v;
    for (const name of VIEWS) $('#view-' + name).hidden = name !== v;
    document.querySelectorAll('.tab').forEach((t) => {
      if (t.dataset.view === v) t.setAttribute('aria-current', 'page');
      else t.removeAttribute('aria-current');
    });
    if (!S.built[v]) {
      S.built[v] = true;
      ({ tree: buildTree, fan: buildFan, map: buildMap, photos: buildPhotos, stories: () => {}, people: buildPeople })[v]();
    }
    highlightSelection();
  }

  // ------------------------------------------------------------ tree
  function roundedPath(pts, r = 9) {
    if (pts.length < 3) return 'M' + pts.map((p) => p.join(',')).join('L');
    let d = `M${pts[0][0]},${pts[0][1]}`;
    for (let i = 1; i < pts.length - 1; i++) {
      const [x0, y0] = pts[i - 1], [x1, y1] = pts[i], [x2, y2] = pts[i + 1];
      const d1 = Math.hypot(x1 - x0, y1 - y0), d2 = Math.hypot(x2 - x1, y2 - y1);
      if (!d1 || !d2) { d += `L${x1},${y1}`; continue; }
      const rr = Math.min(r, d1 / 2, d2 / 2);
      d += `L${x1 + ((x0 - x1) * rr) / d1},${y1 + ((y0 - y1) * rr) / d1}Q${x1},${y1} ${x1 + ((x2 - x1) * rr) / d2},${y1 + ((y2 - y1) * rr) / d2}`;
    }
    const last = pts[pts.length - 1];
    return d + `L${last[0]},${last[1]}`;
  }

  function fitText(text, avail, sizes, charW) {
    for (const size of sizes) {
      if (text.length * size * charW <= avail) return { text, size };
    }
    const size = sizes[sizes.length - 1];
    const max = Math.max(3, Math.floor(avail / (size * charW)));
    return { text: text.slice(0, max - 1).trimEnd() + '…', size };
  }

  function buildTree() {
    const svgEl = $('#tree-svg');
    const svg = d3.select(svgEl);
    const vp = svg.append('g');
    const W = L.cardW, H = L.cardH;
    const people = Object.values(P);

    // Generation bands behind alternating rows.
    const rowsY = [...new Set(people.map((p) => p.y))].sort((a, b) => a - b);
    vp.append('g').selectAll('rect').data(rowsY.filter((_, i) => i % 2 === 1)).join('rect')
      .attr('class', 'band').attr('x', -6000).attr('width', L.width + 12000).attr('y', (y) => y - 26).attr('height', H + 52);

    const edges = [...L.edges].sort((a, b) => (a.direct ? 1 : 0) - (b.direct ? 1 : 0));
    vp.append('g').selectAll('path').data(edges).join('path')
      .attr('class', (e) => 'edge' + (e.direct ? ' direct' : '')).attr('d', (e) => roundedPath(e.pts));

    const mg = vp.append('g');
    for (const m of L.marriages) {
      const mid = (m.x1 + m.x2) / 2;
      mg.append('line').attr('class', 'marriage' + (m.direct ? ' direct' : '')).attr('x1', m.x1).attr('x2', m.x2).attr('y1', m.y).attr('y2', m.y);
      if (m.drop) mg.append('line').attr('class', 'drop' + (m.direct ? ' direct' : '')).attr('x1', mid).attr('x2', mid).attr('y1', m.y).attr('y2', m.y + H / 2);
      const fam = FAM[m.fam];
      const marr = fam && fam.events.find((e) => e.tag === 'MARR');
      const ring = mg.append('circle').attr('class', 'ring' + (m.direct ? ' direct' : '')).attr('cx', mid).attr('cy', m.y).attr('r', 5);
      ring.append('title').text(marr && marr.date ? `Married ${marr.date}${marr.place ? ', ' + marr.place : ''}` : 'Married');
    }

    const defs = svg.append('defs');
    const cards = vp.append('g').selectAll('g').data(people).join('g')
      .attr('class', (p) => 'card' + (isDirect(p) ? ' direct' : '') + (p.id === ROOT ? ' root' : '') + (p.living ? ' living' : ''))
      .attr('transform', (p) => `translate(${p.x},${p.y})`)
      .attr('tabindex', 0)
      .attr('role', 'button')
      .attr('aria-label', (p) => `${fullName(p)}${lifespan(p) ? ', ' + lifespan(p) : ''}${relText(p) ? '. ' + relText(p) : ''}`)
      .on('click', (e, p) => go('person-' + p.id))
      .on('keydown', (e, p) => {
        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go('person-' + p.id); }
      });
    cards.append('rect').attr('class', 'bg').attr('width', W).attr('height', H).attr('rx', 6);
    cards.each(function (p) {
      const g = d3.select(this);
      let tx = 14;
      if (p.portrait) {
        const cid = 'clip-' + p.id;
        defs.append('clipPath').attr('id', cid).append('circle').attr('cx', 34).attr('cy', H / 2).attr('r', 24);
        g.append('image').attr('href', p.portrait).attr('x', 10).attr('y', H / 2 - 24).attr('width', 48).attr('height', 48)
          .attr('preserveAspectRatio', 'xMidYMid slice').attr('clip-path', `url(#${cid})`);
        g.append('circle').attr('class', 'c-photo-ring').attr('cx', 34).attr('cy', H / 2).attr('r', 24);
        tx = 68;
      }
      const avail = W - tx - 12;
      const given = fitText(p.given || (p.living ? 'Living' : 'Unknown'), avail, [15, 13.5, 12.5], 0.52);
      g.append('text').attr('class', 'c-given').attr('x', tx).attr('y', p.living && !p.surname ? 34 : 26).style('font-size', given.size + 'px').text(given.text);
      if (p.surname) {
        const sur = fitText(p.surname.toUpperCase(), avail, [11, 10], 0.75);
        g.append('text').attr('class', 'c-sur').attr('x', tx).attr('y', 44).style('font-size', sur.size + 'px').text(sur.text);
      }
      g.append('text').attr('class', 'c-years').attr('x', tx).attr('y', p.living && !p.surname ? 54 : 63).text(lifespan(p, true) || (p.living ? 'Living' : ''));
      const hidden = p.hidden ? (p.hidden.children || 0) + (p.hidden.spouses || 0) : 0;
      if (hidden) {
        const b = g.append('g').attr('class', 'c-badge').attr('transform', `translate(${W - 34},${H - 21})`);
        b.append('rect').attr('width', 26).attr('height', 15).attr('rx', 7.5);
        b.append('text').attr('x', 13).attr('y', 11).attr('text-anchor', 'middle').text('+' + hidden);
        b.append('title').text(`${hidden} living ${hidden === 1 ? 'relative' : 'relatives'} not shown`);
      }
    });
    S.cards = cards;

    // Generation labels on the left edge, following the zoom.
    const genRows = d3.rollups(people.filter(isDirect), (v) => ({
      gens: new Set(v.map((p) => p.gen)),
      gen: d3.min(v, (p) => p.gen),
      born: d3.median(v.filter((p) => p.born), (p) => p.born),
    }), (p) => p.y);
    const rail = $('#rail');
    rail.innerHTML = genRows
      .filter(([, r]) => r.gens.size === 1 && r.gen > 0)
      .map(([y, r]) => `<div class="rail-label" data-y="${y}">${r.born ? `Born c. ${Math.floor(r.born / 10) * 10}s` : `Generation ${r.gen}`}<b>${esc(genName(r.gen))}</b></div>`)
      .join('');
    const railLabels = [...rail.children];
    const updateRail = (t) => {
      const h = svgEl.clientHeight;
      for (const el of railLabels) {
        const y = t.applyY(Number(el.dataset.y) + H / 2);
        el.style.top = y + 'px';
        el.hidden = y < 24 || y > h - 70 || t.k < 0.2;
      }
    };

    const zoom = d3.zoom().scaleExtent([0.05, 2.4]).on('zoom', (e) => {
      vp.attr('transform', e.transform);
      updateRail(e.transform);
      svgEl.classList.toggle('far', e.transform.k < 0.42);
      svgEl.classList.toggle('farther', e.transform.k < 0.15);
    });
    svg.call(zoom).on('dblclick.zoom', null);
    S.zooms.tree = { svg, zoom };

    const fitBox = (box, maxK = 1, minK = 0.05) => {
      const w = svgEl.clientWidth, h = svgEl.clientHeight;
      const k = Math.max(minK, Math.min(maxK, (w - 80) / (box.x1 - box.x0), (h - 120) / (box.y1 - box.y0)));
      const t = d3.zoomIdentity.translate(w / 2, h / 2 + 10).scale(k).translate(-(box.x0 + box.x1) / 2, -(box.y0 + box.y1) / 2);
      return t;
    };
    const boxOf = (list) => ({
      x0: d3.min(list, (p) => p.x), x1: d3.max(list, (p) => p.x + W),
      y0: d3.min(list, (p) => p.y), y1: d3.max(list, (p) => p.y + H),
    });
    const rootKids = famsOf(P[ROOT]).flatMap((f) => f.children);
    const near = people.filter((p) => (isDirect(p) && p.gen <= 1) || rootKids.includes(p.id));
    const startBox = boxOf(near.length ? near : people);
    const startView = () => {
      // Open on the root with parents above and children below, placed low so
      // the gold line leads up into the older generations. On a phone, centre
      // on the root's own card.
      const w = svgEl.clientWidth, h = svgEl.clientHeight;
      if (!isDesktop()) {
        const r = people.find((p) => p.id === ROOT) || people[0];
        return d3.zoomIdentity.translate(w / 2, h * 0.5).scale(0.7).translate(-(r.x + W / 2), -(r.y + H / 2));
      }
      const rail = ($('#rail') && $('#rail').offsetWidth) || 0;
      const k = Math.min(0.85, (w - rail - 64) / (startBox.x1 - startBox.x0 || 1));
      return d3.zoomIdentity.translate(rail + (w - rail) / 2, h * 0.62).scale(k).translate(-(startBox.x0 + startBox.x1) / 2, -(startBox.y0 + startBox.y1) / 2);
    };

    const animate = (sel) => (reduceMotion() ? sel : sel.transition().duration(600));
    $('#zoom-in').onclick = () => animate(svg).call(zoom.scaleBy, 1.4);
    $('#zoom-out').onclick = () => animate(svg).call(zoom.scaleBy, 1 / 1.4);
    $('#zoom-fit').onclick = () => animate(svg).call(zoom.transform, fitBox(boxOf(people), 1, 0.05));
    $('#zoom-root').onclick = () => animate(svg).call(zoom.transform, startView());

    S.focusTree = (id) => {
      const p = P[id];
      if (!p) return;
      const w = svgEl.clientWidth, h = svgEl.clientHeight;
      const t0 = d3.zoomTransform(svgEl);
      const k = Math.max(t0.k, 0.8);
      const panelW = !$('#panel').hidden && isDesktop() ? $('#panel').offsetWidth : 0;
      const sheetH = !$('#panel').hidden && !isDesktop() ? $('#panel').offsetHeight : 0;
      const cx = (w - panelW) / 2, cy = (h - sheetH) / 2;
      const t = d3.zoomIdentity.translate(cx, cy).scale(k).translate(-(p.x + W / 2), -(p.y + H / 2));
      animate(svg).call(zoom.transform, t);
    };

    renderWelcome();
    svg.call(zoom.transform, startView());
  }

  function renderWelcome() {
    const el = $('#welcome');
    if (store.get('welcome-dismissed')) return;
    const feat = META.featuredId && P[META.featuredId];
    el.innerHTML = `
      <h2>${esc(META.title)}, ${META.counts.earliest} to today</h2>
      <p>${esc(META.rootLabel)} is near the bottom of the tree${famsOf(P[ROOT]).some((f) => f.children.length) ? `, with ${META.rootSex === 'F' ? 'her' : META.rootSex === 'M' ? 'his' : 'their'} children below` : ''}. Follow the gold line up through ${META.rootSex === 'F' ? 'her' : META.rootSex === 'M' ? 'his' : 'their'} ancestors. Drag to move around, scroll or pinch to zoom, and click anyone to read about them.</p>
      <div class="stats">
        <div><b>${META.counts.people}</b><span>People</span></div>
        <div><b>${META.counts.ancestors}</b><span>Ancestors</span></div>
        <div><b>${META.counts.generations}</b><span>Generations</span></div>
      </div>
      <div class="row">
        ${feat ? `<button class="btn primary" id="w-feat">Meet ${esc(fullName(feat))}</button>` : ''}
        <a class="btn" href="#stories">Read the stories</a>
        <button class="btn" id="w-close">Close</button>
      </div>`;
    el.hidden = false;
    const dismiss = () => { el.hidden = true; store.set('welcome-dismissed', '1'); };
    $('#w-close').onclick = dismiss;
    if (feat) $('#w-feat').onclick = () => { dismiss(); go('person-' + feat.id); };
    el.querySelector('a[href="#stories"]').addEventListener('click', dismiss);
  }

  // ------------------------------------------------------------ fan chart
  function buildFan() {
    const svgEl = $('#fan-svg');
    const svg = d3.select(svgEl);
    const g = svg.append('g');
    const maxGen = Math.min(META.counts.generations - 1, 10);
    const frontier = maxGen;
    const slots = [];
    (function walk(id, gen, idx) {
      if (gen > frontier) return;
      if (!id) {
        if (gen > 0) slots.push({ gen, idx, id: null });
        return;
      }
      if (gen > maxGen) return;
      slots.push({ gen, idx, id });
      const fam = P[id].famc && P[id].famc[0] && FAM[P[id].famc[0]];
      walk(fam ? fam.husb : null, gen + 1, idx * 2);
      walk(fam ? fam.wife : null, gen + 1, idx * 2 + 1);
    })(ROOT, 0, 0);

    const R0 = 72;
    const ringW = (gen) => (gen <= 3 ? 74 : gen <= 5 ? 104 : 112);
    const inner = (gen) => { let r = R0; for (let i = 1; i < gen; i++) r += ringW(i); return r; };
    const span = (Math.PI * 4) / 3;
    const arc = d3.arc();

    const wedges = g.append('g').selectAll('path').data(slots.filter((s) => s.gen > 0)).join('path')
      .attr('class', (s) => 'fan-wedge' + (s.id ? '' : ' empty'))
      .attr('d', (s) => {
        const n = 2 ** s.gen;
        const a0 = -span / 2 + (s.idx * span) / n;
        s.a0 = a0; s.a1 = a0 + span / n; s.r0 = inner(s.gen); s.r1 = s.r0 + ringW(s.gen);
        return arc({ innerRadius: s.r0, outerRadius: s.r1, startAngle: s.a0, endAngle: s.a1 });
      })
      .style('fill', (s) => (s.id ? `color-mix(in oklab, var(${regionVar(P[s.id].origin)}) ${P[s.id].origin ? 44 : 30}%, var(--card))` : null))
      .on('click', (e, s) => s.id && go('person-' + s.id))
      .on('mousemove', (e, s) => s.id && showTip(e, `<b>${esc(fullName(P[s.id]))}</b><br><span class="muted">${esc(lifespan(P[s.id]))}${P[s.id].birthPlace ? '<br>Born ' + esc(P[s.id].birthPlace) : ''}</span>`))
      .on('mouseleave', hideTip);
    wedges.filter((s) => !s.id).append('title').text('Not yet identified');
    S.fanWedges = wedges;

    // Labels
    const labels = g.append('g');
    for (const s of slots) {
      if (!s.id || s.gen === 0) continue;
      const p = P[s.id];
      const am = (s.a0 + s.a1) / 2;
      const rm = (s.r0 + s.r1) / 2;
      const x = rm * Math.sin(am), y = -rm * Math.cos(am);
      let deg = (am * 180) / Math.PI;
      const t = labels.append('g');
      if (s.gen <= 3) {
        if (Math.abs(deg) > 95) deg += 180;
        t.attr('transform', `translate(${x},${y}) rotate(${deg})`);
        const arcLen = rm * (s.a1 - s.a0) - 12;
        const size = s.gen === 1 ? 14 : 12.5;
        const lines = s.gen === 1 ? [fullName(p)] : [p.given.split(' ')[0] || p.given, p.surname || ''];
        const fitted = lines.filter(Boolean).map((l) => fitText(l, arcLen, [size, size - 1.5], 0.53));
        const yrs = lifespan(p, true);
        const total = fitted.length + (yrs ? 1 : 0);
        fitted.forEach((f, i) => t.append('text').attr('class', 'fan-text').attr('text-anchor', 'middle')
          .attr('y', (i - (total - 1) / 2) * 15 + 4).style('font-size', f.size + 'px').text(f.text));
        if (yrs && !p.living) t.append('text').attr('class', 'fan-sub').attr('text-anchor', 'middle').attr('y', (fitted.length - (total - 1) / 2) * 15 + 4).text(yrs);
      } else {
        const thick = rm * (s.a1 - s.a0);
        if (thick < 9) continue;
        deg -= 90;
        if (am < 0) deg += 180;
        t.attr('transform', `translate(${x},${y}) rotate(${deg})`);
        const size = thick > 30 ? 11 : thick > 16 ? 10 : 8.5;
        const len = ringW(s.gen) - 12;
        const nm = fitText(`${p.given.split(' ')[0]} ${p.surname}`.trim(), len, [size], 0.53);
        const two = thick > 26;
        t.append('text').attr('class', 'fan-text').attr('text-anchor', 'middle').attr('y', two ? -2 : size / 3).style('font-size', nm.size + 'px').text(nm.text);
        if (two) t.append('text').attr('class', 'fan-sub').attr('text-anchor', 'middle').attr('y', size + 1).style('font-size', size - 1 + 'px').text(lifespan(p, true));
      }
    }

    // Generation labels along the left edge of the fan.
    const gl = g.append('g');
    for (let gen = 1; gen <= maxGen; gen++) {
      const r = inner(gen) + ringW(gen) / 2;
      const a = -span / 2 - 0.035;
      gl.append('text').attr('class', 'fan-gen').attr('text-anchor', 'middle')
        .attr('transform', `translate(${r * Math.sin(a)},${-r * Math.cos(a)}) rotate(${(a * 180) / Math.PI + 90})`)
        .text(`Gen ${gen}`);
    }

    g.append('circle').attr('class', 'fan-center').attr('r', R0 - 6).on('click', () => go('person-' + ROOT));
    g.append('text').attr('class', 'fan-center-text').attr('text-anchor', 'middle').attr('y', 7).text(firstName(P[ROOT]));

    // Note and key
    const known = slots.filter((s) => s.id && s.gen > 0 && s.gen <= maxGen).length;
    const total = 2 ** (maxGen + 1) - 2;
    $('#fan-note').innerHTML = `<h2>${esc(META.rootLabel)}’s ancestors</h2>
      Each ring is one generation further back, father’s side on the left and mother’s on the right. Color shows where each person was born.
      <strong>${known} of ${total}</strong> places in ${maxGen} generations have a name so far. Dashed slots are parents still to be found.`;
    const present = [...new Set(slots.filter((s) => s.id && s.gen > 0).map((s) => P[s.id].origin || null))];
    const order = REGIONS.map((r) => r[0]);
    present.sort((a, b) => (a == null) - (b == null) || order.indexOf(a) - order.indexOf(b));
    $('#fan-key').innerHTML = present.map((o) => `<span><i class="sw-dot" style="background: var(${regionVar(o)})"></i>${esc(regionLabel(o))}</span>`).join('')
      + '<span><i class="sw-card"></i>Not yet identified</span>';

    const zoom = d3.zoom().scaleExtent([0.2, 6]).on('zoom', (e) => g.attr('transform', e.transform));
    svg.call(zoom).on('dblclick.zoom', null);
    const Rmax = inner(frontier) + ringW(frontier);
    const fit = () => {
      const w = svgEl.clientWidth, h = svgEl.clientHeight;
      const note = $('#fan-note');
      const top = isDesktop() ? 24 : note.offsetHeight + 28;
      let k = Math.min((w - 32) / (2 * Rmax), (h - top - 80) / (1.5 * Rmax));
      if (isDesktop()) {
        // Shrink until the note in the top-left corner sits outside the fan's circle.
        const nx = 16 + note.offsetWidth + 12, ny = 16 + note.offsetHeight + 12;
        while (k > 0.05) {
          const R = Rmax * k, dx = w / 2 - nx, dy = top + R - ny;
          if (dx < 0 || dx * dx + dy * dy >= R * R) break;
          k *= 0.97;
        }
      }
      return d3.zoomIdentity.translate(w / 2, top + Rmax * k).scale(k);
    };
    svg.call(zoom.transform, fit());
    bindZoomButtons('fan', svg, zoom, fit);
  }

  function bindZoomButtons(prefix, svg, zoom, fit) {
    const animate = (sel) => (reduceMotion() ? sel : sel.transition().duration(500));
    document.querySelector(`[data-zoom="${prefix}-in"]`).onclick = () => animate(svg).call(zoom.scaleBy, 1.5);
    document.querySelector(`[data-zoom="${prefix}-out"]`).onclick = () => animate(svg).call(zoom.scaleBy, 1 / 1.5);
    document.querySelector(`[data-zoom="${prefix}-fit"]`).onclick = () => animate(svg).call(zoom.transform, fit());
  }

  // ------------------------------------------------------------ tooltip
  function showTip(e, html) {
    const tip = $('#tip');
    tip.innerHTML = html;
    tip.hidden = false;
    const m = $('main').getBoundingClientRect();
    let x = e.clientX - m.left + 14, y = e.clientY - m.top + 14;
    if (x + tip.offsetWidth > m.width - 8) x = e.clientX - m.left - tip.offsetWidth - 14;
    if (y + tip.offsetHeight > m.height - 8) y = e.clientY - m.top - tip.offsetHeight - 14;
    tip.style.left = x + 'px';
    tip.style.top = y + 'px';
  }
  const hideTip = () => { $('#tip').hidden = true; };

  // ------------------------------------------------------------ map
  function loadMap() {
    if (!S.mapPromise) S.mapPromise = fetch('data/map.json').then((r) => r.json()).then((m) => (S.map = m));
    return S.mapPromise;
  }
  const placeXY = (name) => {
    const pl = F.places[name];
    return pl && pl.lat != null ? [pl.lon, pl.lat] : null;
  };

  function placeEvents() {
    const idx = {};
    const add = (place, item) => { if (place && F.places[place]) (idx[place] ||= []).push(item); };
    for (const p of Object.values(P)) for (const e of p.events || []) add(e.place, { id: p.id, what: e.label, date: e.date });
    for (const f of Object.values(FAM)) for (const e of f.events || []) {
      const who = [f.husb, f.wife].filter(Boolean);
      add(e.place, { id: who[0], also: who[1], what: e.label, date: e.date });
    }
    return idx;
  }

  function drawBase(g, path, M) {
    g.append('g').selectAll('path').data(M.countries).join('path').attr('class', 'map-land').attr('d', path);
    g.append('path').datum(M.states).attr('class', 'map-state').attr('d', path);
    g.append('path').datum(M.borders).attr('class', 'map-border').attr('d', path);
  }

  async function buildMap() {
    const M = await loadMap();
    const svgEl = $('#map-svg');
    const svg = d3.select(svgEl);
    const w = svgEl.clientWidth, h = svgEl.clientHeight;
    const g = svg.append('g');
    const idx = placeEvents();
    const names = Object.keys(idx).filter((n) => placeXY(n));
    const proj = d3.geoConicEqualArea().parallels([33, 62]).rotate([52, 0]);
    proj.fitExtent([[40, 40], [w - 120, h - (isDesktop() ? 60 : 230)]], { type: 'MultiPoint', coordinates: names.map(placeXY) });
    const path = d3.geoPath(proj);
    drawBase(g, path, M);

    // Moves: from each parent's birthplace to the child's.
    const arcs = new Map();
    for (const c of Object.values(P)) {
      const to = c.birthPlace && placeXY(c.birthPlace);
      if (!to) continue;
      for (const pid of parentsOf(c)) {
        const p = P[pid];
        const from = p && p.birthPlace && placeXY(p.birthPlace);
        if (!from || p.birthPlace === c.birthPlace) continue;
        const key = p.birthPlace + '>' + c.birthPlace;
        const a = arcs.get(key) || { from, to, fromName: p.birthPlace, toName: c.birthPlace, direct: false, people: [] };
        a.direct = a.direct || (isDirect(c) && isDirect(p));
        a.people.push(c.id);
        arcs.set(key, a);
      }
    }
    const arcData = [...arcs.values()].sort((a, b) => a.direct - b.direct);
    const arcSel = g.append('g').selectAll('path').data(arcData).join('path')
      .attr('class', (a) => 'map-arc' + (a.direct ? ' direct' : ''))
      .attr('d', (a) => path({ type: 'LineString', coordinates: [a.from, a.to] }));
    const setAll = (on) => arcSel.attr('display', (a) => (a.direct || on ? null : 'none'));
    setAll(false);

    const pts = names.map((n) => ({ name: n, xy: proj(placeXY(n)), items: idx[n], region: F.places[n].region }))
      .sort((a, b) => b.items.length - a.items.length);
    const rOf = (d) => 3.5 + Math.sqrt(d.items.length) * 2.2;
    const ptSel = g.append('g').selectAll('circle').data(pts).join('circle')
      .attr('class', (d) => 'map-pt' + (d.region ? ' region' : ''))
      .attr('cx', (d) => d.xy[0]).attr('cy', (d) => d.xy[1]).attr('r', (d) => (d.region ? rOf(d) + 6 : rOf(d)))
      .on('mousemove', (e, d) => showTip(e, placeTip(d)))
      .on('mouseleave', hideTip)
      .on('click', (e, d) => openPlace(d.name));
    const labelSel = g.append('g').selectAll('text').data(pts).join('text').attr('class', 'map-label')
      .attr('x', (d) => d.xy[0]).attr('y', (d) => d.xy[1]).text((d) => F.places[d.name].short);

    const placeLabels = (k) => {
      const taken = [];
      labelSel.each(function (d) {
        const sx = d.xy[0] * k, sy = d.xy[1] * k;
        const ok = taken.every(([x, y]) => Math.abs(x - sx) > 90 || Math.abs(y - sy) > 18);
        if (ok) taken.push([sx, sy]);
        d3.select(this).attr('display', ok ? null : 'none').attr('dx', (rOf(d) + 4) / k).attr('dy', 4 / k).style('font-size', 12 / k + 'px').style('stroke-width', 3 / k + 'px');
      });
    };
    const zoom = d3.zoom().scaleExtent([0.6, 80]).on('zoom', (e) => {
      g.attr('transform', e.transform);
      ptSel.attr('r', (d) => (d.region ? rOf(d) + 6 : rOf(d)) / Math.sqrt(e.transform.k));
    }).on('end', (e) => placeLabels(e.transform.k));
    svg.call(zoom).on('dblclick.zoom', null);
    placeLabels(1);
    bindZoomButtons('map', svg, zoom, () => d3.zoomIdentity);

    const moves = arcData.filter((a) => a.direct).length;
    $('#map-note').innerHTML = `<h2>Where the family lived</h2>
      Gold lines trace ${esc(META.rootLabel)}’s direct line from each parent’s birthplace to the child’s (${moves} moves). Dots grow with the number of births, marriages and deaths recorded there; dashed circles are places known only to the state or country.
      <label class="toggle"><input type="checkbox" id="map-all"> Show moves for every relative</label>`;
    $('#map-all').onchange = (e) => setAll(e.target.checked);

    S.mapApi = {
      highlight(placesList) {
        ptSel.classed('hot', (d) => placesList.includes(d.name));
        const xy = placesList.map(placeXY).filter(Boolean).map((c) => proj(c));
        if (!xy.length) return;
        const [x0, x1] = d3.extent(xy, (d) => d[0]), [y0, y1] = d3.extent(xy, (d) => d[1]);
        const W2 = svgEl.clientWidth, H2 = svgEl.clientHeight;
        const panelW = !$('#panel').hidden && isDesktop() ? $('#panel').offsetWidth : 0;
        const k = Math.min(8, 0.7 * Math.min((W2 - panelW) / Math.max(x1 - x0, 1), H2 / Math.max(y1 - y0, 1)));
        const t = d3.zoomIdentity.translate((W2 - panelW) / 2, H2 / 2).scale(Math.max(1, k)).translate(-(x0 + x1) / 2, -(y0 + y1) / 2);
        (reduceMotion() ? svg : svg.transition().duration(700)).call(zoom.transform, t);
      },
    };
    if (S.pendingPlaces) { S.mapApi.highlight(S.pendingPlaces); S.pendingPlaces = null; }
  }

  function placeTip(d) {
    const list = d.items.slice(0, 6).map((it) => `${esc(it.what)}: ${esc(fullName(P[it.id]))}${it.date ? ` <span class="muted">${esc(it.date)}</span>` : ''}`).join('<br>');
    const more = d.items.length > 6 ? `<br><span class="muted">and ${d.items.length - 6} more</span>` : '';
    return `<b>${esc(d.name)}</b>${d.region ? ' <span class="muted">(approximate)</span>' : ''}<br>${list}${more}`;
  }

  function showOnMap(placesList) {
    S.pendingPlaces = placesList;
    if (S.view !== 'map') go('map');
    if (S.mapApi) { S.mapApi.highlight(placesList); S.pendingPlaces = null; }
  }

  function openPlace(name) {
    const items = placeEvents()[name] || [];
    const pl = F.places[name];
    const rows = items.sort((a, b) => String(a.date || '').localeCompare(String(b.date || '')))
      .map((it) => `<li><span class="t-date">${esc(it.date || '—')}</span><span><span class="t-what">${esc(it.what)}</span> <a class="chip${isDirect(P[it.id]) ? ' direct' : ''}" href="#person-${it.id}">${esc(fullName(P[it.id]))}</a>${it.also && P[it.also] ? ` and <a class="chip" href="#person-${it.also}">${esc(fullName(P[it.also]))}</a>` : ''}</span></li>`).join('');
    renderPanel(`<p class="eyebrow">Place</p><h2 class="p-name">${esc(name)}</h2>
      ${pl.region ? '<p class="note-muted">Shown at an approximate position: the record names only the county, state or country.</p>' : ''}
      <h3>Recorded here</h3><ol class="timeline">${rows}</ol>`);
  }

  // ------------------------------------------------------------ panel
  function renderPanel(html) {
    const panel = $('#panel');
    panel.innerHTML = `<button class="panel-close" id="panel-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>${html}`;
    panel.hidden = false;
    panel.scrollTop = 0;
    $('#panel-close').onclick = closePanel;
    panel.querySelectorAll('[data-place]').forEach((b) => (b.onclick = () => showOnMap([b.dataset.place])));
    panel.querySelectorAll('[data-photo]').forEach((b) => (b.onclick = () => openLightbox(b.dataset.photo)));
  }
  function hidePanel() {
    $('#panel').hidden = true;
    S.selected = null;
    highlightSelection();
  }
  function closePanel() {
    hidePanel();
    if (location.hash.slice(1).startsWith('person-')) location.hash = S.baseHash || 'tree';
  }

  function timelineHtml(evs) {
    return '<h3>Life</h3><ol class="timeline">' + evs.map((e) => `<li>
          <span class="t-date">${esc(e.date || '—')}</span>
          <span><span class="t-what">${esc(e.label)}${e.value ? ': ' + esc(e.value) : ''}</span>
          ${e.place ? (F.places[e.place] && F.places[e.place].lat != null ? `<button class="place-link t-place" data-place="${esc(e.place)}">${esc(e.place)}</button>` : `<span class="t-place">${esc(e.place)}</span>`) : ''}
          ${(e.notes || []).map((n) => `<span class="t-note">${esc(n)}</span>`).join('')}</span></li>`).join('') + '</ol>';
  }

  function chip(id) {
    const p = P[id];
    if (!p) return '';
    const yrs = lifespan(p, true);
    return `<a class="chip${isDirect(p) ? ' direct' : ''}${p.living ? ' living' : ''}" href="#person-${id}">${esc(fullName(p))}${yrs && yrs !== 'dates unknown' ? `<span class="yrs">${esc(yrs)}</span>` : ''}</a>`;
  }

  function openPerson(id) {
    const p = P[id];
    S.selected = id;
    const parts = [];
    const img = (p.media || []).find((m) => m.kind === 'image');
    if (img) parts.push(`<figure class="p-photo"><button class="photo-btn" data-photo="${esc(img.src)}" aria-label="Enlarge photo"><img src="${esc(img.thumb || img.src)}" alt="${esc(img.title || fullName(p))}"></button>${img.title ? `<figcaption>${esc(img.title)}</figcaption>` : ''}</figure>`);
    const rel = relText(p);
    parts.push(`${rel ? `<p class="eyebrow">${esc(rel)}</p>` : ''}<h2 class="p-name">${esc(fullName(p))}${p.nick ? ` <span class="p-nick">“${esc(p.nick)}”</span>` : ''}</h2>`);
    if (lifespan(p)) parts.push(`<p class="p-life">${esc(lifespan(p))}</p>`);

    if (p.living) {
      if ((p.events || []).length) parts.push(timelineHtml(p.events));
      parts.push(`<p class="private-note">Living. ${p.events && p.events.length ? 'Apart from birth details, other' : 'Dates, places and other'} events, photos and stories of living relatives are kept private on this site.</p>`);
    } else {
      // Life events, with marriages folded in.
      // A bare "Died" with no date, place or note says nothing the dates line does not.
      const evs = (p.events || []).filter((e) => e.date || e.place || e.value || (e.notes && e.notes.length) || !["DEAT", "BURI"].includes(e.tag)).map((e) => ({ ...e }));
      for (const f of famsOf(p)) {
        const spouse = f.husb === id ? f.wife : f.husb;
        for (const e of f.events || []) {
          if (e.tag === 'MARR') evs.push({ ...e, label: spouse && P[spouse] ? `Married ${fullName(P[spouse])}` : 'Married' });
          else evs.push(e);
        }
      }
      evs.sort((a, b) => (a.sort || 1e9) - (b.sort || 1e9));
      if (evs.length) parts.push(timelineHtml(evs));
      if (p.notes && p.notes.length) {
        parts.push('<h3>Story</h3><div class="story-text">' + p.notes.flatMap((n) => n.split(/\n{1,}/)).filter(Boolean).map((t) => `<p>${esc(t)}</p>`).join('') + '</div>');
      }
    }

    // Family
    const fam = [];
    const parents = parentsOf(p);
    if (parents.length) fam.push(['Parents', parents]);
    const spouses = famsOf(p).map((f) => (f.husb === id ? f.wife : f.husb)).filter(Boolean);
    if (spouses.length) fam.push([spouses.length > 1 ? 'Spouses' : 'Spouse', spouses]);
    const kids = [...new Set(famsOf(p).flatMap((f) => f.children))];
    if (kids.length) fam.push(['Children', kids]);
    const sibs = [...new Set((p.famc || []).map((f) => FAM[f]).filter(Boolean).flatMap((f) => f.children))].filter((c) => c !== id);
    if (sibs.length) fam.push(['Siblings', sibs]);
    if (fam.length || p.hidden) {
      parts.push('<h3>Family</h3>' + fam.map(([label, ids]) => `<div class="fam-group"><span class="fam-label">${label}</span><div class="chips">${ids.map(chip).join('')}</div></div>`).join(''));
      if (p.hidden) {
        const bits = [];
        if (p.hidden.spouses) bits.push(`${p.hidden.spouses} ${p.hidden.spouses === 1 ? 'spouse' : 'spouses'}`);
        if (p.hidden.children) bits.push(`${p.hidden.children} ${p.hidden.children === 1 ? 'child' : 'children'}`);
        parts.push(`<p class="note-muted">Also ${bits.join(' and ')} who may be living, not shown to protect their privacy.</p>`);
      }
    }

    if (!p.living) {
      const more = (p.media || []).filter((m) => m !== img);
      if (more.length) parts.push('<h3>Photos and documents</h3><div class="p-more">' + more.map((m) => (m.kind === 'image' ? `<figure class="p-photo"><button class="photo-btn" data-photo="${esc(m.src)}" aria-label="Enlarge photo"><img src="${esc(m.thumb || m.src)}" alt="${esc(m.title || fullName(p))}" loading="lazy"></button>${m.title ? `<figcaption>${esc(m.title)}</figcaption>` : ''}</figure>` : `<p><a href="${esc(m.src)}" target="_blank" rel="noopener">${esc(m.title || m.src)}</a></p>`)).join('') + '</div>');
      const srcs = [...(p.sources || []), ...(p.events || []).flatMap((e) => e.sources || [])];
      if (srcs.length) parts.push('<h3>Sources</h3><ul class="sources">' + srcs.map((s) => `<li>${s.url ? `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.title)}</a>` : esc(s.title)}${s.page ? ', ' + esc(s.page) : ''}${s.text ? `<br><span class="note-muted">${esc(s.text)}</span>` : ''}</li>`).join('') + '</ul>');
      const inStories = F.stories.filter((s) => s.people.includes(id));
      if (inStories.length) parts.push('<h3>In the stories</h3><div class="chips">' + inStories.map((s) => `<a class="chip" href="#story-${s.slug}">${esc(s.title)}</a>`).join('') + '</div>');
    }

    const myPlaces = [...new Set((p.events || []).map((e) => e.place).filter((n) => n && F.places[n] && F.places[n].lat != null))];
    parts.push(`<div class="panel-actions">
      <button class="btn" id="act-tree">Show in tree</button>
      ${myPlaces.length ? '<button class="btn" id="act-map">Show on map</button>' : ''}
      <button class="btn" id="act-link">Copy link</button></div>`);
    if (META.contactNote && !p.living) parts.push(`<p class="note-muted" style="margin-top:16px">Know more about ${esc(firstName(p))}? ${esc(META.contactNote)}</p>`);

    renderPanel(parts.join(''));
    $('#act-tree').onclick = () => {
      if (S.view !== 'tree') { showView('tree'); }
      S.focusTree && S.focusTree(id);
    };
    if ($('#act-map')) $('#act-map').onclick = () => showOnMap(myPlaces);
    $('#act-link').onclick = async (e) => {
      const url = location.href.split('#')[0] + '#person-' + id;
      try {
        await navigator.clipboard.writeText(url);
        e.target.textContent = 'Link copied';
      } catch (err) {
        e.target.outerHTML = `<input class="btn" value="${esc(url)}" readonly onclick="this.select()" style="font-weight:400;width:100%">`;
      }
    };
    highlightSelection();
    if (S.view === 'tree' && S.focusTree) S.focusTree(id);
  }

  function highlightSelection() {
    const id = S.selected;
    if (S.cards) S.cards.classed('selected', (p) => p.id === id);
    if (S.fanWedges) S.fanWedges.classed('selected', (s) => s.id && s.id === id);
  }

  // ------------------------------------------------------------ stories
  function renderStoryList() {
    S.story = null;
    const el = $('#view-stories');
    el.innerHTML = `<div class="page-inner">
      <h1>Stories and connections</h1>
      <p class="lede">How the family’s branches crossed oceans and mountains to meet. Each story links to the people in it; click a name to open their page.</p>
      <div class="story-grid">${F.stories.map((s) => `
        <a class="story-card" href="#story-${s.slug}">
          <svg data-route="${s.slug}" aria-hidden="true"></svg>
          <div class="sc-body">${s.era ? `<span class="sc-era">${esc(s.era)}</span>` : ''}<h2>${esc(s.title)}</h2><p>${esc(s.summary)}</p></div>
        </a>`).join('')}</div>
      ${aboutBlock()}
    </div>`;
    el.scrollTop = 0;
    loadMap().then(() => el.querySelectorAll('svg[data-route]').forEach((svgEl) => {
      const s = F.stories.find((x) => x.slug === svgEl.dataset.route);
      drawRoute(svgEl, s.route, false);
    }));
  }

  function openStory(slug) {
    const s = F.stories.find((x) => x.slug === slug);
    if (!s) return renderStoryList();
    if (S.story === slug) return;
    S.story = slug;
    const el = $('#view-stories');
    el.innerHTML = `<div class="page-inner">
      <a class="back" href="#stories">← All stories</a>
      <div class="reader">
        <article>
          ${s.era ? `<p class="eyebrow">${esc(s.era)}</p>` : ''}
          <h1>${esc(s.title)}</h1>
          <p class="lede">${esc(s.summary)}</p>
          <div class="prose">${s.html}</div>
          ${s.people.length ? `<div class="story-people"><h3 class="eyebrow" style="color:var(--ink-2)">People in this story</h3><div class="chips">${s.people.map(chip).join('')}</div></div>` : ''}
        </article>
        ${s.route.length ? `<aside class="reader-map"><svg id="story-map" aria-label="Map of this story's route"></svg>
          <ol>${s.route.map((r, i) => `<li><span class="n">${i + 1}</span><span class="y">${esc(r.year || '')}</span><span>${esc(r.label || r.place)}${r.label ? `<br><span class="note-muted">${esc(r.place)}</span>` : ''}</span></li>`).join('')}</ol></aside>` : ''}
      </div>
    </div>`;
    el.scrollTop = 0;
    if (s.route.length) loadMap().then(() => drawRoute($('#story-map'), s.route, true));
  }

  function drawRoute(svgEl, route, numbered) {
    const M = S.map;
    const svg = d3.select(svgEl);
    svg.selectAll('*').remove();
    const w = svgEl.clientWidth || 300, h = svgEl.clientHeight || 150;
    const coords = route.map((r) => placeXY(r.place)).filter(Boolean);
    if (!coords.length) return;
    const lonSpan = d3.extent(coords, (c) => c[0]);
    const proj = d3.geoConicEqualArea().parallels([33, 62]).rotate([-(lonSpan[0] + lonSpan[1]) / 2, 0]);
    const pad = numbered ? 34 : 22;
    let fitTo = { type: 'MultiPoint', coordinates: coords };
    const [[x0, y0], [x1, y1]] = d3.geoBounds(fitTo);
    if (Math.abs(x1 - x0) < 6 && Math.abs(y1 - y0) < 4) {
      const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
      fitTo = { type: 'MultiPoint', coordinates: [[cx - 4, cy - 2.5], [cx + 4, cy + 2.5]] };
    }
    proj.fitExtent([[pad, pad], [w - pad, h - pad]], fitTo);
    const path = d3.geoPath(proj);
    const g = svg.append('g');
    drawBase(g, path, M);
    g.append('path').datum({ type: 'LineString', coordinates: coords }).attr('class', 'map-arc direct').attr('d', path);
    const stops = g.append('g').selectAll('g').data(route.filter((r) => placeXY(r.place))).join('g')
      .attr('transform', (r) => `translate(${proj(placeXY(r.place))})`);
    if (numbered) {
      stops.append('circle').attr('class', 'map-stop').attr('r', 10);
      stops.append('text').attr('class', 'map-stop-n').text((r) => route.indexOf(r) + 1);
    } else stops.append('circle').attr('class', 'map-stop').attr('r', 4.5);
  }

  function aboutBlock() {
    return `<div class="about"><p>${esc(META.sourcesNote)}</p>
      <p>${esc(privacyText())} Last updated ${esc(META.built)}.</p></div>`;
  }

  function privacyText() {
    const pv = META.privacy || {};
    if (pv.living === 'hidden') return 'People who may still be living are shown only as “Living”, with no details.';
    const what = pv.livingDetails === 'birth' ? 'their names and birth details' : 'their names';
    return `For people who may still be living, the site shows only ${what}; other events, photos and stories are kept private.`;
  }

  // ------------------------------------------------------------ photos
  function buildPhotos() {
    const el = $('#view-photos');
    const G = F.gallery || [];
    el.innerHTML = `<div class="page-inner">
      <h1>Photographs</h1>
      <p class="lede">${G.length} ${G.length === 1 ? 'photograph' : 'photographs'} from the family papers, oldest generation first. Click one to see it larger and meet the people in it.</p>
      <div class="gallery">${G.map((g) => `
        <figure class="g-item">
          <button class="photo-btn" data-photo="${esc(g.src)}" aria-label="Enlarge: ${esc(g.title || g.people.map((id) => fullName(P[id])).join(', '))}">
            <img src="${esc(g.thumb || g.src)}" alt="${esc(g.title || '')}" loading="lazy">
          </button>
          <figcaption><span class="g-who">${g.people.map((id) => esc(fullName(P[id]))).join(', ')}</span>${g.title ? `<span class="g-title">${esc(g.title)}</span>` : ''}</figcaption>
        </figure>`).join('')}</div>
      <p class="about">Have old photographs of anyone in the tree? They can be added to the family archive and will appear here and on each person’s page.</p>
    </div>`;
    el.querySelectorAll('[data-photo]').forEach((b) => (b.onclick = () => openLightbox(b.dataset.photo)));
  }

  function openLightbox(src) {
    const G = F.gallery || [];
    let i = Math.max(0, G.findIndex((g) => g.src === src));
    const box = $('#lightbox');
    const render = () => {
      const g = G[i] || { src, people: [] };
      box.innerHTML = `<div class="lb-inner" role="dialog" aria-modal="true" aria-label="Photograph">
        <button class="panel-close lb-close" aria-label="Close"><svg viewBox="0 0 24 24"><path d="M6 6l12 12M18 6 6 18"/></svg></button>
        <img src="${esc(g.src)}" alt="${esc(g.title || '')}">
        <div class="lb-cap">${g.title ? `<p>${esc(g.title)}</p>` : ''}<div class="chips">${g.people.map(chip).join('')}</div>
        ${G.length > 1 ? `<div class="lb-nav"><button class="btn" data-step="-1">← Previous</button><span>${i + 1} of ${G.length}</span><button class="btn" data-step="1">Next →</button></div>` : ''}</div>
      </div>`;
      box.querySelector('.lb-close').onclick = close;
      box.querySelectorAll('[data-step]').forEach((b) => (b.onclick = () => { i = (i + Number(b.dataset.step) + G.length) % G.length; render(); }));
      box.querySelectorAll('.chip').forEach((c) => c.addEventListener('click', close));
    };
    const close = () => { box.hidden = true; document.removeEventListener('keydown', onKey); };
    const onKey = (e) => {
      if (e.key === 'Escape') close();
      if (e.key === 'ArrowRight' && G.length > 1) { i = (i + 1) % G.length; render(); }
      if (e.key === 'ArrowLeft' && G.length > 1) { i = (i - 1 + G.length) % G.length; render(); }
    };
    box.onclick = (e) => { if (e.target === box) close(); };
    document.addEventListener('keydown', onKey);
    render();
    box.hidden = false;
  }

  // ------------------------------------------------------------ people index
  function buildPeople() {
    const el = $('#view-people');
    el.innerHTML = `<div class="page-inner">
      <h1>Everyone in the tree</h1>
      <p class="lede">${META.counts.people} people, grouped by surname. A gold dot marks ${esc(META.rootLabel)}’s direct ancestors.</p>
      <div class="people-tools"><input id="people-filter" type="search" placeholder="Filter by name or place" aria-label="Filter people"><span class="count" id="people-count"></span></div>
      <div id="people-list"></div>
      ${aboutBlock()}
    </div>`;
    const render = (q) => {
      const terms = norm(q).split(/\s+/).filter(Boolean);
      const list = Object.values(P).filter((p) => {
        if (!terms.length) return true;
        const hay = norm([fullName(p), p.nick, p.birthPlace, ...(p.events || []).map((e) => e.place)].join(' '));
        return terms.every((t) => hay.includes(t));
      });
      const groups = d3.groups(list, (p) => (p.living ? 'Living relatives' : p.surname || 'Surname unknown'))
        .sort((a, b) => (a[0] === 'Living relatives') - (b[0] === 'Living relatives') || a[0].localeCompare(b[0]));
      $('#people-count').textContent = `${list.length} ${list.length === 1 ? 'person' : 'people'}`;
      $('#people-list').innerHTML = `<div class="people-cols">${groups.map(([sur, ps]) => `
        <div class="surname-group"><h2>${esc(sur)}</h2>
        ${ps.sort((a, b) => (a.born || a.estBorn || 3000) - (b.born || b.estBorn || 3000)).map((p) => `
          <a class="person-row${isDirect(p) ? ' direct' : ''}" href="#person-${p.id}">
            <span class="nm">${esc(fullName(p))}</span><span class="yrs">${esc(lifespan(p, true))}</span>
            ${relText(p) ? `<span class="rl">${esc(relText(p))}</span>` : ''}
          </a>`).join('')}
        </div>`).join('')}</div>`;
    };
    $('#people-filter').addEventListener('input', (e) => render(e.target.value));
    render('');
  }

  // ------------------------------------------------------------ search
  function setupSearch() {
    const input = $('#search'), box = $('#results');
    let hits = [], active = 0;
    const draw = () => {
      if (!input.value.trim()) { box.hidden = true; return; }
      box.innerHTML = hits.length
        ? hits.map((p, i) => `<li role="option" data-id="${p.id}" aria-selected="${i === active}"><span>${esc(fullName(p))}</span><span class="yrs">${esc(lifespan(p, true))}</span></li>`).join('')
        : '<li class="empty">No one by that name yet</li>';
      box.hidden = false;
    };
    input.addEventListener('input', () => {
      const terms = norm(input.value).split(/\s+/).filter(Boolean);
      hits = Object.values(P)
        .filter((p) => terms.length && terms.every((t) => norm(fullName(p) + ' ' + (p.nick || '')).includes(t)))
        .sort((a, b) => isDirect(b) - isDirect(a) || (a.born || 3000) - (b.born || 3000))
        .slice(0, 8);
      active = 0;
      draw();
    });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown') { active = Math.min(active + 1, hits.length - 1); draw(); e.preventDefault(); }
      else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); draw(); e.preventDefault(); }
      else if (e.key === 'Enter' && hits[active]) pick(hits[active].id);
      else if (e.key === 'Escape') { input.value = ''; box.hidden = true; }
    });
    box.addEventListener('mousedown', (e) => {
      const li = e.target.closest('li[data-id]');
      if (li) { e.preventDefault(); pick(li.dataset.id); }
    });
    input.addEventListener('blur', () => setTimeout(() => (box.hidden = true), 120));
    const pick = (id) => {
      input.value = '';
      box.hidden = true;
      input.blur();
      if (S.view !== 'tree' && S.view !== 'fan') showView('tree');
      go('person-' + id);
    };
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})();
