/* TiVA GVC 대시보드 / TiVA GVC dashboard (정적 페이지, ECharts + d3-geo 투영) */
'use strict';
(() => {
  const DATA = 'data/';
  const S = { meta: null, countries: null, cache: new Map(), charts: [], observers: [], state: {}, token: 0, view: null };

  // ------------------------------------------------------------------ language
  // 언어 결정 순서 = 주소의 ?lang= → 이전에 고른 언어 → 브라우저 첫 번째 언어 (한국어면 ko, 그 밖에는 en)
  let LANG = (() => {
    const q = new URLSearchParams(location.search).get('lang');
    if (q === 'en' || q === 'ko') return q;
    try { const saved = localStorage.getItem('tiva-lang'); if (saved === 'en' || saved === 'ko') return saved; } catch (e) { /* 저장소 사용 불가 */ }
    const first = ((navigator.languages && navigator.languages[0]) || navigator.language || '').toLowerCase();
    return first.startsWith('ko') ? 'ko' : 'en';
  })();
  const tr = (ko, en) => (LANG === 'en' ? en : ko);

  // ------------------------------------------------------------------ utils
  function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs || {})) {
      if (v == null || v === false) continue;
      if (k === 'class') e.className = v;
      else if (k === 'text') e.textContent = v;
      else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
      else e.setAttribute(k, v === true ? '' : v);
    }
    for (const c of children.flat()) {
      if (c == null || c === false) continue;
      e.append(c instanceof Node ? c : document.createTextNode(String(c)));
    }
    return e;
  }
  const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const ok = v => v != null && Number.isFinite(v);
  const sum = arr => arr.reduce((a, b) => a + (ok(b) ? b : 0), 0);

  function getJSON(path) {
    if (!S.cache.has(path)) {
      const p = fetch(path.startsWith('assets/') ? path : DATA + path, { cache: 'no-cache' }).then(r => {
        if (!r.ok) throw new Error(`${path} (${r.status})`);
        return r.json();
      });
      p.catch(() => S.cache.delete(path));
      S.cache.set(path, p);
    }
    return S.cache.get(path);
  }
  const tryJSON = path => getJSON(path).catch(() => null);

  // ------------------------------------------------------------------ formats
  const NF = {};
  const loc = () => (LANG === 'en' ? 'en-GB' : 'ko-KR');
  const nf = d => NF[loc() + d] || (NF[loc() + d] = new Intl.NumberFormat(loc(), { minimumFractionDigits: d, maximumFractionDigits: d }));
  const DASH = '-';
  const fmtPct = v => ok(v) ? nf(1).format(v) + '%' : DASH;
  const fmtPp = v => ok(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + nf(1).format(Math.abs(v)) + tr('%p', ' pp') : DASH;
  const moneyDiv = () => (LANG === 'en' ? 1000 : 100);              // 백만 달러 -> 억 달러 / USD bn
  const moneyUnit = () => tr('억 달러', 'USD bn');
  const fmtMoneyNum = v => ok(v) ? nf(LANG === 'en' ? 1 : 0).format(v / moneyDiv()) : DASH;
  const fmtMoneyScaled = v => ok(v) ? (LANG === 'en' ? `USD ${nf(1).format(v)} bn` : `${nf(0).format(v)}억 달러`) : DASH;
  const fmtUsd = v => ok(v) ? fmtMoneyScaled(v / moneyDiv()) : DASH;
  const fmtRca = v => ok(v) ? nf(2).format(v) : DASH;
  const fmtNum = v => ok(v) ? nf(0).format(v) : DASH;
  const axisFmt = v => (Math.abs(v) >= 1000 ? nf(0).format(v) : String(+Number(v).toFixed(4)));
  const yl = y => tr(`${y}년`, String(y));
  const cagr = (a, b, n) => ok(a) && ok(b) && a > 0 && b > 0 && n > 0 ? (Math.pow(b / a, 1 / n) - 1) * 100 : null;

  const AL = c => ((LANG === 'en' ? S.meta.labels.area_en : S.meta.labels.area) || {})[c] || c;
  const IL = c => ((LANG === 'en' ? S.meta.labels.activity_en : S.meta.labels.activity) || {})[c] || c;
  const FL = f => tr(f.label, f.label_en || f.label);
  const FN = f => tr(f.note, f.note_en || f.note);
  const RL = r => tr(r.label, r.label_en || r.label);
  const RN = r => (r.note ? tr(r.note, r.note_en || r.note) : '');
  const SGL = (r, name) => (LANG === 'en' ? ((r.subgroup_labels_en || {})[name] || name) : name);

  function M(k) {
    const d = {
      back: [tr('후방 참여율', 'Backward participation'), '%', fmtPct, tr('총수출 중 해외부가가치 비중', 'foreign value added share of gross exports')],
      fwd: [tr('전방 참여율', 'Forward participation'), '%', fmtPct, tr('제3국 수출에 체화된 자국 부가가치, 총수출 대비', 'domestic value added in third-country exports, share of gross exports')],
      gvc: [tr('GVC 참여율', 'GVC participation'), '%', fmtPct, tr('후방 참여율 + 전방 참여율', 'backward plus forward participation')],
      dva_sh: [tr('국내부가가치 비중', 'Domestic value added share'), '%', fmtPct, tr('총수출 중 국내부가가치 비중', 'domestic value added share of gross exports')],
      int_sh: [tr('중간재 수출 비중', 'Intermediates share'), '%', fmtPct, tr('총수출 중 중간재 비중', 'intermediate goods and services share of gross exports')],
      EXGR: [tr('총수출', 'Gross exports'), moneyUnit(), fmtUsd, null, true],
      EXGR_DVA: [tr('수출 국내부가가치', 'Domestic value added in exports'), moneyUnit(), fmtUsd, null, true],
      VALU: [tr('부가가치', 'Value added'), moneyUnit(), fmtUsd, null, true],
      ms: [tr('세계 수출 점유율', 'World export share'), '%', fmtPct, tr('개별 경제 합계 대비', 'share of the sum of all economies')],
      rca: [tr('부가가치 기준 RCA', 'Value-added RCA'), '', fmtRca, tr('1보다 크면 상대적 특화', 'values above 1 indicate relative specialisation')],
    }[k];
    return { key: k, label: d[0], unit: d[1], fmt: d[2], desc: d[3], money: !!d[4] };
  }

  // ------------------------------------------------------------------ theme tokens
  function tokens() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    return {
      surface: v('--surface'), surface2: v('--surface-2'), text: v('--text-primary'), text2: v('--text-secondary'), muted: v('--axis-muted'),
      grid: v('--grid'), base: v('--baseline'), deemph: v('--deemph'), accent: v('--accent'), border: v('--border'),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map(i => v('--s' + i)), seq: [0, 1, 2, 3, 4].map(i => v('--seq-' + i)),
      div: ['--div-n2', '--div-n1', '--div-mid', '--div-p1', '--div-p2'].map(v), flow: v('--flow'), font: v('--font'),
    };
  }

  // ------------------------------------------------------------------ data access
  function yIndex(year) { return S.countries.years.indexOf(year); }
  async function seriesOf(area, act, metric) {
    if (S.countries.acts.includes(act) && S.countries.data[area]) {
      const d = S.countries.data[area][act];
      if (d && d[metric]) return d[metric];
    }
    const p = await tryJSON(`profile/${area}.json`);
    return (p && p.data[act] && p.data[act][metric]) || S.countries.years.map(() => null);
  }
  function valAt(arr, year) { const i = yIndex(year); return i >= 0 && arr ? arr[i] : null; }
  function partnerYearFor(year, years) {
    const c = (years || []).filter(y => y <= year);
    return c.length ? c[c.length - 1] : (years || [])[years.length - 1];
  }
  function baseYear(year) { return S.countries.years.includes(year - 10) ? year - 10 : S.countries.years[0]; }

  // ------------------------------------------------------------------ charts
  function disposeAll() {
    S.observers.forEach(o => o.disconnect());
    S.charts.forEach(c => c.dispose());
    S.observers = []; S.charts = [];
  }
  function mount(node) {
    const c = echarts.init(node, null, { renderer: 'canvas' });
    S.charts.push(c);
    const ro = new ResizeObserver(() => { if (c.__relayout) c.__relayout(); c.resize(); });
    ro.observe(node);
    S.observers.push(ro);
    return c;
  }
  function tooltipBase(t) {
    return {
      backgroundColor: t.surface, borderColor: t.base, borderWidth: 1, padding: [8, 10],
      textStyle: { color: t.text, fontSize: 12, fontFamily: t.font },
      extraCssText: 'box-shadow:0 4px 16px rgba(0,0,0,.12);border-radius:8px;',
      confine: true,
    };
  }
  const keyLine = c => `<span style="display:inline-block;width:12px;height:2px;border-radius:1px;background:${c};vertical-align:middle;margin-right:6px"></span>`;
  const keyBox = c => `<span style="display:inline-block;width:9px;height:9px;border-radius:2px;background:${c};vertical-align:middle;margin-right:6px"></span>`;
  function tipRow(color, value, name, t, line = true) {
    return `<div style="line-height:1.6">${line ? keyLine(color) : keyBox(color)}<b>${esc(value)}</b> <span style="color:${t.text2}">${esc(name)}</span></div>`;
  }
  function axisCommon(t) {
    return {
      axisLine: { show: true, lineStyle: { color: t.base, width: 1 } },
      axisTick: { show: false },
      axisLabel: { color: t.muted, fontSize: 11, fontFamily: t.font },
      splitLine: { show: true, lineStyle: { color: t.grid, width: 1, type: 'solid' } },
      nameTextStyle: { color: t.muted, fontSize: 11, fontFamily: t.font },
    };
  }
  function legend(t, show = true) {
    return { show, top: 0, left: 0, icon: 'roundRect', itemWidth: 14, itemHeight: 3, itemGap: 14,
      textStyle: { color: t.text2, fontSize: 12, fontFamily: t.font } };
  }
  // 범례가 여러 줄로 접힐 때 플롯 위 여백을 늘린다
  function legendTop(node, names, show) {
    if (!show) return 24;
    const w = Math.max(200, node.clientWidth || 600);
    let rows = 1, x = 0;
    names.forEach(n => {
      const iw = 14 + 6 + String(n).length * (LANG === 'en' ? 7 : 12) + 14;
      if (x + iw > w && x > 0) { rows += 1; x = 0; }
      x += iw;
    });
    return 14 + rows * 22;
  }

  function lineChart(node, { years, series, fmt = fmtPct, yName = '', endLabels = null, yMin }) {
    const t = tokens();
    const c = mount(node);
    const showEnd = endLabels ?? series.length <= 4;
    const anyEnd = showEnd || series.some(s => s.endLabel);
    c.setOption({
      animationDuration: 300,
      textStyle: { fontFamily: t.font },
      legend: legend(t, series.length >= 2),
      grid: { left: 4, right: anyEnd ? 96 : 18, top: legendTop(node, series.map(x => x.name), series.length >= 2) + 8, bottom: 4, containLabel: true },
      tooltip: {
        ...tooltipBase(t), trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: t.base, width: 1 } },
        formatter: ps => {
          const rows = ps.filter(p => ok(p.value)).sort((a, b) => b.value - a.value)
            .map(p => tipRow(p.color, fmt(p.value), p.seriesName, t));
          return `<div style="color:${t.text2};margin-bottom:2px">${esc(yl(ps[0].axisValueLabel))}</div>${rows.join('') || tr('자료 없음', 'No data')}`;
        },
      },
      xAxis: { type: 'category', data: years.map(String), boundaryGap: false, ...axisCommon(t), splitLine: { show: false } },
      yAxis: { type: 'value', name: yName, scale: yMin == null, min: yMin, ...axisCommon(t),
        axisLabel: { ...axisCommon(t).axisLabel, formatter: axisFmt }, axisLine: { show: false } },
      series: series.map(s => ({
        type: 'line', name: s.name, data: s.data.map(v => ok(v) ? v : null), connectNulls: false,
        symbol: 'circle', symbolSize: 8, showSymbol: false,
        lineStyle: { width: s.width || 2, color: s.color, cap: 'round', join: 'round' },
        itemStyle: { color: s.color, borderColor: t.surface, borderWidth: 2 },
        emphasis: { focus: 'series', lineStyle: { width: 2.5 } },
        endLabel: showEnd || s.endLabel ? { show: true, formatter: p => s.short || p.seriesName, color: t.text2, fontSize: 11, distance: 6 } : { show: false },
        labelLayout: { hideOverlap: true },
        z: s.z || 2,
      })),
    });
    return c;
  }

  function hbarChart(node, { cats, series, fmt = fmtPct, stacked = false, highlight = null, refLine = null, xName = '', labelAll = false }) {
    const t = tokens();
    const c = mount(node);
    const last = series.length - 1;
    c.setOption({
      animationDuration: 300,
      textStyle: { fontFamily: t.font },
      legend: legend(t, series.length >= 2 && !series[0].noLegend),
      grid: { left: 4, right: 60, top: series.length >= 2 && !series[0].noLegend ? legendTop(node, series.map(x => x.name), true) : 10, bottom: 4, containLabel: true },
      tooltip: {
        ...tooltipBase(t), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,0.08)' } },
        formatter: ps => {
          const rows = ps.filter(p => ok(p.value)).map(p => tipRow(p.color, fmt(p.value), p.seriesName, t, false));
          const extra = ps[0] && ps[0].data && ps[0].data.extra ? `<div style="color:${t.text2}">${esc(ps[0].data.extra)}</div>` : '';
          return `<div style="color:${t.text2};margin-bottom:2px">${esc(ps[0].axisValueLabel)}</div>${rows.join('')}${extra}`;
        },
      },
      yAxis: {
        type: 'category', data: cats.map(x => x.label), inverse: true, ...axisCommon(t), splitLine: { show: false },
        axisLabel: {
          ...axisCommon(t).axisLabel, color: t.text2, fontSize: 12,
          formatter: (v, i) => (highlight && cats[i] && highlight(cats[i].code) ? `{b|${v}}` : v),
          rich: { b: { fontWeight: 700, color: t.text, fontSize: 12 } },
        },
      },
      xAxis: { type: 'value', name: xName, nameLocation: 'end', ...axisCommon(t), axisLine: { show: false },
        axisLabel: { ...axisCommon(t).axisLabel, formatter: axisFmt } },
      series: series.map((s, i) => ({
        type: 'bar', name: s.name, stack: stacked ? 'total' : undefined, barMaxWidth: 18, barCategoryGap: '30%',
        data: s.data.map((v, j) => ({
          value: ok(v) ? v : null, extra: s.extra ? s.extra[j] : undefined,
          itemStyle: s.colors ? { color: s.colors[j] } : undefined,
        })),
        itemStyle: {
          color: s.color, borderColor: t.surface, borderWidth: stacked ? 1 : 0,
          borderRadius: !stacked || labelAll || i === last ? [0, 4, 4, 0] : 0,
        },
        label: labelAll ? { show: true, position: 'right', color: t.text2, fontSize: 11, formatter: p => fmt(p.value) } : stacked ? (i === last ? {
          show: true, position: 'right', color: t.text2, fontSize: 11,
          formatter: p => fmt(sum(series.map(ss => ss.data[p.dataIndex]))),
        } : { show: false }) : series.length === 1 ? {
          show: s.valueLabels !== false, position: 'right', color: t.text2, fontSize: 11,
          formatter: p => fmt(p.value),
        } : { show: false },
        markLine: refLine != null && i === 0 ? {
          silent: true, symbol: 'none', lineStyle: { color: t.muted, width: 1, type: 'solid' },
          label: { formatter: String(refLine), color: t.muted, fontSize: 10 }, data: [{ xAxis: refLine }],
        } : undefined,
      })),
    });
    return c;
  }

  function columnChart(node, { cats, series, fmt = fmtPct, stacked = true, yName = '' }) {
    const t = tokens();
    const c = mount(node);
    const last = series.length - 1;
    c.setOption({
      animationDuration: 300,
      textStyle: { fontFamily: t.font },
      legend: { ...legend(t, series.length >= 2), type: 'scroll' },
      grid: { left: 4, right: 12, top: 40, bottom: 4, containLabel: true },
      tooltip: {
        ...tooltipBase(t), trigger: 'axis', axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(127,127,127,0.08)' } },
        formatter: ps => {
          const rows = ps.filter(p => ok(p.value) && p.value > 0).sort((a, b) => b.value - a.value)
            .map(p => tipRow(p.color, fmt(p.value), p.seriesName, t, false));
          const total = sum(ps.map(p => p.value));
          return `<div style="color:${t.text2};margin-bottom:2px">${esc(yl(ps[0].axisValueLabel))} · ${tr('합계', 'total')} ${esc(fmt(total))}</div>${rows.join('')}`;
        },
      },
      xAxis: { type: 'category', data: cats, ...axisCommon(t), splitLine: { show: false } },
      yAxis: { type: 'value', name: yName, ...axisCommon(t), axisLine: { show: false },
        axisLabel: { ...axisCommon(t).axisLabel, formatter: axisFmt } },
      series: series.map((s, i) => ({
        type: 'bar', name: s.name, stack: stacked ? 'total' : undefined, barMaxWidth: 24,
        data: s.data.map(v => ok(v) ? v : null),
        itemStyle: { color: s.color, borderColor: t.surface, borderWidth: stacked ? 1 : 0,
          borderRadius: !stacked || i === last ? [4, 4, 0, 0] : 0 },
      })),
    });
    return c;
  }

  function scatterChart(node, { points, xName, yName, fmtX = fmtPct, fmtY = fmtPct, highlight }) {
    const t = tokens();
    const c = mount(node);
    const hi = points.filter(p => highlight && highlight(p.code));
    const rest = points.filter(p => !(highlight && highlight(p.code)));
    const mk = (arr, color, label) => ({
      type: 'scatter', name: label, symbolSize: 10,
      data: arr.map(p => ({ value: [p.x, p.y], name: p.label, code: p.code })),
      itemStyle: { color, borderColor: t.surface, borderWidth: 2 },
      label: { show: true, position: 'right', formatter: p => p.name, color: t.text2, fontSize: 11 },
      labelLayout: { hideOverlap: true },
      emphasis: { scale: 1.3 },
      z: color === t.accent ? 5 : 2,
    });
    c.setOption({
      animationDuration: 300,
      textStyle: { fontFamily: t.font },
      legend: legend(t, hi.length > 0 && rest.length > 0),
      grid: { left: 24, right: 40, top: 40, bottom: 28, containLabel: true },
      tooltip: {
        ...tooltipBase(t), trigger: 'item',
        formatter: p => `<div style="font-weight:600;margin-bottom:2px">${esc(p.name)}</div>` +
          `<div>${esc(xName)} <b>${esc(fmtX(p.value[0]))}</b></div><div>${esc(yName)} <b>${esc(fmtY(p.value[1]))}</b></div>`,
      },
      xAxis: { type: 'value', name: xName, nameLocation: 'middle', nameGap: 26, scale: true, ...axisCommon(t),
        axisLabel: { ...axisCommon(t).axisLabel, formatter: axisFmt } },
      yAxis: { type: 'value', name: yName, nameLocation: 'middle', nameGap: 34, nameRotate: 90, scale: true, ...axisCommon(t), axisLine: { show: false },
        axisLabel: { ...axisCommon(t).axisLabel, formatter: axisFmt } },
      series: [mk(rest, t.deemph, tr('그 외', 'Others')), mk(hi, t.accent, hi.length === 1 ? hi[0].label : tr('강조', 'Highlighted'))],
    });
    return c;
  }

  function heatmapChart(node, { rows, cols, matrix, fmt = fmtPct }) {
    const t = tokens();
    const c = mount(node);
    let max = 0;
    matrix.forEach(r => r.forEach(v => { if (ok(v)) max = Math.max(max, v); }));
    const darkUI = t.seq[4].toLowerCase() === '#cde2fb';
    const data = [];
    matrix.forEach((r, i) => r.forEach((v, j) => {
      if (!ok(v)) return;
      const strong = max > 0 && v / max > 0.55;
      const color = darkUI ? (strong ? '#0b0b0b' : '#ffffff') : (strong ? '#ffffff' : '#0b0b0b');
      data.push({ value: [j, i, v], label: { color } });
    }));
    c.setOption({
      animationDuration: 300,
      textStyle: { fontFamily: t.font },
      grid: { left: 4, right: 12, top: 8, bottom: 56, containLabel: true },
      tooltip: { ...tooltipBase(t), trigger: 'item',
        formatter: p => `<div style="color:${t.text2}">${esc(tr(`${rows[p.value[1]].label} 수출에 들어간 ${cols[p.value[0]].label} 부가가치`, `${cols[p.value[0]].label} value added in exports of ${rows[p.value[1]].label}`))}</div><b>${esc(fmt(p.value[2]))}</b> <span style="color:${t.text2}">${esc(tr('총수출 대비', 'of gross exports'))}</span>` },
      xAxis: { type: 'category', data: cols.map(x => x.label), ...axisCommon(t), splitLine: { show: false }, axisLine: { show: false },
        axisLabel: { ...axisCommon(t).axisLabel, color: t.text2, interval: 0, rotate: 30 } },
      yAxis: { type: 'category', data: rows.map(x => x.label), inverse: true, ...axisCommon(t), splitLine: { show: false }, axisLine: { show: false },
        axisLabel: { ...axisCommon(t).axisLabel, color: t.text2, fontSize: 12 } },
      visualMap: { min: 0, max: max || 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 160, itemWidth: 10,
        inRange: { color: t.seq }, text: [fmt(max), '0'], textStyle: { color: t.muted, fontSize: 11 } },
      series: [{ type: 'heatmap', data, itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
        label: { show: true, fontSize: 10, formatter: p => nf(1).format(p.value[2]) },
        emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1 } } }],
    });
    return c;
  }

  // ------------------------------------------------------------------ maps
  const GEO = { loaded: null, world: null, cent: null, registered: new Set(), names: new Set() };
  const REGION_BOX = { R_EU: [-12, 33.5, 36, 71], R_MIDEAST: [22, 11, 62, 43], R_SOUTHAM: [-92, -56, -32, 14], R_ASIA: [58, -11, 148, 53] };
  function loadGeo() {
    if (!GEO.loaded) {
      GEO.loaded = Promise.all([getJSON('assets/geo/world-110m.json'), getJSON('assets/geo/centroids.json')]).then(([w, c]) => {
        GEO.world = w; GEO.cent = c;
        w.features.forEach(f => GEO.names.add(f.properties.iso3));
      });
      GEO.loaded.catch(() => { GEO.loaded = null; });
    }
    return GEO.loaded;
  }
  function inBox(code, box) {
    const c = GEO.cent[code];
    return c && c[0] >= box[0] && c[0] <= box[2] && c[1] >= box[1] && c[1] <= box[3];
  }
  // 직사각형으로 다각형 고리를 자른다 (Sutherland-Hodgman). 지역 지도를 해당 범위로 확대하기 위해 쓴다
  function clipRing(ring, [x0, y0, x1, y1]) {
    const edges = [
      [p => p[0] >= x0, (a, b) => [x0, a[1] + (b[1] - a[1]) * (x0 - a[0]) / (b[0] - a[0])]],
      [p => p[0] <= x1, (a, b) => [x1, a[1] + (b[1] - a[1]) * (x1 - a[0]) / (b[0] - a[0])]],
      [p => p[1] >= y0, (a, b) => [a[0] + (b[0] - a[0]) * (y0 - a[1]) / (b[1] - a[1]), y0]],
      [p => p[1] <= y1, (a, b) => [a[0] + (b[0] - a[0]) * (y1 - a[1]) / (b[1] - a[1]), y1]],
    ];
    let out = ring;
    for (const [inside, cut] of edges) {
      const inp = out;
      out = [];
      if (!inp.length) break;
      let prev = inp[inp.length - 1];
      for (const cur of inp) {
        if (inside(cur)) {
          if (!inside(prev)) out.push(cut(prev, cur));
          out.push(cur);
        } else if (inside(prev)) out.push(cut(prev, cur));
        prev = cur;
      }
    }
    return out.length >= 3 ? [...out, out[0]] : null;
  }
  function clipFeature(f, box) {
    const g = f.geometry;
    const polys = g.type === 'Polygon' ? [g.coordinates] : g.coordinates;
    const kept = polys.map(poly => {
      const outer = clipRing(poly[0], box);
      if (!outer) return null;
      return [outer, ...poly.slice(1).map(r => clipRing(r, box)).filter(Boolean)];
    }).filter(Boolean);
    if (!kept.length) return null;
    return { ...f, geometry: { type: 'MultiPolygon', coordinates: kept } };
  }
  function mapFor(rid) {
    const name = rid ? 'tiva-' + rid : 'tiva-world';
    if (!GEO.registered.has(name)) {
      let feats = GEO.world.features;
      if (rid) feats = feats.map(f => clipFeature(f, REGION_BOX[rid])).filter(Boolean);
      const fc = { type: 'FeatureCollection', features: feats };
      echarts.registerMap(name, fc);
      const b = d3.geoPath(projFn(rid)).bounds(fc);
      GEO.aspect = GEO.aspect || {};
      GEO.aspect[name] = (b[1][0] - b[0][0]) / (b[1][1] - b[0][1]);
      GEO.registered.add(name);
    }
    return name;
  }
  // 투영한 지도의 가로세로 비율을 지키면서 카드 안에 가운데 맞춘다
  function geoBox(node, name) {
    const W = node.clientWidth || 800, H = node.clientHeight || 400, a = GEO.aspect[name] || 2;
    const pad = 6;
    let w = W - 2 * pad, h = w / a;
    if (h > H - 2 * pad) { h = H - 2 * pad; w = h * a; }
    return { left: Math.round((W - w) / 2), top: Math.round((H - h) / 2), width: Math.round(w), height: Math.round(h) };
  }
  const projFn = rid => (rid ? d3.geoMercator() : d3.geoNaturalEarth1());
  function projectionFor(rid) {
    const p = projFn(rid);
    return { project: pt => p(pt), unproject: pt => p.invert(pt) };
  }
  // 1:110m 국경에 없는 작은 경제(홍콩, 싱가포르, 몰타 등)는 점으로 표시
  function smallPoints(codes, rid) {
    return codes.filter(c => !GEO.names.has(c) && GEO.cent[c] && (!rid || S.meta.regions[rid].members.includes(c) || inBox(c, REGION_BOX[rid])));
  }
  function niceNum(x) {
    if (!ok(x) || x === 0) return x;
    const m = Math.pow(10, Math.floor(Math.log10(Math.abs(x))) - 1);
    return Math.round(x / m) * m;
  }
  function rangeLabel(lo, hi, fmt) {
    if (lo == null) return `< ${fmt(hi)}`;
    if (hi == null) return `≥ ${fmt(lo)}`;
    return tr(`${fmt(lo)} ~ ${fmt(hi)}`, `${fmt(lo)} to ${fmt(hi)}`);
  }
  const legendFmt = fmt => (fmt === fmtPct ? (x => (Math.abs(x) < 1 && x !== 0 ? nf(2).format(x) + '%' : fmtPct(x))) : fmt);
  function quantilePieces(values, colors, fmt) {
    fmt = legendFmt(fmt);
    const v = values.filter(ok).sort((a, b) => a - b);
    if (!v.length) return [];
    const br = [];
    for (let i = 1; i < colors.length; i++) {
      const b = niceNum(v[Math.min(v.length - 1, Math.floor(i * v.length / colors.length))]);
      if (b > v[0] && (!br.length || b > br[br.length - 1])) br.push(b);   // 빈 구간이 생기지 않도록 최솟값 이하 경계는 버린다
    }
    const n = br.length + 1;
    const cols = n === colors.length ? colors : colors.slice(colors.length - n);
    return cols.map((color, i) => {
      const lo = i === 0 ? null : br[i - 1], hi = i === n - 1 ? null : br[i];
      const p = { color, label: rangeLabel(lo, hi, fmt) };
      if (lo != null) p.gte = lo;
      if (hi != null) p.lt = hi;
      return p;
    });
  }
  function divergingPieces(breaks, colors, fmt) {          // breaks 4개 -> 5구간
    return colors.map((color, i) => {
      const lo = i === 0 ? null : breaks[i - 1], hi = i === colors.length - 1 ? null : breaks[i];
      const p = { color, label: rangeLabel(lo, hi, fmt) };
      if (lo != null) p.gte = lo;
      if (hi != null) p.lt = hi;
      return p;
    });
  }
  function scaleFor(kind, values, fmt, t) {
    if (kind === 'rca') return divergingPieces([0.5, 0.8, 1.25, 2], t.div, fmtRca);
    if (kind === 'change') {
      const a = values.filter(ok).map(Math.abs).sort((x, y) => x - y);
      const q = Math.max(0.1, niceNum(a[Math.floor(a.length * 0.5)] || 1));
      return divergingPieces([-2 * q, -q / 2, q / 2, 2 * q], t.div, fmt);
    }
    return quantilePieces(values, t.seq, fmt);
  }

  /** 단계구분도. values = {ISO3: 값}. flows = [{from, to, value}] 이면 흐름선을 함께 그린다. */
  function mapChart(node, { values, label, fmt = fmtPct, kind = 'seq', rid = null, highlight = [], flows = null, flowFmt = fmtPct }) {
    const t = tokens();
    const c = mount(node);
    const name = mapFor(rid);
    const codes = Object.keys(values).filter(k => ok(values[k]));
    const pieces = scaleFor(kind, codes.map(k => values[k]), fmt, t);
    const pts = smallPoints(codes, rid);
    const hl = new Set(highlight);
    const series = [
      { type: 'map', geoIndex: 0, data: codes.map(k => ({ name: k, value: values[k] })) },
      { type: 'scatter', coordinateSystem: 'geo', symbolSize: 9, z: 4,
        data: pts.map(k => ({ name: k, value: [...GEO.cent[k], values[k]] })),
        itemStyle: { borderColor: t.text2, borderWidth: 1 }, tooltip: { trigger: 'item' } },
    ];
    if (flows && flows.length) {
      const maxF = Math.max(...flows.map(f => f.value));
      series.push({
        type: 'lines', coordinateSystem: 'geo', z: 5, silent: false,
        data: flows.filter(f => GEO.cent[f.from] && GEO.cent[f.to]).map(f => ({
          coords: [GEO.cent[f.from], GEO.cent[f.to]], value: f.value, fromCode: f.from, toCode: f.to,
          lineStyle: { width: 1 + 5 * Math.sqrt(f.value / maxF) },
        })),
        lineStyle: { color: t.flow, opacity: 0.85, curveness: 0.25, cap: 'round' },
        symbol: ['none', 'arrow'], symbolSize: 7,
        tooltip: { trigger: 'item', formatter: p => `<b>${esc(AL(p.data.fromCode))} → ${esc(AL(p.data.toCode))}</b><br>${esc(flowFmt(p.data.value))}` },
      });
      const ends = [...new Set(flows.flatMap(f => [f.from, f.to]))].filter(k => GEO.cent[k]);
      series.push({ type: 'scatter', coordinateSystem: 'geo', z: 6, symbolSize: 6, silent: true,
        data: ends.map(k => ({ name: k, value: GEO.cent[k] })), itemStyle: { color: t.flow, borderColor: t.surface, borderWidth: 1 },
        label: { show: true, formatter: p => (hl.has(p.name) ? AL(p.name) : ''), position: 'right', color: t.text, fontSize: 12, fontWeight: 700 } });
    }
    const vmBase = { type: 'piecewise', pieces, left: 8, bottom: 8, orient: 'vertical', itemWidth: 14, itemHeight: 10, itemGap: 4,
      textStyle: { color: t.text2, fontSize: 11, fontFamily: t.font }, selectedMode: false, outOfRange: { color: t.surface2 } };
    c.setOption({
      animationDuration: 300,
      color: [t.surface2],                       // 자료가 없는 지역은 바탕색 (ECharts 기본 팔레트가 칠하지 않도록)
      textStyle: { fontFamily: t.font },
      tooltip: {
        ...tooltipBase(t), trigger: 'item',
        formatter: p => {
          if (p.seriesType === 'lines') return null;
          const code = p.name, v = values[code];
          return `<div style="font-weight:600;margin-bottom:2px">${esc(AL(code))}</div>${esc(label)} <b>${esc(ok(v) ? fmt(v) : tr('자료 없음', 'No data'))}</b>`;
        },
      },
      visualMap: [
        { ...vmBase, seriesIndex: 0 },
        { ...vmBase, seriesIndex: 1, dimension: 2, show: false },
      ],
      geo: {
        map: name, projection: projectionFor(rid), nameProperty: 'iso3', roam: false,
        ...geoBox(node, name),
        itemStyle: { areaColor: t.surface2, borderColor: t.base, borderWidth: 0.6 },
        emphasis: { disabled: true }, select: { disabled: true }, silent: false,
        regions: [...hl].map(k => ({ name: k, itemStyle: { borderColor: t.text, borderWidth: 1.6 } })),
        tooltip: { show: true },
      },
      series,
    });
    c.__relayout = () => c.setOption({ geo: geoBox(node, name) });
    return c;
  }

  // ------------------------------------------------------------------ UI pieces
  function card({ span = 6, title, sub, note, size = '' }) {
    const chart = el('div', { class: `chart ${size}`, role: 'img', 'aria-label': title });
    const tableBox = el('div', { class: 'table-wrap scroll-y', hidden: true });
    const btn = el('button', { class: 'table-toggle', type: 'button', 'aria-expanded': 'false', text: tr('표 보기', 'Show table') });
    btn.addEventListener('click', () => {
      const open = tableBox.hidden;
      tableBox.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? tr('표 닫기', 'Hide table') : tr('표 보기', 'Show table');
    });
    const node = el('section', { class: `card span-${span}` },
      el('div', { class: 'card-head' }, el('div', {}, el('h3', { text: title }), sub ? el('p', { class: 'sub', text: sub }) : null), btn),
      chart, tableBox, note ? el('p', { class: 'note', text: note }) : null);
    return {
      node, chart,
      table(columns, rows, opts) { tableBox.replaceChildren(makeTable(columns, rows, opts)); },
      empty(msg) { chart.replaceWith(el('p', { class: 'empty', text: msg })); btn.hidden = true; },
    };
  }

  function makeTable(columns, rows, { sortKey, desc = true, highlight, onRow } = {}) {
    let key = sortKey, dir = desc ? -1 : 1;
    const table = el('table', { class: 'data' });
    const thead = el('thead');
    const tbody = el('tbody');
    table.append(thead, tbody);
    const render = () => {
      const sorted = key ? [...rows].sort((a, b) => {
        const x = a[key], y = b[key];
        if (!ok(x) && !ok(y) && typeof x !== 'string') return 0;
        if (typeof x === 'string' || typeof y === 'string') return dir * String(x ?? '').localeCompare(String(y ?? ''), loc());
        if (!ok(x)) return 1;
        if (!ok(y)) return -1;
        return dir * (x - y);
      }) : rows;
      thead.replaceChildren(el('tr', {}, columns.map(c => {
        const th = el('th', { class: (c.left ? 'left ' : '') + (c.sort !== false ? 'sortable' : ''), scope: 'col',
          'aria-sort': key === c.key ? (dir < 0 ? 'descending' : 'ascending') : null }, c.label + (key === c.key ? (dir < 0 ? ' ↓' : ' ↑') : ''));
        if (c.sort !== false) th.addEventListener('click', () => { if (key === c.key) dir = -dir; else { key = c.key; dir = c.left ? 1 : -1; } render(); });
        return th;
      })));
      tbody.replaceChildren(...sorted.map(r => {
        const tr_ = el('tr', { class: highlight && highlight(r) ? 'hl' : null });
        if (onRow) { tr_.style.cursor = 'pointer'; tr_.addEventListener('click', () => onRow(r)); }
        columns.forEach(c => {
          const td = el('td', { class: c.left ? 'left' : null });
          td.append(document.createTextNode(c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? DASH)));
          tr_.append(td);
        });
        return tr_;
      }));
    };
    render();
    return table;
  }

  function tiles(items) {
    return el('div', { class: 'tiles' }, items.map(it => el('div', { class: 'tile' },
      el('div', { class: 't-label', text: it.label }),
      el('div', { class: 't-value' }, it.value, it.unit ? el('span', { class: 't-unit', text: it.unit }) : null),
      it.delta ? el('div', { class: 't-delta', text: it.delta }) : null)));
  }

  function selectFilter(label, options, value, onChange, { groups } = {}) {
    const id = 'f-' + Math.random().toString(36).slice(2, 8);
    const sel = el('select', { id });
    if (groups) {
      groups.forEach(g => {
        const og = el('optgroup', { label: g.label });
        g.options.forEach(o => og.append(el('option', { value: o.value, text: o.label })));
        sel.append(og);
      });
    } else {
      options.forEach(o => sel.append(el('option', { value: o.value, text: o.label })));
    }
    sel.value = String(value);
    sel.addEventListener('change', () => onChange(sel.value));
    return el('div', { class: 'filter' }, el('label', { for: id, text: label }), sel);
  }
  function segFilter(label, options, value, onChange) {
    const wrap = el('div', { class: 'seg', role: 'group', 'aria-label': label });
    options.forEach(o => {
      const b = el('button', { type: 'button', 'aria-pressed': String(o.value === value), text: o.label });
      b.addEventListener('click', () => onChange(o.value));
      wrap.append(b);
    });
    return el('div', { class: 'filter' }, el('label', { text: label }), wrap);
  }

  // 국가 선택 칩: 선택 순서대로 색 슬롯을 고정한다 (다른 국가를 빼도 색이 바뀌지 않음)
  function chipPicker(label, codes, st, key, max, onChange) {
    st[key + 'Slots'] = st[key + 'Slots'] || {};
    const slots = st[key + 'Slots'];
    st[key].forEach(c => { if (slots[c] == null) slots[c] = firstFree(slots, max); });
    const t = tokens();
    const wrap = el('div', { class: 'chips', role: 'group', 'aria-label': label },
      el('span', { class: 'chips-label', text: tr(`${label} (최대 ${max}개)`, `${label} (up to ${max})`) }));
    codes.forEach(code => {
      const on = st[key].includes(code);
      const b = el('button', { class: 'chip', type: 'button', 'aria-pressed': String(on) },
        el('span', { class: 'key', style: on ? `background:${t.series[slots[code]]}` : null }), AL(code));
      b.addEventListener('click', () => {
        if (st[key].includes(code)) {
          st[key] = st[key].filter(c => c !== code);
          delete slots[code];
        } else {
          if (st[key].length >= max) return;
          st[key] = [...st[key], code];
          slots[code] = firstFree(slots, max);
        }
        onChange();
      });
      wrap.append(b);
    });
    return wrap;
  }
  function firstFree(slots, max) {
    const used = new Set(Object.values(slots));
    for (let i = 0; i < max; i++) if (!used.has(i)) return i;
    return 0;
  }

  function filtersRow(...items) { return el('div', { class: 'filters' }, items); }
  function head(title, desc) { return el('div', { class: 'view-head' }, el('h2', { text: title }), desc ? el('p', { text: desc }) : null); }
  function yearOptions() { return [...S.countries.years].reverse().map(y => ({ value: y, label: yl(y) })); }
  function actGroups(include) {
    const m = S.meta;
    const has = c => m.acts.includes(c) && (!include || include.includes(c));
    const focus = m.focus.filter(f => has(f.code)).map(f => ({ value: f.code, label: `${FL(f)} (${f.code})` }));
    const aggr = ['_T', 'C', 'BTE', 'GTT', 'A', 'B', 'D_E', 'F'].filter(has).map(c => ({ value: c, label: IL(c) }));
    const manu = m.detail_acts.filter(c => c.startsWith('C') && has(c)).map(c => ({ value: c, label: `${IL(c)} (${c})` }));
    const prim = m.detail_acts.filter(c => /^[AB]/.test(c) && has(c)).map(c => ({ value: c, label: `${IL(c)} (${c})` }));
    const serv = m.detail_acts.filter(c => /^[D-T]/.test(c) && has(c)).map(c => ({ value: c, label: `${IL(c)} (${c})` }));
    return [{ label: tr('중점 산업', 'Focus industries'), options: focus }, { label: tr('집계', 'Aggregates'), options: aggr },
      { label: tr('제조업 세부', 'Manufacturing detail'), options: manu },
      { label: tr('농림어업·광업', 'Agriculture and mining'), options: prim }, { label: tr('서비스·기타', 'Services and other'), options: serv }]
      .filter(g => g.options.length);
  }
  function focusNote(act) {
    const f = S.meta.focus.find(x => x.code === act);
    return f ? `${FL(f)} = ${IL(act)} (${act}). ${FN(f)}` : null;
  }
  const mapNote = () => tr('지도 경계는 Natural Earth 자료이며 어떠한 영토의 지위나 경계에 대한 입장도 나타내지 않습니다. 회색 바탕은 자료가 없는 경제입니다. 작은 경제는 점으로 표시합니다.',
    'Boundaries are from Natural Earth and imply no position on the status or delimitation of any territory. Grey areas have no data. Small economies are shown as dots.');

  // 상대국 원천 구성 (상위 n + 기타)
  function sourceStack(pdata, measure, act, partners, years, n = 7, exclude = []) {
    const byYear = pdata.data[measure][act];
    const lastIdx = years.length - 1;
    const last = byYear[lastIdx] || [];
    const order = partners.map((p, i) => ({ p, i, v: last[i] })).filter(o => ok(o.v) && !exclude.includes(o.p))
      .sort((a, b) => b.v - a.v).slice(0, n);
    const t = tokens();
    const series = order.map((o, k) => ({ name: AL(o.p), code: o.p, color: t.series[k], data: years.map((y, yi) => (byYear[yi] || [])[o.i]) }));
    const other = years.map((y, yi) => {
      const row = byYear[yi] || [];
      const total = sum(row.filter((v, i) => !exclude.includes(partners[i])));
      return total - sum(order.map(o => row[o.i]));
    });
    series.push({ name: tr('기타', 'Other'), code: 'OTHER', color: t.deemph, data: other });
    return series;
  }
  const yearTable = (series, years, fmt) => [
    [{ key: 'year', label: tr('연도', 'Year'), left: true, fmt: x => x }, ...series.map(s => ({ key: s.code, label: s.name, fmt }))],
    years.map((yy, i) => Object.fromEntries([['year', yy], ...series.map(s => [s.code, s.data[i]])])),
  ];

  // 필터 줄과 본문을 함께 다시 그리는 공통 틀
  function viewShell(root, st, buildFilters, renderBody) {
    let filters = buildFilters(update);
    const body = el('div');
    root.append(filters, body);
    function update() {
      disposeAll();
      const nf_ = buildFilters(update);
      filters.replaceWith(nf_);
      filters = nf_;
      body.replaceChildren();
      const tok = ++S.token;
      Promise.resolve(renderBody(body, tok)).catch(err => {
        console.error(err);
        body.append(el('p', { class: 'empty', text: tr('데이터를 불러오지 못했습니다. ', 'Could not load the data. ') + err.message }));
      });
    }
    disposeAll();
    const tok = ++S.token;
    return Promise.resolve(renderBody(body, tok));
  }
  const stale = tok => tok !== S.token;

  // ---------------------------------------------------------------- 세계 지도
  async function viewMap(root) {
    const st = S.state.map = S.state.map || { metric: 'gvc', act: '_T', year: S.meta.latest, mode: 'level' };
    root.append(head(tr('세계 지도로 보는 GVC', 'Global value chains on the map'),
      tr('경제별 GVC 참여, 부가가치 구성, 산업별 수출 점유율과 비교우위를 세계 지도로 보여 줍니다. 변화 보기를 고르면 10년 전 대비 차이를 나타냅니다.',
        'The map shows GVC participation, value added composition, industry export shares and comparative advantage by economy. The change view shows the difference from ten years earlier.')));
    const metrics = ['gvc', 'back', 'fwd', 'dva_sh', 'int_sh', 'ms', 'rca', 'EXGR'];
    await viewShell(root, st, update => filtersRow(
      selectFilter(tr('지표', 'Indicator'), metrics.map(k => ({ value: k, label: M(k).label })), st.metric, v => { st.metric = v; if (v === 'rca' || v === 'EXGR') st.mode = 'level'; update(); }),
      selectFilter(tr('산업', 'Industry'), null, st.act, v => { st.act = v; update(); }, { groups: actGroups() }),
      selectFilter(tr('기준 연도', 'Year'), yearOptions(), st.year, v => { st.year = +v; update(); }),
      segFilter(tr('보기', 'View'), [{ value: 'level', label: tr('수준', 'Level') }, { value: 'change', label: tr('10년 변화', '10-year change') }]
        .filter(o => o.value === 'level' || !['rca', 'EXGR'].includes(st.metric)), st.mode, v => { st.mode = v; update(); })),
    async (body, tok) => {
      const [ind] = await Promise.all([getJSON(`industry/${st.act}.json`), loadGeo()]);
      if (stale(tok)) return;
      const t = tokens();
      const m = M(st.metric);
      const yi = ind.years.indexOf(st.year), b0 = baseYear(st.year), bi = ind.years.indexOf(b0);
      const econ = S.meta.economies.filter(c => ind.data[c]);
      const val = (c, i) => { const d = ind.data[c] && ind.data[c][st.metric]; return d ? d[i] : null; };
      const change = st.mode === 'change';
      const values = {};
      econ.forEach(c => {
        const v = change ? (ok(val(c, yi)) && ok(val(c, bi)) ? val(c, yi) - val(c, bi) : null) : val(c, yi);
        if (ok(v)) values[c] = v;
      });
      const fmt = change ? fmtPp : m.fmt;
      const label = change ? tr(`${m.label} ${b0}년 대비 변화`, `${m.label}, change since ${b0}`) : m.label;
      const note = focusNote(st.act);
      if (note) body.append(el('div', { class: 'banner', text: note }));

      const ranked = Object.entries(values).sort((a, b) => b[1] - a[1]);
      const vals = ranked.map(r => r[1]).sort((a, b) => a - b);
      const median = vals.length ? vals[Math.floor(vals.length / 2)] : null;
      body.append(tiles([
        { label: tr('자료가 있는 경제', 'Economies with data'), value: fmtNum(ranked.length), delta: `${IL(st.act)}, ${yl(st.year)}` },
        { label: tr('중앙값', 'Median'), value: fmt(median), delta: label },
        { label: tr('가장 높은 경제', 'Highest'), value: ranked[0] ? AL(ranked[0][0]) : DASH, delta: ranked[0] ? fmt(ranked[0][1]) : '' },
        { label: tr('한국', 'Korea'), value: fmt(values.KOR), delta: ok(values.KOR) ? tr(`${ranked.findIndex(r => r[0] === 'KOR') + 1}위 / ${ranked.length}`, `rank ${ranked.findIndex(r => r[0] === 'KOR') + 1} of ${ranked.length}`) : '' },
      ]));
      const grid = el('div', { class: 'grid' });
      body.append(grid);
      const c1 = card({ span: 12, title: `${label} (${IL(st.act)}, ${yl(st.year)})`, sub: m.desc ? (m.desc.charAt(0).toUpperCase() + m.desc.slice(1)) : '', size: 'map', note: mapNote() });
      grid.append(c1.node);
      if (!ranked.length) c1.empty(tr('이 조합에는 자료가 없습니다.', 'No data for this selection.'));
      else {
        mapChart(c1.chart, { values, label, fmt, kind: change ? 'change' : st.metric === 'rca' ? 'rca' : 'seq', highlight: ['KOR'] });
        c1.table([{ key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'v', label, fmt }],
          ranked.map(([c, v]) => ({ name: AL(c), v })), { sortKey: 'v' });
      }

      const top15 = ranked.slice(0, 15);
      const c2 = card({ span: 6, title: tr('상위 15개 경제', 'Top 15 economies'), sub: label, size: 'tall' });
      grid.append(c2.node);
      hbarChart(c2.chart, { cats: top15.map(([c]) => ({ code: c, label: AL(c) })), highlight: c => c === 'KOR', fmt,
        series: [{ name: label, data: top15.map(r => r[1]), colors: top15.map(([c]) => (c === 'KOR' ? t.accent : t.series[0])), color: t.series[0] }] });
      c2.table([{ key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'v', label, fmt }], top15.map(([c, v]) => ({ name: AL(c), v })), { sortKey: 'v' });

      const regs = Object.keys(S.meta.regions);
      const regRows = regs.map(r => ({ code: r, name: AL(r), v: change ? (ok(val(r, yi)) && ok(val(r, bi)) ? val(r, yi) - val(r, bi) : null) : val(r, yi) })).filter(r => ok(r.v));
      const c3 = card({ span: 6, title: tr('지역 비교 (회원국 합계)', 'Regions (sum of members)'), sub: label });
      grid.append(c3.node);
      if (regRows.length) {
        hbarChart(c3.chart, { cats: regRows.map(r => ({ code: r.code, label: AL(r.code) })), fmt,
          series: [{ name: label, color: t.series[0], data: regRows.map(r => r.v) }], refLine: st.metric === 'rca' && !change ? 1 : null });
        c3.table([{ key: 'name', label: tr('지역', 'Region'), left: true }, { key: 'v', label, fmt }], regRows, { sortKey: 'v' });
      } else c3.empty(tr('자료가 없습니다.', 'No data.'));
    });
  }

  // ---------------------------------------------------------------- 주요국 비교
  async function viewTopCountries(root) {
    const top = S.meta.top;
    const st = S.state.top = S.state.top || { year: S.meta.latest, act: '_T', metric: 'gvc', sel: ['KOR', 'USA', 'CHN', 'JPN', 'DEU'] };
    const trendCodes = [...new Set([...top, 'KOR'])];
    st.sel = st.sel.filter(c => trendCodes.includes(c));
    root.append(head(tr(`주요국 비교 (부가가치 상위 ${top.length}개 경제)`, `Major economies (top ${top.length} by value added)`),
      tr(`TiVA 부가가치(VALU, 전 산업) 기준 ${S.meta.latest}년 상위 ${top.length}개 경제의 GVC 참여 구조를 비교합니다. 후방 참여율은 총수출 중 해외부가가치 비중, 전방 참여율은 자국 부가가치 중 제3국 수출에 체화된 부분의 총수출 대비 비중입니다.`,
        `The view compares the GVC participation of the ${top.length} largest economies by TiVA value added (VALU, all industries) in ${S.meta.latest}. Backward participation is the foreign value added share of gross exports. Forward participation is domestic value added embodied in third-country exports, as a share of gross exports.`)));
    await viewShell(root, st, update => filtersRow(
      selectFilter(tr('기준 연도', 'Year'), yearOptions(), st.year, v => { st.year = +v; update(); }),
      selectFilter(tr('산업 범위', 'Scope'), [{ value: '_T', label: IL('_T') }, { value: 'C', label: IL('C') }], st.act, v => { st.act = v; update(); }),
      selectFilter(tr('추이 지표', 'Trend indicator'), ['gvc', 'back', 'fwd', 'dva_sh', 'int_sh', 'EXGR'].map(k => ({ value: k, label: M(k).label })), st.metric, v => { st.metric = v; update(); }),
      chipPicker(tr('추이 비교 경제', 'Economies in the trend chart'), trendCodes, st, 'sel', 8, update)), (body) => {
      const D = S.countries.data;
      const y = st.year, a = st.act, b0 = baseYear(y);
      const rows = top.map(c => {
        const d = D[c] && D[c][a];
        if (!d) return null;
        return { code: c, name: AL(c), VALU: valAt(D[c]._T.VALU, y), EXGR: valAt(d.EXGR, y), dva_sh: valAt(d.dva_sh, y),
          back: valAt(d.back, y), fwd: valAt(d.fwd, y), gvc: valAt(d.gvc, y), int_sh: valAt(d.int_sh, y),
          dback: ok(valAt(d.back, y)) && ok(valAt(d.back, b0)) ? valAt(d.back, y) - valAt(d.back, b0) : null };
      }).filter(Boolean);
      const worldEx = sum([...S.meta.economies, 'WXD'].map(c => D[c] && D[c][a] ? valAt(D[c][a].EXGR, y) : null));
      const topEx = sum(rows.map(r => r.EXGR));
      const wavg = k => { const w = rows.filter(r => ok(r[k]) && ok(r.EXGR)); return sum(w.map(r => r[k] * r.EXGR)) / sum(w.map(r => r.EXGR)); };
      const best = [...rows].filter(r => ok(r.gvc)).sort((p, q) => q.gvc - p.gvc)[0];
      body.append(tiles([
        { label: tr(`${top.length}개 경제의 세계 총수출 비중`, `Share of world gross exports`), value: fmtPct(topEx / worldEx * 100), delta: `${IL(a)}, ${yl(y)}` },
        { label: tr('가중평균 후방 참여율', 'Weighted backward participation'), value: fmtPct(wavg('back')), delta: tr('총수출 가중', 'weighted by gross exports') },
        { label: tr('가중평균 전방 참여율', 'Weighted forward participation'), value: fmtPct(wavg('fwd')), delta: tr('총수출 가중', 'weighted by gross exports') },
        { label: tr('GVC 참여율 최고 경제', 'Highest GVC participation'), value: best ? best.name : DASH, delta: best ? fmtPct(best.gvc) : '' },
      ]));
      const grid = el('div', { class: 'grid' });
      body.append(grid);
      const t = tokens();

      const byGvc = [...rows].filter(r => ok(r.gvc)).sort((p, q) => q.gvc - p.gvc);
      const c1 = card({ span: 7, title: tr(`GVC 참여율 구성 (${yl(y)})`, `GVC participation (${y})`), sub: tr(`${IL(a)}, 총수출 대비 %`, `${IL(a)}, % of gross exports`), size: 'tall' });
      grid.append(c1.node);
      hbarChart(c1.chart, {
        cats: byGvc.map(r => ({ code: r.code, label: r.name })), stacked: true, highlight: c => c === 'KOR',
        series: [{ name: M('back').label, color: t.series[0], data: byGvc.map(r => r.back) },
          { name: M('fwd').label, color: t.series[1], data: byGvc.map(r => r.fwd) }],
      });
      c1.table([{ key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'back', label: M('back').label, fmt: fmtPct }, { key: 'fwd', label: M('fwd').label, fmt: fmtPct }, { key: 'gvc', label: M('gvc').label, fmt: fmtPct }], byGvc, { sortKey: 'gvc' });

      const c2 = card({ span: 5, title: tr('후방·전방 참여율 분포', 'Backward and forward participation'), sub: tr(`${yl(y)}, 한국 강조`, `${y}, Korea highlighted`), size: 'tall' });
      grid.append(c2.node);
      scatterChart(c2.chart, { points: rows.filter(r => ok(r.back) && ok(r.fwd)).map(r => ({ code: r.code, label: r.name, x: r.back, y: r.fwd })),
        xName: `${M('back').label} (%)`, yName: `${M('fwd').label} (%)`, highlight: c => c === 'KOR' });
      c2.table([{ key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'back', label: M('back').label, fmt: fmtPct }, { key: 'fwd', label: M('fwd').label, fmt: fmtPct }], rows, { sortKey: 'back' });

      const tableCard = el('section', { class: 'card span-12' },
        el('div', { class: 'card-head' }, el('div', {}, el('h3', { text: tr(`주요 경제 지표 (${yl(y)}, ${IL(a)})`, `Indicators for major economies (${y}, ${IL(a)})`) }),
          el('p', { class: 'sub', text: tr(`열 제목을 누르면 정렬하고, 행을 누르면 아래 추이 차트에 넣거나 뺍니다. 후방 변화는 ${b0}년 대비입니다.`,
            `Select a column heading to sort and a row to add or remove the economy in the trend chart. The backward change is measured from ${b0}.`) }))),
        el('div', { class: 'table-wrap' }, makeTable([
          { key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'VALU', label: `${M('VALU').label} (${moneyUnit()})`, fmt: fmtMoneyNum },
          { key: 'EXGR', label: `${M('EXGR').label} (${moneyUnit()})`, fmt: fmtMoneyNum }, { key: 'dva_sh', label: M('dva_sh').label, fmt: fmtPct },
          { key: 'back', label: M('back').label, fmt: fmtPct }, { key: 'fwd', label: M('fwd').label, fmt: fmtPct },
          { key: 'gvc', label: M('gvc').label, fmt: fmtPct }, { key: 'int_sh', label: M('int_sh').label, fmt: fmtPct },
          { key: 'dback', label: tr('후방 변화', 'Backward change'), fmt: fmtPp },
        ], rows, {
          sortKey: 'VALU', highlight: r => r.code === 'KOR' || st.sel.includes(r.code),
          onRow: r => {
            if (st.sel.includes(r.code)) { st.sel = st.sel.filter(c => c !== r.code); delete st.selSlots[r.code]; }
            else if (st.sel.length < 8) { st.sel = [...st.sel, r.code]; st.selSlots[r.code] = firstFree(st.selSlots, 8); }
            route();
          },
        })));
      grid.append(tableCard);

      const m = M(st.metric);
      const c4 = card({ span: 12, title: tr(`${m.label} 추이`, `${m.label} over time`), sub: `${IL(a)}, ${m.unit}${m.desc ? ', ' + m.desc : ''}` });
      grid.append(c4.node);
      const ser = st.sel.filter(c => D[c] && D[c][a]).map(c => ({ name: AL(c), code: c, color: t.series[st.selSlots[c]],
        data: D[c][a][st.metric].map(v => (m.money && ok(v) ? v / moneyDiv() : v)) }));
      if (!ser.length) c4.empty(tr('위의 칩에서 비교할 경제를 고르세요.', 'Choose economies with the chips above.'));
      else {
        const fmt = m.money ? fmtMoneyScaled : m.fmt;
        lineChart(c4.chart, { years: S.countries.years, series: ser, fmt, yName: m.unit });
        c4.table(...yearTable(ser, S.countries.years, m.money ? (v => ok(v) ? nf(LANG === 'en' ? 1 : 0).format(v) : DASH) : fmtPct), { sortKey: 'year' });
      }
    });
  }

  // ---------------------------------------------------------------- 산업별 심층
  async function viewIndustry(root) {
    const st = S.state.industry = S.state.industry || { act: S.meta.acts.includes('C26') ? 'C26' : S.meta.acts[0], year: S.meta.latest, base: 'KOR', mapMetric: 'ms' };
    root.append(head(tr('산업별 심층 분석', 'Industry deep dive'),
      tr('산업을 고르면 세계 수출 규모, 주요 수출 경제, 부가가치 구성, 집중도, 비교우위를 보여 줍니다. 중점 산업은 상대국별 원천·연계 분석을 함께 제공합니다.',
        'Choose an industry to see world export size, leading exporters, value added composition, concentration and comparative advantage. Focus industries also include partner-level sourcing and linkage analysis.')));
    await viewShell(root, st, update => {
      const econOpts = [...S.meta.economies].sort((a, b) => AL(a).localeCompare(AL(b), loc())).map(c => ({ value: c, label: AL(c) }));
      const focusChips = el('div', { class: 'chips', role: 'group', 'aria-label': tr('중점 산업 바로가기', 'Focus industries') },
        el('span', { class: 'chips-label', text: tr('중점 산업', 'Focus industries') }),
        S.meta.focus.map(f => {
          const b = el('button', { class: 'chip focus-chip', type: 'button', 'aria-pressed': String(st.act === f.code) }, FL(f));
          b.addEventListener('click', () => { st.act = f.code; update(); });
          return b;
        }));
      return filtersRow(
        selectFilter(tr('산업', 'Industry'), null, st.act, v => { st.act = v; update(); }, { groups: actGroups() }),
        selectFilter(tr('기준 연도', 'Year'), yearOptions(), st.year, v => { st.year = +v; update(); }),
        selectFilter(tr('기준 경제', 'Reference economy'), econOpts, st.base, v => { st.base = v; update(); }),
        segFilter(tr('지도 지표', 'Map indicator'), [{ value: 'ms', label: tr('수출 점유율', 'Export share') }, { value: 'rca', label: 'RCA' }, { value: 'back', label: tr('후방 참여', 'Backward') }],
          st.mapMetric, v => { st.mapMetric = v; update(); }),
        focusChips);
    }, async (body, tok) => {
      const act = st.act, y = st.year, base = st.base;
      const [d] = await Promise.all([getJSON(`industry/${act}.json`), loadGeo()]);
      if (stale(tok)) return;
      const t = tokens();
      const yi = d.years.indexOf(y), b0 = baseYear(y), bi = d.years.indexOf(b0);
      const econ = S.meta.economies.filter(c => d.data[c]);
      const v = (c, m, i = yi) => (d.data[c] && d.data[c][m] ? d.data[c][m][i] : null);
      const note = focusNote(act);
      if (note) body.append(el('div', { class: 'banner', text: note }));
      const wEx = d.world.EXGR[yi];
      const ranked = econ.filter(c => ok(v(c, 'EXGR')) && v(c, 'EXGR') > 0).sort((a, b) => v(b, 'EXGR') - v(a, 'EXGR'));
      const baseRank = ranked.indexOf(base) + 1;
      body.append(tiles([
        { label: tr(`세계 총수출 (${yl(y)})`, `World gross exports (${y})`), value: fmtMoneyNum(wEx), unit: moneyUnit(), delta: tr(`${b0}년 이후 연평균 ${fmtPct(cagr(d.world.EXGR[bi], wEx, y - b0))}`, `${fmtPct(cagr(d.world.EXGR[bi], wEx, y - b0))} a year since ${b0}`) },
        { label: tr('상위 3개 경제 점유율', 'Top 3 share'), value: fmtPct(d.top3[yi]), delta: `HHI ${fmtNum(d.hhi[yi])}` },
        { label: tr('세계 후방 참여율', 'World backward participation'), value: fmtPct(d.world_back[yi]), delta: tr('세계 총수출 중 해외부가가치', 'foreign value added in world gross exports') },
        { label: tr(`${AL(base)} 수출 점유율`, `${AL(base)} export share`), value: fmtPct(v(base, 'ms')), delta: baseRank ? tr(`세계 ${baseRank}위`, `rank ${baseRank} in the world`) : tr('자료 없음', 'No data') },
        { label: tr(`${AL(base)} RCA (부가가치 기준)`, `${AL(base)} value-added RCA`), value: fmtRca(v(base, 'rca')), delta: tr('1보다 크면 상대적 특화', 'above 1 indicates specialisation') },
      ]));
      const grid = el('div', { class: 'grid' });
      body.append(grid);

      // 지도
      const mm = M(st.mapMetric);
      const mapVals = {};
      econ.forEach(c => { const x = v(c, st.mapMetric); if (ok(x) && (st.mapMetric !== 'rca' || (ok(v(c, 'EXGR')) && v(c, 'EXGR') > 0))) mapVals[c] = x; });
      const cm = card({ span: 12, title: tr(`${mm.label} 지도 (${IL(act)}, ${yl(y)})`, `${mm.label} map (${IL(act)}, ${y})`), sub: mm.desc ? mm.desc.charAt(0).toUpperCase() + mm.desc.slice(1) : '', size: 'map-short', note: mapNote() });
      grid.append(cm.node);
      mapChart(cm.chart, { values: mapVals, label: mm.label, fmt: mm.fmt, kind: st.mapMetric === 'rca' ? 'rca' : 'seq', highlight: [base] });
      cm.table([{ key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'v', label: mm.label, fmt: mm.fmt }],
        Object.entries(mapVals).map(([c, x]) => ({ name: AL(c), v: x })), { sortKey: 'v' });

      const top15 = ranked.slice(0, 15);
      const fmtM = x => fmtMoneyScaled(x);
      const c1 = card({ span: 7, title: tr(`상위 15개 수출 경제 (${yl(y)})`, `Top 15 exporters (${y})`), sub: tr(`총수출의 국내·해외 부가가치 구성, ${moneyUnit()}`, `Domestic and foreign value added in gross exports, ${moneyUnit()}`), size: 'tall' });
      grid.append(c1.node);
      hbarChart(c1.chart, {
        cats: top15.map(c => ({ code: c, label: AL(c) })), stacked: true, highlight: c => c === base, fmt: fmtM,
        series: [{ name: tr('국내부가가치', 'Domestic value added'), color: t.series[0], data: top15.map(c => ok(v(c, 'EXGR_DVA')) ? v(c, 'EXGR_DVA') / moneyDiv() : null) },
          { name: tr('해외부가가치', 'Foreign value added'), color: t.series[1], data: top15.map(c => ok(v(c, 'EXGR_FVA')) ? v(c, 'EXGR_FVA') / moneyDiv() : null) }],
      });
      c1.table([{ key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'EXGR', label: `${M('EXGR').label} (${moneyUnit()})`, fmt: fmtMoneyNum },
        { key: 'ms', label: tr('점유율', 'Share'), fmt: fmtPct }, { key: 'back', label: M('back').label, fmt: fmtPct }],
      ranked.map(c => ({ name: AL(c), EXGR: v(c, 'EXGR'), ms: v(c, 'ms'), back: v(c, 'back') })), { sortKey: 'EXGR' });

      const rcaRank = econ.filter(c => ok(v(c, 'rca')) && ok(v(c, 'EXGR')) && v(c, 'EXGR') > 0).sort((a, b) => v(b, 'rca') - v(a, 'rca'));
      let rcaTop = rcaRank.slice(0, 15);
      if (!rcaTop.includes(base) && rcaRank.includes(base)) rcaTop = [...rcaTop, base];
      const c2 = card({ span: 5, title: tr(`부가가치 기준 RCA 상위 경제 (${yl(y)})`, `Highest value-added RCA (${y})`), sub: tr(`${AL(base)} 강조, 기준선 1`, `${AL(base)} highlighted, reference line at 1`), size: 'tall' });
      grid.append(c2.node);
      hbarChart(c2.chart, {
        cats: rcaTop.map(c => ({ code: c, label: AL(c) })), highlight: c => c === base, fmt: fmtRca, refLine: 1,
        series: [{ name: 'RCA', data: rcaTop.map(c => v(c, 'rca')), colors: rcaTop.map(c => (c === base ? t.accent : t.deemph)), color: t.deemph }],
      });
      c2.table([{ key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'rca', label: 'RCA', fmt: fmtRca }, { key: 'ms', label: tr('점유율', 'Share'), fmt: fmtPct }],
        rcaRank.map(c => ({ name: AL(c), rca: v(c, 'rca'), ms: v(c, 'ms') })), { sortKey: 'rca' });

      const trend = [...new Set([...ranked.slice(0, 5), base])].filter(c => d.data[c]);
      const c3 = card({ span: 6, title: tr('세계 수출 점유율 추이', 'World export share over time'), sub: tr(`${yl(y)} 상위 5개 경제와 ${AL(base)}, %`, `Top 5 exporters in ${y} and ${AL(base)}, %`) });
      grid.append(c3.node);
      const tSer = trend.map((c, i) => ({ name: AL(c), code: c, color: t.series[i], data: d.data[c].ms, endLabel: c === base }));
      lineChart(c3.chart, { years: d.years, series: tSer, endLabels: false });
      c3.table(...yearTable(tSer, d.years, fmtPct), { sortKey: 'year' });

      const top20 = ranked.slice(0, 20);
      if (!top20.includes(base) && ranked.includes(base)) top20.push(base);
      const c4 = card({ span: 6, title: tr('상위 수출 경제의 후방·전방 참여율', 'Backward and forward participation of leading exporters'), sub: tr(`${yl(y)}, 수출 상위 20개 경제`, `${y}, top 20 exporters`) });
      grid.append(c4.node);
      scatterChart(c4.chart, { points: top20.filter(c => ok(v(c, 'back')) && ok(v(c, 'fwd'))).map(c => ({ code: c, label: AL(c), x: v(c, 'back'), y: v(c, 'fwd') })),
        xName: `${M('back').label} (%)`, yName: `${M('fwd').label} (%)`, highlight: c => c === base });
      c4.table([{ key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'back', label: M('back').label, fmt: fmtPct }, { key: 'fwd', label: M('fwd').label, fmt: fmtPct }],
        top20.map(c => ({ name: AL(c), back: v(c, 'back'), fwd: v(c, 'fwd') })), { sortKey: 'back' });

      if (!S.meta.partner_acts.includes(act)) {
        grid.append(el('section', { class: 'card span-12' }, el('p', { class: 'empty', text: tr(`상대국별 원천·연계 분석은 ${S.meta.partner_acts.map(IL).join(', ')}에서 제공합니다.`, `Partner-level analysis is available for ${S.meta.partner_acts.map(IL).join(', ')}.`) })));
        return;
      }
      const pb = await tryJSON(`partner/${base}.json`);
      if (stale(tok)) return;
      const pYears = S.meta.partner_years;
      const py = partnerYearFor(y, pYears), pyi = pYears.indexOf(py);
      if (pb) {
        const row = pb.data.DEXFVApSH[act][pyi] || [];
        const srcVals = {};
        pb.partners.forEach((p, i) => { if (ok(row[i]) && p !== base && p !== 'WXD') srcVals[p] = row[i]; });
        const topSrc = Object.entries(srcVals).sort((a, b) => b[1] - a[1]).slice(0, 12);
        const cf = card({ span: 12, title: tr(`${AL(base)} 수출에 들어간 해외부가가치의 원천 (${IL(act)}, ${py}년)`, `Where the foreign value added in ${AL(base)} exports comes from (${IL(act)}, ${py})`),
          sub: tr('색은 원천 경제별 비중, 선은 상위 12개 원천에서 오는 흐름, 총수출 대비 %', 'Colour shows each source economy, lines show the 12 largest sources, % of gross exports'), size: 'map', note: mapNote() });
        grid.append(cf.node);
        mapChart(cf.chart, { values: srcVals, label: tr('총수출 대비 비중', 'Share of gross exports'), fmt: fmtPct, highlight: [base],
          flows: topSrc.map(([p, x]) => ({ from: p, to: base, value: x })) });
        cf.table([{ key: 'name', label: tr('원천 경제', 'Source economy'), left: true }, { key: 'v', label: tr('총수출 대비', 'Share of gross exports'), fmt: fmtPct }],
          Object.entries(srcVals).map(([p, x]) => ({ name: AL(p), v: x })), { sortKey: 'v' });

        const src = sourceStack(pb, 'DEXFVApSH', act, pb.partners, pb.years, 7, [base]);
        const c5 = card({ span: 6, title: tr(`${AL(base)} 수출의 해외부가가치 원천 추이`, `Sources of foreign value added in ${AL(base)} exports`), sub: tr('원천 경제별, 총수출 대비 %', 'By source economy, % of gross exports'), note: tr('상위 7개 원천은 가장 최근 연도 기준입니다.', 'The top 7 sources are based on the latest year.') });
        grid.append(c5.node);
        columnChart(c5.chart, { cats: pb.years.map(String), series: src });
        c5.table([{ key: 'name', label: tr('원천 경제', 'Source economy'), left: true }, ...pb.years.map((yy, i) => ({ key: 'y' + i, label: String(yy), fmt: fmtPct }))],
          src.map(s => Object.fromEntries([['name', s.name], ...s.data.map((x, i) => ['y' + i, x])])), { sortKey: 'y' + (pb.years.length - 1) });

        const fw = pb.data.FEXDVApSH[act][pyi] || [];
        const fwRank = pb.partners.map((p, i) => ({ p, v: fw[i] })).filter(o => ok(o.v) && o.p !== base).sort((a, b) => b.v - a.v);
        const c6 = card({ span: 6, title: tr(`${AL(base)} 부가가치가 체화된 제3국 수출 (${py}년)`, `Third-country exports embodying ${AL(base)} value added (${py})`),
          sub: tr('전방 연계 상위 10개 수출 경제, 원천 산업 기준, 해당 산업 총수출 대비 %', 'Top 10 exporting economies, source industry basis, % of the industry’s gross exports') });
        grid.append(c6.node);
        if (fwRank.length) {
          hbarChart(c6.chart, { cats: fwRank.slice(0, 10).map(o => ({ code: o.p, label: AL(o.p) })), series: [{ name: tr('전방 연계', 'Forward linkage'), color: t.series[0], data: fwRank.slice(0, 10).map(o => o.v) }] });
          c6.table([{ key: 'name', label: tr('수출 경제', 'Exporting economy'), left: true }, { key: 'v', label: tr('총수출 대비', 'Share'), fmt: fmtPct }], fwRank.map(o => ({ name: AL(o.p), v: o.v })), { sortKey: 'v' });
        } else c6.empty(tr('자료가 없습니다.', 'No data.'));
      }

      const exporters = ranked.slice(0, 10);
      const pfs = await Promise.all(exporters.map(c => tryJSON(`partner/${c}.json`)));
      if (stale(tok)) return;
      const valid = exporters.map((c, i) => ({ c, p: pfs[i] })).filter(o => o.p && o.p.data.DEXFVApSH[act]);
      if (valid.length) {
        const partners = valid[0].p.partners;
        const usd = partners.map(() => 0);
        valid.forEach(o => {
          const row = o.p.data.DEXFVApSH[act][pyi] || [];
          const exg = ok(v(o.c, 'EXGR', d.years.indexOf(py))) ? v(o.c, 'EXGR', d.years.indexOf(py)) : 0;
          row.forEach((x, j) => { if (ok(x) && partners[j] !== o.c) usd[j] += x / 100 * exg; });
        });
        const srcTop = partners.map((p, j) => ({ p, j, v: usd[j] })).filter(o => o.v > 0).sort((a, b) => b.v - a.v).slice(0, 10);
        const matrix = valid.map(o => srcTop.map(s => (s.p === o.c ? null : (o.p.data.DEXFVApSH[act][pyi] || [])[s.j])));
        const c7 = card({ span: 12, title: tr(`주요 수출 경제의 해외부가가치 원천 (${py}년)`, `Sources of foreign value added for leading exporters (${py})`),
          sub: tr('행 = 수출 상위 10개 경제, 열 = 주요 원천 경제, 값 = 행 경제 총수출 대비 %', 'Rows are the top 10 exporters, columns the main source economies, values are % of the row economy’s gross exports'), size: 'tall' });
        grid.append(c7.node);
        heatmapChart(c7.chart, { rows: valid.map(o => ({ code: o.c, label: AL(o.c) })), cols: srcTop.map(s => ({ code: s.p, label: AL(s.p) })), matrix });
        c7.table([{ key: 'name', label: tr('수출 경제', 'Exporting economy'), left: true }, ...srcTop.map((s, j) => ({ key: 'c' + j, label: AL(s.p), fmt: fmtPct }))],
          valid.map((o, i) => Object.fromEntries([['name', AL(o.c)], ...matrix[i].map((x, j) => ['c' + j, x])])));
      }

      if (pb) {
        const ex = pb.data.EXGR[act][pyi] || [], fd = pb.data.FFD_DVA[act][pyi] || [];
        const exT = sum(ex.filter((x, i) => pb.partners[i] !== base)), fdT = sum(fd.filter((x, i) => pb.partners[i] !== base));
        const dest = pb.partners.map((p, i) => ({ p, ex: ok(ex[i]) ? ex[i] / exT * 100 : null, fd: ok(fd[i]) ? fd[i] / fdT * 100 : null }))
          .filter(o => o.p !== base && ok(o.ex)).sort((a, b) => b.ex - a.ex);
        const c8 = card({ span: 12, title: tr(`${AL(base)}의 수출 대상 구성 (${py}년)`, `Destinations of ${AL(base)} exports (${py})`),
          sub: tr('총수출 기준 비중과 상대국 최종수요에 체화된 국내부가가치 기준 비중, 상위 10개 상대국', 'Shares in gross exports and in domestic value added embodied in partner final demand, top 10 partners') });
        grid.append(c8.node);
        if (dest.length && exT > 0) {
          hbarChart(c8.chart, { cats: dest.slice(0, 10).map(o => ({ code: o.p, label: AL(o.p) })),
            series: [{ name: tr('총수출 기준', 'Gross exports'), color: t.series[0], data: dest.slice(0, 10).map(o => o.ex) },
              { name: tr('최종수요 부가가치 기준', 'Value added in final demand'), color: t.series[1], data: dest.slice(0, 10).map(o => o.fd) }] });
          c8.table([{ key: 'name', label: tr('상대국', 'Partner'), left: true }, { key: 'ex', label: tr('총수출 기준', 'Gross exports'), fmt: fmtPct }, { key: 'fd', label: tr('최종수요 부가가치 기준', 'Value added in final demand'), fmt: fmtPct }],
            dest.map(o => ({ name: AL(o.p), ex: o.ex, fd: o.fd })), { sortKey: 'ex' });
        } else c8.empty(tr('자료가 없습니다.', 'No data.'));
      }
    });
  }

  // ---------------------------------------------------------------- 한국 GVC
  async function viewKorea(root) {
    const K = S.meta.korea.code;
    const peers = S.meta.korea.peers.filter(c => S.countries.data[c]);
    const acts = S.meta.partner_acts.length ? S.meta.partner_acts : ['_T', 'C'];
    const st = S.state.korea = S.state.korea || { act: '_T', year: S.meta.latest, metric: 'back', flow: 'in' };
    root.append(head(tr('한국의 GVC 참여', 'Korea in global value chains'),
      tr('한국의 후방·전방 참여 추이, 경쟁국 비교, 산업별 구조, 해외부가가치 원천과 수출 대상의 부가가치 구성을 보여 줍니다.',
        'The view covers Korea’s backward and forward participation over time, comparison with peers, industry structure, sources of foreign value added and the value added composition of export destinations.')));
    await viewShell(root, st, update => filtersRow(
      selectFilter(tr('산업', 'Industry'), null, st.act, v => { st.act = v; update(); }, { groups: actGroups(acts) }),
      selectFilter(tr('기준 연도', 'Year'), yearOptions(), st.year, v => { st.year = +v; update(); }),
      selectFilter(tr('경쟁국 비교 지표', 'Peer comparison indicator'), ['back', 'fwd', 'gvc', 'dva_sh', 'int_sh'].map(k => ({ value: k, label: M(k).label })), st.metric, v => { st.metric = v; update(); }),
      segFilter(tr('흐름 지도', 'Flow map'), [{ value: 'in', label: tr('후방 (원천 → 한국)', 'Backward (sources to Korea)') }, { value: 'out', label: tr('전방 (한국 → 제3국 수출)', 'Forward (Korea to third-country exports)') }],
        st.flow, v => { st.flow = v; update(); })),
    async (body, tok) => {
      const act = st.act, y = st.year, b0 = baseYear(y);
      const [prof, pk] = await Promise.all([getJSON(`profile/${K}.json`), tryJSON(`partner/${K}.json`), loadGeo()]);
      if (stale(tok)) return;
      const t = tokens();
      const s = m => prof.data[act] && prof.data[act][m] ? prof.data[act][m] : S.countries.years.map(() => null);
      const note = focusNote(act);
      if (note) body.append(el('div', { class: 'banner', text: note }));
      const dl = m => ok(valAt(s(m), y)) && ok(valAt(s(m), b0)) ? tr(`${b0}년 대비 ${fmtPp(valAt(s(m), y) - valAt(s(m), b0))}`, `${fmtPp(valAt(s(m), y) - valAt(s(m), b0))} since ${b0}`) : '';
      body.append(tiles([
        { label: M('back').label, value: fmtPct(valAt(s('back'), y)), delta: dl('back') },
        { label: M('fwd').label, value: fmtPct(valAt(s('fwd'), y)), delta: dl('fwd') },
        { label: M('gvc').label, value: fmtPct(valAt(s('gvc'), y)), delta: dl('gvc') },
        { label: M('dva_sh').label, value: fmtPct(valAt(s('dva_sh'), y)), delta: dl('dva_sh') },
        { label: M('ms').label, value: fmtPct(valAt(s('ms'), y)), delta: `${M('EXGR').label} ${fmtUsd(valAt(s('EXGR'), y))}` },
      ]));
      const grid = el('div', { class: 'grid' });
      body.append(grid);

      // 흐름 지도
      if (pk && pk.data.DEXFVApSH[act]) {
        const py0 = partnerYearFor(y, pk.years), pyi0 = pk.years.indexOf(py0);
        const meas = st.flow === 'in' ? 'DEXFVApSH' : 'FEXDVApSH';
        const row = pk.data[meas][act][pyi0] || [];
        const vals = {};
        pk.partners.forEach((p, i) => { if (ok(row[i]) && p !== K && p !== 'WXD') vals[p] = row[i]; });
        const topP = Object.entries(vals).sort((a, b) => b[1] - a[1]).slice(0, 12);
        const isIn = st.flow === 'in';
        const cf = card({ span: 12, size: 'map',
          title: isIn ? tr(`한국 수출에 들어간 해외부가가치는 어디서 오는가 (${IL(act)}, ${py0}년)`, `Where the foreign value added in Korean exports comes from (${IL(act)}, ${py0})`)
            : tr(`한국 부가가치는 어느 경제의 수출을 거쳐 나가는가 (${IL(act)}, ${py0}년)`, `Which economies re-export Korean value added (${IL(act)}, ${py0})`),
          sub: isIn ? tr('색은 원천 경제별 비중, 선은 상위 12개 원천, 한국 총수출 대비 %', 'Colour shows each source economy, lines show the 12 largest sources, % of Korean gross exports')
            : tr('색은 수출 경제별 비중, 선은 상위 12개 경제, 원천 산업 기준, 한국 해당 산업 총수출 대비 %', 'Colour shows each exporting economy, lines show the 12 largest, source industry basis, % of Korean gross exports in the industry'),
          note: mapNote() });
        grid.append(cf.node);
        mapChart(cf.chart, { values: vals, label: tr('총수출 대비 비중', 'Share of gross exports'), fmt: fmtPct, highlight: [K],
          flows: topP.map(([p, x]) => (isIn ? { from: p, to: K, value: x } : { from: K, to: p, value: x })) });
        cf.table([{ key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'v', label: tr('총수출 대비', 'Share of gross exports'), fmt: fmtPct }],
          Object.entries(vals).map(([p, x]) => ({ name: AL(p), v: x })), { sortKey: 'v' });
      }

      const c1 = card({ span: 6, title: tr(`한국 GVC 참여율 추이 (${IL(act)})`, `Korea’s GVC participation (${IL(act)})`), sub: tr('총수출 대비 %', '% of gross exports') });
      grid.append(c1.node);
      const s1 = [{ name: M('back').label, code: 'back', color: t.series[0], data: s('back') }, { name: M('fwd').label, code: 'fwd', color: t.series[1], data: s('fwd') },
        { name: M('gvc').label, code: 'gvc', color: t.series[2], data: s('gvc') }];
      lineChart(c1.chart, { years: S.countries.years, series: s1 });
      c1.table(...yearTable(s1, S.countries.years, fmtPct), { sortKey: 'year' });

      const m = M(st.metric);
      const all = [K, ...peers];
      const sers = await Promise.all(all.map(c => seriesOf(c, act, st.metric)));
      if (stale(tok)) return;
      const c2 = card({ span: 6, title: tr(`경쟁국 비교, ${m.label}`, `Peer comparison, ${m.label.toLowerCase()}`), sub: `${IL(act)}, %` });
      grid.append(c2.node);
      const s2 = all.map((c, i) => ({ name: AL(c), code: c, color: t.series[i], data: sers[i], width: c === K ? 2.5 : 2, z: c === K ? 5 : 2, endLabel: c === K }));
      lineChart(c2.chart, { years: S.countries.years, series: s2, fmt: m.fmt, endLabels: false });
      c2.table(...yearTable(s2, S.countries.years, fmtPct), { sortKey: 'year' });

      const focusSet = new Set(S.meta.focus.map(f => f.code));
      const manu = S.meta.detail_acts.filter(c => c.startsWith('C') && prof.data[c]);
      const mrows = manu.map(c => ({ code: c, name: IL(c), back: valAt(prof.data[c].back, y), fwd: valAt(prof.data[c].fwd, y), gvc: valAt(prof.data[c].gvc, y),
        EXGR: valAt(prof.data[c].EXGR, y), rca: valAt(prof.data[c].rca, y), ms: valAt(prof.data[c].ms, y) })).filter(r => ok(r.gvc)).sort((a, b) => b.gvc - a.gvc);
      const c3 = card({ span: 7, title: tr(`제조업 세부 산업별 후방·전방 참여율 (${yl(y)})`, `Backward and forward participation by manufacturing industry (${y})`), sub: tr('중점 산업은 굵게 표시, 해당 산업 총수출 대비 %', 'Focus industries in bold, % of the industry’s gross exports'), size: 'tall' });
      grid.append(c3.node);
      hbarChart(c3.chart, { cats: mrows.map(r => ({ code: r.code, label: r.name })), stacked: true, highlight: c => focusSet.has(c),
        series: [{ name: M('back').label, color: t.series[0], data: mrows.map(r => r.back) }, { name: M('fwd').label, color: t.series[1], data: mrows.map(r => r.fwd) }] });
      c3.table([{ key: 'name', label: tr('산업', 'Industry'), left: true }, { key: 'EXGR', label: `${M('EXGR').label} (${moneyUnit()})`, fmt: fmtMoneyNum }, { key: 'back', label: M('back').label, fmt: fmtPct },
        { key: 'fwd', label: M('fwd').label, fmt: fmtPct }, { key: 'gvc', label: M('gvc').label, fmt: fmtPct }, { key: 'ms', label: M('ms').label, fmt: fmtPct }], mrows, { sortKey: 'gvc' });

      const all50 = S.meta.detail_acts.filter(c => prof.data[c]).map(c => ({ code: c, name: IL(c), rca: valAt(prof.data[c].rca, y), EXGR: valAt(prof.data[c].EXGR, y) }))
        .filter(r => ok(r.rca) && ok(r.EXGR) && r.EXGR > 0).sort((a, b) => b.rca - a.rca);
      const c4 = card({ span: 5, title: tr(`부가가치 기준 RCA 상위 15개 산업 (${yl(y)})`, `Top 15 industries by value-added RCA (${y})`), sub: tr('중점 산업 강조, 기준선 1', 'Focus industries highlighted, reference line at 1'), size: 'tall' });
      grid.append(c4.node);
      const r15 = all50.slice(0, 15);
      hbarChart(c4.chart, { cats: r15.map(r => ({ code: r.code, label: r.name })), fmt: fmtRca, refLine: 1, highlight: c => focusSet.has(c),
        series: [{ name: 'RCA', data: r15.map(r => r.rca), colors: r15.map(r => (focusSet.has(r.code) ? t.accent : t.deemph)), color: t.deemph }] });
      c4.table([{ key: 'name', label: tr('산업', 'Industry'), left: true }, { key: 'rca', label: 'RCA', fmt: fmtRca }, { key: 'EXGR', label: `${M('EXGR').label} (${moneyUnit()})`, fmt: fmtMoneyNum }], all50, { sortKey: 'rca' });

      if (!pk || !pk.data.DEXFVApSH[act]) {
        grid.append(el('section', { class: 'card span-12' }, el('p', { class: 'empty', text: tr('상대국별 자료가 없습니다.', 'No partner data.') })));
        return;
      }
      const src = sourceStack(pk, 'DEXFVApSH', act, pk.partners, pk.years, 7, [K]);
      const c5 = card({ span: 7, title: tr(`해외부가가치 원천 구성 (${IL(act)})`, `Sources of foreign value added (${IL(act)})`), sub: tr('원천 경제별, 한국 총수출 대비 %', 'By source economy, % of Korean gross exports') });
      grid.append(c5.node);
      columnChart(c5.chart, { cats: pk.years.map(String), series: src });
      c5.table([{ key: 'name', label: tr('원천 경제', 'Source economy'), left: true }, ...pk.years.map((yy, i) => ({ key: 'y' + i, label: String(yy), fmt: fmtPct }))],
        src.map(x => Object.fromEntries([['name', x.name], ...x.data.map((v, i) => ['y' + i, v])])), { sortKey: 'y' + (pk.years.length - 1) });

      const keySrc = ['CHN', 'JPN', 'USA', 'DEU'].filter(c => pk.partners.includes(c));
      const c6 = card({ span: 5, title: tr('주요 원천 경제 의존도 추이', 'Reliance on main source economies'), sub: tr('해당 경제에서 온 부가가치, 한국 총수출 대비 %', 'Value added from each economy, % of Korean gross exports') });
      grid.append(c6.node);
      const s6 = keySrc.map((c, i) => ({ name: AL(c), code: c, color: t.series[i], data: pk.years.map((yy, yi) => (pk.data.DEXFVApSH[act][yi] || [])[pk.partners.indexOf(c)]) }));
      lineChart(c6.chart, { years: pk.years, series: s6, fmt: fmtPct });
      c6.table(...yearTable(s6, pk.years, fmtPct), { sortKey: 'year' });

      const py = partnerYearFor(y, pk.years), pyi = pk.years.indexOf(py);
      const ex = pk.data.EXGR[act][pyi] || [], fd = pk.data.FFD_DVA[act][pyi] || [];
      const exT = sum(ex.filter((x, i) => pk.partners[i] !== K)), fdT = sum(fd.filter((x, i) => pk.partners[i] !== K));
      const dest = pk.partners.map((p, i) => ({ p, ex: ok(ex[i]) && exT ? ex[i] / exT * 100 : null, fd: ok(fd[i]) && fdT ? fd[i] / fdT * 100 : null }))
        .filter(o => o.p !== K && ok(o.ex)).sort((a, b) => b.ex - a.ex);
      const c7 = card({ span: 7, title: tr(`수출 대상 구성, 총수출과 부가가치 기준 (${py}년)`, `Export destinations, gross and value added terms (${py})`), sub: tr('상위 10개 상대국, 각 기준 합계 대비 %', 'Top 10 partners, % of each total'), size: 'tall' });
      grid.append(c7.node);
      hbarChart(c7.chart, { cats: dest.slice(0, 10).map(o => ({ code: o.p, label: AL(o.p) })),
        series: [{ name: tr('총수출 기준', 'Gross exports'), color: t.series[0], data: dest.slice(0, 10).map(o => o.ex) },
          { name: tr('최종수요 부가가치 기준', 'Value added in final demand'), color: t.series[1], data: dest.slice(0, 10).map(o => o.fd) }] });
      c7.table([{ key: 'name', label: tr('상대국', 'Partner'), left: true }, { key: 'ex', label: tr('총수출 기준', 'Gross exports'), fmt: fmtPct }, { key: 'fd', label: tr('최종수요 부가가치 기준', 'Value added in final demand'), fmt: fmtPct }],
        dest.map(o => ({ name: AL(o.p), ex: o.ex, fd: o.fd })), { sortKey: 'ex' });

      const fw = pk.data.FEXDVApSH[act][pyi] || [];
      const fwRank = pk.partners.map((p, i) => ({ p, v: fw[i] })).filter(o => ok(o.v) && o.p !== K).sort((a, b) => b.v - a.v);
      const c8 = card({ span: 5, title: tr(`한국 부가가치가 체화된 제3국 수출 (${py}년)`, `Third-country exports embodying Korean value added (${py})`), sub: tr('전방 연계 상위 10개 경제, 원천 산업 기준, 한국 해당 산업 총수출 대비 %', 'Top 10 economies, source industry basis, % of Korean gross exports in the industry'), size: 'tall' });
      grid.append(c8.node);
      hbarChart(c8.chart, { cats: fwRank.slice(0, 10).map(o => ({ code: o.p, label: AL(o.p) })), series: [{ name: tr('전방 연계', 'Forward linkage'), color: t.series[0], data: fwRank.slice(0, 10).map(o => o.v) }] });
      c8.table([{ key: 'name', label: tr('수출 경제', 'Exporting economy'), left: true }, { key: 'v', label: tr('한국 총수출 대비', 'Share of Korean gross exports'), fmt: fmtPct }], fwRank.map(o => ({ name: AL(o.p), v: o.v })), { sortKey: 'v' });
    });
  }

  // ---------------------------------------------------------------- 지역
  async function viewRegion(root, rid) {
    const R = S.meta.regions[rid];
    if (!R) { root.append(el('p', { class: 'empty', text: tr('지역 정의가 없습니다.', 'Region not defined.') })); return; }
    const D = S.countries.data;
    const st = S.state[rid] = S.state[rid] || { act: S.meta.acts.includes(R.default_activity) ? R.default_activity : '_T', year: S.meta.latest, metric: 'back', sel: null };
    if (!st.sel) {
      st.sel = [...R.members].filter(c => D[c] && D[c]._T).sort((a, b) => (valAt(D[b]._T.EXGR, S.meta.latest) || 0) - (valAt(D[a]._T.EXGR, S.meta.latest) || 0)).slice(0, 6);
    }
    const isEU = R.id === 'EU';
    const sg = R.subgroups || null;
    const sgOf = c => (sg ? Object.entries(sg).find(([, v]) => v.includes(c))?.[0] : null);
    const memberText = R.members.map(AL).join(', ');
    root.append(head(RL(R) + (isEU ? tr(' (EU27 회원국)', ' (EU27 members)') : ''),
      tr(`${memberText}. ${RN(R) ? RN(R) + ' ' : ''}지역 지표는 회원국 값을 합산해 계산하므로 회원국 간 교역이 포함됩니다.${R.official ? ` TiVA가 제공하는 ${AL(R.official)} 집계는 역외 교역 기준으로 함께 표시합니다.` : ''}`,
        `${memberText}. ${RN(R) ? RN(R) + ' ' : ''}Regional indicators sum the members’ values and therefore include trade among members.${R.official ? ` The ${AL(R.official)} aggregate from TiVA, which covers extra-regional trade only, is shown for reference.` : ''}`)));
    await viewShell(root, st, update => filtersRow(
      selectFilter(tr('산업', 'Industry'), null, st.act, v => { st.act = v; update(); }, { groups: actGroups() }),
      selectFilter(tr('기준 연도', 'Year'), yearOptions(), st.year, v => { st.year = +v; update(); }),
      selectFilter(tr('지도·회원국 지표', 'Map and member indicator'), ['back', 'fwd', 'gvc', 'dva_sh', 'int_sh', 'ms', 'rca'].map(k => ({ value: k, label: M(k).label })), st.metric, v => { st.metric = v; update(); }),
      chipPicker(tr('추이 비교 회원국', 'Members in the trend chart'), R.members, st, 'sel', 8, update)),
    async (body, tok) => {
      const act = st.act, y = st.year;
      const [ind, prof, pr, off] = await Promise.all([getJSON(`industry/${act}.json`), getJSON(`profile/${rid}.json`),
        tryJSON(`partner/${rid}.json`), R.official ? tryJSON(`profile/${R.official}.json`) : null, loadGeo()]);
      if (stale(tok)) return;
      const t = tokens();
      const yi = ind.years.indexOf(y), b0 = baseYear(y);
      const rv = m => (ind.data[rid] && ind.data[rid][m] ? ind.data[rid][m] : ind.years.map(() => null));
      const note = focusNote(act);
      if (note) body.append(el('div', { class: 'banner', text: note }));

      let intra = null, intraSeries = null, py = null, pyi = -1;
      if (pr && pr.data.DEXFVApSH[act]) {
        py = partnerYearFor(y, pr.years); pyi = pr.years.indexOf(py);
        const share = yi2 => {
          const row = pr.data.DEXFVApSH[act][yi2] || [];
          const tot = sum(row), inn = sum(row.filter((v, i) => R.members.includes(pr.partners[i])));
          return tot > 0 ? inn / tot * 100 : null;
        };
        intraSeries = pr.years.map((yy, i) => share(i));
        intra = intraSeries[pyi];
      }
      const bIdx = ind.years.indexOf(b0);
      body.append(tiles([
        { label: tr(`회원국 합계 총수출 (${yl(y)})`, `Members’ gross exports (${y})`), value: fmtMoneyNum(rv('EXGR')[yi]), unit: moneyUnit(), delta: tr(`세계 점유율 ${fmtPct(rv('ms')[yi])}`, `${fmtPct(rv('ms')[yi])} of world exports`) },
        { label: M('back').label, value: fmtPct(rv('back')[yi]), delta: ok(rv('back')[bIdx]) ? tr(`${b0}년 대비 ${fmtPp(rv('back')[yi] - rv('back')[bIdx])}`, `${fmtPp(rv('back')[yi] - rv('back')[bIdx])} since ${b0}`) : '' },
        { label: M('fwd').label, value: fmtPct(rv('fwd')[yi]), delta: tr('제3국 수출 체화분 합계 ÷ 총수출 합계', 'sum of third-country embodiment over sum of exports') },
        { label: M('rca').label, value: fmtRca(rv('rca')[yi]), delta: act === '_T' ? tr('전 산업은 1', 'equals 1 for all industries') : tr('세계 대비 특화 정도', 'specialisation relative to the world') },
        { label: tr(`역내 조달 비중${py ? ` (${py}년)` : ''}`, `Intra-regional sourcing${py ? ` (${py})` : ''}`), value: intra != null ? fmtPct(intra) : DASH, delta: tr('해외부가가치 중 회원국에서 온 비중', 'share of foreign value added from members') },
      ]));
      const grid = el('div', { class: 'grid' });
      body.append(grid);

      // 지역 지도
      const m = M(st.metric);
      const mapVals = {};
      R.members.forEach(c => { const x = ind.data[c] && ind.data[c][st.metric] ? ind.data[c][st.metric][yi] : null; if (ok(x)) mapVals[c] = x; });
      const cm = card({ span: 12, title: tr(`회원국 ${m.label} 지도 (${IL(act)}, ${yl(y)})`, `${m.label} across members (${IL(act)}, ${y})`), sub: m.desc ? m.desc.charAt(0).toUpperCase() + m.desc.slice(1) : '', size: 'map-short', note: mapNote() });
      grid.append(cm.node);
      mapChart(cm.chart, { values: mapVals, label: m.label, fmt: m.fmt, kind: st.metric === 'rca' ? 'rca' : 'seq', rid });
      cm.table([{ key: 'name', label: tr('경제', 'Economy'), left: true }, { key: 'v', label: m.label, fmt: m.fmt }],
        Object.entries(mapVals).map(([c, x]) => ({ name: AL(c), v: x })), { sortKey: 'v' });

      const s1 = [{ name: M('back').label, code: 'back', color: t.series[0], data: rv('back') }, { name: M('fwd').label, code: 'fwd', color: t.series[1], data: rv('fwd') }];
      if (off && off.data[act]) s1.push({ name: tr(`${AL(R.official)} 집계 후방`, `${AL(R.official)} backward`), code: 'off', color: t.series[2], data: off.data[act].back, short: tr('공식 집계 후방', 'Official aggregate') });
      const c1 = card({ span: 6, title: tr(`지역 GVC 참여율 추이 (${IL(act)})`, `Regional GVC participation (${IL(act)})`), sub: tr('회원국 합계 기준, 총수출 대비 %', 'Sum of members, % of gross exports') });
      grid.append(c1.node);
      lineChart(c1.chart, { years: ind.years, series: s1, endLabels: s1.length <= 2 });
      c1.table(...yearTable(s1, ind.years, fmtPct), { sortKey: 'year' });

      const c2 = card({ span: 6, title: tr(`회원국 ${m.label} 추이`, `${m.label} of selected members`), sub: `${IL(act)}${m.unit ? ', ' + m.unit : ''}` });
      grid.append(c2.node);
      const s2 = st.sel.filter(c => ind.data[c]).map(c => ({ name: AL(c), code: c, color: t.series[st.selSlots[c]], data: ind.data[c][st.metric] }));
      if (s2.length) {
        lineChart(c2.chart, { years: ind.years, series: s2, fmt: m.fmt });
        c2.table(...yearTable(s2, ind.years, m.fmt), { sortKey: 'year' });
      } else c2.empty(tr('위의 칩에서 회원국을 고르세요.', 'Choose members with the chips above.'));

      const rexg = rv('EXGR')[yi];
      const mrows = R.members.filter(c => ind.data[c]).map(c => {
        const g = (k) => ind.data[c][k][yi];
        return { code: c, name: AL(c), sg: sgOf(c) ? SGL(R, sgOf(c)) : null, EXGR: g('EXGR'), rshare: ok(g('EXGR')) && rexg ? g('EXGR') / rexg * 100 : null,
          ms: g('ms'), back: g('back'), fwd: g('fwd'), gvc: g('gvc'), dva_sh: g('dva_sh'), int_sh: g('int_sh'), rca: g('rca') };
      });
      const cols = [{ key: 'name', label: tr('경제', 'Economy'), left: true }];
      if (sg) cols.push({ key: 'sg', label: tr('권역', 'Sub-region'), left: true });
      cols.push({ key: 'EXGR', label: `${M('EXGR').label} (${moneyUnit()})`, fmt: fmtMoneyNum }, { key: 'rshare', label: tr('지역 내 비중', 'Share of region'), fmt: fmtPct }, { key: 'ms', label: M('ms').label, fmt: fmtPct },
        { key: 'back', label: M('back').label, fmt: fmtPct }, { key: 'fwd', label: M('fwd').label, fmt: fmtPct }, { key: 'gvc', label: M('gvc').label, fmt: fmtPct },
        { key: 'dva_sh', label: M('dva_sh').label, fmt: fmtPct }, { key: 'int_sh', label: M('int_sh').label, fmt: fmtPct }, { key: 'rca', label: 'RCA', fmt: fmtRca });
      grid.append(el('section', { class: 'card span-12' },
        el('div', { class: 'card-head' }, el('div', {}, el('h3', { text: tr(`회원국 지표 (${yl(y)}, ${IL(act)})`, `Member indicators (${y}, ${IL(act)})`) }), el('p', { class: 'sub', text: tr('열 제목을 누르면 정렬합니다.', 'Select a column heading to sort.') }))),
        el('div', { class: 'table-wrap' }, makeTable(cols, mrows, { sortKey: 'EXGR', highlight: r => st.sel.includes(r.code) }))));

      const T = prof.data._T;
      const dvaT = T ? valAt(T.EXGR_DVA, y) : null;
      const comp = S.meta.detail_acts.filter(c => prof.data[c]).map(c => ({ code: c, name: IL(c), share: ok(valAt(prof.data[c].EXGR_DVA, y)) && dvaT ? valAt(prof.data[c].EXGR_DVA, y) / dvaT * 100 : null,
        rca: valAt(prof.data[c].rca, y), back: valAt(prof.data[c].back, y) })).filter(r => ok(r.share));
      const byShare = [...comp].sort((a, b) => b.share - a.share);
      const c3 = card({ span: 6, title: tr(`수출 국내부가가치의 산업 구성 (${yl(y)})`, `Industry composition of domestic value added in exports (${y})`), sub: tr('상위 12개 산업, 전 산업 합계 대비 %', 'Top 12 industries, % of the all-industry total'), size: 'tall' });
      grid.append(c3.node);
      if (byShare.length) {
        const top12 = byShare.slice(0, 12);
        hbarChart(c3.chart, { cats: top12.map(r => ({ code: r.code, label: r.name })), highlight: c => c === act,
          series: [{ name: tr('비중', 'Share'), color: t.series[0], data: top12.map(r => r.share), extra: top12.map(r => `RCA ${fmtRca(r.rca)}`) }] });
        c3.table([{ key: 'name', label: tr('산업', 'Industry'), left: true }, { key: 'share', label: tr('비중', 'Share'), fmt: fmtPct }, { key: 'rca', label: 'RCA', fmt: fmtRca }, { key: 'back', label: M('back').label, fmt: fmtPct }], byShare, { sortKey: 'share' });
      } else c3.empty(tr('자료가 없습니다.', 'No data.'));

      const byRca = comp.filter(r => ok(r.rca) && r.share > 0.1).sort((a, b) => b.rca - a.rca);
      const c4 = card({ span: 6, title: tr(`부가가치 기준 RCA 상위 12개 산업 (${yl(y)})`, `Top 12 industries by value-added RCA (${y})`), sub: tr('수출 국내부가가치 비중 0.1% 이상 산업, 기준선 1', 'Industries above 0.1% of domestic value added in exports, reference line at 1'), size: 'tall' });
      grid.append(c4.node);
      if (byRca.length) {
        const r12 = byRca.slice(0, 12);
        hbarChart(c4.chart, { cats: r12.map(r => ({ code: r.code, label: r.name })), fmt: fmtRca, refLine: 1, highlight: c => c === act,
          series: [{ name: 'RCA', color: t.series[0], data: r12.map(r => r.rca) }] });
        c4.table([{ key: 'name', label: tr('산업', 'Industry'), left: true }, { key: 'rca', label: 'RCA', fmt: fmtRca }, { key: 'share', label: tr('비중', 'Share'), fmt: fmtPct }], byRca, { sortKey: 'rca' });
      } else c4.empty(tr('자료가 없습니다.', 'No data.'));

      if (!pr || !pr.data.DEXFVApSH[act]) {
        grid.append(el('section', { class: 'card span-12' }, el('p', { class: 'empty', text: tr(`역내 조달과 원천 분석은 ${S.meta.partner_acts.map(IL).join(', ')}에서 제공합니다.`, `Intra-regional sourcing and source analysis are available for ${S.meta.partner_acts.map(IL).join(', ')}.`) })));
        return;
      }
      const c5 = card({ span: 5, title: tr('역내 조달 비중 추이', 'Intra-regional sourcing over time'), sub: tr('해외부가가치 중 회원국에서 온 부가가치 비중, %', 'Share of foreign value added from members, %') });
      grid.append(c5.node);
      lineChart(c5.chart, { years: pr.years, series: [{ name: tr('역내 조달 비중', 'Intra-regional sourcing'), code: 'intra', color: t.series[0], data: intraSeries }], endLabels: false });
      c5.table([{ key: 'year', label: tr('연도', 'Year'), left: true, fmt: x => x }, { key: 'v', label: tr('역내 조달 비중', 'Intra-regional sourcing'), fmt: fmtPct }], pr.years.map((yy, i) => ({ year: yy, v: intraSeries[i] })), { sortKey: 'year' });

      const row = pr.data.DEXFVApSH[act][pyi] || [];
      const srcs = pr.partners.map((p, i) => ({ p, v: row[i], inside: R.members.includes(p) })).filter(o => ok(o.v) && o.v > 0).sort((a, b) => b.v - a.v);
      const top12 = srcs.slice(0, 12);
      const c6 = card({ span: 7, title: tr(`해외부가가치의 주요 원천 경제 (${py}년)`, `Main sources of foreign value added (${py})`), sub: tr('회원국 합계 총수출 대비 %, 역내와 역외 구분', '% of members’ gross exports, intra- and extra-regional'), size: 'tall' });
      grid.append(c6.node);
      hbarChart(c6.chart, { cats: top12.map(o => ({ code: o.p, label: AL(o.p) })),
        series: [{ name: tr('역내 원천', 'Intra-regional'), color: t.series[0], data: top12.map(o => (o.inside ? o.v : null)) },
          { name: tr('역외 원천', 'Extra-regional'), color: t.series[1], data: top12.map(o => (o.inside ? null : o.v)) }], stacked: true, labelAll: true });
      c6.table([{ key: 'name', label: tr('원천 경제', 'Source economy'), left: true }, { key: 'kind', label: tr('구분', 'Type'), left: true }, { key: 'v', label: tr('총수출 대비', 'Share of gross exports'), fmt: fmtPct }],
        srcs.map(o => ({ name: AL(o.p), kind: o.inside ? tr('역내', 'Intra') : tr('역외', 'Extra'), v: o.v })), { sortKey: 'v' });
    });
  }

  // ---------------------------------------------------------------- 방법론
  async function viewMethod(root) {
    const m = S.meta;
    const qa = await tryJSON('qa.json');
    const repo = repoUrl();
    const p = (...c) => el('p', {}, ...c);
    const dl = (pairs) => el('dl', {}, pairs.flatMap(([a, b]) => [el('dt', { text: a }), el('dd', { text: b })]));
    root.append(head(tr('방법론과 데이터', 'Methods and data'), tr('지표 정의, 산업·지역 구분, 자동 갱신 방식, 데이터 품질 점검 결과입니다.', 'Indicator definitions, industry and regional groupings, the update process and data quality checks.')));
    const box = el('div', { class: 'card prose' });
    root.append(box);
    const defs = LANG === 'en' ? [
      ['Backward participation', 'Foreign value added as a share of gross exports (EXGR_FVA in Principal Indicators, shares, unit PT_EXGR). It is associated with reliance on imported inputs in export production.'],
      ['Forward participation', 'Value added created by the economy (or by the industry in industry views) that is embodied in third-country exports (IV), divided by gross exports (or the industry’s gross exports). This follows Koopman et al. (2010) and is computed from the EXGRVA dataset as the sum over all other exporting economies. The all-industry value equals the official OECD FEXGR_DVA, which the quality checks confirm. The industry breakdown of FEXGR_DVA refers to the foreign exporting industry and is therefore not used here.'],
      ['GVC participation', 'Backward plus forward participation. Both share the same denominator, the gross exports of the economy or industry, so they can be added. Industries that export little directly but contribute indirectly through other industries (mining, business services) can show forward participation above 100%.'],
      ['Domestic value added share', 'Domestic value added as a share of gross exports (EXGR_DVA, unit PT_EXGR). It adds up to 100% with backward participation.'],
      ['Intermediates share', 'Gross exports of intermediates (EXGR_INT) divided by gross exports (EXGR).'],
      ['World export share', 'An economy’s gross exports in an industry divided by the sum over all TiVA economies, including the rest of the world.'],
      ['Value-added RCA', '(Industry domestic value added in exports / total domestic value added in exports) divided by the same ratio for the world. Values above 1 indicate relative specialisation.'],
      ['Sources of foreign value added', 'From Origin of value added in gross exports (EXGRVA) with all source industries (_T), value added from each source economy in the exporting economy’s or industry’s gross exports, divided by those gross exports (%).'],
      ['Forward linkage by partner', 'From EXGRVA, value added created by the industry that is embodied in each partner’s exports, divided by the industry’s gross exports (%). The sum over partners equals forward participation, which the quality checks confirm.'],
      ['Value added in final demand (FFD_DVA)', 'Domestic value added embodied in partner final demand. Compared with the gross export pattern it indicates value added that reaches final users through third economies.'],
      ['Concentration (HHI, top 3 share)', 'Based on each economy’s share of world gross exports in the industry. The rest of the world (WXD) is not treated as an economy and is excluded.'],
    ] : [
      ['후방 참여율', '총수출에 포함된 해외부가가치의 비중 (Principal Indicators, shares의 EXGR_FVA, 단위 PT_EXGR). 수출 생산에서 수입 중간재에 의존하는 정도와 연관됩니다.'],
      ['전방 참여율', '자국(산업별 화면에서는 해당 산업)이 창출한 부가가치 중 제3국의 수출에 체화된 부분(IV)을 총수출(해당 산업 총수출) 대비로 나타낸 값. Koopman et al. (2010)의 방식으로, EXGRVA에서 자국을 뺀 모든 수출 경제의 합계로 계산합니다. 전 산업 값은 OECD 공식 FEXGR_DVA와 같으며 품질 점검에서 확인합니다. OECD가 제공하는 산업별 FEXGR_DVA는 외국의 해당 산업 수출에 체화된 자국 부가가치를 뜻하므로 여기서는 쓰지 않습니다.'],
      ['GVC 참여율', '후방 참여율과 전방 참여율의 합. 산업별로도 두 값의 분모가 해당 산업 총수출로 같아 더할 수 있습니다. 직접 수출이 작고 다른 산업의 수출을 거쳐 간접적으로 참여하는 산업(광업, 사업서비스 등)은 전방 참여율이 100%를 넘을 수 있습니다.'],
      ['국내부가가치 비중', '총수출에 포함된 국내부가가치의 비중 (EXGR_DVA, 단위 PT_EXGR). 후방 참여율과 합하면 100%입니다.'],
      ['중간재 수출 비중', '중간재 총수출(EXGR_INT)을 총수출(EXGR)로 나눈 값.'],
      ['세계 수출 점유율', '해당 산업에서 개별 경제의 총수출을 TiVA 개별 경제(기타 세계 포함) 총수출 합계로 나눈 값.'],
      ['부가가치 기준 RCA', '(경제의 산업 수출 국내부가가치 / 경제 전체 수출 국내부가가치) ÷ (세계 산업 수출 국내부가가치 / 세계 전체 수출 국내부가가치). 1보다 크면 그 산업 수출에 상대적으로 특화된 것으로 봅니다.'],
      ['해외부가가치 원천', 'Origin of value added in gross exports(EXGRVA)에서 원천 산업 전체(_T)를 기준으로, 수출 경제·산업의 총수출에 들어간 원천 경제별 부가가치를 그 총수출로 나눈 값 (%).'],
      ['전방 연계 (상대 경제별)', 'EXGRVA에서 자국 해당 산업이 창출한 부가가치가 상대 경제의 수출에 체화된 크기를 자국 해당 산업 총수출로 나눈 값 (%). 상대 경제별 합계는 전방 참여율과 같으며 품질 점검에서 확인합니다.'],
      ['최종수요 부가가치 (FFD_DVA)', '상대국 최종수요에 체화된 자국 부가가치. 총수출 기준 상대국 구성과 비교하면 중간 경유지를 거친 부가가치 흐름을 가늠할 수 있습니다.'],
      ['집중도 (HHI, 상위 3개 점유율)', '산업별 세계 총수출에서 개별 경제가 차지하는 비중으로 계산합니다. 기타 세계(WXD)는 하나의 경제로 보지 않아 제외합니다.'],
    ];
    box.append(...[
      el('h3', { text: tr('자료', 'Data') }),
      p(tr(`OECD Trade in Value Added (TiVA) ${m.edition ? m.edition + '년판' : ''}. OECD SDMX API에서 GitHub Actions가 자동으로 내려받습니다. 최신 연도는 ${m.latest}년, 마지막 수집 시점은 ${fmtTime(m.fetched_at)}입니다.`,
        `OECD Trade in Value Added (TiVA)${m.edition ? ', ' + m.edition + ' edition' : ''}. GitHub Actions downloads the data from the OECD SDMX API. The latest year is ${m.latest} and the data were last collected on ${fmtTime(m.fetched_at)}.`)),
      p(tr('사용한 dataflow는 ', 'Dataflows used are ') + (m.flows.map(f => `${f.id} (${f.name})`).join(', ') || tr('기록 없음', 'not recorded')) + '.'),
      m.missing_measures && m.missing_measures.length ? p(tr(`이번 수집에서 찾지 못한 지표 ${m.missing_measures.join(', ')}.`, `Indicators not found in this collection are ${m.missing_measures.join(', ')}.`)) : null,
      el('h3', { text: tr('지표 정의', 'Indicator definitions') }),
      dl(defs),
      el('h3', { text: tr('중점 산업의 대응 관계', 'Focus industries') }),
      p(tr('TiVA는 ISIC Rev.4 기반 50개 산업으로 구성되어 반도체나 이차전지 같은 품목 단위 산업을 따로 분리하지 않습니다. 따라서 아래처럼 해당 산업을 포함하는 TiVA 산업으로 대응시켰고, 결과는 그 산업 전체에 대한 값입니다.',
        'TiVA covers 50 industries based on ISIC Rev.4 and does not separate product-level industries such as semiconductors or batteries. Each focus industry is therefore mapped to the TiVA industry that contains it, and the results refer to that whole industry.')),
      el('ul', {}, m.focus.map(f => el('li', { text: `${FL(f)} → ${IL(f.code)} (${f.code}). ${FN(f)}` }))),
      el('h3', { text: tr('국가군', 'Country groups') }),
      el('ul', {}, el('li', { text: tr(`주요국 비교 = ${m.latest}년 TiVA 부가가치(VALU, 전 산업) 상위 ${m.top.length}개 경제 (${m.top.map(AL).join(', ')})`, `Major economies = the ${m.top.length} largest economies by TiVA value added (VALU, all industries) in ${m.latest} (${m.top.map(AL).join(', ')})`) }),
        Object.values(m.regions).map(r => el('li', { text: `${RL(r)} = ${r.members.map(AL).join(', ')}${RN(r) ? '. ' + RN(r) : ''}` }))),
      p(tr('지역 지표는 회원국 값을 합산해 계산하므로 회원국 간 교역과 부가가치가 포함됩니다. 지역 후방 참여율은 회원국 해외부가가치 합계를 회원국 총수출 합계로 나눈 값이고, 전방 참여율은 회원국 IV 합계를 총수출 합계로 나눈 값입니다. TiVA가 직접 제공하는 EU27, ASEAN 등의 공식 집계는 지역을 하나의 경제로 보아 역외 교역만 반영하므로 회원국 합계와 수준이 다릅니다.',
        'Regional indicators sum the members’ values and therefore include trade and value added among members. Regional backward participation is the members’ combined foreign value added divided by their combined gross exports, and forward participation is their combined IV divided by combined gross exports. Official TiVA aggregates such as EU27 or ASEAN treat the region as a single economy covering extra-regional trade only, so their levels differ from the sum of members.')),
      el('h3', { text: tr('지도', 'Maps') }),
      p(tr('국경은 Natural Earth 1:110m 자료(world-atlas)이며 어떠한 영토의 지위나 경계에 대한 입장도 나타내지 않습니다. 홍콩, 싱가포르, 몰타, 상투메프린시페처럼 이 축척에 없는 경제는 점으로 표시합니다. 색 구간은 값의 5분위로 나누며, RCA와 변화 보기는 기준값(1 또는 0)을 가운데에 둔 양방향 색을 씁니다.',
        'Boundaries come from Natural Earth at 1:110m (world-atlas) and imply no position on the status or delimitation of any territory. Economies too small for this scale, such as Hong Kong, Singapore, Malta and Sao Tome and Principe, are shown as dots. Colour classes are quintiles of the values, and RCA and the change view use a diverging scale centred on 1 or 0.')),
      el('h3', { text: tr('해석상 유의점', 'Notes on interpretation') }),
      el('ul', {},
        el('li', { text: tr('지표는 국가·산업 간 연관성을 보여 주며 인과관계를 뜻하지 않습니다.', 'The indicators describe associations between economies and industries and do not imply causation.') }),
        el('li', { text: tr('TiVA는 국가 간 산업연관표(ICIO) 추정치이므로 판(edition)이 바뀌면 과거 연도 값도 함께 수정될 수 있습니다. 서로 다른 판의 수치를 섞어 비교하지 않는 것이 좋습니다.', 'TiVA is derived from Inter-Country Input-Output tables, so a new edition can revise earlier years as well. Figures from different editions are best not mixed.') }),
        el('li', { text: tr('금액은 명목 미국 달러 기준이며 한국어 화면에서는 억 달러, 영어 화면에서는 십억 달러(USD bn)로 표시합니다.', 'Values are in current US dollars, shown in USD billions in the English view and in 100 million dollars in the Korean view.') }),
        el('li', { text: tr('상대국별 분석은 수집량을 줄이기 위해 선택한 연도와 산업(전 산업, 제조업, 중점 산업)에 한정했습니다. 범위는 config/tiva.yaml에서 바꿀 수 있습니다.', 'Partner-level analysis is limited to selected years and industries (all industries, manufacturing and focus industries) to keep downloads manageable. The scope can be changed in config/tiva.yaml.') })),
      el('h3', { text: tr('자동 갱신', 'Updates') }),
      p(tr('GitHub Actions가 매월 OECD API의 TiVA dataflow 구성과 판 정보를 확인하고, 새 판이 나오거나 설정이 바뀌었을 때만 전체 데이터를 다시 내려받아 이 페이지를 갱신합니다.',
        'GitHub Actions checks the TiVA dataflows and edition on the OECD API every month and downloads the full data again only when a new edition appears or the configuration changes.')),
      repo ? p(tr('원자료와 코드 ', 'Code and processed data are in ') , el('a', { href: repo, text: repo }), tr('. 정리된 데이터는 data/processed 폴더(parquet, 요약 CSV)에 있습니다.', ', with processed data in the data/processed folder (parquet and a summary CSV).')) : null,
    ].filter(Boolean));
    if (qa && qa.checks) {
      box.append(el('h3', { text: tr('데이터 품질 점검', 'Data quality checks') }),
        el('div', { class: 'table-wrap' }, makeTable([
          { key: 'name', label: tr('점검 항목', 'Check'), left: true, sort: false, fmt: (v, r) => (LANG === 'en' ? r.name_en || v : v) },
          { key: 'value', label: tr('결과', 'Result'), fmt: v => Array.isArray(v) ? v.map(x => (typeof x === 'number' ? nf(4).format(x) : x)).join(' / ') : (typeof v === 'number' ? nf(4).format(v) : String(v)), sort: false },
          { key: 'ok', label: tr('판정', 'Status'), fmt: v => (v ? tr('통과', 'Passed') : tr('확인 필요', 'Review')), sort: false },
        ], qa.checks)));
    }
  }
  function fmtTime(s) {
    if (!s) return tr('기록 없음', 'not recorded');
    const d = new Date(s);
    return isNaN(d) ? s : d.toLocaleString(loc(), { dateStyle: 'medium', timeStyle: 'short' });
  }
  function repoUrl() {
    const h = location.hostname, parts = location.pathname.split('/').filter(Boolean);
    if (h.endsWith('.github.io')) return `https://github.com/${h.replace('.github.io', '')}/${parts[0] || ''}`;
    return null;
  }

  // ------------------------------------------------------------------ router
  const VIEWS = {
    map: viewMap, top: viewTopCountries, industry: viewIndustry, korea: viewKorea,
    eu: r => viewRegion(r, 'R_EU'), mideast: r => viewRegion(r, 'R_MIDEAST'), southam: r => viewRegion(r, 'R_SOUTHAM'), asia: r => viewRegion(r, 'R_ASIA'),
    method: viewMethod,
  };
  async function route() {
    const key = (location.hash || '#map').slice(1);
    const name = VIEWS[key] ? key : 'map';
    document.querySelectorAll('#nav a').forEach(a => a.setAttribute('aria-current', a.getAttribute('href') === '#' + name ? 'page' : 'false'));
    disposeAll();
    const root = document.getElementById('view');
    const scrollY = S.view === name ? window.scrollY : 0;
    root.replaceChildren();
    S.view = name;
    try {
      await VIEWS[name](root);
    } catch (e) {
      console.error(e);
      root.append(el('p', { class: 'empty', text: tr('화면을 그리지 못했습니다. ', 'Could not draw this view. ') + e.message }));
    }
    if (scrollY) window.scrollTo(0, scrollY);
  }

  function applyStatic() {
    document.documentElement.lang = LANG;
    document.title = tr('TiVA GVC 대시보드', 'TiVA GVC dashboard');
    document.getElementById('site-title').textContent = tr('TiVA 글로벌 가치사슬 대시보드', 'TiVA global value chain dashboard');
    document.getElementById('site-nav').setAttribute('aria-label', tr('대시보드 영역', 'Dashboard sections'));
    document.querySelectorAll('#nav a').forEach(a => { a.textContent = a.dataset[LANG] || a.textContent; });
    document.querySelectorAll('.lang-tab').forEach(b => b.setAttribute('aria-pressed', String(b.dataset.lang === LANG)));
    document.getElementById('footer-text').textContent = tr(
      '자료 OECD Trade in Value Added (TiVA) Database. 수집과 가공은 이 저장소의 GitHub Actions가 자동으로 수행합니다. 지표는 국가·산업 간 연관성을 보여 주며 인과관계를 뜻하지 않습니다.',
      'Source OECD Trade in Value Added (TiVA) Database. Collection and processing run automatically in this repository’s GitHub Actions. The indicators describe associations between economies and industries and do not imply causation.');
    const m = S.meta;
    if (m) {
      document.getElementById('edition-line').textContent = tr(
        `OECD TiVA ${m.edition ? m.edition + '년판' : ''}, ${m.years[0]}~${m.latest}년, ${m.economies.length}개 경제 · ${m.detail_acts.length}개 산업`,
        `OECD TiVA${m.edition ? ' ' + m.edition + ' edition' : ''}, ${m.years[0]} to ${m.latest}, ${m.economies.length} economies and ${m.detail_acts.length} industries`);
      document.getElementById('build-line').textContent = tr(`데이터 수집 ${fmtTime(m.fetched_at)}`, `Data collected ${fmtTime(m.fetched_at)}`);
    }
    themeLabel();
  }
  function setLang(l) {
    if (l === LANG) return;
    LANG = l;
    try { localStorage.setItem('tiva-lang', l); } catch (e) { /* 저장 불가 */ }
    const u = new URL(location.href);
    u.searchParams.set('lang', l);
    history.replaceState(null, '', u.pathname + u.search + u.hash);
    applyStatic();
    route();
  }

  function themeLabel() {
    const btn = document.getElementById('theme-btn');
    const tv = document.documentElement.dataset.theme;
    btn.textContent = tv === 'dark' ? tr('어두운 화면', 'Dark') : tv === 'light' ? tr('밝은 화면', 'Light') : tr('시스템 설정', 'System');
    btn.setAttribute('aria-label', tr('화면 밝기 전환', 'Switch colour theme'));
  }
  function setupTheme() {
    const btn = document.getElementById('theme-btn');
    btn.addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === 'light' ? 'dark' : cur === 'dark' ? '' : 'light';
      if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
      try { if (next) localStorage.setItem('tiva-theme', next); else localStorage.removeItem('tiva-theme'); } catch (e) { /* 저장 불가 */ }
      themeLabel();
      route();
    });
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!document.documentElement.dataset.theme) route(); });
    document.querySelectorAll('.lang-tab').forEach(b => b.addEventListener('click', () => setLang(b.dataset.lang)));
  }

  async function init() {
    setupTheme();
    applyStatic();
    try {
      [S.meta, S.countries] = await Promise.all([getJSON('meta.json'), getJSON('countries.json')]);
    } catch (e) {
      document.getElementById('view').replaceChildren(
        el('div', { class: 'card prose' }, el('h3', { text: tr('아직 데이터가 없습니다', 'No data yet') }),
          el('p', { text: tr('GitHub Actions의 "TiVA 데이터 갱신" 워크플로가 처음 실행되면 OECD에서 데이터를 받아 이 페이지를 채웁니다.', 'The page fills in once the GitHub Actions workflow has collected the data from the OECD.') }),
          el('p', { class: 'note', text: String(e.message) })));
      return;
    }
    applyStatic();
    window.addEventListener('hashchange', route);
    route();
  }
  init();
})();
