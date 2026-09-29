// tests/iconref.mjs — сверка обводки с настоящими векторными иконками.
//
// Не автотест, а мерная линейка, сестра fontref: `node tests/iconref.mjs`.
// Берёт SVG из refs/solar-outline-icons (Solar, CC BY 4.0, 480 Design),
// рендерит их Inkscape'ом в PNG, обводит нашим иконочным конвейером ровно
// так, как это делает приложение, и сверяет каждую с контуром, который её
// породил: увод от истины в пикселях, узлы против канона истины, углы
// найдены / найдены гладкими / пропущены.
//
// Ключи:
//   --sample N     сколько иконок (по умолчанию 120; выборка воспроизводима)
//   --all          весь пакет
//   --size S       сторона рендера, px (512)
//   --low A:B      «шакал»: рендер в A px, растяжка до B px (например 100:300)
//   --out DIR      куда класть PNG и отчёт (tests/_iconref по умолчанию,
//                  в игноре git)
//   --tune         прогнать «Подобрать сам» для каждой иконки (медленно)
//   --tune-fixed   то же, но без осей «Порог» и «Допуск по цвету»
//   --contact      контактный лист contact.png (нужен google-chrome)
//   --report F     имя файла отчёта (report.json)
//   --fit K        «Точность» ×K от умолчания (K<1 — строже)
//   --fit-power P  «Точность» растёт с размером как f^P вместо масштабирования приложения
//   --corner A     порог угла в градусах вместо умолчания
//   --span S       окно угла, пиксели исходника, вместо умолчания (2·f)
//   --simp-power P «Упрощение» растёт с размером как f^P вместо масштабирования приложения
//   --only A,B     только эти иконки
//   --probe-shift  подобрать общий сдвиг наших контуров к истине: ловит
//                  систематику вроде «на полпикселя выше-левее»
//   --canon        после обводки прогнать канон (regularizeShape), как у букв

import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { execFileSync, execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, basename, resolve } from 'node:path';
import { readPng, parsePath, toNodes } from './fontref.mjs';
import { colorDistance, coverageToField, upscale, threshold, capScale, guessBackground, guessForeground } from '../js/prep/mask.js';
import { traceMask, DEFAULTS as TRACE } from '../js/trace/trace.js';
import { rasterizeShape, edgeCount, countComponents, mismatch } from '../js/trace/rasterize.js';
import { regularizeShape } from '../js/trace/regularize.js';
import { countNodes, transform } from '../js/core/path.js';
import { sizeFactor, scaleControls, defaults as paramDefaults } from '../js/ui/params.js';
import { descend } from '../js/tune/tune.js';
import { toSvgDocument } from '../js/export/svg.js';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PACK = join(ROOT, 'refs', 'solar-outline-icons');

const args = process.argv.slice(2);
const opt = (key, def) => { const i = args.indexOf(key); return i >= 0 ? args[i + 1] : def; };
const SIZE = +opt('--size', 512);
const LOW = opt('--low', null);            // «A:B»
const OUT = resolve(opt('--out', join(ROOT, 'tests', '_iconref')));   // абсолютный: file:// для контактного листа
const SAMPLE = args.includes('--all') ? Infinity : +opt('--sample', 120);
const TUNE = args.includes('--tune') || args.includes('--tune-fixed');
const TUNE_FIXED = args.includes('--tune-fixed');   // подбор без осей «Порог» и «Допуск по цвету»
const FIT = +opt('--fit', 1);              // множитель к «Точности» по умолчанию
const FIT_POWER = +opt('--fit-power', 1);
const CORNER = opt('--corner', null);      // порог угла, градусы (по умолчанию как в приложении)
const SPAN = opt('--span', null);          // окно угла в пикселях исходника вместо умолчания (2·f)
const SIMP_POWER = +opt('--simp-power', 1); // степень роста «Упрощения» с размером  // степень роста «Точности» с размером (1 — линейно, как в приложении)
const PROBE = args.includes('--probe-shift');   // искать общий сдвиг контура относительно истины
const CONTACT = args.includes('--contact');
const REPORT = opt('--report', null);      // имя файла отчёта вместо report.json
const ONLY = opt('--only', null);          // только эти иконки (имена через запятую)
const CANON = args.includes('--canon');    // прогнать канон (regularizeShape), как в шрифтовом маршруте

// ─── выборка ────────────────────────────────────────────────────────────────

/** Воспроизводимая псевдослучайная выборка: тот же список при каждом прогоне. */
function pick(files, n) {
  if (n >= files.length) return files;
  let seed = 20260905;
  const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const arr = files.slice();
  for (let i = arr.length - 1; i > 0; i -= 1) { const j = Math.floor(rnd() * (i + 1)); [arr[i], arr[j]] = [arr[j], arr[i]]; }
  return arr.slice(0, n).sort();
}

// ─── рендер ─────────────────────────────────────────────────────────────────

/** SVG → PNG заданной стороны на белом; кэшируется по имени и размеру. */
function render(svgFile, side, dir) {
  mkdirSync(dir, { recursive: true });
  const png = join(dir, `${basename(svgFile, '.svg')}.${side}.png`);
  if (!existsSync(png)) {
    execFileSync('inkscape', ['--export-type=png', `--export-width=${side}`, `--export-height=${side}`,
      '--export-background=#ffffff', '--export-background-opacity=1', '-o', png, svgFile], { stdio: 'ignore' });
  }
  return png;
}

/** «Шакал»: картинка A px растягивается до B px билинейно, как это делает браузер. */
function stretch(img, to) {
  const out = new Uint8ClampedArray(to * to * 4);
  const k = img.width / to;
  for (let y = 0; y < to; y += 1) {
    const sy = Math.min(img.height - 1.001, Math.max(0, (y + 0.5) * k - 0.5));
    const y0 = Math.floor(sy); const fy = sy - y0;
    for (let x = 0; x < to; x += 1) {
      const sx = Math.min(img.width - 1.001, Math.max(0, (x + 0.5) * k - 0.5));
      const x0 = Math.floor(sx); const fx = sx - x0;
      for (let c = 0; c < 4; c += 1) {
        const p = (yy, xx) => img.data[(yy * img.width + xx) * 4 + c];
        const v = p(y0, x0) * (1 - fx) * (1 - fy) + p(y0, x0 + 1) * fx * (1 - fy)
          + p(y0 + 1, x0) * (1 - fx) * fy + p(y0 + 1, x0 + 1) * fx * fy;
        out[(y * to + x) * 4 + c] = v;
      }
    }
  }
  return { width: to, height: to, data: out };
}

// ─── истина ─────────────────────────────────────────────────────────────────

/** Контуры SVG в пикселях рендера. Solar: viewBox 24, только M/L/H/V/C/Z. */
function truthOf(svgFile, side) {
  const svg = readFileSync(svgFile, 'utf8');
  const vb = (/viewBox="([^"]+)"/.exec(svg)?.[1] ?? '0 0 24 24').split(/\s+/).map(Number);
  const k = side / vb[2];
  const scale = (shape) => transform(shape, (p) => ({ x: (p.x - vb[0]) * k, y: (p.y - vb[1]) * k }));
  // Каждый <path> — сам по себе: правило заливки действует внутри одного
  // пути, а несколько путей складываются объединением. Белая заливка поверх
  // тёмной — дырка, нарисованная поверх: вычитается.
  const paths = [];
  for (const m of svg.matchAll(/<path\b([^>]*)>/g)) {
    const attrs = m[1];
    const d = /\sd="([^"]+)"/.exec(attrs)?.[1];
    if (!d) continue;
    // Десяток иконок пакета нарисован настоящим штрихом (stroke=), а не
    // развёрнутой заливкой: их истина — не контур, а осевая с толщиной.
    // Сверять их заливкой значило бы врать; пропускаем и говорим об этом.
    if (/\sstroke="(?!none)/.test(attrs)) return null;
    const contours = [];
    for (const c of parsePath(d)) {
      const nodes = toNodes(c);
      if (nodes.length >= 2) contours.push({ closed: true, nodes });
    }
    const fill = (/\sfill="([^"]+)"/.exec(attrs)?.[1] ?? '').toLowerCase();
    paths.push({
      shape: scale({ contours }),
      rule: /fill-rule="evenodd"/.test(attrs) ? 'evenodd' : 'nonzero',
      erase: fill === 'white' || fill === '#fff' || fill === '#ffffff',
    });
  }
  const shape = { contours: paths.filter((p) => !p.erase).flatMap((p) => p.shape.contours) };
  return { shape, paths };
}

/** Растр истины: пути объединяются, белые — вычитаются. */
function rasterTruth(truth, w, S) {
  const out = new Uint8Array(w * w);
  for (const p of truth.paths) {
    const r = rasterizeShape(p.shape, w, w, S, 10, p.rule);
    for (let i = 0; i < out.length; i += 1) {
      if (r[i]) out[i] = p.erase ? 0 : 1;
    }
  }
  return out;
}

// ─── обводка как в приложении ───────────────────────────────────────────────

/** Ровно то, что делает iconJob воркера при настройках по умолчанию. */
function traceLikeApp(img, overrides = {}) {
  const f = sizeFactor(img.width, img.height);
  const base = paramDefaults();
  // Как в приложении: умолчания, подогнанные под размер кропа (scaleControls);
  // ключи --fit-power/--simp-power/--span/--fit/--corner подменяют их для опытов.
  const scaled = Object.fromEntries(scaleControls(f).map((c) => [c.key, c.value]));
  const p = { ...base, ...overrides };
  const bg = guessBackground(img);
  const fg = guessForeground(img, bg);
  const k = capScale(img.width, img.height, p.upscale);
  const soft = coverageToField(colorDistance(img, { fg, bg, tolerance: p.tolerance }));
  const up = upscale(soft, k);
  const opts = {
    level: p.level,
    simplify: overrides.simplify ?? (SIMP_POWER !== 1 ? base.simplify * f ** SIMP_POWER : scaled.simplify),
    cornerAngle: CORNER !== null ? +CORNER : p.cornerAngle,
    cornerSpan: overrides.cornerSpan ?? (SPAN !== null ? +SPAN : scaled.cornerSpan),
    fitError: overrides.fitError ?? (FIT_POWER !== 1 ? base.fitError * f ** FIT_POWER : scaled.fitError) * FIT,
    minArea: overrides.minArea ?? scaled.minArea,
  };
  let shape = traceMask(up, k, opts);
  if (CANON) shape = regularizeShape(shape, { lineTol: opts.fitError, axisDeg: 4, primShare: 0.025, primTol: opts.fitError });
  const bin = threshold(up, p.level);
  const fit = mismatch(bin, shape, k, Math.max(1, opts.minArea * k * k));
  return { shape, fit, k, f, opts, bin, up, p, base };
}

/** Увод от истины в пикселях рендера: растр обоих с увеличением S. */
function driftVsTruth(ours, truth, side, S = 2) {
  const w = side * S;
  const T = rasterTruth(truth, w, S);
  const O = rasterizeShape(ours, w, w, S);
  let diff = 0;
  let area = 0;
  for (let i = 0; i < T.length; i += 1) { area += T[i]; if (T[i] !== O[i]) diff += 1; }
  return {
    drift: diff / Math.max(1, edgeCount(T, w, w)) / S,
    share: diff / Math.max(1, area),
    compTruth: countComponents(T, w, w, 4 * S * S),
    compOurs: countComponents(O, w, w, 4 * S * S),
  };
}

/** Углы истины: найдены / найдены гладкими / пропущены; наши лишние узлы. */
function structure(ours, canon, near, far) {
  const d2 = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
  const T = canon.contours.flatMap((c) => c.nodes);
  const O = ours.contours.flatMap((c) => c.nodes);
  const s = { corners: 0, found: 0, soft: 0, missed: 0, extras: 0 };
  // Угол истины считается, только если он есть в растре: шипы с разворотом
  // на 180° и точки, где развёртка штриха проходит дважды, — артефакты
  // перевода штриха в заливку, у них нет площади, и тракт их видеть не может.
  const seen = [];
  const kinkOf = (nd) => {
    if (!nd.in || !nd.out) return 90;
    const a = { x: nd.p.x - nd.in.x, y: nd.p.y - nd.in.y };
    const b = { x: nd.out.x - nd.p.x, y: nd.out.y - nd.p.y };
    const la = Math.hypot(a.x, a.y); const lb = Math.hypot(b.x, b.y);
    if (la < 1e-9 || lb < 1e-9) return 180;
    return (Math.acos(Math.max(-1, Math.min(1, (a.x * b.x + a.y * b.y) / (la * lb)))) * 180) / Math.PI;
  };
  for (const t of T) {
    if (t.type !== 'corner') continue;
    if (kinkOf(t) >= 170) continue;
    if (seen.some((p) => d2(p, t.p) < 1e-6)) continue;
    seen.push(t.p);
    s.corners += 1;
    let best = null; let bd = Infinity;
    for (const o of O) { const d = d2(o.p, t.p); if (d < bd) { bd = d; best = o; } }
    if (bd > near) s.missed += 1; else if (best.type === 'corner') s.found += 1; else s.soft += 1;
  }
  for (const o of O) if (T.every((t) => d2(o.p, t.p) > far)) s.extras += 1;
  // Ложные углы: наш угловой узел там, где у истины угла нет.
  s.falseCorners = 0;
  for (const o of O) {
    if (o.type !== 'corner') continue;
    if (!seen.some((p) => d2(o.p, p) <= far)) s.falseCorners += 1;
  }
  return s;
}

// ─── прогон ─────────────────────────────────────────────────────────────────

if (!existsSync(PACK)) {
  console.error(`iconref: нет корпуса ${PACK} — сверять не с чем. `
    + 'Корпус в репозиторий не входит: см. THIRD-PARTY-NOTICES.md, раздел «Мерные корпуса».');
  process.exit(1);
}
const all = readdirSync(PACK).filter((f) => f.endsWith('.svg')).sort();
const files = (ONLY ? all.filter((f) => ONLY.split(',').includes(basename(f, '.svg'))) : pick(all, SAMPLE)).map((f) => join(PACK, f));
const [lowA, lowB] = LOW ? LOW.split(':').map(Number) : [null, null];
const side = LOW ? lowB : SIZE;
mkdirSync(OUT, { recursive: true });
const rows = [];
const cells = [];
const shifts = [];
const skipped = [];
const t0 = performance.now();
for (const file of files) {
  const name = basename(file, '.svg');
  let img = readPng(render(file, LOW ? lowA : SIZE, join(OUT, 'png')));
  if (LOW) img = stretch(img, lowB);
  const truth = truthOf(file, side);
  if (!truth) { skipped.push(name); continue; }
  let r = traceLikeApp(img);
  let tuned = null;
  if (TUNE) {
    // Как в воркере: сверка с одной маской исходных настроек, не со своей.
    const ref = r.bin;
    const minComp = Math.max(1, r.opts.minArea * r.k * r.k);
    const evaluate = async (cand) => {
      const rr = traceLikeApp(img, cand);
      const fit = mismatch(ref, rr.shape, rr.k, minComp);
      return { nodes: countNodes(rr.shape), units: 1, drift: fit.drift / rr.k, compBin: fit.compBin, compRen: fit.compRen, rr };
    };
    const base = { simplify: r.opts.simplify, fitError: r.opts.fitError, cornerAngle: r.p.cornerAngle, cornerSpan: r.opts.cornerSpan, open: 0, close: 0 };
    if (!TUNE_FIXED) Object.assign(base, { level: r.p.level, tolerance: r.p.tolerance });
    const res = await descend({ evaluate, base });
    tuned = Object.fromEntries(Object.entries(res.params).filter(([k, v]) => v !== base[k]));
    r = res.result.rr;
  }
  const canon = regularizeShape(JSON.parse(JSON.stringify(truth.shape)), { lineTol: r.opts.fitError, axisDeg: 4, primShare: 0.025, primTol: r.opts.fitError });
  const d = driftVsTruth(r.shape, truth, side);
  if (PROBE) {
    let best = { dx: 0, dy: 0, drift: d.drift };
    for (let dx = -0.5; dx <= 0.5; dx += 0.25) {
      for (let dy = -0.5; dy <= 0.5; dy += 0.25) {
        const dd = driftVsTruth(transform(r.shape, (p) => ({ x: p.x + dx, y: p.y + dy })), truth, side).drift;
        if (dd < best.drift - 1e-9) best = { dx, dy, drift: dd };
      }
    }
    shifts.push(best);
  }
  const st = structure(r.shape, canon, Math.max(1.5, r.opts.fitError * 1.5), Math.max(3, r.opts.fitError * 3));
  const row = {
    name, nodes: countNodes(r.shape), canon: countNodes(canon), truthNodes: countNodes(truth.shape),
    contours: r.shape.contours.length, truthContours: truth.shape.contours.length,
    drift: +d.drift.toFixed(3), share: +d.share.toFixed(4), lost: d.compTruth - d.compOurs,
    maskDrift: +(r.fit.drift / r.k).toFixed(3), ...st, tuned,
  };
  rows.push(row);
  const flag = row.lost ? ` ПОТЕРЯНО ${row.lost}` : '';
  console.log(`${name.padEnd(28)} узлов ${String(row.nodes).padStart(3)}/${String(row.canon).padStart(3)} · увод ${row.drift.toFixed(2)} px${flag} · углы ${row.found}+${row.soft}~${row.missed}✗ лишних ${row.extras}${tuned ? ' · ' + Object.entries(tuned).map(([k, v]) => `${k}=${+(+v).toFixed(2)}`).join(' ') : ''}`);
  if (CONTACT) {
    const png = readFileSync(join(OUT, 'png', `${name}.${LOW ? lowA : SIZE}.png`)).toString('base64');
    const svg = toSvgDocument(r.shape, { width: side, height: side, fill: '#1C274C' });
    cells.push(`<div class="cell"><img src="data:image/png;base64,${png}"><div class="v">${svg}</div><div class="n">${name.slice(0, 18)}<br>${row.nodes}/${row.canon}<br>увод ${row.drift.toFixed(2)}</div></div>`);
  }
}

const n = rows.length;
const sum = (k) => rows.reduce((a, r) => a + r[k], 0);
const sorted = (k) => rows.map((r) => r[k]).sort((a, b) => a - b);
const q = (arr, p) => arr[Math.min(arr.length - 1, Math.floor(arr.length * p))];
console.log(`\n══ ${n} иконок, ${side} px${LOW ? ` (рендер ${lowA} px, растяжка до ${lowB})` : ''}, ${((performance.now() - t0) / 1000).toFixed(0)} с${skipped.length ? ` · пропущено ${skipped.length} (штрихом, не заливкой): ${skipped.join(' ')}` : ''}`);
console.log(`   увод от истины: медиана ${q(sorted('drift'), 0.5).toFixed(2)} px, p90 ${q(sorted('drift'), 0.9).toFixed(2)}, max ${q(sorted('drift'), 1).toFixed(2)} · от маски медиана ${q(sorted('maskDrift'), 0.5).toFixed(2)}`);
console.log(`   узлов: наши ${sum('nodes')} · канон истины ${sum('canon')} (${(sum('nodes') / sum('canon')).toFixed(2)}×) · исходных ${sum('truthNodes')}`);
console.log(`   углы истины ${sum('corners')}: найдено ${sum('found')}, гладкими ${sum('soft')}, пропущено ${sum('missed')} · ложных углов ${sum('falseCorners')} · лишних узлов ${sum('extras')} · иконок с потерей кусков ${rows.filter((r) => r.lost > 0).length}, с лишними ${rows.filter((r) => r.lost < 0).length}`);
if (PROBE) {
  const mean = (k) => shifts.reduce((a, s2) => a + s2[k], 0) / shifts.length;
  console.log(`   общий сдвиг к истине: dx ${mean('dx').toFixed(2)}, dy ${mean('dy').toFixed(2)} (среднее лучших); увод после сдвига медиана ${q(shifts.map((s2) => s2.drift).sort((a, b) => a - b), 0.5).toFixed(2)}`);
}
const worst = rows.slice().sort((a, b) => b.drift - a.drift).slice(0, 12);
console.log(`   худшие по уводу: ${worst.map((r) => `${r.name}(${r.drift.toFixed(2)})`).join(' ')}`);
writeFileSync(join(OUT, REPORT ?? `report${LOW ? '-low' : ''}.json`), JSON.stringify({ side, low: LOW, rows }, null, 1));

if (CONTACT) {
  const html = `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#f4f4f6;color:#222;font:13px sans-serif}
.grid{display:grid;grid-template-columns:repeat(5,auto);gap:6px 14px;padding:8px}.cell{display:flex;align-items:center;gap:4px}
img,.v{width:150px;height:150px;background:#fff}.v svg{width:150px;height:150px}.n{width:110px;font-size:12px}</style><div class="grid">${cells.join('')}</div>`;
  const htmlFile = join(OUT, `contact${LOW ? '-low' : ''}.html`);
  writeFileSync(htmlFile, html);
  try {
    const pngFile = htmlFile.replace(/\.html$/, '.png');
    execSync(`google-chrome --headless=new --disable-gpu --hide-scrollbars --window-size=2100,${Math.ceil(n / 5) * 160 + 20} --screenshot=${pngFile} file://${htmlFile} 2>/dev/null`);
    console.log(`   контактный лист: ${pngFile}`);
  } catch { console.log('   google-chrome не найден — контактный лист только html'); }
}
