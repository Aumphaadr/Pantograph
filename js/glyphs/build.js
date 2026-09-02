// glyphs/build.js — от маски строки до обведённых глифов.
//
// Разветвление уже произошло в segment: сюда приходят компоненты, и каждая
// группа обводится ОТДЕЛЬНО. Своё увеличение каждой букве — буква высотой
// в 14 пикселей и буква высотой в 22 требуют разного коэффициента.

import { createMask, upscale, threshold, morph, capScale } from '../prep/mask.js';
import { traceMask, DEFAULTS as TRACE } from '../trace/trace.js';
import { regularizeShape, dropCollinear } from '../trace/regularize.js';
import { equalizeStems, mirrorReconcile } from './harmonize.js';
import { symmetrize } from '../prep/symmetry.js';
import { translateShape, countNodes } from '../core/path.js';
import { segment } from './segment.js';
import { autoMerge, mergeTight, readingOrder, groupBBox } from './merge.js';

const TARGET_H = 120;   // до какой высоты в пикселях доращиваем глиф перед обводкой
const PAD = 2;
const BASE_H = 48;      // размер буквы, под который рассчитаны допуски
const NOISE_SHARE = 0.01;   // мельче сотой доли от обычной буквы — это крапина
const CORNER_WINDOW_MIN = 2; // окно угла не мельче этого, пиксели исходника

const median = (v) => {
  if (!v.length) return 0;
  const a = [...v].sort((x, y) => x - y);
  return a[a.length >> 1];
};

/** Во сколько раз растить именно эту букву. */
export function glyphScale(height, { target = TARGET_H, min = 2, max = 12 } = {}) {
  return Math.max(min, Math.min(max, Math.round(target / Math.max(1, height))));
}

/**
 * Общая мягкая маска группы: куски компонент, положенные в один габарит.
 * Берётся максимум, а не сумма — перекрытия не должны давать значений выше единицы.
 */
export function groupMask(ids, components) {
  const bbox = groupBBox(ids, components);
  const mask = createMask(bbox.w + PAD * 2, bbox.h + PAD * 2);

  for (const i of ids) {
    const c = components[i];
    for (let y = 0; y < c.mask.h; y += 1) {
      for (let x = 0; x < c.mask.w; x += 1) {
        const v = c.mask.data[y * c.mask.w + x];
        if (v <= 0) continue;
        const gx = c.bbox.x - c.pad + x - bbox.x + PAD;
        const gy = c.bbox.y - c.pad + y - bbox.y + PAD;
        if (gx < 1 || gy < 1 || gx >= mask.w - 1 || gy >= mask.h - 1) continue;
        const at = gy * mask.w + gx;
        if (v > mask.data[at]) mask.data[at] = v;
      }
    }
  }
  return { mask, bbox };
}

/**
 * Обвести одну группу. Выход — в crop-пространстве всего кропа.
 *
 * Допуски соразмерны САМОЙ БУКВЕ, а не кропу. На шрифтовом листе кроп —
 * это лист: если мерить по нему, порог отсева мусора вырастает до тысяч
 * пикселей и съедает все буквы разом.
 */
export function traceGroup(ids, components, params = {}) {
  const { mask, bbox } = groupMask(ids, components);
  const k = capScale(mask.w, mask.h, glyphScale(bbox.h, params.scale));
  const f = Math.max(0.25, Math.min(40, bbox.h / BASE_H));

  let m = upscale(mask, k);

  // Согласование симметрии начинается с МАСКИ: половины буквы, совпадающие
  // со своим зеркалом в пределах гейта, сворачиваются в среднее — обе стороны
  // обводятся с одинаковых данных, и узлы выходят согласованными по строению.
  // Гейт выбран по замеру листа: у честной симметрии несовпадение половин
  // ≤0.06, у первой ложной («В» по горизонтали — чаши правда разные) — 0.11.
  const foldAxes = {};   // оси симметрии, признанные свёрткой; в пикселях МАСКИ
  if (params.tidy !== false) {
    // Ось не ищется перебором: у симметричной фигуры она проходит через
    // центр масс, а несимметричную всё равно отвергнет гейт.
    let sx2 = 0;
    let sy2 = 0;
    let sw = 0;
    for (let y = 0; y < m.h; y += 1) {
      for (let x = 0; x < m.w; x += 1) {
        const v = m.data[y * m.w + x];
        if (v > 0) { sx2 += v * x; sy2 += v * y; sw += v; }
      }
    }
    if (sw > 0) {
      const gate = params.symGate ?? 0.07;
      const sx = symmetrize(m, { axis: 'x', mode: 'average', atX: sx2 / sw });
      if (sx.mismatchX <= gate) { m = sx.mask; foldAxes.x = sx.axisX; }
      const sy = symmetrize(m, { axis: 'y', mode: 'average', atY: sy2 / sw });
      if (sy.mismatchY <= gate) { m = sy.mask; foldAxes.y = sy.axisY; }
    }
  }

  // Морфология и изолиния идут по СЕРОМУ полю: положение края закодировано
  // в дробных значениях, и порог до обводки квантовал бы его к сетке
  // увеличенной маски — четверть пикселя исходника при увеличении в четыре.
  // Сверка с настоящими шрифтами показала: именно эта четверть ставила
  // лишние узлы на прямых кромках и сбивала вершины углов. Бинарная маска
  // остаётся для показа, сегментации и метрики — там она и нужна.
  m = morph(m, { open: params.open ?? 0, close: params.close ?? 0 });

  let local = traceMask(m, k, {
    level: params.level ?? 0.5,
    simplify: (params.simplify ?? TRACE.simplify) * f,
    cornerAngle: params.cornerAngle ?? TRACE.cornerAngle,
    // Окно угла не мельче двух пикселей исходника: скругление антиалиасинга
    // не зависит от роста буквы, и окно, ужатое под мелкую букву, не видело
    // бы за ним прямого угла.
    cornerSpan: Math.max((params.cornerSpan ?? TRACE.cornerSpan) * f, CORNER_WINDOW_MIN),
    fitError: (params.fitError ?? TRACE.fitError) * f,
    minArea: (params.minArea ?? TRACE.minArea) * f * f,
  });

  // Выравнивание возвращает букве замысел: прямые, оси, прямоугольники,
  // эллипсы. Порог — тот же допуск подгонки: форма не выдумывается,
  // из неотличимых кандидатов выбирается самый правильный.
  let snapped = 0;
  let axes = [];
  if (params.tidy !== false) {
    const r = regularizeShape(local, {
      lineTol: (params.fitError ?? TRACE.fitError) * f * (params.canonRatio ?? 1),
      axisDeg: 4,
      primShare: 0.025,
      primTol: (params.fitError ?? TRACE.fitError) * f * (params.canonRatio ?? 1),
    });
    local = r;
    snapped = r.snapped;
    // Согласование собственной симметрии буквы: «Ф» рисовалась зеркальной,
    // а расхождение чаш — шум растра, не замысел. Свёртка маски уже сказала,
    // какие оси настоящие, — по ним контур пересобирается зеркально: худшая
    // сторона заменяется зеркалом лучшей, симметрия точна по построению.
    const kinds = params.mirror === false ? [] : Object.keys(foldAxes);
    if (kinds.length) {
      const axesAt = {};
      if (foldAxes.x !== undefined) axesAt.x = (foldAxes.x + 0.5) / k;
      if (foldAxes.y !== undefined) axesAt.y = (foldAxes.y + 0.5) / k;
      axes = mirrorReconcile(local, kinds, axesAt, {
        tol: Math.max(1.0, (params.fitError ?? TRACE.fitError) * f * 1.3),
      });
      // Осевые узлы на прямых кромках («I», «Т») после пересборки лишние;
      // их снятие симметрию не трогает — узел стоит на самой оси.
      if (axes.length) {
        for (const c of local.contours) dropCollinear(c, (params.fitError ?? TRACE.fitError) * f);
      }
    }
  }

  return {
    shape: translateShape(local, bbox.x - PAD, bbox.y - PAD),
    bbox,
    scale: k,
    snapped,
    axes,
  };
}

/**
 * Полный маршрут шрифта: сегментация, склейка, порядок чтения, обводка.
 * Если groups переданы — берём их вместо автоматических (ручная правка групп).
 */
export function buildGlyphs(soft, binary, params = {}, groups = null) {
  // Сперва мелким ситом — узнать, какого размера тут буквы, а потом отсеять
  // крапины по доле от обычной буквы. Абсолютный порог тут не годится:
  // точка над «ё» законно во много раз мельче самой «ё».
  const probe = segment(soft, binary, { minArea: 1 });
  const typical = median(probe.map((c) => c.area));
  const floor = Math.max(1, typical * (params.glyphNoise ?? NOISE_SHARE));
  const components = probe.filter((c) => c.area >= floor)
    .map((c, i) => ({ ...c, id: i }));
  // Две склейки подряд: сперва по перекрытию (Ё, Й, i — часть над частью),
  // затем по тесноте (Ы — часть рядом с частью).
  const auto = groups
    ?? mergeTight(autoMerge(components, params.merge), components, params.merge);
  const rows = readingOrder(auto, components, params.merge);

  const glyphs = [];
  rows.forEach((row, ri) => {
    for (const ids of row) {
      const { shape, bbox, scale, snapped, axes } = traceGroup(ids, components, params);
      glyphs.push({
        index: glyphs.length, row: ri, ids, bbox, shape, scale, snapped, axes,
        nodes: countNodes(shape),
      });
    }
  });
  // Толщины штрихов — общие на весь лист: стойка «Н» и стойка «П» рисовались
  // одним пером, и разнобой в пределах допуска обводки — шум, а не замысел.
  // Дальше допуска грань не двигается: на настоящем шрифте стойки прописных,
  // строчных и знаков разной толщины ПО ЗАМЫСЛУ, и прежний потолок в 0.8 px
  // уводил «I» и «T» Lato от истины на 0.4 px — вчетверо хуже сырой обводки.
  if (params.tidy !== false && params.stems !== false) {
    const heights = glyphs.map((g) => g.bbox.h);
    const fTyp = Math.max(0.25, Math.min(40, median(heights) / BASE_H));
    const tol = (params.fitError ?? TRACE.fitError) * fTyp;
    equalizeStems(glyphs, { cap: tol, spread: tol * 2 });
  }

  return { components, glyphs, rows: rows.length };
}
