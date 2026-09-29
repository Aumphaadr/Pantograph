// tools/icon-sheets.mjs — листы значков от генератора → отдельные PNG и SVG.
//
//   node tools/icon-sheets.mjs <папка с листами> [ключи]
//
// В папке — листы PNG и MANIFEST.md, где у каждого листа раскладка и имена:
//
//   ## 01-interface-a.png — 4×3          (колонок×рядов; или «— 4+3» по рядам)
//   `menu`, `close`, `check`, …          (слева направо, сверху вниз)
//
// Лист режется НЕ на равные доли: генератор ставит значки неровно, и доля
// рано или поздно рассекает значок. Резы идут по белым промежуткам:
//   1. порог по черноте, связные куски краски (8-связность);
//   2. профиль строк → ряды: из пустых пробегов профиля берутся R−1 самых
//      широких (R — число рядов из манифеста), режем по серединам;
//   3. в каждом ряду профиль столбцов → так же C−1 самых широких промежутков;
//   4. проверка: каждый кусок краски целиком в одной ячейке, ни одной пустой
//      ячейки, и самая узкая выбранная щель шире любой щели ВНУТРИ значков
//      (иначе значок мог быть рассечён по своему пробелу) — нарушение любой
//      из трёх остановит прогон.
//
// Масштаб — общий на партию (слово в имени листа: interface, actions, files…):
// генератор рисует партии разного размера, а внутри партии соотношения — его
// замысел (минус меньше круга). Верхняя четверть партии по размеру ложится
// в --target единиц из 20; значок крупнее --cap единиц ужимается один.
// Центр значка — центр его габарита.
//
// Вырезка — квадрат рамки 20×20 в пикселях листа, без пересэмплирования;
// в неё переносятся только пиксели СВОЕЙ ячейки, чужое остаётся белым.
// Обводка — иконочный маршрут Пантографа с умолчаниями приложения и
// подбором, как у «Подобрать сам», но без осей «Порог» и «Допуск по цвету»:
// они меняют толщину штриха, а её трогать не наше дело.
//
// Ключи:
//   --out DIR      куда класть (по умолчанию — сама папка листов):
//                  png/, svg/, contact/, REPORT.md
//   --target U     размер крупных значков партии, единиц из 20 (17)
//   --cap U        предел для любого значка (18.5)
//   --no-tune      без подбора — умолчания приложения
//   --fit K        «Точность» ×K от умолчания приложения (K<1 — строже)
//   --stroke U     толщина штриха по ТЗ, единиц из 20 (1.5): с ней сверяется вес партий
//   --only A,B     только эти листы (по имени файла, без .png)
//   --dry          только разбор и таблица, без записи
//   --contact-only пересобрать контактные листы из готовых png/, svg/ и
//                  contact/report.json, без обводки

import { readFileSync, writeFileSync, mkdirSync, readdirSync, existsSync } from 'node:fs';
import { deflateSync } from 'node:zlib';
import { execSync } from 'node:child_process';
import { join, resolve, basename } from 'node:path';
import { readPng } from '../tests/fontref.mjs';
import { crc32 } from '../js/export/zip.js';
import { colorDistance, coverageToField, upscale, threshold, morph, capScale, guessBackground, guessForeground } from '../js/prep/mask.js';
import { traceMask } from '../js/trace/trace.js';
import { mismatch } from '../js/trace/rasterize.js';
import { countNodes, transform } from '../js/core/path.js';
import { toPathData } from '../js/export/svg.js';
import { sizeFactor, scaleControls, defaults as paramDefaults } from '../js/ui/params.js';
import { descend } from '../js/tune/tune.js';
import { distanceTransform, thin } from '../js/trace/centerline.js';

const BOX = 20;

// ─── ключи ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const opt = (key, def) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : def; };
const DIR = resolve(args.find((a, i) => !a.startsWith('--') && (i === 0 || !args[i - 1].startsWith('--'))) ?? '.');
const OUT = resolve(opt('--out', DIR));
const TARGET = +opt('--target', 17);
const CAP = +opt('--cap', 18.5);
const TUNE = !args.includes('--no-tune');
const FIT = +opt('--fit', 1);        // множитель к «Точности» приложения
const STROKE = +opt('--stroke', 1.5); // толщина штриха по ТЗ, единиц из 20 — для сверки
const ONLY = opt('--only', null);
const DRY = args.includes('--dry');
const CONTACT_ONLY = args.includes('--contact-only');   // пересобрать только контактные листы из готовых svg/ и отчёта

// ─── манифест ───────────────────────────────────────────────────────────────

/** Листы из MANIFEST.md: файл, число значков по рядам, имена по порядку. */
export function readManifest(dir) {
  const text = readFileSync(join(dir, 'MANIFEST.md'), 'utf8');
  const out = [];
  for (const part of text.split(/^## /m).slice(1)) {
    const lines = part.split('\n');
    const m = /^(\S+\.png)\s+[—-]\s+(.+)$/.exec(lines[0]);
    if (!m) continue;
    const layout = m[2].trim();
    let rows;
    if (/^\d+\s*[×x]\s*\d+$/.test(layout)) {
      const [c, r] = layout.split(/[×x]/).map((v) => +v.trim());
      rows = Array(r).fill(c);
    } else if (/^\d+(\s*\+\s*\d+)+$/.test(layout)) {
      rows = layout.split('+').map((v) => +v.trim());
    } else {
      throw new Error(`${m[1]}: раскладка «${layout}» не прочитана — нужно «C×R» или «4+3»`);
    }
    // Имена — из первого абзаца после заголовка: дальше идут пояснения.
    const para = lines.slice(1).join('\n').trim().split(/\n\s*\n/)[0];
    const names = [...para.matchAll(/`([^`]+)`/g)].map((x) => x[1]);
    const count = rows.reduce((a, b) => a + b, 0);
    if (names.length !== count) throw new Error(`${m[1]}: раскладка на ${count} значков, а имён ${names.length}`);
    out.push({ file: m[1], rows, names, family: familyOf(m[1]) });
  }
  if (!out.length) throw new Error('в MANIFEST.md не нашлось ни одного листа');
  return out;
}

/** Партия листа — слово после номера: «01-interface-a.png» → interface. */
const familyOf = (file) => (/^\d+-([a-z]+)/i.exec(file)?.[1] ?? basename(file, '.png')).toLowerCase();

// ─── разбор листа ───────────────────────────────────────────────────────────

/** Чернота 0..1 (лист уже на белом: readPng сводит прозрачность к белому). */
function inkOf(img) {
  const n = img.width * img.height;
  const ink = new Float32Array(n);
  for (let i = 0; i < n; i += 1) {
    ink[i] = 1 - (0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2]) / 255;
  }
  return ink;
}

/** Связные куски по порогу, 8-связность. */
function components(ink, w, h, level = 0.5) {
  const lab = new Int32Array(w * h).fill(-1);
  const comps = [];
  const stack = [];
  for (let i = 0; i < w * h; i += 1) {
    if (ink[i] <= level || lab[i] >= 0) continue;
    const c = { id: comps.length, area: 0, x0: w, y0: h, x1: -1, y1: -1, sx: 0, sy: 0 };
    lab[i] = c.id;
    stack.push(i);
    while (stack.length) {
      const j = stack.pop();
      const x = j % w;
      const y = (j - x) / w;
      c.area += 1; c.sx += x; c.sy += y;
      if (x < c.x0) c.x0 = x; if (x > c.x1) c.x1 = x;
      if (y < c.y0) c.y0 = y; if (y > c.y1) c.y1 = y;
      for (let dy = -1; dy <= 1; dy += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          const xx = x + dx;
          const yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const k = yy * w + xx;
          if (ink[k] > level && lab[k] < 0) { lab[k] = c.id; stack.push(k); }
        }
      }
    }
    c.cx = c.sx / c.area;
    c.cy = c.sy / c.area;
    comps.push(c);
  }
  return { lab, comps };
}

/** Пустые пробеги профиля внутри [from, to]. */
function emptyRuns(profile, from, to) {
  const out = [];
  let start = -1;
  for (let i = from; i <= to + 1; i += 1) {
    const empty = i <= to && profile[i] === 0;
    if (empty && start < 0) start = i;
    if (!empty && start >= 0) { out.push({ a: start, b: i - 1, len: i - start }); start = -1; }
  }
  return out;
}

/** k−1 самых широких внутренних промежутков; режем по серединам. */
function cutsOf(profile, n, k) {
  let first = 0; while (first < n && profile[first] === 0) first += 1;
  let last = n - 1; while (last >= 0 && profile[last] === 0) last -= 1;
  const inner = emptyRuns(profile, first, last).sort((p, q) => q.len - p.len);
  const chosen = inner.slice(0, k - 1).sort((p, q) => p.a - q.a);
  return {
    first, last,
    cuts: chosen.map((g) => ({ at: (g.a + g.b + 1) / 2, len: g.len })),
    narrowest: chosen.length ? Math.min(...chosen.map((g) => g.len)) : Infinity,
    widestInside: inner.length >= k ? inner[k - 1].len : 0,
    enough: chosen.length === k - 1,
  };
}

/** Толщина штриха значка: медиана 2·(расстояние до фона) по скелету. */
function strokeOf(ink, w, bbox) {
  const pad = 3;
  const x0 = bbox.x0 - pad;
  const y0 = bbox.y0 - pad;
  const cw = bbox.x1 - bbox.x0 + 1 + pad * 2;
  const ch = bbox.y1 - bbox.y0 + 1 + pad * 2;
  const bin = { w: cw, h: ch, data: new Float32Array(cw * ch) };
  for (let y = 0; y < ch; y += 1) {
    for (let x = 0; x < cw; x += 1) {
      const sx = x0 + x;
      const sy = y0 + y;
      bin.data[y * cw + x] = sx >= 0 && sy >= 0 && sx < w && ink[sy * w + sx] > 0.5 ? 1 : 0;
    }
  }
  const dist = distanceTransform(bin);
  const sk = thin(bin);
  const vals = [];
  for (let i = 0; i < sk.length; i += 1) if (sk[i]) vals.push(2 * dist[i] - 1);
  vals.sort((a, b) => a - b);
  return vals.length ? vals[vals.length >> 1] : 0;
}

/**
 * Разбор листа. Бросает, если разрезать честно нельзя: тогда лучше
 * остановиться и сказать, чем выдать значок с чужим куском.
 */
export function analyzeSheet(dir, sheet) {
  const img = readPng(join(dir, sheet.file));
  const { width: w, height: h } = img;
  const ink = inkOf(img);
  const { lab, comps } = components(ink, w, h);

  const rowProf = new Int32Array(h);
  for (let i = 0; i < w * h; i += 1) if (lab[i] >= 0) rowProf[(i - (i % w)) / w] += 1;
  const R = sheet.rows.length;
  const rc = cutsOf(rowProf, h, R);
  if (!rc.enough) throw new Error(`${sheet.file}: рядов по манифесту ${R}, а белых полос между ними меньше`);
  const rowEdges = [0, ...rc.cuts.map((c) => c.at), h];

  const cells = [];
  const rows = [];
  for (let r = 0; r < R; r += 1) {
    const y0 = Math.ceil(rowEdges[r]);
    const y1 = Math.min(h - 1, Math.floor(rowEdges[r + 1]));
    const colProf = new Int32Array(w);
    for (let y = y0; y <= y1; y += 1) for (let x = 0; x < w; x += 1) if (lab[y * w + x] >= 0) colProf[x] += 1;
    const cc = cutsOf(colProf, w, sheet.rows[r]);
    if (!cc.enough) throw new Error(`${sheet.file}, ряд ${r + 1}: значков по манифесту ${sheet.rows[r]}, а промежутков меньше`);
    rows.push({ r, cut: cc });
    const colEdges = [0, ...cc.cuts.map((c) => c.at), w];
    for (let c = 0; c < sheet.rows[r]; c += 1) {
      cells.push({ r, c, x0: colEdges[c], x1: colEdges[c + 1], y0: rowEdges[r], y1: rowEdges[r + 1], comps: [] });
    }
  }

  // Каждый кусок — в ячейку своего центра, и обязан лежать в ней целиком.
  const inCell = (q, x, y) => x >= q.x0 && x < q.x1 && y >= q.y0 && y < q.y1;
  for (const comp of comps) {
    const cell = cells.find((q) => inCell(q, comp.cx, comp.cy));
    if (!cell || !inCell(cell, comp.x0, comp.y0) || !inCell(cell, comp.x1 + 0.5, comp.y1 + 0.5)) {
      throw new Error(`${sheet.file}: кусок у (${Math.round(comp.cx)}, ${Math.round(comp.cy)}) лежит на разрезе`);
    }
    cell.comps.push(comp);
  }
  cells.forEach((cell, i) => {
    if (!cell.comps.length) throw new Error(`${sheet.file}: ячейка «${sheet.names[i]}» пуста — раскладка не совпала`);
    const cs = cell.comps;
    cell.bbox = {
      x0: Math.min(...cs.map((c) => c.x0)), y0: Math.min(...cs.map((c) => c.y0)),
      x1: Math.max(...cs.map((c) => c.x1)), y1: Math.max(...cs.map((c) => c.y1)),
    };
    cell.name = sheet.names[i];
    cell.size = Math.max(cell.bbox.x1 - cell.bbox.x0 + 1, cell.bbox.y1 - cell.bbox.y0 + 1);
    cell.stroke = strokeOf(ink, w, cell.bbox);
  });

  // Запас разреза: самая узкая выбранная щель против самой широкой внутренней.
  const margins = [
    { what: 'ряды', narrowest: rc.narrowest, widestInside: rc.widestInside },
    ...rows.map((row) => ({ what: `ряд ${row.r + 1}`, narrowest: row.cut.narrowest, widestInside: row.cut.widestInside })),
  ];
  for (const m of margins) {
    if (m.widestInside >= m.narrowest) {
      throw new Error(`${sheet.file}, ${m.what}: щель внутри значка (${m.widestInside} px) не уже щели между значками (${m.narrowest} px) — резать по пробелам нельзя`);
    }
  }
  return { img, ink, cells, rc, rows, margins, comps: comps.length };
}

// ─── вырезка ────────────────────────────────────────────────────────────────

/** Квадрат рамки в пикселях листа; переносится только своя ячейка. */
function cropIcon(img, cell, side) {
  const cx = (cell.bbox.x0 + cell.bbox.x1 + 1) / 2;
  const cy = (cell.bbox.y0 + cell.bbox.y1 + 1) / 2;
  const ox = Math.round(cx - side / 2);
  const oy = Math.round(cy - side / 2);
  const data = new Uint8ClampedArray(side * side * 4).fill(255);
  for (let v = 0; v < side; v += 1) {
    const y = oy + v;
    if (y < 0 || y >= img.height || y < cell.y0 || y >= cell.y1) continue;
    for (let u = 0; u < side; u += 1) {
      const x = ox + u;
      if (x < 0 || x >= img.width || x < cell.x0 || x >= cell.x1) continue;
      const s = (y * img.width + x) * 4;
      const d = (v * side + u) * 4;
      data[d] = img.data[s]; data[d + 1] = img.data[s + 1]; data[d + 2] = img.data[s + 2];
    }
  }
  // Рамка обязана вместить весь значок — иначе он обрезан.
  const fits = cell.bbox.x0 >= ox && cell.bbox.y0 >= oy && cell.bbox.x1 < ox + side && cell.bbox.y1 < oy + side;
  if (!fits) throw new Error(`${cell.name}: значок не вошёл в рамку ${side} px`);
  return { img: { width: side, height: side, data }, ox, oy };
}

/** PNG, 8 бит RGB, без фильтров — сжимает zlib. */
function writePng(file, img) {
  const { width: w, height: h, data } = img;
  const raw = Buffer.alloc((w * 3 + 1) * h);
  for (let y = 0; y < h; y += 1) {
    raw[y * (w * 3 + 1)] = 0;
    for (let x = 0; x < w; x += 1) {
      const s = (y * w + x) * 4;
      const d = y * (w * 3 + 1) + 1 + x * 3;
      raw[d] = data[s]; raw[d + 1] = data[s + 1]; raw[d + 2] = data[s + 2];
    }
  }
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const tb = Buffer.concat([Buffer.from(type, 'ascii'), body]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(tb));
    return Buffer.concat([len, tb, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  writeFileSync(file, Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0)),
  ]));
}

// ─── обводка ────────────────────────────────────────────────────────────────

/** Иконочный маршрут приложения: маска → поле → увеличение → изолиния. */
function prepare(img) {
  const f = sizeFactor(img.width, img.height);
  const base = paramDefaults();
  const sc = Object.fromEntries(scaleControls(f).map((c) => [c.key, c.value]));
  const bg = guessBackground(img);
  const fg = guessForeground(img, bg);
  const k = capScale(img.width, img.height, base.upscale);
  const up = upscale(coverageToField(colorDistance(img, { fg, bg, tolerance: base.tolerance })), k);
  const ref = threshold(up, base.level);
  const params = {
    simplify: sc.simplify, fitError: sc.fitError * FIT, cornerAngle: sc.cornerAngle,
    cornerSpan: sc.cornerSpan, open: 0, close: 0,
  };
  return { up, ref, k, params, level: base.level, minArea: sc.minArea, fg, bg };
}

function traceWith(prep, p) {
  const m = morph(prep.up, { open: p.open ?? 0, close: p.close ?? 0 });
  return traceMask(m, prep.k, {
    level: prep.level, simplify: p.simplify, cornerAngle: p.cornerAngle,
    cornerSpan: p.cornerSpan, fitError: p.fitError, minArea: prep.minArea,
  });
}

/** Сверка с ОДНОЙ маской исходных настроек — как в приложении. */
function score(prep, shape) {
  const fit = mismatch(prep.ref, shape, prep.k, Math.max(1, prep.minArea * prep.k * prep.k));
  return { drift: fit.drift / prep.k, compBin: fit.compBin, compRen: fit.compRen };
}

async function traceIcon(img) {
  const prep = prepare(img);
  let params = prep.params;
  let shape = traceWith(prep, params);
  const before = { nodes: countNodes(shape), ...score(prep, shape) };
  if (TUNE) {
    const evaluate = async (cand) => {
      const sh = traceWith(prep, cand);
      return { nodes: countNodes(sh), units: 1, ...score(prep, sh), sh };
    };
    const res = await descend({ evaluate, base: prep.params });
    shape = res.result.sh ?? shape;
    params = res.params;
  }
  const after = { nodes: countNodes(shape), ...score(prep, shape) };
  return { shape, params, before, after, prep };
}

function svgOf(shape, side) {
  const s = BOX / side;
  const local = transform(shape, (p) => ({ x: p.x * s, y: p.y * s }));
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${BOX} ${BOX}" width="${BOX}" height="${BOX}">`
    + `<path d="${toPathData(local, 2)}" fill="currentColor"/></svg>\n`;
}

// ─── прогон ─────────────────────────────────────────────────────────────────

const median = (a) => { const s = a.slice().sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };
const quantile = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor((s.length - 1) * p))]; };

const sheets = readManifest(DIR).filter((s) => !ONLY || ONLY.split(',').includes(basename(s.file, '.png')));
const t0 = performance.now();
const parsed = sheets.map((sheet) => ({ sheet, ...analyzeSheet(DIR, sheet) }));

// Масштаб на партию: верхняя четверть по размеру → TARGET единиц.
const families = new Map();
for (const p of parsed) {
  if (!families.has(p.sheet.family)) families.set(p.sheet.family, []);
  families.get(p.sheet.family).push(...p.cells);
}
const famScale = new Map();
for (const [fam, cells] of families) {
  const p75 = quantile(cells.map((c) => c.size), 0.75);
  famScale.set(fam, { unitsPerPx: TARGET / p75, p75 });
}

if (CONTACT_ONLY) {
  const saved = JSON.parse(readFileSync(join(OUT, 'contact', 'report.json'), 'utf8'));
  contactSheets(parsed, saved.rows);
  console.log(`контактные листы пересобраны → ${join(OUT, 'contact')}`);
  process.exit(0);
}

if (!DRY) for (const sub of ['png', 'svg', 'contact']) mkdirSync(join(OUT, sub), { recursive: true });

const rows = [];
for (const p of parsed) {
  const { sheet, img, cells } = p;
  const fam = famScale.get(sheet.family);
  for (const cell of cells) {
    let upp = fam.unitsPerPx;
    const shrunk = cell.size * upp > CAP;
    if (shrunk) upp = CAP / cell.size;
    const side = Math.round(BOX / upp);
    const row = {
      name: cell.name, sheet: sheet.file, family: sheet.family, pos: `${cell.r + 1}:${cell.c + 1}`,
      pieces: cell.comps.length, sizePx: cell.size, side, units: +(cell.size * BOX / side).toFixed(2),
      strokePx: +cell.stroke.toFixed(1), strokeUnits: +(cell.stroke * BOX / side).toFixed(2), shrunk,
    };
    if (!DRY) {
      const crop = cropIcon(img, cell, side);
      writePng(join(OUT, 'png', `${cell.name}.png`), crop.img);
      const t = await traceIcon(crop.img);
      writeFileSync(join(OUT, 'svg', `${cell.name}.svg`), svgOf(t.shape, side));
      Object.assign(row, {
        nodes: t.after.nodes, nodesBefore: t.before.nodes,
        driftUnits: +(t.after.drift * BOX / side).toFixed(3), driftPx: +t.after.drift.toFixed(2),
        lost: t.after.compBin - t.after.compRen, contours: t.shape.contours.length,
        tuned: Object.fromEntries(Object.entries(t.params).filter(([k2, v]) => v !== t.prep.params[k2]).map(([k2, v]) => [k2, +(+v).toFixed(2)])),
      });
      console.log(`${cell.name.padEnd(22)} ${sheet.file.slice(0, 2)} ${row.pos} · кусков ${String(row.pieces).padStart(2)} · ${row.units.toFixed(1)} ед.${shrunk ? ' (ужат)' : ''} · штрих ${row.strokeUnits.toFixed(2)} ед. · узлов ${t.before.nodes}→${t.after.nodes} · увод ${row.driftUnits.toFixed(3)} ед.${row.lost ? ` · ПОТЕРЯНО ${row.lost}` : ''}`);
    }
    rows.push(row);
  }
}

// ─── отчёт ──────────────────────────────────────────────────────────────────

const sec = ((performance.now() - t0) / 1000).toFixed(0);
const byFamily = [...families.keys()].map((fam) => {
  const rs = rows.filter((r) => r.family === fam);
  const sw = rs.map((r) => r.strokeUnits);
  return { fam, n: rs.length, p75: famScale.get(fam).p75, upp: famScale.get(fam).unitsPerPx, strokeMed: median(sw), strokeMin: Math.min(...sw), strokeMax: Math.max(...sw), shrunk: rs.filter((r) => r.shrunk).length };
});

const cutLines = parsed.map((p) => {
  const worst = p.margins.reduce((m, x) => (x.narrowest / Math.max(1, x.widestInside) < m.narrowest / Math.max(1, m.widestInside) ? x : m), p.margins[0]);
  return `| ${p.sheet.file} | ${p.sheet.rows.join('+')} | ${p.comps} | ${p.rc.cuts.map((c) => Math.round(c.at)).join(', ')} | ${p.rows.map((r) => r.cut.cuts.map((c) => Math.round(c.at)).join(', ')).join(' · ')} | ${worst.narrowest} / ${worst.widestInside} px (${worst.what}) |`;
}).join('\n');

const report = `# Нарезка и обводка листов — ${basename(DIR)}

Сделано Пантографом: \`node tools/icon-sheets.mjs ${DIR}\`${TUNE ? '' : ' --no-tune'}
(${rows.length} значков из ${parsed.length} листов, ${sec} с). Листы не тронуты;
рядом — \`png/\` (вырезки), \`svg/\` (обводка), \`contact/\` (листы для сверки глазами).

## Как резалось

Не на равные доли. Порог по черноте → связные куски краски → белые полосы:
между рядами — самые широкие пустые строки профиля (рядов столько, сколько
в манифесте), в каждом ряду — самые широкие пустые столбцы. Проверено на
каждом листе: каждый кусок краски целиком в своей ячейке, пустых ячеек нет,
и самая узкая щель между значками шире самой широкой щели внутри значка
(последний столбец: «узкая между / широкая внутри»).

| лист | раскладка | кусков | резы рядов, y | резы колонок по рядам, x | запас |
|---|---|---|---|---|---|
${cutLines}

## Масштаб и рамка

Вырезка — квадрат рамки 20×20 в пикселях листа, без пересэмплирования; центр
значка — центр его габарита; в квадрат перенесены только пиксели своей
ячейки. Масштаб общий на партию: верхняя четверть партии по размеру ложится
в ${TARGET} единиц из 20, любой значок крупнее ${CAP} ужат отдельно.

| партия | значков | верхняя четверть, px | px на единицу | штрих, ед. (медиана, мин–макс) | ужато |
|---|---|---|---|---|---|
${byFamily.map((b) => `| ${b.fam} | ${b.n} | ${b.p75} | ${(1 / b.upp).toFixed(1)} | ${b.strokeMed.toFixed(2)} (${b.strokeMin.toFixed(2)}–${b.strokeMax.toFixed(2)}) | ${b.shrunk} |`).join('\n')}

Толщина — как нарисовал генератор: медиана двойного расстояния до фона по
осевой линии значка (у сплошных знаков — звезды, play, stop — это толщина
пятна, а не линии). По ТЗ штрих — ${STROKE} единицы у всего набора.
${(() => {
  const off = byFamily.filter((b) => Math.abs(b.strokeMed - STROKE) / STROKE > 0.2);
  if (!off.length) return 'Все партии в пределах ±20 % от этой толщины.';
  return `**Вес набора не единый.** Дальше ±20 % от ${STROKE} единицы: `
    + off.map((b) => `${b.fam} — ${b.strokeMed.toFixed(2)}`).join(', ')
    + '. Масштабом это не лечится: у таких партий штрих тонок или толст относительно '
    + 'самого значка, и вписать значок в рамку со штрихом ' + STROKE + ' нельзя. Лечится '
    + 'перегенерацией листа с явной толщиной или обводкой осевой линией с общей толщиной.';
})()}

## SVG

\`viewBox="0 0 20 20"\`, один \`<path fill="currentColor">\`, координаты с двумя
знаками. Обводка — иконочный маршрут Пантографа с умолчаниями приложения${TUNE ? ` и
подбором, как у «Подобрать сам», без осей «Порог» и «Допуск по цвету» (они
меняют толщину штриха)` : ''}${FIT !== 1 ? `, «Точность» ×${FIT}` : ''}. Увод — средний
сдвиг края контура от растра, в единицах сетки 20.

Это обводка КОНТУРОМ: штрих — залитая фигура из двух кромок. Длинные прямые
в ней — кубики в пределах допуска подгонки, и на увеличении от 300 px видна
лёгкая волна (местный отход до ~0.08 единицы; в 16–24 px — сотые доли
пикселя). Толщину такой обводки атрибутом не поменять — она нарисована.

| значок | лист, ряд:место | кусков | размер, ед. | штрих, ед. | узлов | увод, ед. |
|---|---|---|---|---|---|---|
${rows.map((r) => `| ${r.name} | ${r.sheet.slice(0, 2)} ${r.pos} | ${r.pieces} | ${r.units.toFixed(1)}${r.shrunk ? ' (ужат)' : ''} | ${r.strokeUnits.toFixed(2)} | ${r.nodes ?? '—'} | ${r.driftUnits !== undefined ? r.driftUnits.toFixed(3) : '—'}${r.lost ? ` ⚠ потеряно кусков: ${r.lost}` : ''} |`).join('\n')}
`;

if (DRY) {
  console.log(report);
} else {
  writeFileSync(join(OUT, 'REPORT.md'), report);
  writeFileSync(join(OUT, 'contact', 'report.json'), JSON.stringify({ rows, families: byFamily }, null, 1));
  contactSheets(parsed, rows);
  const drifts = rows.map((r) => r.driftUnits);
  console.log(`\n${rows.length} значков за ${sec} с · узлов ${rows.reduce((a, r) => a + r.nodes, 0)} · увод медиана ${median(drifts).toFixed(3)} ед., макс ${Math.max(...drifts).toFixed(3)} · потеряно кусков у ${rows.filter((r) => r.lost > 0).length}, лишних у ${rows.filter((r) => r.lost < 0).length}`);
  console.log(`→ ${OUT}`);
}

// ─── контактные листы ───────────────────────────────────────────────────────

/** По листу: вырезка · SVG крупно · SVG в 24, 20, 16 px; и сводка весов. */
function contactSheets(parsedSheets, allRows) {
  const style = `<style>body{margin:0;background:#fff;color:#222;font:13px sans-serif}
.grid{display:grid;grid-template-columns:repeat(4,auto);gap:10px 18px;padding:10px}
.cell{display:flex;align-items:center;gap:6px}.big{width:120px;height:120px;border:1px solid #ddd}
.big svg,.big img{width:120px;height:120px;display:block}.sm{display:flex;flex-direction:column;gap:6px;align-items:center}
.sm svg{display:block}.n{width:118px;font-size:12px;line-height:1.35}.warn{color:#b00}
.row{display:flex;gap:10px;align-items:center;padding:6px 10px;flex-wrap:wrap}.row b{width:92px;font-weight:600}
.dark{background:#1e2127;color:#e6e6e6}</style>`;
  const svgFile = (name) => readFileSync(join(OUT, 'svg', `${name}.svg`), 'utf8');
  const sized = (svg, px) => svg.replace(/width="20" height="20"/, `width="${px}" height="${px}"`);
  for (const p of parsedSheets) {
    const rs = allRows.filter((r) => r.sheet === p.sheet.file);
    const cells = rs.map((r) => {
      const svg = svgFile(r.name);
      // Вырезка — ссылкой на png/: встраивать base64 значило бы хранить
      // каждую картинку дважды.
      return `<div class="cell"><div class="big"><img src="../png/${r.name}.png"></div>`
        + `<div class="big">${sized(svg, 120)}</div><div class="sm">${sized(svg, 24)}${sized(svg, 20)}${sized(svg, 16)}</div>`
        + `<div class="n"><b>${r.name}</b><br>${r.units.toFixed(1)} ед.${r.shrunk ? ' (ужат)' : ''}<br>штрих ${r.strokeUnits.toFixed(2)}<br>узлов ${r.nodes}<br>`
        + `<span class="${r.lost ? 'warn' : ''}">увод ${r.driftUnits.toFixed(3)}${r.lost ? ` · потеряно ${r.lost}` : ''}</span></div></div>`;
    }).join('');
    const html = `<!doctype html><meta charset="utf-8">${style}<div class="grid">${cells}</div>`;
    shoot(html, `contact-${basename(p.sheet.file, '.png')}`, 1650, Math.ceil(rs.length / 4) * 142 + 24);
  }
  // Сводка весов: все значки при 24 px, строка на лист — светлая и тёмная тема.
  const strip = (cls) => parsedSheets.map((p) => `<div class="row ${cls}"><b>${basename(p.sheet.file, '.png')}</b>`
    + allRows.filter((r) => r.sheet === p.sheet.file).map((r) => `<span title="${r.name}">${sized(svgFile(r.name), 24)}</span>`).join('') + '</div>').join('');
  shoot(`<!doctype html><meta charset="utf-8">${style}${strip('')}<div style="height:8px"></div>${strip('dark')}`, 'weights', 700, parsedSheets.length * 2 * 40 + 40);
}

function shoot(html, name, width, height) {
  const htmlFile = join(OUT, 'contact', `${name}.html`);
  writeFileSync(htmlFile, html);
  try {
    execSync(`google-chrome --headless=new --disable-gpu --hide-scrollbars --window-size=${width},${height} --screenshot=${join(OUT, 'contact', `${name}.png`)} file://${htmlFile} 2>/dev/null`);
  } catch {
    console.log(`google-chrome не найден — ${name} только html`);
  }
}
