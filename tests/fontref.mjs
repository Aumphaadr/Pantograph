// tests/fontref.mjs — сверка обводки с НАСТОЯЩИМИ шрифтами.
//
// Не автотест, а мерная линейка: `node tests/fontref.mjs [lato|free_serif]`.
// В refs/font_ref/ лежат текст, переведённый Inkscape в контуры (.svg), и его же
// рендер (.png, 100 dpi). Лист обводится нашим конвейером как в приложении,
// и каждая буква сверяется с контуром, который её породил:
//   — увод от истины, px (площадь симметрической разности на длину края);
//   — узлов у нас против «канона» истины (её контуры через наш же
//     regularizeShape с тем же допуском);
//   — структура: сколько углов истины найдено, найдено гладкими, пропущено.
// Ничего, кроме Node: PNG читается своим декодером (zlib встроен).

import { readFileSync, existsSync } from 'node:fs';
import { inflateSync } from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { colorDistance, coverageToField, threshold, morph } from '../js/prep/mask.js';
import { buildGlyphs } from '../js/glyphs/build.js';
import { rasterizeShape, edgeCount } from '../js/trace/rasterize.js';
import { countNodes, transform } from '../js/core/path.js';
import { regularizeShape } from '../js/trace/regularize.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
// Референсы лежат в refs/ (владелец держит их вне репозитория); старое место — корень.
const REF = existsSync(join(ROOT, 'refs', 'font_ref')) ? join(ROOT, 'refs', 'font_ref') : join(ROOT, 'font_ref');
const PX = 100 / 25.4;   // пикселей на мм при экспорте 100 dpi
// Поправка экспорта: Inkscape округляет холст до целых пикселей и сдвигает
// рендер на долю пикселя; замерена сырой обводкой (лучший общий сдвиг).
const CALIB = { lato: [0, 0.25], free_serif: [0.0625, 0.0625] };

// ─── PNG ────────────────────────────────────────────────────────────────────

/** PNG (8 бит, RGB/RGBA, без чересстрочности) → ImageData-подобный объект на белом фоне. */
export function readPng(file) {
  const buf = readFileSync(file);
  let pos = 8;
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[12] !== 0) throw new Error('PNG: нужен 8-битный без чересстрочности');
      colorType = data[9];
    } else if (type === 'IDAT') idat.push(data);
    pos += 12 + len;
  }
  const bpp = colorType === 6 ? 4 : colorType === 2 ? 3 : (() => { throw new Error('PNG: нужен RGB или RGBA'); })();
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width * bpp;
  const out = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  let at = 0;
  for (let y = 0; y < height; y += 1) {
    const filter = raw[at]; at += 1;
    for (let i = 0; i < stride; i += 1) {
      const x = raw[at + i];
      const a = i >= bpp ? cur[i - bpp] : 0;
      const b = prev[i];
      const c = i >= bpp ? prev[i - bpp] : 0;
      let v;
      if (filter === 0) v = x;
      else if (filter === 1) v = x + a;
      else if (filter === 2) v = x + b;
      else if (filter === 3) v = x + ((a + b) >> 1);
      else {
        const p = a + b - c;
        const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v = x + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c);
      }
      cur[i] = v & 255;
    }
    at += stride;
    for (let x = 0; x < width; x += 1) {
      const s = x * bpp;
      const alpha = bpp === 4 ? cur[s + 3] / 255 : 1;
      const o = (y * width + x) * 4;
      out[o] = Math.round(cur[s] * alpha + 255 * (1 - alpha));
      out[o + 1] = Math.round(cur[s + 1] * alpha + 255 * (1 - alpha));
      out[o + 2] = Math.round(cur[s + 2] * alpha + 255 * (1 - alpha));
      out[o + 3] = 255;
    }
    prev.set(cur);
  }
  return { width, height, data: out };
}

// ─── SVG Inkscape ───────────────────────────────────────────────────────────

function loadSvg(file) {
  const svg = readFileSync(file, 'utf8');
  const label = /aria-label="([^"]*)"/.exec(svg)[1]
    .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
  const chars = [...label].filter((c) => c !== ' ' && c !== '\n');
  const paths = [...svg.matchAll(/<path\s+d="([^"]*)"/g)].map((m) => m[1]);
  const tr = /transform="translate\(([-\d.]+),([-\d.]+)\)"/.exec(svg);
  return { chars, paths, offset: tr ? [+tr[1], +tr[2]] : [0, 0] };
}

/** d → контуры из сегментов {kind:'L'|'Q'|'C', pts}. Команды Inkscape: m l h v q c z. */
export function parsePath(d) {
  const tok = d.match(/[a-zA-Z]|-?\d*\.?\d+(?:e-?\d+)?/g);
  const contours = [];
  let cur = null;
  let cmd = null;
  let x = 0, y = 0, sx = 0, sy = 0;
  let i = 0;
  const num = () => parseFloat(tok[i++]);
  while (i < tok.length) {
    if (/[a-zA-Z]/.test(tok[i])) cmd = tok[i++];
    const rel = cmd === cmd.toLowerCase();
    const C = cmd.toUpperCase();
    const px = x, py = y;
    if (C === 'M') {
      const nx = num(), ny = num();
      x = rel ? x + nx : nx; y = rel ? y + ny : ny;
      sx = x; sy = y;
      cur = { segs: [] };
      contours.push(cur);
      cmd = rel ? 'l' : 'L';
    } else if (C === 'L' || C === 'H' || C === 'V') {
      if (C !== 'V') { const nx = num(); x = rel ? x + nx : nx; }
      if (C !== 'H') { const ny = num(); y = rel ? y + ny : ny; }
      cur.segs.push({ kind: 'L', pts: [{ x: px, y: py }, { x, y }] });
    } else if (C === 'Q') {
      const cx = num(), cy = num(), nx = num(), ny = num();
      const q = { x: rel ? x + cx : cx, y: rel ? y + cy : cy };
      x = rel ? x + nx : nx; y = rel ? y + ny : ny;
      cur.segs.push({ kind: 'Q', pts: [{ x: px, y: py }, q, { x, y }] });
    } else if (C === 'C') {
      const c1x = num(), c1y = num(), c2x = num(), c2y = num(), nx = num(), ny = num();
      const p1 = { x: rel ? x + c1x : c1x, y: rel ? y + c1y : c1y };
      const p2 = { x: rel ? x + c2x : c2x, y: rel ? y + c2y : c2y };
      x = rel ? x + nx : nx; y = rel ? y + ny : ny;
      cur.segs.push({ kind: 'C', pts: [{ x: px, y: py }, p1, p2, { x, y }] });
    } else if (C === 'Z') {
      if (cur && (Math.abs(x - sx) > 1e-9 || Math.abs(y - sy) > 1e-9)) {
        cur.segs.push({ kind: 'L', pts: [{ x, y }, { x: sx, y: sy }] });
      }
      x = sx; y = sy; cur = null;
    } else throw new Error(`SVG: команда ${cmd}`);
  }
  return contours;
}

const lerp = (a, b, t) => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

/** Контур сегментов → узлы с рычагами; квадратики поднимаются до кубик. */
export function toNodes(c) {
  const n = c.segs.length;
  const cubics = c.segs.map((s) => {
    if (s.kind === 'L') return [s.pts[0], null, null, s.pts[1]];
    if (s.kind === 'Q') { const [a, q, b] = s.pts; return [a, lerp(a, q, 2 / 3), lerp(b, q, 2 / 3), b]; }
    return s.pts;
  });
  return cubics.map((cur, i) => {
    const prev = cubics[(i - 1 + n) % n];
    const p = cur[0];
    // Тип — по излому касательных; у прямых касательная идёт в конец сегмента.
    const tin = { x: p.x - (prev[2] ?? prev[0]).x, y: p.y - (prev[2] ?? prev[0]).y };
    const tout = { x: (cur[1] ?? cur[3]).x - p.x, y: (cur[1] ?? cur[3]).y - p.y };
    const la = Math.hypot(tin.x, tin.y), lb = Math.hypot(tout.x, tout.y);
    let type = 'corner';
    if (la > 1e-9 && lb > 1e-9) {
      const cos = (tin.x * tout.x + tin.y * tout.y) / (la * lb);
      type = Math.acos(Math.max(-1, Math.min(1, cos))) * 180 / Math.PI <= 8 ? 'smooth' : 'corner';
    }
    return { p: { ...p }, in: prev[2] ? { ...prev[2] } : null, out: cur[1] ? { ...cur[1] } : null, type };
  });
}

/** Настоящие контуры листа в пикселях PNG, по знакам. */
export function truthGlyphs(name) {
  const { chars, paths, offset: [tx, ty] } = loadSvg(join(REF, `${name}.svg`));
  const [cx, cy] = CALIB[name] ?? [0, 0];
  return paths.map((d, i) => {
    const raw = { contours: parsePath(d).map((c) => ({ closed: true, nodes: toNodes(c) })).filter((c) => c.nodes.length >= 2) };
    // translate слоя Inkscape прибавляется к координатам пути.
    const shape = transform(raw, (p) => ({ x: (p.x + tx) * PX - cx, y: (p.y + ty) * PX - cy }));
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const c of shape.contours) for (const nd of c.nodes) {
      x0 = Math.min(x0, nd.p.x); x1 = Math.max(x1, nd.p.x); y0 = Math.min(y0, nd.p.y); y1 = Math.max(y1, nd.p.y);
    }
    return { ch: chars[i] ?? '?', shape, bbox: { x: x0, y: y0, w: x1 - x0, h: y1 - y0 } };
  });
}

// ─── обводка и сверка ───────────────────────────────────────────────────────

export const DEFAULT_PARAMS = {
  fg: [0, 0, 0], bg: [255, 255, 255], tolerance: 70, level: 0.5, open: 0, close: 0,
  simplify: 0.18, cornerAngle: 68, fitError: 0.25, cornerSpan: 2, minArea: 4, tidy: true,
};

/** Лист → глифы, как в fontJob воркера. */
export function runSheet(name, params = {}) {
  const img = readPng(join(REF, `${name}.png`));
  const p = { ...DEFAULT_PARAMS, ...params };
  const soft = coverageToField(colorDistance(img, { fg: p.fg, bg: p.bg, tolerance: p.tolerance }));
  const bin = morph(threshold(soft, p.level), { open: p.open, close: p.close });
  return { built: buildGlyphs(soft, bin, p), bin, params: p };
}

const iou = (a, b) => {
  const x0 = Math.max(a.x, b.x), y0 = Math.max(a.y, b.y);
  const x1 = Math.min(a.x + a.w, b.x + b.w), y1 = Math.min(a.y + a.h, b.y + b.h);
  const inter = Math.max(0, x1 - x0) * Math.max(0, y1 - y0);
  return inter / (a.w * a.h + b.w * b.h - inter);
};

/** Увод края нашего контура от настоящего, px (оба растрятся с увеличением S). */
export function driftVsTruth(ours, truth, S = 4) {
  const b = truth.bbox;
  const x0 = Math.floor(b.x) - 2, y0 = Math.floor(b.y) - 2;
  const w = Math.ceil(b.w) + 5, h = Math.ceil(b.h) + 5;
  const shift = (s) => transform(s, (p) => ({ x: p.x - x0, y: p.y - y0 }));
  const T = rasterizeShape(shift(truth.shape), w * S, h * S, S);
  const O = rasterizeShape(shift(ours), w * S, h * S, S);
  let diff = 0;
  for (let i = 0; i < T.length; i += 1) if (T[i] !== O[i]) diff += 1;
  return diff / Math.max(1, edgeCount(T, w * S, h * S)) / S;
}

/** Структура: углы истины (по её канону) — найдены / найдены гладкими / пропущены; лишние узлы. */
function structure(ours, canon, near = 0.75, far = 1.5) {
  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const T = canon.contours.flatMap((c) => c.nodes);
  const O = ours.contours.flatMap((c) => c.nodes);
  const s = { corners: 0, found: 0, soft: 0, missed: 0, extras: 0 };
  for (const t of T) {
    if (t.type !== 'corner') continue;
    s.corners += 1;
    let best = null, bd = Infinity;
    for (const o of O) { const d = d2(o.p, t.p); if (d < bd) { bd = d; best = o; } }
    if (bd > near) s.missed += 1; else if (best.type === 'corner') s.found += 1; else s.soft += 1;
  }
  for (const o of O) if (T.every((t) => d2(o.p, t.p) > far)) s.extras += 1;
  return s;
}

export function report(name, params = {}) {
  const t0 = performance.now();
  const { built, params: p } = runSheet(name, params);
  const ms = performance.now() - t0;
  const truths = truthGlyphs(name);
  const rows = [];
  const sum = { ours: 0, canon: 0, drift: 0, corners: 0, found: 0, soft: 0, missed: 0, extras: 0 };
  for (const g of built.glyphs) {
    let t = null, bi = 0;
    for (const cand of truths) { const v = iou(g.bbox, cand.bbox); if (v > bi) { bi = v; t = cand; } }
    if (!t || bi < 0.5) continue;
    const tol = p.fitError * Math.max(0.25, Math.min(40, g.bbox.h / 48));
    const canon = regularizeShape(JSON.parse(JSON.stringify(t.shape)), { lineTol: tol, axisDeg: 4, primShare: 0.025, primTol: tol });
    const drift = driftVsTruth(g.shape, t);
    const s = structure(g.shape, canon);
    const row = { ch: t.ch, ours: g.nodes, canon: countNodes(canon), drift, ...s };
    rows.push(row);
    for (const k of Object.keys(sum)) sum[k] += row[k] ?? 0;
  }
  return { name, ms, glyphs: built.glyphs.length, rows, sum };
}

if (process.argv[1] && process.argv[1].endsWith('fontref.mjs')) {
  if (!existsSync(REF)) {
    console.error(`fontref: нет корпуса ${join(ROOT, 'refs', 'font_ref')} — сверять не с чем. `
      + 'Корпус в репозиторий не входит: см. THIRD-PARTY-NOTICES.md, раздел «Мерные корпуса».');
    process.exit(1);
  }
  const names = process.argv.slice(2).length ? process.argv.slice(2) : ['lato', 'free_serif'];
  for (const name of names) {
    const r = report(name);
    const n = r.rows.length;
    console.log(`══ ${name}: глифов ${r.glyphs}, сверено ${n}, ${r.ms.toFixed(0)} мс`);
    console.log(`   узлов ${r.sum.ours} · канон истины ${r.sum.canon} (${(r.sum.ours / r.sum.canon).toFixed(2)}×)`
      + ` · увод от истины ${(r.sum.drift / n).toFixed(3)} px/букву`
      + ` · углов истины ${r.sum.corners}: найдено ${r.sum.found}, гладкими ${r.sum.soft}, пропущено ${r.sum.missed}`
      + ` · лишних узлов ${r.sum.extras}`);
    const fmt = (x) => `${x.ch}:${x.ours}/${x.canon}${x.drift > 0.4 ? `!${x.drift.toFixed(2)}` : ''}`;
    for (let i = 0; i < n; i += 17) console.log('   ' + r.rows.slice(i, i + 17).map(fmt).join(' '));
    const bad = r.rows.filter((x) => x.drift > 0.4).map((x) => x.ch).join('');
    console.log(`   (буква:узлов у нас/у канона; ! — увод больше 0.4 px${bad ? `: ${bad}` : ''})`);
  }
}
