// worker/pipeline.js — весь путь «параметры → Shape» живёт здесь.
//
// Кроп уезжает сюда один раз и остаётся; на каждое движение ползунка летят
// только параметры. Устаревшие ответы отбрасываются по счётчику поколений,
// а сама работа не начинается, если в очереди уже есть более свежие параметры.
//
// Работы iconJob и fontJob — чистые функции «параметры → результат»: их
// гоняет и обычный цикл, и авто-подбор, которому нужно много прогонов подряд.

import {
  colorDistance, coverageToField, upscale, threshold, morph, capScale,
} from '../prep/mask.js';
import { layerMasks, unionMask } from '../prep/layers.js';
import { symmetrize } from '../prep/symmetry.js';
import { traceMask, traceStroke } from '../trace/trace.js';
import { mismatch } from '../trace/rasterize.js';
import { buildGlyphs } from '../glyphs/build.js';
import { countNodes } from '../core/path.js';
import { descend } from '../tune/tune.js';

let crop = null;
let pending = null;   // { gen, params } — последние пришедшие параметры
let running = false;
let last = null;      // маски и компоненты последнего разбора — для перегруппировки
let tuneGen = 0;      // какой подбор сейчас главный: новый обрывает старый

// Молчащий воркер снаружи неотличим от пустой панели, поэтому он сам
// докладывает и о готовности, и о любом сбое.
self.postMessage({ type: 'ready' });

self.onmessage = (ev) => {
  try {
    const msg = ev.data;
    if (msg.type === 'crop') {
      crop = msg.imageData;
      return;
    }
    if (msg.type === 'params') {
      pending = { gen: msg.gen, params: msg.params };
      if (!running) schedule();
      return;
    }
    if (msg.type === 'tune') {
      tune(msg.gen, msg.params);
      return;
    }
    if (msg.type === 'regroup') {
      regroup(msg.gen, msg.groups);
    }
  } catch (err) {
    self.postMessage({ type: 'error', gen: ev.data && ev.data.gen, message: String(err) });
  }
};

/** Чернила из параметров: слои различаются только ими. */
const inksOf = (params) => (params.layers && params.layers.length
  ? params.layers
  : [{ id: 'ink', fg: params.fg, tolerance: params.tolerance }]);

/**
 * Иконочная работа: маски слоёв → контуры → метрика расхождения.
 * Ничего не постит и ничего в состоянии воркера не трогает.
 */
function iconJob(params) {
  const inks = inksOf(params);
  const k = capScale(crop.width, crop.height, params.upscale);
  let sym = null;

  // Спор за пиксель решается ДО увеличения: на исходном растре, где он и
  // возник, а не на домысленных лишних пикселях.
  // Покрытие → поле (см. coverageToField) до увеличения: линейная изолиния
  // на прямой кромке тогда точна, а не промахивается на долю пикселя.
  let masks = layerMasks(crop, params.bg, inks, { exclusive: params.exclusive !== false })
    .map((m) => upscale(coverageToField(m), k));

  // Симметризация складывает ПОЛУТОНА, поэтому идёт до порога. Ось ищется
  // один раз по общей маске и навязывается каждому слою: иначе слои найдут
  // разные оси и разъедутся.
  if (params.symAxis && params.symAxis !== 'none') {
    const opts = {
      axis: params.symAxis,
      mode: params.symMode,
      shiftX: (params.symShiftX ?? 0) * k,
      shiftY: (params.symShiftY ?? 0) * k,
    };
    sym = symmetrize(unionMask(masks), opts);
    masks = masks.map((m) => symmetrize(m, {
      ...opts, atX: sym.axisX ?? undefined, atY: sym.axisY ?? undefined,
    }).mask);
  }

  // Морфология — по серому полю, изолиния — на уровне порога по нему же:
  // порог до обводки квантовал бы край к сетке увеличенной маски.
  masks = masks.map((m) => morph(m, { open: params.open, close: params.close }));

  const traceOpts = {
    level: params.level,
    simplify: params.simplify,
    cornerAngle: params.cornerAngle,
    cornerSpan: params.cornerSpan,
    fitError: params.fitError,
    minArea: params.minArea,
  };
  // «Обвести как штрих» — отдельный ход, а не замена: заливка и осевая
  // линия отвечают на разные вопросы, и подменять одно другим молча нельзя.
  // Скелету нужна битовая маска: он считает чернилами всё, что больше нуля.
  const shapes = params.stroke
    ? masks.map((m) => traceStroke(threshold(m, params.level), k, traceOpts))
    : masks.map((m) => traceMask(m, k, traceOpts));
  const mask = threshold(unionMask(masks), params.level);

  // Метрика: рендер всех слоёв разом против объединённой маски. У осевых
  // линий площади нет — там расхождение площади не определено, и это честно.
  const fit = params.stroke
    ? null
    : mismatch(mask, { contours: shapes.flatMap((s) => s.contours) }, k,
      Math.max(1, (params.minArea ?? 4) * k * k));

  return { inks, k, sym, mask, shapes, fit };
}

/**
 * Шрифтовая работа: маски листа → буквы → метрика. Одноцветна по природе:
 * строка текста набрана одними чернилами, берётся первый слой.
 */
function fontJob(params) {
  const ink = inksOf(params)[0];
  const k = capScale(crop.width, crop.height, params.upscale);
  // Сегментация идёт по НЕувеличенной маске, а увеличение каждая буква
  // получает своё — уже внутри buildGlyphs. Поле одно на всё: и показ,
  // и сегментация, и изолиния берутся с него же.
  const soft = coverageToField(colorDistance(crop, { fg: ink.fg, bg: params.bg, tolerance: ink.tolerance }));
  const shown = morph(threshold(upscale(soft, k), params.level), { open: params.open, close: params.close });
  const bin = morph(threshold(soft, params.level), { open: params.open, close: params.close });
  const built = buildGlyphs(soft, bin, params);

  // Метрика по всему листу в пикселях кропа: контуры букв уже в них.
  const fit = mismatch(bin, {
    contours: built.glyphs.flatMap((g) => g.shape.contours),
  }, 1, Math.max(1, params.minArea ?? 4));

  return { soft, bin, shown, built, fit };
}

/** Обводит буквы заново по группам, собранным руками. Маски уже есть. */
function regroup(gen, groups) {
  if (!last) return;
  try {
    const t0 = performance.now();
    const built = buildGlyphs(last.soft, last.bin, last.params, groups);
    last.components = built.components;
    const fit = mismatch(last.bin, {
      contours: built.glyphs.flatMap((g) => g.shape.contours),
    }, 1, Math.max(1, (last.params.minArea ?? 4)));
    sendGlyphs(gen, built, fit, null, t0);
  } catch (err) {
    self.postMessage({ type: 'error', gen, message: String((err && err.stack) || err) });
  }
}

const fitStats = (fit) => (fit && {
  drift: fit.drift,
  compBin: fit.compBin,
  compRen: fit.compRen,
});

function sendGlyphs(gen, built, fit, mask, t0) {
  const payload = {
    type: 'glyphs',
    gen,
    components: built.components.map((c) => ({ id: c.id, bbox: c.bbox, area: c.area })),
    glyphs: built.glyphs.map((g) => ({
      index: g.index, row: g.row, ids: g.ids, bbox: g.bbox, shape: g.shape,
      scale: g.scale, nodes: g.nodes, snapped: g.snapped,
    })),
    stats: {
      ms: Math.round(performance.now() - t0),
      components: built.components.length,
      glyphs: built.glyphs.length,
      rows: built.rows,
      nodes: built.glyphs.reduce((s, g) => s + g.nodes, 0),
      fit: fitStats(fit),
    },
  };
  if (mask) {
    payload.mask = { w: mask.w, h: mask.h, data: mask.data };
    self.postMessage(payload, [mask.data.buffer]);
  } else {
    self.postMessage(payload);
  }
}

// Через задачу, а не сразу: так очередь сообщений успевает разобраться,
// и подряд пришедшие движения ползунка схлопываются в один пересчёт.
function schedule() {
  running = true;
  setTimeout(run, 0);
}

function run() {
  const job = pending;
  pending = null;
  if (!job || !crop) { running = false; return; }

  // Хвост — в finally: шрифтовая ветка выходит через return, и без этого
  // running оставался поднятым НАВСЕГДА после первого же шрифтового прогона.
  // Все следующие запросы ложились в pending, который никто не забирал:
  // воркер жив, но нем — ползунки перестают действовать без единой ошибки.
  try {
    const { gen, params } = job;
    const t0 = performance.now();

    if (params.route === 'font') {
      const r = fontJob(params);
      last = { soft: r.soft, bin: r.bin, params, components: r.built.components };
      sendGlyphs(gen, r.built, r.fit, r.shown, t0);
      return;
    }

    const r = iconJob(params);
    self.postMessage({
      type: 'result',
      gen,
      mask: { w: r.mask.w, h: r.mask.h, data: r.mask.data },
      layers: r.shapes.map((shape, i) => ({
        id: r.inks[i].id,
        shape,
        nodes: countNodes(shape),
        contours: shape.contours.length,
      })),
      stats: {
        ms: Math.round(performance.now() - t0),
        nodes: r.shapes.reduce((a, s2) => a + countNodes(s2), 0),
        contours: r.shapes.reduce((a, s2) => a + s2.contours.length, 0),
        maskSize: [r.mask.w, r.mask.h],
        scale: r.k,
        capped: r.k < Math.round(params.upscale),
        fit: fitStats(r.fit),
        symmetry: r.sym && {
          axisX: r.sym.axisX === null ? null : (r.sym.axisX + 0.5) / r.k,
          axisY: r.sym.axisY === null ? null : (r.sym.axisY + 0.5) / r.k,
          mismatch: Math.max(r.sym.mismatchX, r.sym.mismatchY),
          score: Math.max(r.sym.scoreX, r.sym.scoreY),
        },
      },
    }, [r.mask.data.buffer]);
  } catch (err) {
    self.postMessage({ type: 'error', gen: job.gen, message: String((err && err.stack) || err) });
  } finally {
    if (pending) setTimeout(run, 0);
    else running = false;
  }
}

// ─── авто-подбор ────────────────────────────────────────────────────────────

// Ключи, которые подбор вправе крутить. Остальное — решения человека
// (цвета, слои, симметрия) или не про качество (увеличение).
const TUNABLE = ['level', 'tolerance', 'simplify', 'fitError', 'cornerAngle', 'cornerSpan', 'open', 'close'];

/**
 * Подбор: покоординатный спуск по метрике расхождения. Работает уступчиво —
 * перед каждым прогоном отдаёт очередь сообщений, и любое новое движение
 * ползунка (pending) или новый подбор его обрывает.
 */
async function tune(gen, params) {
  tuneGen = gen;
  if (!crop) return;
  if (params.stroke) {
    self.postMessage({ type: 'error', gen, message: 'Подбор не работает в режиме штриха: у осевой линии нет площади для сверки.' });
    return;
  }

  const merge = (cand) => {
    const p = { ...params, ...cand };
    // Допуск по цвету принадлежит чернилам: подбор крутит ПЕРВЫЙ слой.
    if (cand.tolerance !== undefined && params.layers && params.layers.length) {
      p.layers = params.layers.map((L, i) => (i === 0 ? { ...L, tolerance: cand.tolerance } : L));
    }
    return p;
  };

  const evaluate = async (cand) => {
    // Уступить очередь: пусть войдут сообщения, способные нас оборвать.
    await new Promise((r) => { setTimeout(r, 0); });
    const p = merge(cand);
    if (params.route === 'font') {
      const r = fontJob(p);
      return {
        nodes: r.built.glyphs.reduce((s, g) => s + g.nodes, 0),
        units: r.built.glyphs.length,
        drift: r.fit.drift, compBin: r.fit.compBin, compRen: r.fit.compRen,
      };
    }
    const r = iconJob(p);
    return {
      nodes: r.shapes.reduce((a, s2) => a + countNodes(s2), 0),
      units: 1,
      drift: r.fit.drift, compBin: r.fit.compBin, compRen: r.fit.compRen,
    };
  };

  const base = Object.fromEntries(TUNABLE.map((key) => [key,
    key === 'tolerance' ? inksOf(params)[0].tolerance : params[key]]));

  try {
    const r = await descend({
      evaluate,
      base,
      aborted: () => pending !== null || tuneGen !== gen,
      onStep: (step, total, best) => self.postMessage({
        type: 'tuneStep', gen, step, total, nodes: best.nodes, drift: best.drift,
      }),
    });
    self.postMessage({
      type: 'tuned',
      gen,
      aborted: r.aborted,
      params: r.params,
      nodes: r.result.nodes,
      drift: r.result.drift,
      was: { nodes: r.baseline.nodes, drift: r.baseline.drift },
      steps: r.steps,
    });
  } catch (err) {
    self.postMessage({ type: 'error', gen, message: String((err && err.stack) || err) });
  }
}
