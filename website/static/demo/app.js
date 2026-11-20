/* Static demo of the IDP's Backstage portal.
 * Navigation, page list, titles, headers and tab filters mirror the real app:
 *   backstage/app/packages/app/src/modules/nav/Sidebar.tsx  (sidebar order)
 *   backstage/app/packages/app/src/extensions.tsx           (custom pages + entity tabs)
 *   backstage/app/packages/app/src/entityFilters.ts         (which tabs an entity gets)
 *   backstage/app/packages/app/src/App.tsx                  (stock plugins)
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
  function $(sel) { return document.querySelector(sel); }

  /* ---------- deterministic data ---------- */
  function hash(s) {
    var h = 2166136261; s = String(s);
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
  function series(seed, n, base, spread, trend) {
    var r = rng(seed), out = [], prev = base;
    for (var i = 0; i < n; i++) {
      var target = base * (1 + (trend || 0) * (i / Math.max(1, n - 1) - 0.5)) + (r() - 0.5) * 2 * spread;
      prev = prev * 0.45 + target * 0.55;
      out.push(Math.max(0, prev));
    }
    return out;
  }
  var NOW = new Date(2026, 10, 20, 14, 32, 10);
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function fmtDate(d) { return pad(d.getDate()) + '/' + pad(d.getMonth() + 1) + '/' + d.getFullYear() + ', ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); }
  function ago(mins) { return fmtDate(new Date(NOW.getTime() - mins * 60000)); }
  function iso(offsetSec) { var d = new Date(NOW.getTime() + offsetSec * 1000); return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()) + '.' + String(100 + (hash(offsetSec) % 900)) + 'Z'; }
  function dayLabels(n) { var out = []; for (var i = n - 1; i >= 0; i--) { var d = new Date(NOW.getTime() - i * 864e5); out.push((d.getMonth() + 1) + '/' + d.getDate()); } return out; }

  /* ---------- formatting ---------- */
  function num(n, d) { return Number(n).toLocaleString('en-US', { minimumFractionDigits: d || 0, maximumFractionDigits: d || 0 }); }
  function money(n, d) { return '$' + num(n, d == null ? 2 : d); }
  function pct(n, d) { return num(n, d == null ? 1 : d) + '%'; }
  function dur(m) { return m < 60 ? Math.round(m) + ' min' : num(m / 60, 1) + ' h'; }
  function hours(h) { return h < 24 ? num(h, 1) + ' h' : num(h / 24, 1) + ' d'; }
  function initials(n) { return String(n).split(/[\s-]+/).map(function (p) { return p[0] || ''; }).join('').slice(0, 2).toUpperCase(); }
  function cap(s) { s = String(s); return s.charAt(0).toUpperCase() + s.slice(1); }

  /* ---------- Material-style icons (filled, 24px) ---------- */
  var IC = {
    home: 'M10 20v-6h4v6h5v-8h3L12 3 2 12h3v8z',
    dashboard: 'M3 13h8V3H3v10zm0 8h8v-6H3v6zm10 0h8V11h-8v10zm0-18v6h8V3h-8z',
    search: 'M15.5 14h-.79l-.28-.27A6.47 6.47 0 0 0 16 9.5 6.5 6.5 0 1 0 9.5 16c1.61 0 3.09-.59 4.23-1.57l.27.28v.79l5 4.99L20.49 19l-4.99-5zm-6 0C7.01 14 5 11.99 5 9.5S7.01 5 9.5 5 14 7.01 14 9.5 11.99 14 9.5 14z',
    add: 'M13 7h-2v4H7v2h4v4h2v-4h4v-2h-4V7zm-1-5C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z',
    extension: 'M20.5 11H19V7c0-1.1-.9-2-2-2h-4V3.5a2.5 2.5 0 0 0-5 0V5H4c-1.1 0-1.99.9-1.99 2v3.8H3.5c1.49 0 2.7 1.21 2.7 2.7s-1.21 2.7-2.7 2.7H2V20c0 1.1.9 2 2 2h3.8v-1.5c0-1.49 1.21-2.7 2.7-2.7 1.49 0 2.7 1.21 2.7 2.7V22H17c1.1 0 2-.9 2-2v-4h1.5a2.5 2.5 0 0 0 0-5z',
    tree: 'M22 11V3h-7v3H9V3H2v8h7V8h2v10h4v3h7v-8h-7v3h-2V8h2v3z',
    feed: 'M8 8H6v7c0 1.1.9 2 2 2h9v-2H8V8zm12-5h-8c-1.1 0-2 .9-2 2v6c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 8h-8V7h8v4zM4 12H2v7c0 1.1.9 2 2 2h9v-2H4v-7z',
    admin: 'M16.5 12c1.38 0 2.49-1.12 2.49-2.5S17.88 7 16.5 7a2.5 2.5 0 0 0 0 5zM9 11c1.66 0 2.99-1.34 2.99-3S10.66 5 9 5C7.34 5 6 6.34 6 8s1.34 3 3 3zm7.5 3c-1.83 0-5.5.92-5.5 2.75V19h11v-2.25c0-1.83-3.67-2.75-5.5-2.75zM9 13c-2.33 0-7 1.17-7 3.5V19h7v-2.25c0-.85.33-2.34 2.37-3.47C10.5 13.1 9.66 13 9 13z',
    gavel: 'M1 21h12v2H1zM5.245 8.07l2.83-2.827 14.14 14.142-2.828 2.828zM12.317 1l5.657 5.656-2.83 2.83-5.654-5.66zM3.825 9.485l5.657 5.657-2.828 2.828-5.657-5.657z',
    chat: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zM6 9h12v2H6V9zm8 5H6v-2h8v2zm4-6H6V6h12v2z',
    timeline: 'M23 8c0 1.1-.9 2-2 2a1.7 1.7 0 0 1-.51-.07l-3.56 3.55c.05.16.07.34.07.52 0 1.1-.9 2-2 2s-2-.9-2-2c0-.18.02-.36.07-.52l-2.55-2.55c-.16.05-.34.07-.52.07s-.36-.02-.52-.07l-4.55 4.56c.05.16.07.33.07.51 0 1.1-.9 2-2 2s-2-.9-2-2 .9-2 2-2c.18 0 .35.02.51.07l4.56-4.55C8.02 9.36 8 9.18 8 9c0-1.1.9-2 2-2s2 .9 2 2c0 .18-.02.36-.07.52l2.55 2.55c.16-.05.34-.07.52-.07s.36.02.52.07l3.55-3.56A1.7 1.7 0 0 1 19 8c0-1.1.9-2 2-2s2 .9 2 2z',
    campaign: 'M18 11v2h4v-2h-4zm-2 6.61c.96.71 2.21 1.65 3.2 2.39.4-.53.8-1.07 1.2-1.6-.99-.74-2.24-1.68-3.2-2.4-.4.54-.8 1.08-1.2 1.61zM20.4 5.6c-.4-.53-.8-1.07-1.2-1.6-.99.74-2.24 1.68-3.2 2.4.4.53.8 1.07 1.2 1.6.96-.72 2.21-1.65 3.2-2.4zM4 9c-1.1 0-2 .9-2 2v2c0 1.1.9 2 2 2h1v4h2v-4h1l5 3V6L8 9H4zm11.5 3c0-1.33-.58-2.53-1.5-3.35v6.69c.92-.81 1.5-2.01 1.5-3.34z',
    money: 'M11.8 10.9c-2.27-.59-3-1.2-3-2.15 0-1.09 1.01-1.85 2.7-1.85 1.78 0 2.44.85 2.5 2.1h2.21c-.07-1.72-1.12-3.3-3.21-3.81V3h-3v2.16c-1.94.42-3.5 1.68-3.5 3.61 0 2.31 1.91 3.46 4.7 4.13 2.5.6 3 1.48 3 2.41 0 .69-.49 1.79-2.7 1.79-2.06 0-2.87-.92-2.98-2.1h-2.2c.12 2.19 1.76 3.42 3.68 3.83V21h3v-2.15c1.95-.37 3.5-1.5 3.5-3.55 0-2.84-2.43-3.81-4.7-4.4z',
    calc: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1.41 16.09V20h-2.67v-1.93c-1.71-.36-3.16-1.46-3.27-3.4h1.96c.1 1.05.82 1.87 2.65 1.87 1.96 0 2.4-.98 2.4-1.59 0-.83-.44-1.61-2.67-2.14-2.48-.6-4.18-1.62-4.18-3.67 0-1.72 1.39-2.84 3.11-3.21V4h2.67v1.95c1.86.45 2.79 1.86 2.85 3.39H14.3c-.05-1.11-.64-1.87-2.22-1.87-1.5 0-2.4.68-2.4 1.64 0 .84.65 1.39 2.67 1.91s4.18 1.39 4.18 3.91c-.01 1.83-1.38 2.83-3.12 3.16z',
    feedback: 'M20 2H4c-1.1 0-1.99.9-1.99 2L2 22l4-4h14c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-7 12h-2v-2h2v2zm0-4h-2V6h2v4z',
    docs: 'M14 2H6c-1.1 0-1.99.9-1.99 2L4 20c0 1.1.89 2 1.99 2H18c1.1 0 2-.9 2-2V8l-6-6zm2 16H8v-2h8v2zm0-4H8v-2h8v2zm-3-5V3.5L18.5 9H13z',
    trending: 'M16 6l2.29 2.29-4.88 4.88-4-4L2 16.59 3.41 18l6-6 4 4 6.3-6.29L22 12V6z',
    insights: 'M21 8c-1.45 0-2.26 1.44-1.93 2.51l-3.55 3.56c-.3-.09-.74-.09-1.04 0l-2.55-2.55C12.27 10.45 11.46 9 10 9c-1.45 0-2.27 1.44-1.93 2.52l-4.56 4.55C2.44 15.74 1 16.55 1 18c0 1.1.9 2 2 2 1.45 0 2.26-1.44 1.93-2.51l4.55-4.56c.3.09.74.09 1.04 0l2.55 2.55C12.73 16.55 13.54 18 15 18c1.45 0 2.27-1.44 1.93-2.52l3.56-3.55c1.07.33 2.51-.48 2.51-1.93 0-1.1-.9-2-2-2zM15 9l.94-2.07L18 6l-2.06-.93L15 3l-.92 2.07L12 6l2.08.93zM3.5 11L4 9l2-.5L4 8l-.5-2L3 8l-2 .5L3 9z',
    warning: 'M1 21h22L12 2 1 21zm12-3h-2v-2h2v2zm0-4h-2v-4h2v4z',
    bot: 'M20 9V7c0-1.1-.9-2-2-2h-3c0-1.66-1.34-3-3-3S9 3.34 9 5H6c-1.1 0-2 .9-2 2v2c-1.66 0-3 1.34-3 3s1.34 3 3 3v4c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2v-4c1.66 0 3-1.34 3-3s-1.34-3-3-3zM7.5 11.5c0-.83.67-1.5 1.5-1.5s1.5.67 1.5 1.5S9.83 13 9 13s-1.5-.67-1.5-1.5zM16 17H8v-2h8v2zm-1-4c-.83 0-1.5-.67-1.5-1.5S14.17 10 15 10s1.5.67 1.5 1.5S15.83 13 15 13z',
    school: 'M5 13.18v4L12 21l7-3.82v-4L12 17l-7-3.82zM12 3L1 9l11 6 9-4.91V17h2V9L12 3z',
    key: 'M12.65 10A5.99 5.99 0 0 0 7 6c-3.31 0-6 2.69-6 6s2.69 6 6 6a5.99 5.99 0 0 0 5.65-4H17v4h4v-4h2v-4H12.65zM7 14c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2z',
    science: 'M19.8 18.4L14 10.67V6.5l1.35-1.69c.26-.33.03-.81-.39-.81H9.04c-.42 0-.65.48-.39.81L10 6.5v4.17L4.2 18.4c-.49.66-.02 1.6.8 1.6h14c.82 0 1.29-.94.8-1.6z',
    person: 'M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z',
    wave: 'M12 2c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm3.89 4.4L17.3 5l1.41 1.41-2.9 2.9-.81-.81V22h-2v-6h-2v6H9V9.5c-1.1 0-2-.9-2-2V2h2v5.5h1.5c.55 0 1.05.22 1.41.59l.48.48z',
    trophy: 'M19 5h-2V3H7v2H5c-1.1 0-2 .9-2 2v1c0 2.55 1.92 4.63 4.39 4.94A5.01 5.01 0 0 0 11 15.9V19H7v2h10v-2h-4v-3.1a5.01 5.01 0 0 0 3.61-2.96C19.08 12.63 21 10.55 21 8V7c0-1.1-.9-2-2-2zM5 8V7h2v3.82C5.84 10.4 5 9.3 5 8zm14 0c0 1.3-.84 2.4-2 2.82V7h2v1z',
    target: 'M19.07 4.93l-1.41 1.41A8.01 8.01 0 0 1 20 12c0 4.42-3.58 8-8 8s-8-3.58-8-8c0-4.08 3.05-7.44 7-7.93v2.02C8.16 6.57 6 9.03 6 12c0 3.31 2.69 6 6 6s6-2.69 6-6c0-1.66-.67-3.16-1.76-4.24l-1.41 1.41C15.55 9.9 16 10.9 16 12c0 2.21-1.79 4-4 4s-4-1.79-4-4c0-1.86 1.28-3.41 3-3.86v2.14c-.6.35-1 .98-1 1.72 0 1.1.9 2 2 2s2-.9 2-2c0-.74-.4-1.38-1-1.72V2h-1C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10c0-2.76-1.12-5.26-2.93-7.07z',
    help: 'M11 18h2v-2h-2v2zm1-16C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8zm0-14c-2.21 0-4 1.79-4 4h2c0-1.1.9-2 2-2s2 .9 2 2c0 2-3 1.75-3 5h2c0-2.25 3-2.5 3-5 0-2.21-1.79-4-4-4z',
    radar: 'M12 8c-2.21 0-4 1.79-4 4s1.79 4 4 4 4-1.79 4-4-1.79-4-4-4zm8.94 3A8.994 8.994 0 0 0 13 3.06V1h-2v2.06A8.994 8.994 0 0 0 3.06 11H1v2h2.06A8.994 8.994 0 0 0 11 20.94V23h2v-2.06A8.994 8.994 0 0 0 20.94 13H23v-2h-2.06zM12 19c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7z',
    gear: 'M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58a.49.49 0 0 0 .12-.61l-1.92-3.32a.488.488 0 0 0-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54a.484.484 0 0 0-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58a.49.49 0 0 0-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z',
    star: 'M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z',
    starO: 'M22 9.24l-7.19-.62L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21 12 17.27 18.18 21l-1.63-7.03L22 9.24zM12 15.4l-3.76 2.27 1-4.28-3.32-2.88 4.38-.38L12 6.1l1.71 4.04 4.38.38-3.32 2.88 1 4.28L12 15.4z',
    open: 'M19 19H5V5h7V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14c1.1 0 2-.9 2-2v-7h-2v7zM14 3v2h3.59l-9.83 9.83 1.41 1.41L19 6.41V10h2V3h-7z',
    edit: 'M3 17.25V21h3.75L17.81 9.94l-3.75-3.75L3 17.25zM20.71 7.04a.996.996 0 0 0 0-1.41l-2.34-2.34a.996.996 0 0 0-1.41 0l-1.83 1.83 3.75 3.75 1.83-1.83z',
    group: 'M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z',
    category: 'M12 2l-5.5 9h11L12 2zm5.5 11c-2.49 0-4.5 2.01-4.5 4.5s2.01 4.5 4.5 4.5 4.5-2.01 4.5-4.5-2.01-4.5-4.5-4.5zM3 21.5h8v-8H3v8z',
    widgets: 'M13 13v8h8v-8h-8zM3 21h8v-8H3v8zM3 3v8h8V3H3zm13.66-1.31L11 7.34 16.66 13l5.66-5.66-5.66-5.65z',
    checkC: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-2 15l-5-5 1.41-1.41L10 14.17l7.59-7.59L19 8l-9 9z',
    checkO: 'M16.59 7.58L10 14.17l-3.59-3.58L5 12l5 5 8-8zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
    cancel: 'M12 2C6.47 2 2 6.47 2 12s4.47 10 10 10 10-4.47 10-10S17.53 2 12 2zm5 13.59L15.59 17 12 13.41 8.41 17 7 15.59 10.59 12 7 8.41 8.41 7 12 10.59 15.59 7 17 8.41 13.41 12 17 15.59z',
    circleO: 'M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.42 0-8-3.58-8-8s3.58-8 8-8 8 3.58 8 8-3.58 8-8 8z',
    loading: 'M12 4V2A10 10 0 0 0 2 12h2a8 8 0 0 1 8-8z',
    menu: 'M3 18h18v-2H3v2zm0-5h18v-2H3v2zm0-7v2h18V6H3z',
    chevron: 'M10 6L8.59 7.41 13.17 12l-4.58 4.59L10 18l6-6z',
    more: 'M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z',
    send: 'M2.01 21L23 12 2.01 3 2 10l15 2-15 2z',
    history: 'M13 3a9 9 0 0 0-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42A8.954 8.954 0 0 0 13 21a9 9 0 0 0 0-18zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z',
    newchat: 'M22 4c0-1.1-.9-2-2-2H4c-1.1 0-1.99.9-1.99 2L2 16c0 1.1.9 2 2 2h14l4 4V4zm-5 7h-4v4h-2v-4H7V9h4V5h2v4h4v2z',
    clear: 'M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z',
    refresh: 'M17.65 6.35A7.958 7.958 0 0 0 12 4c-4.42 0-7.99 3.58-7.99 8s3.57 8 7.99 8c3.73 0 6.84-2.55 7.73-6h-2.08A5.99 5.99 0 0 1 12 18c-3.31 0-6-2.69-6-6s2.69-6 6-6c1.66 0 3.14.69 4.22 1.78L13 11h7V4l-2.35 2.35z',
    wrench: 'M22.7 19l-9.1-9.1c.9-2.3.4-5-1.5-6.9-2-2-5-2.4-7.4-1.3L9 6 6 9 1.6 4.7C.4 7.1.9 10.1 2.9 12.1c1.9 1.9 4.6 2.4 6.9 1.5l9.1 9.1c.4.4 1 .4 1.4 0l2.3-2.3c.5-.4.5-1.1.1-1.4z',
    library: 'M4 6H2v14c0 1.1.9 2 2 2h14v-2H4V6zm16-4H8c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-1 9H9V9h10v2zm-4 4H9v-2h6v2zm4-8H9V5h10v2z',
    code: 'M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z'
  };
  function icon(name, size, cls) {
    var s = size || 24;
    return raw('<svg width="' + s + '" height="' + s + '" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"' + (cls ? ' class="' + cls + '"' : '') + '><path d="' + IC[name] + '"/></svg>');
  }
  // Original stacked-layers mark, drawn for this demo (not the trademark file).
  var LOGO = raw('<svg width="30" height="30" viewBox="0 0 32 32" aria-hidden="true"><path d="M16 4l11 5.5L16 15 5 9.5z" fill="currentColor" opacity=".95"/><path d="M5 14.5L16 20l11-5.5M5 19.5L16 25l11-5.5" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linejoin="round"/></svg>');

  /* ---------- charts ---------- */
  function niceMax(v) {
    if (!(v > 0)) return 1;
    var st = v / 4, p = Math.pow(10, Math.floor(Math.log10(st))), n = st / p;
    return (n <= 1 ? 1 : n <= 2 ? 2 : n <= 2.5 ? 2.5 : n <= 5 ? 5 : 10) * p * 4;
  }
  function tick(v) { return v >= 1000 ? num(v / 1000, 1) + 'k' : num(v, v % 1 === 0 ? 0 : (v * 10) % 1 === 0 ? 1 : 2); }
  function legend(items) {
    return html`<div class="legend">${items.map(function (it, i) { return html`<span><i style="background:${raw(it.color || 'var(--c' + (i + 1) + ')')}"></i>${it.name}</span>`; })}</div>`;
  }
  function lineChart(ser, o) {
    o = o || {};
    var W = 560, H = o.h || 200, L = 40, R = 10, T = 10, B = 24, n = ser[0].values.length, all = [];
    ser.forEach(function (s) { all = all.concat(s.values); });
    var min = o.min || 0, max = o.max || niceMax(Math.max.apply(null, all) * 1.05), yf = o.yFmt || tick;
    function x(i) { return L + (W - L - R) * (n === 1 ? 0.5 : i / (n - 1)); }
    function y(v) { return T + (H - T - B) * (1 - (v - min) / (max - min)); }
    var s = '';
    for (var k = 0; k <= 4; k++) {
      var v = min + (max - min) * k / 4, yy = y(v).toFixed(1);
      s += '<line x1="' + L + '" x2="' + (W - R) + '" y1="' + yy + '" y2="' + yy + '" stroke="var(--grid)"/><text x="' + (L - 6) + '" y="' + (+yy + 4) + '" text-anchor="end">' + esc(yf(v)) + '</text>';
    }
    if (o.labels) {
      var every = Math.ceil(n / 7);
      o.labels.forEach(function (lb, i) { if (i % every === 0) s += '<text x="' + x(i).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(lb) + '</text>'; });
    }
    ser.forEach(function (sr, si) {
      var col = sr.color || 'var(--c' + (si + 1) + ')';
      var pts = sr.values.map(function (v, i) { return x(i).toFixed(1) + ',' + y(v).toFixed(1); });
      s += '<polyline points="' + pts.join(' ') + '" fill="none" stroke="' + col + '" stroke-width="2.2" stroke-linejoin="round"/>';
    });
    return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label || 'Line chart'}">${raw(s)}</svg>${ser.length > 1 ? legend(ser) : ''}`;
  }
  function stackedBars(labels, layers, o) {
    o = o || {};
    var W = 760, H = o.h || 180, B = 22, n = labels.length, totals = labels.map(function (_, i) { return layers.reduce(function (a, l) { return a + l.values[i]; }, 0); });
    var max = Math.max.apply(null, totals) * 1.1, bw = W / n, s = '';
    labels.forEach(function (lb, i) {
      var y0 = H - B;
      layers.forEach(function (l, li) {
        var h = (H - B - 6) * l.values[i] / max;
        s += '<rect x="' + (i * bw + 2).toFixed(1) + '" y="' + (y0 - h).toFixed(1) + '" width="' + (bw - 4).toFixed(1) + '" height="' + h.toFixed(1) + '" fill="' + (l.color || 'var(--c' + (li + 1) + ')') + '"><title>' + esc(l.name + ' ' + lb + ': $' + l.values[i].toFixed(2)) + '</title></rect>';
        y0 -= h;
      });
      s += '<text x="' + (i * bw + bw / 2).toFixed(1) + '" y="' + (H - 6) + '" text-anchor="middle">' + esc(lb) + '</text>';
    });
    return html`<svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${o.label || 'Stacked bar chart'}">${raw(s)}</svg>${legend(layers)}`;
  }
  function sparkline(values, color) {
    var max = Math.max.apply(null, values), min = Math.min.apply(null, values), span = max - min || 1, n = values.length;
    var pts = values.map(function (v, i) { return (i / (n - 1) * 100).toFixed(1) + ',' + (18 - (v - min) / span * 14).toFixed(1); }).join(' ');
    return raw('<svg width="88" height="22" viewBox="0 0 100 22" preserveAspectRatio="none" aria-hidden="true"><polyline points="' + pts + '" fill="none" stroke="' + color + '" stroke-width="2" vector-effect="non-scaling-stroke"/></svg>');
  }
  function hbar(v, max, color) { return html`<div class="bar" style="min-width:90px"><span style="width:${Math.min(100, v / max * 100).toFixed(1)}%;background:${raw(color || 'var(--ok)')}"></span></div>`; }

  /* ---------- building blocks ---------- */
  function chip(text, cls) { return html`<span class="chip ${cls || ''}">${text}</span>`; }
  var STATUS_CLS = { Synced: 'ok', Healthy: 'ok', Ready: 'ok', healthy: 'ok', active: 'ok', enabled: 'ok', FINISHED: 'ok', Resolved: 'ok',
    OutOfSync: 'warn', Progressing: 'info', degraded: 'warn', Degraded: 'err', Missing: 'err', error: 'err', FAILED: 'err', RUNNING: 'info', 'Not ready': 'err', inactive: '', Unknown: '' };
  function status(text) { return chip(text, 'sm dot ' + (STATUS_CLS[text] || '')); }
  function lifecycleChip(l) { return chip(l, 'sm ' + (l === 'production' ? 'ok' : l === 'experimental' ? 'warn' : '')); }
  function tierChip(t) { return t === 'none' ? chip('None', 'sm') : chip(cap(t), 'sm ' + t); }
  function bandChip(b) { return chip(b, 'sm ' + ({ Elite: 'ok-dark', High: 'info', Medium: 'warn', Low: 'err-dark' }[b])); }
  function card(title, body, extra, sub) {
    return html`<section class="card">${title ? html`<div class="card-head"><h2>${title}${sub ? html`<span class="sub">${sub}</span>` : ''}</h2>${extra || ''}</div>` : ''}${body}</section>`;
  }
  function cardBody(title, body, extra) { return card(title, html`<div class="card-body" style="padding-top:0">${body}</div>`, extra); }
  function statCard(value, label, color, desc) {
    return html`<div class="card stat" style="border-top-color:${raw(color)}"><div class="num" style="color:${raw(color)}">${value}</div><div class="lab">${label}</div>${desc ? html`<div class="desc">${desc}</div>` : ''}</div>`;
  }
  function statCardTop(label, value, color, desc) {
    return html`<div class="card stat" style="border-top-color:${raw(color)}"><div class="lab-top">${label}</div><div class="num" style="color:${raw(color)}">${value}</div>${desc ? html`<div class="desc">${desc}</div>` : ''}</div>`;
  }
  function table(headers, rows, opts) {
    opts = opts || {};
    var numCols = opts.num || [];
    return html`<div class="table-wrap"><table class="${opts.cls || ''}"><thead><tr>${headers.map(function (h, i) {
      return html`<th scope="col" class="${numCols.indexOf(i) >= 0 ? 'num' : ''}">${h}</th>`;
    })}</tr></thead><tbody>${rows.length ? rows.map(function (r) {
      return html`<tr>${r.map(function (c, i) { return html`<td class="${numCols.indexOf(i) >= 0 ? 'num' : ''}">${c}</td>`; })}</tr>`;
    }) : html`<tr><td colspan="${headers.length}" class="empty-row">${opts.empty || 'No records to display'}</td></tr>`}</tbody></table></div>`;
  }
  function pluginBar(label, ic) { return html`<div class="plugin-bar"><span class="pb-icon">${icon(ic || 'widgets', 20)}</span><span>${label}</span></div>`; }
  function header(theme, title, subtitle, right) {
    return html`<header class="header ${theme}"><div style="min-width:0"><h1>${title}</h1>${subtitle ? html`<div class="subtitle">${subtitle}</div>` : ''}</div>${right || ''}</header>`;
  }
  // A custom-pages plugin page: breadcrumb bar + themed Header + content.
  function customPage(theme, title, subtitle, body, right) {
    return html`${pluginBar('custom-pages')}${header(theme, title, subtitle, right)}<div class="content">${body}</div>`;
  }
  function demoChip() { return chip('Demo data', 'sm warn'); }
  function chipButtons(key, options, cur, cls) {
    return html`<div class="btn-row" role="group">${options.map(function (o) {
      var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
      return html`<button type="button" class="chip ${cls || ''}" data-action="set" data-key="${key}" data-value="${v}" aria-pressed="${String(cur === v)}">${l}</button>`;
    })}</div>`;
  }
  function selectField(label, id, key, options, cur, allLabel) {
    return html`<div class="field"><label for="${id}">${label}</label><select class="input" id="${id}" data-bind="${key}">
      ${allLabel != null ? html`<option value="">${allLabel}</option>` : ''}${options.map(function (o) {
        var v = Array.isArray(o) ? o[0] : o, l = Array.isArray(o) ? o[1] : o;
        return html`<option value="${v}" ${v === cur ? raw('selected') : ''}>${l}</option>`;
      })}</select></div>`;
  }

  /* ---------- catalog model ---------- */
  var TEAM_TAGS = { 'platform-team': ['platform', 'kubernetes', 'golden-path'], 'ml-team': ['ml', 'ai'], 'backend-team': ['backend', 'go', 'nodejs', 'python'], 'data-team': ['data'],
    'frontend-team': ['frontend', 'react', 'typescript', 'web'], 'android-team': ['android', 'mobile', 'kotlin'], 'ios-team': ['ios', 'mobile', 'swift'], 'qa-team': ['qa', 'testing'] };
  function team(name) {
    if (name === 'qa-platform-team') name = 'qa-team';
    return D.teams.filter(function (t) { return t.name === name; })[0];
  }
  function comp(name) { return D.components.filter(function (c) { return c.name === name; })[0]; }
  function tpl(name) { return D.templates.filter(function (t) { return t.n === name; })[0]; }
  function api(name) { return D.apis.filter(function (a) { return a.name === name; })[0]; }
  function entityHref(kind, name) { return '#/catalog/default/' + kind.toLowerCase() + '/' + encodeURIComponent(name); }
  function ownerLink(owner) {
    var t = team(owner);
    return html`<a class="cell-link" style="font-weight:400" href="${entityHref('group', t ? t.name : owner)}">${icon('group', 16)}${t ? t.display : owner}</a>`;
  }
  function systemLink(sys) { return sys ? html`<a class="cell-link" style="font-weight:400" href="${entityHref('system', sys)}">${icon('category', 16)}${sys.replace(/-/g, ' ').replace(/\b\w/g, function (c) { return c.toUpperCase(); })}</a>` : ''; }
  // Annotation-derived flags, standing in for entityFilters.ts.
  function flags(c) {
    var deployed = c.replicas > 0;
    return {
      deployed: deployed,
      scorecard: c.type !== 'library',
      security: c.score >= 8,
      pagerduty: deployed && c.lifecycle === 'production' && (c.system === 'commerce' || c.name === 'hello-service' || c.name === 'idp-mcp-server'),
      grafana: deployed,
      jira: c.system === 'commerce' || c.system === 'data-platform' || c.name === 'hello-service',
      langfuse: !!c.ai && c.type === 'service',
      lambdatest: c.type === 'mobile' || c.tags.some(function (t) { return ['mobile', 'e2e', 'appium', 'playwright', 'devicefarm'].indexOf(t) >= 0; }),
      slo: deployed || !!c.slo,
      adrs: c.name === 'hello-service' || c.name === 'idp-mcp-server'
    };
  }
  function entityTabs(c) {
    var f = flags(c), t = [['', 'Overview'], ['docs', 'TechDocs'], ['apis', 'APIs']];
    if (f.deployed) t.push(['kubernetes', 'Kubernetes']);
    if (f.langfuse) t.push(['langfuse', 'Langfuse']);
    if (f.deployed) t.push(['dora', 'DORA']);
    if (f.scorecard) t.push(['scorecard', 'Scorecard']);
    if (f.security) t.push(['security', 'Security']);
    if (f.deployed) t.push(['datadog', 'Datadog']);
    if (f.lambdatest) t.push(['lambdatest', 'LambdaTest']);
    if (f.deployed) t.push(['trivy', 'Trivy']);
    if (f.pagerduty) t.push(['on-call', 'On-Call']);
    if (f.deployed || f.pagerduty) t.push(['incidents', 'Incidents']);
    if (f.grafana) t.push(['grafana', 'Grafana']);
    if (f.jira) t.push(['jira', 'Jira']);
    if (f.slo) t.push(['slo', 'SLOs']);
    t.push(['github-actions', 'GitHub Actions']);
    if (f.adrs) t.push(['adrs', 'ADRs']);
    return t;
  }
  function catalogEntities() {
    var out = [];
    D.components.forEach(function (c) { out.push({ kind: 'Component', name: c.name, type: c.type, owner: c.owner, system: c.system, lifecycle: c.lifecycle, desc: c.desc, tags: c.tags }); });
    D.apis.forEach(function (a) { out.push({ kind: 'API', name: a.name, type: a.type, owner: a.owner, system: a.system, lifecycle: 'production', desc: a.desc, tags: [a.type] }); });
    D.teams.forEach(function (t) { out.push({ kind: 'Group', name: t.name, title: t.display, type: 'team', owner: '', system: '', lifecycle: '', desc: t.mission, tags: TEAM_TAGS[t.name] || [] }); });
    D.systems.forEach(function (s) { out.push({ kind: 'System', name: s.name, type: '', owner: s.owner, system: '', lifecycle: '', desc: s.desc, tags: [] }); });
    D.resources.forEach(function (r) { out.push({ kind: 'Resource', name: r.name, type: r.kind.toLowerCase(), owner: r.owner, system: r.system, lifecycle: 'production', desc: r.desc, tags: ['crossplane'] }); });
    D.templates.forEach(function (t) { out.push({ kind: 'Template', name: t.n, title: t.t, type: t.type, owner: t.o, system: '', lifecycle: '', desc: t.d, tags: t.tags }); });
    return out;
  }
  // Scorecard (scorecard.ts): visible checks, pass/fail and tier.
  var REMEDIATION = {
    'has-owner': 'Set spec.owner in catalog-info.yaml.', 'has-techdocs': 'Add annotation backstage.io/techdocs-ref: dir:.',
    'has-health-probes': 'Add annotation backstage.io/kubernetes-id (the Helm chart wires the probes).', 'has-runbook-url': 'Add annotation backstage.io/runbook-url linking to your service runbook.',
    'has-api-definition': 'Declare providesApis in catalog-info.yaml or expose /openapi.json.', 'uses-pinned-image-tag': 'Set annotation backstage.io/image-tag to a SHA or version; avoid latest.',
    'has-coverage-gate': 'Add "coverage" to idp.io/quality-gates annotation (skeleton CI already enforces 70%).', 'has-static-analysis': 'Add "static-analysis" to idp.io/quality-gates annotation.',
    'has-vuln-scan': 'Add "vuln-scan" to idp.io/quality-gates annotation.', 'has-contract-tests': 'Run the enable-contract-testing scaffolder template, or add "contract" to idp.io/quality-gates.',
    'has-e2e-tests': 'Run the playwright-e2e-suite scaffolder, or tag the entity with e2e/playwright.', 'has-model-card': 'Add annotation backstage.io/model-card-url documenting the model, its training data, and performance.',
    'has-eval-suite': 'Add "llm-eval" to idp.io/quality-gates and run the deepeval-llm-eval-suite scaffolder.', 'has-ai-observability': 'Add annotation backstage.io/kubernetes-id to enable Grafana dashboards.',
    'has-litellm-virtual-key': 'Run the ai-agent-kagent template with "Provision LiteLLM virtual key" enabled (ADR-0008).', 'has-budget-configured': 'Set annotation idp.io/litellm-budget-usd to your agreed monthly LLM spend ceiling.',
    'has-sonar-scanning': 'Run the enable-security-scanning scaffolder, or add a sonarcloud.io/project-key annotation.', 'has-snyk-scanning': 'Run the enable-security-scanning scaffolder, or add a snyk.io/org-slug annotation.',
    'has-trivy-scanning': 'See the Trivy tab — requires a github.com/project-slug annotation and CI to have run at least once.', 'has-code-signing': 'Run the mobile-code-signing scaffolder, then set annotation backstage.io/code-signing-setup: "true".',
    'has-min-sdk-version': 'Set annotation backstage.io/mobile-min-sdk — Android API ≥24, or iOS ≥16.0.', 'has-accessibility-tests': 'Run the accessibility-suite scaffolder, then set annotation backstage.io/accessibility-tests: "true".',
    'has-crashlytics-enabled': 'Wire up Firebase Crashlytics or Sentry, then set annotation backstage.io/crashlytics-enabled: "true".', 'has-app-size-budget': 'Set annotation backstage.io/app-size-budget-mb to your agreed binary size ceiling.'
  };
  function visibleChecks(e) { return D.checks.filter(function (c) { return !c[3] || (c[3] === 'ai' && e.ai) || (c[3] === 'mobile' && e.type === 'mobile'); }); }
  function checkResults(e) {
    var vis = visibleChecks(e), r = rng('checks:' + e.name);
    var order = vis.slice(1).map(function (c) { return [r(), c]; }).sort(function (a, b) { return a[0] - b[0]; }).map(function (x) { return x[1]; });
    order.unshift(vis[0]);
    var pass = {};
    order.forEach(function (c, i) { pass[c[0]] = i < e.score; });
    return { checks: vis, pass: pass, count: Math.min(e.score, vis.length), firstFail: order[Math.min(e.score, order.length - 1)] };
  }
  function tierOf(e) {
    var th = e.ai ? D.tierThresholds.ai : D.tierThresholds.std, n = checkResults(e).count;
    return n >= th.gold ? 'gold' : n >= th.silver ? 'silver' : n >= th.bronze ? 'bronze' : 'none';
  }
  function doraBand(metric, v) {
    var t = { df: [1, 1 / 7, 1 / 30], lt: [24, 168, 720], cfr: [5, 10, 15], mttr: [60, 1440, 10080] }[metric];
    var lv = metric === 'df' ? (v >= t[0] ? 0 : v >= t[1] ? 1 : v >= t[2] ? 2 : 3) : (v <= t[0] ? 0 : v <= t[1] ? 1 : v <= t[2] ? 2 : 3);
    return ['Elite', 'High', 'Medium', 'Low'][lv];
  }
  function overallBand(c) {
    var order = ['Elite', 'High', 'Medium', 'Low'];
    var worst = Math.max(order.indexOf(doraBand('df', c.dora.df)), order.indexOf(doraBand('lt', c.dora.lt)), order.indexOf(doraBand('cfr', c.dora.cfr)), order.indexOf(doraBand('mttr', c.dora.mttr)));
    return order[worst];
  }
  var BUDGET_OVERRIDE = { 'orders-service': 0.14, 'inventory-service': 0.03, 'notifications-service': 0.41, 'payments-api': 0.62 };
  function sloRows(c) {
    if (!c.slo) return [];
    var r = rng('slo:' + c.name), rem = BUDGET_OVERRIDE[c.name] != null ? BUDGET_OVERRIDE[c.name] : 0.45 + r() * 0.5;
    var lrem = Math.max(0, Math.min(1, rem + (r() - 0.4) * 0.3));
    return [{ slo: 'Requests Latency', obj: c.slo.latency, rem: lrem }, { slo: 'Requests Availability', obj: c.slo.avail, rem: rem }];
  }
  function sloStatus(rem) { return rem < 0.2 ? chip('At risk', 'sm err') : rem < 0.5 ? chip('Warning', 'sm warn') : chip('Healthy', 'sm ok'); }

  /* ---------- state ---------- */
  var S = {
    cat: { kind: 'Component', type: '', personal: 'all', owner: '', lifecycle: '', tag: '', q: '' },
    apiCat: { type: '', personal: 'all', owner: '', lifecycle: '', q: '' },
    starred: {},
    tplf: { q: '', cat: '', tag: '', owner: '', starred: false },
    forms: {},
    tasks: {},
    taskOrder: [],
    showLogs: true,
    chat: [], chatDraft: '', agent: 'platform-assistant', showHistory: false, pending: null,
    approvals: D.approvals.map(function (a, i) { return Object.assign({ status: 'pending', requested: ago([4, 11, 26, 60][i] || 5) }, a); }).concat([
      { id: 'APR-301', agent: 'release-agent', tool: 'sync_app', target: 'hello-service-staging', reason: 'Phase 9 verification of the HiTL gate', status: 'approved', decided_by: 'policy:auto-approve', requested: ago(2900), decided: ago(2900) },
      { id: 'APR-298', agent: 'qa-assistant', tool: 'add_pr_comment', target: 'checkout-web#402', reason: 'Post k6 results on the PR', status: 'denied', decided_by: 'Jordan Blake', requested: ago(4300), decided: ago(4290) }]),
    approvalsFilter: 'pending',
    finops: { range: 'week', by: 'namespace' },
    incFilter: 'All',
    activityFilter: 'All',
    scoreSort: 'score',
    synced: {},
    learning: { level: '', type: '', topic: '' },
    done: {},
    calc: { svc: 'web', cpu: '500', mem: '512', replicas: '2', ai: '10000', env: 'production' },
    onboarding: 0, displayName: 'Alex Rivera',
    survey: {}, surveyTeam: 'platform-team', surveySent: false,
    aiQuery: 'how do I roll back a deployment',
    searchQ: 'payments', searchType: 'all',
    apiOpen: null, apiQ: '',
    copilotRepo: '',
    settingsTab: 'general',
    importStep: 0, importUrl: 'https://github.com/moatazeldebsy/loyalty-points/blob/main/catalog-info.yaml',
    docSearch: ''
  };
  try { var sd = JSON.parse(localStorage.getItem('idp-demo-learning') || 'null'); if (sd) S.done = sd; } catch (e) { /* storage unavailable */ }

  /* ---------- navigation (Sidebar.tsx) ---------- */
  // Every page that has a title + icon becomes a nav item; Home, Catalog and
  // Create are pinned, the rest sort by title (localeCompare), Settings sits at the bottom.
  var PINNED = [
    { path: '', title: 'Home', icon: 'dashboard' },
    { path: 'catalog', title: 'Catalog', icon: 'home' },
    { path: 'create', title: 'Create', icon: 'add' }
  ];
  var REST = [
    ['activity', 'Activity', 'feed'], ['admin', 'Admin', 'admin'], ['approvals', 'Agent Approvals', 'gavel'], ['ai-assistant', 'AI Assistant', 'chat'],
    ['langfuse', 'AI Observability', 'timeline'], ['ai-search', 'AI Search', 'search'], ['announcements', 'Announcements', 'campaign'], ['apis', 'API Explorer', 'tree'],
    ['api-docs', 'APIs', 'extension'], ['argocd', 'ArgoCD', 'tree'], ['copilot', 'Copilot Metrics', 'money'], ['calculator', 'Cost Calc', 'calc'],
    ['finops', 'Cost Overview', 'money'], ['devex-survey', 'DevEx Survey', 'feedback'], ['docs', 'Docs', 'docs'], ['dora', 'DORA', 'trending'],
    ['core4', 'DX Core 4', 'dashboard'], ['engineering-intelligence', 'Engineering Intelligence', 'insights'], ['incidents', 'Incidents', 'warning'],
    ['kagent', 'KAgent', 'bot'], ['learning-center', 'Learning Center', 'school'], ['litellm-spend', 'LiteLLM Spend', 'key'], ['mlflow', 'MLflow', 'science'],
    ['profile', 'My Profile', 'person'], ['onboarding', 'Onboarding', 'wave'], ['catalog-import', 'Register Existing Component', 'add'],
    ['scorecard', 'Scorecard', 'trophy'], ['search-page', 'Search', 'search'], ['slo', 'SLOs', 'target'], ['support', 'Support', 'help'], ['tech-radar', 'Tech Radar', 'radar']
  ].map(function (r) { return { path: r[0], title: r[1], icon: r[2] }; }).sort(function (a, b) { return a.title.localeCompare(b.title); });
  var NAV_ALL = PINNED.concat(REST).concat([{ path: 'settings', title: 'Settings', icon: 'gear' }]);

  function parts() { return location.hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(function (p) { try { return decodeURIComponent(p); } catch (e) { return p; } }); }
  function current() { return parts()[0] || ''; }
  function navItem(it, cur) {
    return html`<a class="nav-item" href="#/${it.path}" ${it.path === cur ? raw('aria-current="page"') : ''}>${icon(it.icon)}<span>${it.title}</span></a>`;
  }
  function renderSidebar() {
    var cur = current();
    if (cur === 'catalog' && parts()[1]) cur = 'catalog';
    if (cur === 'search') cur = '__search';
    $('#sidebar').innerHTML = html`<a class="logo" href="#/">${LOGO}<span>Backstage</span></a>
      <button type="button" class="nav-item" data-action="open-search" ${cur === '__search' ? raw('aria-current="page"') : ''}>${icon('search')}<span>Search</span></button>
      <div class="nav-divider"></div>
      ${navItem(PINNED[0], cur)}
      <div class="nav-divider"></div>
      ${navItem(PINNED[1], cur)}${navItem(PINNED[2], cur)}
      <div class="nav-divider"></div>
      <div class="nav-scroll">${REST.map(function (it) { return navItem(it, cur); })}</div>
      <div class="nav-divider"></div>
      ${navItem(NAV_ALL[NAV_ALL.length - 1], cur)}`.s;
  }

  /* ---------- Home (Platform Dashboard) ---------- */
  var ORG_DORA = { df: 41, lt: 6.2, cfr: 6.4, mttr: 38 };
  function doraCards(d, seed) {
    var cards = [['DEPLOY FREQUENCY', num(d.df, 1) + '/day', 'deploys/day', doraBand('df', d.df), 'df'], ['LEAD TIME', hours(d.lt), 'commit → deploy', doraBand('lt', d.lt), 'lt'],
      ['CHANGE FAILURE RATE', pct(d.cfr), '% of deploys', doraBand('cfr', d.cfr), 'cfr'], ['MTTR', dur(d.mttr), 'time to restore', doraBand('mttr', d.mttr), 'mttr']];
    return html`<div class="grid g4">${cards.map(function (c) {
      var col = c[3] === 'Elite' ? 'var(--ok-dark)' : c[3] === 'Low' ? 'var(--err-dark)' : c[3] === 'High' ? 'var(--info)' : 'var(--warn-dark)';
      return html`<div class="card dora-card"><div class="lab">${c[0]}</div><div class="row"><div class="val">${c[1]}</div>${sparkline(series(seed + c[4], 12, 10, 3, c[4] === 'df' ? 0.3 : -0.2), col)}</div>
        <div class="foot">${bandChip(c[3])}<span>${c[2]}</span></div></div>`;
    })}</div>`;
  }
  function pageHome() {
    return html`${pluginBar('custom-pages')}${header('home', 'Platform Dashboard', 'Internal Developer Platform · platform-wide overview')}
      <div class="content">
        <div class="grid g3">${statCard(D.components.length, 'Services in catalog', '#1976d2')}${statCard(D.apis.length, 'APIs in catalog', '#43a047')}${statCard(D.teams.length, 'Teams in catalog', '#8e24aa')}</div>
        <h2 class="section-title" style="margin-top:28px">Platform DORA</h2>
        ${doraCards(ORG_DORA, 'home')}
        <div style="display:flex;align-items:center;justify-content:space-between;margin:28px 0 14px"><h2 class="section-title" style="margin:0">Services</h2><a class="btn outlined" href="#/create">Create</a></div>
        <div class="card">${table(['Name', 'Owner', 'Type', 'Lifecycle'], D.components.map(function (c) {
          return [html`<a href="${entityHref('component', c.name)}"><strong>${c.name}</strong></a>`, 'group:default/' + c.owner, c.type, lifecycleChip(c.lifecycle)];
        }))}</div>
      </div>`;
  }

  /* ---------- Catalog (stock catalog plugin) ---------- */
  function userFilter(stateKey, ownedCount, starredCount, allCount, cur) {
    return html`<div class="user-filter"><div class="uf-title">Personal</div>
      <button type="button" class="uf-item" data-action="set" data-key="${stateKey}.personal" data-value="owned" aria-pressed="${String(cur === 'owned')}"><span>${icon('gear', 20)} Owned</span><span>${ownedCount}</span></button>
      <button type="button" class="uf-item" data-action="set" data-key="${stateKey}.personal" data-value="starred" aria-pressed="${String(cur === 'starred')}"><span>${icon('star', 20)} Starred</span><span>${starredCount}</span></button>
      <div class="uf-title" style="margin-top:14px">My Organization</div>
      <button type="button" class="uf-item" data-action="set" data-key="${stateKey}.personal" data-value="all" aria-pressed="${String(cur === 'all')}"><span>All</span><span>${allCount}</span></button></div>`;
  }
  function actionsCell(e) {
    var key = e.kind + ':' + e.name, on = !!S.starred[key];
    return html`<div class="actions"><a class="icon-btn" href="${e.kind === 'Template' ? '#/create/templates/default/' + e.name : entityHref(e.kind, e.name)}" aria-label="${'View ' + e.name}" title="View">${icon('open', 20)}</a>
      <span class="icon-btn" aria-hidden="true" title="Edit (opens the source repo in the live portal)" style="opacity:.5">${icon('edit', 20)}</span>
      <button type="button" class="icon-btn ${on ? 'on' : ''}" data-action="star" data-key="${key}" aria-pressed="${String(on)}" aria-label="${(on ? 'Remove ' : 'Add ') + e.name + (on ? ' from' : ' to') + ' favorites'}">${icon(on ? 'star' : 'starO', 20)}</button></div>`;
  }
  function entityIcon(kind) { return { Component: 'wrench', API: 'extension', Group: 'group', System: 'category', Resource: 'widgets', Template: 'library' }[kind] || 'widgets'; }
  function pageCatalog() {
    var f = S.cat, all = catalogEntities().filter(function (e) { return e.kind === f.kind; });
    var mine = all.filter(function (e) { return e.owner === D.user.team || (e.kind === 'Group' && e.name === D.user.team); });
    var starred = all.filter(function (e) { return S.starred[e.kind + ':' + e.name]; });
    var base = f.personal === 'owned' ? mine : f.personal === 'starred' ? starred : all;
    var types = [], owners = [], lifecycles = [], tags = [];
    all.forEach(function (e) {
      if (e.type && types.indexOf(e.type) < 0) types.push(e.type);
      if (e.owner && owners.indexOf(e.owner) < 0) owners.push(e.owner);
      if (e.lifecycle && lifecycles.indexOf(e.lifecycle) < 0) lifecycles.push(e.lifecycle);
      e.tags.forEach(function (t) { if (tags.indexOf(t) < 0) tags.push(t); });
    });
    var q = f.q.toLowerCase();
    var rows = base.filter(function (e) {
      return (!f.type || e.type === f.type) && (!f.owner || e.owner === f.owner) && (!f.lifecycle || e.lifecycle === f.lifecycle) && (!f.tag || e.tags.indexOf(f.tag) >= 0) &&
        (!q || (e.name + ' ' + (e.title || '') + ' ' + e.desc + ' ' + e.tags.join(' ')).toLowerCase().indexOf(q) >= 0);
    });
    var kindLabel = { Component: 'Components', API: 'APIs', Group: 'Groups', System: 'Systems', Resource: 'Resources', Template: 'Templates' }[f.kind];
    var cols, cells;
    if (f.kind === 'Group') {
      cols = ['Name', 'Type', 'Description', 'Tags', 'Actions'];
      cells = function (e) { return [html`<a class="cell-link" href="${entityHref('group', e.name)}">${icon('group', 18)}${e.title}</a>`, e.type, html`<span class="clamp">${e.desc}</span>`, tagChips(e.tags), actionsCell(e)]; };
    } else {
      cols = ['Name', 'System', 'Owner', 'Type', 'Lifecycle', 'Description', 'Tags', 'Actions'];
      cells = function (e) {
        return [html`<a class="cell-link" href="${e.kind === 'Template' ? '#/create/templates/default/' + e.name : entityHref(e.kind, e.name)}">${icon(entityIcon(e.kind), 16)}${e.name}</a>`, systemLink(e.system), e.owner ? ownerLink(e.owner) : '', e.type, e.lifecycle,
          html`<span class="clamp" title="${e.desc}">${e.desc}</span>`, tagChips(e.tags), actionsCell(e)];
      };
    }
    return html`${pluginBar('Catalog', 'home')}<div class="content">
      <div class="page-title"><h1>My Organization Catalog</h1><a class="btn contained" href="#/create">Create</a></div>
      <div class="catalog-layout">
        <div class="filters">
          ${selectField('Kind', 'f-kind', 'cat.kind', ['Component', 'API', 'Group', 'System', 'Resource', 'Template'], f.kind)}
          ${selectField('Type', 'f-type', 'cat.type', types.sort(), f.type, 'all')}
          ${userFilter('cat', mine.length, starred.length, all.length, f.personal)}
          ${owners.length ? selectField('Owner', 'f-owner', 'cat.owner', owners.sort().map(function (o) { var t = team(o); return [o, t ? t.display : o]; }), f.owner, '') : ''}
          ${lifecycles.length ? selectField('Lifecycle', 'f-life', 'cat.lifecycle', lifecycles.sort(), f.lifecycle, '') : ''}
          ${selectField('Tags', 'f-tag', 'cat.tag', tags.sort(), f.tag, '')}
        </div>
        <section class="card">
          <div class="card-head"><h2>All ${kindLabel} (${rows.length})</h2>
            <div class="underline-search">${icon('search', 22)}<label class="sr-only" for="cat-q">Search</label><input id="cat-q" type="search" placeholder="Search" value="${f.q}" data-bind="cat.q">
              ${f.q ? html`<button type="button" class="icon-btn sm" data-action="set" data-key="cat.q" data-value="" aria-label="Clear search">${icon('clear', 20)}</button>` : ''}</div></div>
          ${table(cols, rows.map(cells), { cls: 'bs' })}
        </section>
      </div></div>`;
  }
  function tagChips(tags) { return html`<div style="max-width:160px">${tags.map(function (t) { return chip(t, 'sm outlined'); })}</div>`; }

  /* ---------- Entity pages ---------- */
  function entityHeader(theme, kindLine, name, meta, starKey) {
    var on = !!S.starred[starKey];
    return html`<header class="header ${theme}"><div style="min-width:0"><div class="overline">${kindLine}</div>
        <div class="title-row"><h1>${name}</h1><button type="button" class="star" data-action="star" data-key="${starKey}" aria-pressed="${String(on)}" aria-label="${on ? 'Remove from favorites' : 'Add to favorites'}">${icon(on ? 'star' : 'starO', 30)}</button></div></div>
      <div class="header-meta">${meta}<span class="icon-btn" style="color:#fff" aria-hidden="true">${icon('more')}</span></div></header>`;
  }
  function metaItem(label, value) { return html`<dl><dt>${label}</dt><dd>${value}</dd></dl>`; }
  function entityTabsNav(base, list, cur) {
    return html`<nav class="tabs" aria-label="Entity tabs">${list.map(function (t) {
      return html`<a href="${base + (t[0] ? '/' + t[0] : '')}" ${t[0] === cur ? raw('aria-current="page"') : ''}>${t[1]}</a>`;
    })}</nav>`;
  }
  function pageEntity(kind, name, tab) {
    kind = (kind || '').toLowerCase();
    tab = tab || '';
    if (kind === 'component') return pageComponent(name, tab);
    if (kind === 'group') return pageGroup(name, tab);
    if (kind === 'api') return pageApiEntity(name, tab);
    if (kind === 'system' || kind === 'resource') return pageSimpleEntity(kind, name, tab);
    return notFound();
  }
  function pageComponent(name, tab) {
    var c = comp(name);
    if (!c) return notFound('Entity was not found');
    var tabsList = entityTabs(c), t = tabsList.filter(function (x) { return x[0] === tab; })[0];
    if (!t) return notFound('This entity has no "' + tab + '" tab.');
    var tm = team(c.owner), base = entityHref('component', c.name);
    return html`${entityHeader('service', 'Component — ' + c.type, c.name, html`${metaItem('Owner', html`${icon('group', 16)}${tm ? tm.display : c.owner}`)}${metaItem('Lifecycle', c.lifecycle)}`, 'Component:' + c.name)}
      ${entityTabsNav(base, tabsList, tab)}<div class="content">${TAB[tab || 'overview'](c)}</div>`;
  }
  function aboutCard(e, fields, links) {
    return html`<section class="card"><div class="card-head"><h2>About</h2><div class="btn-row"><span class="icon-btn sm" aria-hidden="true">${icon('refresh', 20)}</span><span class="icon-btn sm" aria-hidden="true">${icon('edit', 20)}</span></div></div>
      <div class="card-divider"></div>
      <div class="about-links">${links.map(function (l) { return l[1] ? html`<a href="${l[1]}">${icon(l[2], 22)}${l[0]}</a>` : html`<span>${icon(l[2], 22)}${l[0]}</span>`; })}</div>
      <div class="card-body about"><dl style="margin:0"><dt>Description</dt><dd>${e.desc}</dd></dl><div class="about-grid">${fields.map(function (f) { return html`<dl style="margin:0"><dt>${f[0]}</dt><dd>${f[1] || html`<span class="muted">No ${f[0].toLowerCase()}</span>`}</dd></dl>`; })}</div></div></section>`;
  }
  function relationsGraph(center, nodes) {
    // nodes: [{label, kind, rel}] arranged around the center node.
    var W = 620, H = 300, cx = W / 2, cy = H / 2, s = '';
    var n = nodes.length;
    nodes.forEach(function (nd, i) {
      var a = (i / n) * Math.PI * 2 - Math.PI / 2, x = cx + Math.cos(a) * 225, y = cy + Math.sin(a) * 110;
      s += '<line x1="' + cx + '" y1="' + cy + '" x2="' + x.toFixed(0) + '" y2="' + y.toFixed(0) + '" stroke="var(--text-3)" stroke-width="1"/>';
      s += '<text x="' + ((cx + x) / 2).toFixed(0) + '" y="' + ((cy + y) / 2 - 4).toFixed(0) + '" text-anchor="middle" style="font-size:9px">' + esc(nd.rel) + '</text>';
      s += '<g><rect x="' + (x - 78).toFixed(0) + '" y="' + (y - 14).toFixed(0) + '" width="156" height="28" rx="14" fill="var(--paper)" stroke="var(--divider)"/><text x="' + x.toFixed(0) + '" y="' + (y + 4).toFixed(0) + '" text-anchor="middle" style="font-size:11px;fill:var(--text)">' + esc(nd.kind + ':' + nd.label) + '</text></g>';
    });
    s += '<rect x="' + (cx - 86) + '" y="' + (cy - 16) + '" width="172" height="32" rx="16" fill="var(--primary)"/><text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" style="font-size:12px;font-weight:700;fill:var(--primary-contrast)">' + esc(center) + '</text>';
    return html`<div class="graph-box"><svg class="chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="${'Relations of ' + center}">${raw(s)}</svg></div>`;
  }
  var TAB = {
    overview: function (c) {
      var nodes = [{ label: c.owner, kind: 'group', rel: 'ownedBy' }, { label: c.system, kind: 'system', rel: 'partOf' }];
      (c.apis || []).forEach(function (a) { nodes.push({ label: a, kind: 'api', rel: 'providesApi' }); });
      D.resources.filter(function (r) { return r.owner === c.owner && r.system === c.system; }).slice(0, 2).forEach(function (r) { nodes.push({ label: r.name, kind: 'resource', rel: 'dependsOn' }); });
      return html`<div class="grid g2">
        ${aboutCard(c, [['Owner', ownerLink(c.owner)], ['System', systemLink(c.system)], ['Type', c.type], ['Lifecycle', c.lifecycle], ['Tags', html`${c.tags.map(function (t) { return chip(t, 'sm'); })}`]],
          [['View Source', null, 'code'], ['View TechDocs', entityHref('component', c.name) + '/docs', 'docs']])}
        ${card('Relations', html`<div class="card-body" style="padding-top:0">${relationsGraph(c.name, nodes)}</div>`)}
      </div>
      <div class="grid g2 mt">
        ${card('Links', html`<div class="card-body" style="padding-top:0">${[['Repository', 'github.com/moatazeldebsy/' + c.name], ['Runbook', 'docs/runbooks/pod-crash-loop.md'], ['Grafana', 'grafana.idp.local/d/idp-services?var-service=' + c.name]].map(function (l) {
          return html`<div class="list-row" style="padding:10px 0">${icon('open', 18)}<div><strong>${l[0]}</strong><div class="muted small">${l[1]}</div></div></div>`;
        })}</div>`)}
        ${card('Has subcomponents', table(['Name', 'Owner', 'Type', 'Lifecycle', 'Description'], [], { empty: 'No subcomponent is part of this component' }))}
      </div>`;
    },
    docs: function (c) { return docsReader(c.name, 'component', null, true); },
    apis: function (c) {
      var provided = (c.apis || []).map(api).filter(Boolean);
      var consumed = D.apis.filter(function (a) { return a.provider !== c.name && (hash(c.name + a.name) % 4 === 0); });
      function rows(list) { return list.map(function (a) { return [html`<a class="cell-link" href="${entityHref('api', a.name)}">${icon('extension', 16)}${a.name}</a>`, systemLink(a.system), ownerLink(a.owner), a.type, 'production', a.desc]; }); }
      return html`${card('Provided APIs', table(['Name', 'System', 'Owner', 'Type', 'Lifecycle', 'Description'], rows(provided), { cls: 'bs', empty: 'This component does not provide any APIs.' }))}
        <div class="mt">${card('Consumed APIs', table(['Name', 'System', 'Owner', 'Type', 'Lifecycle', 'Description'], rows(consumed), { cls: 'bs', empty: 'This component does not consume any APIs.' }))}</div>`;
    },
    kubernetes: function (c) {
      var bad = c.name === 'inventory-service', r = rng('k8s:' + c.name), pods = [];
      for (var i = 0; i < c.replicas; i++) pods.push([html`<span class="mono">${c.name}-${hash(c.name).toString(16).slice(0, 9)}-${hash(c.name + i).toString(36).slice(0, 5)}</span>`, bad ? 'Running' : 'Running', bad ? '0/1' : '1/1', bad ? 7 + i : Math.floor(r() * 2), bad ? chip('CrashLoopBackOff', 'sm err') : chip('OK', 'sm ok'), Math.floor(5 + r() * 40) + '%', Math.floor(20 + r() * 50) + '%']);
      return html`<section class="card"><div class="card-head"><div><div class="muted small">CLUSTER</div><h2>local-kind</h2></div>${bad ? chip('1 pod with errors', 'err') : chip('No pods with errors', 'ok')}</div>
        <div class="card-divider"></div><div class="card-body">
          <h3 style="font-size:16px;margin-bottom:4px">${c.name}</h3><div class="muted small" style="margin-bottom:12px">Deployment · namespace services-dev · ${c.replicas} pods</div>
          ${table(['ID', 'Phase', 'Containers ready', 'Total restarts', 'Status', 'CPU usage %', 'Memory usage %'], pods, { num: [3, 5, 6] })}
          <div class="muted small" style="margin-top:12px">HorizontalPodAutoscaler: min ${c.replicas}, max ${c.replicas * 3}, target CPU 70% · PodDisruptionBudget: minAvailable 1</div>
        </div></section>`;
    },
    langfuse: function (c) {
      var r = rng('lf:' + c.name), rows = [];
      for (var i = 0; i < 6; i++) rows.push([html`<span class="mono">${hash(c.name + i).toString(16).slice(0, 8)}</span>`, ['chat.completion', 'tool.call', 'agent.turn'][i % 3], i % 2 ? 'user:default/arivera' : '—', num(0.8 + r() * 5, 1) + 's', money(0.001 + r() * 0.02, 4), (i * 7 + 2) + ' min ago']);
      return html`<div class="grid g3">${statCardTop('Traces', num(120 + Math.floor(r() * 900)), '#1976d2', 'last 7 days')}${statCardTop('LLM Cost', money(4 + r() * 30), '#8e24aa', 'last 7 days')}${statCardTop('Avg latency', num(1 + r() * 3, 1) + 's', '#f57c00', 'p50')}</div>
        <div class="mt">${card('Recent traces', table(['Trace', 'Operation', 'User', 'Latency', 'Cost', 'When'], rows))}</div>
        <p class="muted small mt16">Traces are matched on <code>langfuse.com/service-name: ${c.name}</code>.</p>`;
    },
    dora: function (c) {
      return html`${doraCards(c.dora, 'e:' + c.name)}
        <div class="mt">${card('Performance Bands', table(['Metric', 'Elite', 'High', 'Medium', 'Low'], [
          ['Deploy Frequency', '≥ 1/day', '≥ 1/week', '≥ 1/month', '< 1/month'], ['Lead Time', '< 1 day', '< 1 week', '< 1 month', '≥ 1 month'],
          ['Change Failure Rate', '≤ 5%', '≤ 10%', '≤ 15%', '> 15%'], ['MTTR', '< 1 hour', '< 1 day', '< 1 week', '≥ 1 week']]))}</div>`;
    },
    scorecard: function (c) {
      var cr = checkResults(c), th = c.ai ? D.tierThresholds.ai : D.tierThresholds.std, t = tierOf(c);
      var col = { gold: 'var(--gold)', silver: 'var(--silver)', bronze: 'var(--bronze)', none: 'var(--text-3)' }[t];
      var msg = { gold: '🎉 Gold tier — full shift-left adoption. Consider mutation testing next.', silver: 'Silver tier — add contract and end-to-end tests to reach Gold.', bronze: 'Bronze tier — wire coverage, static analysis and vuln scanning into CI next.', none: 'No tier yet — start with ownership, TechDocs and probes.' }[t];
      var groups = [];
      cr.checks.forEach(function (ch) { if (groups.indexOf(ch[1]) < 0) groups.push(ch[1]); });
      return html`<div style="display:flex;gap:20px;align-items:center;margin-bottom:12px"><div class="tier-badge" style="background:${raw(col)}">${icon('trophy', 44)}</div>
          <div><h2 style="font-size:28px">${t === 'none' ? 'No tier' : cap(t) + ' tier'}</h2><div style="font-size:16px;color:var(--text-2)">${cr.count} of ${cr.checks.length} checks passing</div>
          <div class="small muted">Thresholds — Bronze ≥${th.bronze}, Silver ≥${th.silver}, Gold ≥${th.gold}</div></div></div>
        <p style="font-size:15px;color:var(--text-2)">${msg}</p>
        ${groups.map(function (g) {
          return html`<h3 style="font-size:18px;font-weight:400;margin:24px 0 12px">${g}</h3><div class="card">${table(['Status', 'Check', 'How to fix if failing'], cr.checks.filter(function (ch) { return ch[1] === g; }).map(function (ch) {
            var ok = cr.pass[ch[0]];
            return [html`<span class="${ok ? 'check-ok' : 'check-fail'}" role="img" aria-label="${ok ? 'Passing' : 'Failing'}">${icon(ok ? 'checkC' : 'cancel', 26)}</span>`, html`<strong>${ch[2]}</strong><div class="muted small">${ch[0]}</div>`, ok ? '—' : REMEDIATION[ch[0]]];
          }))}</div>`;
        })}
        <p class="muted small mt16">Checks are defined in <code>scorecard.ts</code>; see <code>docs/shift-left.md</code>.</p>`;
    },
    security: function (c) {
      var r = rng('sec:' + c.name), weak = 14 - c.score;
      var s = { cov: Math.min(94, 52 + c.score * 2.6 + r() * 5), bugs: Math.round(weak * r()), vulns: Math.round(weak * 0.4 * r()), hot: Math.round(weak * 0.6 * r()), smells: Math.round(20 + weak * 9 * r()) };
      var snyk = [weak > 9 ? 1 : 0, Math.round(Math.max(0, weak - 5) * r()) + (c.name === 'inventory-service' ? 2 : 0), Math.round(2 + weak * r()), Math.round(3 + 6 * r())];
      function cell(v, l, col) { return html`<div style="text-align:center"><div style="font-size:30px;color:${raw(col || 'var(--text)')}">${v}</div><div class="muted small">${l}</div></div>`; }
      return html`<div class="grid g2">
        ${card('SonarCloud', html`<div class="card-body" style="padding-top:0"><div style="margin-bottom:16px">${chip('Quality Gate: ' + (c.score >= 9 ? 'Passed' : 'Failed'), c.score >= 9 ? 'ok' : 'err')}</div>
          <div class="grid g5 gap16">${cell(pct(s.cov), 'Coverage')}${cell(s.bugs, 'Bugs')}${cell(s.vulns, 'Vulnerabilities', s.vulns ? 'var(--err-dark)' : '')}${cell(s.hot, 'Security hotspots')}${cell(s.smells, 'Code smells')}</div>
          <div class="btn-row mt16"><span class="btn outlined sm" aria-disabled="true">Open in SonarCloud ↗</span></div></div>`, null, 'sonarcloud.io/project-key: moatazeldebsy_' + c.name)}
        ${card('Snyk monitor', html`<div class="card-body" style="padding-top:0"><div class="grid g4 gap16">${cell(snyk[0], 'Critical', snyk[0] ? 'var(--err-dark)' : '')}${cell(snyk[1], 'High', snyk[1] ? 'var(--warn-dark)' : '')}${cell(snyk[2], 'Medium')}${cell(snyk[3], 'Low')}</div>
          <div class="btn-row mt16"><span class="btn outlined sm" aria-disabled="true">Open project in Snyk ↗</span><span class="btn sm" aria-disabled="true">Org dashboard ↗</span></div></div>`, null, 'snyk.io/org-slug: moatazeldebsy')}
      </div>`;
    },
    datadog: function (c) {
      return html`<div class="btn-row" style="margin-bottom:16px">${demoChip()}<span class="muted small">Set <code>DD_API_KEY</code> and <code>DD_APP_KEY</code> to load live monitors.</span></div>
        <div class="grid g2">
          ${card('Monitors', table(['Monitor', 'State'], [['High p99 latency', chip('OK', 'sm ok')], ['Error rate > 1%', chip('OK', 'sm ok')], ['Pod restart loop', chip(c.name === 'inventory-service' ? 'Alert' : 'Warn', 'sm ' + (c.name === 'inventory-service' ? 'err' : 'warn'))]]), html`<span class="btn outlined sm" aria-disabled="true">Open Datadog Dashboard ↗</span>`, 'service:' + c.name)}
          ${card('SLO', html`<div class="card-body" style="padding-top:0"><strong>Availability — 99.9% of requests succeed</strong><div class="muted small" style="margin:6px 0 10px">30-day window · 99.94% achieved</div>${hbar(94, 100)}</div>`)}
        </div>`;
    },
    lambdatest: function (c) {
      return html`<div class="btn-row" style="margin-bottom:16px">${demoChip()}<span class="muted small">Annotate <code>lambdatest.com/project-name</code> to link a real project.</span></div>
        ${card('Mobile Device Farm', table(['Build', 'Name', 'Status', 'Platform', 'Device', 'Duration'], [
          [40122, c.name + ' #218', chip('completed', 'sm ok'), 'Android', 'Pixel 6-13', '14m 02s'], [40118, c.name + ' #217', chip('completed', 'sm ok'), 'Android', 'Galaxy S21-12', '13m 15s'], [40109, c.name + ' #216', chip('failed', 'sm err'), 'iOS', 'iPhone 14-16', '10m 31s']]))}
        <div class="mt">${card('LambdaTest', table(['Test', 'Name', 'Status', 'Browser', 'Platform'], [
          [90311, 'checkout flow — happy path', chip('passed', 'sm ok'), 'Chrome 126', 'Windows 11'], [90310, 'checkout flow — expired card', chip('passed', 'sm ok'), 'Chrome 126', 'Windows 11'], [90309, 'visual baseline — cart', chip('failed', 'sm err'), 'Safari 17', 'macOS Ventura']]))}</div>`;
    },
    trivy: function (c) {
      var r = rng('trivy:' + c.name), weak = 14 - c.score, sev = [0, Math.round(Math.max(0, weak - 6) * r()), Math.round(1 + weak * 0.6 * r()), Math.round(4 + 8 * r())];
      var cols = ['var(--err-dark)', 'var(--warn-dark)', '#f9a825', 'var(--text-2)'];
      return html`<div class="grid g4">${['Critical', 'High', 'Medium', 'Low'].map(function (l, i) { return statCardTop(l, sev[i], cols[i]); })}</div>
        <div class="mt">${card('Open code scanning alerts', table(['Rule', 'Severity', 'Package', 'Fixed version'], sev[1] ? [['CVE-2026-31337', chip('high', 'sm warn'), c.lang === 'Go' ? 'golang.org/x/net' : 'openssl', c.lang === 'Go' ? '0.33.0' : '3.0.15-r1']] : [], { empty: 'No high or critical alerts.' }),
          html`<span class="btn outlined sm" aria-disabled="true">Open in GitHub ↗</span>`, 'ghcr.io/moatazeldebsy/' + c.name + ':' + c.version)}</div>`;
    },
    'on-call': function (c) {
      var p = D.people[hash(c.name) % D.people.length];
      return html`<div class="grid g2">
        ${card('On-Call Now', html`<div class="card-body" style="padding-top:0"><div class="list-row" style="padding:8px 0"><div class="avatar">${initials(p)}</div><div><strong>${p}</strong><div class="muted small">Level 1 · until Mon 09:00</div></div></div>
          <div class="list-row" style="padding:8px 0"><div class="avatar">${initials(team(c.owner).lead)}</div><div><strong>${team(c.owner).lead}</strong><div class="muted small">Level 2 · escalation</div></div></div></div>`)}
        ${card('Open Incidents', table(['Title', 'Status', 'Urgency', 'Created'], c.name === 'inventory-service' ? [['inventory-service pods in CrashLoopBackOff', chip('triggered', 'sm err'), 'high', ago(140)]] : [], { empty: 'No open incidents.' }))}
      </div>`;
    },
    incidents: function (c) {
      var rows = incidents().filter(function (i) { return i.service === c.name; });
      return card('Incident history', table(['Incident', 'Severity', 'Started', 'Duration', 'State'], rows.map(function (i) {
        return [html`<span style="color:var(--link)">${i.id}</span>`, chip(i.sev, 'sm err-dark'), i.started, i.duration, html`<span style="color:${raw(i.state === 'Resolved' ? 'var(--ok-text)' : 'var(--err-dark)')}">${i.state}</span>`];
      }), { empty: 'No incidents recorded for this service.' }));
    },
    grafana: function (c) {
      var rows = D.alerts.filter(function (a) { return a.state === 'firing' && a.labels.indexOf(c.name) >= 0; });
      return html`${card('Firing Alerts', table(['Alert', 'Severity', 'Since', 'Summary'], rows.map(function (a) { return [a.name, chip(a.sev, 'sm ' + (a.sev === 'critical' ? 'err' : 'warn')), a.since, html`<span class="mono small">${a.labels}</span>`]; }), { empty: 'No firing alerts for service=' + c.name + '.' }))}
        <p class="muted small mt16">Selector: <code>grafana/alert-label-selector: service=${c.name}</code></p>`;
    },
    jira: function (c) {
      var key = c.name.split('-').map(function (w) { return w[0]; }).join('').toUpperCase().slice(0, 3) || 'IDP';
      var r = rng('jira:' + c.name), titles = ['Add retry budget to downstream calls', 'Flaky integration test on CI', 'Upgrade base image to distroless', 'Expose p99 latency metric', 'Document runbook URL', 'Rate limit per client'];
      return card('Open Issues — ' + key, table(['Key', 'Summary', 'Type', 'Priority', 'Status', 'Assignee'], titles.map(function (t, i) {
        return [html`<span style="color:var(--link)">${key}-${120 + i * 7}</span>`, t, ['Story', 'Bug', 'Task'][Math.floor(r() * 3)], ['High', 'Medium', 'Low'][Math.floor(r() * 3)], ['To Do', 'In Progress', 'In Review'][Math.floor(r() * 3)], D.people[Math.floor(r() * D.people.length)]];
      })));
    },
    slo: function (c) {
      var rows = sloRows(c);
      return html`${card('SLO Definition', table(['SLO', 'Objective', 'Error Budget Remaining', 'Status'], rows.map(function (s) {
          return [s.slo, s.obj + '%', html`<div style="display:flex;gap:10px;align-items:center">${hbar(s.rem, 1, s.rem < 0.2 ? 'var(--err)' : s.rem < 0.5 ? 'var(--warn)' : 'var(--ok)')}<span class="mono">${pct(s.rem * 100)}</span></div>`, sloStatus(s.rem)];
        }), { empty: 'Add idp.io/slo-availability-target and idp.io/slo-latency-target annotations.' }))}
        <div class="mt">${card('SLO Configuration', table(['Setting', 'Value'], [['Service', c.name], ['SLO engine', html`Sloth ↗`], ['Availability target', c.slo ? c.slo.avail + '%' : 'Not configured'], ['Latency target', c.slo ? c.slo.latency + '%' : 'Not configured'], ['Alert tiers', 'Page (critical burn rate) · Ticket (slow burn rate)']]))}</div>
        <p class="muted small mt16">Apply with <code>sloth generate -i observability/slo/... | kubectl apply -f -</code>; matched on <code>idp.io/sloth-service</code>.</p>`;
    },
    'github-actions': function (c) {
      var r = rng('gha:' + c.name), rows = [];
      for (var i = 0; i < 8; i++) {
        var fail = (i === 0 && c.name === 'inventory-service') || r() < 0.12;
        rows.push([html`<span style="color:var(--link)">${8123400 + 931 - i * 37}</span>`, ['chore: bump dependencies', 'feat: add retry budget', 'fix: handle empty payload', 'ci: cache go modules', 'docs: update runbook', 'refactor: split handlers', 'test: add contract tests', 'feat: expose p99 metric'][i],
          html`<div><strong>${i % 3 === 2 ? 'feat/otel-spans' : 'main'}</strong><div class="muted small mono">${hash(c.name + i).toString(16).slice(0, 7)}</div></div>`, i % 2 ? 'ci.yml' : 'build-and-deploy.yml',
          html`<span style="display:inline-flex;gap:6px;align-items:center;color:${raw(fail ? 'var(--err-dark)' : 'var(--ok-text)')}">${icon(fail ? 'cancel' : 'checkC', 18)}${fail ? 'Failed' : 'Completed'}</span>`,
          html`<span class="icon-btn sm" aria-hidden="true">${icon('refresh', 20)}</span>`]);
      }
      return card('All workflow runs', table(['ID', 'Message', 'Source', 'Workflow', 'Status', 'Actions'], rows, { cls: 'bs' }), null, 'moatazeldebsy/' + c.name);
    },
    adrs: function (c) {
      var adrs = [['0001-record-architecture-decisions.md', 'Record architecture decisions', 'We will keep ADRs in docs/adrs as Markdown, numbered and immutable once accepted.'],
        ['0002-use-the-shared-helm-chart.md', 'Use the shared Helm chart', 'Deploy through helm/service-template only; per-service overrides live in helm-values-*.yaml.'],
        ['0003-expose-prometheus-metrics.md', 'Expose Prometheus metrics', 'Every service exposes /metrics with RED metrics so DORA and SLO tooling work without per-service setup.']];
      var sel = adrs[0];
      return html`<div class="grid" style="grid-template-columns:minmax(0,280px) minmax(0,1fr)">${card('Architecture Decision Records', html`<div>${adrs.map(function (a, i) { return html`<div class="list-row" style="padding:12px 16px">${icon('docs', 20)}<div><strong>${a[1]}</strong><div class="muted small">${a[0]}</div></div></div>`; })}</div>`)}
        ${card(sel[1], html`<div class="card-body prose" style="padding-top:0"><p><strong>Status:</strong> Accepted · <strong>Date:</strong> 2026-03-02</p><h2 style="font-size:20px">Context</h2><p>We need a lightweight, reviewable record of significant decisions.</p><h2 style="font-size:20px">Decision</h2><p>${sel[2]}</p></div>`)}</div>`;
    }
  };

  function pageGroup(name, tab) {
    var t = team(name);
    if (!t) return notFound('Entity was not found');
    if (tab && tab !== 'budget') return notFound('This entity has no "' + tab + '" tab.');
    var base = entityHref('group', t.name), owned = D.components.filter(function (c) { return c.owner === t.name; });
    var body;
    if (tab === 'budget') {
      var u = t.spend / t.budget, col = u > 1 ? 'var(--err)' : u > 0.8 ? 'var(--warn)' : 'var(--ok)';
      body = html`<div class="grid g3">${statCardTop('Spent', money(t.spend, 0), col, 'month-to-date')}${statCardTop('Monthly budget', money(t.budget, 0), '#1976d2', html`<code>idp.io/cost-budget-monthly-usd: "${t.budget}"</code>`)}
          ${statCardTop('Utilisation', pct(u * 100, 0), col, u > 1 ? 'TeamBudgetExceeded firing' : u > 0.8 ? 'TeamBudgetWarning firing' : 'within budget')}</div>
        <div class="card mt"><div class="card-body">${hbar(t.spend, t.budget, col)}<div class="muted small" style="margin-top:8px">${money(t.spend, 0)} of ${money(t.budget, 0)} · forecast ${money(t.spend / 20 * 30, 0)} at month end</div></div></div>
        <div class="mt">${card('Budget Configuration', table(['Setting', 'Value'], [['Team', t.name], ['Monthly budget', money(t.budget, 0)], ['Cost namespaces', html`<code>${t.namespace}</code> <span class="muted small">(idp.io/cost-namespace)</span>`],
          ['Alert thresholds', 'Warning at 80% · Critical at 100%'], ['Data source', 'OpenCost → Pushgateway (every 15 min)']]))}</div>`;
    } else {
      var types = {};
      owned.forEach(function (c) { types[c.type] = (types[c.type] || 0) + 1; });
      var members = [t.lead].concat(D.people.filter(function (p) { return p !== t.lead; }).filter(function (p, i) { return (hash(t.name + p) % 3 === 0); }).slice(0, Math.max(2, Math.min(5, t.members - 1))));
      body = html`<div class="grid g2">
        ${card(t.display, html`<div class="card-body" style="padding-top:0"><div style="display:flex;gap:16px;align-items:center;flex-wrap:wrap"><div class="avatar lg">${initials(t.display)}</div><div style="min-width:0;overflow-wrap:anywhere">
          <div>${icon('group', 18)} ${t.name}@moatazeldebsy.dev</div><div class="muted" style="margin-top:6px">Parent group: <a href="${entityHref('group', 'platform-team')}">${t.name === 'platform-team' ? '—' : 'engineering'}</a></div><div class="muted small" style="margin-top:6px">${t.mission}</div></div></div></div>`)}
        ${card('Ownership', html`<div class="card-body" style="padding-top:0"><div class="grid g3 gap16">${Object.keys(types).length ? Object.keys(types).map(function (k) {
          return html`<div class="card stat" style="border-top-color:var(--c1);box-shadow:none;background:var(--paper-2)"><div class="num" style="font-size:30px">${types[k]}</div><div class="lab">${k.toUpperCase()}</div></div>`;
        }) : html`<p class="muted">No owned entities.</p>`}</div></div>`)}
      </div>
      <div class="mt">${card('Members (' + members.length + ')', html`<div class="card-body" style="padding-top:0"><div class="grid g4 gap16">${members.map(function (m) {
        return html`<div style="display:flex;gap:12px;align-items:center;min-width:0"><div class="avatar">${initials(m)}</div><div style="min-width:0;overflow-wrap:anywhere"><strong>${m}</strong><div class="muted small">${m.split(' ')[0].toLowerCase()}@moatazeldebsy.dev</div></div></div>`;
      })}</div></div>`)}</div>`;
    }
    return html`${entityHeader('other', 'Group — team', t.display, metaItem('Members', String(t.members)), 'Group:' + t.name)}${entityTabsNav(base, [['', 'Overview'], ['budget', 'Budget']], tab)}<div class="content">${body}</div>`;
  }
  function pageApiEntity(name, tab) {
    var a = api(name);
    if (!a) return notFound('Entity was not found');
    if (tab && tab !== 'definition') return notFound('This entity has no "' + tab + '" tab.');
    var base = entityHref('api', a.name), body;
    if (tab === 'definition') {
      var spec = a.type === 'openapi' ? 'openapi: 3.0.3\ninfo:\n  title: ' + a.name + '\n  version: ' + a.version + '\npaths:\n' + a.endpoints.map(function (e) { return '  ' + e[1] + ':\n    ' + e[0].toLowerCase() + ':\n      summary: ' + e[2] + '\n      responses:\n        "200":\n          description: OK'; }).join('\n')
        : a.type === 'asyncapi' ? 'asyncapi: 2.6.0\ninfo:\n  title: ' + a.name + '\n  version: ' + a.version + '\nchannels:\n  orders.v1:\n    publish:\n      message:\n        oneOf:\n' + a.endpoints.map(function (e) { return '          - name: ' + e[1].split('/ ')[1] + '   # ' + e[2]; }).join('\n')
        : 'type Query {\n' + a.endpoints.map(function (e) { return '  ' + e[1] + ': SearchResult  # ' + e[2]; }).join('\n') + '\n}';
      body = card(a.name, html`<div class="card-body" style="padding-top:0"><pre>${spec}</pre></div>`, chip(a.type, 'sm outlined'));
    } else {
      body = html`<div class="grid g2">${aboutCard(a, [['Owner', ownerLink(a.owner)], ['System', systemLink(a.system)], ['Type', a.type], ['Lifecycle', 'production'], ['Tags', chip(a.type, 'sm')]], [['View Source', null, 'code'], ['View Definition', base + '/definition', 'docs']])}
        ${card('Providers', table(['Name', 'Owner', 'Lifecycle'], [[html`<a class="cell-link" href="${entityHref('component', a.provider)}">${icon('wrench', 16)}${a.provider}</a>`, ownerLink(a.owner), 'production']], { cls: 'bs' }))}</div>`;
    }
    return html`${entityHeader('apis', 'API — ' + a.type, a.name, html`${metaItem('Owner', html`${icon('group', 16)}${team(a.owner).display}`)}${metaItem('Lifecycle', 'production')}`, 'API:' + a.name)}${entityTabsNav(base, [['', 'Overview'], ['definition', 'Definition']], tab)}<div class="content">${body}</div>`;
  }
  function pageSimpleEntity(kind, name, tab) {
    var e = kind === 'system' ? D.systems.filter(function (s) { return s.name === name; })[0] : D.resources.filter(function (r) { return r.name === name; })[0];
    if (!e || tab) return notFound('Entity was not found');
    var children = kind === 'system' ? D.components.filter(function (c) { return c.system === e.name; }) : [];
    var body = html`<div class="grid g2">${aboutCard(e, [['Owner', ownerLink(e.owner)], ['Type', kind === 'system' ? '' : e.kind.toLowerCase()], ['Domain', kind === 'system' ? 'engineering' : ''], ['Lifecycle', kind === 'resource' ? 'production' : '']], [['View Source', null, 'code']])}
      ${kind === 'system' ? card('Has components', table(['Name', 'Owner', 'Type', 'Lifecycle'], children.map(function (c) { return [html`<a class="cell-link" href="${entityHref('component', c.name)}">${c.name}</a>`, ownerLink(c.owner), c.type, c.lifecycle]; }), { cls: 'bs' }))
        : card('Crossplane claim', table(['Field', 'Value'], [['Kind', e.kind], ['Template', html`<a href="#/create/templates/default/${e.provider}">${e.provider}</a>`], ['Namespace', e.ns], ['Synced', String(e.synced)], ['Ready', e.ready ? 'True' : 'False'], ['Connection secret', html`<code>${e.secret}</code>`]].concat(e.reason ? [['Reason', e.reason]] : [])))}</div>`;
    return html`${entityHeader('other', cap(kind), e.name, metaItem('Owner', html`${icon('group', 16)}${team(e.owner).display}`), cap(kind) + ':' + e.name)}${entityTabsNav(entityHref(kind, e.name), [['', 'Overview']], '')}<div class="content">${body}</div>`;
  }

  /* ---------- Create (scaffolder plugin) ---------- */
  var TPL_THEME = { service: 'linear-gradient(90deg,#006d8f,#0049a1)', website: 'linear-gradient(90deg,#c9284d,#710dc2)', library: 'linear-gradient(90deg,#7a5a00,#b48a00)' };
  function tplBackground(type) { return TPL_THEME[type] || 'linear-gradient(90deg,#2b7a5f,#3f6f5f)'; }
  function scaffolderBar(cur) {
    return html`${pluginBar('Create', 'add')}<nav class="subtabs" aria-label="Scaffolder">${[['create', 'Templates'], ['create/tasks', 'Tasks'], ['create/actions', 'Actions']].map(function (t) {
      return html`<a href="#/${t[0]}" ${t[0] === cur ? raw('aria-current="page"') : ''}>${t[1]}</a>`;
    })}<span aria-disabled="true" title="Available in the live portal">Template Editor</span><span aria-disabled="true" title="Available in the live portal">Templating Extensions</span></nav>`;
  }
  function pageCreate() {
    var f = S.tplf, q = f.q.toLowerCase(), cats = [], tags = [];
    D.templates.forEach(function (t) { if (cats.indexOf(t.type) < 0) cats.push(t.type); t.tags.forEach(function (g) { if (tags.indexOf(g) < 0) tags.push(g); }); });
    var list = D.templates.filter(function (t) {
      return (!f.starred || S.starred['Template:' + t.n]) && (!f.cat || t.type === f.cat) && (!f.tag || t.tags.indexOf(f.tag) >= 0) && (!f.owner || t.o === f.owner) &&
        (!q || (t.n + ' ' + t.t + ' ' + t.d + ' ' + t.tags.join(' ')).toLowerCase().indexOf(q) >= 0);
    });
    var starredCount = D.templates.filter(function (t) { return S.starred['Template:' + t.n]; }).length;
    return html`${scaffolderBar('create')}<div class="content">
      <div style="display:flex;justify-content:flex-end;margin-bottom:16px"><a class="btn outlined" href="#/catalog-import">Register Existing Component</a></div>
      <div class="catalog-layout">
        <div class="filters">
          <div class="underline-search" style="margin-bottom:24px">${icon('search', 22)}<label class="sr-only" for="tpl-q">Search templates</label><input id="tpl-q" type="search" placeholder="Search" value="${f.q}" data-bind="tplf.q"></div>
          <div class="user-filter"><div class="uf-title">Personal</div>
            <button type="button" class="uf-item" data-action="toggle-tpl-starred" aria-pressed="${String(f.starred)}"><span>${icon('star', 20)} Starred</span><span>${starredCount}</span></button>
            <div class="uf-title" style="margin-top:14px">My Organization</div>
            <button type="button" class="uf-item" data-action="set" data-key="tplf.starred" data-value="" aria-pressed="${String(!f.starred)}"><span>All</span><span>${D.templates.length}</span></button></div>
          ${selectField('CATEGORIES', 'tpl-cat', 'tplf.cat', cats.sort(), f.cat, '')}
          ${selectField('Tags', 'tpl-tag', 'tplf.tag', tags.sort(), f.tag, '')}
          ${selectField('Owner', 'tpl-owner', 'tplf.owner', [['platform-team', 'Platform Team'], ['qa-platform-team', 'QA Platform Team']], f.owner, '')}
        </div>
        <div>
          <h1 style="font-size:32px;margin-bottom:20px">Templates</h1>
          ${list.length ? html`<div class="tpl-grid">${list.map(function (t) {
            var key = 'Template:' + t.n, on = !!S.starred[key], tm = team(t.o);
            return html`<article class="tpl-card"><div class="tpl-head" style="background-image:${raw(tplBackground(t.type))}"><div class="t-type">${t.type}</div><h3>${t.t}</h3>
                <div class="t-icons"><span aria-hidden="true">${icon('docs', 22)}</span><button type="button" data-action="star" data-key="${key}" aria-pressed="${String(on)}" aria-label="${(on ? 'Unstar ' : 'Star ') + t.t}">${icon(on ? 'star' : 'starO', 24)}</button></div></div>
              <div class="tpl-body"><p>${t.d}</p><div class="card-divider"></div><div>${t.tags.map(function (g) { return chip(g, 'sm'); })}</div><div class="card-divider"></div>
                <a href="#/docs/default/system/internal-developer-platform/golden-paths" style="display:flex;gap:8px;align-items:center">${icon('docs', 20)} View TechDocs</a></div>
              <div class="tpl-foot"><span class="owner">${icon('person', 20)}${tm ? tm.display : t.o}</span><a class="btn outlined sm" href="#/create/templates/default/${t.n}">Choose</a></div></article>`;
          })}</div>` : html`<div class="card card-body muted">No templates found that match your filter.</div>`}
        </div></div></div>`;
  }
  function isSuite(t) { return t.type === 'test-suite' || t.type === 'platform-capability'; }
  function defaultName(t) {
    var m = { 'go-service': 'inventory-sync', 'python-service': 'loyalty-points', 'nodejs-service': 'gift-cards', 'jvm-service': 'tax-calculator', 'react-frontend': 'account-web' };
    return m[t.n] || (isSuite(t) ? t.n.replace(/-test-suite$|-suite$/, '') + '-tests' : 'my-' + t.n.split('-')[0]);
  }
  function pageTemplateForm(name) {
    var t = tpl(name);
    if (!t) return notFound('Template not found');
    var f = S.forms[name] || (S.forms[name] = { step: 0, name: defaultName(t), owner: D.user.team, desc: '', target: 'local', service: 'hello-service', error: '' });
    var steps = ['Provide some simple information', 'Choose a location', 'Review'];
    var body;
    if (f.step === 0) {
      body = html`${isSuite(t) ? html`<div class="field"><label for="f-service">Target service *</label><select class="input" id="f-service" data-bind-quiet="forms.${t.n}.service">${D.components.map(function (c) { return html`<option ${c.name === f.service ? raw('selected') : ''}>${c.name}</option>`; })}</select><span class="hint">The suite is added to this service's repository through a pull request.</span></div>` : ''}
        <div class="field"><label for="f-name">Name *</label><input class="input" id="f-name" value="${f.name}" data-bind-quiet="forms.${t.n}.name" aria-describedby="f-name-hint"><span class="hint" id="f-name-hint">Unique name of the ${isSuite(t) ? 'test suite' : 'component'} — lowercase letters, digits and hyphens.</span></div>
        <div class="field"><label for="f-desc">Description</label><input class="input" id="f-desc" value="${f.desc}" data-bind-quiet="forms.${t.n}.desc"><span class="hint">Help others understand what this is for.</span></div>
        <div class="field"><label for="f-owner">Owner *</label><select class="input" id="f-owner" data-bind-quiet="forms.${t.n}.owner">${D.teams.map(function (tm) { return html`<option value="${tm.name}" ${tm.name === f.owner ? raw('selected') : ''}>group:default/${tm.name}</option>`; })}</select><span class="hint">Owner of the component</span></div>`;
    } else if (f.step === 1) {
      body = html`<div class="field"><label for="f-host">Host</label><input class="input" id="f-host" value="github.com" readonly></div>
        <div class="field"><label for="f-repo">Repository</label><input class="input" id="f-repo" value="${isSuite(t) ? 'moatazeldebsy/' + f.service : 'moatazeldebsy/' + f.name}" readonly></div>
        <div class="field"><span class="flabel">Deploy target</span><div class="seg" role="group">${[['local', 'Local (Kind)'], ['aws', 'AWS (EKS)']].map(function (o) {
          return html`<button type="button" data-action="set" data-key="forms.${t.n}.target" data-value="${o[0]}" aria-pressed="${String(f.target === o[0])}">${o[1]}</button>`;
        })}</div></div>`;
    } else {
      body = table(['Field', 'Value'], [['Name', f.name], ['Description', f.desc || '—'], ['Owner', 'group:default/' + f.owner]].concat(isSuite(t) ? [['Target service', f.service]] : []).concat([['Repository', 'github.com/moatazeldebsy/' + (isSuite(t) ? f.service : f.name)], ['Deploy target', f.target === 'aws' ? 'AWS (EKS)' : 'Local (Kind)']]), { cls: 'plain' });
    }
    return html`${scaffolderBar('create')}<div class="content">
      <div class="page-title"><div><h1>Create a new component</h1><div class="muted" style="margin-top:4px">Create new software components using standard templates in your organization</div></div></div>
      <section class="card"><div class="card-head"><h2>${t.t}<span class="sub">${t.d}</span></h2></div><div class="card-divider"></div>
        <div class="stepper-head">${steps.map(function (s, i) {
          return html`${i ? html`<span class="line"></span>` : ''}<span class="st ${i === f.step ? 'active' : ''}"><span class="vstep ${i < f.step ? 'done' : i === f.step ? 'active' : ''}"><span class="num">${i < f.step ? '✓' : i + 1}</span></span>${s}</span>`;
        })}</div>
        <form class="card-body" data-submit="tpl-next" data-tpl="${t.n}" novalidate style="max-width:760px">${body}
          <div class="err-text" role="alert" id="form-error">${f.error}</div>
          <div class="btn-row" style="margin-top:8px"><button type="button" class="btn" data-action="tpl-back" data-key="${t.n}" ${f.step === 0 ? raw('disabled') : ''}>Back</button>
            <button type="submit" class="btn contained">${f.step === 2 ? 'Create' : 'Next'}</button></div></form></section></div>`;
  }
  function taskSteps(t, v) {
    if (isSuite(t)) return ['Fetch Template', 'Open Pull Request on ' + v.service, 'Push Tech Insights Metrics'];
    if (t.type === 'resource') return ['Fetch Template', 'Render ' + (t.n.indexOf('crossplane') >= 0 ? 'Crossplane Claim' : 'Terraform Module'), 'Open Platform GitOps PR'];
    return ['Resolve Platform URLs', 'Fetch Template', 'Publish to GitHub'].concat(v.target === 'aws' ? ['Provision ECR Repository'] : []).concat(['Configure CI/CD Secrets', 'Register in Local Catalog', 'Prepare Platform GitOps Values', 'Open Platform GitOps PR', 'Register in Catalog']);
  }
  function taskLog(step, v, t) {
    var map = {
      'Resolve Platform URLs': ['info: Platform repo moatazeldebsy/backstage-platform-template', 'info: Registry localhost:5003'],
      'Fetch Template': ['info: Fetching template content from remote URL', 'info: Listing files and directories in template', 'info: Processing 27 template files/directories with input values'],
      'Publish to GitHub': ['info: Creating repository moatazeldebsy/' + v.name, 'info: Pushing initial commit to main', 'info: Enabled branch protection on main'],
      'Provision ECR Repository': ['info: Created ECR repository idp-mvp/' + v.name],
      'Configure CI/CD Secrets': ['info: Fetching Actions public key for moatazeldebsy/' + v.name + '...', 'info: Secret IDP_PLATFORM_TOKEN set on moatazeldebsy/' + v.name, 'info: Done. Set 2/2 secrets'],
      'Register in Local Catalog': ['info: Registered component:default/' + v.name],
      'Prepare Platform GitOps Values': ['info: Wrote services/' + v.name + '/helm-values-' + v.target + '.yaml'],
      'Open Platform GitOps PR': ['info: Opened PR #' + (700 + hash(v.name) % 90) + ' "feat: onboard ' + v.name + '"', 'info: Auto-merge enabled (helm-values only)'],
      'Register in Catalog': ['info: Location registered: github.com/moatazeldebsy/' + v.name + '/blob/main/catalog-info.yaml'],
      'Push Tech Insights Metrics': ['info: Pushed has-e2e-tests=1 to pushgateway.idp.local']
    };
    return map[step] || (step.indexOf('Open Pull Request') === 0 ? ['info: Opened PR #' + (400 + hash(v.name) % 90) + ' on moatazeldebsy/' + v.service + ': "test: add ' + v.name + '"'] : ['info: Rendered ' + (t.n.indexOf('crossplane') >= 0 ? 'services/' + v.service + '/claims/' + v.name + '.yaml' : 'terraform/modules/' + v.name)]);
  }
  function startTask(t, v) {
    var id = (hash(v.name + Date.now()).toString(16) + '0000').slice(0, 8) + '-' + hash(v.name).toString(16).slice(0, 4) + '-475c-92aa-' + hash(t.n).toString(16).padStart(8, '0').slice(0, 8) + '1cc0';
    var task = { id: id, tpl: t.n, values: v, steps: taskSteps(t, v), step: 0, done: false, lines: [], durations: [], started: ago(0), clock: 0 };
    S.tasks[id] = task; S.taskOrder.unshift(id);
    function tick() {
      var name = task.steps[task.step], secs = 1 + (hash(name + v.name) % 6);
      task.lines.push(iso(task.clock) + ' Beginning step ' + name);
      taskLog(name, v, t).forEach(function (l) { task.lines.push(iso(task.clock) + ' ' + l); });
      task.clock += secs;
      task.lines.push(iso(task.clock) + ' Finished step ' + name);
      task.durations.push(secs);
      task.step++;
      if (task.step >= task.steps.length) {
        task.done = true;
        if (!isSuite(t) && t.type !== 'resource') registerEntity(v, t);
      } else setTimeout(tick, 650);
      refreshIf('create');
    }
    setTimeout(tick, 400);
    return id;
  }
  function registerEntity(v, t) {
    if (comp(v.name)) return;
    var lang = { 'go-service': 'Go', 'python-service': 'Python', 'nodejs-service': 'Node.js', 'jvm-service': 'Java', 'ruby-service': 'Ruby', 'react-frontend': 'React' }[t ? t.n : ''] || 'Go';
    D.components.push({ name: v.name, type: t && t.type === 'website' ? 'website' : 'service', owner: v.owner, system: 'commerce', lifecycle: 'experimental', lang: lang,
      desc: v.desc || 'Scaffolded from the ' + (t ? t.t : 'Go Service') + ' template.', tags: [lang.toLowerCase(), 'golden-path'], score: 7,
      slo: { avail: 99.5, latency: 99.0 }, dora: { df: 1, lt: 0.4, cfr: 0, mttr: 0 }, replicas: 1, version: '0.1.0' });
  }
  function pageTask(id) {
    var task = S.tasks[id];
    if (!task) return html`${scaffolderBar('create/tasks')}<div class="content"><div class="card card-body">Task not found. Tasks only exist for this browser session in the demo. <a href="#/create">Back to templates</a></div></div>`;
    var t = tpl(task.tpl), v = task.values, pctDone = task.step / task.steps.length * 100, service = !isSuite(t) && t.type !== 'resource';
    return html`${scaffolderBar('create/tasks')}<div class="content">
      <div class="page-title"><h1>${t.t}</h1><span class="icon-btn" aria-hidden="true">${icon('more')}</span></div>
      <section class="card"><div class="progress-line" role="progressbar" aria-valuenow="${Math.round(pctDone)}" aria-valuemin="0" aria-valuemax="100" aria-label="Task progress"><span style="width:${pctDone.toFixed(0)}%"></span></div>
        <div class="hstepper">${task.steps.map(function (s, i) {
          var st = i < task.step ? 'done' : i === task.step && !task.done ? 'running' : 'pending';
          return html`<div class="hstep ${st}"><span class="s-ic">${icon(st === 'done' ? 'checkO' : st === 'running' ? 'loading' : 'circleO', 26)}</span><div class="s-label">${s}</div>${st === 'done' ? html`<div class="s-time">${task.durations[i]} seconds</div>` : ''}</div>`;
        })}</div>
        ${task.done ? html`<div class="card-divider"></div><div class="card-body btn-row">${service ? html`<a class="btn outlined" href="${entityHref('component', v.name)}">${icon('open', 18)}Open in catalog</a><a class="btn outlined" href="#/argocd">${icon('tree', 18)}ArgoCD</a>` : html`<a class="btn outlined" href="${entityHref('component', v.service)}">${icon('open', 18)}Open ${v.service}</a>`}
          <span class="btn outlined" aria-disabled="true">${icon('code', 18)}Repository</span></div>` : ''}
      </section>
      <section class="card mt"><div class="card-body" style="display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
        <button type="button" class="btn grey" ${task.done ? raw('disabled') : ''} data-action="toast" data-msg="Cancel is disabled in the demo">Cancel</button>
        <button type="button" class="btn outlined" data-action="toggle-logs">${S.showLogs ? 'Hide logs' : 'Show logs'}</button>
        <a class="btn contained" href="#/create/templates/default/${t.n}" ${task.done ? '' : raw('aria-disabled="true" tabindex="-1" style="pointer-events:none;opacity:.5"')}>Start over</a></div></section>
      ${S.showLogs ? html`<section class="card mt"><div class="logview" id="task-log" aria-live="polite">${task.lines.map(function (l, i) {
        var m = l.match(/^(\S+) (info:)?(.*)$/);
        return html`<div><span class="ln">${i + 1}</span><span>${m[1]} ${m[2] ? html`<span class="lvl">info</span>:` : ''}${m[3]}</span></div>`;
      })}</div></section>` : ''}</div>`;
  }
  function pageTasks() {
    return html`${scaffolderBar('create/tasks')}<div class="content"><div class="page-title"><h1>List template tasks</h1></div>
      ${card('Tasks', table(['Task ID', 'Template', 'Created', 'Owner', 'Status'], S.taskOrder.map(function (id) {
        var tk = S.tasks[id];
        return [html`<a href="#/create/tasks/${id}">${id}</a>`, tpl(tk.tpl).t, tk.started, 'user:default/arivera', tk.done ? chip('completed', 'sm ok') : chip('processing', 'sm info')];
      }), { empty: 'No tasks yet in this session. Run a template from the Templates tab.' }))}</div>`;
  }
  function pageActions() {
    var acts = [['idp:deploy-local', 'helm upgrade --install to Kind via host.docker.internal'], ['idp:provision-secret', 'Create a Kubernetes Secret'], ['idp:set-repo-secrets', 'Write GitHub Actions secrets'],
      ['idp:tech-insights', 'Push metrics to Prometheus Pushgateway'], ['idp:deploy-agent', 'Deploy a KAgent Agent CRD'], ['idp:run-training-job', 'Launch an MLflow training job'],
      ['idp:deploy-mcp-server', 'Deploy an MCP server via Helm'], ['idp:deploy-model-server', 'Deploy a model inference server (Ollama local / vLLM AWS)'], ['idp:setup-contract-testing', 'Deploy contract-mcp-server and register the target service'],
      ['fetch:template', 'Downloads a skeleton, templates variables into files and directories'], ['publish:github', 'Initializes a git repository and publishes it to GitHub'], ['catalog:register', 'Registers entities from a catalog descriptor file']];
    return html`${scaffolderBar('create/actions')}<div class="content"><div class="page-title"><h1>Installed actions</h1></div>
      <div class="grid">${acts.map(function (a) { return card(a[0], html`<div class="card-body" style="padding-top:0">${a[1]}</div>`); })}</div></div>`;
  }

  /* ---------- APIs (stock api-docs) ---------- */
  function pageApiDocs() {
    var f = S.apiCat, all = D.apis.map(function (a) { return { kind: 'API', name: a.name, type: a.type, owner: a.owner, system: a.system, lifecycle: 'production', desc: a.desc, tags: [a.type] }; });
    var mine = all.filter(function (e) { return e.owner === D.user.team; }), starred = all.filter(function (e) { return S.starred['API:' + e.name]; });
    var base = f.personal === 'owned' ? mine : f.personal === 'starred' ? starred : all, q = f.q.toLowerCase();
    var rows = base.filter(function (e) { return (!f.type || e.type === f.type) && (!f.owner || e.owner === f.owner) && (!q || (e.name + ' ' + e.desc).toLowerCase().indexOf(q) >= 0); });
    return html`${pluginBar('APIs', 'extension')}<div class="content">
      <div class="page-title"><h1>My Organization API Explorer</h1><a class="btn contained" href="#/catalog-import">Register Existing API</a></div>
      <div class="catalog-layout"><div class="filters">
          ${selectField('Type', 'a-type', 'apiCat.type', ['openapi', 'asyncapi', 'graphql'], f.type, 'all')}
          ${userFilter('apiCat', mine.length, starred.length, all.length, f.personal)}
          ${selectField('Owner', 'a-owner', 'apiCat.owner', ['platform-team', 'backend-team', 'data-team'].map(function (o) { return [o, team(o).display]; }), f.owner, '')}
          ${selectField('Lifecycle', 'a-life', 'apiCat.lifecycle', ['production'], f.lifecycle, '')}</div>
        <section class="card"><div class="card-head"><h2>All APIs (${rows.length})</h2><div class="underline-search">${icon('search', 22)}<label class="sr-only" for="api-q">Filter</label><input id="api-q" type="search" placeholder="Filter" value="${f.q}" data-bind="apiCat.q"></div></div>
          ${table(['Name', 'System', 'Owner', 'Type', 'Lifecycle', 'Description', 'Tags', 'Actions'], rows.map(function (e) {
            return [html`<a class="cell-link" href="${entityHref('api', e.name)}">${icon('extension', 16)}${e.name}</a>`, systemLink(e.system), ownerLink(e.owner), e.type, e.lifecycle, html`<span class="clamp">${e.desc}</span>`, tagChips(e.tags), actionsCell(e)];
          }), { cls: 'bs' })}</section></div></div>`;
  }

  /* ---------- Docs (stock TechDocs) ---------- */
  function docSites() {
    return [{ kind: 'system', name: 'internal-developer-platform', owner: 'platform-team', type: 'system', title: 'Internal Developer Platform' }].concat(D.components.map(function (c) { return { kind: 'component', name: c.name, owner: c.owner, type: c.type, title: c.name }; }));
  }
  function pageDocsIndex() {
    var sites = docSites();
    return html`${pluginBar('Docs', 'docs')}${header('documentation', 'Documentation', 'Documentation available in My Organization')}<div class="content">
      ${card('All (' + sites.length + ')', table(['Document', 'Owner', 'Kind', 'Type', 'Actions'], sites.map(function (s) {
        return [html`<a href="#/docs/default/${s.kind}/${s.name}"><strong>${s.title}</strong></a>`, ownerLink(s.owner), s.kind, s.type, actionsCell({ kind: s.kind === 'system' ? 'System' : 'Component', name: s.name })];
      }), { cls: 'bs' }))}</div>`;
  }
  function docPages(kind, name) {
    if (kind === 'system') return D.docs;
    var c = comp(name) || { name: name, desc: '', lang: 'Go' };
    return [{ id: 'index', title: name, section: 'Home', body: [['p', c.desc], ['h2', 'Endpoints'], ['code', 'GET /          Service info JSON\nGET /healthz   Liveness probe — returns {"status":"ok"}\nGET /readyz    Readiness probe\nGET /metrics   Prometheus metrics'],
      ['h2', 'Local development'], ['code', c.lang === 'Go' ? 'go test ./... -coverprofile=coverage.out\ngo run ./src' : c.lang === 'Python' ? 'pip install -r requirements.txt\nuvicorn app.main:app --reload' : 'npm ci && npm run dev'],
      ['h2', 'Deployment'], ['p', 'Merging to main builds and signs the image; ArgoCD syncs ' + name + '-dev from services/' + name + '/helm-values-local.yaml using the shared helm/service-template chart.']] },
      { id: 'runbooks', title: 'Runbooks', section: 'Runbooks', body: [['p', 'Alerts for this service link to the platform runbooks.'], ['runbooks']] }];
  }
  function docsReader(name, kind, pageId, embedded) {
    var pages = docPages(kind, name), p = pages.filter(function (x) { return x.id === pageId; })[0] || pages[0];
    var base = '#/docs/default/' + kind + '/' + name;
    var h2s = p.body.filter(function (b) { return b[0] === 'h2'; }).map(function (b) { return b[1]; });
    var content = html`<div class="outlined-search" style="max-width:640px;margin:0 auto 32px">${icon('search', 22)}<label class="sr-only" for="doc-q">Search docs</label><input id="doc-q" type="search" placeholder="${'Search ' + name + ' docs'}" value="${S.docSearch}" data-bind-quiet="docSearch"></div>
      <div class="docs-reader"><nav aria-label="Docs navigation"><strong style="display:block;margin-bottom:8px">${kind === 'system' ? 'Internal Developer Platform' : name}</strong>${pages.map(function (x) {
        return html`<a href="${base + '/' + x.id}" ${x === p ? raw('aria-current="page"') : ''}>${x.title}</a>`;
      })}</nav>
      <article class="prose"><h1>${p.title}</h1>${p.body.map(function (b) {
        if (b[0] === 'p') return html`<p>${b[1]}</p>`;
        if (b[0] === 'h2') return html`<h2>${b[1]}</h2>`;
        if (b[0] === 'ul') return html`<ul>${b[1].map(function (x) { return html`<li>${x}</li>`; })}</ul>`;
        if (b[0] === 'code') return html`<pre><code>${b[1]}</code></pre>`;
        if (b[0] === 'runbooks') return html`<ul>${D.runbooks.map(function (r) { return html`<li>${r[1]} — <code>docs/runbooks/${r[0]}.md</code></li>`; })}</ul>`;
        return '';
      })}</article>
      <aside class="toc">${h2s.length ? html`<strong>Table of contents</strong>${h2s.map(function (h) { return html`<a href="${base + '/' + p.id}">${h}</a>`; })}` : ''}</aside></div>`;
    return embedded ? content : html`${pluginBar('Docs', 'docs')}${header('documentation', p.title, kind === 'system' ? 'Internal Developer Platform' : name)}<div class="content">${content}</div>`;
  }

  /* ---------- Tech Radar (community plugin, backstage/catalog/tech-radar.json) ---------- */
  var QUAD = { languages: 'Languages & Frameworks', platforms: 'Platforms & Infrastructure', tools: 'Tools & Utilities', techniques: 'Techniques & Practices' };
  var RING_COL = { adopt: '#27ae60', trial: '#2980b9', assess: '#f39c12', hold: '#e74c3c' };
  var RINGS = ['adopt', 'trial', 'assess', 'hold'];
  function pageRadar() {
    var q = (S.radarQ || '').toLowerCase();
    var entries = D.radar.map(function (e, i) { return { n: i + 1, title: e[0], quad: e[1], ring: e[2] }; });
    var pos = { tools: [-1, -1], techniques: [1, -1], platforms: [-1, 1], languages: [1, 1] };
    var C = 260, R = [90, 150, 205, 250], s = '';
    for (var i = 3; i >= 0; i--) s += '<circle cx="' + C + '" cy="' + C + '" r="' + R[i] + '" fill="none" stroke="var(--grid)"/>';
    s += '<line x1="' + (C - 255) + '" x2="' + (C + 255) + '" y1="' + C + '" y2="' + C + '" stroke="var(--grid)"/><line y1="' + (C - 255) + '" y2="' + (C + 255) + '" x1="' + C + '" x2="' + C + '" stroke="var(--grid)"/>';
    entries.forEach(function (e) {
      var r = rng('radar:' + e.title), ri = RINGS.indexOf(e.ring), inner = ri ? R[ri - 1] : 14, outer = R[ri];
      var rad = inner + 12 + r() * (outer - inner - 24), ang = (10 + r() * 70) * Math.PI / 180, p = pos[e.quad] || [1, 1];
      var x = C + p[0] * rad * Math.cos(ang), y = C + p[1] * rad * Math.sin(ang), dim = q && e.title.toLowerCase().indexOf(q) < 0;
      s += '<g opacity="' + (dim ? 0.15 : 1) + '"><circle cx="' + x.toFixed(1) + '" cy="' + y.toFixed(1) + '" r="9" fill="' + RING_COL[e.ring] + '"><title>' + esc(e.n + '. ' + e.title) + '</title></circle><text x="' + x.toFixed(1) + '" y="' + (y + 3.5).toFixed(1) + '" text-anchor="middle" style="font-size:8.5px;fill:#fff;font-weight:700">' + e.n + '</text></g>';
    });
    RINGS.forEach(function (rg, i) { s += '<text x="' + C + '" y="' + (C - R[i] + 22) + '" text-anchor="middle" style="font-size:18px;font-weight:700;fill:' + RING_COL[rg] + ';opacity:.85">' + rg.toUpperCase() + '</text>'; });
    function quadList(qid) {
      return html`<div class="radar-q"><h3>${QUAD[qid]}</h3><div class="rings">${RINGS.map(function (rg) {
        var items = entries.filter(function (e) { return e.quad === qid && e.ring === rg; });
        if (!items.length) return '';
        return html`<div><h4 style="color:${raw(RING_COL[rg])}">${rg.toUpperCase()}</h4><ol>${items.map(function (e) { var dim = q && e.title.toLowerCase().indexOf(q) < 0; return html`<li style="${raw(dim ? 'opacity:.35' : '')}">${e.n}. ${e.title}</li>`; })}</ol></div>`;
      })}</div></div>`;
    }
    return html`${pluginBar('tech-radar', 'widgets')}${header('tool', 'Tech Radar', 'Pick the recommended technologies for your projects')}<div class="content">
      <div class="page-title"><h1 style="font-size:32px">Company Radar</h1><div class="underline-search"><label class="sr-only" for="radar-q">Filter</label><input id="radar-q" type="search" placeholder="Filter" value="${S.radarQ || ''}" data-bind="radarQ"></div></div>
      <div class="radar-wrap"><div>${quadList('tools')}${quadList('platforms')}</div>
        <svg class="chart" viewBox="0 0 520 520" role="img" aria-label="${'Tech radar with ' + entries.length + ' entries'}">${raw(s)}</svg>
        <div>${quadList('techniques')}${quadList('languages')}</div></div></div>`;
  }

  /* ---------- Announcements (community plugin) ---------- */
  var ANNOUNCEMENTS = [
    ['KAgent v0.4 — OpenAI ModelConfig support', 'Jun 18', 'GPT-4o is now available as an alternative model for KAgent agents.', 'platform-team'],
    ['Cost attribution GA — teams can now see per-agent AI spend', 'Jun 15', 'Budget tab in Backstage now shows AI API costs broken down by agent.', 'platform-team'],
    ['Planned maintenance — Kind cluster restart Jun 22 02:00 UTC', 'Jun 14', 'All local services will be unavailable for ~10 minutes.', 'platform-team'],
    ['Contract testing is now one click', 'Jun 2', 'Run "Enable Contract Testing" on any service; the contract-mcp-server registers its spec automatically.', 'qa-team']
  ];
  function pageAnnouncements() {
    return html`${pluginBar('Announcements', 'campaign')}${header('home', 'Announcements', null, html`<span class="btn outlined" style="color:#fff;border-color:rgba(255,255,255,.6)" aria-disabled="true">New announcement</span>`)}<div class="content"><div class="grid g2">${ANNOUNCEMENTS.map(function (a) {
      return html`<section class="card"><div class="card-head"><h2>${a[0]}<span class="sub">By ${team(a[3]).display}, ${a[1]}</span></h2></div><div class="card-body" style="padding-top:0">${a[2]}</div></section>`;
    })}</div></div>`;
  }

  /* ---------- Register Existing Component (catalog-import) ---------- */
  function pageImport() {
    var st = S.importStep, steps = ['Select URL', 'Import Actions', 'Review', 'Finish'];
    var body = st === 0 ? html`<form data-submit="import" novalidate><div class="field"><label for="imp-url">URL</label><input class="input" id="imp-url" value="${S.importUrl}" data-bind-quiet="importUrl"><span class="hint">Enter the full path to your entity file to start tracking your component</span></div><button class="btn contained" type="submit">Analyze</button></form>`
      : st === 1 ? html`<p>The following entities will be added to the catalog:</p>${table(['Entity', 'Kind'], [[html`<strong>loyalty-points</strong>`, 'Component'], [html`<strong>loyalty-points-api</strong>`, 'API']])}<div class="btn-row mt16"><button class="btn" type="button" data-action="set" data-key="importStep" data-value="0">Back</button><button class="btn contained" type="button" data-action="set" data-key="importStep" data-value="2">Import</button></div>`
      : html`<div class="alert success">Entities have been registered. They will appear in the catalog after the next refresh.</div><div class="btn-row"><a class="btn outlined" href="#/catalog">View in catalog</a><button class="btn" type="button" data-action="set" data-key="importStep" data-value="0">Register another</button></div>`;
    return html`${pluginBar('Register Existing Component', 'add')}${header('home', 'Register an existing component')}<div class="content"><div class="grid" style="grid-template-columns:minmax(0,2fr) minmax(0,1fr)">
      ${card('Start tracking your component in Backstage by adding it to the software catalog.', html`<div class="stepper-head" style="padding-top:0">${steps.map(function (s, i) {
        var idx = st === 2 ? 3 : st;
        return html`${i ? html`<span class="line"></span>` : ''}<span class="st ${i === idx ? 'active' : ''}"><span class="vstep ${i < idx ? 'done' : i === idx ? 'active' : ''}"><span class="num">${i < idx ? '✓' : i + 1}</span></span>${s}</span>`;
      })}</div><div class="card-body">${body}</div>`)}
      ${card('Register an existing component', html`<div class="card-body" style="padding-top:0"><p>Enter the URL to your source code repository to add it to the catalog.</p><p><strong>Link to an existing entity file</strong></p><p class="muted small">Example: <code>https://github.com/moatazeldebsy/hello-service/blob/main/catalog-info.yaml</code></p><p class="muted small">The wizard analyzes the file, previews the entities, and adds them to the catalog.</p></div>`)}
      </div></div>`;
  }

  /* ---------- custom-pages: platform pages ---------- */
  function argoApps() {
    var r = rng('argo');
    var apps = D.components.filter(function (c) { return c.replicas > 0; }).map(function (c) {
      var oos = ['notifications-service', 'fraud-scoring', 'qa-mcp-server'].indexOf(c.name) >= 0;
      return { name: c.name + '-dev', ns: 'services-dev', sync: S.synced[c.name + '-dev'] ? 'Synced' : oos ? 'OutOfSync' : 'Synced', health: c.name === 'inventory-service' ? 'Degraded' : 'Healthy', rev: '—', last: ago(30 + Math.floor(r() * 9000)) };
    });
    [['crossplane', 'crossplane-system', '1.17.2'], ['cert-manager', 'cert-manager', 'v1.16.2'], ['ingress-nginx', 'ingress-nginx', '4.11.3'], ['kube-prometheus-stack', 'monitoring', '66.3.1'], ['loki', 'monitoring', '6.21.0'], ['tempo', 'monitoring', '1.14.0'], ['kyverno', 'kyverno', '3.3.4'], ['kagent', 'kagent', 'v0.4.1']].forEach(function (p) {
      var oos = p[0] === 'tempo' || p[0] === 'kagent';
      apps.push({ name: p[0], ns: p[1], sync: S.synced[p[0]] ? 'Synced' : oos ? 'OutOfSync' : 'Synced', health: p[0] === 'kagent' && !S.synced.kagent ? 'Progressing' : 'Healthy', rev: p[2], last: ago(60 + Math.floor(r() * 20000)) });
    });
    return apps.sort(function (a, b) { return a.name.localeCompare(b.name); });
  }
  function pageArgo() {
    var apps = argoApps(), c = function (fn) { return apps.filter(fn).length; };
    return customPage('tool', 'ArgoCD Applications', 'GitOps · app-of-apps', html`
      <div class="grid g5">${statCard(apps.length, 'Total Apps', '#455a64')}${statCard(c(function (a) { return a.sync === 'Synced'; }), 'Synced', '#43a047')}${statCard(c(function (a) { return a.sync === 'OutOfSync'; }), 'Out of Sync', '#f57c00')}
        ${statCard(c(function (a) { return a.health === 'Unknown'; }), 'Unknown', '#9e9e9e')}${statCard(c(function (a) { return a.health === 'Degraded'; }), 'Degraded', '#e53935')}</div>
      <div class="mt">${card('Applications', table(['Application', 'Namespace', 'Sync Status', 'Health', 'Revision', 'Last Synced', ''], apps.map(function (a) {
        return [a.name, html`<span class="mono">${a.ns}</span>`, status(a.sync), status(a.health), a.rev, html`<span class="nowrap">${a.last}</span>`,
          html`<button type="button" class="btn outlined sm grey" data-action="argo-sync" data-key="${a.name}" ${S.syncing && S.syncing[a.name] ? raw('disabled') : ''}>${S.syncing && S.syncing[a.name] ? 'Syncing…' : '↻ Sync'}</button>`];
      })), html`<div class="btn-row"><button type="button" class="btn outlined grey" data-action="noop">↻ Refresh</button><span class="btn contained" aria-disabled="true">Open ArgoCD ↗</span></div>`)}</div>`);
  }
  function pageDora() {
    var rows = D.components.filter(function (c) { return c.replicas > 0 || c.type === 'mobile'; }).sort(function (a, b) { return a.name.localeCompare(b.name); });
    return customPage('tool', 'DORA Metrics', 'Platform-wide deployment performance · all services', html`${doraCards(ORG_DORA, 'org')}
      <div class="mt">${card('Per-Service Breakdown', table(['Service', 'Deploy Freq', 'Lead Time', 'Change Fail %', 'MTTR', 'Perf Band'], rows.map(function (c) {
        return [html`<a href="${entityHref('component', c.name)}/dora">${c.name}</a>`, num(c.dora.df * 7, 1) + '/wk', hours(c.dora.lt), pct(c.dora.cfr), dur(c.dora.mttr), bandChip(overallBand(c))];
      }), { num: [1, 2, 3, 4] }))}</div>`);
  }
  function pageScorecardPlatform() {
    var rows = D.components.filter(function (c) { return c.type !== 'library'; }).map(function (c) { var cr = checkResults(c); return { c: c, cr: cr, tier: tierOf(c) }; });
    var order = { gold: 0, silver: 1, bronze: 2, none: 3 };
    rows.sort(S.scoreSort === 'name' ? function (a, b) { return a.c.name.localeCompare(b.c.name); } : S.scoreSort === 'tier' ? function (a, b) { return order[a.tier] - order[b.tier] || b.cr.count - a.cr.count; } : function (a, b) { return b.cr.count / b.cr.checks.length - a.cr.count / a.cr.checks.length; });
    var cnt = function (t) { return rows.filter(function (r) { return r.tier === t; }).length; };
    return customPage('tool', 'Scorecard Overview', 'Bronze / Silver / Gold shift-left quality tiers · all services', html`
      <div class="grid g4">${statCard(cnt('gold'), 'Gold', 'var(--gold)')}${statCard(cnt('silver'), 'Silver', 'var(--silver)')}${statCard(cnt('bronze'), 'Bronze', 'var(--bronze)')}${statCard(cnt('none'), 'No Tier', '#9e9e9e')}</div>
      <div class="mt">${card('Services', table(['Service', 'Owner', 'Tier', 'Score', 'Next action'], rows.map(function (r) {
        var fail = r.cr.checks.filter(function (ch) { return !r.cr.pass[ch[0]]; })[0];
        return [html`<a href="${entityHref('component', r.c.name)}/scorecard">${r.c.name}</a>`, 'group:default/' + r.c.owner, tierChip(r.tier),
          html`<div style="display:flex;gap:10px;align-items:center"><strong class="nowrap">${r.cr.count}/${r.cr.checks.length}</strong>${hbar(r.cr.count, r.cr.checks.length, { gold: 'var(--gold)', silver: 'var(--silver)', bronze: 'var(--bronze)', none: '#9e9e9e' }[r.tier])}</div>`,
          html`<span class="muted">${fail ? fail[2] : '—'}</span>`];
      })), chipButtons('scoreSort', [['score', 'Sort by score'], ['tier', 'Sort by tier'], ['name', 'Sort by name']], S.scoreSort, 'flat'))}</div>`);
  }
  function pageSloPlatform() {
    var rows = [];
    D.components.forEach(function (c) { sloRows(c).forEach(function (s) { rows.push([c, s]); }); });
    return customPage('tool', 'SLOs', 'Error budgets · all services · powered by Sloth + Prometheus', html`<div class="card">${table(['Service', 'SLO', 'Objective', 'Error Budget Remaining', 'Status'], rows.map(function (x) {
      var s = x[1];
      return [html`<a href="${entityHref('component', x[0].name)}/slo"><strong>${x[0].name}</strong></a>`, s.slo, html`<span class="mono">${s.obj}%</span>`,
        html`<div style="display:flex;gap:10px;align-items:center">${hbar(s.rem, 1, s.rem < 0.2 ? 'var(--err)' : s.rem < 0.5 ? 'var(--warn)' : 'var(--ok)')}<span class="mono">${pct(s.rem * 100)}</span></div>`, sloStatus(s.rem)];
    }), { num: [2] })}</div><p class="muted small mt16">From <code>sloth_slo_info</code> and the Sloth recording rules.</p>`);
  }
  function incidents() {
    return D.incidents.map(function (i, k) {
      var started = { 'INC-2041': 2 * 1440 + 30, 'INC-2040': 5 * 1440 + 300, 'INC-2042': 140, 'INC-2038': 11 * 1440 }[i.id] || 600;
      var d = new Date(NOW.getTime() - started * 60000);
      return { id: 'INC-' + d.getFullYear() + pad(d.getMonth() + 1) + pad(d.getDate()) + pad(d.getHours()) + pad(d.getMinutes()) + '00', title: i.title, sev: { SEV2: 'P1', SEV3: 'P2', SEV4: 'P3' }[i.sev], service: i.service, started: fmtDate(d), duration: i.status === 'resolved' ? i.duration : '—', state: i.status === 'resolved' ? 'Resolved' : 'Open', pm: i.pm, k: k };
    });
  }
  function pageIncidents() {
    var all = incidents(), list = all.filter(function (i) { return S.incFilter === 'All' || i.sev === S.incFilter; });
    return customPage('tool', 'Incidents', 'Tracked incident records · auto-filed from Alertmanager', html`
      <div class="grid g4">${statCardTop('Open', all.filter(function (i) { return i.state === 'Open'; }).length, '#e53935')}${statCardTop('Awaiting postmortem', all.filter(function (i) { return i.state === 'Resolved' && !i.pm; }).length, '#f57c00')}${statCardTop('MTTR', '58 min', '#1976d2')}${statCardTop('Total records', all.length, '#455a64')}</div>
      <div class="btn-row mt" role="group">${['All', 'P1', 'P2', 'P3'].map(function (f) { return html`<button type="button" class="btn grey ${S.incFilter === f ? 'selected' : ''}" data-action="set" data-key="incFilter" data-value="${f}" aria-pressed="${String(S.incFilter === f)}">${f}</button>`; })}</div>
      <div class="card mt16">${table(['Incident', 'Severity', 'Service', 'Started', 'Duration', 'State'], list.map(function (i) {
        return [html`<span style="color:var(--link)" title="${i.title}">${i.id}</span>`, chip(i.sev, 'sm err-dark'), i.service, i.started, i.duration, html`<span style="color:${raw(i.state === 'Resolved' ? 'var(--ok-text)' : 'var(--err-dark)')}">${i.state}</span>`];
      }))}</div>`);
  }
  function activityEvents() {
    var ev = [];
    incidents().forEach(function (i) { ev.push({ cat: 'Incidents', ic: i.state === 'Resolved' ? '✅' : '🚨', text: html`Incident ${i.state === 'Resolved' ? 'resolved' : 'open'} — <strong>${i.id}</strong> on ${i.service}`, sub: i.sev, when: i.started }); });
    argoApps().filter(function (a) { return a.ns === 'services-dev'; }).slice(0, 8).forEach(function (a) { ev.push({ cat: 'Deployments', ic: '🚀', text: html`<strong>${a.name}</strong> sync ${a.sync === 'Synced' ? 'succeeded' : 'pending'}`, sub: a.ns + ' · · ' + (a.sync === 'Synced' ? 'Succeeded' : 'Running'), when: a.last }); });
    D.activity.forEach(function (a, i) {
      var cat = { scaffold: 'Catalog', ai: 'Catalog', scorecard: 'Scorecard', cost: 'Budget', security: 'Security', deploy: 'Deployments', gitops: 'Deployments', alert: 'Incidents' }[a.kind];
      ev.push({ cat: cat, ic: { Catalog: '📦', Scorecard: '🏆', Budget: '💸', Security: '🔒', Deployments: '🚀', Incidents: '🔔' }[cat], text: html`<strong>${a.target}</strong> — ${a.who} ${a.what}`, sub: a.detail, when: ago([6, 14, 32, 60, 120, 180, 300, 1500, 1600][i] || 30) });
    });
    return ev.sort(function (a, b) { return a.when < b.when ? 1 : -1; });
  }
  function pageActivity() {
    var ev = activityEvents().filter(function (e) { return S.activityFilter === 'All' || e.cat === S.activityFilter; });
    return customPage('tool', 'Activity Feed', 'Platform-wide event stream · real-time', html`
      ${chipButtons('activityFilter', ['All', 'Deployments', 'Incidents', 'Catalog', 'Scorecard', 'Budget', 'Security'], S.activityFilter)}
      <div class="card mt16">${ev.length ? ev.map(function (e) { return html`<div class="list-row"><span class="ic-circle" aria-hidden="true">${e.ic}</span><div style="flex:1;min-width:0">${e.text}<div class="muted small" style="margin-top:4px">${e.sub}</div></div><span class="muted small nowrap">${e.when}</span></div>`; }) : html`<div class="card-body muted">No events for this filter.</div>`}</div>`);
  }
  function pageApiExplorer() {
    var q = S.apiQ.toLowerCase(), list = D.apis.filter(function (a) { return !q || (a.name + ' ' + a.desc).toLowerCase().indexOf(q) >= 0; });
    var open = D.apis.filter(function (a) { return a.name === S.apiOpen; })[0];
    var mcol = { GET: 'ok', POST: 'info', PUT: 'warn', DELETE: 'err', PUB: 'warn', QUERY: 'info' };
    return customPage('tool', 'API Explorer', D.apis.length + ' registered APIs · OpenAPI · AsyncAPI · gRPC', html`
      <div class="outlined-search" style="max-width:520px;margin-bottom:20px">${icon('search', 22)}<label class="sr-only" for="apix-q">Search APIs</label><input id="apix-q" type="search" placeholder="Search APIs…" value="${S.apiQ}" data-bind="apiQ"></div>
      ${open ? html`<section class="card" style="margin-bottom:24px"><div class="card-head"><h2>${open.name}<span class="sub">${open.desc}</span></h2><button type="button" class="btn grey sm" data-action="set" data-key="apiOpen" data-value="">Close ✕</button></div>
        ${table(['Method', 'Path', 'Description', 'Responses'], open.endpoints.map(function (e) { return [chip(e[0], 'sm ' + (mcol[e[0]] || '')), html`<span class="mono">${e[1]}</span>`, e[2], e[0] === 'POST' ? '201 Created · 400 Bad Request' : e[0] === 'GET' ? '200 OK · 404 Not Found' : '—']; }))}</section>` : ''}
      ${list.length ? html`<div class="grid g3">${list.map(function (a) {
        return html`<section class="card"><div class="card-body"><div style="display:flex;justify-content:space-between;gap:8px;align-items:flex-start"><h3 style="font-size:17px">${a.name}</h3>${chip(a.type, 'sm info')}</div>
          <p class="muted" style="margin:8px 0">${a.desc}</p><div class="small muted">${team(a.owner).display} · production · ${a.endpoints.length} operations</div>
          <div class="btn-row mt16"><button type="button" class="btn outlined sm" data-action="set" data-key="apiOpen" data-value="${a.name}">View endpoints</button><a class="btn sm" href="${entityHref('api', a.name)}">Catalog</a></div></div></section>`;
      })}</div>` : html`<div class="card card-body muted">No APIs match your filter.</div>`}
      <p class="muted small mt16">Register an API with a <code>catalog-info.yaml</code> with <code>kind: API</code>.</p>`);
  }
  function pageOnboarding() {
    var st = S.onboarding, steps = [
      ['Set up your profile', html`<div class="field" style="max-width:420px"><label for="ob-name">Display name</label><input class="input" id="ob-name" value="${S.displayName}" data-bind-quiet="displayName"></div><button type="button" class="btn contained" data-action="set" data-key="onboarding" data-value="1">Looks good →</button>`],
      ['Connect GitHub', html`<div class="alert success">✓ GitHub token detected — GITHUB_TOKEN is set in local/.env — scaffold actions are enabled.</div><div class="btn-row"><button type="button" class="btn" data-action="set" data-key="onboarding" data-value="0">← Back</button><button type="button" class="btn contained" data-action="set" data-key="onboarding" data-value="2">Continue →</button></div>`],
      ['Create your first service', html`<p>Use a Golden Path template to scaffold a production-ready service in under 2 minutes.</p><div class="btn-row"><a class="btn contained" href="#/create/templates/default/go-service">Go Service</a><a class="btn outlined" href="#/create/templates/default/python-service">Python Service</a><button type="button" class="btn" data-action="set" data-key="onboarding" data-value="3">Skip for now →</button></div>`],
      ['🎉 You’re all set, ' + (S.displayName || 'there') + '!', html`<p>Here's where to go next:</p><div class="grid g3 gap16">${[['#/catalog', '📚', 'Catalog', 'Browse every service'], ['#/scorecard', '🏆', 'Scorecard', 'Quality tiers across all services'], ['#/ai-assistant', '🤖', 'AI Assistant', 'Ask in plain English']].map(function (l) {
        return html`<a class="card card-body" href="${l[0]}" style="color:var(--text)"><div style="font-size:22px">${l[1]}</div><strong>${l[2]}</strong><div class="muted small">${l[3]}</div></a>`;
      })}</div><div class="btn-row mt16"><a class="btn contained" href="#/">Go to Dashboard →</a></div>`]];
    return html`${pluginBar('custom-pages')}${header('home', 'Welcome to the IDP', 'Let’s get you set up in 4 quick steps')}<div class="content" style="max-width:900px">
      ${steps.map(function (s, i) {
        var active = i === st;
        return html`<section class="card" style="margin-bottom:16px;${raw(active ? '' : 'opacity:.6')}"><div class="card-body"><div class="btn-row">${chip('Step ' + (i + 1) + ' of 4', 'sm ' + (i < st ? 'ok' : i === 3 && active ? 'ok' : 'info'))}<h2 style="font-size:20px">${s[0]}</h2>${i < st ? html`<span class="check-ok">${icon('checkC', 22)}</span>` : ''}</div>${active ? html`<div class="mt16">${s[1]}</div>` : ''}</div></section>`;
      })}</div>`;
  }
  function learningItems() {
    return D.learningTemplates.map(function (l) { var t = tpl(l[0]); return { id: 'tpl:' + l[0], title: t ? t.t : l[0], desc: t ? t.d : '', level: l[1], topic: l[2], type: 'template', href: '#/create/templates/default/' + l[0] }; })
      .concat(D.learningDocs.map(function (d) { return { id: d[0], title: d[1], desc: d[2], level: d[3], topic: d[4], type: 'doc', href: '#/docs/default/system/internal-developer-platform/getting-started' }; }));
  }
  function pageLearning() {
    var items = learningItems(), f = S.learning, done = items.filter(function (i) { return S.done[i.id]; }).length;
    var list = items.filter(function (i) { return (!f.level || i.level === f.level) && (!f.type || i.type === f.type) && (!f.topic || i.topic === f.topic); });
    var topics = []; items.forEach(function (i) { if (topics.indexOf(i.topic) < 0) topics.push(i.topic); });
    var lvlCls = { beginner: 'ok', intermediate: 'warn', advanced: 'err' };
    function facet(label, key, opts) { return html`<div class="flabel" style="font-size:13px;text-transform:uppercase;letter-spacing:.04em;margin:16px 0 8px;color:var(--text-2)">${label}</div><div class="btn-row">${opts.map(function (o) { return html`<button type="button" class="chip flat" data-action="set" data-key="learning.${key}" data-value="${o[0]}" aria-pressed="${String(f[key] === o[0])}">${o[1]}</button>`; })}</div>`; }
    return customPage('tool', 'Learning Center', 'Tutorials and golden-path templates by experience level', html`
      <section class="card"><div class="card-body"><div style="display:flex;justify-content:space-between;gap:8px;align-items:center"><h2 style="font-size:22px">${done} of ${items.length} completed</h2><span class="muted">${Math.round(done / items.length * 100)}%</span></div>
        <div class="bar" style="margin-top:14px"><span style="width:${(done / items.length * 100).toFixed(0)}%;background:var(--primary)"></span></div></div></section>
      <div class="grid mt" style="grid-template-columns:minmax(0,300px) minmax(0,1fr)">
        <section class="card" style="align-self:start"><div class="card-body"><strong>Filter Your Search</strong>
          ${facet('Experience', 'level', [['beginner', 'Beginner'], ['intermediate', 'Intermediate'], ['advanced', 'Advanced']])}${facet('Type', 'type', [['template', 'Template'], ['doc', 'Doc']])}${facet('Topic', 'topic', topics.sort().map(function (t) { return [t, t]; }))}</div></section>
        <div>${list.length ? list.map(function (i) {
          var d = !!S.done[i.id];
          return html`<section class="card" style="margin-bottom:16px"><div class="card-body" style="display:flex;gap:16px">
            <button type="button" class="icon-btn sm ${d ? 'check-ok' : ''}" data-action="toggle-done" data-key="${i.id}" aria-pressed="${String(d)}" aria-label="${(d ? 'Mark not completed: ' : 'Mark completed: ') + i.title}">${icon(d ? 'checkC' : 'checkO', 26)}</button>
            <div style="min-width:0"><div class="btn-row"><h3 style="font-size:18px">${i.title}</h3>${chip(cap(i.level), 'sm ' + lvlCls[i.level])}${chip(i.type === 'template' ? 'Template' : 'Doc', 'sm outlined')}</div>
              <p class="muted" style="margin:8px 0">${i.desc}</p><a href="${i.href}">${i.type === 'template' ? 'View template →' : 'Read doc →'}</a></div></div></section>`;
        }) : html`<div class="card card-body muted">No tutorials match these filters.</div>`}</div></div>`);
  }
  function calcCost() {
    var c = S.calc, cpu = +c.cpu / 1000, mem = +c.mem / 1024, rep = +c.replicas, mult = c.env === 'production' ? 1 : 0.5;
    var k8s = (cpu * 23.5 + mem * 3.2) * rep * mult, ai = +c.ai * 0.0042, obs = 2.5 + rep * 0.8;
    return { k8s: k8s, ai: ai, obs: obs, total: k8s + ai + obs };
  }
  function pageCalculator() {
    var c = S.calc, k = calcCost(), tm = team(D.user.team), after = tm.spend + k.total;
    return customPage('tool', 'Cost Calculator', 'Estimate monthly infrastructure cost before deploying', html`<div class="grid g2">
      ${cardBody('Service Configuration', html`${selectField('Service Type', 'c-svc', 'calc.svc', [['web', 'Web service (HTTP/gRPC)'], ['worker', 'Background worker'], ['cron', 'Cron job'], ['ml', 'ML inference server']], c.svc)}
        ${selectField('CPU Request', 'c-cpu', 'calc.cpu', [['250', '250m'], ['500', '500m'], ['1000', '1 vCPU'], ['2000', '2 vCPU']], c.cpu)}
        ${selectField('Memory Request', 'c-mem', 'calc.mem', [['256', '256 Mi'], ['512', '512 Mi'], ['1024', '1 Gi'], ['2048', '2 Gi']], c.mem)}
        ${selectField('Replicas', 'c-rep', 'calc.replicas', ['1', '2', '3', '4', '6'], c.replicas)}
        ${selectField('AI API calls / month', 'c-ai', 'calc.ai', [['0', 'None'], ['1000', '1,000'], ['10000', '10,000'], ['100000', '100,000']], c.ai)}
        ${selectField('Environment', 'c-env', 'calc.env', [['production', 'Production'], ['staging', 'Staging']], c.env)}`)}
      <div class="grid" style="align-content:start">
        ${cardBody('Estimated Monthly Cost', html`${table(['Item', 'Monthly'], [['Kubernetes (OpenCost est.)', money(k.k8s)], ['AI API (Claude Sonnet)', money(k.ai)], ['Observability (Loki, Tempo)', money(k.obs)], [html`<strong>Total</strong>`, html`<strong>${money(k.total)}</strong>`]], { num: [1], cls: 'plain' })}`)}
        ${cardBody('vs Team Budget', html`<div class="muted small" style="margin-bottom:8px">${tm.display} · demo data</div>${hbar(after, tm.budget, after > tm.budget ? 'var(--err)' : after > tm.budget * 0.8 ? 'var(--warn)' : 'var(--ok)')}
          <p class="small" style="margin-top:8px">This service: <strong>${money(k.total)}</strong> · team after deploy: <strong>${money(after, 0)}</strong> of ${money(tm.budget, 0)} (${pct(after / tm.budget * 100, 0)})</p>`)}
      </div></div>`);
  }
  function pageProfile() {
    var mine = D.components.filter(function (c) { return c.owner === D.user.team; });
    return customPage('home', 'My Profile', 'arivera@moatazeldebsy.dev', html`<div class="grid" style="grid-template-columns:minmax(0,1fr) minmax(0,2fr)">
      <section class="card"><div class="card-body" style="text-align:center"><div class="avatar lg" style="margin:8px auto 12px">${initials(S.displayName)}</div><h2 style="font-size:22px">${S.displayName}</h2>
        <div class="btn-row" style="justify-content:center;margin:8px 0">${chip(D.user.team, 'sm')}${chip('admin', 'sm primary')}</div><a class="btn outlined" href="#/settings">Edit Profile</a></div></section>
      <div class="grid">
        ${cardBody('Stats', html`<div class="grid g4 gap16">${[[mine.length, 'Services owned'], [D.apis.filter(function (a) { return a.owner === D.user.team; }).length, 'APIs owned'], [1, 'Teams'], [37, 'Deploys this month']].map(function (s) { return html`<div><div style="font-size:28px;color:var(--c1)">${s[0]}</div><div class="muted small">${s[1]}</div></div>`; })}</div>`)}
        ${cardBody('Owned Entities', html`${mine.map(function (c) { return html`<a class="chip sm outlined" href="${entityHref('component', c.name)}">${c.name}</a>`; })}`)}
        ${cardBody('Recent Activity', html`${activityEvents().slice(0, 5).map(function (e) { return html`<div class="list-row" style="padding:10px 0"><span class="ic-circle" aria-hidden="true">${e.ic}</span><div style="flex:1">${e.text}<div class="muted small">${e.when}</div></div></div>`; })}`)}
      </div></div>`);
  }
  function searchCorpus() {
    var out = [];
    D.components.forEach(function (c) { out.push({ type: 'Component', title: c.name, sub: 'Component · group:default/' + c.owner + ' · ' + c.lifecycle + ' · ' + c.type + ' — ' + c.desc, href: entityHref('component', c.name), life: c.lifecycle, text: c.name + ' ' + c.desc + ' ' + c.tags.join(' ') }); });
    D.apis.forEach(function (a) { out.push({ type: 'API', title: a.name, sub: 'API · group:default/' + a.owner + ' · ' + a.type + ' — ' + a.desc, href: entityHref('api', a.name), text: a.name + ' ' + a.desc }); });
    D.docs.forEach(function (d) { out.push({ type: 'TechDocs', title: d.title, sub: 'TechDocs · Internal Developer Platform', href: '#/docs/default/system/internal-developer-platform/' + d.id, text: d.title + ' ' + JSON.stringify(d.body) }); });
    D.templates.forEach(function (t) { out.push({ type: 'Template', title: t.t, sub: 'Template · ' + t.type + ' — ' + t.d, href: '#/create/templates/default/' + t.n, text: t.n + ' ' + t.t + ' ' + t.d + ' ' + t.tags.join(' ') }); });
    return out;
  }
  function searchResults(q) {
    q = q.trim().toLowerCase();
    if (!q) return [];
    return searchCorpus().filter(function (r) { return r.text.toLowerCase().indexOf(q) >= 0 || r.title.toLowerCase().indexOf(q) >= 0; });
  }
  function highlight(text, q) {
    var i = q ? text.toLowerCase().indexOf(q.toLowerCase()) : -1;
    return i < 0 ? html`${text}` : html`${text.slice(0, i)}<mark class="mark">${text.slice(i, i + q.length)}</mark>${text.slice(i + q.length)}`;
  }
  function pageSearchCustom() {
    var res = searchResults(S.searchQ), types = ['Component', 'API', 'TechDocs', 'Template'];
    var shown = res.filter(function (r) { return S.searchType === 'all' || r.type === S.searchType; });
    return customPage('tool', 'Search', 'Find services, APIs, docs, and templates across the platform', html`<div style="max-width:800px;margin:0 auto">
      <div class="outlined-search">${icon('search', 22)}<label class="sr-only" for="gs-q">Search</label><input id="gs-q" type="search" placeholder="Search services, APIs, docs, templates…" value="${S.searchQ}" data-bind="searchQ"></div>
      <div class="btn-row mt16">${[['all', 'All (' + res.length + ')']].concat(types.map(function (t) { return [t, t + ' (' + res.filter(function (r) { return r.type === t; }).length + ')']; })).map(function (o) {
        return html`<button type="button" class="chip" data-action="set" data-key="searchType" data-value="${o[0]}" aria-pressed="${String(S.searchType === o[0])}">${o[1]}</button>`;
      })}</div>
      ${types.map(function (t) {
        var g = shown.filter(function (r) { return r.type === t; });
        if (!g.length) return '';
        return html`<div class="small" style="text-transform:uppercase;letter-spacing:.06em;font-weight:700;color:var(--text-2);margin:28px 0 10px">${t}</div>${g.slice(0, 8).map(function (r) {
          return html`<a class="card" href="${r.href}" style="display:flex;gap:16px;align-items:center;padding:14px 18px;margin-bottom:10px;color:var(--text)"><span class="ic-circle">${icon(t === 'API' ? 'extension' : t === 'TechDocs' ? 'docs' : t === 'Template' ? 'library' : 'wrench', 20)}</span>
            <div style="flex:1;min-width:0"><div style="font-size:16px">${highlight(r.title, S.searchQ)}</div><div class="muted small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.sub}</div></div>${r.life ? lifecycleChip(r.life) : ''}</a>`;
        })}`;
      })}
      ${S.searchQ && !res.length ? html`<p class="muted mt">No results for "${S.searchQ}".</p>` : ''}</div>`);
  }
  function pageSearchStock() {
    var res = searchResults(S.searchQ);
    return html`${pluginBar('Search', 'search')}${header('home', 'Search')}<div class="content">
      <div class="outlined-search" style="margin-bottom:24px">${icon('search', 22)}<label class="sr-only" for="ss-q">Search in Backstage</label><input id="ss-q" type="search" placeholder="Search in Backstage" value="${S.searchQ}" data-bind="searchQ"></div>
      <div class="catalog-layout"><div class="filters"><div class="flabel">Result Type</div>${[['all', 'All'], ['Component', 'Software Catalog'], ['TechDocs', 'Documentation'], ['Template', 'Templates']].map(function (o) {
        return html`<button type="button" class="uf-item" data-action="set" data-key="searchType" data-value="${o[0]}" aria-pressed="${String(S.searchType === o[0])}"><span>${o[1]}</span></button>`;
      })}</div>
      <section class="card">${res.filter(function (r) { return S.searchType === 'all' || r.type === S.searchType || (S.searchType === 'Component' && r.type === 'API'); }).slice(0, 20).map(function (r) {
        return html`<div class="list-row"><div><a href="${r.href}" style="font-size:16px">${r.title}</a><div class="muted small" style="margin-top:4px">${r.sub}</div></div></div>`;
      })}${!res.length ? html`<div class="card-body muted">Type a query to search the catalog, docs and templates.</div>` : ''}</section></div></div>`;
  }
  function pageAdmin() {
    var users = [['Marcus Chen', 'marcus.chen@idp.local', 'backend-team', 'member'], ['Guest', '', 'platform-team', 'member'], ['Priya Nair', 'priya.nair@idp.local', 'ml-team', 'member'], ['Lena Fischer', 'lena.fischer@idp.local', 'android-team', 'member'],
      ['Alex Rivera', 'alex.rivera@idp.local', 'platform-team', 'admin'], ['Kenji Watanabe', 'kenji.watanabe@idp.local', 'ios-team', 'member'], ['Amara Okafor', 'amara.okafor@idp.local', 'qa-team', 'member']];
    var plugins = [['Catalog', '1.12.0'], ['Scaffolder', '1.19.0'], ['TechDocs', '1.9.0'], ['Kubernetes', '0.11.0'], ['PagerDuty', '0.8.0'], ['Search', '1.5.0'], ['Tech Insights', '0.3.0']];
    return customPage('tool', 'Admin', 'Platform configuration · user management · plugin settings', html`<div class="alert warning">⚠ Admin panel — changes here affect all users on the platform.</div>
      <div class="grid g2">
        ${card('Users', table(['Name', 'Team', 'Role', ''], users.map(function (u) { return [html`<div>${u[0]}</div>${u[1] ? html`<div class="muted small">${u[1]}</div>` : ''}`, chip(u[2], 'sm'), chip(u[3], 'sm'), html`<span class="btn sm" aria-disabled="true">Edit</span>`]; })), html`<span class="btn contained sm" aria-disabled="true">+ Invite user</span>`)}
        ${card('Plugins', table(['Plugin', 'Version', 'Status', ''], plugins.map(function (p) { return [p[0], html`<span class="mono">${p[1]}</span>`, chip('enabled', 'sm ok'), html`<span class="btn sm" aria-disabled="true">Config</span>`]; })))}
      </div>
      <div class="mt">${card('Catalog Providers', table(['Provider', 'Target', 'Schedule', 'Entities'], [['GitHub repo discovery', 'github.com/moatazeldebsy (topic: idp)', 'every 30 min', String(D.components.length + D.apis.length)], ['GitHub Org Team sync', 'github.com/moatazeldebsy', 'every 60 min', String(D.teams.length)]], { num: [3] }), null, 'configured entity providers · live entity counts')}</div>`);
  }
  var BUILTIN_AGENTS = ['argo-rollouts-conversion-agent', 'cilium-debug-agent', 'cilium-manager-agent', 'cilium-policy-agent', 'helm-agent', 'istio-agent', 'k8s-agent', 'kgateway-agent', 'observability-agent', 'promql-agent'];
  function pageKagent() {
    var r = rng('kagent');
    var rows = D.agents.map(function (a) { return { name: a.name, model: a.model, mcp: ['ai-gateway'], tools: a.tools.length, calls: Math.floor(r() * 1900), lat: num(1 + r() * 3, 1) + 's', ready: a.ready }; })
      .concat(BUILTIN_AGENTS.map(function (n) { return { name: n, model: 'default-model-config', mcp: ['kagent-tool-server'], tools: 5 + (hash(n) % 16), calls: 0, lat: '—', ready: true }; }))
      .sort(function (a, b) { return a.name.localeCompare(b.name); });
    var ready = rows.filter(function (a) { return a.ready; }), calls = rows.reduce(function (s, a) { return s + a.calls; }, 0);
    var used = {}; D.agents.forEach(function (a) { used[a.model] = true; });
    return customPage('tool', 'KAgent', 'Kubernetes AI agents · namespace: kagent · ' + ready.length + ' agents running', html`
      <div class="grid g3">${statCardTop('Agents Running', ready.length, '#43a047', ready.map(function (a) { return a.name; }).join(', '))}${statCardTop('MCP Tool Calls (24h)', num(calls), '#1976d2', 'across all agents')}${statCardTop('Avg Response', '2.1s', '#8e24aa', 'p50 · p95: 6.4s')}</div>
      <div class="mt">${card('Agents', table(['Name', 'Model', 'MCP Servers', 'Tools', 'Calls (24h)', 'Avg Latency', 'Status'], rows.map(function (a) {
        return [a.name, html`<span class="mono small">${a.model}</span>`, a.mcp.map(function (m) { return chip(m, 'sm'); }), html`<span class="mono">${a.tools}</span>`, html`<span class="mono">${a.calls}</span>`, a.lat, status(a.ready ? 'Ready' : 'Not ready')];
      }), { num: [3, 4] }), html`<div class="btn-row"><span class="btn outlined sm grey" aria-disabled="true">Open KAgent UI ↗</span><a class="btn contained sm" href="#/create/templates/default/ai-agent-kagent">+ Deploy agent</a></div>`)}</div>
      <div class="grid g2 mt">
        ${card('MCP Servers', table(['Server', 'Tools', 'Namespace', 'Status'], D.mcpServers.map(function (s) { return [s.name, String(s.tools.length), html`<span class="mono">services-dev</span>`, status(s.health)]; }), { num: [1] }))}
        ${card('ModelConfigs', table(['Name', 'Provider', 'Model', 'Status'], D.modelConfigs.map(function (m) { return [m.name, m.provider, html`<span class="mono small">${m.model}</span>`, chip(used[m.name] ? 'active' : 'inactive', 'sm dot ' + (used[m.name] ? 'ok' : ''))]; })))}
      </div>`);
  }
  function pageLangfuse() {
    var tr = D.traces, models = [['claude-sonnet-4-6', 1840210, 214330, 9.21], ['claude-haiku-4-5-20251001', 920110, 120400, 1.38], ['claude-sonnet-bedrock', 310200, 41020, 1.72]];
    return customPage('tool', 'AI Observability', 'LLM tracing · cost · latency · powered by Langfuse · 3,912 traces (7d)', html`
      <div class="grid g4">${statCardTop('Traces', '3,912', '#1976d2', 'last 7 days')}${statCardTop('Observations', '18,204', '#43a047', 'spans + generations')}${statCardTop('LLM Cost', '$12.31', '#8e24aa', 'last 7 days')}${statCardTop('Models', models.length, '#f57c00', 'with usage')}</div>
      <div class="mt">${card('Usage by model (7 days)', table(['Model', 'Input units', 'Output units', 'Cost'], models.map(function (m) { return [html`<span class="mono">${m[0]}</span>`, num(m[1]), num(m[2]), money(m[3])]; }), { num: [1, 2, 3] }), html`<span class="btn outlined sm" aria-disabled="true">Open Langfuse ↗</span>`)}</div>
      <div class="mt">${card('Recent agent runs', table(['Trace', 'Agent', 'User', 'Latency', 'Cost', 'When'], tr.map(function (t) {
        return [html`<span class="mono">${t.id}</span>`, t.name.split(' · ')[0], t.user === 'svc' ? '—' : 'user:default/' + t.user, num(t.latency, 1) + 's', money(t.cost, 4), t.t];
      })))}</div>`);
  }
  function pageLitellm() {
    var total = D.litellmKeys.reduce(function (s, k) { return s + k.spend; }, 0), r = rng('llm'), log = [];
    for (var i = 0; i < 10; i++) { var k = D.litellmKeys[i % D.litellmKeys.length], tok = Math.floor(400 + r() * 6000); log.push([html`<span class="mono">chatcmpl-${hash('l' + i).toString(16).slice(0, 10)}</span>`, html`<span class="mono small">${k.model}</span>`, num(tok), money(tok * 0.0000062, 4), (i * 3 + 1) + ' min ago', k.alias]); }
    return customPage('tool', 'LiteLLM Spend', 'Multi-provider LLM spend (Anthropic + Bedrock) · virtual keys & budgets · ' + money(total) + ' total', html`
      <div class="grid g3">${statCardTop('Total spend', money(total), '#8e24aa', 'all virtual keys')}${statCardTop('Recent calls', '1,284', '#1976d2', 'last 24 hours')}${statCardTop('Virtual keys', D.litellmKeys.length, '#43a047', D.litellmKeys.filter(function (k) { return k.spend / k.budget > 0.8; }).length + ' above 80% of budget')}</div>
      <div class="mt">${card('Recent spend log', table(['Request', 'Model', 'Tokens', 'Spend', 'When', 'Key alias'], log, { num: [2, 3] }))}</div>`);
  }
  function pageMlflow() {
    var runs = [];
    D.mlflow.forEach(function (e) { e.runs.forEach(function (r) { runs.push([e, r]); }); });
    var models = [];
    runs.forEach(function (x) { if (x[1].registered) models.push([x[0].name + '-model', x[1].registered.split(' · ')[0].replace('v', ''), x[1].registered.split(' · ')[1], x[1].started]); });
    function metricStr(m) { return Object.keys(m).slice(0, 2).map(function (k) { return k + ' ' + num(m[k], 3); }).join(' · '); }
    return customPage('tool', 'MLflow', 'Experiment tracking · model registry · namespace: ml-platform · ' + D.mlflow.length + ' experiments', html`
      <div class="grid g3">${statCardTop('Experiments', D.mlflow.length, '#1976d2')}${statCardTop('Runs', runs.length, '#43a047')}${statCardTop('Registered Models', models.length, '#8e24aa')}</div>
      <div class="mt">${card('Experiments', table(['Name', 'Recent runs', 'Last run', 'Latest metric', 'Artifacts'], D.mlflow.map(function (e, i) {
        return [html`<strong>${e.name}</strong>`, String(e.runs.length), e.runs[0].started, metricStr(e.runs[0].metrics), html`<span class="mono small">mlflow-artifacts:/${i + 2}</span>`];
      })), html`<span class="btn outlined sm" aria-disabled="true">Open MLflow ↗</span>`)}</div>
      <div class="grid g2 mt">
        ${card('Registered Models', table(['Model', 'Latest version', 'Stage', 'Updated'], models.map(function (m) { return [m[0], m[1], chip(m[2], 'sm ' + (m[2] === 'Production' ? 'ok' : 'info')), m[3]]; })))}
        ${card('Recent Runs', table(['Run', 'Experiment', 'Status', 'Duration', 'Metrics'], runs.slice(0, 6).map(function (x) { return [html`<span class="mono small">${x[1].name}</span>`, x[0].name, status(x[1].status), x[1].dur, html`<span class="small">${x[1].status === 'FAILED' ? '—' : metricStr(x[1].metrics)}</span>`]; })))}
      </div>`);
  }
  function pageSupport() {
    var links = [['🏅', 'Scorecard', '#/scorecard'], ['📈', 'DORA', '#/dora'], ['💸', 'Cost Overview', '#/finops'], ['📚', 'Docs', '#/docs'], ['🤖', 'AI Assistant', '#/ai-assistant'], ['🧭', 'Learning Center', '#/learning-center']];
    return customPage('home', 'Support', 'Platform Engineering team · #platform-support on Slack', html`<div class="grid g2">
      ${cardBody('Get Help', html`${[['💬', 'Ask in #platform-support', 'Slack · answered within 4 business hours'], ['🐛', 'Open an issue', 'github.com/moatazeldebsy/backstage-platform-template/issues'], ['🤖', 'Ask the AI Assistant', 'Catalog, metrics, scaffolding and costs']].map(function (h) {
        return html`<div class="list-row" style="padding:12px 0"><span class="ic-circle">${h[0]}</span><div><strong>${h[1]}</strong><div class="muted small">${h[2]}</div></div></div>`;
      })}`)}
      ${cardBody('Platform Team On-Call', html`${table(['', ''], [['Current on-call', 'Alex Rivera'], ['Rotation', 'Weekly, Monday 09:00 UTC'], ['Response SLA', '15 min (P1) · 4 h (P2)'], ['Escalation', 'Priya Nair → Marcus Chen']], { cls: 'plain' })}<span class="btn outlined sm mt16" aria-disabled="true">PagerDuty ↗</span>`)}
      ${cardBody('Useful Links', html`<div class="grid g2 gap16">${links.map(function (l) { return html`<a href="${l[2]}">${l[0]} ${l[1]}</a>`; })}</div>`)}
      ${cardBody('Recent Platform Announcements', html`${ANNOUNCEMENTS.slice(0, 3).map(function (a, i) {
        return html`<div style="border-left:4px solid ${raw(['#1976d2', '#4caf50', '#ff9800'][i])};padding:4px 12px;margin-bottom:12px"><strong>${a[0]}</strong><div class="muted small">${a[1]} · ${a[2]}</div></div>`;
      })}`)}
    </div>`);
  }
  function pageFinops() {
    var ns = [['ml-platform', 3.589, 2.488, 0, 31], ['monitoring', 4.188, 1.495, 0, 41], ['kagent', 4.056, 1.39, 0, 24], ['kube-system', 1.92, 0.88, 0.04, 61], ['services-dev', 1.41, 0.96, 0.12, 42], ['argocd', 1.02, 0.41, 0, 38], ['crossplane-system', 0.62, 0.3, 0, 55], ['kyverno', 0.41, 0.22, 0, 48]];
    var mult = { day: 1 / 7, week: 1, month: 4.3 }[S.finops.range];
    var rows = ns.map(function (n) { return { name: n[0], cpu: n[1] * mult, ram: n[2] * mult, pv: n[3] * mult, eff: n[4], total: (n[1] + n[2] + n[3]) * mult }; }).sort(function (a, b) { return b.total - a.total; });
    var total = rows.reduce(function (s, r) { return s + r.total; }, 0), days = S.finops.range === 'day' ? 1 : 7, labels = dayLabels(days);
    var layers = rows.map(function (r, i) { var v = series('fo' + r.name, days, r.total / days, r.total / days * 0.2); if (days === 7) { v[0] = v[1] = v[2] = 0; var s = v.reduce(function (a, b) { return a + b; }, 0) || 1; v = v.map(function (x) { return x * r.total / s; }); } return { name: r.name, values: v, color: 'var(--c' + (i + 1) + ')' }; });
    return customPage('tool', 'FinOps — Cost Overview', 'Kubernetes spend · powered by OpenCost', html`
      <div style="display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap;align-items:flex-start">
        <div class="btn-row" style="gap:32px;align-items:flex-start"><div><div class="flabel" style="margin-bottom:8px">Date Range</div>${chipButtons('finops.range', [['day', 'Last 24h'], ['week', 'Last Week'], ['month', 'Last Month']], S.finops.range)}</div>
          <div><div class="flabel" style="margin-bottom:8px">Breakdown</div>${chipButtons('finops.by', [['namespace', 'Namespace'], ['team', 'Team'], ['container', 'Container']], S.finops.by)}</div></div>
        <div class="card" style="padding:14px 24px;text-align:center"><div style="font-size:26px;color:#1976d2;font-weight:700">${money(total)}</div><div class="muted small">Total Cost (USD)</div></div></div>
      <div class="mt">${cardBody('Spend Over Time by ' + cap(S.finops.by), S.finops.range === 'month' ? lineChart([{ name: 'Daily cost', values: series('fo-m', 30, total / 30, total / 30 * 0.2) }], { labels: dayLabels(30), yFmt: function (v) { return '$' + num(v, 1); }, label: 'Daily spend' }) : stackedBars(labels, layers, { label: 'Spend over time' }))}</div>
      <div class="card mt">${table(['Name', 'Cost breakdown', 'CPU', 'RAM', 'PV', 'Efficiency', 'Total Cost'], rows.map(function (r, i) {
        return [html`<span style="display:inline-flex;gap:8px;align-items:center"><i style="width:10px;height:10px;display:inline-block;background:${raw('var(--c' + (i + 1) + ')')}"></i>${r.name}</span>`,
          html`<div style="display:flex;width:200px;height:28px;border-radius:2px;overflow:hidden"><span style="flex:${r.cpu.toFixed(3)};background:#3878d1"></span><span style="flex:${r.ram.toFixed(3)};background:#4c9a3f"></span><span style="flex:${(r.pv || 0.001).toFixed(3)};background:#e8a33c"></span></div>`,
          money(r.cpu, 3), money(r.ram, 3), money(r.pv, 3), html`<span style="color:${raw(r.eff < 40 ? 'var(--err-dark)' : 'var(--ok-text)')}">${r.eff}%</span>`, html`<strong>${money(r.total, 3)}</strong>`];
      }).concat([[html`<strong>Totals</strong>`, '', '', '', '', '', html`<strong>${money(total, 3)}</strong>`]]), { num: [2, 3, 4, 5, 6] })}</div>`);
  }
  function pageAISearch() {
    var q = S.aiQuery.toLowerCase(), words = q.split(/\W+/).filter(function (w) { return w.length > 2; });
    var res = D.aiSearchCorpus.map(function (d) {
      var hay = (d.title + ' ' + d.text).toLowerCase(), hits = words.filter(function (w) { return hay.indexOf(w) >= 0 || hay.indexOf(w.replace(/s$/, '')) >= 0; }).length;
      return { d: d, score: words.length ? 0.55 + 0.4 * hits / words.length + rng(d.title + q)() * 0.04 : 0 };
    }).filter(function (r) { return r.score > 0.6; }).sort(function (a, b) { return b.score - a.score; }).slice(0, 6);
    return customPage('tool', 'AI Search', 'Semantic search powered by Voyage AI + pgvector', html`
      <form data-submit="noop" style="display:flex;gap:8px;align-items:center;max-width:820px"><div class="outlined-search" style="flex:1">${icon('search', 22)}<label class="sr-only" for="ai-q">Search by intent</label><input id="ai-q" type="search" placeholder="Search by intent, e.g. how do I roll back a deployment" value="${S.aiQuery}" data-bind="aiQuery"></div>
        <button type="button" class="icon-btn" data-action="noop" title="Re-index catalog entities and external sources" aria-label="Re-index catalog entities and external sources">${icon('refresh')}</button></form>
      <div class="btn-row mt16">${['how do I roll back a deployment', 'request an s3 bucket', 'slo error budget', 'who handles payments', 'load testing'].map(function (s) { return html`<button type="button" class="chip flat" data-action="set" data-key="aiQuery" data-value="${s}" aria-pressed="${String(S.aiQuery === s)}">${s}</button>`; })}</div>
      <div class="mt" style="max-width:820px">${res.length ? res.map(function (r) {
        return html`<a class="card" href="${r.d.href}" style="display:block;padding:14px 18px;margin-bottom:10px;color:var(--text)"><div style="display:flex;justify-content:space-between;gap:12px"><strong style="font-size:16px">${r.d.title}</strong>${chip('similarity ' + num(r.score, 2), 'sm outlined')}</div>
          <div class="muted small" style="margin-top:4px">${r.d.kind} · …${r.d.text}…</div></a>`;
      }) : html`<p class="muted">No results above the similarity threshold.</p>`}</div>`);
  }
  function pageApprovals() {
    var list = S.approvals.filter(function (a) { return S.approvalsFilter === 'all' || a.status === 'pending'; });
    var col = { pending: 'primary', approved: 'secondary', denied: '' };
    return customPage('tool', 'Agent Approvals', 'Human-in-the-loop gate for agent-initiated mutating actions', html`
      <div class="btn-row" style="margin-bottom:16px"><button type="button" class="btn grey ${S.approvalsFilter === 'pending' ? 'selected' : ''}" data-action="set" data-key="approvalsFilter" data-value="pending" aria-pressed="${String(S.approvalsFilter === 'pending')}">Pending only</button>
        <button type="button" class="btn grey ${S.approvalsFilter === 'all' ? 'selected' : ''}" data-action="set" data-key="approvalsFilter" data-value="all" aria-pressed="${String(S.approvalsFilter === 'all')}">All (last 100)</button>
        <button type="button" class="icon-btn" data-action="noop" aria-label="Refresh" title="Refresh">${icon('gavel')}</button></div>
      ${list.length ? list.map(function (a) {
        return html`<section class="card" style="margin-bottom:12px"><div class="card-body"><div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;align-items:center">
            <div class="btn-row">${chip(a.status, 'sm ' + col[a.status])}<span>${a.agent} → <span class="mono">${a.tool}</span> on <span class="mono">${a.target}</span></span></div><span class="muted small">requested ${a.requested}</span></div>
          <div class="muted" style="margin:12px 0 8px">${JSON.stringify({ reason: a.reason })}</div>
          ${a.status === 'pending' ? html`<div class="small muted" style="margin-bottom:10px">${a.policy || ''}</div><div class="btn-row"><button type="button" class="btn contained sm" data-action="decide" data-key="${a.id}" data-value="approved">Approve</button><button type="button" class="btn outlined sm" data-action="decide" data-key="${a.id}" data-value="denied">Deny</button></div>`
            : html`<div class="muted small">${a.status} by ${a.decided_by} at ${a.decided}</div>`}</div></section>`;
      }) : html`<div class="card card-body muted">No approval requests${S.approvalsFilter === 'pending' ? ' pending' : ''}.</div>`}`);
  }
  function pageCopilot() {
    var c = D.copilot, n = 28, act = series('cp-act', n, c.active, 4, 0.1), eng = act.map(function (v, i) { return v * (0.62 + 0.05 * Math.sin(i / 3)); }), acc = series('cp-acc', n, c.acceptance, 2.2, 0.12);
    var seatsTotal = c.seats, cost = seatsTotal * 19;
    return customPage('tool', 'GitHub Copilot Metrics', 'Developer productivity via AI assistance', html`
      <div class="btn-row" style="margin-bottom:16px">${demoChip()}<span class="muted small">Set <code>GITHUB_TOKEN</code> with <code>read:org</code> and <code>manage_billing:copilot</code> to load live metrics.</span></div>
      <div class="grid g4">${statCardTop('Active Users (latest day)', Math.round(act[n - 1]), '#1976d2')}${statCardTop('Engaged Users (latest day)', Math.round(eng[n - 1]), '#43a047')}${statCardTop('Lines Accepted (latest day)', num(1490), '#8e24aa')}${statCardTop('Acceptance Rate', pct(acc[n - 1]), '#f57c00')}</div>
      <div class="grid g2 mt">${cardBody('Active vs Engaged Users (last ' + n + ' days)', lineChart([{ name: 'Active users', values: act, color: '#1976d2' }, { name: 'Engaged users', values: eng, color: '#43a047' }], { labels: dayLabels(n), label: 'Active vs engaged users' }))}
        ${cardBody('Acceptance Rate Trend', lineChart([{ name: 'Acceptance %', values: acc, color: '#f57c00' }], { labels: dayLabels(n), min: 20, max: 40, label: 'Acceptance rate' }))}</div>
      <div class="grid g2 mt">${card('Usage by Language', table(['Language', 'Acceptance rate', ''], c.languages.map(function (l) { return [l[0], pct(l[1]), hbar(l[1], 45, '#1976d2')]; }), { num: [1] }))}
        ${card('Code Completions by Editor (latest day)', table(['Editor', 'Suggestions', 'Acceptances', 'Rate'], [['VS Code', 1420, 471, '33.2%'], ['JetBrains', 610, 172, '28.2%'], ['Neovim', 88, 27, '30.7%']], { num: [1, 2, 3] }))}</div>
      <div class="grid g2 mt">${card('Seat Utilization by Team', table(['Team', 'Seats', 'Acceptance'], c.teams.map(function (t) { return [t[0], t[1], pct(t[2])]; }), { num: [1, 2] }))}
        ${cardBody('Cost / ROI', table(['', ''], [['Seats', String(seatsTotal)], ['Monthly cost', money(cost, 0) + ' ($19/seat)'], ['Active seats', c.active + ' (' + pct(c.active / seatsTotal * 100, 0) + ')'], ['Est. hours saved / month', '≈ 410 h']], { cls: 'plain' }))}</div>`);
  }
  function eiScores() {
    var avg = function (i) { return Math.round(D.teams.reduce(function (s, t) { return s + D.teamScores[t.name][i]; }, 0) / D.teams.length); };
    return [['Platform', avg(1)], ['Developer Experience', avg(4)], ['Quality', avg(0)], ['Reliability', avg(2)], ['AI', avg(5)], ['Security', avg(3)], ['FinOps', 64]];
  }
  function pageEI() {
    var sc = eiScores(), col = function (v) { return v >= 75 ? '#43a047' : v >= 60 ? '#1976d2' : v >= 45 ? '#f57c00' : '#e53935'; };
    return html`${pluginBar('engineering-intelligence', 'insights')}${header('tool', 'Engineering Intelligence', 'Platform, Developer Experience, Quality, Reliability, AI, Security and FinOps health — scored from the platform’s own telemetry')}<div class="content">
      <section class="card"><div class="card-body" style="display:flex;gap:20px;align-items:center;flex-wrap:wrap"><div class="tier-badge" style="background:#1976d2;font-size:30px;font-weight:700">L3</div>
        <div><h2 style="font-size:24px">Level 3 — Platform Enabled</h2><div class="muted">Platform ≥ 70, Quality ≥ 65 and Reliability ≥ 65 are met. Level 4 needs AI ≥ 65 (currently ${sc[4][1]}).</div></div></div></section>
      <div class="grid g4 mt">${sc.map(function (s) { return statCardTop(s[0], s[1], col(s[1]), s[1] >= 60 ? 'healthy' : 'needs attention'); })}</div>
      <div class="mt">${card('Platform Health', table(['Metric', 'Observed', 'Score', 'Impact', 'Source'], [
        ['Services', String(D.components.length), '82', 'Catalog coverage', 'Catalog'], ['Ownership', '100% of components', '100', 'Every component has an owner', 'Catalog'],
        ['Golden path', '71% from templates', '71', 'Scaffolded vs hand-rolled', 'Scaffolder'], ['Self-service', '64 template runs (30 d)', '78', 'No ticket needed', 'Scaffolder'],
        ['Deploy frequency', '41/day', '90', 'DORA speed', 'DORA exporter'], ['Change failure rate', '6.4%', '76', 'DORA stability', 'DORA exporter']], { num: [2] }))}</div>
      <div class="grid g2 mt">${cardBody('AI Evaluation', table(['Assertions', 'Passed', 'Failed'], [['412', '398', '14']], { num: [0, 1, 2] }))}${cardBody('AI Spend', table(['Total', 'Attributed'], [[money(D.litellmKeys.reduce(function (s, k) { return s + k.spend; }, 0)), '96%']]))}</div></div>`;
  }
  function pageCore4() {
    return html`${pluginBar('engineering-intelligence', 'insights')}${header('tool', 'DX Core 4', 'Speed, Effectiveness, Quality and Impact — system metrics and the DevEx survey, read together')}<div class="content">
      <div class="grid g4">${D.core4.map(function (c) {
        return html`<div class="card stat" style="border-top-color:var(--c1)"><div class="lab-top">${c.area}</div><div class="num">${c.value}</div><div class="lab" style="font-size:13px">${c.metric}</div>
          <div class="desc"><span style="color:${raw(c.good ? 'var(--ok-text)' : 'var(--err-dark)')}">${c.good ? '▲' : '▼'} from ${c.prev}</span> · ${c.secondary}</div></div>`;
      })}</div>
      <div class="mt">${card('By team', table(['Team', 'Engineers', 'PRs / engineer / week', 'Survey responses', 'Experience index', 'Time on new capabilities'], D.teams.map(function (t) {
        var r = rng('c4' + t.name); return [t.name, t.members, num(2.4 + r() * 2.6, 1), Math.max(3, t.members - Math.floor(r() * 3)), Math.round(58 + r() * 24), pct(40 + r() * 25, 0)];
      }), { num: [1, 2, 3, 4, 5] }), html`<a class="btn outlined sm" href="#/devex-survey">Answer the survey</a>`)}</div></div>`;
  }
  function pageSurvey() {
    var opts = ['Strongly disagree', 'Disagree', 'Neutral', 'Agree', 'Strongly agree'];
    return html`${pluginBar('devex-survey', 'feedback')}${header('tool', 'DevEx Survey', 'About five minutes. Anonymous, and only ever reported as team averages.')}<div class="content" style="max-width:960px">
      ${S.surveySent ? html`<div class="alert success">Thanks — your answers were recorded (in this demo, only in this browser tab). See the results on <a href="#/core4">DX Core 4</a>.</div>` : html`
      <section class="card"><div class="card-head"><h2>Q4 2026 DevEx survey<span class="sub">Open until Dec 4 · 142 responses so far</span></h2></div><form class="card-body" data-submit="survey" style="padding-top:0">
        ${selectField('Answer as a member of', 's-team', 'surveyTeam', D.teams.map(function (t) { return [t.name, t.display]; }), S.surveyTeam)}
        ${D.survey.map(function (s, qi) {
          return html`<fieldset style="border:0;border-top:1px solid var(--divider);padding:14px 0;margin:0"><legend style="font-weight:700;padding:0 0 8px">${s.q}</legend><div class="seg" role="radiogroup">${opts.map(function (o, i) {
            var v = String(i + 1); return html`<button type="button" role="radio" aria-checked="${String(S.survey['q' + qi] === v)}" aria-pressed="${String(S.survey['q' + qi] === v)}" data-action="set" data-key="survey.q${qi}" data-value="${v}">${o}</button>`;
          })}</div></fieldset>`;
        })}<button class="btn contained mt16" type="submit">Submit</button></form></section>`}</div>`;
  }

  /* ---------- AI Assistant ---------- */
  var PROMPTS = [
    ['Metrics & Catalog', [['List my services', 'List all services in the catalog'], ['Check hello-service metrics', 'Show me the request rate, error rate and latency for hello-service'], ['List deployments', 'List all running Kubernetes deployments and their health'], ['Find payment services', 'Find all services related to payments']]],
    ['Scaffolding', [['Scaffold a Go service', 'Scaffold a new Go microservice'], ['Add a Playwright suite', 'Add a Playwright E2E test suite to an existing service']]],
    ['Delivery & Cost', [['Check ArgoCD apps', 'List all ArgoCD applications and their sync status'], ['Team budget status', 'Show me all teams over 80% budget utilisation'], ['Rightsizing savings', 'What are the top rightsizing opportunities to reduce cost?']]],
    ['Contracts', [['List contracts', 'List all registered API contracts'], ['Check breaking changes', 'Detect breaking changes across all registered API contracts'], ['Validate compatibility', 'Validate compatibility between all consumer and provider contracts'], ['Discover contracts', 'Auto-discover contracts for all services in the catalog']]]
  ];
  function pageAssistant() {
    var agents = D.agents.map(function (a) { return a.name; });
    var right = html`<div class="btn-row"><label class="sr-only" for="agent-sel">KAgent agent to chat with</label><select id="agent-sel" class="input" style="height:36px;width:auto;font-size:14px;color:var(--text)" data-bind="agent">${agents.map(function (a) { return html`<option ${a === S.agent ? raw('selected') : ''}>${a}</option>`; })}</select></div>`;
    return html`${pluginBar('custom-pages')}${header('tool', 'AI Assistant', 'Powered by KAgent · ' + S.agent, right)}<div class="content">
      <div style="display:flex;justify-content:flex-end;gap:8px;margin-bottom:12px"><button type="button" class="btn outlined grey" data-action="toggle-history">${icon('history', 20)}History</button><button type="button" class="btn outlined grey" data-action="new-chat">${icon('newchat', 20)}New chat</button></div>
      ${S.showHistory ? card('Chat History', table(['Conversation', 'Agent', 'Messages', 'Last activity'], [[S.chat.length ? (S.chat[0].text || 'New chat') : 'New chat', S.agent, String(S.chat.length), 'now'], ['Scaffold a new Go microservice', 'platform-assistant', '4', 'Yesterday'], ['Which teams are over budget?', 'cost-agent', '2', 'Nov 17']]), html`<button type="button" class="icon-btn sm" data-action="toggle-history" aria-label="Close history">${icon('clear', 20)}</button>`) : ''}
      <div class="chat-wrap"><div class="chat-scroll" id="chat-scroll" aria-live="polite">
        ${S.chat.length ? '' : html`<div style="max-width:900px">${PROMPTS.map(function (g) {
          return html`<div class="prompt-group"><div class="pg-title">${g[0]}</div><div class="btn-row">${g[1].map(function (p) { return html`<button type="button" class="chip" data-action="ask" data-prompt="${p[1]}">${p[0]}</button>`; })}</div></div>`;
        })}</div>`}
        ${S.chat.map(function (m) { return m.role === 'user' ? html`<div class="bubble-user">${m.text}</div>` : m.typing ? html`<div class="bubble-bot typing" aria-label="Assistant is typing"><span></span><span></span><span></span></div>` : html`<div class="bubble-bot">${m.body}</div>`; })}
      </div>
      ${S.pending ? html`<div class="btn-row" style="margin-bottom:10px"><button type="button" class="chip" data-action="ask" data-prompt="Yes, go ahead">Yes, go ahead</button><button type="button" class="chip" data-action="ask" data-prompt="Cancel">Cancel</button></div>` : ''}
      <form class="chat-input" data-submit="chat"><label class="sr-only" for="chat-in">Message</label><input id="chat-in" autocomplete="off" placeholder="Ask about services, deployments, metrics…" value="${S.chatDraft}" data-bind-quiet="chatDraft">
        <button type="submit" class="icon-btn" aria-label="Send">${icon('send')}</button></form></div></div>`;
  }
  function ask(text) {
    text = String(text).trim();
    if (!text) return;
    S.chat.push({ role: 'user', text: text });
    var typing = { role: 'bot', typing: true };
    S.chat.push(typing); S.chatDraft = '';
    refreshIf('ai-assistant'); scrollChat();
    setTimeout(function () {
      var i = S.chat.indexOf(typing);
      if (i < 0) return;
      S.chat[i] = { role: 'bot', body: reply(text) };
      refreshIf('ai-assistant'); scrollChat();
    }, 700);
  }
  function kv(rows) { return html`<table class="plain"><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>${rows.map(function (r) { return html`<tr><td><strong>${r[0]}</strong></td><td>${r[1]}</td></tr>`; })}</tbody></table>`; }
  function reply(text) {
    var t = text.toLowerCase(), c = D.components.slice().sort(function (a, b) { return b.name.length - a.name.length; }).filter(function (x) { return t.indexOf(x.name) >= 0; })[0];
    if (S.pending) {
      var p = S.pending;
      S.pending = null;
      if (/^(yes|y|go|ok|approve|confirm|do it|sure)/.test(t)) {
        var tt = tpl(p.template), id = startTask(tt, { name: p.name, owner: p.owner, desc: '', target: 'aws', service: p.service || 'hello-service' });
        var isTs = isSuite(tt);
        return html`<p><strong>✅ ${isTs ? 'Test suite pull request opened!' : 'Go microservice scaffolded successfully!'}</strong></p><p>Here's a summary of what was created:</p>
          ${kv([[isTs ? 'Suite Name' : 'Service Name', html`<code>${p.name}</code>`], ['Template', html`${tt.t} (<code>template:default/${tt.n}</code>)`], ['Owner', html`<code>group:default/${p.owner}</code>`], ['Repository', html`<code>github.com/moatazeldebsy/${isTs ? p.service : p.name}</code>`], ['Deploy Target', 'AWS (EKS)'], ['Cluster', html`<code>idp-mvp</code> @ <code>us-east-1</code>`], ['Task ID', html`<code>${id}</code>`]])}
          <p style="margin-top:8px">🔗 <a href="#/create/tasks/${id}">View scaffolder task</a></p>
          ${isTs ? '' : html`<p><strong>What's included out of the box:</strong></p><ul><li>🐹 Go HTTP service with health endpoints</li><li>🚀 GitHub Actions CI/CD pipeline (builds &amp; pushes to ECR via OIDC)</li><li>⎈ Helm chart for Kubernetes deployment on EKS</li><li>📦 Catalog entity auto-registered</li></ul>
          <p><strong>Suggested next steps:</strong></p><ul><li>🧪 <strong>Add a test suite</strong> — e.g. Playwright E2E, k6 performance, or Pact contract tests</li><li>🔒 <strong>Enable security scanning</strong> — SonarCloud + Snyk via <code>enable-security-scanning</code></li></ul>`}`;
      }
      return html`<p>No problem — nothing was created.</p>`;
    }
    if (/playwright|e2e/.test(t) && /add|suite|test/.test(t)) {
      S.pending = { template: 'playwright-e2e-suite', name: (c ? c.name : 'checkout-web') + '-e2e', owner: 'qa-team', service: c ? c.name : 'checkout-web' };
      return html`<p>I can add a <strong>Playwright E2E Test Suite</strong> with these parameters:</p>${kv([['Target service', html`<code>${S.pending.service}</code>`], ['Suite name', html`<code>${S.pending.name}</code>`], ['Owner', html`<code>group:default/qa-team</code>`], ['Mode', 'Add to existing repo (opens a PR)']])}
        <p style="margin-top:8px"><code>scaffold_test_suite</code> opens a pull request, so it goes through the approval gate. Shall I go ahead?</p>`;
    }
    if (/scaffold|create (a|an|new)|new (go|python|node|java)? ?(micro)?service/.test(t)) {
      var nm = (t.match(/(?:called|named)\s+([a-z0-9][a-z0-9-]{2,40})/) || [])[1] || 'my-go-service-' + pad(S.chat.length);
      S.pending = { template: /python/.test(t) ? 'python-service' : /node/.test(t) ? 'nodejs-service' : 'go-service', name: nm, owner: D.user.team };
      return html`<p>I have everything I need. To scaffold your microservice I'll use these details:</p>
        ${kv([['Service Name', html`<code>${nm}</code>`], ['Description', 'Scaffolded by the AI Assistant'], ['Owner', html`<code>group:default/${D.user.team}</code>`], ['GitHub Repo Name', html`<code>github.com/moatazeldebsy/${nm}</code>`], ['Deploy Target', html`<code>aws</code> (EKS)`]])}
        <p style="margin-top:8px"><strong>Optional extras:</strong> Port (default <code>8080</code>), Cost Center (default <code>eng-platform</code>). Reply <em>yes</em> to scaffold it, or tell me what to change.</p>`;
    }
    if (/budget|cost|spend|rightsiz/.test(t)) {
      if (/rightsiz|reduce/.test(t)) return html`<p>Top rightsizing opportunities (from <code>get_rightsizing_recommendations</code>):</p><ul><li><strong>recommendations-ml</strong> — move to Graviton (m7g): ~$61/month</li><li><strong>analytics-pipeline</strong> — 3 → 2 replicas (CPU p95 18%): ~$38/month</li><li><strong>orders-service</strong> — memory request 2Gi → 1Gi: ~$23/month</li></ul>`;
      var over = D.teams.filter(function (x) { return x.spend / x.budget > 0.8; });
      return html`<p>${over.length} teams are above 80% of their monthly budget:</p><ul>${over.map(function (x) { return html`<li><a href="${entityHref('group', x.name)}/budget">${x.display}</a> — ${money(x.spend, 0)} of ${money(x.budget, 0)} (${pct(x.spend / x.budget * 100, 0)})</li>`; })}</ul>`;
    }
    if (/argocd|sync status/.test(t)) {
      var apps = argoApps(), bad = apps.filter(function (a) { return a.sync !== 'Synced' || a.health !== 'Healthy'; });
      return html`<p>${apps.length} ArgoCD applications; ${bad.length} need attention:</p><ul>${bad.map(function (a) { return html`<li><code>${a.name}</code> — ${a.sync}, ${a.health}</li>`; })}</ul><p>See <a href="#/argocd">ArgoCD</a>.</p>`;
    }
    if (/deployment|kubernetes|running/.test(t)) {
      var deps = D.components.filter(function (x) { return x.replicas > 0; });
      return html`<p>${deps.length} deployments in <code>services-dev</code>:</p><ul>${deps.slice(0, 8).map(function (x) { return html`<li><code>${x.name}</code> — ${x.name === 'inventory-service' ? '0/' + x.replicas + ' ready (CrashLoopBackOff)' : x.replicas + '/' + x.replicas + ' ready'}</li>`; })}</ul>${deps.length > 8 ? html`<p class="muted">…and ${deps.length - 8} more.</p>` : ''}`;
    }
    if (c && /metric|latency|error|rate/.test(t)) {
      var rps = series('chat-rps:' + c.name, 24, c.replicas * 40 + 20, 12);
      return html`<p>Last 24 h for <a href="${entityHref('component', c.name)}">${c.name}</a> (<code>get_service_metrics</code>):</p><ul><li>📊 Request rate: <strong>${num(rps[23], 1)} req/s</strong></li><li>❌ Error rate: <strong>${pct(c.dora.cfr / 10, 2)}</strong></li><li>⏱ p95 latency: <strong>${num(120 + c.dora.lt * 3, 0)} ms</strong></li></ul>`;
    }
    if (/contract|breaking|compatib/.test(t)) {
      if (/breaking/.test(t)) return html`<p>Checked ${D.apis.length} registered contracts. <strong>1 breaking change</strong> found:</p><ul><li><code>orders-api</code> — <code>POST /v1/orders/{id}/cancel</code> now requires <code>reason</code> (consumer <code>checkout-web</code> does not send it)</li></ul>`;
      if (/discover/.test(t)) return html`<p>Auto-discovered OpenAPI specs for <strong>4</strong> services and registered them: payments-api, orders-service, search-api, hello-service.</p>`;
      if (/compatib/.test(t)) return html`<p>Compatibility report: <strong>11 of 12</strong> consumer/provider pairs are compatible. <code>checkout-web → orders-api</code> fails (see breaking change above). <code>can_i_deploy</code> blocks orders-service until it is fixed.</p>`;
      return html`<p>${D.apis.length} registered contracts:</p><ul>${D.apis.map(function (a) { return html`<li><code>${a.name}</code> (${a.type}) — provided by ${a.provider}</li>`; })}</ul>`;
    }
    if (/service|catalog|find|search|who owns|list/.test(t)) {
      var words = t.split(/\W+/).filter(function (w) { return w.length > 3 && ['list', 'services', 'service', 'catalog', 'find', 'related', 'search', 'with', 'that', 'show', 'owns'].indexOf(w) < 0; });
      var res = c ? [c] : words.length ? D.components.filter(function (x) { return words.some(function (w) { return (x.name + ' ' + x.desc + ' ' + x.tags.join(' ')).toLowerCase().indexOf(w.replace(/s$/, '')) >= 0; }); }) : D.components;
      return html`<p>Found <strong>${res.length}</strong> ${res.length === 1 ? 'component' : 'components'} (<code>catalog_search</code>):</p><ul>${res.slice(0, 10).map(function (x) { return html`<li><a href="${entityHref('component', x.name)}">${x.name}</a> — ${x.type}, owned by ${x.owner} (${x.lifecycle})</li>`; })}</ul>${res.length > 10 ? html`<p class="muted">…and ${res.length - 10} more in the <a href="#/catalog">catalog</a>.</p>` : ''}`;
    }
    return html`<p>Sure! Here are a few things I can help you with under <strong>Metrics &amp; Catalog</strong>:</p><ul><li>🔍 <strong>Search the catalog</strong> — Find services, APIs, components, or resources by name or keyword</li>
      <li>📊 <strong>Query service metrics</strong> — Pull real-time Prometheus metrics (requests, errors, latency, etc.)</li><li>🚀 <strong>List deployments</strong> — See Kubernetes deployments and their readiness status</li></ul>
      <p>What would you like to do? For example:</p><ul><li><em>"Search for the payments service"</em></li><li><em>"Show metrics for orders-service"</em></li><li><em>"Scaffold a new Go microservice"</em></li></ul>`;
  }

  /* ---------- Settings (user-settings plugin) ---------- */
  var THEMES = [['', 'Auto'], ['light', 'Light'], ['dark', 'Dark'], ['idp-dark', 'IDP Dark'], ['catppuccin', 'Catppuccin Mocha'], ['nord', 'Nord'], ['dracula', 'Dracula']];
  function pageSettings() {
    var cur = document.documentElement.getAttribute('data-theme') || '';
    var tab = S.settingsTab, body;
    if (tab === 'auth') body = card('Available Providers', table(['Provider', 'Description', ''], [['GitHub', 'Sign in with your GitHub account', html`<span class="btn outlined sm" aria-disabled="true">Sign in</span>`], ['Guest', 'Signed in as guest (local development)', chip('signed in', 'sm ok')]]));
    else if (tab === 'flags') body = card('Feature Flags', html`<div class="card-body muted" style="padding-top:0">No registered feature flags.</div>`);
    else body = html`<div class="grid g2">
        ${cardBody('Profile', html`<div style="display:flex;gap:16px;align-items:center"><div class="avatar lg" style="width:72px;height:72px;font-size:24px">${initials(S.displayName)}</div><div><h3 style="font-size:20px">${S.displayName}</h3><div class="muted">arivera@moatazeldebsy.dev</div></div></div>`)}
        ${cardBody('Appearance', html`<div class="toggle-row"><div><strong>Theme</strong><div class="muted small">Change the theme mode</div></div><div class="seg" role="group" aria-label="Theme">${THEMES.map(function (th) {
          return html`<button type="button" data-action="set-theme" data-value="${th[0]}" aria-pressed="${String(cur === th[0])}">${th[1]}</button>`;
        })}</div></div><div class="toggle-row"><div><strong>Language</strong><div class="muted small">Change the language</div></div><span>English</span></div>
        <div class="toggle-row"><div><strong>Pin Sidebar</strong><div class="muted small">Prevent the sidebar from collapsing</div></div>${chip('on', 'sm ok')}</div>`)}
      </div>`;
    return html`${pluginBar('Settings', 'gear')}${header('home', 'Settings')}<nav class="subtabs" aria-label="Settings">${[['general', 'General'], ['auth', 'Authentication Providers'], ['flags', 'Feature Flags']].map(function (t) {
      return html`<a href="#/settings" data-action="set" data-key="settingsTab" data-value="${t[0]}" ${t[0] === tab ? raw('aria-current="page"') : ''}>${t[1]}</a>`;
    })}</nav><div class="content">${body}</div>`;
  }

  function notFound(msg) {
    return html`<div class="content"><div class="empty-state"><h1>404</h1><p style="font-size:18px">${msg || 'Looks like someone dropped the mic!'}</p><a class="btn contained" href="#/">Go back</a></div></div>`;
  }

  /* ---------- router ---------- */
  var PAGES = {
    '': pageHome, catalog: pageCatalog, create: pageCreate, 'api-docs': pageApiDocs, docs: pageDocsIndex, 'tech-radar': pageRadar, announcements: pageAnnouncements,
    'catalog-import': pageImport, finops: pageFinops, 'ai-search': pageAISearch, 'ai-assistant': pageAssistant, approvals: pageApprovals, incidents: pageIncidents,
    copilot: pageCopilot, dora: pageDora, scorecard: pageScorecardPlatform, slo: pageSloPlatform, argocd: pageArgo, activity: pageActivity, apis: pageApiExplorer,
    onboarding: pageOnboarding, 'learning-center': pageLearning, calculator: pageCalculator, profile: pageProfile, 'search-page': pageSearchCustom, admin: pageAdmin,
    kagent: pageKagent, langfuse: pageLangfuse, 'litellm-spend': pageLitellm, mlflow: pageMlflow, support: pageSupport, 'engineering-intelligence': pageEI,
    core4: pageCore4, 'devex-survey': pageSurvey, settings: pageSettings, search: pageSearchStock
  };
  function renderPage() {
    var p = parts(), r = p[0] || '';
    if (r === 'catalog' && p[1]) return pageEntity(p[2], p[3], p[4]);
    if (r === 'create' && p[1] === 'templates') return pageTemplateForm(p[3]);
    if (r === 'create' && p[1] === 'tasks') return p[2] ? pageTask(p[2]) : pageTasks();
    if (r === 'create' && p[1] === 'actions') return pageActions();
    if (r === 'docs' && p[1]) return docsReader(p[3], p[2], p[4], false);
    if (PAGES[r] && !p[1]) return PAGES[r]();
    return notFound();
  }
  var TITLES = {};
  NAV_ALL.forEach(function (n) { TITLES[n.path] = n.title; });
  var lastHash = null;
  function render() {
    var h = location.hash;
    $('#main').innerHTML = renderPage().s;
    renderSidebar();
    var p = parts();
    document.title = (p[0] === 'catalog' && p[3] ? p[3] : TITLES[p[0] || ''] || 'Backstage') + ' | IDP Portal Demo';
    if (h !== lastHash) {
      window.scrollTo(0, 0);
      document.body.classList.remove('nav-open');
      $('#menu-btn').setAttribute('aria-expanded', 'false');
      lastHash = h;
    }
    var lg = $('#task-log'); if (lg) lg.scrollTop = lg.scrollHeight;
  }
  function rerender() {
    var a = document.activeElement, id = a && a.id && $('#main').contains(a) ? a.id : null, pos = null;
    try { pos = id ? a.selectionStart : null; } catch (e) { pos = null; }
    var y = window.scrollY;
    render();
    window.scrollTo(0, y);
    if (id) { var el = document.getElementById(id); if (el) { el.focus({ preventScroll: true }); try { if (pos != null) el.setSelectionRange(pos, pos); } catch (e) { /* not a text input */ } } }
  }
  function refreshIf(route) { if (current() === route) rerender(); else renderSidebar(); }
  function scrollChat() { if (current() === 'ai-assistant') window.scrollTo(0, document.body.scrollHeight); }

  /* ---------- state binding ---------- */
  function setPath(path, value) {
    var keys = path.split('.'), o = S;
    for (var i = 0; i < keys.length - 1; i++) { if (o[keys[i]] == null) o[keys[i]] = {}; o = o[keys[i]]; }
    var last = keys[keys.length - 1];
    o[last] = typeof o[last] === 'number' ? Number(value) : typeof o[last] === 'boolean' ? value === 'true' : value;
  }

  /* ---------- search modal (SidebarSearchModal) ---------- */
  var modalSel = 0;
  function openSearch() {
    $('#modal-root').innerHTML = html`<div class="modal-backdrop" data-action="close-search"><div class="modal" role="dialog" aria-modal="true" aria-label="Search">
      <div style="padding:16px 24px 8px"><div class="outlined-search">${icon('search', 22)}<label class="sr-only" for="modal-q">Search in Backstage</label><input id="modal-q" type="search" placeholder="Search in Backstage" autocomplete="off"><button type="button" class="icon-btn sm" data-action="close-search" aria-label="Close search">${icon('clear', 20)}</button></div></div>
      <div class="modal-results" id="modal-results"></div>
      <div style="padding:8px 24px 16px;text-align:right"><a href="#/search" data-action="close-search">View full results →</a></div></div></div>`.s;
    document.body.classList.remove('nav-open');
    modalSel = 0;
    $('#modal-q').focus();
    runModalSearch();
  }
  function closeSearch() { $('#modal-root').innerHTML = ''; }
  function runModalSearch() {
    var input = $('#modal-q'); if (!input) return;
    var q = input.value, pages = NAV_ALL.filter(function (n) { return q && n.title.toLowerCase().indexOf(q.toLowerCase()) >= 0; }).map(function (n) { return { title: n.title, sub: 'Page', href: '#/' + n.path }; });
    var res = pages.concat(searchResults(q)).slice(0, 10);
    modalSel = Math.min(modalSel, Math.max(0, res.length - 1));
    $('#modal-results').innerHTML = q ? (res.length ? res.map(function (r, i) {
      return html`<a href="${r.href}" class="${i === modalSel ? 'active' : ''}" data-action="close-search"><div style="font-size:16px">${highlight(r.title, q)}</div><div class="muted small" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${r.sub}</div></a>`.s;
    }).join('') : html`<div class="muted" style="padding:12px 24px">Sorry, no results were found</div>`.s) : html`<div class="muted" style="padding:12px 24px">Start typing to search the catalog, docs, templates and pages.</div>`.s;
  }

  /* ---------- actions ---------- */
  var ACTIONS = {
    set: function (el) {
      var k = el.getAttribute('data-key'), v = el.getAttribute('data-value');
      if (k === 'cat.kind') { S.cat.type = ''; S.cat.owner = ''; S.cat.lifecycle = ''; S.cat.tag = ''; }
      if (k.indexOf('learning.') === 0 && S.learning[k.split('.')[1]] === v) v = '';
      setPath(k, v);
      if (el.tagName !== 'A') rerender(); else setTimeout(rerender, 0);
    },
    star: function (el) { var k = el.getAttribute('data-key'); S.starred[k] = !S.starred[k]; rerender(); },
    'toggle-tpl-starred': function () { S.tplf.starred = !S.tplf.starred; rerender(); },
    'toggle-theme': function () {
      var cur = document.documentElement.getAttribute('data-theme');
      var dark = cur ? cur !== 'light' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
      applyTheme(dark ? 'light' : 'dark');
    },
    'set-theme': function (el) { applyTheme(el.getAttribute('data-value')); },
    'open-nav': function () { var o = !document.body.classList.contains('nav-open'); document.body.classList.toggle('nav-open', o); $('#menu-btn').setAttribute('aria-expanded', String(o)); },
    'close-nav': function () { document.body.classList.remove('nav-open'); $('#menu-btn').setAttribute('aria-expanded', 'false'); },
    'open-search': function () { openSearch(); },
    'close-search': function (el, e) { if (el.classList.contains('modal-backdrop') && e.target !== el) return; closeSearch(); },
    ask: function (el) { if (current() !== 'ai-assistant') location.hash = '#/ai-assistant'; ask(el.getAttribute('data-prompt')); },
    'new-chat': function () { S.chat = []; S.pending = null; rerender(); },
    'toggle-history': function () { S.showHistory = !S.showHistory; rerender(); },
    decide: function (el) {
      var a = S.approvals.filter(function (x) { return x.id === el.getAttribute('data-key'); })[0];
      if (a) { a.status = el.getAttribute('data-value'); a.decided_by = 'user:default/arivera'; a.decided = ago(0); rerender(); }
    },
    'toggle-done': function (el) {
      var k = el.getAttribute('data-key'); S.done[k] = !S.done[k];
      try { localStorage.setItem('idp-demo-learning', JSON.stringify(S.done)); } catch (e) { /* storage unavailable */ }
      rerender();
    },
    'argo-sync': function (el) {
      var k = el.getAttribute('data-key'); S.syncing = S.syncing || {}; S.syncing[k] = true; rerender();
      setTimeout(function () { S.syncing[k] = false; S.synced[k] = true; refreshIf('argocd'); }, 1100);
    },
    'tpl-back': function (el) { var f = S.forms[el.getAttribute('data-key')]; if (f && f.step > 0) { f.step--; f.error = ''; rerender(); } },
    'toggle-logs': function () { S.showLogs = !S.showLogs; rerender(); },
    toast: function (el) { el.textContent = el.getAttribute('data-msg'); },
    noop: function () { /* visual-only control */ }
  };
  var SUBMITS = {
    'tpl-next': function (form) {
      var n = form.getAttribute('data-tpl'), t = tpl(n), f = S.forms[n];
      if (f.step === 0) {
        if (!/^[a-z][a-z0-9-]{2,40}$/.test(f.name)) { f.error = 'Name must start with a letter and use only lowercase letters, digits and hyphens (3–41 characters).'; rerender(); var el = $('#f-name'); if (el) el.focus(); return; }
        if (!isSuite(t) && t.type !== 'resource' && comp(f.name)) { f.error = 'A component named ' + f.name + ' already exists in the catalog.'; rerender(); return; }
      }
      f.error = '';
      if (f.step < 2) { f.step++; rerender(); return; }
      var id = startTask(t, { name: f.name, owner: f.owner, desc: f.desc, target: f.target, service: f.service });
      f.step = 0;
      location.hash = '#/create/tasks/' + id;
    },
    chat: function () { ask(S.chatDraft); },
    survey: function () { S.surveySent = true; rerender(); },
    'import': function () { S.importStep = 1; rerender(); },
    noop: function () { rerender(); }
  };

  function applyTheme(t) {
    if (t) document.documentElement.setAttribute('data-theme', t); else document.documentElement.removeAttribute('data-theme');
    try { if (t) localStorage.setItem('idp-demo-theme', t); else localStorage.removeItem('idp-demo-theme'); } catch (e) { /* storage unavailable */ }
    themeLabel();
    if (current() === 'settings') rerender();
  }
  function themeLabel() {
    var cur = document.documentElement.getAttribute('data-theme');
    var dark = cur ? cur !== 'light' : window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    $('#theme-btn').textContent = dark ? 'Light theme' : 'Dark theme';
    $('#theme-btn').setAttribute('aria-label', dark ? 'Switch to the light theme' : 'Switch to the dark theme');
  }
  function syncBannerHeight() { document.documentElement.style.setProperty('--bh', $('#banner').offsetHeight + 'px'); }

  /* ---------- wiring ---------- */
  document.addEventListener('click', function (e) {
    var el = e.target.closest('[data-action]');
    if (!el || !ACTIONS[el.getAttribute('data-action')]) return;
    var act = el.getAttribute('data-action');
    if (el.tagName !== 'A') e.preventDefault();
    ACTIONS[act](el, e);
  });
  document.addEventListener('input', function (e) {
    var el = e.target;
    if (el.id === 'modal-q') { modalSel = 0; runModalSearch(); return; }
    var b = el.getAttribute('data-bind'), q = el.getAttribute('data-bind-quiet');
    if (b === 'cat.kind') { S.cat.type = ''; S.cat.owner = ''; S.cat.lifecycle = ''; S.cat.tag = ''; S.cat.personal = 'all'; }
    if (b) { setPath(b, el.value); rerender(); } else if (q) setPath(q, el.value);
  });
  document.addEventListener('change', function (e) { var q = e.target.getAttribute && e.target.getAttribute('data-bind-quiet'); if (q) setPath(q, e.target.value); });
  document.addEventListener('submit', function (e) {
    var f = e.target.closest('[data-submit]');
    if (f && SUBMITS[f.getAttribute('data-submit')]) { e.preventDefault(); SUBMITS[f.getAttribute('data-submit')](f); }
  });
  document.addEventListener('keydown', function (e) {
    var modal = $('#modal-q');
    if (e.key === 'Escape') { closeSearch(); document.body.classList.remove('nav-open'); return; }
    if (modal && document.activeElement === modal) {
      var items = document.querySelectorAll('#modal-results a');
      if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && items.length) { e.preventDefault(); modalSel = (modalSel + (e.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length; runModalSearch(); }
      else if (e.key === 'Enter' && items[modalSel]) { e.preventDefault(); location.hash = items[modalSel].getAttribute('href'); closeSearch(); }
      return;
    }
    if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); openSearch(); }
  });
  window.addEventListener('hashchange', render);
  window.addEventListener('resize', syncBannerHeight);
  if (window.matchMedia) { try { window.matchMedia('(prefers-color-scheme: dark)').addEventListener('change', themeLabel); } catch (e) { /* old browsers */ } }

  $('#menu-btn').innerHTML = html`${icon('menu')}<span>Menu</span>`.s;
  $('#mb-home').innerHTML = html`${icon('dashboard')}<span>Home</span>`.s;
  $('#mb-search').innerHTML = html`${icon('search')}<span>Search</span>`.s;
  themeLabel();
  syncBannerHeight();
  render();

  // Exposed for automated checks only.
  window.__demo = { nav: NAV_ALL.map(function (n) { return n.path; }), entityTabs: function (name) { var c = comp(name); return c ? entityTabs(c).map(function (t) { return t[0]; }) : []; }, state: S };
})();
