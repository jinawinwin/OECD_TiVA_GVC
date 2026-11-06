/* TiVA GVC 대시보드 (정적 페이지, ECharts) */
'use strict';
(() => {
  const DATA = 'data/';
  const S = { meta: null, countries: null, qa: null, cache: new Map(), charts: [], observers: [], state: {}, token: 0 };

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
      const p = fetch(DATA + path, { cache: 'no-cache' }).then(r => {
        if (!r.ok) throw new Error(`${path} (${r.status})`);
        return r.json();
      });
      p.catch(() => S.cache.delete(path));
      S.cache.set(path, p);
    }
    return S.cache.get(path);
  }
  const tryJSON = path => getJSON(path).catch(() => null);

  const nf0 = new Intl.NumberFormat('ko-KR', { maximumFractionDigits: 0 });
  const nf1 = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const nf2 = new Intl.NumberFormat('ko-KR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const DASH = '-';
  const fmtPct = v => ok(v) ? nf1.format(v) + '%' : DASH;
  const fmtPp = v => ok(v) ? (v > 0 ? '+' : v < 0 ? '−' : '') + nf1.format(Math.abs(v)) + '%p' : DASH;
  const fmtEok = v => ok(v) ? nf0.format(v / 100) : DASH;            // 백만 달러 -> 억 달러
  const fmtUsd = v => ok(v) ? nf0.format(v / 100) + '억 달러' : DASH;
  const fmtRca = v => ok(v) ? nf2.format(v) : DASH;
  const fmtNum = v => ok(v) ? nf0.format(v) : DASH;
  const axisFmt = v => (Math.abs(v) >= 1000 ? nf0.format(v) : String(+Number(v).toFixed(4)));
  const cagr = (a, b, n) => ok(a) && ok(b) && a > 0 && b > 0 && n > 0 ? (Math.pow(b / a, 1 / n) - 1) * 100 : null;

  const AL = c => (S.meta.labels.area[c] || c);
  const IL = c => (S.meta.labels.activity[c] || c);

  const METRICS = {
    back: { label: '후방 참여율', unit: '%', fmt: fmtPct, desc: '총수출 중 해외부가가치 비중' },
    fwd: { label: '전방 참여율', unit: '%', fmt: fmtPct, desc: '제3국 수출에 체화된 자국 부가가치, 총수출 대비' },
    gvc: { label: 'GVC 참여율', unit: '%', fmt: fmtPct, desc: '후방 참여율 + 전방 참여율' },
    dva_sh: { label: '국내부가가치 비중', unit: '%', fmt: fmtPct, desc: '총수출 중 국내부가가치 비중' },
    int_sh: { label: '중간재 수출 비중', unit: '%', fmt: fmtPct, desc: '총수출 중 중간재 비중' },
    EXGR: { label: '총수출', unit: '억 달러', fmt: fmtUsd, scale: 0.01 },
    EXGR_DVA: { label: '수출 국내부가가치', unit: '억 달러', fmt: fmtUsd, scale: 0.01 },
    VALU: { label: '부가가치', unit: '억 달러', fmt: fmtUsd, scale: 0.01 },
    ms: { label: '세계 수출 점유율', unit: '%', fmt: fmtPct },
    rca: { label: '부가가치 기준 RCA', unit: '', fmt: fmtRca },
  };

  // ------------------------------------------------------------------ theme tokens
  function tokens() {
    const cs = getComputedStyle(document.documentElement);
    const v = n => cs.getPropertyValue(n).trim();
    return {
      surface: v('--surface'), text: v('--text-primary'), text2: v('--text-secondary'), muted: v('--axis-muted'),
      grid: v('--grid'), base: v('--baseline'), deemph: v('--deemph'), accent: v('--accent'), border: v('--border'),
      series: [1, 2, 3, 4, 5, 6, 7, 8].map(i => v('--s' + i)), seq: [0, 1, 2, 3, 4].map(i => v('--seq-' + i)),
      font: v('--font'),
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
    const ro = new ResizeObserver(() => c.resize());
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
      const iw = 14 + 6 + String(n).length * 12 + 14;
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
      grid: { left: 4, right: anyEnd ? 84 : 18, top: legendTop(node, series.map(x => x.name), series.length >= 2) + 8, bottom: 4, containLabel: true },
      tooltip: {
        ...tooltipBase(t), trigger: 'axis',
        axisPointer: { type: 'line', lineStyle: { color: t.base, width: 1 } },
        formatter: ps => {
          const rows = ps.filter(p => ok(p.value)).sort((a, b) => b.value - a.value)
            .map(p => tipRow(p.color, fmt(p.value), p.seriesName, t));
          return `<div style="color:${t.text2};margin-bottom:2px">${esc(ps[0].axisValueLabel)}년</div>${rows.join('') || '자료 없음'}`;
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
      grid: { left: 4, right: 56, top: series.length >= 2 && !series[0].noLegend ? legendTop(node, series.map(x => x.name), true) : 10, bottom: 4, containLabel: true },
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
          return `<div style="color:${t.text2};margin-bottom:2px">${esc(ps[0].axisValueLabel)} · 합계 ${esc(fmt(total))}</div>${rows.join('')}`;
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
      series: [mk(rest, t.deemph, '그 외'), mk(hi, t.accent, hi.length === 1 ? hi[0].label : '강조')],
    });
    return c;
  }

  function heatmapChart(node, { rows, cols, matrix, fmt = fmtPct }) {
    const t = tokens();
    const c = mount(node);
    let max = 0;
    matrix.forEach(r => r.forEach(v => { if (ok(v)) max = Math.max(max, v); }));
    // 칸 색의 명도에 따라 글자색을 흰색 또는 검정으로 (어두운 화면에서는 값이 클수록 칸이 밝다)
    const darkUI = tokens().seq[4].toLowerCase() === '#cde2fb';
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
        formatter: p => `<div style="color:${t.text2}">${esc(rows[p.value[1]].label)} 수출의 ${esc(cols[p.value[0]].label)} 부가가치</div><b>${esc(fmt(p.value[2]))}</b> <span style="color:${t.text2}">총수출 대비</span>` },
      xAxis: { type: 'category', data: cols.map(x => x.label), ...axisCommon(t), splitLine: { show: false }, axisLine: { show: false },
        axisLabel: { ...axisCommon(t).axisLabel, color: t.text2, interval: 0, rotate: 30 } },
      yAxis: { type: 'category', data: rows.map(x => x.label), inverse: true, ...axisCommon(t), splitLine: { show: false }, axisLine: { show: false },
        axisLabel: { ...axisCommon(t).axisLabel, color: t.text2, fontSize: 12 } },
      visualMap: { min: 0, max: max || 1, calculable: false, orient: 'horizontal', left: 'center', bottom: 0, itemHeight: 160, itemWidth: 10,
        inRange: { color: t.seq }, text: [fmt(max), '0'], textStyle: { color: t.muted, fontSize: 11 } },
      series: [{ type: 'heatmap', data, itemStyle: { borderColor: t.surface, borderWidth: 2, borderRadius: 3 },
        label: { show: true, fontSize: 10, formatter: p => nf1.format(p.value[2]) },
        emphasis: { itemStyle: { borderColor: t.text, borderWidth: 1 } } }],
    });
    return c;
  }

  // ------------------------------------------------------------------ UI pieces
  function card({ span = 6, title, sub, note, size = '' }) {
    const chart = el('div', { class: `chart ${size}`, role: 'img', 'aria-label': title });
    const tableBox = el('div', { class: 'table-wrap scroll-y', hidden: true });
    const btn = el('button', { class: 'table-toggle', type: 'button', 'aria-expanded': 'false', text: '표 보기' });
    btn.addEventListener('click', () => {
      const open = tableBox.hidden;
      tableBox.hidden = !open;
      btn.setAttribute('aria-expanded', String(open));
      btn.textContent = open ? '표 닫기' : '표 보기';
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
        if (!ok(x) && !ok(y)) return 0;
        if (!ok(x)) return 1;
        if (!ok(y)) return -1;
        return typeof x === 'string' ? dir * x.localeCompare(y, 'ko') : dir * (x - y);
      }) : rows;
      thead.replaceChildren(el('tr', {}, columns.map(c => {
        const th = el('th', { class: (c.left ? 'left ' : '') + (c.sort !== false ? 'sortable' : ''), scope: 'col',
          'aria-sort': key === c.key ? (dir < 0 ? 'descending' : 'ascending') : null }, c.label + (key === c.key ? (dir < 0 ? ' ↓' : ' ↑') : ''));
        if (c.sort !== false) th.addEventListener('click', () => { if (key === c.key) dir = -dir; else { key = c.key; dir = c.left ? 1 : -1; } render(); });
        return th;
      })));
      tbody.replaceChildren(...sorted.map(r => {
        const tr = el('tr', { class: highlight && highlight(r) ? 'hl' : null });
        if (onRow) { tr.style.cursor = 'pointer'; tr.addEventListener('click', () => onRow(r)); }
        columns.forEach(c => {
          const td = el('td', { class: c.left ? 'left' : null });
          if (c.swatch && r._color) td.append(el('span', { class: 'swatch', style: `background:${r._color}` }));
          td.append(document.createTextNode(c.fmt ? c.fmt(r[c.key], r) : (r[c.key] ?? DASH)));
          tr.append(td);
        });
        return tr;
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

  // 국가 선택 칩: 선택 순서대로 색 슬롯을 고정한다 (다른 국가를 빼도 색이 바뀌지 않음)
  function chipPicker(label, codes, st, key, max, onChange) {
    st[key + 'Slots'] = st[key + 'Slots'] || {};
    const slots = st[key + 'Slots'];
    st[key].forEach(c => { if (slots[c] == null) slots[c] = firstFree(slots, max); });
    const t = tokens();
    const wrap = el('div', { class: 'chips', role: 'group', 'aria-label': label }, el('span', { class: 'chips-label', text: `${label} (최대 ${max}개)` }));
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
  function yearOptions() { return [...S.countries.years].reverse().map(y => ({ value: y, label: `${y}년` })); }
  function actGroups(include) {
    const m = S.meta;
    const has = c => m.acts.includes(c) && (!include || include.includes(c));
    const focus = m.focus.filter(f => has(f.code)).map(f => ({ value: f.code, label: `${f.label} (${f.code})` }));
    const aggr = ['_T', 'C', 'BTE', 'GTT', 'A', 'B', 'D_E', 'F'].filter(has).map(c => ({ value: c, label: IL(c) }));
    const manu = m.detail_acts.filter(c => c.startsWith('C') && has(c)).map(c => ({ value: c, label: `${IL(c)} (${c})` }));
    const prim = m.detail_acts.filter(c => /^[AB]/.test(c) && has(c)).map(c => ({ value: c, label: `${IL(c)} (${c})` }));
    const serv = m.detail_acts.filter(c => /^[D-T]/.test(c) && has(c)).map(c => ({ value: c, label: `${IL(c)} (${c})` }));
    return [{ label: '중점 산업', options: focus }, { label: '집계', options: aggr }, { label: '제조업 세부', options: manu },
      { label: '농림어업·광업', options: prim }, { label: '서비스·기타', options: serv }].filter(g => g.options.length);
  }
  function focusNote(act) {
    const f = S.meta.focus.find(x => x.code === act);
    return f ? `${f.label} = ${IL(act)} (${act}). ${f.note}` : null;
  }

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
    series.push({ name: '기타', code: 'OTHER', color: t.deemph, data: other });
    return series;
  }

  // ------------------------------------------------------------------ views
  // 필터 줄과 본문을 함께 다시 그리는 공통 틀
  function viewShell(root, st, buildFilters, renderBody) {
    let filters = buildFilters(update);
    const body = el('div');
    root.append(filters, body);
    function update() {
      disposeAll();
      const nf = buildFilters(update);
      filters.replaceWith(nf);
      filters = nf;
      body.replaceChildren();
      const tok = ++S.token;
      Promise.resolve(renderBody(body, tok)).catch(err => {
        console.error(err);
        body.append(el('p', { class: 'empty', text: '데이터를 불러오지 못했습니다. ' + err.message }));
      });
    }
    disposeAll();
    const tok = ++S.token;
    return Promise.resolve(renderBody(body, tok));
  }
  const stale = tok => tok !== S.token;

  // ---------------------------------------------------------------- 주요국 비교
  async function viewTopCountries(root) {
    const top = S.meta.top;
    const st = S.state.top = S.state.top || { year: S.meta.latest, act: '_T', metric: 'gvc', sel: ['KOR', 'USA', 'CHN', 'JPN', 'DEU'] };
    const trendCodes = [...new Set([...top, 'KOR'])];
    st.sel = st.sel.filter(c => trendCodes.includes(c));
    root.append(head(`주요국 비교 (부가가치 상위 ${top.length}개 경제)`,
      `TiVA 부가가치(VALU, 전 산업) 기준 ${S.meta.latest}년 상위 ${top.length}개 경제의 GVC 참여 구조를 비교합니다. 후방 참여율은 총수출 중 해외부가가치 비중, 전방 참여율은 제3국 수출에 체화된 자국 부가가치의 총수출 대비 비중입니다.`));
    await viewShell(root, st, update => filtersRow(
      selectFilter('기준 연도', yearOptions(), st.year, v => { st.year = +v; update(); }),
      selectFilter('산업 범위', [{ value: '_T', label: '전 산업' }, { value: 'C', label: '제조업' }], st.act, v => { st.act = v; update(); }),
      selectFilter('추이 지표', ['gvc', 'back', 'fwd', 'dva_sh', 'int_sh', 'EXGR'].map(k => ({ value: k, label: METRICS[k].label })), st.metric, v => { st.metric = v; update(); }),
      chipPicker('추이 비교 경제', trendCodes, st, 'sel', 8, update)), (body) => {
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
        { label: `${top.length}개 경제의 세계 총수출 비중`, value: fmtPct(topEx / worldEx * 100), delta: `${IL(a)}, ${y}년` },
        { label: '가중평균 후방 참여율', value: fmtPct(wavg('back')), delta: '총수출 가중' },
        { label: '가중평균 전방 참여율', value: fmtPct(wavg('fwd')), delta: '총수출 가중' },
        { label: 'GVC 참여율 최고 경제', value: best ? best.name : DASH, delta: best ? fmtPct(best.gvc) : '' },
      ]));
      const grid = el('div', { class: 'grid' });
      body.append(grid);
      const t = tokens();

      const byGvc = [...rows].filter(r => ok(r.gvc)).sort((p, q) => q.gvc - p.gvc);
      const c1 = card({ span: 7, title: `GVC 참여율 구성 (${y}년)`, sub: `${IL(a)}, 총수출 대비 %`, size: 'tall' });
      grid.append(c1.node);
      hbarChart(c1.chart, {
        cats: byGvc.map(r => ({ code: r.code, label: r.name })), stacked: true, highlight: c => c === 'KOR',
        series: [{ name: '후방 참여율', color: t.series[0], data: byGvc.map(r => r.back) },
          { name: '전방 참여율', color: t.series[1], data: byGvc.map(r => r.fwd) }],
      });
      c1.table([{ key: 'name', label: '경제', left: true }, { key: 'back', label: '후방', fmt: fmtPct }, { key: 'fwd', label: '전방', fmt: fmtPct }, { key: 'gvc', label: 'GVC', fmt: fmtPct }], byGvc, { sortKey: 'gvc' });

      const c2 = card({ span: 5, title: '후방·전방 참여율 분포', sub: `${y}년, 한국 강조`, size: 'tall' });
      grid.append(c2.node);
      scatterChart(c2.chart, { points: rows.filter(r => ok(r.back) && ok(r.fwd)).map(r => ({ code: r.code, label: r.name, x: r.back, y: r.fwd })),
        xName: '후방 참여율 (%)', yName: '전방 참여율 (%)', highlight: c => c === 'KOR' });
      c2.table([{ key: 'name', label: '경제', left: true }, { key: 'back', label: '후방', fmt: fmtPct }, { key: 'fwd', label: '전방', fmt: fmtPct }], rows, { sortKey: 'back' });

      const tableCard = el('section', { class: 'card span-12' },
        el('div', { class: 'card-head' }, el('div', {}, el('h3', { text: `주요 경제 지표 (${y}년, ${IL(a)})` }),
          el('p', { class: 'sub', text: `열 제목을 누르면 정렬하고, 행을 누르면 아래 추이 차트에 넣거나 뺍니다. 후방 변화는 ${b0}년 대비입니다.` }))),
        el('div', { class: 'table-wrap' }, makeTable([
          { key: 'name', label: '경제', left: true }, { key: 'VALU', label: '부가가치 (억 달러)', fmt: fmtEok },
          { key: 'EXGR', label: '총수출 (억 달러)', fmt: fmtEok }, { key: 'dva_sh', label: '국내부가가치 비중', fmt: fmtPct },
          { key: 'back', label: '후방 참여율', fmt: fmtPct }, { key: 'fwd', label: '전방 참여율', fmt: fmtPct },
          { key: 'gvc', label: 'GVC 참여율', fmt: fmtPct }, { key: 'int_sh', label: '중간재 수출 비중', fmt: fmtPct },
          { key: 'dback', label: '후방 변화', fmt: fmtPp },
        ], rows, {
          sortKey: 'VALU', highlight: r => r.code === 'KOR' || st.sel.includes(r.code),
          onRow: r => {
            if (st.sel.includes(r.code)) { st.sel = st.sel.filter(c => c !== r.code); delete st.selSlots[r.code]; }
            else if (st.sel.length < 8) { st.sel = [...st.sel, r.code]; st.selSlots[r.code] = firstFree(st.selSlots, 8); }
            route();
          },
        })));
      grid.append(tableCard);

      const m = METRICS[st.metric];
      const c4 = card({ span: 12, title: `${m.label} 추이`, sub: `${IL(a)}, ${m.unit}${m.desc ? ', ' + m.desc : ''}` });
      grid.append(c4.node);
      const ser = st.sel.filter(c => D[c] && D[c][a]).map(c => ({ name: AL(c), code: c, color: t.series[st.selSlots[c]],
        data: D[c][a][st.metric].map(v => (m.scale && ok(v) ? v * m.scale : v)) }));
      if (!ser.length) c4.empty('위의 칩에서 비교할 경제를 고르세요.');
      else {
        lineChart(c4.chart, { years: S.countries.years, series: ser, fmt: m.scale ? (v => nf0.format(v) + '억 달러') : m.fmt, yName: m.unit });
        c4.table([{ key: 'year', label: '연도', left: true, fmt: v => v }, ...ser.map(s => ({ key: s.code, label: s.name, fmt: m.scale ? fmtNum : fmtPct }))],
          S.countries.years.map((yy, i) => Object.fromEntries([['year', yy], ...ser.map(s => [s.code, s.data[i]])])), { sortKey: 'year' });
      }
    });
  }

  // ---------------------------------------------------------------- 산업별 심층
  async function viewIndustry(root) {
    const st = S.state.industry = S.state.industry || { act: S.meta.acts.includes('C26') ? 'C26' : S.meta.acts[0], year: S.meta.latest, base: 'KOR' };
    root.append(head('산업별 심층 분석', '산업을 고르면 세계 수출 규모, 주요 수출 경제, 부가가치 구성, 집중도, 비교우위를 보여 줍니다. 중점 산업은 상대국별 원천·연계 분석을 함께 제공합니다.'));
    const econOpts = [...S.meta.economies].sort((a, b) => AL(a).localeCompare(AL(b), 'ko')).map(c => ({ value: c, label: AL(c) }));
    await viewShell(root, st, update => {
      const focusChips = el('div', { class: 'chips', role: 'group', 'aria-label': '중점 산업 바로가기' },
        el('span', { class: 'chips-label', text: '중점 산업' }),
        S.meta.focus.map(f => {
          const b = el('button', { class: 'chip focus-chip', type: 'button', 'aria-pressed': String(st.act === f.code) }, `${f.label}`);
          b.addEventListener('click', () => { st.act = f.code; update(); });
          return b;
        }));
      return filtersRow(
        selectFilter('산업', null, st.act, v => { st.act = v; update(); }, { groups: actGroups() }),
        selectFilter('기준 연도', yearOptions(), st.year, v => { st.year = +v; update(); }),
        selectFilter('기준 경제', econOpts, st.base, v => { st.base = v; update(); }),
        focusChips);
    }, async (body, tok) => {
      const act = st.act, y = st.year, base = st.base;
      const d = await getJSON(`industry/${act}.json`);
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
        { label: `세계 총수출 (${y}년)`, value: fmtEok(wEx), unit: '억 달러', delta: `${b0}년 이후 연평균 ${fmtPct(cagr(d.world.EXGR[bi], wEx, y - b0))}` },
        { label: '상위 3개 경제 점유율', value: fmtPct(d.top3[yi]), delta: `HHI ${fmtNum(d.hhi[yi])}` },
        { label: '세계 후방 참여율', value: fmtPct(d.world_back[yi]), delta: '세계 총수출 중 해외부가가치' },
        { label: `${AL(base)} 수출 점유율`, value: fmtPct(v(base, 'ms')), delta: baseRank ? `세계 ${baseRank}위` : '자료 없음' },
        { label: `${AL(base)} RCA (부가가치 기준)`, value: fmtRca(v(base, 'rca')), delta: '1보다 크면 상대적 특화' },
      ]));
      const grid = el('div', { class: 'grid' });
      body.append(grid);

      // 상위 15개 수출 경제
      const top15 = ranked.slice(0, 15);
      const c1 = card({ span: 7, title: `상위 15개 수출 경제 (${y}년)`, sub: '총수출의 국내·해외 부가가치 구성, 억 달러', size: 'tall' });
      grid.append(c1.node);
      hbarChart(c1.chart, {
        cats: top15.map(c => ({ code: c, label: AL(c) })), stacked: true, highlight: c => c === base, fmt: v => nf0.format(v) + '억 달러',
        series: [{ name: '국내부가가치', color: t.series[0], data: top15.map(c => ok(v(c, 'EXGR_DVA')) ? v(c, 'EXGR_DVA') / 100 : null) },
          { name: '해외부가가치', color: t.series[1], data: top15.map(c => ok(v(c, 'EXGR_FVA')) ? v(c, 'EXGR_FVA') / 100 : null) }],
      });
      c1.table([{ key: 'name', label: '경제', left: true }, { key: 'EXGR', label: '총수출 (억 달러)', fmt: fmtEok },
        { key: 'ms', label: '점유율', fmt: fmtPct }, { key: 'back', label: '후방 참여율', fmt: fmtPct }],
      ranked.map(c => ({ name: AL(c), EXGR: v(c, 'EXGR'), ms: v(c, 'ms'), back: v(c, 'back') })), { sortKey: 'EXGR' });

      // RCA 상위
      const rcaRank = econ.filter(c => ok(v(c, 'rca')) && ok(v(c, 'EXGR')) && v(c, 'EXGR') > 0).sort((a, b) => v(b, 'rca') - v(a, 'rca'));
      let rcaTop = rcaRank.slice(0, 15);
      if (!rcaTop.includes(base) && rcaRank.includes(base)) rcaTop = [...rcaTop, base];
      const c2 = card({ span: 5, title: `부가가치 기준 RCA 상위 경제 (${y}년)`, sub: `${AL(base)} 강조, 기준선 1`, size: 'tall' });
      grid.append(c2.node);
      hbarChart(c2.chart, {
        cats: rcaTop.map(c => ({ code: c, label: AL(c) })), highlight: c => c === base, fmt: fmtRca, refLine: 1,
        series: [{ name: 'RCA', data: rcaTop.map(c => v(c, 'rca')), colors: rcaTop.map(c => (c === base ? t.accent : t.deemph)), color: t.deemph }],
      });
      c2.table([{ key: 'name', label: '경제', left: true }, { key: 'rca', label: 'RCA', fmt: fmtRca }, { key: 'ms', label: '점유율', fmt: fmtPct }],
        rcaRank.map(c => ({ name: AL(c), rca: v(c, 'rca'), ms: v(c, 'ms') })), { sortKey: 'rca' });

      // 점유율 추이
      const trend = [...new Set([...ranked.slice(0, 5), base])].filter(c => d.data[c]);
      const c3 = card({ span: 6, title: '세계 수출 점유율 추이', sub: `${y}년 상위 5개 경제와 ${AL(base)}, %` });
      grid.append(c3.node);
      const tSer = trend.map((c, i) => ({ name: AL(c), code: c, color: t.series[i], data: d.data[c].ms, endLabel: c === base }));
      lineChart(c3.chart, { years: d.years, series: tSer, endLabels: false });
      c3.table([{ key: 'year', label: '연도', left: true, fmt: x => x }, ...tSer.map(s => ({ key: s.code, label: s.name, fmt: fmtPct }))],
        d.years.map((yy, i) => Object.fromEntries([['year', yy], ...tSer.map(s => [s.code, s.data[i]])])), { sortKey: 'year' });

      // 후방·전방 산점도
      const top20 = ranked.slice(0, 20);
      if (!top20.includes(base) && ranked.includes(base)) top20.push(base);
      const c4 = card({ span: 6, title: '상위 수출 경제의 후방·전방 참여율', sub: `${y}년, 수출 상위 20개 경제` });
      grid.append(c4.node);
      scatterChart(c4.chart, { points: top20.filter(c => ok(v(c, 'back')) && ok(v(c, 'fwd'))).map(c => ({ code: c, label: AL(c), x: v(c, 'back'), y: v(c, 'fwd') })),
        xName: '후방 참여율 (%)', yName: '전방 참여율 (%)', highlight: c => c === base });
      c4.table([{ key: 'name', label: '경제', left: true }, { key: 'back', label: '후방', fmt: fmtPct }, { key: 'fwd', label: '전방', fmt: fmtPct }],
        top20.map(c => ({ name: AL(c), back: v(c, 'back'), fwd: v(c, 'fwd') })), { sortKey: 'back' });

      // 상대국 분석
      if (!S.meta.partner_acts.includes(act)) {
        grid.append(el('section', { class: 'card span-12' }, el('p', { class: 'empty', text: `상대국별 원천·연계 분석은 ${S.meta.partner_acts.map(IL).join(', ')}에서 제공합니다.` })));
        return;
      }
      const pb = await tryJSON(`partner/${base}.json`);
      if (stale(tok)) return;
      const pYears = S.meta.partner_years;
      const py = partnerYearFor(y, pYears), pyi = pYears.indexOf(py);
      if (pb) {
        const src = sourceStack(pb, 'DEXFVApSH', act, pb.partners, pb.years, 7, [base]);
        const c5 = card({ span: 6, title: `${AL(base)} 수출의 해외부가가치 원천`, sub: '원천 경제별, 총수출 대비 %', note: '상위 7개 원천은 가장 최근 연도 기준입니다.' });
        grid.append(c5.node);
        columnChart(c5.chart, { cats: pb.years.map(String), series: src });
        c5.table([{ key: 'name', label: '원천 경제', left: true }, ...pb.years.map((yy, i) => ({ key: 'y' + i, label: String(yy), fmt: fmtPct }))],
          src.map(s => Object.fromEntries([['name', s.name], ...s.data.map((x, i) => ['y' + i, x])])), { sortKey: 'y' + (pb.years.length - 1) });

        const fw = pb.data.FEXDVApSH[act][pyi] || [];
        const fwRank = pb.partners.map((p, i) => ({ p, v: fw[i] })).filter(o => ok(o.v) && o.p !== base).sort((a, b) => b.v - a.v);
        const c6 = card({ span: 6, title: `${AL(base)} 부가가치가 체화된 제3국 수출 (${py}년)`, sub: '전방 연계 상위 10개 수출 경제, 총수출 대비 %' });
        grid.append(c6.node);
        if (fwRank.length) {
          hbarChart(c6.chart, { cats: fwRank.slice(0, 10).map(o => ({ code: o.p, label: AL(o.p) })), series: [{ name: '전방 연계', color: t.series[0], data: fwRank.slice(0, 10).map(o => o.v) }] });
          c6.table([{ key: 'name', label: '수출 경제', left: true }, { key: 'v', label: '총수출 대비', fmt: fmtPct }], fwRank.map(o => ({ name: AL(o.p), v: o.v })), { sortKey: 'v' });
        } else c6.empty('자료가 없습니다.');
      }

      // 히트맵: 상위 10개 수출 경제 × 원천 경제
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
        const c7 = card({ span: 12, title: `주요 수출 경제의 해외부가가치 원천 (${py}년)`, sub: '행 = 수출 상위 10개 경제, 열 = 주요 원천 경제, 값 = 행 경제 총수출 대비 %', size: 'tall' });
        grid.append(c7.node);
        heatmapChart(c7.chart, { rows: valid.map(o => ({ code: o.c, label: AL(o.c) })), cols: srcTop.map(s => ({ code: s.p, label: AL(s.p) })), matrix });
        c7.table([{ key: 'name', label: '수출 경제', left: true }, ...srcTop.map((s, j) => ({ key: 'c' + j, label: AL(s.p), fmt: fmtPct }))],
          valid.map((o, i) => Object.fromEntries([['name', AL(o.c)], ...matrix[i].map((x, j) => ['c' + j, x])])));
      }

      // 수출 대상: 총수출 vs 최종수요 부가가치
      if (pb) {
        const ex = pb.data.EXGR[act][pyi] || [], fd = pb.data.FFD_DVA[act][pyi] || [];
        const exT = sum(ex.filter((x, i) => pb.partners[i] !== base)), fdT = sum(fd.filter((x, i) => pb.partners[i] !== base));
        const dest = pb.partners.map((p, i) => ({ p, ex: ok(ex[i]) ? ex[i] / exT * 100 : null, fd: ok(fd[i]) ? fd[i] / fdT * 100 : null }))
          .filter(o => o.p !== base && ok(o.ex)).sort((a, b) => b.ex - a.ex);
        const c8 = card({ span: 12, title: `${AL(base)}의 수출 대상 구성 (${py}년)`, sub: '총수출 기준 비중과 상대국 최종수요에 체화된 국내부가가치 기준 비중, 상위 10개 상대국' });
        grid.append(c8.node);
        if (dest.length && exT > 0) {
          hbarChart(c8.chart, { cats: dest.slice(0, 10).map(o => ({ code: o.p, label: AL(o.p) })),
            series: [{ name: '총수출 기준', color: t.series[0], data: dest.slice(0, 10).map(o => o.ex) },
              { name: '최종수요 부가가치 기준', color: t.series[1], data: dest.slice(0, 10).map(o => o.fd) }] });
          c8.table([{ key: 'name', label: '상대국', left: true }, { key: 'ex', label: '총수출 기준', fmt: fmtPct }, { key: 'fd', label: '최종수요 부가가치 기준', fmt: fmtPct }],
            dest.map(o => ({ name: AL(o.p), ex: o.ex, fd: o.fd })), { sortKey: 'ex' });
        } else c8.empty('자료가 없습니다.');
      }
    });
  }

  // ---------------------------------------------------------------- 한국 GVC
  async function viewKorea(root) {
    const K = S.meta.korea.code;
    const peers = S.meta.korea.peers.filter(c => S.countries.data[c]);
    const acts = S.meta.partner_acts.length ? S.meta.partner_acts : ['_T', 'C'];
    const st = S.state.korea = S.state.korea || { act: '_T', year: S.meta.latest, metric: 'back' };
    root.append(head('한국의 GVC 참여', '한국의 후방·전방 참여 추이, 경쟁국 비교, 산업별 구조, 해외부가가치 원천과 수출 대상의 부가가치 구성을 보여 줍니다.'));
    await viewShell(root, st, update => filtersRow(
      selectFilter('산업', null, st.act, v => { st.act = v; update(); }, { groups: actGroups(acts) }),
      selectFilter('기준 연도', yearOptions(), st.year, v => { st.year = +v; update(); }),
      selectFilter('경쟁국 비교 지표', ['back', 'fwd', 'gvc', 'dva_sh', 'int_sh'].map(k => ({ value: k, label: METRICS[k].label })), st.metric, v => { st.metric = v; update(); })),
    async (body, tok) => {
      const act = st.act, y = st.year, b0 = baseYear(y);
      const [prof, pk] = await Promise.all([getJSON(`profile/${K}.json`), tryJSON(`partner/${K}.json`)]);
      if (stale(tok)) return;
      const t = tokens();
      const s = m => prof.data[act] && prof.data[act][m] ? prof.data[act][m] : S.countries.years.map(() => null);
      const note = focusNote(act);
      if (note) body.append(el('div', { class: 'banner', text: note }));
      const dl = m => ok(valAt(s(m), y)) && ok(valAt(s(m), b0)) ? `${b0}년 대비 ${fmtPp(valAt(s(m), y) - valAt(s(m), b0))}` : '';
      body.append(tiles([
        { label: '후방 참여율', value: fmtPct(valAt(s('back'), y)), delta: dl('back') },
        { label: '전방 참여율', value: fmtPct(valAt(s('fwd'), y)), delta: dl('fwd') },
        { label: 'GVC 참여율', value: fmtPct(valAt(s('gvc'), y)), delta: dl('gvc') },
        { label: '국내부가가치 비중', value: fmtPct(valAt(s('dva_sh'), y)), delta: dl('dva_sh') },
        { label: '세계 수출 점유율', value: fmtPct(valAt(s('ms'), y)), delta: `총수출 ${fmtUsd(valAt(s('EXGR'), y))}` },
      ]));
      const grid = el('div', { class: 'grid' });
      body.append(grid);

      const c1 = card({ span: 6, title: `한국 GVC 참여율 추이 (${IL(act)})`, sub: '총수출 대비 %' });
      grid.append(c1.node);
      const s1 = [{ name: '후방 참여율', code: 'back', color: t.series[0], data: s('back') }, { name: '전방 참여율', code: 'fwd', color: t.series[1], data: s('fwd') },
        { name: 'GVC 참여율', code: 'gvc', color: t.series[2], data: s('gvc') }];
      lineChart(c1.chart, { years: S.countries.years, series: s1 });
      c1.table([{ key: 'year', label: '연도', left: true, fmt: x => x }, ...s1.map(x => ({ key: x.code, label: x.name, fmt: fmtPct }))],
        S.countries.years.map((yy, i) => Object.fromEntries([['year', yy], ...s1.map(x => [x.code, x.data[i]])])), { sortKey: 'year' });

      const m = METRICS[st.metric];
      const all = [K, ...peers];
      const sers = await Promise.all(all.map(c => seriesOf(c, act, st.metric)));
      if (stale(tok)) return;
      const c2 = card({ span: 6, title: `경쟁국 비교, ${m.label}`, sub: `${IL(act)}, %` });
      grid.append(c2.node);
      const s2 = all.map((c, i) => ({ name: AL(c), code: c, color: t.series[i], data: sers[i], width: c === K ? 2.5 : 2, z: c === K ? 5 : 2, endLabel: c === K }));
      lineChart(c2.chart, { years: S.countries.years, series: s2, fmt: m.fmt, endLabels: false });
      c2.table([{ key: 'year', label: '연도', left: true, fmt: x => x }, ...s2.map(x => ({ key: x.code, label: x.name, fmt: fmtPct }))],
        S.countries.years.map((yy, i) => Object.fromEntries([['year', yy], ...s2.map(x => [x.code, x.data[i]])])), { sortKey: 'year' });

      // 제조업 세부 산업
      const focusSet = new Set(S.meta.focus.map(f => f.code));
      const manu = S.meta.detail_acts.filter(c => c.startsWith('C') && prof.data[c]);
      const mrows = manu.map(c => ({ code: c, name: IL(c), back: valAt(prof.data[c].back, y), fwd: valAt(prof.data[c].fwd, y), gvc: valAt(prof.data[c].gvc, y),
        EXGR: valAt(prof.data[c].EXGR, y), rca: valAt(prof.data[c].rca, y), ms: valAt(prof.data[c].ms, y) })).filter(r => ok(r.gvc)).sort((a, b) => b.gvc - a.gvc);
      const c3 = card({ span: 7, title: `제조업 세부 산업별 후방·전방 참여율 (${y}년)`, sub: '중점 산업은 굵게 표시, 총수출 대비 %', size: 'tall' });
      grid.append(c3.node);
      hbarChart(c3.chart, { cats: mrows.map(r => ({ code: r.code, label: r.name })), stacked: true, highlight: c => focusSet.has(c),
        series: [{ name: '후방 참여율', color: t.series[0], data: mrows.map(r => r.back) }, { name: '전방 참여율', color: t.series[1], data: mrows.map(r => r.fwd) }] });
      c3.table([{ key: 'name', label: '산업', left: true }, { key: 'EXGR', label: '총수출 (억 달러)', fmt: fmtEok }, { key: 'back', label: '후방', fmt: fmtPct },
        { key: 'fwd', label: '전방', fmt: fmtPct }, { key: 'gvc', label: 'GVC', fmt: fmtPct }, { key: 'ms', label: '세계 점유율', fmt: fmtPct }], mrows, { sortKey: 'gvc' });

      const all50 = S.meta.detail_acts.filter(c => prof.data[c]).map(c => ({ code: c, name: IL(c), rca: valAt(prof.data[c].rca, y), EXGR: valAt(prof.data[c].EXGR, y) }))
        .filter(r => ok(r.rca) && ok(r.EXGR) && r.EXGR > 0).sort((a, b) => b.rca - a.rca);
      const c4 = card({ span: 5, title: `부가가치 기준 RCA 상위 15개 산업 (${y}년)`, sub: '중점 산업 강조, 기준선 1', size: 'tall' });
      grid.append(c4.node);
      const r15 = all50.slice(0, 15);
      hbarChart(c4.chart, { cats: r15.map(r => ({ code: r.code, label: r.name })), fmt: fmtRca, refLine: 1, highlight: c => focusSet.has(c),
        series: [{ name: 'RCA', data: r15.map(r => r.rca), colors: r15.map(r => (focusSet.has(r.code) ? t.accent : t.deemph)), color: t.deemph }] });
      c4.table([{ key: 'name', label: '산업', left: true }, { key: 'rca', label: 'RCA', fmt: fmtRca }, { key: 'EXGR', label: '총수출 (억 달러)', fmt: fmtEok }], all50, { sortKey: 'rca' });

      if (!pk || !pk.data.DEXFVApSH[act]) {
        grid.append(el('section', { class: 'card span-12' }, el('p', { class: 'empty', text: '상대국별 자료가 없습니다.' })));
        return;
      }
      const src = sourceStack(pk, 'DEXFVApSH', act, pk.partners, pk.years, 7, [K]);
      const c5 = card({ span: 7, title: `해외부가가치 원천 구성 (${IL(act)})`, sub: '원천 경제별, 한국 총수출 대비 %' });
      grid.append(c5.node);
      columnChart(c5.chart, { cats: pk.years.map(String), series: src });
      c5.table([{ key: 'name', label: '원천 경제', left: true }, ...pk.years.map((yy, i) => ({ key: 'y' + i, label: String(yy), fmt: fmtPct }))],
        src.map(x => Object.fromEntries([['name', x.name], ...x.data.map((v, i) => ['y' + i, v])])), { sortKey: 'y' + (pk.years.length - 1) });

      const keySrc = ['CHN', 'JPN', 'USA', 'DEU'].filter(c => pk.partners.includes(c));
      const c6 = card({ span: 5, title: '주요 원천 경제 의존도 추이', sub: '해당 경제에서 온 부가가치, 한국 총수출 대비 %' });
      grid.append(c6.node);
      const s6 = keySrc.map((c, i) => ({ name: AL(c), code: c, color: t.series[i], data: pk.years.map((yy, yi) => (pk.data.DEXFVApSH[act][yi] || [])[pk.partners.indexOf(c)]) }));
      lineChart(c6.chart, { years: pk.years, series: s6, fmt: fmtPct });
      c6.table([{ key: 'year', label: '연도', left: true, fmt: x => x }, ...s6.map(x => ({ key: x.code, label: x.name, fmt: fmtPct }))],
        pk.years.map((yy, i) => Object.fromEntries([['year', yy], ...s6.map(x => [x.code, x.data[i]])])), { sortKey: 'year' });

      const py = partnerYearFor(y, pk.years), pyi = pk.years.indexOf(py);
      const ex = pk.data.EXGR[act][pyi] || [], fd = pk.data.FFD_DVA[act][pyi] || [];
      const exT = sum(ex.filter((x, i) => pk.partners[i] !== K)), fdT = sum(fd.filter((x, i) => pk.partners[i] !== K));
      const dest = pk.partners.map((p, i) => ({ p, ex: ok(ex[i]) && exT ? ex[i] / exT * 100 : null, fd: ok(fd[i]) && fdT ? fd[i] / fdT * 100 : null }))
        .filter(o => o.p !== K && ok(o.ex)).sort((a, b) => b.ex - a.ex);
      const c7 = card({ span: 7, title: `수출 대상 구성, 총수출과 부가가치 기준 (${py}년)`, sub: '상위 10개 상대국, 각 기준 합계 대비 %', size: 'tall' });
      grid.append(c7.node);
      hbarChart(c7.chart, { cats: dest.slice(0, 10).map(o => ({ code: o.p, label: AL(o.p) })),
        series: [{ name: '총수출 기준', color: t.series[0], data: dest.slice(0, 10).map(o => o.ex) },
          { name: '최종수요 부가가치 기준', color: t.series[1], data: dest.slice(0, 10).map(o => o.fd) }] });
      c7.table([{ key: 'name', label: '상대국', left: true }, { key: 'ex', label: '총수출 기준', fmt: fmtPct }, { key: 'fd', label: '최종수요 부가가치 기준', fmt: fmtPct }],
        dest.map(o => ({ name: AL(o.p), ex: o.ex, fd: o.fd })), { sortKey: 'ex' });

      const fw = pk.data.FEXDVApSH[act][pyi] || [];
      const fwRank = pk.partners.map((p, i) => ({ p, v: fw[i] })).filter(o => ok(o.v) && o.p !== K).sort((a, b) => b.v - a.v);
      const c8 = card({ span: 5, title: `한국 부가가치가 체화된 제3국 수출 (${py}년)`, sub: '전방 연계 상위 10개 경제, 한국 총수출 대비 %', size: 'tall' });
      grid.append(c8.node);
      hbarChart(c8.chart, { cats: fwRank.slice(0, 10).map(o => ({ code: o.p, label: AL(o.p) })), series: [{ name: '전방 연계', color: t.series[0], data: fwRank.slice(0, 10).map(o => o.v) }] });
      c8.table([{ key: 'name', label: '수출 경제', left: true }, { key: 'v', label: '한국 총수출 대비', fmt: fmtPct }], fwRank.map(o => ({ name: AL(o.p), v: o.v })), { sortKey: 'v' });
    });
  }

  // ---------------------------------------------------------------- 지역
  async function viewRegion(root, rid) {
    const R = S.meta.regions[rid];
    if (!R) { root.append(el('p', { class: 'empty', text: '지역 정의가 없습니다.' })); return; }
    const D = S.countries.data;
    const st = S.state[rid] = S.state[rid] || { act: S.meta.acts.includes(R.default_activity) ? R.default_activity : '_T', year: S.meta.latest, metric: 'back', sel: null };
    if (!st.sel) {
      st.sel = [...R.members].filter(c => D[c] && D[c]._T).sort((a, b) => (valAt(D[b]._T.EXGR, S.meta.latest) || 0) - (valAt(D[a]._T.EXGR, S.meta.latest) || 0)).slice(0, 6);
    }
    const isEU = R.id === 'EU';
    const sg = R.subgroups || null;
    const sgOf = c => (sg ? Object.entries(sg).find(([, v]) => v.includes(c))?.[0] : null);
    root.append(head(R.label + (isEU ? ' (EU27 회원국)' : ''),
      `${R.members.map(AL).join(', ')}. ${R.note ? R.note + ' ' : ''}지역 지표는 회원국 값을 합산해 계산하므로 회원국 간 교역이 포함됩니다.${R.official ? ` TiVA가 제공하는 ${AL(R.official)} 집계는 역외 교역 기준으로 함께 표시합니다.` : ''}`));
    const actInclude = isEU ? null : null;
    await viewShell(root, st, update => filtersRow(
      selectFilter('산업', null, st.act, v => { st.act = v; update(); }, { groups: actGroups(actInclude) }),
      selectFilter('기준 연도', yearOptions(), st.year, v => { st.year = +v; update(); }),
      selectFilter('회원국 추이 지표', ['back', 'fwd', 'gvc', 'dva_sh', 'int_sh', 'ms', 'rca'].map(k => ({ value: k, label: METRICS[k].label })), st.metric, v => { st.metric = v; update(); }),
      chipPicker('추이 비교 회원국', R.members, st, 'sel', 8, update)),
    async (body, tok) => {
      const act = st.act, y = st.year;
      const [ind, prof, pr, off] = await Promise.all([getJSON(`industry/${act}.json`), getJSON(`profile/${rid}.json`),
        tryJSON(`partner/${rid}.json`), R.official ? tryJSON(`profile/${R.official}.json`) : null]);
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
      body.append(tiles([
        { label: `회원국 합계 총수출 (${y}년)`, value: fmtEok(rv('EXGR')[yi]), unit: '억 달러', delta: `세계 점유율 ${fmtPct(rv('ms')[yi])}` },
        { label: '후방 참여율', value: fmtPct(rv('back')[yi]), delta: ok(rv('back')[ind.years.indexOf(b0)]) ? `${b0}년 대비 ${fmtPp(rv('back')[yi] - rv('back')[ind.years.indexOf(b0)])}` : '' },
        { label: '전방 참여율', value: fmtPct(rv('fwd')[yi]), delta: '총수출 가중평균' },
        { label: '부가가치 기준 RCA', value: fmtRca(rv('rca')[yi]), delta: act === '_T' ? '전 산업은 1' : '세계 대비 특화 정도' },
        { label: `역내 조달 비중${py ? ` (${py}년)` : ''}`, value: intra != null ? fmtPct(intra) : DASH, delta: '해외부가가치 중 회원국에서 온 비중' },
      ]));
      const grid = el('div', { class: 'grid' });
      body.append(grid);

      // 지역 추이
      const s1 = [{ name: '후방 참여율', code: 'back', color: t.series[0], data: rv('back') }, { name: '전방 참여율', code: 'fwd', color: t.series[1], data: rv('fwd') }];
      if (off && off.data[act]) s1.push({ name: `${AL(R.official)} 집계 후방`, code: 'off', color: t.series[2], data: off.data[act].back, short: '공식 집계 후방' });
      const c1 = card({ span: 6, title: `지역 GVC 참여율 추이 (${IL(act)})`, sub: '회원국 합계 기준, 총수출 대비 %' });
      grid.append(c1.node);
      lineChart(c1.chart, { years: ind.years, series: s1, endLabels: s1.length <= 2 });
      c1.table([{ key: 'year', label: '연도', left: true, fmt: x => x }, ...s1.map(x => ({ key: x.code, label: x.name, fmt: fmtPct }))],
        ind.years.map((yy, i) => Object.fromEntries([['year', yy], ...s1.map(x => [x.code, x.data[i]])])), { sortKey: 'year' });

      // 회원국 추이
      const m = METRICS[st.metric];
      const c2 = card({ span: 6, title: `회원국 ${m.label} 추이`, sub: `${IL(act)}${m.unit ? ', ' + m.unit : ''}` });
      grid.append(c2.node);
      const s2 = st.sel.filter(c => ind.data[c]).map(c => ({ name: AL(c), code: c, color: t.series[st.selSlots[c]], data: ind.data[c][st.metric] }));
      if (s2.length) {
        lineChart(c2.chart, { years: ind.years, series: s2, fmt: m.fmt });
        c2.table([{ key: 'year', label: '연도', left: true, fmt: x => x }, ...s2.map(x => ({ key: x.code, label: x.name, fmt: m.fmt }))],
          ind.years.map((yy, i) => Object.fromEntries([['year', yy], ...s2.map(x => [x.code, x.data[i]])])), { sortKey: 'year' });
      } else c2.empty('위의 칩에서 회원국을 고르세요.');

      // 회원국 표
      const rexg = rv('EXGR')[yi];
      const mrows = R.members.filter(c => ind.data[c]).map(c => {
        const g = (k) => ind.data[c][k][yi];
        return { code: c, name: AL(c), sg: sgOf(c), EXGR: g('EXGR'), rshare: ok(g('EXGR')) && rexg ? g('EXGR') / rexg * 100 : null,
          ms: g('ms'), back: g('back'), fwd: g('fwd'), gvc: g('gvc'), dva_sh: g('dva_sh'), int_sh: g('int_sh'), rca: g('rca') };
      });
      const cols = [{ key: 'name', label: '경제', left: true }];
      if (sg) cols.push({ key: 'sg', label: '권역', left: true });
      cols.push({ key: 'EXGR', label: '총수출 (억 달러)', fmt: fmtEok }, { key: 'rshare', label: '지역 내 비중', fmt: fmtPct }, { key: 'ms', label: '세계 점유율', fmt: fmtPct },
        { key: 'back', label: '후방', fmt: fmtPct }, { key: 'fwd', label: '전방', fmt: fmtPct }, { key: 'gvc', label: 'GVC', fmt: fmtPct },
        { key: 'dva_sh', label: '국내부가가치 비중', fmt: fmtPct }, { key: 'int_sh', label: '중간재 수출 비중', fmt: fmtPct }, { key: 'rca', label: 'RCA', fmt: fmtRca });
      grid.append(el('section', { class: 'card span-12' },
        el('div', { class: 'card-head' }, el('div', {}, el('h3', { text: `회원국 지표 (${y}년, ${IL(act)})` }), el('p', { class: 'sub', text: '열 제목을 누르면 정렬합니다.' }))),
        el('div', { class: 'table-wrap' }, makeTable(cols, mrows, { sortKey: 'EXGR', highlight: r => st.sel.includes(r.code) }))));

      // 산업 구성
      const T = prof.data._T;
      const dvaT = T ? valAt(T.EXGR_DVA, y) : null;
      const comp = S.meta.detail_acts.filter(c => prof.data[c]).map(c => ({ code: c, name: IL(c), share: ok(valAt(prof.data[c].EXGR_DVA, y)) && dvaT ? valAt(prof.data[c].EXGR_DVA, y) / dvaT * 100 : null,
        rca: valAt(prof.data[c].rca, y), back: valAt(prof.data[c].back, y) })).filter(r => ok(r.share));
      const byShare = [...comp].sort((a, b) => b.share - a.share);
      const c3 = card({ span: 6, title: `수출 국내부가가치의 산업 구성 (${y}년)`, sub: '상위 12개 산업, 전 산업 합계 대비 %', size: 'tall' });
      grid.append(c3.node);
      if (byShare.length) {
        const top12 = byShare.slice(0, 12);
        hbarChart(c3.chart, { cats: top12.map(r => ({ code: r.code, label: r.name })), highlight: c => c === act,
          series: [{ name: '비중', color: t.series[0], data: top12.map(r => r.share), extra: top12.map(r => `RCA ${fmtRca(r.rca)}`) }] });
        c3.table([{ key: 'name', label: '산업', left: true }, { key: 'share', label: '비중', fmt: fmtPct }, { key: 'rca', label: 'RCA', fmt: fmtRca }, { key: 'back', label: '후방', fmt: fmtPct }], byShare, { sortKey: 'share' });
      } else c3.empty('자료가 없습니다.');

      const byRca = comp.filter(r => ok(r.rca) && r.share > 0.1).sort((a, b) => b.rca - a.rca);
      const c4 = card({ span: 6, title: `부가가치 기준 RCA 상위 12개 산업 (${y}년)`, sub: '수출 국내부가가치 비중 0.1% 이상 산업, 기준선 1', size: 'tall' });
      grid.append(c4.node);
      if (byRca.length) {
        const r12 = byRca.slice(0, 12);
        hbarChart(c4.chart, { cats: r12.map(r => ({ code: r.code, label: r.name })), fmt: fmtRca, refLine: 1, highlight: c => c === act,
          series: [{ name: 'RCA', color: t.series[0], data: r12.map(r => r.rca) }] });
        c4.table([{ key: 'name', label: '산업', left: true }, { key: 'rca', label: 'RCA', fmt: fmtRca }, { key: 'share', label: '비중', fmt: fmtPct }], byRca, { sortKey: 'rca' });
      } else c4.empty('자료가 없습니다.');

      if (!pr || !pr.data.DEXFVApSH[act]) {
        grid.append(el('section', { class: 'card span-12' }, el('p', { class: 'empty', text: `역내 조달과 원천 분석은 ${S.meta.partner_acts.map(IL).join(', ')}에서 제공합니다.` })));
        return;
      }
      const c5 = card({ span: 5, title: '역내 조달 비중 추이', sub: '해외부가가치 중 회원국에서 온 부가가치 비중, %' });
      grid.append(c5.node);
      lineChart(c5.chart, { years: pr.years, series: [{ name: '역내 조달 비중', code: 'intra', color: t.series[0], data: intraSeries }], endLabels: false });
      c5.table([{ key: 'year', label: '연도', left: true, fmt: x => x }, { key: 'v', label: '역내 조달 비중', fmt: fmtPct }], pr.years.map((yy, i) => ({ year: yy, v: intraSeries[i] })), { sortKey: 'year' });

      const row = pr.data.DEXFVApSH[act][pyi] || [];
      const srcs = pr.partners.map((p, i) => ({ p, v: row[i], inside: R.members.includes(p) })).filter(o => ok(o.v) && o.v > 0).sort((a, b) => b.v - a.v);
      const top12 = srcs.slice(0, 12);
      const c6 = card({ span: 7, title: `해외부가가치의 주요 원천 경제 (${py}년)`, sub: '회원국 합계 총수출 대비 %, 역내와 역외 구분', size: 'tall' });
      grid.append(c6.node);
      hbarChart(c6.chart, { cats: top12.map(o => ({ code: o.p, label: AL(o.p) })),
        series: [{ name: '역내 원천', color: t.series[0], data: top12.map(o => (o.inside ? o.v : null)) },
          { name: '역외 원천', color: t.series[1], data: top12.map(o => (o.inside ? null : o.v)) }], stacked: true, labelAll: true });
      c6.table([{ key: 'name', label: '원천 경제', left: true }, { key: 'kind', label: '구분', left: true }, { key: 'v', label: '총수출 대비', fmt: fmtPct }],
        srcs.map(o => ({ name: AL(o.p), kind: o.inside ? '역내' : '역외', v: o.v })), { sortKey: 'v' });
    });
  }

  // ---------------------------------------------------------------- 방법론
  async function viewMethod(root) {
    const m = S.meta;
    const qa = await tryJSON('qa.json');
    const repo = repoUrl();
    const p = (...c) => el('p', {}, ...c);
    const dl = (pairs) => el('dl', {}, pairs.flatMap(([a, b]) => [el('dt', { text: a }), el('dd', { text: b })]));
    root.append(head('방법론과 데이터', '지표 정의, 산업·지역 구분, 자동 갱신 방식, 데이터 품질 점검 결과입니다.'));
    const box = el('div', { class: 'card prose' });
    root.append(box);
    box.append(...[
      el('h3', { text: '자료' }),
      p(`OECD Trade in Value Added (TiVA) ${m.edition ? m.edition + '년판' : ''}. OECD SDMX API(sdmx.oecd.org)에서 GitHub Actions가 자동으로 내려받습니다. 최신 연도는 ${m.latest}년, 마지막 수집 시점은 ${fmtTime(m.fetched_at)}입니다.`),
      p(`사용한 dataflow는 ${m.flows.map(f => `${f.id} (${f.name})`).join(', ') || '기록 없음'}입니다.`),
      m.missing_measures && m.missing_measures.length ? p(`이번 수집에서 찾지 못한 지표 ${m.missing_measures.join(', ')}. 해당 지표를 쓰는 차트는 비어 있을 수 있습니다.`) : null,
      el('h3', { text: '지표 정의' }),
      dl([
        ['후방 참여율 (EXGR_FVASH)', '총수출에 포함된 해외부가가치의 비중. 수출 생산에서 수입 중간재에 의존하는 정도와 연관됩니다.'],
        ['전방 참여율 (EXGR_DVAFXSH)', '자국 부가가치가 상대국의 수출에 다시 체화된 크기를 자국 총수출 대비로 나타낸 값. 다른 경제의 수출 생산에 중간재를 공급하는 정도와 연관됩니다.'],
        ['GVC 참여율', '후방 참여율과 전방 참여율의 합.'],
        ['국내부가가치 비중 (EXGR_DVASH)', '총수출에 포함된 국내부가가치의 비중. 후방 참여율과 합하면 100%입니다.'],
        ['중간재 수출 비중', '중간재 총수출(EXGR_INT)을 총수출(EXGR)로 나눈 값.'],
        ['세계 수출 점유율', '해당 산업에서 개별 경제의 총수출을 TiVA 개별 경제(기타 세계 포함) 총수출 합계로 나눈 값.'],
        ['부가가치 기준 RCA', '(경제의 산업 수출 국내부가가치 / 경제 전체 수출 국내부가가치) ÷ (세계 산업 수출 국내부가가치 / 세계 전체 수출 국내부가가치). 1보다 크면 그 산업 수출에 상대적으로 특화된 것으로 봅니다.'],
        ['해외부가가치 원천 (DEXFVApSH)', '수출 경제의 총수출에 들어간 원천 경제별 부가가치, 수출 경제 총수출 대비 %.'],
        ['전방 연계 (FEXDVApSH)', '자국 부가가치가 상대 경제의 수출에 체화된 크기, 자국 총수출 대비 %.'],
        ['최종수요 부가가치 (FFD_DVA)', '상대국 최종수요에 체화된 자국 부가가치. 총수출 기준 상대국 구성과 비교하면 중간 경유지를 거친 부가가치 흐름을 가늠할 수 있습니다.'],
        ['집중도 (HHI, 상위 3개 점유율)', '산업별 세계 총수출에서 개별 경제가 차지하는 비중으로 계산합니다. 기타 세계(WXD)는 하나의 경제로 보지 않아 제외합니다.'],
      ]),
      el('h3', { text: '중점 산업의 대응 관계' }),
      p('TiVA는 ISIC Rev.4 기반 50개 산업으로 구성되어 반도체나 이차전지 같은 품목 단위 산업을 따로 분리하지 않습니다. 따라서 아래처럼 해당 산업을 포함하는 TiVA 산업으로 대응시켰고, 결과는 그 산업 전체에 대한 값입니다.'),
      el('ul', {}, m.focus.map(f => el('li', { text: `${f.label} → ${IL(f.code)} (${f.code}). ${f.note}` }))),
      el('h3', { text: '국가군' }),
      el('ul', {}, el('li', { text: `주요국 비교 = ${m.latest}년 TiVA 부가가치(VALU, 전 산업) 상위 ${m.top.length}개 경제 (${m.top.map(AL).join(', ')})` }),
        Object.values(m.regions).map(r => el('li', { text: `${r.label} = ${r.members.map(AL).join(', ')}${r.note ? '. ' + r.note : ''}` }))),
      p('지역 지표는 회원국 값을 합산해 계산하므로 회원국 간 교역과 부가가치가 포함됩니다. 지역 후방 참여율은 회원국 해외부가가치 합계를 회원국 총수출 합계로 나눈 값이고, 전방 참여율은 회원국 값을 총수출로 가중평균한 값입니다. TiVA가 직접 제공하는 EU27, ASEAN 등의 공식 집계는 지역을 하나의 경제로 보아 역외 교역만 반영하므로 회원국 합계와 수준이 다릅니다.'),
      el('h3', { text: '해석상 유의점' }),
      el('ul', {},
        el('li', { text: '지표는 국가·산업 간 연관성을 보여 주며 인과관계를 뜻하지 않습니다.' }),
        el('li', { text: 'TiVA는 국가 간 산업연관표(ICIO) 추정치이므로 판(edition)이 바뀌면 과거 연도 값도 함께 수정될 수 있습니다. 서로 다른 판의 수치를 섞어 비교하지 않는 것이 좋습니다.' }),
        el('li', { text: '금액은 명목 미국 달러 기준이며 대시보드에서는 억 달러로 표시합니다.' }),
        el('li', { text: '상대국별 분석은 수집량을 줄이기 위해 선택한 연도와 산업(전 산업, 제조업, 중점 산업)에 한정했습니다. 범위는 config/tiva.yaml에서 바꿀 수 있습니다.' })),
      el('h3', { text: '자동 갱신' }),
      p('GitHub Actions가 매월 OECD API의 TiVA dataflow 구성과 판 정보를 확인하고, 새 판이 나오거나 설정이 바뀌었을 때만 전체 데이터를 다시 내려받아 이 페이지를 갱신합니다. 저장소의 Actions 탭에서 수동 실행도 할 수 있습니다.'),
      repo ? p('원자료와 코드 ', el('a', { href: repo, text: repo }), '. 정리된 데이터는 data/processed 폴더(parquet, 요약 CSV)에 있습니다.') : null,
    ].filter(Boolean));
    if (qa && qa.checks) {
      box.append(el('h3', { text: '데이터 품질 점검' }),
        el('div', { class: 'table-wrap' }, makeTable([
          { key: 'name', label: '점검 항목', left: true, sort: false },
          { key: 'value', label: '결과', fmt: v => Array.isArray(v) ? v.map(x => (typeof x === 'number' ? nf2.format(x) : x)).join(' / ') : (typeof v === 'number' ? nf2.format(v) : String(v)), sort: false },
          { key: 'ok', label: '판정', fmt: v => (v ? '통과' : '확인 필요'), sort: false },
        ], qa.checks)));
    }
  }
  function fmtTime(s) {
    if (!s) return '기록 없음';
    const d = new Date(s);
    return isNaN(d) ? s : d.toLocaleString('ko-KR', { dateStyle: 'medium', timeStyle: 'short' });
  }
  function repoUrl() {
    const h = location.hostname, parts = location.pathname.split('/').filter(Boolean);
    if (h.endsWith('.github.io')) return `https://github.com/${h.replace('.github.io', '')}/${parts[0] || ''}`;
    return null;
  }

  // ------------------------------------------------------------------ router
  const VIEWS = {
    top: viewTopCountries, industry: viewIndustry, korea: viewKorea,
    eu: r => viewRegion(r, 'R_EU'), mideast: r => viewRegion(r, 'R_MIDEAST'), southam: r => viewRegion(r, 'R_SOUTHAM'), asia: r => viewRegion(r, 'R_ASIA'),
    method: viewMethod,
  };
  async function route() {
    const key = (location.hash || '#top').slice(1);
    const name = VIEWS[key] ? key : 'top';
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
      root.append(el('p', { class: 'empty', text: '화면을 그리지 못했습니다. ' + e.message }));
    }
    if (scrollY) window.scrollTo(0, scrollY);
  }

  function setupTheme() {
    const btn = document.getElementById('theme-btn');
    const label = () => {
      const tv = document.documentElement.dataset.theme;
      btn.textContent = tv === 'dark' ? '어두운 화면' : tv === 'light' ? '밝은 화면' : '시스템 설정';
    };
    btn.addEventListener('click', () => {
      const cur = document.documentElement.dataset.theme;
      const next = cur === 'light' ? 'dark' : cur === 'dark' ? '' : 'light';
      if (next) document.documentElement.dataset.theme = next; else delete document.documentElement.dataset.theme;
      try { if (next) localStorage.setItem('tiva-theme', next); else localStorage.removeItem('tiva-theme'); } catch (e) { /* 저장 불가 */ }
      label();
      route();
    });
    label();
    window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => { if (!document.documentElement.dataset.theme) route(); });
  }

  async function init() {
    setupTheme();
    try {
      [S.meta, S.countries] = await Promise.all([getJSON('meta.json'), getJSON('countries.json')]);
    } catch (e) {
      document.getElementById('view').replaceChildren(
        el('div', { class: 'card prose' }, el('h3', { text: '아직 데이터가 없습니다' }),
          el('p', { text: 'GitHub Actions의 "TiVA 데이터 갱신" 워크플로가 처음 실행되면 OECD에서 데이터를 받아 이 페이지를 채웁니다. 저장소의 Actions 탭에서 수동으로 실행할 수 있습니다.' }),
          el('p', { class: 'note', text: String(e.message) })));
      document.getElementById('edition-line').textContent = 'OECD Trade in Value Added';
      return;
    }
    const m = S.meta;
    document.getElementById('edition-line').textContent =
      `OECD TiVA ${m.edition ? m.edition + '년판' : ''}, ${m.years[0]}~${m.latest}년, ${m.economies.length}개 경제 · ${m.detail_acts.length}개 산업`;
    document.getElementById('build-line').textContent = `데이터 수집 ${fmtTime(m.fetched_at)}`;
    window.addEventListener('hashchange', route);
    route();
  }
  init();
})();
