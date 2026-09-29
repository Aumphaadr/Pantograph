// tools/icon-weight.mjs — единый вес штриха у набора готовых SVG-значков.
//
//   node tools/icon-weight.mjs <папка svg> --out <папка>
//        [--frame grid|tight] [--weight W] [--gap G] [--render svg|chrome]
//        [--outline curves|arcs] [--box 24] [--pad 0.045] [--cap 18.5] [--order <папка с MANIFEST.md>]
//        [--variants a,b] [--sample имя,имя] [--keep имя,имя] [--only имя,имя] [--contact-only]
//
// Два вида наборов:
//
//   --frame grid (умолчание) — сетка 20×20 с полями (набор Idyllium): viewBox
//     любой, приводится к 20 масштабом; W и G — в единицах сетки (1.4 и 0.7).
//     Значок, подошедший к краю сетки ближе 0.3 (страница в Inkscape подогнана
//     по рисунку), вписывается в --cap единиц.
//   --frame tight — рисунок впритык к своему квадратному viewBox (набор
//     SignoreBot: поле добавляет сборка приложения). W и G — в процентах
//     стороны кадра (8.5 и W/2); кадр выхода — прежний viewBox, раздвинутый
//     ровно на столько, на сколько вырос рисунок, в сетке --box.
//
// Растр — 800×800 на рабочий кадр: встроенным читателем (--render svg: только
// <path> и <g>, viewBox и transform учитываются) или headless Chrome
// (--render chrome: любой SVG — <rect> с поворотом, <line> со штрихом, стили).
// У каждого куска край сдвигается до общей толщины (js/prep/weight.js),
// результат обводится заново заливкой: один <path fill="currentColor">.
// --outline curves — кривые Безье (для рисованных наборов: форма живая);
// --outline arcs — отрезки и дуги (для геометричных: прямая — один отрезок,
// скругление — дуга; сдвиг на долю пикселя квантуется сеткой, и кривые
// повторяли бы эту лесенку волной на прямых кромках).
//
// Выход: <out>/svg/, <out>/contact/ (сравнение v1 | v2, палитра на светлом и
// тёмном, варианты толщины), <out>/REPORT.md и contact/report.json.
// --pad — поле вокруг viewBox только при показе на листах (как у сборки
// приложения, чтобы листы выглядели как экран).

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync, mkdtempSync, rmSync } from 'node:fs';
import { execSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join, resolve, basename, dirname } from 'node:path';
import { parsePath, toNodes, readPng } from '../tests/fontref.mjs';
import { rasterizeShape, mismatch } from '../js/trace/rasterize.js';
import { traceMask } from '../js/trace/trace.js';
import { outlineArcs, DEFAULTS as OUTLINE_DEFAULTS } from '../js/assemble/outline.js';
import { gaussian } from '../js/prep/mask.js';
import { evenWeight, strokeWidth } from '../js/prep/weight.js';
import { labelComponents } from '../js/glyphs/segment.js';
import { segment, segmentCount } from '../js/core/path.js';
import { sizeFactor, scaleControls } from '../js/ui/params.js';

const BOX = 20;                 // рабочий кадр — 20 единиц
const RES = 40;                 // px рабочего растра на единицу
const N = BOX * RES;
const K = 10;                   // px «кропа» на единицу: в них заданы допуски трассировщика
const SCALE = RES / K;
const MARGIN = 0.1;             // tight: поле рабочего кадра вокруг viewBox, доля стороны — место для роста

// ─── ключи ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opt = (key, def) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : def; };
const SRC = resolve(args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--'))) ?? '.');
if (!args.includes('--out')) throw new Error('нужен --out <папка>: вход не перезаписывается');
const OUT = resolve(opt('--out'));
const FRAME = opt('--frame', 'grid');
if (!['grid', 'tight'].includes(FRAME)) throw new Error('--frame: grid или tight');
const TIGHT = FRAME === 'tight';
const RENDER = opt('--render', 'svg');
const OUTLINE = opt('--outline', 'curves');
if (!['curves', 'arcs'].includes(OUTLINE)) throw new Error('--outline: curves или arcs');
if (!['svg', 'chrome'].includes(RENDER)) throw new Error('--render: svg или chrome');
const WEIGHT = +opt('--weight', TIGHT ? 8.5 : 1.4);
const GAP = +opt('--gap', TIGHT ? WEIGHT / 2 : 0.7);
const BOX_OUT = TIGHT ? +opt('--box', 24) : BOX;
const PAD = +opt('--pad', 0);
const CAP = +opt('--cap', 18.5);
const ORDER = opt('--order', existsSync(join(dirname(SRC), 'MANIFEST.md')) ? dirname(SRC) : null);
const VARIANTS = (opt('--variants', '') || '').split(',').filter(Boolean).map(Number);
const SAMPLE = opt('--sample', null);
const ONLY = opt('--only', null);
const KEEP = new Set((opt('--keep', '') || '').split(',').filter(Boolean));   // эти значки — как были (фирменный знак, заливка)
const CONTACT_ONLY = args.includes('--contact-only');
const UNIT = TIGHT ? '% стороны кадра' : 'ед. сетки 20';
const fmtW = (v) => (TIGHT ? `${v.toFixed(1)}%` : v.toFixed(2));

// Допуски обводки — умолчания приложения для кропа 200 px (K единиц на клетку),
// точность и упрощение плотнее: вход чистый, шуметь нечему.
const F = sizeFactor(BOX * K, BOX * K);
const suggested = Object.fromEntries(scaleControls(F).map((c) => [c.key, c.value]));
const TRACE = { ...suggested, level: 0.5, fitError: 0.3, simplify: 0.25 };

// ─── чтение SVG встроенным читателем ────────────────────────────────────────

const mul = (a, b) => [
  a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1],
  a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
  a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5],
];
const ID = [1, 0, 0, 1, 0, 0];

function parseTransform(s) {
  let m = ID;
  if (!s) return m;
  for (const [, fn, argStr] of s.matchAll(/(\w+)\s*\(([^)]*)\)/g)) {
    const a = argStr.split(/[\s,]+/).filter(Boolean).map(Number);
    let t;
    if (fn === 'translate') t = [1, 0, 0, 1, a[0], a[1] ?? 0];
    else if (fn === 'scale') t = [a[0], 0, 0, a[1] ?? a[0], 0, 0];
    else if (fn === 'matrix') t = a;
    else if (fn === 'rotate') {
      const r = (a[0] * Math.PI) / 180;
      t = [Math.cos(r), Math.sin(r), -Math.sin(r), Math.cos(r), 0, 0];
      if (a.length === 3) t = mul(mul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
    } else throw new Error(`transform ${fn}() не поддержан`);
    m = mul(m, t);
  }
  return m;
}

const attr = (tag, name) => new RegExp(`\\s${name}\\s*=\\s*"([^"]*)"`).exec(tag)?.[1];
const viewBoxOf = (src) => {
  const svgTag = /<svg\b[^>]*>/s.exec(src)?.[0];
  if (!svgTag) throw new Error('нет <svg>');
  return { svgTag, vb: (attr(svgTag, 'viewBox') ?? `0 0 ${BOX} ${BOX}`).trim().split(/[\s,]+/).map(Number) };
};

/**
 * Преобразование viewBox → рабочий кадр: сторона кадра BOX, viewBox по центру.
 * margin — доля стороны viewBox вокруг него (tight: место для роста рисунка).
 */
function frameOf(vb, margin) {
  const side = Math.max(vb[2], vb[3]);
  const k = BOX / (side * (1 + 2 * margin));
  const cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
  return { k, m: [k, 0, 0, k, BOX / 2 - cx * k, BOX / 2 - cy * k], side };
}

/** SVG → контуры в рабочем кадре + чем файл отличается от ТЗ. Только <path> и <g>. */
export function readIconSvg(file, margin = 0) {
  const src = readFileSync(file, 'utf8');
  const foreign = [];
  const { svgTag, vb } = viewBoxOf(src);
  if (!TIGHT && vb.join(' ') !== `0 0 ${BOX} ${BOX}`) foreign.push(`viewBox="${vb.join(' ')}"`);
  const stack = [frameOf(vb, margin).m];
  const contours = [];
  let rule = null;
  const body = src.slice(src.indexOf(svgTag) + svgTag.length);
  for (const m of body.matchAll(/<(\/?)([a-zA-Z][\w:-]*)\b([^>]*?)(\/?)>/gs)) {
    const [whole, close, name, , self] = m;
    if (name === 'g') {
      if (close) { stack.pop(); continue; }
      const t = attr(whole, 'transform');
      if (t) foreign.push('<g transform>');
      if (!self) stack.push(mul(stack[stack.length - 1], parseTransform(t)));
      continue;
    }
    if (close || name === 'svg') continue;
    if (['defs', 'sodipodi:namedview', 'metadata', 'title', 'desc'].includes(name)) continue;
    if (name !== 'path') throw new Error(`${basename(file)}: <${name}> не поддержан — только <path> и <g> (или --render chrome)`);
    const d = attr(whole, 'd');
    if (!d) continue;
    const style = attr(whole, 'style') ?? '';
    const stroke = attr(whole, 'stroke') ?? /stroke\s*:\s*([^;]+)/.exec(style)?.[1];
    if (stroke && stroke.trim() !== 'none') throw new Error(`${basename(file)}: <path> со штрихом — вход только заливкой (или --render chrome)`);
    const fill = attr(whole, 'fill');
    if (fill !== 'currentColor') foreign.push(fill ? `fill="${fill}"` : 'без fill');
    const r = attr(whole, 'fill-rule') ?? /fill-rule\s*:\s*(\w+)/.exec(style)?.[1] ?? 'nonzero';
    if (rule && rule !== r) throw new Error(`${basename(file)}: разные fill-rule в одном значке`);
    rule = r;
    const t = attr(whole, 'transform');
    if (t) foreign.push('<path transform>');
    const M = mul(stack[stack.length - 1], parseTransform(t));
    const ap = (p) => ({ x: M[0] * p.x + M[2] * p.y + M[4], y: M[1] * p.x + M[3] * p.y + M[5] });
    for (const c of parsePath(d.replace(/\s+/g, ' '))) {
      for (const s of c.segs) s.pts = s.pts.map(ap);
      const nodes = toNodes(c);
      if (nodes.length >= 2) contours.push({ closed: true, nodes });
    }
  }
  if (!contours.length) throw new Error(`${basename(file)}: ни одного контура`);
  return { contours, rule: rule ?? 'nonzero', foreign: [...new Set(foreign)] };
}

// ─── растр через Chrome ─────────────────────────────────────────────────────

let renderDir = null;
/** Любой SVG → двоичная маска рабочего кадра: Chrome рисует, берём покрытие ≥ 0.5. */
function renderChrome(file, margin) {
  renderDir ??= mkdtempSync(join(tmpdir(), 'icon-weight-'));
  let src = readFileSync(file, 'utf8').replace(/<\?xml[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const { svgTag, vb } = viewBoxOf(src);
  const { k } = frameOf(vb, margin);
  const Fside = BOX / k;
  const cx = vb[0] + vb[2] / 2, cy = vb[1] + vb[3] / 2;
  const root = svgTag.replace(/\sviewBox="[^"]*"/, '').replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '')
    .replace(/<svg\b/, `<svg width="${N}" height="${N}" viewBox="${cx - Fside / 2} ${cy - Fside / 2} ${Fside} ${Fside}" preserveAspectRatio="xMidYMid meet"`);
  src = src.replace(svgTag, root);
  const base = join(renderDir, basename(file, '.svg'));
  writeFileSync(`${base}.html`, `<!doctype html><meta charset="utf-8"><style>html,body{margin:0;background:#fff;color:#000;overflow:hidden}svg{display:block}</style>${src}`);
  execSync(`google-chrome --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 --window-size=${N},${N} --screenshot=${base}.png file://${base}.html 2>/dev/null`);
  const img = readPng(`${base}.png`);
  if (img.width !== N || img.height !== N) throw new Error(`${basename(file)}: Chrome отдал ${img.width}×${img.height} вместо ${N}×${N}`);
  const bin = new Uint8Array(N * N);
  for (let i = 0; i < N * N; i += 1) {
    const lum = (0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2]) / 255;
    bin[i] = 1 - lum >= 0.5 ? 1 : 0;
  }
  const foreign = [];
  if (/(?:fill|stroke)\s*[:=]\s*"?(#[0-9a-fA-F]{3,8}|black|rgb\()/.test(src)) foreign.push('зашитый цвет');
  const kinds = [...new Set([...src.matchAll(/<(rect|line|polyline|polygon|circle|ellipse)\b/g)].map((x) => `<${x[1]}>`))];
  if (kinds.length) foreign.push(kinds.join(' '));
  if (/stroke\s*[:=]\s*"?(?!none)[#a-zA-Z]/.test(src.replace(/stroke-[a-z]+/g, ''))) foreign.push('штрих');
  return { bin, foreign };
}

// ─── растр и обводка ────────────────────────────────────────────────────────

const rasterOf = (shape, rule = 'nonzero') => Uint8Array.from(rasterizeShape(shape, N, N, RES, 16, rule));
const maskOf = (u8) => ({ w: N, h: N, data: Float32Array.from(u8) });

function bboxOf(u8) {
  let x0 = N, y0 = N, x1 = -1, y1 = -1;
  for (let i = 0; i < u8.length; i += 1) {
    if (!u8[i]) continue;
    const x = i % N, y = (i - x) / N;
    if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
  }
  return [x0 / RES, y0 / RES, (x1 + 1) / RES, (y1 + 1) / RES];
}
const sideOf = (b) => Math.max(b[2] - b[0], b[3] - b[1]);

const mapShape = (shape, T) => ({
  contours: shape.contours.map((c) => ({ ...c, nodes: c.nodes.map((nd) => ({ ...nd, p: T(nd.p), in: nd.in && T(nd.in), out: nd.out && T(nd.out) })) })),
});

/**
 * grid: значок, подошедший к краю сетки ближе EDGE (страница в Inkscape
 * подогнана по рисунку), — вписать в cap единиц по центру. Прочие не
 * трогаются: их размер задан нарезкой (партия, предел 18.5).
 */
const EDGE = 0.3;
function fitToCap(shape, rule) {
  const bin = rasterOf(shape, rule);
  const [x0, y0, x1, y1] = bboxOf(bin);
  const side = Math.max(x1 - x0, y1 - y0);
  if (Math.min(x0, y0, BOX - x1, BOX - y1) >= EDGE) return { shape, bin, note: null };
  const k = CAP / side;
  const cx = (x0 + x1) / 2, cy = (y0 + y1) / 2;
  const fitted = mapShape(shape, (p) => ({ x: BOX / 2 + (p.x - cx) * k, y: BOX / 2 + (p.y - cy) * k }));
  return { shape: fitted, bin: rasterOf(fitted, rule), note: `вписан: ${side.toFixed(2)} → ${CAP} ед. (упирался в край сетки)` };
}

/** Двоичная маска → контуры в рабочем кадре: размытие в 1.5 px снимает лесенку (см. mask.gaussian). */
function traceClean(u8) {
  const shape = traceMask(gaussian(maskOf(u8), 1.5), SCALE, TRACE);
  return mapShape(shape, (p) => ({ x: p.x / K, y: p.y / K }));
}

/**
 * Двоичная маска → контуры из отрезков и дуг (в рабочем кадре): прямая
 * кромка — один отрезок, скругление — дуга, острый угол — в пересечение
 * прямых (assemble/outline.js).
 */
function outlineArcsUnits(u8) {
  const shape = outlineArcs(maskOf(u8), { minArea: TRACE.minArea * SCALE * SCALE });
  return mapShape(shape, (p) => ({ x: p.x / RES, y: p.y / RES }));
}
/**
 * Обводка с проверкой: средний увод края от маски (px). Контур из дуг, не
 * легший на маску (увод больше OUTLINE_GUARD — так было, когда дуга обошла
 * круг и залила полкартинки), заменяется обводкой кривыми, и отчёт это пишет.
 */
const OUTLINE_GUARD = 1.0;
function outlineOf(u8) {
  const drift = (shape) => mismatch(maskOf(u8), shape, RES, 1).drift;
  if (OUTLINE !== 'arcs') { const shape = traceClean(u8); return { shape, drift: drift(shape), note: null }; }
  const arcs = outlineArcsUnits(u8);
  const d = drift(arcs);
  if (d <= OUTLINE_GUARD) return { shape: arcs, drift: d, note: null };
  const shape = traceClean(u8);
  return { shape, drift: drift(shape), note: `контур из дуг разошёлся с маской (увод ${d.toFixed(2)} px) — обведён кривыми` };
}

const fix = (v) => (v.toFixed(2).replace(/\.?0+$/, '').replace(/^-0$/, '0') || '0');

/** Контуры → d: прямые куски — L, прочие — C. */
function pathData(shape) {
  const P = (p) => `${fix(p.x)} ${fix(p.y)}`;
  const out = [];
  for (const c of shape.contours) {
    if (!c.nodes.length) continue;
    out.push(`M${P(c.nodes[0].p)}`);
    for (let i = 0; i < segmentCount(c); i += 1) {
      const [p0, p1, p2, p3] = segment(c, i);
      const straight = Math.hypot(p1.x - p0.x, p1.y - p0.y) < 1e-6 && Math.hypot(p2.x - p3.x, p2.y - p3.y) < 1e-6;
      out.push(straight ? `L${P(p3)}` : `C${P(p1)} ${P(p2)} ${P(p3)}`);
    }
    if (c.closed) out.push('Z');
  }
  return out.join('');
}

const svgOf = (shape) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX_OUT} ${BOX_OUT}" width="${BOX_OUT}" height="${BOX_OUT}">\n`
  + `<path d="${pathData(shape)}" fill="currentColor"/>\n</svg>\n`;

// ─── сверка ─────────────────────────────────────────────────────────────────

/** Куски чернил (8-связно) и дыры (фон без выхода к краю, 4-связно). */
function topology(u8) {
  const ink = labelComponents(maskOf(u8));
  const seen = new Uint8Array(N * N);
  let holes = 0;
  const stack = [];
  for (let s = 0; s < u8.length; s += 1) {
    if (u8[s] || seen[s]) continue;
    let edge = false, area = 0;
    seen[s] = 1; stack.push(s);
    while (stack.length) {
      const i = stack.pop();
      area += 1;
      const x = i % N, y = (i - x) / N;
      if (x === 0 || y === 0 || x === N - 1 || y === N - 1) edge = true;
      for (const j of [x > 0 ? i - 1 : -1, x < N - 1 ? i + 1 : -1, y > 0 ? i - N : -1, y < N - 1 ? i + N : -1]) {
        if (j >= 0 && !u8[j] && !seen[j]) { seen[j] = 1; stack.push(j); }
      }
    }
    if (!edge && area >= 16) holes += 1;
  }
  return { pieces: ink.count, holes };
}

// ─── порядок и прогон ───────────────────────────────────────────────────────

/** Порядок и листы — из MANIFEST.md генератора, если он есть; иначе по алфавиту кусками по 24. */
function orderOf(names) {
  const chunks = (list, file) => {
    if (list.length <= 24) return [{ file, names: list }];
    const out = [];
    for (let i = 0; i < list.length; i += 24) out.push({ file: `${file} ${i / 24 + 1}`, names: list.slice(i, i + 24) });
    return out;
  };
  if (!ORDER) return chunks(names, 'все');
  const text = readFileSync(join(ORDER, 'MANIFEST.md'), 'utf8');
  const sheets = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const head = /^(\S+\.png)\s+[—-]/.exec(part);
    if (!head) continue;
    const para = part.split('\n').slice(1).join('\n').trim().split(/\n\s*\n/)[0];
    const list = [...para.matchAll(/`([^`]+)`/g)].map((x) => x[1]).filter((n) => names.includes(n));
    if (list.length) sheets.push({ file: head[1], names: list });
  }
  const listed = new Set(sheets.flatMap((s) => s.names));
  const rest = names.filter((n) => !listed.has(n));
  if (rest.length) sheets.push(...chunks(rest, 'вне манифеста'));
  return sheets;
}

const names = readdirSync(SRC).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort()
  .filter((n) => !ONLY || ONLY.split(',').includes(n));
const sheets = orderOf(names);
mkdirSync(join(OUT, 'svg'), { recursive: true });
mkdirSync(join(OUT, 'contact'), { recursive: true });

/** Значок v1 в рабочем кадре: растр, вектор (если прочитан) и что в нём не по ТЗ. Один раз на имя. */
const loaded = new Map();
function loadIcon(name) {
  if (loaded.has(name)) return loaded.get(name);
  const file = join(SRC, `${name}.svg`);
  const margin = TIGHT ? MARGIN : 0;
  let icon;
  if (RENDER === 'chrome') {
    const { bin, foreign } = renderChrome(file, margin);
    icon = { bin, vector: null, foreign, note: null };
  } else {
    const { contours, rule, foreign } = readIconSvg(file, margin);
    const fit = TIGHT ? { shape: { contours }, bin: rasterOf({ contours }, rule), note: null } : fitToCap({ contours }, rule);
    icon = { bin: fit.bin, vector: fit.shape, foreign, note: fit.note };
  }
  // Кадр v1 в рабочих единицах: сетка целиком (grid) или viewBox без поля (tight).
  icon.frameSide = TIGHT ? BOX / (1 + 2 * MARGIN) : BOX;
  loaded.set(name, icon);
  return icon;
}

/**
 * Один значок с заданной толщиной: svg-строка и сводка.
 * tight: толщина — доля стороны кадра ВЫХОДА, а кадр раздвигается ровно на
 * рост рисунка, поэтому толщина подбирается в два-три прохода.
 */
function weigh(name, weight) {
  const src = loadIcon(name);
  const b1 = bboxOf(src.bin);
  const s1 = sideOf(b1);
  let side = src.frameSide;          // кадр выхода в рабочих единицах
  let r = null;
  if (KEEP.has(name)) r = { out: src.bin, allSolid: true, kept: true, parts: [], notes: ['оставлен как был (--keep)'] };
  for (let pass = 0; pass < 3 && !r?.kept; pass += 1) {
    const target = TIGHT ? (weight / 100) * side : weight;
    const gap = TIGHT ? (GAP / 100) * side : GAP;
    r = evenWeight(maskOf(src.bin), target * RES, { gap: gap / target });
    if (!TIGHT) break;
    const next = src.frameSide + (sideOf(bboxOf(r.out)) - s1);
    if (Math.abs(next - side) * RES < 0.5) { side = next; break; }
    side = next;
  }
  const traced = r.allSolid && src.vector ? { shape: src.vector, drift: 0, note: null } : outlineOf(r.allSolid ? src.bin : r.out);
  const shape = traced.shape;
  if (traced.note) r.notes.push(traced.note);
  const v2 = rasterOf(shape);
  const w1 = strokeWidth(maskOf(src.bin)), w2 = strokeWidth(maskOf(v2));
  const t1 = topology(src.bin), t2 = topology(v2);
  const b2 = bboxOf(v2);
  const flags = [];
  if (t2.holes !== t1.holes) flags.push(`дыр ${t1.holes}→${t2.holes}`);
  if (t2.pieces !== t1.pieces) flags.push(`кусков ${t1.pieces}→${t2.pieces}`);
  let out = shape;
  let frameOut = side;
  if (TIGHT) {
    // Кадр выхода: прежний viewBox, раздвинутый на рост рисунка, центр — центр рисунка.
    frameOut = src.frameSide + (sideOf(b2) - s1);
    const cx = (b2[0] + b2[2]) / 2, cy = (b2[1] + b2[3]) / 2;
    const k = BOX_OUT / frameOut;
    out = mapShape(shape, (p) => ({ x: BOX_OUT / 2 + (p.x - cx) * k, y: BOX_OUT / 2 + (p.y - cy) * k }));
  } else if (b2[0] < 0.25 || b2[1] < 0.25 || b2[2] > BOX - 0.25 || b2[3] > BOX - 0.25) flags.push('у края сетки');
  const toW = (px, frame) => (TIGHT ? (px / RES / frame) * 100 : px / RES);
  const segs = shape.contours.reduce((s, c) => s + segmentCount(c), 0);
  return {
    svg: svgOf(out),
    row: {
      name, allSolid: r.allSolid, kept: !!r.kept,
      v1: +toW(w1.med, src.frameSide).toFixed(2), v2: +toW(w2.med, frameOut).toFixed(2),
      v2p10: +toW(w2.p10, frameOut).toFixed(2), v2p90: +toW(w2.p90, frameOut).toFixed(2),
      parts: r.parts.map((p) => ({ w: +(p.width / RES).toFixed(2), shift: +(p.shift / RES).toFixed(2), solid: p.solid, cut: p.yielded })),
      segs, drift: +traced.drift.toFixed(2), flags, foreign: src.foreign,
      notes: [src.note, ...r.notes.filter((n) => !/^(вырез|теснота|дыра)/.test(n))].filter(Boolean),
      cuts: r.notes.filter((n) => n.startsWith('вырез')).length,
      apart: r.notes.filter((n) => n.startsWith('теснота')).length,
      holesKept: r.notes.filter((n) => n.startsWith('дыра')).length,
    },
  };
}

/** Что удержано при росте — коротко: вырезы, куски врозь, просветы дыр. */
function keptOf(r) {
  const out = [];
  if (r.cuts) out.push(`вырезов ${r.cuts}`);
  if (r.apart) out.push(`кусков врозь ${r.apart}`);
  if (r.holesKept) out.push(`дыр с просветом ${r.holesKept}`);
  return out;
}

const t0 = performance.now();
let rows;
if (CONTACT_ONLY) {
  rows = JSON.parse(readFileSync(join(OUT, 'contact', 'report.json'), 'utf8')).rows;
} else {
  rows = [];
  for (const name of sheets.flatMap((s) => s.names)) {
    const { svg, row } = weigh(name, WEIGHT);
    writeFileSync(join(OUT, 'svg', `${name}.svg`), svg);
    rows.push(row);
    const extra = [...row.notes, ...keptOf(row)];
    console.log(`${name.padEnd(22)} ${fmtW(row.v1)} → ${fmtW(row.v2)}  ${row.flags.join('; ')}${extra.length ? `  · ${extra.join('; ')}` : ''}`);
  }
  writeFileSync(join(OUT, 'contact', 'report.json'), JSON.stringify({ frame: FRAME, weight: WEIGHT, gap: GAP, cap: CAP, rows }, null, 1));
}

// ─── варианты толщины ───────────────────────────────────────────────────────

const idylliumSample = ['upload', 'download', 'menu', 'check-circle', 'settings', 'eye-off', 'bell', 'file-text',
  'folder', 'section-oop', 'section-network', 'widget-Slider', 'widget-TextEdit', 'arrow-right', 'trash', 'link'];
let variantNames = SAMPLE ? SAMPLE.split(',') : idylliumSample;
variantNames = variantNames.filter((n) => names.includes(n));
if (!SAMPLE && variantNames.length < 8) {
  const step = Math.max(1, Math.floor(names.length / 16));
  variantNames = names.filter((_, i) => i % step === 0).slice(0, 16);
}
const variantDirs = [];
for (const v of VARIANTS) {
  const dir = join(OUT, 'contact', `weight-${v}`);
  if (!CONTACT_ONLY) {
    mkdirSync(dir, { recursive: true });
    for (const n of variantNames) writeFileSync(join(dir, `${n}.svg`), weigh(n, v).svg);
  }
  variantDirs.push({ v, dir });
}
if (renderDir) rmSync(renderDir, { recursive: true, force: true });

// ─── контактные листы ───────────────────────────────────────────────────────

/** SVG в строку страницы; --pad раздвигает viewBox, как сборка приложения. */
function inline(file, px) {
  let s = readFileSync(file, 'utf8').replace(/<\?xml[^>]*>/, '').replace(/<!--[\s\S]*?-->/g, '');
  const { svgTag, vb } = viewBoxOf(s);
  let root = svgTag.replace(/\swidth="[^"]*"/, '').replace(/\sheight="[^"]*"/, '');
  if (PAD) {
    const [x, y, w, h] = vb;
    root = root.replace(/\sviewBox="[^"]*"/, ` viewBox="${x - w * PAD} ${y - h * PAD} ${w * (1 + 2 * PAD)} ${h * (1 + 2 * PAD)}"`);
  }
  s = s.replace(svgTag, root.replace(/<svg\b/, `<svg style="width:${px}px;height:${px}px"`));
  return s;
}
const v1File = (n) => join(SRC, `${n}.svg`);
const v2File = (n) => join(OUT, 'svg', `${n}.svg`);
const CSS = `body{margin:12px;font:14px/1.3 sans-serif;background:#fff;color:#111}
h2{font-size:15px;margin:14px 0 6px}.grid{display:grid;grid-template-columns:repeat(4,300px);gap:10px}
figure{margin:0;border:1px solid #ddd;padding:6px}.pair{display:flex;gap:8px}.pair>div{background:#f2f2f2;line-height:0}
.small{display:flex;gap:8px;align-items:center;margin-top:6px}.gap{width:28px}
figcaption{font-size:14px;margin-top:4px}.bad{color:#b00}.dim{color:#666}`;

function shoot(name, html, width, height) {
  const file = join(OUT, 'contact', `${name}.html`);
  writeFileSync(file, html);
  try {
    execSync(`google-chrome --headless=new --disable-gpu --hide-scrollbars --window-size=${width},${height} --screenshot=${join(OUT, 'contact', `${name}.png`)} file://${file} 2>/dev/null`);
  } catch {
    console.log(`google-chrome не найден — ${name} только html`);
  }
}

const info = new Map(rows.map((r) => [r.name, r]));
sheets.forEach((sheet, si) => {
  const figs = sheet.names.map((n) => {
    const r = info.get(n);
    const extra = [...r.notes.filter((x) => !x.startsWith('оставлен как был')), ...keptOf(r)];
    return `<figure><div class="pair"><div>${inline(v1File(n), 140)}</div><div>${inline(v2File(n), 140)}</div></div>`
      + `<div class="small">${[24, 20, 16].map((s) => inline(v1File(n), s)).join('')}<span class="gap"></span>${[24, 20, 16].map((s) => inline(v2File(n), s)).join('')}</div>`
      + `<figcaption><b>${n}</b> <span class="dim">${r.kept ? 'как в v1 (--keep)' : r.allSolid ? 'пятна, как в v1' : `${fmtW(r.v1)} → ${fmtW(r.v2)}`}</span>`
      + `${r.flags.length ? `<br><span class="bad">${r.flags.join('; ')}</span>` : ''}`
      + `${extra.length ? `<br><span class="dim">${extra.join(' · ')}</span>` : ''}</figcaption></figure>`;
  }).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>${CSS}</style><h2>${sheet.file}: слева v1, справа v2 (${fmtW(WEIGHT)})</h2><div class="grid">${figs}</div>`;
  const tag = /^\d+-/.test(sheet.file) ? basename(sheet.file, '.png') : String(si + 1).padStart(2, '0');
  shoot(`compare-${tag}`, html, 1290, Math.ceil(sheet.names.length / 4) * 300 + 70);
});

// Палитра: весь набор рядами, 20 и 16 px, светлый и тёмный фон — как в меню.
{
  const rowsOf = (list) => { const out = []; for (let i = 0; i < list.length; i += 12) out.push(list.slice(i, i + 12)); return out; };
  const lines = sheets.flatMap((s) => rowsOf(s.names));
  const block = (file, bg, fg) => `<div style="background:${bg};color:${fg};padding:10px 12px;border-radius:6px">`
    + lines.map((l) => `<div class="row">${l.map((n) => inline(file(n), 20)).join('')}</div>`
      + `<div class="row">${l.map((n) => inline(file(n), 16)).join('')}</div>`).join('') + '</div>';
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:12px;font:14px sans-serif;background:#fff}
.cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}.row{display:flex;gap:10px;align-items:center;margin:5px 0}
h3{margin:4px 0;font-size:14px}</style>
<div class="cols"><div><h3>v1</h3>${block(v1File, '#fff', '#111')}${block(v1File, '#1e1f22', '#e6e6e6')}</div>
<div><h3>v2 — ${fmtW(WEIGHT)}</h3>${block(v2File, '#fff', '#111')}${block(v2File, '#1e1f22', '#e6e6e6')}</div></div>`;
  shoot('palette', html, 900, lines.length * 2 * 31 * 2 + 140);
}

// Варианты толщины.
if (variantDirs.length) {
  const cols = [{ v: WEIGHT, dir: join(OUT, 'svg') }, ...variantDirs].sort((a, b) => a.v - b.v);
  const rowsHtml = variantNames.map((n) => `<tr><td>${n}</td>${cols.map((c) => `<td>${inline(join(c.dir, `${n}.svg`), 72)} ${inline(join(c.dir, `${n}.svg`), 20)} ${inline(join(c.dir, `${n}.svg`), 16)}</td>`).join('')}</tr>`).join('');
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:12px;font:14px sans-serif}
td{padding:4px 14px 4px 0;vertical-align:middle}svg{vertical-align:middle;background:#f2f2f2}th{text-align:left}</style>
<table><tr><th></th>${cols.map((c) => `<th>${fmtW(c.v)}${c.v === WEIGHT ? ' (набор)' : ''}</th>`).join('')}</tr>${rowsHtml}</table>`;
  shoot('weights', html, 190 + cols.length * 190, variantNames.length * 82 + 60);
}

// ─── отчёт ──────────────────────────────────────────────────────────────────

const strokeRows = rows.filter((r) => !r.allSolid);
const q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };
const spread = (key) => { const a = strokeRows.map((r) => r[key]); return `${fmtW(q(a, 0))}–${fmtW(q(a, 1))}, медиана ${fmtW(q(a, 0.5))}, у 80% значков ${fmtW(q(a, 0.1))}–${fmtW(q(a, 0.9))}`; };
const flagged = rows.filter((r) => r.flags.length);
const shapeNotes = (r) => r.notes.filter((n) => !n.startsWith('весь значок') && !n.startsWith('оставлен как был'));
const noted = rows.filter((r) => shapeNotes(r).length);
const cutRows = rows.filter((r) => r.cuts);
const apartRows = rows.filter((r) => r.apart);
const holeRows = rows.filter((r) => r.holesKept);
const foreignRows = rows.filter((r) => r.foreign.length);
/** Что во входе не по формату — по видам: у скольких и у кого (длинные списки — числом). */
function foreignKinds() {
  const kinds = new Map();
  for (const r of foreignRows) for (const f of r.foreign) for (const k of f.split(/,\s*|\s+(?=<)/)) {
    if (!kinds.has(k)) kinds.set(k, []);
    kinds.get(k).push(r.name);
  }
  return [...kinds].map(([k, list]) => `${k} — ${list.length > 12 ? `${list.length} значков` : list.map((n) => `\`${n}\``).join(', ')}`).join('; ');
}
const sec = ((performance.now() - t0) / 1000).toFixed(0);
const frameText = TIGHT
  ? `Рисунок каждого значка стоит впритык к своему квадратному viewBox (поле
добавляет сборка приложения), поэтому толщина меряется в долях стороны кадра.
Кадр выхода — прежний viewBox, раздвинутый ровно на столько, на сколько вырос
рисунок; сетка выхода — \`viewBox="0 0 ${BOX_OUT} ${BOX_OUT}"\`, рисунок так же впритык.`
  : 'Сетка — `viewBox="0 0 20 20"`, как у входа.';
const report = `# Единый вес штриха — ${basename(OUT)}

Вход: \`${SRC}\` (${rows.length} SVG). Толщина штриха — **${fmtW(WEIGHT)}** (${UNIT}).
Сделано \`node tools/icon-weight.mjs\` из Пантографа${CONTACT_ONLY ? '' : ` за ${sec} с`}${RENDER === 'chrome' ? ', растр — headless Chrome' : ''}.

## Что сделано

Каждый значок растрится в ${N}×${N}. У каждого куска (связной части рисунка)
толщина меряется по скелету, и край куска сдвигается на постоянную величину
(W − w)/2 — тонкое дорастает, толстое худеет, форма остаётся как была. Пятна
(точки, play, бегунок, зрачок) не трогаются. Зазоры держатся: где конец штриха
упирается в борт соседа (перечёркнутый глаз), конец срезается по контуру
соседа — вырез; где борт против борта, куски растут врозь поровну, просвет —
не уже ${fmtW(GAP)} или прежнего, если он был уже; сердцевина мелких дыр не
зарастает. Результат обведён заново заливкой: один \`<path fill="currentColor">\`${OUTLINE === 'arcs' ? `, контур — из отрезков и дуг
(прямая кромка — один отрезок, скругление — дуга, острый угол — в пересечение прямых; допуск
${OUTLINE_DEFAULTS.tol} px растра, ${(OUTLINE_DEFAULTS.tol / RES / (TIGHT ? BOX / (1 + 2 * MARGIN) : BOX) * 100).toFixed(2)}% стороны)` : ''}.
${frameText}

## Толщина до и после (${UNIT}, медиана по скелету значка)

- v1: ${spread('v1')}.
- v2: ${spread('v2')}.
- Контур против маски (средний увод края, px растра ${N}): медиана ${q(rows.map((r) => r.drift ?? 0), 0.5).toFixed(2)}, наибольший ${Math.max(...rows.map((r) => r.drift ?? 0)).toFixed(2)} (\`${rows.reduce((a, b) => ((b.drift ?? 0) > (a.drift ?? 0) ? b : a)).name}\`).
- Значки из одних пятен оставлены как были: ${rows.filter((r) => r.allSolid && !r.kept).map((r) => `\`${r.name}\``).join(', ') || 'нет'}.
${rows.some((r) => r.kept) ? `- Оставлены как были по списку \`--keep\`: ${rows.filter((r) => r.kept).map((r) => `\`${r.name}\``).join(', ')}.\n` : ''}

| значок | v1 | v2 | v2 p10–p90 |
|---|---|---|---|
${strokeRows.map((r) => `| ${r.name} | ${fmtW(r.v1)} | ${fmtW(r.v2)} | ${fmtW(r.v2p10)}–${fmtW(r.v2p90)} |`).join('\n')}

## Что сверка заметила сама

${flagged.length ? flagged.map((r) => `- \`${r.name}\`: ${r.flags.join('; ')}.`).join('\n') : `- Ничего: число кусков и дыр у каждого значка то же, что в v1${TIGHT ? '' : '; к краю сетки никто не подошёл ближе 0.25 ед.'}`}
${noted.length ? `\nПравки формы:\n\n${noted.map((r) => `- \`${r.name}\`: ${shapeNotes(r).join('; ')}.`).join('\n')}` : ''}
${cutRows.length ? `\nВырезы — конец срезан по контуру соседа, чтобы зазор не зарос: ${cutRows.map((r) => `\`${r.name}\` (${r.cuts})`).join(', ')}.` : ''}
${apartRows.length ? `\nКуски растут врозь (борт против борта, зазор держится): ${apartRows.map((r) => `\`${r.name}\` (${r.apart})`).join(', ')}.` : ''}
${holeRows.length ? `\nМелкие дыры держат просвет (рост внутрь ограничен): ${holeRows.map((r) => `\`${r.name}\` (${r.holesKept})`).join(', ')}.` : ''}
${foreignRows.length ? `\nВо входе (в v2 — только \`<path fill="currentColor">\`): ${foreignKinds()}.` : ''}

## Листы

- \`contact/compare-*.png\` — ${ORDER ? 'по листам генератора' : 'по 24 значка'}: v1 слева, v2 справа, ниже 24/20/16 px${PAD ? ` (с полем ${PAD * 100}% вокруг viewBox, как в приложении)` : ''}.
- \`contact/palette.png\` — весь набор в 20 и 16 px на светлом и тёмном фоне, v1 и v2 рядом.
${variantDirs.length ? `- \`contact/weights.png\` — толщины ${[WEIGHT, ...VARIANTS].sort((a, b) => a - b).map(fmtW).join(' / ')} на ${variantNames.length} значках.\n` : ''}
Другая толщина — тот же прогон с \`--weight\` (из папки Пантографа):
\`node tools/icon-weight.mjs ${SRC} --out ${OUT}${TIGHT ? ' --frame tight' : ''}${RENDER === 'chrome' ? ' --render chrome' : ''}${OUTLINE === 'arcs' ? ' --outline arcs' : ''}${PAD ? ` --pad ${PAD}` : ''}${KEEP.size ? ` --keep ${[...KEEP].join(',')}` : ''} --weight ${TIGHT ? '9.5' : '1.5'}\`.
`;
writeFileSync(join(OUT, 'REPORT.md'), report);
console.log(`\nготово: ${rows.length} значков, ${sec} с → ${OUT}`);
