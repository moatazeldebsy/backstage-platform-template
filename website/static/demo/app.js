/* Platform demo: hash router, page renderers and tiny inline-SVG charts.
 * Plain script (no modules, no fetch) so it also works from file://. */
(function () {
  'use strict';
  var D = window.DEMO;

  /* ---------- HTML helpers ---------- */
  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }
  function Raw(s) { this.s = s; }
  function raw(s) { return new Raw(String(s)); }
  function fmt(v) {
    if (v == null || v === false) return '';
    if (v instanceof Raw) return v.s;
    if (Array.isArray(v)) return v.map(fmt).join('');
    return esc(v);
  }
  function html(strs) {
    var out = strs[0];
    for (var i = 1; i < arguments.length; i++) out += fmt(arguments[i]) + strs[i];
    return raw(out);
  }

  /* ---------- deterministic data ---------- */
  function hash(s) {
    var h = 2166136261;
    s = String(s);
    for (var i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
    return h >>> 0;
  }
  function rng(seed) {
    var a = hash(seed);
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  // Smooth random walk around base, optional linear trend (fraction over the range).
  function series(seed, n, base, spread, trend) {
    var r = rng(seed), out = [], prev = base;
    for (var i = 0; i < n; i++) {
      var target = base * (1 + (trend || 0) * (i / Math.max(1, n - 1) - 0.5)) + (r() - 0.5) * 2 * spread;
      prev = prev * 0.45 + target * 0.55;
      out.push(Math.max(0, prev));
    }
    return out;
  }
  var MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  var TODAY = new Date(2026, 10, 20);
  function dayLabels(n) {
    var out = [];
    for (var i = n - 1; i >= 0; i--) { var d = new Date(TODAY.getTime() - i * 864e5); out.push(MONTHS[d.getMonth()] + ' ' + d.getDate()); }
    return out;
  }
  function weekLabels(n) { var out = []; for (var i = n - 1; i >= 0; i--) out.push('W' + (47 - i)); return out; }
  function hourLabels(n) { var out = []; for (var i = n - 1; i >= 0; i--) out.push(((24 + 14 - i) % 24) + ':00'); return out; }

  /* ---------- formatting ---------- */
  function money(n, d) { return '$' + Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function num(n, d) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function pct(n, d) { return num(n, d == null ? 1 : d) + '%'; }
  function dur(mins) { return mins < 60 ? Math.round(mins) + ' min' : mins < 1440 ? num(mins / 60, 1) + ' h' : num(mins / 1440, 1) + ' d'; }
  function hours(h) { return h < 24 ? num(h, 1) + ' h' : num(h / 24, 1) + ' d'; }
  function initials(n) { return n.split(/[\s-]+/).map(function (p) { return p[0]; }).join('').slice(0, 2).toUpperCase(); }

  /* ---------- icons (simple strokes, 24px grid) ---------- */
  var IC = {
    home: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6H9v6H4a1 1 0 0 1-1-1z',
    grid: 'M4 4h7v7H4zM13 4h7v7h-7zM4 13h7v7H4zM13 13h7v7h-7z',
    users: 'M16 19v-1a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v1M9 11a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM22 19v-1a4 4 0 0 0-3-3.9M16 5.1a3 3 0 0 1 0 5.8',
    plus: 'M12 5v14M5 12h14',
    plug: 'M9 2v5M15 2v5M6 7h12v4a6 6 0 0 1-12 0zM12 17v5',
    book: 'M4 4h6a3 3 0 0 1 3 3v13a2 2 0 0 0-2-2H4zM20 4h-6a3 3 0 0 0-3 3v13a2 2 0 0 1 2-2h7z',
    radar: 'M12 12m-9 0a9 9 0 1 0 18 0a9 9 0 1 0-18 0M12 12m-5 0a5 5 0 1 0 10 0a5 5 0 1 0-10 0M12 12l6-6',
    chart: 'M4 20V10M10 20V4M16 20v-7M22 20H2',
    dollar: 'M12 2v20M17 6H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6',
    alert: 'M12 3l10 18H2zM12 10v5M12 18h.01',
    cap: 'M2 9l10-5 10 5-10 5zM6 11v5c3 2 9 2 12 0v-5M22 9v6',
    trend: 'M3 17l6-6 4 4 8-8M15 7h6v6',
    sparkle: 'M12 3l2 6 6 2-6 2-2 6-2-6-6-2 6-2zM19 3v4M17 5h4',
    clipboard: 'M9 4h6v3H9zM7 5H5v16h14V5h-2M9 12l2 2 4-4',
    chat: 'M4 5h16v11H9l-5 4z',
    search: 'M11 11m-7 0a7 7 0 1 0 14 0a7 7 0 1 0-14 0M21 21l-5-5',
    check: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6zM8.5 12l2.5 2.5L16 9',
    bot: 'M5 9h14v10H5zM12 5v4M9 13h.01M15 13h.01M9 16h6M2 13v3M22 13v3',
    server: 'M4 4h16v6H4zM4 14h16v6H4zM8 7h.01M8 17h.01',
    route: 'M6 19a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM18 9a2 2 0 1 0 0-4 2 2 0 0 0 0 4zM6 15V9a4 4 0 0 1 4-4h6M18 9v6a4 4 0 0 1-4 4H8',
    coins: 'M8 8m-6 0a6 3 0 1 0 12 0a6 3 0 1 0-12 0M2 8v4c0 1.7 2.7 3 6 3M2 12v4c0 1.7 2.7 3 6 3M16 13m-6 0a6 3 0 1 0 12 0a6 3 0 1 0-12 0M10 13v4c0 1.7 2.7 3 6 3s6-1.3 6-3v-4',
    flask: 'M9 3h6M10 3v6l-5 9a2 2 0 0 0 1.8 3h10.4a2 2 0 0 0 1.8-3l-5-9V3M7 15h10',
    trace: 'M3 6h8M6 12h10M9 18h12',
    git: 'M6 3v12M18 9a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM6 21a3 3 0 1 0 0-6 3 3 0 0 0 0 6zM18 9a9 9 0 0 1-9 9',
    rollout: 'M4 6h10M4 12h16M4 18h6M17 3v6M20 15v6',
    gauge: 'M12 14l4-4M3.3 17a9 9 0 1 1 17.4 0z',
    bell: 'M6 8a6 6 0 1 1 12 0c0 7 3 9 3 9H3s3-2 3-9M10 21h4',
    shield: 'M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z',
    cloud: 'M7 18a5 5 0 0 1-.6-10A6 6 0 0 1 18 9a4.5 4.5 0 0 1-.5 9z',
    eye: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12zM12 12m-3 0a3 3 0 1 0 6 0a3 3 0 1 0-6 0',
    menu: 'M4 6h16M4 12h16M4 18h16',
    sun: 'M12 12m-4 0a4 4 0 1 0 8 0a4 4 0 1 0-8 0M12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
    moon: 'M21 13A9 9 0 1 1 11 3a7 7 0 0 0 10 10z',
    send: 'M4 12l16-8-6 16-2-6z',
    ok: 'M5 12l5 5 9-10',
    x: 'M6 6l12 12M18 6L6 18',
    layers: 'M12 3l9 5-9 5-9-5zM3 13l9 5 9-5',
    zap: 'M13 2L4 14h7l-1 8 9-12h-7z'
  };
  function icon(name, size) {
    var s = size || 16;
    return raw('<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="' + IC[name] + '"/></svg>');
  }

  /* ---------- charts ---------- */
  // Max that splits into four round steps, so gridline labels stay readable.
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var st = v / 4, p = Math.pow(10, Math.floor(Math.log10(st))), n = st / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p * 4;
  }
  function tick(v) { return v >= 1000 ? num(v / 1000, 1) + 'k' : num(v, v % 1 === 0 ? 0 : (v * 10) % 1 === 0 ? 1 : 2); }
  function legend(items) {
    return html`<div class="legend">${items.map(function (it, i) {
      return html`<span><i style="background:${raw(it.color || 'var(--c' + (i + 1) + ')')}"></i>${it.name}</span>`;
    })}</div>`;
  }
  // series: [{name, values, color?, dash?}]
  function lineChart(ser, o) {
    o = o || {};
    var W = 480, H = o.h || 170, L = 40, R = 8, T = 8, B = 22, n = ser[0].values.length;
    var all = []; ser.forEach(function (s) { all = all.concat(s.values); });
    if (o.threshold) all.push(o.threshold.value);
    var min = o.min || 0, max = o.max || niceMax(Math.max.apply(null, all) * 1.05);
    var yf = o.yFmt || tick;
    function x(i) { return L + (W - L - R) * (n === 1 ? 0.5 : i / (n - 1)); }
    function y(v) { return T + (H - T - B) * (1 - (v - min) / (max - min)); }
    var s = '';
    for (var k = 0; k <= 4; k++) {
      var v = min + (max - min) * k / 4, yy = y(v).toFixed(1);
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--grid)"/>';
      s += '<text x="' + (L - 6) + '" y="' + (+yy + 4) + '" text-anchor="end">' + esc(yf(v)) + '</text>';
    }
    if (o.labels) {
      var every = Math.ceil(n / 6);
      o.labels.forEach(function (lb, i) {
        if (i % every === 0 || i === n - 1) s += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(lb) + '</text>';
      });
    }
    ser.forEach(function (sr, si) {
      var col = sr.color || 'var(--c' + (si + 1) + ')';
      var pts = sr.values.map(function (v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); });
      if (si === 0 && o.area !== false) s += '<path d="M' + x(0).toFixed(1) + ',' + y(min).toFixed(1) + ' L' + pts.join(' L') + ' L' + x(n - 1).toFixed(1) + ',' + y(min).toFixed(1) + ' Z" fill="' + col + '" opacity="0.1"/>';
      s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + col + '" stroke-width="2" stroke-linejoin="round" stroke-linecap="round"' + (sr.dash ? ' stroke-dasharray="5 4"' : '') + '/>';
    });
    if (o.threshold) {
      var ty = y(o.threshold.value).toFixed(1);
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + ty + '" y2="' + ty + '" stroke="var(--bad)" stroke-dasharray="4 4"/>';
      s += '<text x="' + (W - R) + '" y="' + (ty - 4) + '" text-anchor="end" style="fill:var(--bad)">' + esc(o.threshold.label) + '</text>';
    }
    var lg = ser.length > 1 || o.threshold ? legend(ser) : '';
    return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label || 'Line chart'}">${raw(s)}</svg>${lg}`;
  }
  // items: [{label, value, color?}]
  function barChart(items, o) {
    o = o || {};
    var W = 480, H = o.h || 170, L = 40, R = 8, T = 8, B = 22, n = items.length;
    var max = o.max || niceMax(Math.max.apply(null, items.map(function (i) { return i.value; })) * 1.05);
    var yf = o.yFmt || tick;
    var bw = (W - L - R) / n, s = '';
    for (var k = 0; k <= 4; k++) {
      var v = max * k / 4, yy = (T + (H - T - B) * (1 - k / 4)).toFixed(1);
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--grid)"/><text x="' + (L - 6) + '" y="' + (+yy + 4) + '" text-anchor="end">' + esc(yf(v)) + '</text>';
    }
    var every = Math.ceil(n / 8);
    items.forEach(function (it, i) {
      var h = (H - T - B) * it.value / max, x = L + i * bw + bw * 0.18;
      s += '<rect x="' + x.toFixed(1) + '" y="' + (H - B - h).toFixed(1) + '" width="' + (bw * 0.64).toFixed(1) + '" height="' + h.toFixed(1) + '" rx="2" fill="' + (it.color || 'var(--c1)') + '"><title>' + esc(it.label + ': ' + yf(it.value)) + '</title></rect>';
      if (i % every === 0) s += '<text x="' + (x + bw * 0.32).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(it.label) + '</text>';
    });
    return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label || 'Bar chart'}">${raw(s)}</svg>`;
  }
  function sparkline(values, color) {
    var max = Math.max.apply(null, values), min = Math.min.apply(null, values), span = max - min || 1, n = values.length;
    var pts = values.map(function (v, i) { return (i / (n - 1) * 100).toFixed(1) + ',' + (26 - (v - min) / span * 22).toFixed(1); }).join(' ');
    return raw('<svg width="96" height="28" viewBox="0 0 100 28" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '" fill="none" stroke="' + (color || 'var(--c1)') + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>');
  }
  function gauge(frac, label, text, color) {
    var f = Math.max(0, Math.min(1, frac));
    var col = color || (f < 0.2 ? 'var(--bad)' : f < 0.5 ? 'var(--warn)' : 'var(--ok)');
    var arc = 'M12 62 A48 48 0 0 1 108 62';
    return html`<div class="gauge"><svg class="chart" viewBox="0 0 120 72" role="img" aria-label="${label + ': ' + text}">
      <path d="${arc}" fill="none" stroke="var(--neutral-soft)" stroke-width="10" stroke-linecap="round" pathLength="100"/>
      ${f > 0 ? raw('<path d="' + arc + '" fill="none" stroke="' + col + '" stroke-width="10" stroke-linecap="round" pathLength="100" stroke-dasharray="' + (f * 100).toFixed(1) + ' 100"/>') : ''}
      <text x="60" y="58" text-anchor="middle" style="font-size:17px;font-weight:700;fill:var(--text-strong)">${text}</text></svg>
      <div class="g-label">${label}</div></div>`;
  }
  function donut(parts, center, o) {
    o = o || {};
    var total = parts.reduce(function (a, p) { return a + p.value; }, 0), acc = 0, s = '';
    parts.forEach(function (p, i) {
      var f = p.value / total * 100;
      s += '<circle r="38" cx="50" cy="50" fill="none" stroke="' + (p.color || 'var(--c' + (i + 1) + ')') + '" stroke-width="14" pathLength="100" stroke-dasharray="' + f.toFixed(2) + ' ' + (100 - f).toFixed(2) + '" stroke-dashoffset="' + (-acc).toFixed(2) + '" transform="rotate(-90 50 50)"><title>' + esc(p.name) + '</title></circle>';
      acc += f;
    });
    return html`<div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap">
      <svg viewBox="0 0 100 100" width="150" height="150" role="img" aria-label="${o.label || 'Donut chart'}">${raw(s)}
        <text x="50" y="49" text-anchor="middle" style="font-size:13px;font-weight:700;fill:var(--text-strong)">${center[0]}</text>
        <text x="50" y="62" text-anchor="middle" style="font-size:7px;fill:var(--text-muted)">${center[1]}</text></svg>
      <div class="legend" style="flex-direction:column;gap:6px;margin:0">${parts.map(function (p, i) {
        return html`<span><i style="background:${raw(p.color || 'var(--c' + (i + 1) + ')')}"></i>${p.name} · <strong>${o.fmt ? o.fmt(p.value) : p.value}</strong></span>`;
      })}</div></div>`;
  }
  function hbars(rows) {
    // rows: [{label, value, max, text, color?}]
    return html`<div>${rows.map(function (r) {
      var w = Math.min(100, r.value / r.max * 100);
      return html`<div class="hbar-row"><span class="nowrap" style="overflow:hidden;text-overflow:ellipsis">${r.label}</span>
        <div class="bar" role="img" aria-label="${r.label + ' ' + r.text}"><span style="width:${w.toFixed(1)}%;background:${raw(r.color || 'var(--brand)')}"></span></div>
        <span class="num">${r.text}</span></div>`;
    })}</div>`;
  }

  /* ---------- UI building blocks ---------- */
  var OKS = /^(healthy|synced|ready|ok|resolved|done|finished|approved|pass|passed|success|true|elite|running)$/i;
  var WARNS = /^(degraded|outofsync|out of sync|pending|warning|investigating|deploying|in progress|progressing|syncing|medium|high|paused|suspended|silver|bronze)$/i;
  var BADS = /^(failed|error|firing|critical|missing|rejected|down|low|not ready|false|exhausted|crashloopbackoff|aborted)$/i;
  function statusPill(text) {
    var t = String(text);
    var cls = OKS.test(t) ? 'ok' : BADS.test(t) ? 'bad' : WARNS.test(t) ? 'warn' : '';
    return html`<span class="pill ${cls}"><span class="dot"></span>${t}</span>`;
  }
  function pill(text, cls) { return html`<span class="pill ${cls || ''}">${text}</span>`; }
  function tierPill(t) {
    return t === 'none' ? pill('No tier') : html`<span class="pill ${t}">${t[0].toUpperCase() + t.slice(1)}</span>`;
  }
  function card(title, body, extra, cls) {
    return html`<section class="card ${cls || ''}">${title ? html`<div class="card-head"><h2>${title}</h2>${extra || ''}</div>` : ''}${body}</section>`;
  }
  function stat(label, value, sub, spark) {
    return html`<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div><div class="sub"><span>${sub || ''}</span>${spark || ''}</div></div>`;
  }
  function head(title, sub, actions, crumbs) {
    return html`<div class="page-head"><div>${crumbs ? html`<div class="crumbs">${crumbs}</div>` : ''}<h1>${title}</h1>${sub ? html`<p>${sub}</p>` : ''}</div>${actions ? html`<div class="btn-row">${actions}</div>` : ''}</div>`;
  }
  function table(headers, rows, numCols) {
    numCols = numCols || [];
    return html`<div class="table-wrap"><table><thead><tr>${headers.map(function (h, i) {
      return html`<th scope="col" class="${numCols.indexOf(i) >= 0 ? 'num' : ''}">${h}</th>`;
    })}</tr></thead><tbody>${rows.length ? rows.map(function (r) {
      return html`<tr>${r.map(function (c, i) { return html`<td class="${numCols.indexOf(i) >= 0 ? 'num' : ''}">${c}</td>`; })}</tr>`;
    }) : html`<tr><td colspan="${headers.length}" class="muted">Nothing matches these filters.</td></tr>`}</tbody></table></div>`;
  }
  function tabs(base, list, cur) {
    return html`<nav class="tabs" aria-label="Sections">${list.map(function (t) {
      return html`<a href="#/${raw(base)}/${t[0]}" ${t[0] === cur ? raw('aria-current="page"') : ''}>${t[1]}</a>`;
    })}</nav>`;
  }
  function chips(bind, options, cur, allLabel) {
    var opts = allLabel ? [['', allLabel]].concat(options) : options;
    return html`<div class="chips" role="group">${opts.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      return html`<button type="button" class="chip" data-action="set" data-key="${bind}" data-value="${v}" aria-pressed="${String(cur === v)}">${l}</button>`;
    })}</div>`;
  }
  function select(bind, id, label, options, cur, allLabel) {
    return html`<label class="sr-only" for="${id}">${label}</label><select class="input" id="${id}" data-bind="${bind}">
      ${allLabel ? html`<option value="">${allLabel}</option>` : ''}${options.map(function (o) {
        var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
        return html`<option value="${v}" ${v === cur ? raw('selected') : ''}>${l}</option>`;
      })}</select>`;
  }
  function entLink(name) { return html`<a href="#/entity/${raw(encodeURIComponent(name))}">${name}</a>`; }
  function teamLink(name) { return html`<a href="#/team/${raw(encodeURIComponent(name))}">${name}</a>`; }

  /* ---------- domain helpers ---------- */
  function comp(name) { return D.components.filter(function (c) { return c.name === name; })[0]; }
  function team(name) { return D.teams.filter(function (t) { return t.name === name; })[0]; }
  function tpl(name) { return D.templates.filter(function (t) { return t.n === name; })[0]; }
  function isMobile(e) { return e.type === 'mobile'; }
  function visibleChecks(e) {
    return D.checks.filter(function (c) { return !c[3] || (c[3] === 'ai' && e.ai) || (c[3] === 'mobile' && isMobile(e)); });
  }
  function checkResults(e) {
    var vis = visibleChecks(e), r = rng('checks:' + e.name);
    var order = vis.slice(1).map(function (c) { return [r(), c]; }).sort(function (a, b) { return a[0] - b[0]; }).map(function (x) { return x[1]; });
    order.unshift(vis[0]);
    var pass = {};
    order.forEach(function (c, i) { pass[c[0]] = i < e.score; });
    return { checks: vis, pass: pass, count: Math.min(e.score, vis.length) };
  }
  function tierOf(e) {
    var th = e.ai ? D.tierThresholds.ai : D.tierThresholds.std, n = checkResults(e).count;
    return n >= th.gold ? 'gold' : n >= th.silver ? 'silver' : n >= th.bronze ? 'bronze' : 'none';
  }
  function doraLevel(metric, v) {
    var t = { df: [1, 1 / 7, 1 / 30], lt: [24, 168, 720], cfr: [5, 10, 15], mttr: [60, 1440, 10080] }[metric];
    var lv = metric === 'df' ? (v >= t[0] ? 0 : v >= t[1] ? 1 : v >= t[2] ? 2 : 3) : (v <= t[0] ? 0 : v <= t[1] ? 1 : v <= t[2] ? 2 : 3);
    return ['Elite', 'High', 'Medium', 'Low'][lv];
  }
  function levelPill(l) { return pill(l, { Elite: 'ok', High: 'info', Medium: 'warn', Low: 'bad' }[l]); }
  var BUDGET_OVERRIDE = { 'orders-service': 0.14, 'inventory-service': 0.03, 'notifications-service': 0.41, 'payments-api': 0.62 };
  function sloState(e) {
    var r = rng('slo:' + e.name);
    var remain = BUDGET_OVERRIDE[e.name] != null ? BUDGET_OVERRIDE[e.name] : 0.45 + r() * 0.5;
    var a = e.slo.avail, errBudget = 100 - a, sli = a + errBudget * remain * 0.9;
    var l = e.slo.latency, lremain = Math.max(0, Math.min(1, remain + (r() - 0.4) * 0.3));
    return { avail: { target: a, sli: sli, remain: remain, burn: (1 - remain) * (1.1 + r() * 0.6) },
      latency: { target: l, sli: l + (100 - l) * lremain * 0.9, remain: lremain, burn: (1 - lremain) * (1 + r() * 0.5) } };
  }
  function k8sApps() {
    return D.components.filter(function (c) { return c.replicas > 0; }).map(function (c) {
      var bad = c.name === 'inventory-service', oos = c.name === 'notifications-service' || c.name === 'fraud-scoring';
      return { name: c.name + '-local', parent: 'idp-services', project: 'services', sync: S.synced[c.name + '-local'] ? 'Synced' : oos ? 'OutOfSync' : 'Synced', health: bad ? 'Degraded' : 'Healthy', rev: 'main@' + hash(c.name).toString(16).slice(0, 7), ns: 'services-dev', comp: c.name };
    });
  }
  function allArgoApps() {
    return D.argoApps.map(function (a) { return Object.assign({}, a, S.synced[a.name] ? { sync: 'Synced' } : {}); }).concat(k8sApps());
  }

  /* ---------- state ---------- */
  var S = {
    catalog: { q: '', kind: 'Component', owner: '', tier: '', system: '' },
    create: { q: '', cat: '' },
    form: {},
    run: null,
    learning: { topic: '', level: '', type: '' },
    done: {},
    chat: [],
    chatDraft: '',
    approvals: D.approvals.map(function (a) { return Object.assign({ status: 'pending' }, a); }),
    approvalsTab: 'pending',
    rollout: { step: 0, playing: false, aborted: false },
    grafana: 'services',
    aiQuery: 'how do I roll back a deployment',
    apiTry: null,
    mlExp: 0,
    trace: 'tr-8f21',
    alertState: '',
    synced: {},
    syncing: {},
    previews: D.previews.map(function (p) { return Object.assign({}, p); }),
    survey: {},
    surveySent: false,
    extraComponents: 0
  };
  D.learningDone.forEach(function (t) { S.done[t] = true; });
  try { var savedDone = JSON.parse(localStorage.getItem('idp-demo-learning') || 'null'); if (savedDone) S.done = savedDone; } catch (e) { /* storage unavailable */ }

  /* ---------- navigation model ---------- */
  var NAV = [
    { group: 'Portal', items: [
      ['home', 'Home', 'home'], ['catalog', 'Catalog', 'grid'], ['teams', 'Teams', 'users'], ['create', 'Create', 'plus'],
      ['apis', 'API Explorer', 'plug'], ['techdocs', 'TechDocs', 'book'], ['tech-radar', 'Tech Radar', 'radar'], ['dora', 'DORA Metrics', 'chart'],
      ['finops', 'FinOps', 'dollar'], ['incidents', 'Incidents', 'alert'], ['learning-center', 'Learning Center', 'cap'],
      ['engineering-intelligence', 'Engineering Intelligence', 'trend'], ['copilot', 'Copilot Metrics', 'sparkle'], ['devex-survey', 'DevEx Survey', 'clipboard']] },
    { group: 'AI', items: [
      ['ai-assistant', 'AI Assistant', 'chat'], ['ai-search', 'AI Search', 'search'], ['approvals', 'Agent Approvals', 'check'],
      ['kagent', 'KAgent Agents', 'bot'], ['mcp', 'MCP Servers', 'server'], ['ai-gateway', 'AI Gateway', 'route'],
      ['litellm', 'LiteLLM Spend', 'coins'], ['mlflow', 'MLflow', 'flask'], ['langfuse', 'Langfuse Traces', 'trace']] },
    { group: 'Operations', items: [
      ['argocd', 'ArgoCD', 'git'], ['rollouts', 'Argo Rollouts', 'rollout'], ['grafana', 'Dashboards', 'gauge'], ['alerts', 'Alerts', 'bell'],
      ['policies', 'Policy Violations', 'shield'], ['crossplane', 'Crossplane Claims', 'cloud'], ['previews', 'Preview Environments', 'eye']] }
  ];
  var ROUTES = [];
  NAV.forEach(function (g) { g.items.forEach(function (it) { ROUTES.push(it[0]); }); });

  function parts() {
    return (location.hash.replace(/^#\/?/, '') || 'home').split('/').map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } });
  }
  function current() { return parts()[0]; }

  function renderSidebar() {
    var cur = current();
    var map = { entity: 'catalog', team: 'teams' };
    cur = map[cur] || cur;
    var pending = S.approvals.filter(function (a) { return a.status === 'pending'; }).length;
    $('#sidebar').innerHTML = html`<a class="brand" href="#/home"><span class="brand-mark">${icon('layers', 18)}</span><span>Developer Platform<small>Internal Developer Platform</small></span></a>
      ${NAV.map(function (g) {
        return html`<div class="nav-group"><div class="nav-group-title">${g.group}</div>${g.items.map(function (it) {
          return html`<a class="nav-link" href="#/${it[0]}" ${it[0] === cur ? raw('aria-current="page"') : ''}>${icon(it[2])}<span>${it[1]}</span>${it[0] === 'approvals' && pending ? html`<span class="nav-badge" aria-label="${pending + ' pending'}">${pending}</span>` : ''}</a>`;
        })}</div>`;
      })}`.s;
  }

  /* ---------- pages: Portal ---------- */
  function pageHome() {
    var me = D.user, mine = D.components.filter(function (c) { return c.owner === me.team; });
    var open = D.incidents.filter(function (i) { return i.status !== 'resolved'; });
    var pending = S.approvals.filter(function (a) { return a.status === 'pending'; });
    var health = [
      ['ArgoCD', 'Healthy', allArgoApps().length + ' apps · ' + allArgoApps().filter(function (a) { return a.sync !== 'Synced'; }).length + ' out of sync'], ['Prometheus + Alertmanager', 'Healthy', '4 alerts firing'],
      ['AI Gateway', 'Degraded', '7 of 8 MCP targets up (security)'], ['LiteLLM', 'Healthy', '196 req/min'],
      ['Crossplane', 'Degraded', '2 of 7 claims not ready'], ['Backstage', 'Healthy', 'catalog refresh 41 s ago']
    ];
    var dfS = series('home-df', 12, 41, 6, 0.3), ltS = series('home-lt', 12, 6.2, 1.2, -0.3), cfS = series('home-cfr', 12, 6.4, 1.4, -0.2), mtS = series('home-mttr', 12, 38, 8, -0.2);
    return html`${head('Good afternoon, ' + me.name.split(' ')[0], 'Platform overview for ' + me.team + ' · Friday, Nov 20')}
      <div class="grid g4">
        ${stat('Components', D.components.length, 'in the catalog')}
        ${stat('APIs', D.apis.length, 'OpenAPI, AsyncAPI, GraphQL')}
        ${stat('Teams', D.teams.length, 'with cost budgets')}
        ${stat('Templates', D.templates.length, 'golden paths')}
      </div>
      <div class="grid g4" style="margin-top:16px">
        ${stat('Deploy frequency', '41/day', levelPill('Elite'), sparkline(dfS, 'var(--c1)'))}
        ${stat('Lead time', '6.2 h', levelPill('Elite'), sparkline(ltS, 'var(--c2)'))}
        ${stat('Change failure', '6.4%', levelPill('High'), sparkline(cfS, 'var(--c3)'))}
        ${stat('MTTR', '38 min', levelPill('Elite'), sparkline(mtS, 'var(--c4)'))}
      </div>
      <div class="grid g3" style="margin-top:16px">
        ${card('Platform health', html`<ul class="list">${health.map(function (h) {
          return html`<li><div style="flex:1"><strong>${h[0]}</strong><div class="muted small">${h[2]}</div></div>${statusPill(h[1])}</li>`;
        })}</ul>`)}
        ${card('My services', html`<ul class="list">${mine.slice(0, 7).map(function (c) {
          return html`<li><div style="flex:1;min-width:0">${entLink(c.name)}<div class="muted small">${c.lang} · ${c.lifecycle}</div></div>${tierPill(tierOf(c))}</li>`;
        })}</ul>`, html`<a href="#/catalog" data-action="set" data-key="catalog.owner" data-value="${me.team}">All ${mine.length}</a>`)}
        ${card('Needs your attention', html`<ul class="list">
          ${open.map(function (i) { return html`<li><span class="icon" style="background:var(--bad-soft);color:var(--bad)">${icon('alert')}</span><div><a href="#/incidents/${i.id}">${i.id}</a> ${i.title}<div class="muted small">${i.sev} · ${i.status}</div></div></li>`; })}
          ${pending.slice(0, 3).map(function (a) { return html`<li><span class="icon">${icon('check')}</span><div><a href="#/approvals">${a.id}</a> ${a.agent} wants to run <code>${a.tool}</code><div class="muted small">${a.target}</div></div></li>`; })}
          <li><span class="icon" style="background:var(--warn-soft);color:var(--warn)">${icon('dollar')}</span><div><a href="#/team/backend-team/budget">backend-team</a> is at 107% of its monthly budget<div class="muted small">TeamBudgetExceeded firing</div></div></li>
        </ul>`)}
      </div>
      ${card('Activity', html`<ul class="list">${D.activity.map(function (a) {
        var ic = { deploy: 'rollout', ai: 'bot', gitops: 'git', scaffold: 'plus', alert: 'bell', security: 'shield', scorecard: 'trend', cost: 'dollar' }[a.kind];
        var href = comp(a.target) ? '#/entity/' + a.target : team(a.target) ? '#/team/' + a.target : tpl(a.target) ? '#/create/' + a.target : '#/argocd';
        return html`<li><span class="icon">${icon(ic)}</span><div style="flex:1;min-width:0"><strong>${a.who}</strong> ${a.what} <a href="${href}">${a.target}</a><div class="muted small">${a.detail}</div></div><span class="muted small nowrap">${a.t}</span></li>`;
      })}</ul>`)}`;
  }

  function catalogEntities() {
    var out = [];
    D.components.forEach(function (c) { out.push({ kind: 'Component', name: c.name, type: c.type, owner: c.owner, system: c.system, lifecycle: c.lifecycle, desc: c.desc, tags: c.tags, tier: tierOf(c), href: '#/entity/' + c.name }); });
    D.apis.forEach(function (a) { out.push({ kind: 'API', name: a.name, type: a.type, owner: a.owner, system: a.system, lifecycle: 'production', desc: a.desc, tags: [a.type], href: '#/apis/' + a.name }); });
    D.systems.forEach(function (s) { out.push({ kind: 'System', name: s.name, type: 'system', owner: s.owner, system: s.name, lifecycle: '-', desc: s.desc, tags: [], sys: true }); });
    D.resources.forEach(function (r) { out.push({ kind: 'Resource', name: r.name, type: r.kind, owner: r.owner, system: r.system, lifecycle: 'production', desc: r.desc, tags: ['crossplane'], href: '#/crossplane' }); });
    return out;
  }
  function pageCatalog() {
    var f = S.catalog, q = f.q.toLowerCase();
    var rows = catalogEntities().filter(function (e) {
      return (!f.kind || e.kind === f.kind) && (!f.owner || e.owner === f.owner) && (!f.system || e.system === f.system) &&
        (!f.tier || e.tier === f.tier) && (!q || (e.name + ' ' + e.desc + ' ' + e.tags.join(' ')).toLowerCase().indexOf(q) >= 0);
    });
    return html`${head('Catalog', 'Every component, API, system and resource, with its owner and scorecard tier.', html`<a class="btn primary" href="#/create">${icon('plus')} Create</a>`)}
      <div class="filters">
        <label class="sr-only" for="cat-q">Filter catalog</label>
        <input class="input grow" id="cat-q" type="search" placeholder="Filter by name, description or tag" value="${f.q}" data-bind="catalog.q">
        ${select('catalog.kind', 'cat-kind', 'Kind', ['Component', 'API', 'System', 'Resource'], f.kind, 'All kinds')}
        ${select('catalog.owner', 'cat-owner', 'Owner', D.teams.map(function (t) { return t.name; }), f.owner, 'All owners')}
        ${select('catalog.system', 'cat-system', 'System', D.systems.map(function (s) { return s.name; }), f.system, 'All systems')}
        ${select('catalog.tier', 'cat-tier', 'Scorecard tier', [['gold', 'Gold'], ['silver', 'Silver'], ['bronze', 'Bronze'], ['none', 'No tier']], f.tier, 'All tiers')}
        ${f.q || f.owner || f.tier || f.system || f.kind !== 'Component' ? html`<button class="btn sm" type="button" data-action="reset-catalog">Clear</button>` : ''}
      </div>
      ${card(rows.length + ' ' + (f.kind ? f.kind.toLowerCase() + (rows.length === 1 ? '' : 's') : 'entities'), table(['Name', 'Kind', 'Type', 'Owner', 'System', 'Lifecycle', 'Tier', 'Tags'], rows.map(function (e) {
        return [e.sys ? html`<button class="btn sm" type="button" data-action="set" data-key="catalog.system" data-value="${e.name}" title="Show this system's entities">${e.name}</button>` : html`<a href="${e.href}"><strong>${e.name}</strong></a><div class="muted small">${e.desc}</div>`,
          e.kind, e.type, html`<span class="nowrap">${teamLink(e.owner)}</span>`, html`<span class="nowrap">${e.system}</span>`, e.lifecycle === '-' ? '-' : pill(e.lifecycle, e.lifecycle === 'production' ? 'ok' : 'warn'),
          e.kind === 'Component' ? tierPill(e.tier) : '-', e.tags.slice(0, 3).map(function (t) { return html`<span class="tag">${t}</span>`; })];
      })))}`;
  }

  var ENTITY_TABS = [['overview', 'Overview'], ['cicd', 'CI/CD'], ['dora', 'DORA'], ['scorecard', 'Scorecard'], ['security', 'Security'], ['slos', 'SLOs'],
    ['oncall', 'On-Call'], ['grafana', 'Grafana'], ['jira', 'Jira'], ['kubernetes', 'Kubernetes'], ['docs', 'Docs']];
  function pageEntity(name, tab) {
    var e = comp(name);
    if (!e) return notFound('No component named "' + name + '" in the catalog.');
    tab = tab || 'overview';
    var fn = ENTITY_RENDER[tab];
    if (!fn) return notFound('Unknown tab "' + tab + '".');
    return html`${head(e.name, e.desc, html`<a class="btn" href="#/ai-assistant" data-action="ask" data-prompt="${'Show metrics for ' + e.name}">${icon('chat')} Ask AI</a>`,
        html`<a href="#/catalog">Catalog</a> / Component / ${e.type}`)}
      <div class="btn-row" style="margin:-8px 0 16px">${pill(e.lifecycle, e.lifecycle === 'production' ? 'ok' : 'warn')} ${tierPill(tierOf(e))} ${pill('owner: ' + e.owner, 'info')} ${pill('system: ' + e.system)} ${pill(e.lang)}</div>
      ${tabs('entity/' + encodeURIComponent(e.name), ENTITY_TABS, tab)}${fn(e)}`;
  }
  function doraSeries(e) {
    return {
      df: series('df:' + e.name, 12, e.dora.df * 7, e.dora.df * 1.6, 0.25),
      lt: series('lt:' + e.name, 12, e.dora.lt, e.dora.lt * 0.25, -0.2),
      cfr: series('cfr:' + e.name, 12, e.dora.cfr, e.dora.cfr * 0.35, -0.1),
      mttr: series('mttr:' + e.name, 12, e.dora.mttr, e.dora.mttr * 0.3, -0.1)
    };
  }
  var ENTITY_RENDER = {
    overview: function (e) {
      var res = D.resources.filter(function (r) { return r.owner === e.owner && r.system === e.system; });
      var r = rng('deploys:' + e.name);
      return html`<div class="grid g3">
        ${card('About', html`<dl class="kv"><dt>Description</dt><dd>${e.desc}</dd><dt>Owner</dt><dd>${teamLink(e.owner)}</dd><dt>System</dt><dd>${e.system}</dd>
          <dt>Type</dt><dd>${e.type}</dd><dt>Language</dt><dd>${e.lang}</dd><dt>Version</dt><dd><code>${e.version}</code></dd>
          <dt>Repository</dt><dd><code>github.com/moatazeldebsy/${e.name}</code></dd><dt>Tags</dt><dd>${e.tags.map(function (t) { return html`<span class="tag">${t}</span>`; })}</dd></dl>`, null, 'span2')}
        ${card('Relations', html`<ul class="list">
          <li><span class="icon">${icon('users')}</span><div>Owned by ${teamLink(e.owner)}</div></li>
          <li><span class="icon">${icon('layers')}</span><div>Part of system <strong>${e.system}</strong></div></li>
          ${(e.apis || []).map(function (a) { return html`<li><span class="icon">${icon('plug')}</span><div>Provides API <a href="#/apis/${a}">${a}</a></div></li>`; })}
          ${res.slice(0, 2).map(function (x) { return html`<li><span class="icon">${icon('cloud')}</span><div>Depends on <a href="#/crossplane">${x.name}</a> (${x.kind})</div></li>`; })}
        </ul>`)}
      </div>
      <div class="grid g4" style="margin-top:16px">
        ${stat('Deploys / day', num(e.dora.df, 1), levelPill(doraLevel('df', e.dora.df)))}
        ${stat('Lead time', hours(e.dora.lt), levelPill(doraLevel('lt', e.dora.lt)))}
        ${stat('Change failure', pct(e.dora.cfr), levelPill(doraLevel('cfr', e.dora.cfr)))}
        ${stat('MTTR', dur(e.dora.mttr), levelPill(doraLevel('mttr', e.dora.mttr)))}
      </div>
      ${card('Recent deployments', table(['Version', 'Environment', 'Status', 'By', 'When'], [0, 1, 2, 3].map(function (i) {
        var envs = ['dev', 'staging', 'prod', 'prod'];
        return [html`<code>${i === 0 ? e.version : e.version.replace(/\d+$/, function (m) { return Math.max(0, +m - i); })}</code>`, envs[i], statusPill(i === 0 && e.name === 'inventory-service' ? 'Degraded' : 'Healthy'), D.people[Math.floor(r() * 12)], (i * 7 + 2 + Math.floor(r() * 5)) + ' h ago'];
      })))}`;
    },
    cicd: function (e) {
      var r = rng('ci:' + e.name), stages = ['Lint', 'Unit tests', 'SAST', 'Docker build', 'Trivy scan', 'Cosign sign', 'ArgoCD sync'];
      var runs = [];
      for (var i = 0; i < 8; i++) {
        var fail = r() < 0.15 && i > 0;
        runs.push([html`<code>#${1480 - i * 3}</code>`, i % 3 === 1 ? 'ci.yml' : 'build-and-deploy.yml', i % 4 === 2 ? 'feat/' + ['retry-budget', 'otel-spans', 'cache-ttl'][i % 3] : 'main',
          html`<code>${hash(e.name + i).toString(16).slice(0, 7)}</code>`, statusPill(i === 0 && e.name === 'inventory-service' ? 'failed' : fail ? 'failed' : 'success'),
          Math.floor(3 + r() * 6) + 'm ' + Math.floor(r() * 59) + 's', (i * 5 + 1) + ' h ago']);
      }
      var last = e.name === 'inventory-service' ? 2 : 7;
      return html`${card('Latest pipeline · main', html`<div class="rollout-steps">${stages.map(function (s, i) {
          return html`<span class="${i < last ? 'done' : i === last ? 'cur' : ''}">${i < last ? '✓ ' : ''}${s}</span>`;
        })}</div><p class="muted small" style="margin-top:10px">GitHub Actions → lint/test/SAST → Docker build → Trivy + Cosign → GitOps promotion through ArgoCD.</p>`)}
        ${card('Workflow runs', table(['Run', 'Workflow', 'Branch', 'Commit', 'Status', 'Duration', 'Started'], runs))}`;
    },
    dora: function (e) {
      var s = doraSeries(e), wl = weekLabels(12);
      return html`<div class="grid g4">
        ${stat('Deploy frequency', num(e.dora.df, 1) + '/day', levelPill(doraLevel('df', e.dora.df)), sparkline(s.df))}
        ${stat('Lead time for changes', hours(e.dora.lt), levelPill(doraLevel('lt', e.dora.lt)), sparkline(s.lt, 'var(--c2)'))}
        ${stat('Change failure rate', pct(e.dora.cfr), levelPill(doraLevel('cfr', e.dora.cfr)), sparkline(s.cfr, 'var(--c3)'))}
        ${stat('Time to restore', dur(e.dora.mttr), levelPill(doraLevel('mttr', e.dora.mttr)), sparkline(s.mttr, 'var(--c4)'))}
      </div>
      <div class="grid g2" style="margin-top:16px">
        ${card('Deployments per week', barChart(s.df.map(function (v, i) { return { label: wl[i], value: Math.round(v) }; }), { label: 'Deployments per week' }))}
        ${card('Lead time (hours, commit → prod)', lineChart([{ name: 'Lead time', values: s.lt }], { labels: wl, label: 'Lead time per week' }))}
        ${card('Change failure rate (%)', lineChart([{ name: 'CFR', values: s.cfr, color: 'var(--c3)' }], { labels: wl, threshold: { value: 15, label: 'Medium/Low boundary' }, label: 'Change failure rate' }))}
        ${card('Time to restore (minutes)', lineChart([{ name: 'MTTR', values: s.mttr, color: 'var(--c4)' }], { labels: wl, label: 'MTTR' }))}
      </div>
      <p class="muted small" style="margin-top:12px">Source: Prometheus <code>dora_*</code> series from the DORA exporter, keyed by <code>github.com/project-slug</code>.</p>`;
    },
    scorecard: function (e) {
      var cr = checkResults(e), th = e.ai ? D.tierThresholds.ai : D.tierThresholds.std, t = tierOf(e);
      var next = t === 'none' ? ['bronze', th.bronze] : t === 'bronze' ? ['silver', th.silver] : t === 'silver' ? ['gold', th.gold] : null;
      var groups = [];
      cr.checks.forEach(function (c) { if (groups.indexOf(c[1]) < 0) groups.push(c[1]); });
      return html`<div class="grid g3">
        ${card('Tier', html`<div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">${tierPill(t)}<span class="muted">${cr.count} of ${cr.checks.length} checks passing</span></div>
          <div class="bar" style="height:10px"><span style="width:${(cr.count / cr.checks.length * 100).toFixed(0)}%"></span></div>
          <p class="muted small" style="margin-top:10px">${next ? 'Pass ' + (next[1] - cr.count) + ' more to reach ' + next[0][0].toUpperCase() + next[0].slice(1) + '.' : 'Top tier reached.'}
          Thresholds${e.ai ? ' (AI entity)' : ''}: Bronze ${th.bronze} · Silver ${th.silver} · Gold ${th.gold}.</p>`)}
        ${card('By group', hbars(groups.map(function (g) {
          var gc = cr.checks.filter(function (c) { return c[1] === g; }), p = gc.filter(function (c) { return cr.pass[c[0]]; }).length;
          return { label: g, value: p, max: gc.length, text: p + '/' + gc.length, color: p === gc.length ? 'var(--ok)' : 'var(--brand)' };
        })), null, 'span2')}
      </div>
      ${groups.map(function (g) {
        return card(g, html`<ul class="list">${cr.checks.filter(function (c) { return c[1] === g; }).map(function (c) {
          var ok = cr.pass[c[0]];
          return html`<li><span class="icon" style="${raw(ok ? 'background:var(--ok-soft);color:var(--ok)' : 'background:var(--bad-soft);color:var(--bad)')}">${icon(ok ? 'ok' : 'x')}</span>
            <div style="flex:1"><strong>${c[2]}</strong> <code class="small">${c[0]}</code>${ok ? '' : html`<div class="muted small">Not passing. See the remediation hint on the Tech Insights check, or run the matching golden-path template from <a href="#/create">Create</a>.</div>`}</div>
            ${pill(ok ? 'Pass' : 'Fail', ok ? 'ok' : 'bad')}</li>`;
        })}</ul>`);
      })}`;
    },
    security: function (e) {
      var r = rng('sec:' + e.name), weak = 14 - e.score;
      var sonar = { gate: e.score >= 8, bugs: Math.max(0, Math.round(weak * r())), vulns: Math.max(0, Math.round(weak * 0.4 * r())), smells: Math.round(20 + weak * 9 * r()), cov: Math.min(94, 52 + e.score * 2.6 + r() * 5), dup: 1 + r() * 4 };
      var snyk = [Math.max(0, weak - 9) > 0 ? 1 : 0, Math.round(Math.max(0, weak - 5) * r()), Math.round(2 + weak * r()), Math.round(3 + 6 * r())];
      if (e.name === 'inventory-service') snyk[1] = 2;
      var trivy = [0, Math.round(Math.max(0, weak - 6) * r()), Math.round(1 + weak * 0.6 * r()), Math.round(4 + 8 * r())];
      function sevRow(v) { return html`<div class="btn-row">${pill(v[0] + ' critical', v[0] ? 'bad' : '')} ${pill(v[1] + ' high', v[1] ? 'warn' : '')} ${pill(v[2] + ' medium')} ${pill(v[3] + ' low')}</div>`; }
      return html`<div class="grid g3">
        ${card('SonarCloud', html`<div style="margin-bottom:12px">${pill('Quality gate: ' + (sonar.gate ? 'Passed' : 'Failed'), sonar.gate ? 'ok' : 'bad')}</div>
          <dl class="kv"><dt>Bugs</dt><dd>${sonar.bugs}</dd><dt>Vulnerabilities</dt><dd>${sonar.vulns}</dd><dt>Code smells</dt><dd>${sonar.smells}</dd>
          <dt>Coverage</dt><dd>${pct(sonar.cov)}</dd><dt>Duplication</dt><dd>${pct(sonar.dup)}</dd></dl>`, html`<span class="muted">sonarcloud.io/project-key</span>`)}
        ${card('Snyk (dependencies)', html`${sevRow(snyk)}<ul class="list" style="margin-top:10px">
          ${snyk[1] ? html`<li><div><strong>${e.lang === 'Go' ? 'golang.org/x/net' : e.lang === 'Python' ? 'urllib3 1.26.18' : 'express 4.19.2'}</strong><div class="muted small">HTTP request smuggling · fix available</div></div></li>` : ''}
          <li><div><strong>${e.lang === 'Go' ? 'google.golang.org/grpc' : e.lang === 'Python' ? 'jinja2 3.1.3' : 'path-to-regexp 0.1.7'}</strong><div class="muted small">ReDoS · medium · upgrade to latest minor</div></div></li></ul>`, html`<span class="muted">snyk.io/org-slug</span>`)}
        ${card('Trivy (image)', html`${sevRow(trivy)}<p class="muted small" style="margin-top:10px">Image <code>ghcr.io/moatazeldebsy/${e.name}:${e.version}</code>, scanned in CI ${Math.floor(1 + r() * 20)} h ago. Image signed with Cosign.</p>`)}
      </div>`;
    },
    slos: function (e) {
      if (!e.slo) return html`<div class="notice info">No SLOs defined for ${e.name}. Use the <a href="#/create/slo-definition">Define SLOs</a> template to add availability and latency objectives (Sloth generates the rules).</div>`;
      var s = sloState(e), dl = dayLabels(30);
      function sliSeries(k, st) { return series('sli:' + k + e.name, 30, st.sli, (100 - st.target) * 0.3, 0).map(function (v) { return Math.min(100, v); }); }
      function block(k, label, st) {
        return card(label + ' · target ' + st.target + '%', html`<div class="grid g3">
          ${gauge(st.remain, 'Error budget remaining', pct(st.remain * 100, 0))}
          <div><dl class="kv"><dt>SLI (30d)</dt><dd><strong>${num(st.sli, 3)}%</strong></dd><dt>Target</dt><dd>${st.target}%</dd><dt>Burn rate (1h)</dt><dd>${num(st.burn, 2)}×</dd>
            <dt>Status</dt><dd>${st.remain < 0.2 ? pill('At risk', 'bad') : st.remain < 0.5 ? pill('Watch', 'warn') : pill('Healthy', 'ok')}</dd></dl></div>
          <div>${lineChart([{ name: 'SLI', values: sliSeries(k, st) }], { labels: dl, min: Math.floor(st.target - (100 - st.target)), max: 100, threshold: { value: st.target, label: 'target' }, yFmt: function (v) { return num(v, 2); }, h: 150, label: label + ' SLI' })}</div>
        </div>`);
      }
      return html`${block('a', 'Availability', s.avail)}${block('l', 'Latency (p99 < 300 ms)', s.latency)}
        <p class="muted small" style="margin-top:12px">From <code>sloth_slo_info{sloth_service="${e.name}"}</code> and <code>slo:sli_error:ratio_rate5m</code>.</p>`;
    },
    oncall: function (e) {
      var r = rng('oncall:' + e.name), p = D.people, i0 = Math.floor(r() * p.length);
      return html`<div class="grid g3">
        ${card('On call now', html`<div style="display:flex;gap:12px;align-items:center"><div class="avatar" aria-hidden="true">${initials(p[i0])}</div><div><strong>${p[i0]}</strong><div class="muted small">${e.owner} primary · until Mon 09:00</div></div></div>
          <div class="btn-row" style="margin-top:14px"><button class="btn sm" type="button" data-action="toast" data-msg="Demo only: no page was sent.">Page on-call</button></div>`)}
        ${card('Escalation policy', html`<ol style="margin:0;padding-left:20px"><li>${p[i0]} (primary) · 5 min</li><li>${p[(i0 + 1) % p.length]} (secondary) · 15 min</li><li>${team(e.owner) ? team(e.owner).lead : p[0]} (team lead)</li></ol>`)}
        ${card('Upcoming shifts', html`<ul class="list">${[1, 2, 3].map(function (k) { return html`<li><div style="flex:1">${p[(i0 + k) % p.length]}</div><span class="muted small">${['Mon 09:00', 'Mon 30 Nov', 'Mon 7 Dec'][k - 1]}</span></li>`; })}</ul>`)}
      </div>
      ${card('Recent incidents', table(['Incident', 'Severity', 'Status', 'Started'], D.incidents.filter(function (i) { return i.service === e.name; }).map(function (i) {
        return [html`<a href="#/incidents/${i.id}">${i.id}</a> ${i.title}`, i.sev, statusPill(i.status), i.started];
      })))}`;
    },
    grafana: function (e) {
      var hl = hourLabels(24), base = e.replicas * 40 + 20;
      var rps = series('rps:' + e.name, 24, base, base * 0.25), err = series('err:' + e.name, 24, e.dora.cfr / 10, 0.25), p95 = series('p95:' + e.name, 24, 120 + e.dora.lt * 3, 30);
      if (e.name === 'inventory-service') err = err.map(function (v, i) { return i > 20 ? v + 4 : v; });
      return html`<div class="notice info">Panels from the <strong>IDP Services</strong> Grafana dashboard filtered by <code>service=${e.name}</code>.</div>
        <div class="grid g3">
          ${card('Requests / s', lineChart([{ name: 'rps', values: rps }], { labels: hl, h: 150, label: 'Requests per second' }))}
          ${card('Error rate (%)', lineChart([{ name: '5xx %', values: err, color: 'var(--c5)' }], { labels: hl, h: 150, threshold: { value: 1, label: 'alert' }, label: 'Error rate' }))}
          ${card('p95 latency (ms)', lineChart([{ name: 'p95', values: p95, color: 'var(--c2)' }], { labels: hl, h: 150, label: 'p95 latency' }))}
        </div>
        ${card('Alerts for this service', table(['Alert', 'State', 'Labels'], D.alerts.filter(function (a) { return a.labels.indexOf(e.name) >= 0; }).map(function (a) {
          return [a.name, statusPill(a.state), html`<code>${a.labels}</code>`];
        })))}`;
    },
    jira: function (e) {
      var key = e.name.split('-').map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 3) + (e.name.length % 10);
      var r = rng('jira:' + e.name), sts = ['To Do', 'In Progress', 'In Review', 'Done'], types = ['Story', 'Bug', 'Task'];
      var titles = ['Add retry budget to downstream calls', 'Flaky integration test on CI', 'Upgrade base image to distroless', 'Expose p99 latency metric', 'Document runbook URL', 'Rate limit per client', 'Migrate to OTel SDK 1.30', 'Fix memory leak in cache warmup'];
      var issues = titles.map(function (t, i) { return [key + '-' + (120 + i * 7), t, types[Math.floor(r() * 3)], sts[Math.floor(r() * 4)], D.people[Math.floor(r() * 12)], ['High', 'Medium', 'Low'][Math.floor(r() * 3)]]; });
      return html`<div class="grid g4">${sts.map(function (s) { return stat(s, issues.filter(function (x) { return x[3] === s; }).length, 'issues'); })}</div>
        ${card('Open issues · project ' + key, table(['Key', 'Summary', 'Type', 'Status', 'Assignee', 'Priority'], issues.map(function (x) {
          return [html`<code>${x[0]}</code>`, x[1], x[2], pill(x[3], x[3] === 'Done' ? 'ok' : x[3] === 'In Progress' ? 'info' : x[3] === 'In Review' ? 'warn' : ''), x[4], x[5]];
        })), html`<span class="muted">jira/project-key: ${key}</span>`)}`;
    },
    kubernetes: function (e) {
      if (!e.replicas) return html`<div class="notice info">${e.name} is a ${e.type}; it has no Kubernetes workloads.</div>`;
      var r = rng('k8s:' + e.name), bad = e.name === 'inventory-service', pods = [];
      for (var i = 0; i < e.replicas; i++) {
        var id = hash(e.name + i).toString(36).slice(0, 5);
        pods.push([html`<code>${e.name}-${hash(e.name).toString(16).slice(0, 5)}-${id}</code>`, statusPill(bad ? 'CrashLoopBackOff' : 'Running'), bad ? 7 + i : Math.floor(r() * 2), (bad ? '38m' : Math.floor(2 + r() * 9) + 'd'), Math.floor(40 + r() * 160) + 'm', Math.floor(90 + r() * 300) + 'Mi']);
      }
      return html`<div class="grid g4">
        ${stat('Pods', (bad ? 0 : e.replicas) + ' / ' + e.replicas, 'ready')}
        ${stat('Namespace', 'services-dev', 'backstage.io/kubernetes-id')}
        ${stat('HPA', e.replicas + ' → ' + e.replicas * 3, 'target CPU 70%')}
        ${stat('PDB', 'minAvailable 1', 'allowed disruptions ' + (bad ? 0 : 1))}
      </div>
      ${bad ? html`<div class="notice" style="margin-top:16px">Pods are crash-looping: <code>Error: REDIS_URL is not set</code>. See <a href="#/incidents/INC-2042">INC-2042</a> and the <a href="#/techdocs/runbooks">pod-crash-loop runbook</a>.</div>` : ''}
      ${card('Pods', table(['Pod', 'Status', 'Restarts', 'Age', 'CPU', 'Memory'], pods, [2, 4, 5]))}`;
    },
    docs: function (e) {
      return card(e.name + ' docs', html`<div class="prose"><p>${e.desc}</p><h2>Run locally</h2>
        <pre><code>${e.lang === 'Go' ? 'go test ./... && go run ./src' : e.lang === 'Python' ? 'pip install -r requirements.txt\nuvicorn app.main:app --reload' : e.lang === 'Java' ? './gradlew bootRun' : 'npm ci && npm run dev'}</code></pre>
        <h2>Deploy</h2><p>Merging to <code>main</code> builds and signs the image, then ArgoCD syncs <code>${e.name}-local</code> from <code>services/${e.name}/helm-values-local.yaml</code> using the shared <code>helm/service-template</code> chart.</p>
        <h2>Runbooks</h2><ul>${D.runbooks.slice(0, 4).map(function (rb) { return html`<li><a href="#/techdocs/runbooks">${rb[1]}</a></li>`; })}</ul></div>`,
        html`<a href="#/techdocs/${e.name === 'hello-service' ? 'hello-service' : 'getting-started'}">Open in TechDocs</a>`);
    }
  };

  function pageTeams() {
    return html`${head('Teams', 'Groups in the catalog, with owned components and monthly cost budgets.')}
      <div class="grid g-auto">${D.teams.map(function (t) {
        var owned = D.components.filter(function (c) { return c.owner === t.name; }).length, u = t.spend / t.budget;
        return html`<section class="card"><div class="card-head"><h2><a href="#/team/${t.name}">${t.display}</a></h2>${u > 1 ? pill('Over budget', 'bad') : u > 0.8 ? pill('80%+', 'warn') : ''}</div>
          <p class="muted small">${t.mission}</p>
          <dl class="kv"><dt>Lead</dt><dd>${t.lead}</dd><dt>Members</dt><dd>${t.members}</dd><dt>Components</dt><dd>${owned}</dd><dt>Budget</dt><dd>${money(t.spend)} of ${money(t.budget)}</dd></dl>
          <div class="bar" style="margin-top:10px"><span style="width:${Math.min(100, u * 100).toFixed(0)}%;background:${raw(u > 1 ? 'var(--bad)' : u > 0.8 ? 'var(--warn)' : 'var(--ok)')}"></span></div></section>`;
      })}</div>`;
  }
  function pageTeam(name, tab) {
    var t = team(name);
    if (!t) return notFound('No team named "' + name + '".');
    tab = tab || 'overview';
    var owned = D.components.filter(function (c) { return c.owner === t.name; });
    var body;
    if (tab === 'budget') {
      var days = 20, daily = series('bd:' + t.name, days, t.spend / days, t.spend / days * 0.3);
      var scale = t.spend / daily.reduce(function (a, b) { return a + b; }, 0), cum = [], acc = 0;
      daily.forEach(function (v) { acc += v * scale; cum.push(acc); });
      var forecast = t.spend / 20 * 30, u = t.spend / t.budget;
      var budgetLine = cum.map(function (_, i) { return t.budget * (i + 1) / 30; });
      var cats = [{ name: 'Compute', value: Math.round(t.spend * 0.58) }, { name: 'Storage', value: Math.round(t.spend * 0.14) }, { name: 'Network', value: Math.round(t.spend * 0.09) }, { name: 'AI / LLM', value: Math.round(t.spend * 0.19) }];
      body = html`<div class="grid g3">
          ${card('Budget utilisation', gauge(u, 'of ' + money(t.budget) + ' / month', pct(u * 100, 0), u > 1 ? 'var(--bad)' : u > 0.8 ? 'var(--warn)' : 'var(--ok)'))}
          ${card('November', html`<dl class="kv"><dt>Spent so far</dt><dd><strong>${money(t.spend)}</strong></dd><dt>Budget</dt><dd>${money(t.budget)}</dd><dt>Remaining</dt><dd>${money(Math.max(0, t.budget - t.spend))}</dd>
            <dt>Forecast (month end)</dt><dd>${money(forecast)} ${forecast > t.budget ? pill('over', 'bad') : pill('within', 'ok')}</dd><dt>Annotation</dt><dd><code>idp.io/cost-budget-monthly-usd: "${t.budget}"</code></dd></dl>`)}
          ${card('By category', donut(cats, [money(t.spend), 'this month'], { fmt: money, label: 'Spend by category' }))}
        </div>
        ${card('Cumulative spend vs budget pace', lineChart([{ name: 'Actual', values: cum }, { name: 'Budget pace', values: budgetLine, color: 'var(--text-muted)', dash: true }], { labels: dayLabels(days), yFmt: function (v) { return '$' + num(v, 0); }, label: 'Cumulative spend' }))}
        ${card('Cost by component', hbars(owned.map(function (c, i) { var v = t.spend * (0.15 + rng(c.name)() * 0.4) / Math.max(1, owned.length) * 2; return { label: c.name, value: v, max: t.spend, text: money(v) }; })))}
        <p class="muted small" style="margin-top:12px">From <code>idp_team_actual_cost_usd_monthly{team="${t.name}"}</code> pushed by the tech-insights exporter from OpenCost. AlertManager fires TeamBudgetWarning at 80% and TeamBudgetExceeded at 100%.</p>`;
    } else {
      body = html`<div class="grid g3">
        ${card('About', html`<p>${t.mission}</p><dl class="kv"><dt>Lead</dt><dd>${t.lead}</dd><dt>Members</dt><dd>${t.members}</dd><dt>Namespace</dt><dd><code>${t.namespace}</code></dd><dt>Slack</dt><dd>${t.slack}</dd></dl>`)}
        ${card('Members', html`<ul class="list">${D.people.slice(0, Math.min(6, t.members)).map(function (p, i) {
          var person = i === 0 ? t.lead : D.people[(hash(t.name) + i) % D.people.length];
          return html`<li><div class="avatar" aria-hidden="true">${initials(person)}</div><div>${person}<div class="muted small">${i === 0 ? 'Team lead' : 'Engineer'}</div></div></li>`;
        })}</ul>`)}
        ${card('Maturity', (function () {
          var sc = D.teamScores[t.name];
          return hbars(D.dimensions.map(function (d, i) { return { label: d, value: sc[i], max: 100, text: String(sc[i]) }; }));
        })())}
      </div>
      ${card('Owned components', table(['Name', 'Type', 'Lifecycle', 'Tier', 'Deploys/day'], owned.map(function (c) {
        return [entLink(c.name), c.type, c.lifecycle, tierPill(tierOf(c)), num(c.dora.df, 1)];
      }), [4]))}`;
    }
    return html`${head(t.display, t.mission, null, html`<a href="#/teams">Teams</a> / Group`)}${tabs('team/' + t.name, [['overview', 'Overview'], ['budget', 'Budget']], tab)}${body}`;
  }

  var TPL_CATS = [['service', 'Services'], ['website', 'Frontend'], ['test-suite', 'Test suites'], ['resource', 'Cloud resources'], ['infrastructure', 'Infrastructure'],
    ['platform-capability', 'Platform capabilities'], ['template', 'AI & ML'], ['ai-agent', 'AI & ML'], ['mobile', 'Mobile'], ['library', 'Mobile']];
  function tplCat(t) { var m = TPL_CATS.filter(function (c) { return c[0] === t.type; })[0]; return m ? m[1] : 'Other'; }
  function pageCreate() {
    var cats = [];
    TPL_CATS.forEach(function (c) { if (cats.indexOf(c[1]) < 0) cats.push(c[1]); });
    var q = S.create.q.toLowerCase();
    var list = D.templates.filter(function (t) {
      return (!S.create.cat || tplCat(t) === S.create.cat) && (!q || (t.n + ' ' + t.t + ' ' + t.d + ' ' + t.tags.join(' ')).toLowerCase().indexOf(q) >= 0);
    });
    return html`${head('Create', D.templates.length + ' golden-path templates. Pick one to scaffold a repo, a test suite or a cloud resource.')}
      <div class="filters"><label class="sr-only" for="tpl-q">Search templates</label>
        <input class="input grow" id="tpl-q" type="search" placeholder="Search templates (e.g. kafka, playwright, agent)" value="${S.create.q}" data-bind="create.q">
      </div>
      <div style="margin-bottom:18px">${chips('create.cat', cats, S.create.cat, 'All')}</div>
      ${list.length ? cats.map(function (c) {
        var items = list.filter(function (t) { return tplCat(t) === c; });
        if (!items.length) return '';
        return html`<div class="cat-title"><h2>${c}</h2><span class="muted">${items.length}</span></div>
          <div class="grid g-auto">${items.map(function (t) {
            return html`<article class="card tpl"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><h3>${t.t}</h3>${pill(t.type, 'info')}</div>
              <p>${t.d}</p><div>${t.tags.slice(0, 4).map(function (g) { return html`<span class="tag">${g}</span>`; })}</div>
              <a class="btn sm primary" href="#/create/${t.n}">Choose</a></article>`;
          })}</div>`;
      }) : html`<div class="card empty">No templates match "${S.create.q}".</div>`}`;
  }
  function pageTemplate(name, sub) {
    var t = tpl(name);
    if (!t) return notFound('No template named "' + name + '".');
    if (sub === 'run') return pageRun(t);
    var f = S.form[name] || (S.form[name] = { name: defaultName(t), owner: D.user.team, desc: '', target: 'local', service: 'hello-service' });
    var isSuite = t.type === 'test-suite' || t.type === 'platform-capability';
    return html`${head(t.t, t.d, null, html`<a href="#/create">Create</a> / ${t.n}`)}
      <div class="grid g3">
        <section class="card span2"><form data-submit="scaffold" data-tpl="${t.n}" novalidate>
          ${isSuite ? html`<div class="field"><label for="f-service">Target service</label>
            <select class="input" id="f-service" data-bind-quiet="form.${t.n}.service">${D.components.map(function (c) { return html`<option ${c.name === f.service ? raw('selected') : ''}>${c.name}</option>`; })}</select>
            <span class="hint">Opens a PR adding the suite to this service's repository.</span></div>` : ''}
          <div class="field"><label for="f-name">${isSuite ? 'Suite name' : 'Name'}</label>
            <input class="input" id="f-name" required pattern="[a-z][a-z0-9-]{2,40}" value="${f.name}" data-bind-quiet="form.${t.n}.name" aria-describedby="f-name-hint">
            <span class="hint" id="f-name-hint">Lowercase letters, digits and hyphens.</span></div>
          <div class="field"><label for="f-owner">Owner</label><select class="input" id="f-owner" data-bind-quiet="form.${t.n}.owner">${D.teams.map(function (tm) { return html`<option value="${tm.name}" ${tm.name === f.owner ? raw('selected') : ''}>group:default/${tm.name}</option>`; })}</select></div>
          <div class="field"><label for="f-desc">Description</label><textarea class="input" id="f-desc" data-bind-quiet="form.${t.n}.desc" placeholder="What does it do?">${f.desc}</textarea></div>
          <fieldset class="field" style="border:0;padding:0;margin:0 0 14px"><legend style="font-weight:600;font-size:13px;margin-bottom:6px;color:var(--text-strong)">Deploy target</legend>
            <div class="btn-row">${[['local', 'Local (Kind / Rancher Desktop)'], ['aws', 'AWS (EKS)']].map(function (o) {
              return html`<label class="chip" style="display:inline-flex;gap:6px;align-items:center"><input type="radio" name="target" value="${o[0]}" ${f.target === o[0] ? raw('checked') : ''} data-bind-quiet="form.${t.n}.target">${o[1]}</label>`;
            })}</div></fieldset>
          <p class="muted small" id="form-error" role="alert"></p>
          <div class="btn-row"><button class="btn primary" type="submit">${icon('zap')} Create</button><a class="btn" href="#/create">Back</a></div>
        </form></section>
        ${card('What you get', html`<ul class="list">${(isSuite ? ['Test suite under test-suites/<name>/', 'CI job wired into the target repo', 'Tech Insights metrics pushed to Pushgateway', 'Pull request against the target service'] :
          t.type === 'resource' ? ['Claim or Terraform module for the resource', 'Connection secret in your namespace', 'Pull request for review', 'Catalog Resource entity'] :
            ['GitHub repo with CI (lint, test, SAST, Trivy, Cosign)', 'helm-values-local.yaml and helm-values-aws.yaml', 'catalog-info.yaml with scorecard annotations', 'ArgoCD Application via the idp-services ApplicationSet']).map(function (x) {
          return html`<li><span class="icon">${icon('ok')}</span><div>${x}</div></li>`;
        })}</ul><div style="margin-top:8px">${t.tags.map(function (g) { return html`<span class="tag">${g}</span>`; })}</div>`)}
      </div>`;
  }
  function defaultName(t) {
    var m = { 'go-service': 'inventory-sync', 'python-service': 'loyalty-points', 'nodejs-service': 'gift-cards', 'jvm-service': 'tax-calculator', 'react-frontend': 'account-web' };
    return m[t.n] || (t.type === 'test-suite' ? t.n.replace(/-suite$|-test-suite$/, '') + '-tests' : 'my-' + t.n.split('-')[0]);
  }
  function runSteps(t, v) {
    var repo = 'moatazeldebsy/' + v.name;
    if (t.type === 'test-suite' || t.type === 'platform-capability') return [
      ['Fetch skeleton', ['fetch:template skeleton-addon/test-suites/' + v.name]], ['Render files', ['Rendered 9 files', 'Wrote .github/workflows/' + v.name + '.yml']],
      ['Open pull request', ['publish:github:pull-request → ' + 'moatazeldebsy/' + v.service, 'PR #' + (400 + hash(v.name) % 90) + ' opened: "test: add ' + v.name + '"']],
      ['Push Tech Insights metrics', ['idp:tech-insights → pushgateway.idp.local', 'has-e2e-tests=1 has-coverage-gate=1']]];
    if (t.type === 'resource') return [
      ['Render claim', ['fetch:template → services/' + v.service + '/claims/' + v.name + '.yaml']], ['Validate', ['kubeconform: 1 resource valid', 'Kyverno policy check: pass']],
      ['Open GitOps PR', ['PR #' + (600 + hash(v.name) % 90) + ' opened against platform repo']], ['ArgoCD sync', ['idp-services synced claim', 'Claim ' + v.name + ': Synced=True Ready=True']]];
    return [
      ['Fetch skeleton', ['fetch:template ./skeleton → workspace', 'Rendered 27 files for ' + t.t]],
      ['Publish to GitHub', ['publish:github → github.com/' + repo, 'Branch protection enabled on main', 'Secrets set: GHCR_TOKEN, SONAR_TOKEN']],
      ['Register in catalog', ['catalog:register → ' + repo + '/catalog-info.yaml', 'Component ' + v.name + ' owned by ' + v.owner]],
      ['Open GitOps PR', ['services/' + v.name + '/helm-values-' + v.target + '.yaml', 'PR #' + (700 + hash(v.name) % 90) + ' "feat: onboard ' + v.name + '" auto-merged (values only)']],
      ['ArgoCD sync', ['ApplicationSet idp-services generated ' + v.name + '-' + (v.target === 'aws' ? 'aws' : 'local'), 'Sync OK · Health Progressing', 'Health Healthy (1/1 pods ready)']],
      ['Push Tech Insights', ['idp:tech-insights → 9 checks evaluated', 'Scorecard tier: Silver']]];
  }
  function pageRun(t) {
    var run = S.run;
    if (!run || run.tpl !== t.n) {
      return html`${head(t.t, 'No run in progress.', null, html`<a href="#/create">Create</a> / <a href="#/create/${t.n}">${t.n}</a> / run`)}<div class="card empty"><p>Start a run from the template form.</p><a class="btn primary" href="#/create/${t.n}">Open form</a></div>`;
    }
    var steps = run.steps, v = run.values, isService = !(t.type === 'test-suite' || t.type === 'platform-capability' || t.type === 'resource');
    return html`${head('Run: ' + t.t, run.done ? 'Finished in ' + (steps.length * 1.4).toFixed(1) + ' s' : 'Running…', null, html`<a href="#/create">Create</a> / <a href="#/create/${t.n}">${t.n}</a> / run`)}
      <div class="grid g3">
        ${card('Steps', html`<ol class="steps">${steps.map(function (s, i) {
          var st = i < run.step ? 'done' : i === run.step && !run.done ? 'running' : '';
          return html`<li><span class="step-ic ${st}" aria-hidden="true">${st === 'done' ? '✓' : ''}</span><span style="flex:1">${s[0]}</span><span class="muted small">${st === 'done' ? 'done' : st === 'running' ? 'running' : 'waiting'}</span></li>`;
        })}</ol>`)}
        ${card('Log', html`<div class="log" id="run-log" aria-live="polite">${run.lines.map(function (l) { return html`<div class="${l[0]}">${l[1]}</div>`; })}</div>`, null, 'span2')}
      </div>
      ${run.done ? card('Output', html`<div class="notice info" style="border-color:var(--ok);background:var(--ok-soft)"><strong>${isService ? 'Pull request opened and ArgoCD synced.' : 'Pull request opened.'}</strong> ${v.name} is ready.</div>
        <div class="btn-row">
          ${isService ? html`<a class="btn primary" href="#/entity/${v.name}">Open ${v.name} in the catalog</a><a class="btn" href="#/argocd">View in ArgoCD</a>` : html`<a class="btn primary" href="#/entity/${v.service}">Open ${v.service}</a>`}
          <span class="btn" aria-disabled="true" title="Demo only">PR #${(700 + hash(v.name) % 90)} on github.com/moatazeldebsy</span>
          <a class="btn" href="#/create">Create another</a></div>`) : ''}`;
  }
  function startRun(t, values) {
    S.run = { tpl: t.n, values: values, steps: runSteps(t, values), step: 0, lines: [['dim', '$ scaffolder run ' + t.n + ' --name ' + values.name]], done: false, sub: 0 };
    var run = S.run;
    function tick() {
      if (S.run !== run) return;
      var s = run.steps[run.step];
      if (run.sub === 0) run.lines.push(['', '▸ ' + s[0]]);
      if (run.sub < s[1].length) { run.lines.push(['dim', '  ' + s[1][run.sub]]); run.sub++; }
      else { run.lines.push(['ok', '  ✓ ' + s[0] + ' done']); run.step++; run.sub = 0; }
      if (run.step >= run.steps.length) {
        run.done = true;
        run.lines.push(['ok', '✓ Run completed']);
        var isService = !(t.type === 'test-suite' || t.type === 'platform-capability' || t.type === 'resource');
        if (isService) registerEntity(values, t);
      } else setTimeout(tick, 380);
      refreshIf('create');
    }
    setTimeout(tick, 300);
  }
  function registerEntity(v, t) {
    if (comp(v.name)) return;
    var lang = { 'go-service': 'Go', 'python-service': 'Python', 'nodejs-service': 'Node.js', 'jvm-service': 'Java', 'ruby-service': 'Ruby', 'react-frontend': 'React' }[t ? t.n : ''] || 'Go';
    D.components.push({ name: v.name, type: t && t.type === 'website' ? 'website' : 'service', owner: v.owner, system: 'commerce', lifecycle: 'experimental', lang: lang,
      desc: v.desc || 'Scaffolded from the ' + (t ? t.t : 'Go Service') + ' template a moment ago.', tags: [lang.toLowerCase(), 'golden-path', 'new'], score: 7,
      slo: { avail: 99.5, latency: 99.0 }, dora: { df: 1, lt: 0.4, cfr: 0, mttr: 0 }, replicas: 1, version: '0.1.0' });
  }

  function pageApis(sel) {
    var a = D.apis.filter(function (x) { return x.name === sel; })[0] || null;
    if (sel && !a) return notFound('No API named "' + sel + '".');
    a = a || D.apis[0];
    var mcls = { GET: 'ok', POST: 'info', PUT: 'warn', DELETE: 'bad', PUB: 'warn', QUERY: 'info' };
    return html`${head('API Explorer', 'OpenAPI, AsyncAPI and GraphQL definitions registered in the catalog.')}
      <div class="docs-layout">
        <nav class="card docs-nav" aria-label="APIs" style="padding:8px">${D.apis.map(function (x) {
          return html`<a href="#/apis/${x.name}" ${x === a ? raw('aria-current="page"') : ''}>${x.name}<div class="muted small">${x.type} · ${x.owner}</div></a>`;
        })}</nav>
        <div>
          ${card(a.name + ' ' + a.version, html`<p>${a.desc}</p><dl class="kv"><dt>Type</dt><dd>${pill(a.type, 'info')}</dd><dt>Provided by</dt><dd>${entLink(a.provider)}</dd><dt>Owner</dt><dd>${teamLink(a.owner)}</dd><dt>System</dt><dd>${a.system}</dd></dl>`)}
          ${card('Definition', html`<ul class="list">${a.endpoints.map(function (ep, i) {
            var key = a.name + ':' + i;
            return html`<li style="flex-wrap:wrap"><span class="pill ${mcls[ep[0]] || ''}" style="min-width:58px;justify-content:center">${ep[0]}</span>
              <div style="flex:1;min-width:160px"><code>${ep[1]}</code><div class="muted small">${ep[2]}</div></div>
              <button class="btn sm" type="button" data-action="try-api" data-key="${key}">Try it</button>
              ${S.apiTry === key ? html`<pre style="width:100%;margin:8px 0 0"><code>${sampleResponse(a, ep)}</code></pre>` : ''}</li>`;
          })}</ul>`)}
        </div>
      </div>`;
  }
  function sampleResponse(a, ep) {
    if (ep[1].indexOf('health') >= 0 || ep[1].indexOf('readyz') >= 0) return 'HTTP/1.1 200 OK\n{ "status": "ok" }';
    if (ep[1].indexOf('metrics') >= 0) return 'HTTP/1.1 200 OK\n# TYPE http_requests_total counter\nhttp_requests_total{code="200"} 182734';
    if (a.type === 'asyncapi') return '{\n  "type": "' + ep[1].split('/ ')[1] + '",\n  "orderId": "ord_8KQ2",\n  "occurredAt": "2026-11-20T13:04:11Z"\n}';
    if (a.type === 'graphql') return '{\n  "data": { "search": { "total": 128, "items": [{ "sku": "SKU-1042", "title": "Trail running shoe" }] } }\n}';
    if (a.name === 'idp-mcp-api') return 'HTTP/1.1 200 OK\n{ "jsonrpc": "2.0", "id": 1, "result": { "tools": [ { "name": "catalog_search" }, "… 11 more" ] } }';
    if (a.name === 'hello-service-api') return 'HTTP/1.1 200 OK\n{ "message": "Hello, ' + (ep[1].indexOf('{name}') >= 0 ? 'Alex' : 'world') + '!" }';
    return 'HTTP/1.1 ' + (ep[0] === 'POST' ? '201 Created' : '200 OK') + '\n{\n  "id": "' + (a.name.indexOf('pay') >= 0 ? 'pay_' : 'ord_') + '7Hf2K9",\n  "status": "' + (ep[0] === 'POST' ? 'accepted' : 'captured') + '",\n  "amount": { "value": 4999, "currency": "EUR" }\n}';
  }

  function pageTechdocs(id) {
    var doc = D.docs.filter(function (d) { return d.id === id; })[0];
    if (id && !doc) return notFound('No TechDocs page "' + id + '".');
    doc = doc || D.docs[0];
    var secs = [];
    D.docs.forEach(function (d) { if (secs.indexOf(d.section) < 0) secs.push(d.section); });
    return html`${head('TechDocs', 'Docs-as-code, built from each repo’s mkdocs.yml.')}
      <div class="docs-layout">
        <nav class="card docs-nav" aria-label="Documentation" style="padding:8px">${secs.map(function (s) {
          return html`<div class="sec">${s}</div>${D.docs.filter(function (d) { return d.section === s; }).map(function (d) {
            return html`<a href="#/techdocs/${d.id}" ${d === doc ? raw('aria-current="page"') : ''}>${d.title}</a>`;
          })}`;
        })}</nav>
        <article class="card prose"><div class="crumbs">${doc.section}</div><h1 style="margin-bottom:12px">${doc.title}</h1>${doc.body.map(function (b) {
          if (b[0] === 'p') return html`<p>${b[1]}</p>`;
          if (b[0] === 'h2') return html`<h2>${b[1]}</h2>`;
          if (b[0] === 'ul') return html`<ul>${b[1].map(function (x) { return html`<li>${x}</li>`; })}</ul>`;
          if (b[0] === 'code') return html`<pre><code>${b[1]}</code></pre>`;
          if (b[0] === 'runbooks') return html`<ul>${D.runbooks.map(function (r) { return html`<li><strong>${r[1]}</strong> <code class="small">docs/runbooks/${r[0]}.md</code></li>`; })}</ul>`;
          return '';
        })}<p class="muted small" style="margin-top:20px">Last updated 3 days ago · Edit on GitHub</p></article>
      </div>`;
  }

  function pageRadar() {
    var quads = ['Languages & Frameworks', 'Platforms', 'Tools', 'Techniques'], rings = ['Adopt', 'Trial', 'Assess', 'Hold'];
    var C = 250, R = [70, 140, 195, 240], s = '';
    for (var i = 3; i >= 0; i--) s += '<circle cx="' + C + '" cy="' + C + '" r="' + R[i] + '" fill="' + (i % 2 ? 'var(--surface-2)' : 'var(--surface)') + '" stroke="var(--border)"/>';
    s += '<line x1="10" x2="490" y1="250" y2="250" stroke="var(--border)"/><line y1="10" y2="490" x1="250" x2="250" stroke="var(--border)"/>';
    rings.forEach(function (r, i) { s += '<text x="' + (C + 4) + '" y="' + (C - (i ? R[i - 1] : 0) - 6) + '" style="font-size:10px;font-weight:600">' + r + '</text>'; });
    var cols = ['var(--c1)', 'var(--c2)', 'var(--c3)', 'var(--c4)'];
    var numbered = [];
    quads.forEach(function (q, qi) {
      var items = D.radar.filter(function (x) { return x[1] === q; });
      items.forEach(function (it) {
        var ri = rings.indexOf(it[2]), rr = rng('radar:' + it[0]);
        var inner = ri ? R[ri - 1] : 10, outer = R[ri];
        var rad = inner + 14 + rr() * (outer - inner - 28);
        var a0 = [180, 270, 90, 0][qi], ang = (a0 + 10 + rr() * 70) * Math.PI / 180;
        var x = C + rad * Math.cos(ang), y = C - rad * Math.sin(ang), n = numbered.length + 1;
        numbered.push([n, it[0], q, it[2]]);
        s += '<g><circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="9" fill="' + cols[qi] + '"><title>' + esc(it[0] + ' (' + it[2] + ')') + '</title></circle><text x="' + x.toFixed(1) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="middle" style="font-size:9px;font-weight:700;fill:#fff">' + n + '</text></g>';
      });
    });
    var qpos = [[14, 22, 'start'], [486, 22, 'end'], [14, 488, 'start'], [486, 488, 'end']];
    quads.forEach(function (q, i) { s += '<text x="' + qpos[i][0] + '" y="' + qpos[i][1] + '" text-anchor="' + qpos[i][2] + '" style="font-size:12px;font-weight:700;fill:' + cols[i] + '">' + esc(q) + '</text>'; });
    return html`${head('Tech Radar', 'What the platform recommends, trials, assesses or retires. Reviewed quarterly by the architecture guild.')}
      <div class="grid g2">
        ${card(null, html`<svg class="chart" viewBox="0 0 500 500" role="img" aria-label="Technology radar with ${numbered.length} entries">${raw(s)}</svg>`)}
        ${card('Entries', html`<div class="radar-legend">${quads.map(function (q) {
          return html`<h3>${q}</h3><ol>${numbered.filter(function (n) { return n[2] === q; }).map(function (n) { return html`<li value="${n[0]}">${n[1]} <span class="muted">· ${n[3]}</span></li>`; })}</ol>`;
        })}</div>`)}
      </div>`;
  }

  function pageDora() {
    var wl = weekLabels(12), comps = D.components.filter(function (c) { return c.replicas > 0 || c.type === 'mobile'; });
    var df = series('org-df', 12, 41 * 7, 30, 0.3), lt = series('org-lt', 12, 6.2, 1.1, -0.3);
    var byTeam = D.teams.map(function (t) {
      var cs = D.components.filter(function (c) { return c.owner === t.name; });
      return { label: t.name.replace('-team', ''), value: cs.reduce(function (a, c) { return a + c.dora.df; }, 0) };
    });
    return html`${head('DORA metrics', 'Delivery performance across all services, last 12 weeks.')}
      <div class="grid g4">
        ${stat('Deploy frequency', '41/day', levelPill('Elite'), sparkline(df))}
        ${stat('Lead time', '6.2 h', levelPill('Elite'), sparkline(lt, 'var(--c2)'))}
        ${stat('Change failure rate', '6.4%', levelPill('High'), sparkline(series('org-cfr', 12, 6.4, 1.2, -0.2), 'var(--c3)'))}
        ${stat('Time to restore', '38 min', levelPill('Elite'), sparkline(series('org-mttr', 12, 38, 8, -0.2), 'var(--c4)'))}
      </div>
      <div class="grid g2" style="margin-top:16px">
        ${card('Deployments per week (all services)', barChart(df.map(function (v, i) { return { label: wl[i], value: Math.round(v) }; }), { label: 'Deployments per week' }))}
        ${card('Deploys per day by team', barChart(byTeam.map(function (b, i) { return { label: b.label, value: b.value, color: 'var(--c' + (i % 6 + 1) + ')' }; }), { label: 'Deploys per day by team' }))}
      </div>
      ${card('By service', table(['Service', 'Owner', 'Deploys/day', 'Lead time', 'CFR', 'MTTR'], comps.map(function (c) {
        return [html`<a href="#/entity/${c.name}/dora">${c.name}</a>`, c.owner, html`${num(c.dora.df, 1)} ${levelPill(doraLevel('df', c.dora.df))}`, html`${hours(c.dora.lt)} ${levelPill(doraLevel('lt', c.dora.lt))}`,
          html`${pct(c.dora.cfr)} ${levelPill(doraLevel('cfr', c.dora.cfr))}`, html`${dur(c.dora.mttr)} ${levelPill(doraLevel('mttr', c.dora.mttr))}`];
      })))}`;
  }

  function pageFinops() {
    var spend = D.teams.reduce(function (a, t) { return a + t.spend; }, 0), budget = D.teams.reduce(function (a, t) { return a + t.budget; }, 0);
    var daily = series('finops-daily', 30, spend / 20, spend / 20 * 0.15, 0.1);
    var cats = [{ name: 'Compute (EC2/EKS)', value: Math.round(spend * 0.55) }, { name: 'AI / LLM (LiteLLM)', value: Math.round(spend * 0.17) }, { name: 'Storage (EBS/S3)', value: Math.round(spend * 0.13) }, { name: 'Network', value: Math.round(spend * 0.09) }, { name: 'Databases (RDS)', value: Math.round(spend * 0.06) }];
    var recs = [['analytics-pipeline', 'Reduce replicas 3 → 2', 'CPU p95 18% for 14 days', 38.4], ['recommendations-ml', 'Move to Graviton (m7g)', 'Same perf at lower price', 61.2], ['orders-service', 'Lower memory request 2Gi → 1Gi', 'Working set p95 640Mi', 22.9], ['search-snapshots', 'Add Glacier transition at 30 d', '74% of objects older than 30 d', 15.6], ['preview envs', 'Shorten default TTL 3 d → 1 d', '41% of previews idle after day 1', 27.0]];
    return html`${head('FinOps', 'Cost visibility from OpenCost and LiteLLM, by team, namespace and category. November 2026, day 20.')}
      <div class="grid g4">
        ${stat('Spend this month', money(spend), 'of ' + money(budget) + ' budgeted')}
        ${stat('Forecast', money(spend / 20 * 30), pill('+6% vs Oct', 'warn'))}
        ${stat('Teams over budget', '1', 'backend-team (107%)')}
        ${stat('Savings identified', money(165), recs.length + ' recommendations')}
      </div>
      <div class="grid g2" style="margin-top:16px">
        ${card('Spend by team vs budget', hbars(D.teams.map(function (t) {
          var u = t.spend / t.budget;
          return { label: t.name, value: t.spend, max: t.budget, text: pct(u * 100, 0), color: u > 1 ? 'var(--bad)' : u > 0.8 ? 'var(--warn)' : 'var(--ok)' };
        })), html`<a href="#/teams">Teams</a>`)}
        ${card('By category', donut(cats, [money(spend), 'month to date'], { fmt: money, label: 'Spend by category' }))}
      </div>
      ${card('Daily spend (last 30 days)', lineChart([{ name: 'Daily cost', values: daily }], { labels: dayLabels(30), yFmt: function (v) { return '$' + num(v, 0); }, label: 'Daily spend' }))}
      ${card('Rightsizing recommendations', table(['Target', 'Recommendation', 'Evidence', 'Monthly saving'], recs.map(function (r) { return [html`<strong>${r[0]}</strong>`, r[1], html`<span class="muted">${r[2]}</span>`, money(r[3], 2)]; }), [3]),
        html`<span class="muted">via cost-mcp-server · get_rightsizing_recommendations</span>`)}`;
  }

  function pageIncidents(id) {
    if (id) {
      var inc = D.incidents.filter(function (i) { return i.id === id; })[0];
      if (!inc) return notFound('No incident ' + id + '.');
      return html`${head(inc.id + ': ' + inc.title, null, null, html`<a href="#/incidents">Incidents</a> / ${inc.id}`)}
        <div class="btn-row" style="margin:-8px 0 16px">${pill(inc.sev, inc.sev === 'SEV2' ? 'bad' : 'warn')} ${statusPill(inc.status)} ${pill('service: ' + inc.service, 'info')} ${pill('IC: ' + inc.commander)}</div>
        <div class="grid g3">
          ${card(inc.pm ? 'Post-mortem summary' : 'Summary', html`<p>${inc.summary}</p><dl class="kv"><dt>Started</dt><dd>${inc.started}</dd><dt>Duration</dt><dd>${inc.duration}</dd><dt>Commander</dt><dd>${inc.commander}</dd></dl>
            ${inc.pm ? html`<p class="muted small" style="margin-top:10px">Blameless post-mortem. Written within 5 working days, reviewed in the weekly ops review.</p>` : ''}`, null, 'span2')}
          ${card('Action items', inc.actions.length ? html`<ul class="list">${inc.actions.map(function (a) { return html`<li><div style="flex:1">${a[0]}<div class="muted small">${a[1]}</div></div>${statusPill(a[2])}</li>`; })}</ul>` : html`<p class="muted">Action items are added once the incident is resolved.</p>`)}
        </div>
        ${card('Timeline', html`<ul class="list">${inc.timeline.map(function (t) { return html`<li><code class="nowrap">${t[0]}</code><div>${t[1]}</div></li>`; })}</ul>`)}`;
    }
    var open = D.incidents.filter(function (i) { return i.status !== 'resolved'; });
    return html`${head('Incidents', 'Open incidents and blameless post-mortems. The incident-agent links runbooks and drafts status updates.')}
      <div class="grid g4">${stat('Open', open.length, open.length ? open[0].id : 'none')}${stat('Last 30 days', '4', '1 SEV2 · 2 SEV3 · 1 SEV4')}${stat('MTTR (30 d)', '58 min', pill('-22% vs prev', 'ok'))}${stat('Post-mortems', D.incidents.filter(function (i) { return i.pm; }).length, 'published')}</div>
      ${card('All incidents', table(['Incident', 'Severity', 'Status', 'Service', 'Started', 'Duration', 'Post-mortem'], D.incidents.map(function (i) {
        return [html`<a href="#/incidents/${i.id}"><strong>${i.id}</strong></a> ${i.title}`, pill(i.sev, i.sev === 'SEV2' ? 'bad' : 'warn'), statusPill(i.status), comp(i.service) ? entLink(i.service) : i.service, i.started, i.duration, i.pm ? html`<a href="#/incidents/${i.id}">Read</a>` : '-'];
      })))}`;
  }

  function pageLearning() {
    var f = S.learning;
    var items = D.learning.filter(function (l) { return (!f.topic || l.topic === f.topic) && (!f.level || l.level === f.level) && (!f.type || l.type === f.type); });
    var done = D.learning.filter(function (l) { return S.done[l.title]; }).length;
    function uniq(k) { var o = []; D.learning.forEach(function (l) { if (o.indexOf(l[k]) < 0) o.push(l[k]); }); return o; }
    return html`${head('Learning Center', 'Golden-path tutorials and concepts, filtered by topic, experience level and type.')}
      ${card('Your progress', html`<div style="display:flex;align-items:center;gap:14px;flex-wrap:wrap"><strong style="font-size:22px">${done} / ${D.learning.length}</strong><div class="bar" style="flex:1;min-width:160px;height:10px"><span style="width:${(done / D.learning.length * 100).toFixed(0)}%"></span></div><span class="muted">${pct(done / D.learning.length * 100, 0)} complete</span></div>`)}
      <div class="card" style="margin-top:16px"><div class="grid g3">
        <div><h3 style="margin-bottom:8px">Topic</h3>${chips('learning.topic', uniq('topic'), f.topic, 'All')}</div>
        <div><h3 style="margin-bottom:8px">Experience level</h3>${chips('learning.level', uniq('level'), f.level, 'All')}</div>
        <div><h3 style="margin-bottom:8px">Type</h3>${chips('learning.type', uniq('type'), f.type, 'All')}</div>
      </div></div>
      <div class="grid g-auto" style="margin-top:16px">${items.map(function (l) {
        var d = !!S.done[l.title];
        return html`<article class="card tpl"><div class="btn-row">${pill(l.topic, 'info')} ${pill(l.level)} ${pill(l.type)}</div><h3>${l.title}</h3>
          <p>${l.mins} min${l.template ? html` · uses the <code>${l.template}</code> template` : ''}</p>
          <div class="btn-row">${l.template ? html`<a class="btn sm primary" href="#/create/${l.template}">Start</a>` : html`<a class="btn sm primary" href="#/techdocs/golden-paths">Read</a>`}
            <button class="btn sm" type="button" data-action="toggle-done" data-key="${l.title}" aria-pressed="${String(d)}">${d ? '✓ Completed' : 'Mark complete'}</button></div></article>`;
      })}</div>`;
  }

  function maturityLevel(sc) {
    var Q = sc[0], P = sc[1], R = sc[2], Sec = sc[3], DX = sc[4], AI = sc[5], l = 1;
    if (Q >= 50 && P >= 40 && R >= 40) l = 2;
    if (l === 2 && P >= 70 && Q >= 65 && R >= 65) l = 3;
    if (l === 3 && AI >= 65 && Sec >= 60 && DX >= 60) l = 4;
    return l;
  }
  function heat(v) { return v >= 75 ? 'var(--ok-soft)' : v >= 60 ? 'var(--info-soft)' : v >= 45 ? 'var(--warn-soft)' : 'var(--bad-soft)'; }
  function pageEI() {
    var dist = [1, 2, 3, 4, 5].map(function (l) { return D.teams.filter(function (t) { return maturityLevel(D.teamScores[t.name]) === l; }).length; });
    return html`${head('Engineering Intelligence', 'Maturity model and DX Core 4, computed from catalog evidence, DORA, Tech Insights and the DevEx survey.')}
      <div class="grid g4">${D.core4.map(function (c) {
        return html`<div class="card stat"><div class="label">${c.area}</div><div class="value">${c.value}</div><div class="sub"><span>${c.metric}</span></div>
          <div class="small" style="margin-top:6px"><span class="${c.good ? 'delta-up' : 'delta-down'}">${c.good ? '▲' : '▼'} from ${c.prev}</span> <span class="muted">QoQ · ${c.secondary}</span></div></div>`;
      })}</div>
      <div class="grid g2" style="margin-top:16px">
        ${card('Maturity model', html`<ol class="list">${D.maturityLevels.map(function (m, i) {
          return html`<li><span class="icon" style="font-weight:700">${m.level}</span><div style="flex:1"><strong>${m.name}</strong><div class="muted small">${m.desc}</div></div><span class="pill ${dist[i] ? 'info' : ''}">${dist[i]} team${dist[i] === 1 ? '' : 's'}</span></li>`;
        })}</ol>`)}
        ${card('Org average by dimension', hbars(D.dimensions.map(function (d, i) {
          var avg = D.teams.reduce(function (a, t) { return a + D.teamScores[t.name][i]; }, 0) / D.teams.length;
          return { label: d, value: avg, max: 100, text: num(avg, 0) };
        })))}
      </div>
      ${card('Teams', html`<div class="table-wrap"><table><thead><tr><th scope="col">Team</th>${D.dimensions.map(function (d) { return html`<th scope="col" class="num">${d}</th>`; })}<th scope="col">Level</th></tr></thead>
        <tbody>${D.teams.map(function (t) {
          var sc = D.teamScores[t.name], l = maturityLevel(sc);
          return html`<tr><td>${teamLink(t.name)}</td>${sc.map(function (v) { return html`<td class="num" style="background:${raw(heat(v))}">${v}</td>`; })}<td>${pill('L' + l + ' · ' + D.maturityLevels[l - 1].name, l >= 3 ? 'ok' : 'warn')}</td></tr>`;
        })}</tbody></table></div>`)}
      <p class="muted small" style="margin-top:12px">Level 5 is not reachable yet: two of its requirements (approval-gated agent actions and measured auto-remediation) are not measurable today.</p>`;
  }

  function pageCopilot() {
    var c = D.copilot, acc = series('cp-acc', 30, c.acceptance, 2.2, 0.12), act = series('cp-act', 30, c.active, 4, 0.1);
    return html`${head('Copilot metrics', 'AI coding assistant adoption and acceptance, last 30 days.')}
      <div class="grid g4">${stat('Active users', c.active + ' / ' + c.seats, pct(c.active / c.seats * 100, 0) + ' of seats', sparkline(act))}${stat('Acceptance rate', pct(c.acceptance), pill('+2.1 pts', 'ok'), sparkline(acc, 'var(--c2)'))}
        ${stat('Lines accepted', num(c.linesAccepted), num(c.accepted) + ' of ' + num(c.suggestions) + ' suggestions')}${stat('Chat turns', num(c.chatTurns), 'IDE + web')}</div>
      <div class="grid g2" style="margin-top:16px">
        ${card('Acceptance rate (%)', lineChart([{ name: 'Acceptance', values: acc, color: 'var(--c2)' }], { labels: dayLabels(30), min: 20, max: 40, label: 'Acceptance rate' }))}
        ${card('Acceptance by language', hbars(c.languages.map(function (l) { return { label: l[0], value: l[1], max: 45, text: pct(l[1]) }; })))}
      </div>
      ${card('By team', table(['Team', 'Seats', 'Acceptance'], c.teams.map(function (t) { return [teamLink(t[0]), t[1], pct(t[2])]; }), [1, 2]))}`;
  }

  function pageSurvey() {
    var dxi = 71;
    return html`${head('DevEx survey', 'Quarterly, about 5 minutes. Results are aggregated per team with a minimum group size of 5.')}
      <div class="grid g3">
        ${card('Developer Experience Index', gauge(dxi / 100, 'Q4 2026 · 142 responses (79%)', String(dxi), 'var(--brand)'))}
        ${card('Results by question (1–5)', html`${D.survey.map(function (s) {
          var d = s.score - s.prev;
          return html`<div style="margin-bottom:10px"><div class="small" style="display:flex;justify-content:space-between;gap:10px"><span>${s.q}</span><span class="nowrap"><strong>${num(s.score, 1)}</strong> <span class="${d >= 0 ? 'delta-up' : 'delta-down'}">${d >= 0 ? '+' : ''}${num(d, 1)}</span></span></div>
            <div class="bar"><span style="width:${(s.score / 5 * 100).toFixed(0)}%;background:${raw(s.score < 3.2 ? 'var(--warn)' : 'var(--brand)')}"></span></div></div>`;
        })}`, null, 'span2')}
      </div>
      ${card('Take this quarter’s survey', S.surveySent ? html`<div class="notice info" style="border-color:var(--ok);background:var(--ok-soft)">Thanks. Your response was recorded (in this demo, only in your browser tab).</div>` :
        html`<form data-submit="survey">${D.survey.map(function (s, qi) {
          return html`<fieldset style="border:0;padding:0;margin:0 0 14px"><legend style="font-weight:600;margin-bottom:6px">${s.q}</legend><div class="chips">${[1, 2, 3, 4, 5].map(function (v) {
            return html`<label class="chip" style="display:inline-flex;gap:5px;align-items:center"><input type="radio" name="q${qi}" value="${v}" data-bind-quiet="survey.q${qi}" ${S.survey['q' + qi] === String(v) ? raw('checked') : ''}>${['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'][v - 1]}</label>`;
          })}</div></fieldset>`;
        })}<button class="btn primary" type="submit">Submit</button></form>`)}`;
  }

  /* ---------- pages: AI ---------- */
  var SUGGESTIONS = ['Who owns payments-api?', 'Show metrics for hello-service', 'Scaffold a Go service called inventory-sync', 'Which teams are over budget?', 'Any open incidents?', 'What deployments are out of sync?'];
  function pageAssistant() {
    return html`${head('AI Assistant', 'Powered by KAgent · platform-assistant (claude-sonnet via the AI gateway). Mutating actions wait for your approval.', html`<button class="btn" type="button" data-action="new-chat">New chat</button>`)}
      <section class="card chat">
        <div class="chat-scroll" id="chat-scroll" aria-live="polite">
          ${S.chat.length ? '' : html`<div class="empty"><h2 style="margin-bottom:6px">Ask about services, deployments, metrics or costs</h2><p>Replies are scripted for this demo, but they follow what the real agents do with the MCP tools.</p></div>`}
          ${S.chat.map(renderMsg)}
        </div>
        <div style="padding:6px 0">${html`<div class="chips">${SUGGESTIONS.map(function (s) { return html`<button type="button" class="chip" data-action="ask" data-prompt="${s}">${s}</button>`; })}</div>`}</div>
        <form class="chat-input" data-submit="chat"><label class="sr-only" for="chat-in">Message</label>
          <input class="input" id="chat-in" autocomplete="off" placeholder="Ask about services, deployments, metrics…" value="${S.chatDraft}" data-bind-quiet="chatDraft">
          <button class="btn primary" type="submit" aria-label="Send">${icon('send')}</button></form>
      </section>`;
  }
  function renderMsg(m, i) {
    if (m.role === 'user') return html`<div class="msg user">${m.text}</div>`;
    if (m.typing) return html`<div class="msg bot typing" aria-label="Assistant is typing"><span></span><span></span><span></span></div>`;
    return html`<div class="msg bot">${m.tools && m.tools.length ? html`<div class="tool-calls">${m.tools.map(function (t) { return html`<span class="tool-call">${t[0]} · ${t[1]}</span>`; })}</div>` : ''}${m.body}
      ${m.plan ? (m.state === 'pending' ? html`<div class="btn-row" style="margin-top:10px"><button class="btn primary sm" type="button" data-action="chat-approve" data-key="${i}">Approve</button><button class="btn sm" type="button" data-action="chat-cancel" data-key="${i}">Cancel</button></div>`
        : html`<div style="margin-top:8px">${m.state === 'approved' ? pill('Approved by you', 'ok') : pill('Cancelled')}</div>`) : ''}</div>`;
  }
  function askAssistant(text) {
    text = String(text).trim();
    if (!text) return;
    S.chat.push({ role: 'user', text: text });
    var typing = { role: 'bot', typing: true };
    S.chat.push(typing);
    S.chatDraft = '';
    refreshIf('ai-assistant');
    setTimeout(function () {
      var idx = S.chat.indexOf(typing);
      if (idx < 0) return;
      S.chat[idx] = reply(text);
      refreshIf('ai-assistant');
    }, 650);
  }
  function findComp(t) {
    var hit = D.components.slice().sort(function (a, b) { return b.name.length - a.name.length; }).filter(function (c) { return t.indexOf(c.name) >= 0; })[0];
    return hit || null;
  }
  function reply(text) {
    var t = text.toLowerCase(), c = findComp(t);
    if (/scaffold|create (a|an|new)|new (go|python|node|java|service|microservice)|bootstrap/.test(t)) {
      var lang = /python/.test(t) ? 'python' : /node|express/.test(t) ? 'nodejs' : /java|jvm|spring/.test(t) ? 'jvm' : /react|frontend/.test(t) ? 'react' : 'go';
      var tname = lang === 'react' ? 'react-frontend' : lang + '-service', tt = tpl(tname);
      var nm = (t.match(/(?:called|named)\s+([a-z0-9][a-z0-9-]{2,40})/) || [])[1] || (lang + '-demo-' + (S.chat.length + 1));
      var owner = (t.match(/([a-z]+-team)/) || [])[1] || D.user.team;
      var plan = { template: tname, name: nm, owner: owner };
      return { role: 'bot', tools: [['list_templates', '96 ms'], ['get_template_params', '141 ms'], ['check_policy', '88 ms']], plan: plan, state: 'pending',
        body: html`<p>Here is the plan. I will run the <strong>${tt ? tt.t : tname}</strong> template with these parameters:</p>
          ${table(['Parameter', 'Value'], [['name', html`<code>${nm}</code>`], ['owner', html`<code>group:default/${owner}</code>`], ['repo', html`<code>github.com/moatazeldebsy/${nm}</code>`], ['deployTarget', html`<code>local</code>`]])}
          <p class="small muted" style="margin-top:8px">This creates a repository and opens a GitOps PR, so <code>scaffold_service</code> needs your approval (policy: allowed with approval).</p>` };
    }
    if (/budget|cost|spend|finops/.test(t)) {
      return { role: 'bot', tools: [['list_budget_overruns', '233 ms'], ['get_team_spend', '310 ms']],
        body: html`<p>One team is over budget and one is close:</p>${table(['Team', 'Spend', 'Budget', 'Used'], D.teams.slice().sort(function (a, b) { return b.spend / b.budget - a.spend / a.budget; }).slice(0, 4).map(function (x) {
          var u = x.spend / x.budget; return [teamLink(x.name), money(x.spend), money(x.budget), pill(pct(u * 100, 0), u > 1 ? 'bad' : u > 0.8 ? 'warn' : 'ok')];
        }))}<p style="margin-top:8px"><a href="#/team/backend-team/budget">backend-team</a> is driven mostly by orders-service memory requests. Want rightsizing suggestions?</p>` };
    }
    if (/incident|alert|on-?call|outage|down/.test(t)) {
      var firing = D.alerts.filter(function (a) { return a.state === 'firing'; });
      return { role: 'bot', tools: [['get_open_incidents', '174 ms'], ['get_alert_history', '205 ms'], ['get_runbook', '61 ms']],
        body: html`<p><a href="#/incidents/INC-2042">INC-2042</a> is open (SEV3): inventory-service pods are crash-looping after a secret rename. The <a href="#/techdocs/runbooks">pod-crash-loop runbook</a> applies, and release-agent has a rollback waiting in <a href="#/approvals">Agent Approvals</a>.</p>
          <p>${firing.length} alerts are firing: ${firing.map(function (a, i) { return html`${i ? ', ' : ''}<code>${a.name}</code>`; })}.</p>` };
    }
    if (/deploy|argo|sync|rollout|release/.test(t)) {
      var apps = allArgoApps().filter(function (a) { return a.sync !== 'Synced' || a.health !== 'Healthy'; });
      return { role: 'bot', tools: [['list_deployments', '188 ms'], ['list_apps', '264 ms']],
        body: html`<p>${apps.length} applications need attention:</p>${table(['Application', 'Sync', 'Health'], apps.map(function (a) { return [a.name, statusPill(a.sync), statusPill(a.health)]; }))}<p style="margin-top:8px">Open <a href="#/argocd">ArgoCD</a> to sync, or ask me to sync one (needs approval).</p>` };
    }
    if (c && /metric|latency|error|slo|dora|health|perform|how is/.test(t)) {
      var vals = series('chat-rps:' + c.name, 24, c.replicas * 40 + 20, 12);
      return { role: 'bot', tools: [['get_service_metrics', '344 ms']],
        body: html`<p>Last 24 h for <a href="#/entity/${c.name}">${c.name}</a>:</p>${table(['Metric', 'Value'], [
          ['Requests / s', num(vals[23], 0)], ['Error rate', pct(c.dora.cfr / 10, 2)], ['p95 latency', num(120 + c.dora.lt * 3, 0) + ' ms'],
          ['Availability SLO', c.slo ? pct(sloState(c).avail.sli, 3) + ' vs ' + c.slo.avail + '% target' : 'no SLO'], ['Deploys / day', num(c.dora.df, 1)]])}
          <div style="margin-top:8px">${sparkline(vals)}</div>` };
    }
    if (/own|who|find|search|catalog|list|which service|services/.test(t)) {
      var teamHit = D.teams.filter(function (x) { return t.indexOf(x.name) >= 0; })[0];
      var res = c ? [c] : teamHit ? D.components.filter(function (x) { return x.owner === teamHit.name; }) :
        D.components.filter(function (x) { return t.split(/\W+/).some(function (w) { return w.length > 3 && (x.name + ' ' + x.desc + ' ' + x.tags.join(' ')).toLowerCase().indexOf(w) >= 0; }); }).slice(0, 6);
      if (!res.length) res = D.components.slice(0, 5);
      return { role: 'bot', tools: [['catalog_search', '182 ms']],
        body: html`${c ? html`<p><a href="#/entity/${c.name}">${c.name}</a> is owned by ${teamLink(c.owner)} (lead: ${team(c.owner) ? team(c.owner).lead : '-'}). It is ${c.lifecycle}, in the ${c.system} system, and sits at ${tierPill(tierOf(c))}.</p>` : html`<p>I found ${res.length} matching components:</p>`}
          ${c ? '' : table(['Component', 'Owner', 'Tier'], res.map(function (x) { return [entLink(x.name), x.owner, tierPill(tierOf(x))]; }))}` };
    }
    if (/template|golden|test suite|tests/.test(t)) {
      return { role: 'bot', tools: [['list_templates', '96 ms']],
        body: html`<p>There are ${D.templates.length} templates. Popular ones:</p><ul style="margin:0;padding-left:18px">${['go-service', 'playwright-e2e-suite', 'enable-contract-testing', 's3-bucket-crossplane', 'ai-agent-kagent'].map(function (n) { var x = tpl(n); return html`<li><a href="#/create/${n}">${x.t}</a></li>`; })}</ul>` };
    }
    return { role: 'bot', tools: [], body: html`<p>I can search the catalog, check service metrics, list deployments, report costs and incidents, or scaffold a service for you. Try one of the suggestions below, for example <em>"Scaffold a Go service called inventory-sync"</em>.</p>` };
  }
  function approveChat(i) {
    var m = S.chat[i];
    if (!m || m.state !== 'pending') return;
    m.state = 'approved';
    var typing = { role: 'bot', typing: true };
    S.chat.push(typing);
    rerender();
    setTimeout(function () {
      var p = m.plan, t = tpl(p.template);
      registerEntity({ name: p.name, owner: p.owner, desc: '' }, t);
      var pr = 700 + hash(p.name) % 90;
      var idx = S.chat.indexOf(typing);
      if (idx < 0) return;
      S.chat[idx] = { role: 'bot', tools: [['request_approval', 'approved'], ['scaffold_service', '2.4 s'], ['list_deployments', '190 ms']],
        body: html`<p><strong>Done.</strong> ${p.name} is scaffolded and running.</p><ul style="margin:0 0 8px;padding-left:18px">
          <li>Repository <code>github.com/moatazeldebsy/${p.name}</code> created with CI</li><li>GitOps PR #${pr} merged (helm-values only)</li>
          <li>ArgoCD synced <code>${p.name}-local</code>: Healthy</li><li>Registered in the catalog, owner ${p.owner}</li></ul>
          <div class="btn-row"><a class="btn sm primary" href="#/entity/${p.name}">Open ${p.name}</a><a class="btn sm" href="#/argocd">View in ArgoCD</a></div>` };
      refreshIf('ai-assistant');
    }, 1300);
  }

  function pageAISearch() {
    var q = S.aiQuery.toLowerCase(), words = q.split(/\W+/).filter(function (w) { return w.length > 2; });
    var res = D.aiSearchCorpus.map(function (d) {
      var hay = (d.title + ' ' + d.text).toLowerCase(), hits = words.filter(function (w) { return hay.indexOf(w) >= 0 || hay.indexOf(w.replace(/s$/, '')) >= 0; }).length;
      return { d: d, score: words.length ? 0.55 + 0.4 * hits / words.length + rng(d.title + q)() * 0.04 : 0 };
    }).filter(function (r) { return r.score > 0.6; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 6);
    var top = res[0];
    return html`${head('AI Search', 'Semantic search over the catalog and TechDocs (Voyage embeddings in pgvector), with a short generated answer.')}
      <form class="filters" data-submit="ai-search"><label class="sr-only" for="ai-q">Question</label>
        <input class="input grow" id="ai-q" type="search" value="${S.aiQuery}" placeholder="Ask a question" data-bind-quiet="aiQuery"><button class="btn primary" type="submit">${icon('search')} Search</button></form>
      <div style="margin-bottom:16px">${chips('aiQuery', ['how do I roll back a deployment', 'request an s3 bucket', 'slo error budget', 'who handles payments', 'load testing'], S.aiQuery)}</div>
      ${top ? card('Answer', html`<p>${top.d.kind === 'TechDocs' ? 'The most relevant guide is ' : 'The best match is '}<a href="${top.d.href}">${top.d.title}</a>. ${res.length > 1 ? html`Also see <a href="${res[1].d.href}">${res[1].d.title}</a>.` : ''}</p><p class="muted small">Generated from the top ${res.length} passages · catalog_semantic_search · 412 ms</p>`) : ''}
      ${card(res.length + ' results', res.length ? html`<ul class="list">${res.map(function (r) {
        return html`<li><span class="icon">${icon(r.d.kind === 'TechDocs' ? 'book' : r.d.kind === 'Template' ? 'plus' : 'grid')}</span><div style="flex:1"><a href="${r.d.href}"><strong>${r.d.title}</strong></a><div class="muted small">${r.d.kind} · …${r.d.text}…</div></div><span class="pill info">${num(r.score, 2)}</span></li>`;
      })}</ul>` : html`<p class="muted">No passages above the relevance threshold. Try one of the example questions.</p>`)}`;
  }

  function pageApprovals() {
    var tab = S.approvalsTab, list = S.approvals.filter(function (a) { return tab === 'pending' ? a.status === 'pending' : a.status !== 'pending'; });
    return html`${head('Agent Approvals', 'Human-in-the-loop gate for agent actions that change things. Policy-as-Prompt pre-screens each request.')}
      <div style="margin-bottom:16px">${chips('approvalsTab', [['pending', 'Pending (' + S.approvals.filter(function (a) { return a.status === 'pending'; }).length + ')'], ['history', 'History']], tab)}</div>
      ${list.length ? html`<div class="grid g2">${list.map(function (a) {
        return html`<section class="card"><div class="card-head"><h2>${a.id} · <code>${a.tool}</code></h2>${a.status === 'pending' ? pill(a.risk + ' risk', a.risk === 'high' ? 'bad' : a.risk === 'medium' ? 'warn' : 'ok') : statusPill(a.status)}</div>
          <dl class="kv"><dt>Agent</dt><dd>${a.agent}</dd><dt>Target</dt><dd><code>${a.target}</code></dd><dt>Requested by</dt><dd>${a.by} · ${a.t}</dd><dt>Reason</dt><dd>${a.reason}</dd><dt>Policy</dt><dd>${a.policy}</dd></dl>
          ${a.status === 'pending' ? html`<div class="btn-row" style="margin-top:12px"><button class="btn primary sm" type="button" data-action="approval" data-key="${a.id}" data-value="approved">${icon('ok')} Approve</button>
            <button class="btn sm danger" type="button" data-action="approval" data-key="${a.id}" data-value="rejected">${icon('x')} Reject</button></div>` : html`<p class="muted small" style="margin-top:10px">${a.status === 'approved' ? 'Approved' : 'Rejected'} by ${D.user.name} just now. The agent was notified via get_approval_status.</p>`}</section>`;
      })}</div>` : html`<div class="card empty">${tab === 'pending' ? 'No pending requests. Nice.' : 'No decisions yet in this session.'}</div>`}`;
  }

  function pageKagent() {
    return html`${head('KAgent agents', D.agents.length + ' agents in the kagent namespace. Every agent reaches tools and models through the one AI gateway.')}
      <div class="grid g-auto">${D.agents.map(function (a) {
        return html`<section class="card"><div class="card-head"><h2>${a.name}</h2>${statusPill(a.ready ? 'Ready' : 'Not ready')}</div><p class="muted small">${a.desc}</p>
          <dl class="kv" style="margin-bottom:10px"><dt>ModelConfig</dt><dd><code>${a.model}</code></dd><dt>Team</dt><dd>${a.team}</dd><dt>Tools</dt><dd>${a.tools.length}</dd></dl>
          ${a.note ? html`<div class="notice">${a.note}</div>` : ''}
          <div>${a.tools.slice(0, 8).map(function (t) { return html`<span class="tag mono">${t}</span>`; })}${a.tools.length > 8 ? html`<span class="tag">+${a.tools.length - 8} more</span>` : ''}</div></section>`;
      })}</div>
      ${card('Model configs', table(['Name', 'Provider', 'Model', 'Route'], D.modelConfigs.map(function (m) { return [html`<code>${m.name}</code>`, m.provider, html`<code>${m.model}</code>`, m.via]; })))}`;
  }

  function pageMcp() {
    var total = D.mcpServers.reduce(function (a, s) { return a + s.tools.length; }, 0);
    return html`${head('MCP servers', D.mcpServers.length + ' servers, ' + total + ' tools, all behind the AI gateway with prefixMode: never (tool names must be unique across targets).')}
      <div class="grid g2">${D.mcpServers.map(function (s) {
        return html`<section class="card"><div class="card-head"><h2>${s.name}</h2>${statusPill(s.health === 'healthy' ? 'Healthy' : 'Degraded')}</div>
          <div class="btn-row small muted" style="margin-bottom:10px"><span>target <code>${s.target}</code></span><span>· p95 ${num(s.p95)} ms</span><span>· ${num(s.calls)} calls (7 d)</span></div>
          <div>${s.tools.map(function (t) { return html`<span class="tag mono">${t}</span>`; })}</div></section>`;
      })}</div>
      <p class="muted small" style="margin-top:12px">Audit: every call emits <code>[AUDIT]</code> JSON to stdout and increments <code>mcp_agent_tool_calls_total{server,tool,agent}</code>.</p>`;
  }

  function pageGateway() {
    var up = D.mcpServers.filter(function (s) { return s.health === 'healthy'; }).length;
    var rpm = series('gw-rpm', 24, 190, 30);
    return html`${head('AI Gateway', 'agentgateway (standalone) in ml-platform. One RemoteMCPServer for all agents; model traffic forwarded to LiteLLM.')}
      <div class="grid g4">${stat('MCP targets up', up + ' / ' + D.mcpServers.length, 'failureMode: failOpen')}${stat('Requests / min', num(rpm[23], 0), 'MCP + LLM', sparkline(rpm))}${stat('p95 (LLM)', '1.9 s', 'via LiteLLM')}${stat('Tool errors (1 h)', '14', 'security target timeouts')}</div>
      ${card('Routes', table(['Listener', 'Route', 'Backend', 'Policy'], [
        [':8080', html`<code>/mcp</code>`, '8 MCP targets (multiplexed)', 'prefixMode: never · failOpen'],
        [':8080', html`<code>/v1/messages</code>`, 'LiteLLM (provider: anthropic, baseUrl)', 'model allow-list + "*" catch-all'],
        [':15000', html`<code>/ui</code>, <code>/config_dump</code>`, 'admin console (local only)', 'credentials redacted']]))}
      <div class="grid g2" style="margin-top:16px">
        ${card('MCP targets', table(['Target', 'Host', 'Health', 'p95'], D.mcpServers.map(function (s) {
          return [html`<code>${s.target}</code>`, html`<span class="small">${s.name}.services-dev.svc</span>`, statusPill(s.health === 'healthy' ? 'Healthy' : 'Degraded'), num(s.p95) + ' ms'];
        }), [3]))}
        ${card('Models', table(['Model', 'Backend', 'Req/min'], D.gatewayModels.map(function (m) { return [html`<code>${m.name}</code>`, m.backend, m.rpm]; }), [2]))}
      </div>`;
  }

  function pageLitellm() {
    var spend = D.litellmKeys.reduce(function (a, k) { return a + k.spend; }, 0), daily = series('llm-daily', 20, spend / 20, spend / 20 * 0.3, 0.3);
    var byModel = {};
    D.litellmKeys.forEach(function (k) { byModel[k.model] = (byModel[k.model] || 0) + k.spend; });
    return html`${head('LiteLLM spend', 'Virtual keys, budgets and spend per agent, team and model. November to date.')}
      <div class="grid g4">${stat('Spend (MTD)', money(spend, 2), 'across ' + D.litellmKeys.length + ' virtual keys')}${stat('Requests', '1.42 M', '+18% vs Oct')}${stat('Tokens', '611 M', '82% input / 18% output')}${stat('Keys near budget', D.litellmKeys.filter(function (k) { return k.spend / k.budget > 0.8; }).length, '80%+ used')}</div>
      <div class="grid g2" style="margin-top:16px">
        ${card('Daily spend', lineChart([{ name: 'Spend', values: daily }], { labels: dayLabels(20), yFmt: function (v) { return '$' + num(v, 0); }, label: 'Daily LLM spend' }))}
        ${card('By model', donut(Object.keys(byModel).map(function (m) { return { name: m, value: Math.round(byModel[m] * 100) / 100 }; }), [money(spend, 0), 'MTD'], { fmt: function (v) { return money(v, 2); }, label: 'Spend by model' }))}
      </div>
      ${card('Virtual keys', table(['Key', 'Alias', 'Team', 'Model', 'Spend / budget', ''], D.litellmKeys.map(function (k) {
        var u = k.spend / k.budget;
        return [html`<code>${k.key}</code>`, k.alias, k.team, k.model, money(k.spend, 2) + ' / ' + money(k.budget), html`<div class="bar" style="width:110px"><span style="width:${Math.min(100, u * 100).toFixed(0)}%;background:${raw(u > 0.9 ? 'var(--bad)' : u > 0.8 ? 'var(--warn)' : 'var(--ok)')}"></span></div>`];
      }), [4]))}`;
  }

  function pageMlflow() {
    var ex = D.mlflow[S.mlExp] || D.mlflow[0], keys = Object.keys(ex.runs[0].metrics), main = keys[0];
    return html`${head('MLflow', 'Experiments, runs and the model registry in ml-platform.')}
      <div style="margin-bottom:16px" class="chips" role="group">${D.mlflow.map(function (e, i) { return html`<button class="chip" type="button" data-action="set" data-key="mlExp" data-value="${i}" aria-pressed="${String(i === S.mlExp)}">${e.name}</button>`; })}</div>
      <div class="grid g3">
        ${card(ex.name, html`<dl class="kv"><dt>Owner</dt><dd>${ex.owner}</dd><dt>Runs</dt><dd>${ex.runs.length}</dd><dt>Artifact store</dt><dd><code>s3://ml-artifacts/${ex.name}</code></dd>
          <dt>Registered</dt><dd>${ex.runs.filter(function (r) { return r.registered; }).map(function (r) { return html`<div>${r.registered}</div>`; })}</dd></dl>`)}
        ${card('Compare runs · ' + main, barChart(ex.runs.map(function (r, i) { return { label: r.name.slice(0, 12), value: r.metrics[main], color: 'var(--c' + (i + 1) + ')' }; }), { max: 1, yFmt: function (v) { return num(v, 2); }, label: 'Run comparison' }), null, 'span2')}
      </div>
      ${card('Runs', table(['Run', 'Status', 'Started', 'Duration'].concat(Object.keys(ex.runs[0].params)).concat(keys), ex.runs.map(function (r) {
        return [html`<strong>${r.name}</strong><div class="muted small mono">${r.id}${r.registered ? ' · ' + r.registered : ''}</div>`, statusPill(r.status), r.started, r.dur]
          .concat(Object.keys(r.params).map(function (p) { return String(r.params[p]); })).concat(keys.map(function (k) { return num(r.metrics[k], 3); }));
      })))}`;
  }

  function pageLangfuse() {
    var tr = D.traces.filter(function (t) { return t.id === S.trace; })[0] || D.traces[0];
    var total = tr.spans[0][1], off = 0;
    var bars = tr.spans.map(function (s, i) {
      var start = i === 0 ? 0 : off;
      if (i > 0) off += s[1];
      return { name: s[0], ms: s[1], start: start, depth: s[2] };
    });
    return html`${head('Langfuse traces', 'LLM and agent traces with token usage, cost and latency.')}
      <div class="grid g4">${stat('Traces (24 h)', '3,912', '99.1% success')}${stat('p95 latency', '8.4 s', 'agent turns')}${stat('Tokens (24 h)', '18.7 M', '')}${stat('Cost (24 h)', '$41.80', 'matches LiteLLM')}</div>
      ${card('Recent traces', table(['Trace', 'User', 'Latency', 'Tokens', 'Cost', 'Status', ''], D.traces.map(function (t) {
        return [html`<strong>${t.name}</strong><div class="muted small mono">${t.id} · ${t.t}</div>`, t.user, num(t.latency, 1) + ' s', num(t.tokens), money(t.cost, 4), statusPill(t.status === 'ok' ? 'ok' : 'error'),
          html`<button class="btn sm" type="button" data-action="set" data-key="trace" data-value="${t.id}" aria-pressed="${String(t.id === tr.id)}">${t.id === tr.id ? 'Viewing' : 'View'}</button>`];
      }), [2, 3, 4]))}
      ${card('Trace ' + tr.id + ' · ' + tr.name, html`${tr.error ? html`<div class="notice">${tr.error}</div>` : ''}<div>${bars.map(function (b) {
        return html`<div class="hbar-row" style="grid-template-columns:minmax(120px,240px) 1fr 70px"><span class="mono small" style="padding-left:${b.depth * 14}px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${b.name}</span>
          <div style="position:relative;height:14px;background:var(--neutral-soft);border-radius:4px"><span style="position:absolute;top:0;bottom:0;left:${(b.start / total * 100).toFixed(1)}%;width:${Math.max(0.8, b.ms / total * 100).toFixed(1)}%;border-radius:4px;background:${raw(b.name.indexOf('tool.') === 0 ? 'var(--c2)' : b.name.indexOf('llm.') === 0 ? 'var(--c1)' : b.name.indexOf('wait') === 0 ? 'var(--c3)' : 'var(--c4)')}"></span></div>
          <span class="num small">${b.ms >= 1000 ? num(b.ms / 1000, 1) + ' s' : b.ms + ' ms'}</span></div>`;
      })}</div>${legend([{ name: 'LLM', color: 'var(--c1)' }, { name: 'Tool (MCP)', color: 'var(--c2)' }, { name: 'Waiting for approval', color: 'var(--c3)' }, { name: 'Root', color: 'var(--c4)' }])}`)}`;
  }

  /* ---------- pages: Operations ---------- */
  function pageArgo() {
    var apps = allArgoApps();
    function node(a) {
      var kids = apps.filter(function (x) { return x.parent === a.name; });
      return html`<li><span class="tree-node"><strong>${a.comp ? html`<a href="#/entity/${a.comp}">${a.name}</a>` : a.name}</strong>${statusPill(a.sync)}${statusPill(a.health)}<span class="muted small">${a.rev}</span>
        ${a.sync !== 'Synced' ? html`<button class="btn sm" type="button" data-action="argo-sync" data-key="${a.name}" ${S.syncing[a.name] ? raw('disabled') : ''}>${S.syncing[a.name] ? 'Syncing…' : 'Sync'}</button>` : ''}</span>
        ${kids.length ? html`<ul>${kids.map(node)}</ul>` : ''}</li>`;
    }
    var oos = apps.filter(function (a) { return a.sync !== 'Synced'; }).length, deg = apps.filter(function (a) { return a.health !== 'Healthy'; }).length;
    return html`${head('ArgoCD', 'App-of-apps: idp-root owns the platform infrastructure and the idp-services ApplicationSet, which generates one Application per services/<name>/.')}
      <div class="grid g4">${stat('Applications', apps.length, 'in 2 projects')}${stat('Synced', apps.length - oos, oos + ' out of sync')}${stat('Healthy', apps.length - deg, deg + ' degraded')}${stat('Last sync', '41 s ago', 'auto-sync + self-heal')}</div>
      ${card('Application tree', html`<ul class="tree">${apps.filter(function (a) { return !a.parent; }).map(node)}</ul>`)}`;
  }

  var ROLL_STEPS = [['setWeight', 10], ['pause', '30s'], ['analysis', 'success-rate'], ['setWeight', 25], ['pause', '30s'], ['setWeight', 50], ['analysis', 'p95-latency'], ['setWeight', 100]];
  function rollWeight(step) { var w = 0; for (var i = 0; i < step && i < ROLL_STEPS.length; i++) if (ROLL_STEPS[i][0] === 'setWeight') w = ROLL_STEPS[i][1]; return w; }
  function pageRollouts() {
    var r = S.rollout, w = r.aborted ? 0 : rollWeight(r.step), doneAll = r.step >= ROLL_STEPS.length, total = 6, canPods = Math.round(total * w / 100);
    var status = r.aborted ? 'Aborted' : doneAll ? 'Healthy' : r.playing ? 'Progressing' : 'Paused';
    return html`${head('Argo Rollouts', 'Canary release of payments-api 3.22.0 → 3.23.0 with automated analysis against Prometheus.')}
      <div class="grid g3">
        ${card('payments-api', html`<dl class="kv"><dt>Strategy</dt><dd>Canary</dd><dt>Stable</dt><dd><code>3.22.0</code></dd><dt>Canary</dt><dd><code>3.23.0</code></dd><dt>Status</dt><dd>${statusPill(status)}</dd><dt>Step</dt><dd>${Math.min(r.step, ROLL_STEPS.length)} / ${ROLL_STEPS.length}</dd></dl>
          <div class="btn-row" style="margin-top:14px">
            <button class="btn primary" type="button" data-action="roll-play" ${doneAll || r.aborted || r.playing ? raw('disabled') : ''}>${r.step ? 'Promote' : 'Start canary'}</button>
            <button class="btn danger" type="button" data-action="roll-abort" ${doneAll || r.aborted || !r.step ? raw('disabled') : ''}>Abort</button>
            <button class="btn" type="button" data-action="roll-reset">Reset</button></div>`)}
        ${card('Traffic split', html`<div class="traffic" role="img" aria-label="${(100 - w) + '% stable, ' + w + '% canary'}"><div style="flex-basis:${100 - w}%;background:var(--c1)">${100 - w ? 'stable ' + (100 - w) + '%' : ''}</div><div style="flex-basis:${w}%;background:var(--c2)">${w ? 'canary ' + w + '%' : ''}</div></div>
          <h3 style="margin:14px 0 8px">Pods</h3><div class="pods">${Array.from({ length: total }).map(function (_, i) { return html`<span class="pod" title="${i < total - canPods ? 'stable' : 'canary'}" style="background:${raw(i < total - canPods ? 'var(--c1)' : 'var(--c2)')}"></span>`; })}</div>
          <h3 style="margin:14px 0 8px">Steps</h3><div class="rollout-steps">${ROLL_STEPS.map(function (s, i) { return html`<span class="${i < r.step ? 'done' : i === r.step && !doneAll && !r.aborted ? 'cur' : ''}">${s[0]} ${s[1]}${s[0] === 'setWeight' ? '%' : ''}</span>`; })}</div>`, null, 'span2')}
      </div>
      ${card('Analysis runs', table(['Metric', 'Query', 'Result', 'Status'], [
        ['success-rate', html`<code>sum(rate(http_requests_total{code!~"5.."}[2m])) / sum(rate(http_requests_total[2m]))</code>`, r.step > 2 ? '99.71% (≥ 99.5%)' : '-', statusPill(r.step > 2 ? 'Passed' : 'pending')],
        ['p95-latency', html`<code>histogram_quantile(0.95, …) &lt; 0.3</code>`, r.step > 6 ? '212 ms' : '-', statusPill(r.step > 6 ? 'Passed' : 'pending')]]))}`;
  }
  function rollTick() {
    var r = S.rollout;
    if (!r.playing || r.aborted) return;
    r.step++;
    if (r.step >= ROLL_STEPS.length) r.playing = false;
    refreshIf('rollouts');
    if (r.playing) setTimeout(rollTick, 1100);
  }

  function pageGrafana() {
    var tab = S.grafana, hl = hourLabels(24), body;
    if (tab === 'qa') {
      body = html`<div class="grid g4">${stat('Test pass rate', '97.8%', '24 h, all suites')}${stat('Flaky tests', '12', '3 quarantined this week')}${stat('Coverage (median)', '78%', 'gate: 70%')}${stat('Contract checks', '412', 'can-i-deploy: 2 blocked')}</div>
        <div class="grid g2" style="margin-top:16px">
          ${card('Pass rate by suite type', lineChart([{ name: 'unit', values: series('qa-u', 24, 99.2, 0.4) }, { name: 'e2e', values: series('qa-e', 24, 94.5, 1.8) }, { name: 'contract', values: series('qa-c', 24, 98, 0.8) }], { labels: hl, min: 85, max: 100, area: false, label: 'Pass rate by suite' }))}
          ${card('Suite duration (min)', barChart([['unit', 2.1], ['component', 4.8], ['integration', 7.9], ['contract', 1.6], ['e2e', 12.4], ['k6', 9.0], ['zap', 14.2]].map(function (x, i) { return { label: x[0], value: x[1], color: 'var(--c' + (i % 6 + 1) + ')' }; }), { label: 'Suite durations' }))}
        </div>`;
    } else if (tab === 'ai') {
      var tools = [['catalog_search', 4210], ['get_service_metrics', 2380], ['list_deployments', 1990], ['list_apps', 1720], ['get_test_metrics', 1180], ['scaffold_service', 96]];
      body = html`<div class="grid g4">${stat('Tool calls (24 h)', '14,860', 'mcp_tool_calls_total')}${stat('Tool p95', '284 ms', 'mcp_tool_duration_seconds')}${stat('LLM calls', '9,412', 'ai_api_calls_total')}${stat('AI cost (24 h)', '$41.80', 'by team label')}</div>
        <div class="grid g2" style="margin-top:16px">
          ${card('Tool calls by tool', hbars(tools.map(function (t) { return { label: t[0], value: t[1], max: 4500, text: num(t[1]) }; })))}
          ${card('Calls per hour by agent', lineChart([{ name: 'idp-assistant', values: series('ai1', 24, 260, 60) }, { name: 'platform-assistant', values: series('ai2', 24, 180, 40) }, { name: 'qa-assistant', values: series('ai3', 24, 70, 20) }], { labels: hl, area: false, label: 'Calls per hour by agent' }))}
        </div>`;
    } else {
      var svc = D.components.filter(function (c) { return c.replicas > 1; }).slice(0, 4);
      body = html`<div class="grid g2">
          ${card('Requests / s by service', lineChart(svc.map(function (c) { return { name: c.name, values: series('g-rps' + c.name, 24, c.replicas * 40, 20) }; }), { labels: hl, area: false, label: 'Requests per second by service' }))}
          ${card('Error rate (%)', lineChart(svc.map(function (c) { return { name: c.name, values: series('g-err' + c.name, 24, c.dora.cfr / 12, 0.2) }; }), { labels: hl, area: false, label: 'Error rate by service' }))}
          ${card('p95 latency (ms)', lineChart(svc.map(function (c) { return { name: c.name, values: series('g-lat' + c.name, 24, 100 + c.dora.lt * 3, 25) }; }), { labels: hl, area: false, label: 'p95 latency by service' }))}
          ${card('Pod restarts (24 h)', barChart(D.components.filter(function (c) { return c.replicas; }).slice(0, 10).map(function (c) { return { label: c.name.split('-')[0], value: c.name === 'inventory-service' ? 41 : Math.floor(rng('rs' + c.name)() * 4), color: c.name === 'inventory-service' ? 'var(--bad)' : 'var(--c1)' }; }), { label: 'Pod restarts' }))}
        </div>`;
    }
    return html`${head('Dashboards', 'Grafana-style views over Prometheus. The real dashboards live in kubernetes/monitoring/.')}
      <div style="margin-bottom:16px">${chips('grafana', [['services', 'IDP Services'], ['qa', 'QA metrics'], ['ai', 'AI observability']], tab)}</div>${body}`;
  }

  function pageAlerts() {
    var st = S.alertState, list = D.alerts.filter(function (a) { return !st || a.state === st; });
    return html`${head('Alerts', 'Prometheus alerting rules and their current state. Every rule links a runbook.')}
      <div class="grid g3">${['firing', 'pending', 'inactive'].map(function (s) { return stat(s[0].toUpperCase() + s.slice(1), D.alerts.filter(function (a) { return a.state === s; }).length, 'rules'); })}</div>
      <div style="margin:16px 0">${chips('alertState', ['firing', 'pending', 'inactive'], st, 'All')}</div>
      ${card(list.length + ' rules', table(['Alert', 'State', 'Severity', 'Labels', 'For', 'Runbook'], list.map(function (a) {
        return [html`<strong>${a.name}</strong><div class="muted small mono" style="max-width:420px">${a.expr}</div>`, statusPill(a.state), pill(a.sev, a.sev === 'critical' ? 'bad' : a.sev === 'warning' ? 'warn' : 'info'), html`<code class="small">${a.labels}</code>`, a.since, html`<a href="#/techdocs/runbooks">${a.runbook}</a>`];
      })))}`;
  }

  function pagePolicies() {
    return html`${head('Policy violations', 'Kyverno and OPA Gatekeeper results across namespaces. Audit-mode findings do not block; Enforce/Deny do.')}
      <div class="grid g4">${stat('Violations', D.violations.length, 'open')}${stat('Kyverno', D.violations.filter(function (v) { return v.engine === 'Kyverno'; }).length, 'policy reports')}${stat('Gatekeeper', D.violations.filter(function (v) { return v.engine === 'Gatekeeper'; }).length, 'constraints')}${stat('Blocked (7 d)', '23', 'admission denials')}</div>
      ${card('Findings', table(['Policy', 'Engine', 'Resource', 'Namespace', 'Action', 'Severity', 'Message'], D.violations.map(function (v) {
        return [html`<code>${v.policy}</code>`, v.engine, v.resource, v.ns, pill(v.action, v.action === 'Audit' ? 'info' : 'bad'), pill(v.sev, v.sev === 'critical' || v.sev === 'high' ? 'bad' : v.sev === 'medium' ? 'warn' : ''), v.msg];
      })), html`<span class="muted">via security-mcp-server · list_policy_violations</span>`)}`;
  }

  function pageCrossplane() {
    var bad = D.resources.filter(function (r) { return !r.ready; });
    return html`${head('Crossplane claims', 'Per-service AWS resources requested through scaffolder templates and synced by ArgoCD. AWS only; claims live at services/<svc>/claims/.')}
      ${bad.map(function (r) { return html`<div class="notice"><strong>${r.name}</strong> is not ready: ${r.reason}</div>`; })}
      ${card(D.resources.length + ' claims', table(['Claim', 'Kind', 'Template', 'Namespace', 'Synced', 'Ready', 'Connection secret', 'Age'], D.resources.map(function (r) {
        return [html`<strong>${r.name}</strong><div class="muted small">${r.desc}</div>`, r.kind, html`<a href="#/create/${r.provider}">${r.provider}</a>`, r.ns, statusPill(String(r.synced)), statusPill(r.ready ? 'Ready' : 'Not ready'), html`<code>${r.secret}</code>`, r.age];
      })))}`;
  }

  function pagePreviews() {
    return html`${head('Preview environments', 'One namespace per pull request, created by CI and destroyed when the PR closes or the TTL runs out.')}
      <div class="grid g4">${stat('Active', S.previews.filter(function (p) { return p.status !== 'destroyed'; }).length, 'environments')}${stat('Cost (MTD)', money(212.4, 2), 'all previews')}${stat('Median lifetime', '19 h', '')}${stat('Default TTL', '3 days', 'extendable')}</div>
      ${card('Environments', table(['PR', 'Service', 'Branch', 'Author', 'Status', 'URL', 'TTL', 'Cost', ''], S.previews.map(function (p) {
        return [html`<strong>#${p.pr}</strong>`, entLink(p.service), html`<code class="small">${p.branch}</code>`, p.author, statusPill(p.status === 'ready' ? 'Ready' : p.status), p.status === 'ready' ? html`<code class="small">${p.url}</code>` : html`<span class="muted small">${p.reason || '-'}</span>`, p.ttl, money(p.cost, 2),
          p.status === 'destroyed' ? '' : html`<div class="btn-row"><button class="btn sm" type="button" data-action="preview" data-key="${p.pr}" data-value="extend" ${p.status !== 'ready' ? raw('disabled') : ''}>Extend</button><button class="btn sm danger" type="button" data-action="preview" data-key="${p.pr}" data-value="destroy">Destroy</button></div>`];
      }), [7]))}`;
  }

  function notFound(msg) {
    return html`<div class="card empty"><h1>Page not found</h1><p>${msg || 'There is nothing at this address in the demo.'}</p><a class="btn primary" href="#/home">Go home</a></div>`;
  }

  /* ---------- router ---------- */
  var PAGES = {
    home: pageHome, catalog: pageCatalog, teams: pageTeams, create: pageCreate, apis: pageApis, techdocs: pageTechdocs, 'tech-radar': pageRadar,
    dora: pageDora, finops: pageFinops, incidents: pageIncidents, 'learning-center': pageLearning, 'engineering-intelligence': pageEI, copilot: pageCopilot,
    'devex-survey': pageSurvey, 'ai-assistant': pageAssistant, 'ai-search': pageAISearch, approvals: pageApprovals, kagent: pageKagent, mcp: pageMcp,
    'ai-gateway': pageGateway, litellm: pageLitellm, mlflow: pageMlflow, langfuse: pageLangfuse, argocd: pageArgo, rollouts: pageRollouts,
    grafana: pageGrafana, alerts: pageAlerts, policies: pagePolicies, crossplane: pageCrossplane, previews: pagePreviews
  };
  var TITLES = {};
  NAV.forEach(function (g) { g.items.forEach(function (it) { TITLES[it[0]] = it[1]; }); });

  function renderPage() {
    var p = parts(), r = p[0], out;
    if (r === 'entity') out = pageEntity(p[1], p[2]);
    else if (r === 'team') out = pageTeam(p[1], p[2]);
    else if (r === 'create' && p[1]) out = pageTemplate(p[1], p[2]);
    else if ((r === 'apis' || r === 'techdocs' || r === 'incidents') && p[1]) out = PAGES[r](p[1]);
    else if (PAGES[r] && !p[1]) out = PAGES[r]();
    else out = notFound();
    return out;
  }
  var lastHash = null;
  function render() {
    var h = location.hash;
    $('#content').innerHTML = renderPage().s;
    renderSidebar();
    var p = parts();
    document.title = (p[0] === 'entity' ? p[1] : p[0] === 'team' ? p[1] : TITLES[p[0]] || 'Not found') + ' · IDP Platform Demo';
    if (h !== lastHash) {
      window.scrollTo(0, 0);
      document.body.classList.remove('nav-open');
      $('#menu-btn').setAttribute('aria-expanded', 'false');
      lastHash = h;
    }
    var cs = $('#chat-scroll');
    if (cs) cs.scrollTop = cs.scrollHeight;
    var lg = $('#run-log');
    if (lg) lg.scrollTop = lg.scrollHeight;
  }
  function rerender() {
    var a = document.activeElement, id = a && a.id && $('#content').contains(a) ? a.id : null, pos = null;
    try { pos = id ? a.selectionStart : null; } catch (e) { pos = null; }
    var y = window.scrollY;
    render();
    window.scrollTo(0, y);
    if (id) {
      var el = document.getElementById(id);
      if (el) { el.focus({ preventScroll: true }); try { if (pos != null) el.setSelectionRange(pos, pos); } catch (e) { /* not a text input */ } }
    }
  }
  function refreshIf(route) { if (current() === route) rerender(); else renderSidebar(); }
  function $(sel) { return document.querySelector(sel); }

  /* ---------- state binding ---------- */
  function setPath(path, value) {
    var keys = path.split('.'), o = S;
    for (var i = 0; i < keys.length - 1; i++) { if (o[keys[i]] == null) o[keys[i]] = {}; o = o[keys[i]]; }
    var last = keys[keys.length - 1];
    o[last] = typeof o[last] === 'number' ? Number(value) : value;
  }
  function getPath(path) { return path.split('.').reduce(function (o, k) { return o == null ? o : o[k]; }, S); }

  /* ---------- actions ---------- */
  var ACTIONS = {
    set: function (el) {
      var k = el.getAttribute('data-key'), v = el.getAttribute('data-value');
      if (k.indexOf('catalog.') === 0 && k !== 'catalog.kind') { if (k === 'catalog.owner' || k === 'catalog.system') S.catalog.kind = 'Component'; }
      setPath(k, getPath(k) === v && el.classList.contains('chip') && k !== 'grafana' && k !== 'approvalsTab' && k !== 'aiQuery' && k !== 'mlExp' && k !== 'trace' ? '' : v);
      if (el.tagName !== 'A') rerender();
    },
    'reset-catalog': function () { S.catalog = { q: '', kind: 'Component', owner: '', tier: '', system: '' }; rerender(); },
    'toggle-theme': function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var dark = cur ? cur === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      var next = dark ? 'light' : 'dark';
      document.documentElement.setAttribute('data-theme', next);
      try { localStorage.setItem('idp-demo-theme', next); } catch (e) { /* storage unavailable */ }
      themeIcon();
    },
    'open-nav': function () { var open = !document.body.classList.contains('nav-open'); document.body.classList.toggle('nav-open', open); $('#menu-btn').setAttribute('aria-expanded', String(open)); },
    'close-nav': function () { document.body.classList.remove('nav-open'); $('#menu-btn').setAttribute('aria-expanded', 'false'); },
    ask: function (el) {
      var p = el.getAttribute('data-prompt');
      if (current() !== 'ai-assistant') { location.hash = '#/ai-assistant'; }
      askAssistant(p);
    },
    'new-chat': function () { S.chat = []; rerender(); },
    'chat-approve': function (el) { approveChat(+el.getAttribute('data-key')); },
    'chat-cancel': function (el) {
      var m = S.chat[+el.getAttribute('data-key')];
      if (m && m.state === 'pending') { m.state = 'cancelled'; S.chat.push({ role: 'bot', tools: [], body: html`<p>Cancelled. Nothing was created.</p>` }); rerender(); }
    },
    approval: function (el) {
      var a = S.approvals.filter(function (x) { return x.id === el.getAttribute('data-key'); })[0];
      if (a) { a.status = el.getAttribute('data-value'); rerender(); }
    },
    'toggle-done': function (el) {
      var k = el.getAttribute('data-key');
      S.done[k] = !S.done[k];
      try { localStorage.setItem('idp-demo-learning', JSON.stringify(S.done)); } catch (e) { /* storage unavailable */ }
      rerender();
    },
    'try-api': function (el) { var k = el.getAttribute('data-key'); S.apiTry = S.apiTry === k ? null : k; rerender(); },
    'argo-sync': function (el) {
      var k = el.getAttribute('data-key');
      S.syncing[k] = true; rerender();
      setTimeout(function () { S.syncing[k] = false; S.synced[k] = true; refreshIf('argocd'); }, 1200);
    },
    'roll-play': function () { var r = S.rollout; if (r.playing) return; r.playing = true; rerender(); setTimeout(rollTick, 600); },
    'roll-abort': function () { S.rollout.aborted = true; S.rollout.playing = false; rerender(); },
    'roll-reset': function () { S.rollout = { step: 0, playing: false, aborted: false }; rerender(); },
    preview: function (el) {
      var p = S.previews.filter(function (x) { return String(x.pr) === el.getAttribute('data-key'); })[0];
      if (!p) return;
      if (el.getAttribute('data-value') === 'extend') p.ttl = 'extended +2d';
      else { p.status = 'destroyed'; p.ttl = '-'; p.url = '-'; p.reason = 'namespace deleted'; }
      rerender();
    },
    toast: function (el) { el.textContent = el.getAttribute('data-msg'); el.disabled = true; }
  };
  var SUBMITS = {
    scaffold: function (form) {
      var name = form.getAttribute('data-tpl'), t = tpl(name), f = S.form[name], err = form.querySelector('#form-error');
      if (!/^[a-z][a-z0-9-]{2,40}$/.test(f.name)) { err.textContent = 'Name must start with a letter and use only lowercase letters, digits and hyphens (3–41 characters).'; form.querySelector('#f-name').focus(); return; }
      if (comp(f.name) && !(t.type === 'test-suite' || t.type === 'platform-capability')) { err.textContent = 'A component named ' + f.name + ' already exists.'; return; }
      startRun(t, Object.assign({}, f));
      location.hash = '#/create/' + name + '/run';
    },
    chat: function () { askAssistant(S.chatDraft); },
    'ai-search': function () { rerender(); },
    survey: function () { S.surveySent = true; rerender(); }
  };

  /* ---------- global search ---------- */
  function searchIndex() {
    var idx = [];
    NAV.forEach(function (g) { g.items.forEach(function (it) { idx.push({ t: it[1], k: 'Page · ' + g.group, h: '#/' + it[0] }); }); });
    D.components.forEach(function (c) { idx.push({ t: c.name, k: 'Component · ' + c.owner, h: '#/entity/' + c.name, x: c.desc + ' ' + c.tags.join(' ') }); });
    D.apis.forEach(function (a) { idx.push({ t: a.name, k: 'API · ' + a.type, h: '#/apis/' + a.name, x: a.desc }); });
    D.teams.forEach(function (t) { idx.push({ t: t.name, k: 'Team', h: '#/team/' + t.name, x: t.display }); });
    D.templates.forEach(function (t) { idx.push({ t: t.t, k: 'Template', h: '#/create/' + t.n, x: t.n + ' ' + t.tags.join(' ') }); });
    D.docs.forEach(function (d) { idx.push({ t: d.title, k: 'TechDocs', h: '#/techdocs/' + d.id }); });
    return idx;
  }
  var searchSel = 0;
  function runSearch() {
    var input = $('#global-search'), box = $('#search-results'), q = input.value.trim().toLowerCase();
    if (!q) { box.hidden = true; input.setAttribute('aria-expanded', 'false'); return; }
    var res = searchIndex().map(function (e) {
      var tl = e.t.toLowerCase(), score = tl === q ? 3 : tl.indexOf(q) === 0 ? 2 : tl.indexOf(q) >= 0 ? 1.5 : (e.x || '').toLowerCase().indexOf(q) >= 0 ? 1 : 0;
      return { e: e, s: score };
    }).filter(function (r) { return r.s > 0; }).sort(function (a, b) { return b.s - a.s; }).slice(0, 10);
    searchSel = Math.min(searchSel, Math.max(0, res.length - 1));
    box.innerHTML = res.length ? res.map(function (r, i) {
      return html`<a href="${r.e.h}" class="${i === searchSel ? 'active' : ''}" data-search-item><span>${r.e.t}</span><span class="kind">${r.e.k}</span></a>`.s;
    }).join('') : html`<div class="muted" style="padding:8px 10px">No matches for "${input.value}".</div>`.s;
    box.hidden = false;
    input.setAttribute('aria-expanded', 'true');
  }
  function closeSearch() { $('#search-results').hidden = true; $('#global-search').setAttribute('aria-expanded', 'false'); }

  function themeIcon() {
    var cur = document.documentElement.getAttribute('data-theme');
    var dark = cur ? cur === 'dark' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    var b = $('#theme-btn');
    b.innerHTML = icon(dark ? 'sun' : 'moon', 18).s;
    b.setAttribute('aria-label', dark ? 'Switch to light theme' : 'Switch to dark theme');
  }
  function syncBannerHeight() { document.documentElement.style.setProperty('--bh', $('#banner').offsetHeight + 'px'); }

  /* ---------- wiring ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (el && ACTIONS[el.getAttribute('data-action')]) {
      if (el.tagName !== 'A') e.preventDefault();
      ACTIONS[el.getAttribute('data-action')](el, e);
    }
    if (e.target.closest('[data-search-item]')) { $('#global-search').value = ''; closeSearch(); }
    else if (!e.target.closest('.search')) closeSearch();
  });
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.id === 'global-search') { searchSel = 0; runSearch(); return; }
    var b = el.getAttribute('data-bind'), q = el.getAttribute('data-bind-quiet');
    if (b) { setPath(b, el.value); rerender(); }
    else if (q) setPath(q, el.value);
  });
  document.addEventListener('change', function (e) {
    var q = e.target.getAttribute && e.target.getAttribute('data-bind-quiet');
    if (q) setPath(q, e.target.value);
  });
  document.addEventListener('submit', function (e) {
    var f = e.target.closest('[data-submit]');
    if (f && SUBMITS[f.getAttribute('data-submit')]) { e.preventDefault(); SUBMITS[f.getAttribute('data-submit')](f); }
  });
  document.addEventListener('keydown', function (e) {
    var input = $('#global-search');
    if (e.key === '/' && document.activeElement && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); input.focus(); return; }
    if (e.key === 'Escape') { closeSearch(); document.body.classList.remove('nav-open'); return; }
    if (document.activeElement === input && !$('#search-results').hidden) {
      var items = document.querySelectorAll('#search-results a');
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') { e.preventDefault(); searchSel = (searchSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % Math.max(1, items.length); runSearch(); }
      else if (e.key === 'Enter' && items[searchSel]) { e.preventDefault(); location.hash = items[searchSel].getAttribute('href'); input.value = ''; closeSearch(); input.blur(); }
    }
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('resize', syncBannerHeight);
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeIcon); } catch (e) { /* old browsers */ } }

  $('#menu-btn').innerHTML = icon('menu', 18).s;
  themeIcon();
  syncBannerHeight();
  render();

  // Exposed for automated checks only.
  window.__demo = { routes: ROUTES, state: S };
})();
