// ui/app.js — обвязка: загрузка, холст, оверлей, кроп, препроцесс и трассировка.

import * as store from '../store.js';
import { createViewport } from './viewport.js';
import { createCropTool } from './cropTool.js';
import { cropFrom, toCanvas, pixelZoom } from '../prep/crop.js';
import { handlePoints, HANDLES } from '../core/geom.js';
import { sampleColor, guessBackground, guessForeground } from '../prep/mask.js';
import { guessInks } from '../prep/layers.js';
import { toPathData, toSvgDocument, toLayeredSvg, toAssemblySvg } from '../export/svg.js';
import { transform, translateShape, countNodes } from '../core/path.js';
import { CONTROLS, defaults, groups, scaleControls, sizeFactor } from './params.js';
import { createHistory } from '../editor/history.js';
import { createEditorTool } from '../editor/tools.js';
import { renderEditor } from '../editor/render.js';
import { removeNodes, setNodeType, parseKey } from '../editor/ops.js';
import { detect as detectPrimitive, apply as applyPrimitive } from '../core/primitives.js';
import {
  parseLines, autoAssign, roster, coverage, setCode, label, ALPHABETS,
} from '../glyphs/assign.js';
import { fitRows } from '../glyphs/merge.js';
import { describeNodes, sheetPrior } from '../glyphs/priors.js';
import {
  guessGuides, normalizeGuides, guessSpacing, buildGlyph, fontMetrics, scaleFor,
  DEFAULTS as MDEF,
} from '../glyphs/metrics.js';
import { createGuidesTool, LINES } from './guidesTool.js';
import { buildFont, toArrayBuffer, fileName } from '../export/font.js';
import { makeZip } from '../export/zip.js';
import {
  snapshot, restore, codesFit, exportBundle, importBundle,
} from '../project.js';
import { saveLocal, loadLocal, clearLocal } from '../idb.js';
import { createSplitter } from './splitter.js';
import { installHints, hintButton } from './hints.js';

// Строка состояния: единственный голос приложения к человеку.
// say(null) — «всё в порядке, сказать нечего»; второй аргумент красит в тревогу.
function say(text, bad = false) {
  el.status.textContent = text ?? '';
  el.status.classList.toggle('error', Boolean(text) && bad);
}

/** Пришёл добрый ответ: гасим жалобу, но не чужое сообщение. Иначе сказанное
 *  человеку затирается трассировкой раньше, чем он успеет прочесть. */
function sayDone() {
  if (el.status.classList.contains('error')) say(null);
}

const SMALL_SIDE = 32;   // ниже этого трассировка честно предупреждает (см. SPEC, риски)
const SVG_NS = 'http://www.w3.org/2000/svg';

const $ = (id) => document.getElementById(id);

const el = {
  stage: $('stage'), canvas: $('canvas'), overlay: $('overlay'), drop: $('drop'),
  file: $('file'), zoom: $('zoom'), status: $('status'),
  panel: $('panel'), cropSize: $('crop-size'),
  cropWarn: $('crop-warn'), imgName: $('img-name'), imgSize: $('img-size'),
  maskCrop: $('mask-crop'), maskSize: $('mask-size'), statContours: $('stat-contours'),
  statNodes: $('stat-nodes'), statMs: $('stat-ms'),
  controlsMask: $('controls-mask'), controlsCurves: $('controls-curves'),
  controlsCurvesFont: $('controls-curves-font'),
  glyphComps: $('glyph-comps'), glyphCount: $('glyph-count'), glyphNodes: $('glyph-nodes'),
  exContours: $('ex-contours'), exNodes: $('ex-nodes'),
  bgMode: $('bg-mode'), showFill: $('show-fill'), showNodes: $('show-nodes'),
  pickBg: $('pick-bg'), swBg: $('sw-bg'),
  layerList: $('layer-list'), layAdd: $('lay-add'), layGuess: $('lay-guess'),
  layExclusive: $('lay-exclusive'), fillMode: $('fill-mode'),
  traceMode: $('trace-mode'), strokeNote: $('stroke-note'), assembleNote: $('assemble-note'),
  saveSvg: $('save-svg'), stepList: $('step-list'), work: $('work'),
  gridView: $('grid-view'), fontView: $('font-view'), zoomGroup: $('zoom-group'),
  zoomIn: $('zoom-in'), zoomOut: $('zoom-out'), zoom1: $('zoom-1'), fit: $('fit'),
  selCount: $('sel-count'), edSmooth: $('ed-smooth'), edCorner: $('ed-corner'),
  edDelete: $('ed-delete'), edUndo: $('ed-undo'), edRedo: $('ed-redo'), edSnap: $('ed-snap'),
  detached: $('detached'), retrace: $('retrace'),
  primBox: $('prim-box'), primList: $('prim-list'),
  primShare: $('prim-share'), primShareVal: $('prim-share-val'),
  routeSwitch: $('route-switch'), glyphGrid: $('glyph-grid'),
  glMerge: $('gl-merge'), glSplit: $('gl-split'), glReset: $('gl-reset'),
  glEdit: $('gl-edit'), glDone: $('gl-done'), glShapeReset: $('gl-shape-reset'),
  editTools: $('edit-tools'), glyphEditRow: $('glyph-edit-row'),
  busy: $('busy'), dropVeil: $('drop-veil'),
  statFit: $('stat-fit'), glyphFit: $('glyph-fit'), tune: $('tune'),
  sampleSize: $('sample-size'), sampleSizeVal: $('sample-size-val'),
  tileZoom: $('tile-zoom'), tileZoomVal: $('tile-zoom-val'),
  textIn: $('text-in'), assignNote: $('assign-note'),
  charIn: $('char-in'), alphaPick: $('alpha-pick'), coverOut: $('cover-out'),
  splitter: $('splitter'), panelToggle: $('panel-toggle'),
  main: document.querySelector('main'),
  strip: $('strip'), mCap: $('m-cap'), mX: $('m-x'),
  mAsc: $('m-asc'), mDesc: $('m-desc'), mScale: $('m-scale'),
  mControls: $('m-controls'), mGuess: $('m-guess'), fontName: $('font-name'), fontSampleIn: $('font-sample-in'),
  fontSample: $('font-sample'), fontNote: $('font-note'), fontSave: $('font-save'),
  prExport: $('pr-export'), prImportFile: $('pr-import-file'), prPack: $('pr-pack'),
  prNote: $('pr-note'),
};

const ctx = el.canvas.getContext('2d');
const viewport = createViewport();

let rect = null;        // прямоугольник кропа, image-пространство, целые пиксели
let panning = null;
let frame = 0;

const params = defaults();
const colors = { fg: [232, 183, 90], bg: [15, 16, 18] };
let gen = 0;            // счётчик поколений: ответы с меньшим номером устарели
let result = null;      // последний ответ воркера
let traceFrame = 0;
let pickMode = null;    // 'fg' | 'bg' — ждём клика пипеткой
let bgMode = 'mask';   // что показывать на шаге «Маска»: маску, растр или вместе

// ─── правка ─────────────────────────────────────────────────────────────────
// Граница владения: пока phase === 'derived', контур — кэш параметров и молча
// пересчитывается. Первая же правка отчуждает его: параметры замораживаются,
// вернуться можно только явной перетрассировкой с потерей правок.
let route = 'icon';         // 'icon' | 'font' — что делаем с кропом
let glyphs = null;          // разобранные буквы шрифтового маршрута
let glyphEdit = -1;         // индекс буквы, чей контур на правке; −1 — никакая
let glyphEdits = new Map(); // index → правленый контур: решение человека
let glyphEditBase = 0;      // при скольких буквах правки сделаны — их пропуск
let glyphSel = new Set();   // выбранные буквы, индексы в glyphs
let manualGroups = null;    // группы, собранные руками; null — автоматика
let codes = [];             // кодовая точка на глиф, в порядке чтения
let fittedSig = null;       // разбор, уже подогнанный под текст: чтобы не по кругу
let guides = null;          // четыре направляющие, Y в crop-пространстве
const metrics = { capUnits: MDEF.capUnits, sideBearing: 40, spaceUnits: MDEF.spaceUnits };
let pending = null;         // сохранённые решения, ждущие своих глифов
let paramsTouched = false;  // трогал ли человек ползунки: если да, не подгоняем
let primShare = 0.03;       // допуск узнавания: доля от размера самого контура
let saveTimer = 0;
let step = 'image';         // текущий шаг обработки
let phase = 'derived';      // 'derived' | 'detached'
let shape = null;           // правимый контур активного слоя, crop-пространство

// Чернил на кропе может быть несколько. Фон общий — он у кропа один; общие и
// параметры маски с кривыми: они про растр, а не про цвет. У слоя своё только
// два — цвет штриха и допуск (см. BACKLOG.md, п. 1).
let layers = [];            // [{ id, name, fg, tolerance, shape, visible }]
let active = 0;             // какой слой правится и чей допуск на ползунке
let exclusive = true;       // спорный пиксель отходит одному слою
let layerSeq = 0;
let fillMode = localStorage.getItem('pantograph.fill') === 'color' ? 'color' : 'flat';
let strokeTrace = false;    // обводить осевую линию вместо границы
let traceKind = 'fill';     // 'fill' | 'stroke' | 'assemble' — сборка из примитивов

const cur = () => layers[active] || null;
let tolSync = null;         // перечитать ползунок допуска с активного слоя

/**
 * Единственная точка записи контура: две копии одного разъезжаются.
 *
 * Правка живёт в локальном `shape`, а экспорт, сводка и сохранение читают
 * СЛОЙ. Пока правки писались только в `shape`, в файл уходила версия до
 * правок — молча, без единой ошибки. Поэтому все ходы редактора идут сюда.
 *
 * В правке буквы контур принадлежит глифу, а не слою: там за запись
 * отвечает ownEdit, и слой трогать нельзя.
 */
function setShape(next) {
  shape = next;
  if (glyphEdit >= 0) return;
  const L = layers[active];
  if (!L) return;
  L.shape = next;
  // Сборка из примитивов описывает контур ДО правки: держать её дальше —
  // значит отдать в SVG не то, что человек видит. Экспорт вернётся к кривым.
  L.assembly = null;
  // Сводка шага «Экспорт» считает по слоям: без пересчёта она показывала бы
  // числа до правки — то же тихое враньё, что и сам экспорт.
  updateStats();
}
let selection = new Set();
const history = createHistory();

const worker = new Worker(new URL('../worker/pipeline.js', import.meta.url), { type: 'module' });

worker.onerror = (ev) => {
  say(`Воркер не запустился: ${ev.message ?? 'неизвестная ошибка'}`, true);
};

worker.onmessage = (ev) => {
  const m = ev.data;
  if (m.gen !== gen) return;                       // устаревший ответ
  if (m.type === 'tuneStep') {
    el.busy.textContent = `подбор ${m.step}/${m.total} · ${m.nodes} узлов · `
      + `${m.drift.toFixed(2)} px`;
    el.busy.hidden = false;
    return;
  }
  if (m.type === 'tuned') { tuneDone(m); return; }
  el.busy.hidden = true;
  if (m.type === 'error') {
    say(`Трассировка не удалась: ${m.message}`, true);
    if (step === 'glyphs') renderGlyphGrid();      // снять «разбираю…» с сетки
    return;
  }

  if (m.type === 'glyphs') {
    glyphs = m;
    glyphSel = new Set();
    // Восстановленный проект несёт правки контуров; принимаем их той же
    // позиционной меркой, что и привязку к символам.
    if (pending && pending.glyphCount === m.glyphs.length
        && Array.isArray(pending.glyphEdits) && pending.glyphEdits.length) {
      glyphEdits = new Map(pending.glyphEdits);
      glyphEditBase = m.glyphs.length;
    }
    // Правки контуров позиционны. Пока разбор даёт столько же букв, они
    // накладываются поверх пересчёта; изменился состав — честно снимаем.
    if (glyphEdits.size) {
      if (m.glyphs.length === glyphEditBase) {
        for (const [gi, sh] of glyphEdits) {
          const g = m.glyphs[gi];
          if (g) { g.shape = sh; g.nodes = countNodes(sh); }
        }
      } else {
        glyphEdits.clear();
        say('Разбор изменился: правки контуров не к чему приложить, они сняты.', true);
      }
    }
    if (glyphEdit >= 0) {
      const g = m.glyphs[glyphEdit];
      if (g) { shape = g.shape; history.reset(shape); }
      else leaveGlyphEdit();
    }
    if (pending && pending.guides) {
      guides = pending.guides;
      buildMetricControls();
    } else if (!guides) {
      guides = normalizeGuides(guessGuides(m.glyphs));
      Object.assign(metrics, guessSpacing(m.glyphs, guides, metrics));
      buildMetricControls();
    }
    reassign();
    // Привязка позиционна: применяем сохранённую, только если букв столько же.
    if (pending && codesFit(pending, m.glyphs.length)) {
      codes = pending.codes.slice();
      renderGlyphGrid();
      renderCoverage();
    }
    pending = null;
    renderMetrics();
    updateStats();
    draw();
    sayDone();
    return;
  }

  result = m;
  if (phase === 'derived') {
    for (const got of m.layers ?? []) {
      const L = layers.find((x) => x.id === got.id);
      if (L) { L.shape = got.shape; L.assembly = got.assembly ?? null; }
    }
    shape = cur() ? cur().shape : null;
    selection = new Set();
    history.reset(shape);
  }
  // Осевая линия у залитой фигуры распадается на десятки кусков: ветвей у неё
  // столько же, сколько неровностей на границе. Молча отдать эту труху нельзя —
  // человек решит, что так и надо.
  if (traceKind === 'stroke' && m.stats && m.stats.contours > 12) {
    say(`Похоже, картинка не линейная: осевая распалась на ${m.stats.contours} кусков.`
      + ' Штрихом стоит обводить рисунки, начерченные линией.', true);
  } else {
    sayDone();
  }
  updateStats();
  draw();
};

// ─── загрузка ───────────────────────────────────────────────────────────────

async function loadBlob(blob, name) {
  try {
    const bitmap = await createImageBitmap(blob);
    store.set('source', { bitmap, w: bitmap.width, h: bitmap.height, name, blob });
    setRect(null);
    viewport.setContentSize(bitmap.width, bitmap.height);
    syncViewSize();
    viewport.fit();
    paramsTouched = false;   // новая картинка — новая подгонка
    document.body.classList.add('has-image');
    el.imgName.textContent = name;
    el.imgSize.textContent = `${bitmap.width} × ${bitmap.height}`;
    // Новая картинка — снова первый шаг: работать с ней всё равно начинают
    // с кропа, а брошенный файл на шаге «Контур» выглядел как «ничего не
    // произошло» — стол там показывает прежнюю обводку.
    setStep('image');
    say(null);
  } catch {
    say('Не удалось прочитать картинку. Нужен PNG, JPEG или WebP.', true);
  }
}

function takeFiles(list) {
  const f = [...list].find((x) => x.type.startsWith('image/'));
  if (f) loadBlob(f, f.name);
  else say('Это не картинка.', true);
}

el.file.addEventListener('change', () => { if (el.file.files.length) takeFiles(el.file.files); });

// Вуаль на весь экран, а не приглашение внутри стола: стол на шагах «Буквы»
// и «Шрифт» спрятан, и казалось, что новую картинку поверх старой не бросить.
// Глубина входов — потому что dragenter/dragleave стреляют на каждом
// вложенном элементе, и по первому же leave вуаль слетала бы.
let dragDepth = 0;

document.addEventListener('dragenter', (ev) => {
  ev.preventDefault();
  dragDepth += 1;
  el.dropVeil.hidden = false;
});
document.addEventListener('dragover', (ev) => {
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = 'copy';
});
document.addEventListener('dragleave', (ev) => {
  ev.preventDefault();
  dragDepth = Math.max(0, dragDepth - 1);
  if (dragDepth === 0) el.dropVeil.hidden = true;
});
document.addEventListener('drop', (ev) => {
  ev.preventDefault();
  dragDepth = 0;
  el.dropVeil.hidden = true;
  if (ev.dataTransfer?.files.length) takeFiles(ev.dataTransfer.files);
});

// Картинки от ИИ чаще всего попадают сюда через буфер обмена.
window.addEventListener('paste', (ev) => {
  const item = [...(ev.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (item) loadBlob(item.getAsFile(), 'из буфера обмена');
});

// ─── кроп ───────────────────────────────────────────────────────────────────

function setRect(next) {
  rect = next;
  draw();
  updatePanel();
}

function commitCrop(next) {
  const src = store.get('source');
  if (!next || !src) {
    store.set('crop', null);
    result = null;
    updateStats();
    updatePanel();
    return;
  }
  const imageData = cropFrom(src.bitmap, next);
  store.set('crop', { rect: next, imageData });

  // Догадка о цветах, чтобы что-то осмысленное показалось сразу, без пипеток.
  colors.bg = guessBackground(imageData);
  colors.fg = guessForeground(imageData, colors.bg);

  retuneParams();

  // Новый кроп — новые чернила. Слой один: догадка про два цвета там, где он
  // один, дороже обходится, чем щелчок по «Разобрать цвета».
  layers = [makeLayer(colors.fg, INK_NAMES[0])];
  active = 0;
  shape = null;
  history.reset(null);
  updateSwatches();

  worker.postMessage({ type: 'crop', imageData });
  scheduleSave();
  buildStepList();
  manualGroups = null;
  fittedSig = null;
  guides = null;
  glyphs = null;
  glyphSel = new Set();
  if (phase === 'detached') reattach();
  updatePanel();
  requestTrace();
  // Кроп выбран — дальше смотреть надо маску, а не картинку.
  if (step === 'image') setStep('mask');
}

createCropTool({
  el: el.overlay,
  viewport,
  isEnabled: () => step === 'image',
  getBounds: () => { const s = store.get('source'); return s && { w: s.w, h: s.h }; },
  getRect: () => rect,
  onChange: setRect,
  onCommit: commitCrop,
});

// ─── рисование ──────────────────────────────────────────────────────────────

function syncViewSize() {
  viewport.setViewSize(el.stage.clientWidth, el.stage.clientHeight);
}

function draw() {
  if (frame) return;
  frame = requestAnimationFrame(() => { frame = 0; render(); });
}

function render() {
  const dpr = window.devicePixelRatio || 1;
  const w = el.stage.clientWidth;
  const h = el.stage.clientHeight;

  if (el.canvas.width !== Math.round(w * dpr) || el.canvas.height !== Math.round(h * dpr)) {
    el.canvas.width = Math.round(w * dpr);
    el.canvas.height = Math.round(h * dpr);
    el.canvas.style.width = `${w}px`;
    el.canvas.style.height = `${h}px`;
  }
  syncViewSize();

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, el.canvas.width, el.canvas.height);

  const src = store.get('source');
  const crop = store.get('crop');
  // Стол показывает исходник только на первом шаге; дальше — кроп, а на шаге
  // «Маска» ещё и саму маску, чтобы видеть, что ловит порог.
  let content = null;
  // Маска живёт в увеличенном разрешении (см. «Увеличение»), а стол размечен
  // в пикселях кропа: без явного размера она рисовалась вшестеро крупнее поля.
  let size = null;
  if (step === 'image') content = src && src.bitmap;
  else if (step === 'mask' && bgMode === 'mask' && result) {
    content = maskToCanvas(result.mask);
    size = crop && [crop.imageData.width, crop.imageData.height];
  } else if (crop) content = toCanvas(crop.imageData);
  if (content) {
    ctx.setTransform(...viewport.canvasTransform(dpr));
    // Крупный зум должен показывать пиксели, а не мыло: вся суть проекта в краевых пикселях.
    ctx.imageSmoothingEnabled = viewport.scale < 1;
    if (size) ctx.drawImage(content, 0, 0, size[0], size[1]);
    else ctx.drawImage(content, 0, 0);
  }

  // На шаге «Маска» поверх неё можно наложить растр, чтобы сверить край.
  if (step === 'mask' && bgMode === 'both' && crop) {
    ctx.globalAlpha = 0.45;
    ctx.drawImage(toCanvas(crop.imageData), 0, 0);
    ctx.globalAlpha = 1;
  }

  el.overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
  if (step === 'metrics') {
    drawPixelGrid(ctx, dpr, w, h, crop);
    el.overlay.replaceChildren();
    renderGuides(w);
  } else if (step === 'contour' || glyphEdit >= 0) {
    drawPixelGrid(ctx, dpr, w, h, crop);
    renderEditor(el.overlay, {
      shape, selection, hover: editor.hover, viewport,
      fill: el.showFill.checked, marquee: editor.marquee,
    });
    // Соседние буквы — приглушённым контекстом ПОД правкой: renderEditor
    // начисто перерисовывает оверлей, поэтому подкладываем после него.
    if (glyphEdit >= 0 && glyphs) {
      for (const [gi, g] of glyphs.glyphs.entries()) {
        if (gi === glyphEdit || !g.shape) continue;
        const path = document.createElementNS(SVG_NS, 'path');
        path.setAttribute('d', toPathData(transform(g.shape, (p) => viewport.toScreen(p)), 2));
        path.setAttribute('class', 'ed-path dim');
        el.overlay.insertBefore(path, el.overlay.firstChild);
      }
    }
    // Соседние слои — приглушённым фоном под правкой: править можно один,
    // а судить о разборе — только по целому.
    renderNeighbours();
  } else if (step === 'mask' || step === 'export') {
    el.overlay.replaceChildren();
    renderOutline();
  } else {
    renderOverlay(w, h);
  }
  el.zoom.textContent = `${Math.round(viewport.scale * 100)}%`;
}

/**
 * Сетка по пикселям исходника. Появляется, когда пиксель крупнее восьми точек
 * экрана: на ровном фоне границы растра не видны, а узел ставить надо по ним.
 */
function drawPixelGrid(g, dpr, w, h, crop) {
  if (!crop || viewport.scale < 8) return;
  const { width: cw, height: ch } = crop.imageData;
  g.setTransform(dpr, 0, 0, dpr, 0, 0);
  g.strokeStyle = 'rgb(255 255 255 / 0.10)';
  g.lineWidth = 1 / dpr;
  g.beginPath();
  for (let x = 0; x <= cw; x += 1) {
    const p = viewport.toScreen({ x, y: 0 });
    if (p.x < 0 || p.x > w) continue;
    g.moveTo(p.x, Math.max(0, viewport.toScreen({ x, y: 0 }).y));
    g.lineTo(p.x, Math.min(h, viewport.toScreen({ x, y: ch }).y));
  }
  for (let y = 0; y <= ch; y += 1) {
    const p = viewport.toScreen({ x: 0, y });
    if (p.y < 0 || p.y > h) continue;
    g.moveTo(Math.max(0, viewport.toScreen({ x: 0, y }).x), p.y);
    g.lineTo(Math.min(w, viewport.toScreen({ x: cw, y }).x), p.y);
  }
  g.stroke();
}

/**
 * Что лежит ПОД правкой активного слоя: контуры соседей и — в режиме штриха —
 * настоящая толщина. Правится осевая линия, но судить надо по тому, что
 * получится: иначе на столе волосок, а в файле штрих.
 */
function renderNeighbours() {
  layers.forEach((L, i) => {
    if (!L.visible || !L.shape || !L.shape.contours.length) return;
    const own = i === active;
    for (const c of L.shape.contours) {
      if (own && !c.width) continue;           // свой контур рисует редактор
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', toPathData(transform({ contours: [c] }, (p) => viewport.toScreen(p)), 2));
      if (c.width) {
        path.setAttribute('class', `ed-stroke${own ? ' own' : ' dim'}`);
        path.setAttribute('stroke-width', Math.max(1, c.width * viewport.scale));
      } else {
        path.setAttribute('class', 'ed-path dim');
        path.setAttribute('fill-rule', 'nonzero');
      }
      el.overlay.insertBefore(path, el.overlay.firstChild);
    }
  });
}

/**
 * Готовые контуры поверх кропа — без узлов и правки.
 * Видны все слои сразу: правится один, но судить о разборе можно только по
 * целому. Неактивные приглушены, чтобы не спорить за внимание с активным.
 */
function renderOutline() {
  const filled = el.showFill && el.showFill.checked;
  layers.forEach((L, i) => {
    if (!L.visible || !L.shape || !L.shape.contours.length) return;
    for (const c of L.shape.contours) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', toPathData(transform({ contours: [c] }, (p) => viewport.toScreen(p)), 2));
      // У осевой линии показываем НАСТОЯЩУЮ толщину: иначе на столе виден
      // волосок, а в файле — штрих, и человек судит не о том, что получит.
      if (c.width) {
        path.setAttribute('class', `ed-stroke${i === active ? '' : ' dim'}`);
        path.setAttribute('stroke-width', Math.max(1, c.width * viewport.scale));
      } else {
        path.setAttribute('class', `ed-path${filled ? ' filled' : ''}${i === active ? '' : ' dim'}`);
        path.setAttribute('fill-rule', 'nonzero');
      }
      el.overlay.append(path);
    }
  });
}

/** Контуры букв и четыре направляющие поверх кропа. */
function renderGuides(w) {
  if (glyphs) {
    for (const g of glyphs.glyphs) {
      const path = document.createElementNS(SVG_NS, 'path');
      path.setAttribute('d', toPathData(transform(g.shape, (p) => viewport.toScreen(p)), 2));
      path.setAttribute('class', 'ov-glyph');
      el.overlay.append(path);
    }
  }
  if (!guides) return;
  for (const { key, label: name } of LINES) {
    const y = viewport.toScreen({ x: 0, y: guides[key] }).y;
    const line = document.createElementNS(SVG_NS, 'line');
    line.setAttribute('x1', 0); line.setAttribute('x2', w);
    line.setAttribute('y1', y); line.setAttribute('y2', y);
    line.setAttribute('class', `ov-guide ${key === 'baseline' ? 'baseline' : ''}`
      + `${guidesTool.hover === key || guidesTool.dragging === key ? ' hot' : ''}`);
    const text = document.createElementNS(SVG_NS, 'text');
    text.setAttribute('x', 8);
    text.setAttribute('y', y - 4);
    text.setAttribute('class', 'ov-guide-label');
    text.textContent = name;
    el.overlay.append(line, text);
  }
}

function renderOverlay(w, h) {
  el.overlay.setAttribute('viewBox', `0 0 ${w} ${h}`);
  el.overlay.replaceChildren();
  if (!rect || !store.get('source')) return;

  const a = viewport.toScreen({ x: rect.x, y: rect.y });
  const b = viewport.toScreen({ x: rect.x + rect.w, y: rect.y + rect.h });

  // Затемнение вокруг выделения — одним путём с чётно-нечётным заполнением.
  const shade = document.createElementNS(SVG_NS, 'path');
  shade.setAttribute('d',
    `M0,0 H${w} V${h} H0 Z M${a.x},${a.y} H${b.x} V${b.y} H${a.x} Z`);
  shade.setAttribute('fill-rule', 'evenodd');
  shade.setAttribute('class', 'ov-shade');
  el.overlay.append(shade);

  const frameRect = document.createElementNS(SVG_NS, 'rect');
  frameRect.setAttribute('x', a.x);
  frameRect.setAttribute('y', a.y);
  frameRect.setAttribute('width', Math.max(0, b.x - a.x));
  frameRect.setAttribute('height', Math.max(0, b.y - a.y));
  frameRect.setAttribute('class', 'ov-frame');
  el.overlay.append(frameRect);

  if (route === 'font' && glyphs) {
    const crop = store.get('crop');
    for (const g of glyphs.glyphs) {
      const p0 = viewport.toScreen({ x: crop.rect.x + g.bbox.x, y: crop.rect.y + g.bbox.y });
      const p1 = viewport.toScreen({
        x: crop.rect.x + g.bbox.x + g.bbox.w, y: crop.rect.y + g.bbox.y + g.bbox.h,
      });
      const r = document.createElementNS(SVG_NS, 'rect');
      r.setAttribute('x', p0.x); r.setAttribute('y', p0.y);
      r.setAttribute('width', Math.max(0, p1.x - p0.x));
      r.setAttribute('height', Math.max(0, p1.y - p0.y));
      r.setAttribute('class', 'ov-group');
      el.overlay.append(r);
    }
  }

  const pts = handlePoints(rect);
  for (const k of HANDLES) {
    const p = viewport.toScreen(pts[k]);
    const dot = document.createElementNS(SVG_NS, 'rect');
    dot.setAttribute('x', p.x - 4);
    dot.setAttribute('y', p.y - 4);
    dot.setAttribute('width', 8);
    dot.setAttribute('height', 8);
    dot.setAttribute('class', 'ov-handle');
    el.overlay.append(dot);
  }
}

// ─── панель ─────────────────────────────────────────────────────────────────

function updatePanel() {
  const crop = store.get('crop');
  document.body.classList.toggle('has-crop', Boolean(crop));
  if (!crop) return;

  const { rect: r, imageData } = crop;
  el.cropSize.textContent = `${r.w} × ${r.h} px`;
  el.cropSize.title = `от ${r.x}, ${r.y} в исходной картинке`;
  el.maskCrop.textContent = `${r.w} × ${r.h} px`;

  const small = Math.min(r.w, r.h) < SMALL_SIDE;
  el.cropWarn.hidden = !small;
  if (small) {
    el.cropWarn.textContent =
      `Сторона меньше ${SMALL_SIDE} px. Трассировка возможна, но потребует сильного `
      + `апскейла: большая часть контура живёт в краевых пикселях.`;
  }

}

// ─── препроцесс и трассировка ───────────────────────────────────────────────

/** Просьба пересчитать. Не чаще кадра: воркер всё равно схлопывает подряд идущие. */
/** Полный набор параметров, как его видит воркер. */
function fullParams() {
  return {
    ...params,
    bg: colors.bg,
    // Шрифтовой маршрут одноцветен, ему уезжает первый слой как есть.
    fg: cur() ? cur().fg : colors.fg,
    tolerance: cur() ? cur().tolerance : params.tolerance,
    layers: layers.map((L) => ({ id: L.id, fg: L.fg, tolerance: L.tolerance })),
    exclusive,
    stroke: route === 'font' ? false : (traceKind === 'assemble' ? 'assemble' : strokeTrace),
    route,
  };
}

function requestTrace() {
  if (!store.get('crop') || traceFrame) return;
  traceFrame = requestAnimationFrame(() => {
    traceFrame = 0;
    gen += 1;
    // Пока ответ не пришёл, честно видно, что счёт идёт: раньше долгий прогон
    // выглядел как мёртвое приложение.
    tuning = false;
    el.busy.textContent = 'обвожу…';
    el.busy.hidden = false;
    el.tune.textContent = 'Подобрать сам';
    worker.postMessage({ type: 'params', gen, params: fullParams() });
  });
}

// ─── авто-подбор ────────────────────────────────────────────────────────────

let tuning = false;

el.tune.addEventListener('click', () => {
  if (!store.get('crop')) { say('Сначала нужен кроп.', true); return; }
  if (tuning) { requestTrace(); return; }   // повторный щелчок — остановка
  if (phase === 'detached') {
    say('Контур отчуждён: настройки заморожены, подбирать нечего. «Обвести заново» вернёт автоматику.', true);
    return;
  }
  if (strokeTrace && route !== 'font') {
    say(traceKind === 'assemble'
      ? 'Подбор не работает в режиме сборки: примитивы подбираются сами.'
      : 'Подбор не работает в режиме штриха: у осевой линии нет площади для сверки.', true);
    return;
  }
  tuning = true;
  gen += 1;
  el.tune.textContent = 'Остановить подбор';
  el.busy.textContent = 'подбор…';
  el.busy.hidden = false;
  say(route === 'font'
    ? 'Подбор запущен: листу с буквами нужно около минуты. Любой ползунок прерывает.'
    : 'Подбор запущен: несколько секунд.');
  worker.postMessage({ type: 'tune', gen, params: fullParams() });
});

function tuneDone(m) {
  tuning = false;
  el.tune.textContent = 'Подобрать сам';
  el.busy.hidden = true;
  el.busy.textContent = 'обвожу…';
  if (m.aborted) { say('Подбор прерван — оставлено лучшее из найденного.'); }
  // Найденное открыто выставляется в те же ползунки, что крутит человек.
  for (const [key, value] of Object.entries(m.params)) {
    if (key === 'tolerance') {
      if (cur()) cur().tolerance = value;
      params.tolerance = value;
    } else if (key in params) {
      params[key] = value;
    }
  }
  paramsTouched = true;
  buildControls(ctlFactor);
  requestTrace();
  if (!m.aborted) {
    say(`Подобрано за ${m.steps} прогонов: узлов ${m.nodes} (было ${m.was.nodes}), `
      + `край гуляет на ${m.drift.toFixed(2)} px (было ${m.was.drift.toFixed(2)}).`);
  }
}

const rgb = (c) => `rgb(${c[0]} ${c[1]} ${c[2]})`;

function updateSwatches() {
  el.swBg.style.background = rgb(colors.bg);
  renderLayers();
}

// ─── слои ───────────────────────────────────────────────────────────────────

const INK_NAMES = ['Штрих', 'Второй цвет', 'Третий цвет', 'Четвёртый цвет'];

function makeLayer(fg, name) {
  layerSeq += 1;
  return {
    id: `L${layerSeq}`,
    name: name || INK_NAMES[layers.length] || `Цвет ${layers.length + 1}`,
    fg: [...fg],
    tolerance: params.tolerance,
    shape: null,
    visible: true,
  };
}

/** Все поля настроек разом: панелей теперь три, а замораживать надо все. */
function paramInputs() {
  return [el.controlsMask, el.controlsCurves, el.controlsCurvesFont]
    .flatMap((box) => [...box.querySelectorAll('input, select')]);
}

function pipIcon() {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('class', 'pip');
  svg.setAttribute('viewBox', '0 0 16 16');
  svg.setAttribute('aria-hidden', 'true');
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M10.5 2.5a1.8 1.8 0 0 1 2.5 2.5l-1.2 1.2 1 1-1 1-1-1-4.4 4.4-2.4.7.7-2.4 4.4-4.4-1-1 1-1 1 1z');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '1.3');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

function renderLayers() {
  el.layerList.replaceChildren();
  layers.forEach((L, i) => {
    const li = document.createElement('li');
    li.className = `layer${i === active ? ' on' : ''}${L.visible ? '' : ' off'}`;
    li.dataset.id = L.id;

    const pick = document.createElement('button');
    pick.type = 'button';
    pick.className = `swatch-btn lay-pick${pickMode === L.id ? ' picking' : ''}`;
    pick.dataset.act = 'pick';
    pick.title = 'Пипетка: щёлкните по этому цвету на картинке (Esc — отмена)';
    const sw = document.createElement('span');
    sw.className = 'swatch';
    sw.style.background = rgb(L.fg);
    pick.append(sw, pipIcon());

    const name = document.createElement('button');
    name.type = 'button';
    name.className = 'lay-name';
    name.dataset.act = 'select';
    name.textContent = L.name;
    const nodes = L.shape ? L.shape.contours.reduce((a, c) => a + c.nodes.length, 0) : 0;
    name.title = L.shape
      ? `контуров ${L.shape.contours.length}, узлов ${nodes}`
      : 'ещё не обведён';

    const eye = document.createElement('button');
    eye.type = 'button';
    eye.className = 'lay-eye';
    eye.dataset.act = 'eye';
    eye.title = L.visible ? 'Скрыть слой' : 'Показать слой';
    eye.textContent = L.visible ? '●' : '○';

    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'lay-del';
    del.dataset.act = 'del';
    del.title = 'Удалить слой';
    del.textContent = '✕';
    del.disabled = layers.length < 2;

    li.append(pick, name, eye, del);
    el.layerList.append(li);
  });
  el.layAdd.disabled = layers.length >= 4 || !store.get('crop');
  el.layGuess.disabled = !store.get('crop');
}

function setActive(i) {
  if (i < 0 || i >= layers.length || i === active) return;
  active = i;
  shape = cur().shape;
  selection = new Set();
  history.reset(shape);
  params.tolerance = cur().tolerance;
  if (tolSync) tolSync();
  renderLayers();
  updateEditPanel();
  draw();
  scheduleSave();
}

el.layerList.addEventListener('click', (ev) => {
  const btn = ev.target instanceof Element && ev.target.closest('button[data-act], button');
  if (!btn) return;
  const li = btn.closest('.layer');
  if (!li) return;
  const i = layers.findIndex((L) => L.id === li.dataset.id);
  if (i < 0) return;
  const act = btn.dataset.act;
  if (act === 'pick') { setActive(i); setPick(layers[i].id); return; }
  if (act === 'eye') {
    layers[i].visible = !layers[i].visible;
    renderLayers();
    draw();
    scheduleSave();
    return;
  }
  if (act === 'del') {
    if (layers.length < 2) return;
    layers.splice(i, 1);
    active = Math.min(active, layers.length - 1);
    shape = cur() ? cur().shape : null;
    history.reset(shape);
    renderLayers();
    requestTrace();
    scheduleSave();
    return;
  }
  setActive(i);
});

el.layAdd.addEventListener('click', () => {
  if (layers.length >= 4) return;
  const crop = store.get('crop');
  if (!crop) return;
  // Новый слой начинает с цвета, которого ещё нет: догадка по кропу за вычетом
  // уже разобранных чернил — так первый же щелчок пипеткой обычно не нужен.
  const known = layers.map((L) => L.fg);
  const guess = guessInks(crop.imageData, colors.bg, { k: layers.length + 1 })
    .find((c) => known.every((q) => Math.hypot(c[0] - q[0], c[1] - q[1], c[2] - q[2]) > 40));
  layers.push(makeLayer(guess || colors.fg));
  setActive(layers.length - 1);
  renderLayers();
  requestTrace();
});

el.layGuess.addEventListener('click', () => {
  const crop = store.get('crop');
  if (!crop) return;
  const inks = guessInks(crop.imageData, colors.bg, { k: 4 });
  if (!inks.length) { say('Чернил не видно: кроп однотонный.', true); return; }
  layers = inks.map((c, i) => makeLayer(c, INK_NAMES[i]));
  active = 0;
  shape = null;
  history.reset(null);
  params.tolerance = cur().tolerance;
  if (tolSync) tolSync();
  renderLayers();
  requestTrace();
  say(inks.length === 1
    ? 'Чернила одни: слой оставлен один.'
    : `Разобрано чернил: ${inks.length}.`);
});

el.layExclusive.addEventListener('change', () => {
  exclusive = el.layExclusive.checked;
  requestTrace();
  scheduleSave();
});

/** Маска Float32 → канва в оттенках серого. */
function maskToCanvas(mask) {
  const c = document.createElement('canvas');
  c.width = mask.w;
  c.height = mask.h;
  const id = c.getContext('2d').createImageData(mask.w, mask.h);
  for (let i = 0; i < mask.data.length; i += 1) {
    const v = Math.round(mask.data[i] * 255);
    id.data[i * 4] = v; id.data[i * 4 + 1] = v; id.data[i * 4 + 2] = v; id.data[i * 4 + 3] = 255;
  }
  c.getContext('2d').putImageData(id, 0, 0);
  return c;
}

/** Расхождение контура с растром: средний увод края, в пикселях маски. */
function fmtFit(fit) {
  if (!fit) return '—';
  const px = fit.drift.toFixed(2);
  const d = fit.compRen - fit.compBin;
  if (d === 0) return `${px} px по краю`;
  return `${px} px · ${d < 0 ? `потеряно кусков: ${-d}` : `лишних кусков: ${d}`}`;
}

function updateStats() {
  const st = glyphs && glyphs.stats;
  el.glyphComps.textContent = st ? String(st.components) : '—';
  el.glyphCount.textContent = st ? String(st.glyphs) : '—';
  el.glyphNodes.textContent = st ? String(st.nodes) : '—';
  el.glyphFit.textContent = st ? fmtFit(st.fit) : '—';

  if (!result) {
    el.maskSize.textContent = '—';
    el.statFit.textContent = '—';
    el.statContours.textContent = el.statNodes.textContent = el.statMs.textContent = '—';
    el.exContours.textContent = el.exNodes.textContent = '—';
    return;
  }
  const s2 = result.stats;
  el.maskSize.textContent = `${s2.maskSize[0]} × ${s2.maskSize[1]}`
    + (s2.capped ? ` (×${s2.scale})` : '');
  el.statContours.textContent = String(s2.contours);
  el.statNodes.textContent = String(s2.nodes);
  el.statFit.textContent = fmtFit(s2.fit);
  el.statMs.textContent = s2.symmetry
    ? `${s2.ms} мс · симметрия ${Math.round(s2.symmetry.score * 100)}%`
    : `${s2.ms} мс`;
  // В экспорт идут все видимые слои, а не один правимый.
  const live = layers.filter((L) => L.visible && L.shape);
  el.exContours.textContent = String(live.length
    ? live.reduce((a, L) => a + L.shape.contours.length, 0)
    : s2.contours);
  el.exNodes.textContent = String(live.length
    ? live.reduce((a, L) => a + L.shape.contours.reduce((b, c) => b + c.nodes.length, 0), 0)
    : s2.nodes);
}

// ─── маршрут шрифта ─────────────────────────────────────────────────────────

function setRoute(next) {
  leaveGlyphEdit();
  route = next;
  document.body.classList.toggle('route-font', route === 'font');
  for (const b of el.routeSwitch.querySelectorAll('button')) {
    b.classList.toggle('on', b.dataset.route === route);
  }
  if (route === 'icon') {
    glyphs = null; glyphSel = new Set(); codes = []; guides = null; fittedSig = null;
  } else if (layers.length > 1) {
    // Строка текста набрана одними чернилами; лишние слои в шрифте не нужны
    // и молча пропали бы — лучше сказать вслух.
    layers = layers.slice(0, 1);
    active = 0;
    shape = cur() ? cur().shape : null;
    say('Шрифт одноцветен: оставлены первые чернила.');
  }
  manualGroups = null;
  fittedSig = null;
  // Допуски зависят от маршрута, а кроп обычно делают ещё в иконочном режиме.
  // Подгоняем заново ВСЕГДА: оставить ручные значения другого маршрута —
  // значит молча трассировать лист порогами, рассчитанными на иконку.
  const wasTouched = paramsTouched;
  retuneParams(true);
  if (wasTouched) say('Допуски подогнаны под маршрут заново.');
  // Шаг мог исчезнуть вместе с маршрутом — тогда откатываемся к первому общему.
  if (!STEPS[route].some((s2) => s2.key === step)) {
    step = store.get('crop') ? 'mask' : 'image';
  }
  setStep(step);
  requestTrace();
}

el.routeSwitch.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-route]');
  if (btn) setRoute(btn.dataset.route);
});

// ─── привязка к символам ────────────────────────────────────────────────────

/**
 * Перепривязка от текста. Ручные правки отдельных букв при этом теряются:
 * после новой сегментации индексы глифов всё равно другие, и делать вид,
 * что привязка их пережила, было бы враньём.
 */
function reassign() {
  if (!glyphs) { codes = []; renderGlyphGrid(); renderCoverage(); return; }
  const lines = parseLines(el.textIn.value);
  const res = autoAssign(glyphs.glyphs, lines);
  codes = res.codes;
  renderAssignNote(res);
  renderGlyphGrid();
  renderCoverage();
  scheduleFont();
  scheduleSave();
  maybeFitRows();
}

/**
 * Подогнать строки под введённый текст.
 *
 * Человек сказал, что написано, — значит известно, сколько знаков в каждой
 * строке. Гадать про многоточие из трёх точек или процент из трёх частей
 * больше незачем: лишние группы склеиваются по самым тесным зазорам.
 *
 * Только когда строк текста ровно столько же, сколько рядов букв: иначе
 * непонятно, какую строку с какой сверять, и подгонка наделает бед.
 */
function maybeFitRows() {
  if (!glyphs || manualGroups) return;
  const lines = parseLines(el.textIn.value);
  if (!lines.length) return;
  const counts = lines.map((l) => l.filter((c) => !c.space).length);
  if (new Set(glyphs.glyphs.map((g) => g.row)).size !== counts.length) return;

  const sig = `${glyphs.gen}|${el.textIn.value}`;
  if (fittedSig === sig) return;
  fittedSig = sig;

  const res = fitRows(glyphs.glyphs.map((g) => g.ids), glyphs.components, counts);
  if (res.groups.length === glyphs.glyphs.length) return;

  gen += 1;
  worker.postMessage({ type: 'regroup', gen, groups: res.groups });
  const short = res.short.length
    ? ` Строк, где букв не хватило: ${res.short.map((i) => i + 1).join(', ')} — там знаки слиплись, разнимать надо руками.`
    : '';
  say(`Строки подогнаны под текст: букв ${glyphs.glyphs.length} → ${res.groups.length}.${short}`,
    res.short.length > 0);
}

function renderAssignNote(res) {
  const bits = [];
  if (res.lineCount === 0) {
    bits.push('Напечатайте, что написано на картинке, — привязка сложится сама.');
  } else {
    if (res.rowCount !== res.lineCount) {
      bits.push(`строк текста ${res.lineCount}, а рядов букв ${res.rowCount}`);
    }
    if (res.spare.length) {
      bits.push(`символов без глифа: ${res.spare.map((s) => s.ch).join('')}`);
    }
    const blank = codes.filter((c) => c == null).length;
    if (blank) bits.push(`глифов без символа: ${blank}`);
    if (!bits.length) bits.push('Каждой букве нашёлся символ.');
    // Сколько узлов вышло против того, сколько обычно нужно этим знакам:
    // сансериф и антиква задают коридор, а не норму.
    if (glyphs) {
      const known = codes.map((c, i) => (c == null ? null : [label(c), glyphs.glyphs[i]]))
        .filter(Boolean);
      const prior = sheetPrior(known.map(([ch]) => ch));
      if (prior.known >= 5) {
        const got = known.reduce((a, [, g]) => a + g.nodes, 0);
        bits.push(`узлов у ${prior.known} букв: ${got}, обычно ${prior.sans} (сансериф) – ${prior.serif} (антиква)`);
      }
    }
  }
  el.assignNote.textContent = bits.join(' · ');
  el.assignNote.classList.toggle('warn-text',
    res.lineCount > 0 && (res.rowCount !== res.lineCount || res.spare.length > 0));
}

/**
 * Покрытие сразу по нескольким алфавитам: на одном листе может быть и
 * кириллица, и латиница, и знаки, и выбирать из них один — значит закрывать
 * глаза на остальные.
 */
function renderCoverage() {
  el.coverOut.replaceChildren();
  if (!glyphs) return;
  const { covered, duplicates, unassigned } = roster(glyphs.glyphs, codes);

  const row = (parent, lbl, cls, text) => {
    if (!text) return;
    const d = document.createElement('div');
    d.className = 'row';
    d.innerHTML = `<span class="lbl">${lbl}</span><span class="${cls}"></span>`;
    d.lastChild.textContent = text;
    parent.append(d);
  };

  for (const box of el.alphaPick.querySelectorAll('input')) {
    const alpha = ALPHABETS[box.value] ?? '';
    const cov = coverage(covered, alpha);
    const total = [...alpha].length;
    const full = cov.missing.length === 0;
    // Названия алфавитов помечаем прямо в списке: видно, не открывая раздел.
    box.parentElement.classList.toggle('full', full && total > 0);
    if (!box.checked) continue;

    const block = document.createElement('div');
    block.className = 'alpha';
    const head = document.createElement('div');
    head.className = `head${full ? ' full' : ''}`;
    head.innerHTML = `${box.value}: <b></b>`;
    head.querySelector('b').textContent = `${cov.have.length}/${total}`;
    block.append(head);
    if (!full) row(block, 'не хватает', 'miss', cov.missing.join(''));
    else row(block, 'есть', 'have', cov.have.join(''));
    el.coverOut.append(block);
  }

  const tail = document.createElement('div');
  tail.className = 'alpha';
  row(tail, 'дубликаты', 'dup', duplicates.map(([c, list]) => `${label(c)}×${list.length}`).join(' '));
  row(tail, 'без символа', 'dup', unassigned.length ? String(unassigned.length) : '');
  if (tail.children.length) el.coverOut.append(tail);
}

let assignTimer = 0;
el.textIn.addEventListener('input', () => {
  clearTimeout(assignTimer);
  assignTimer = setTimeout(reassign, 200);
});

for (const name of Object.keys(ALPHABETS)) {
  const lab = document.createElement('label');
  const box = document.createElement('input');
  box.type = 'checkbox';
  box.value = name;
  box.checked = true;
  lab.append(box, document.createTextNode(name));
  el.alphaPick.append(lab);
}
el.alphaPick.addEventListener('change', renderCoverage);

/** Поле «символ»: правит выбранную букву и переходит к следующей. */
el.charIn.addEventListener('input', () => {
  if (glyphSel.size !== 1) return;
  const i = [...glyphSel][0];
  codes = setCode(codes, i, el.charIn.value.trim());
  renderGlyphGrid();
  renderCoverage();
  if (el.charIn.value.trim() && i + 1 < glyphs.glyphs.length) {
    selectGlyph(i + 1);
  } else {
    el.charIn.value = label(codes[i]);
  }
});

function selectGlyph(i) {
  glyphSel = new Set([i]);
  for (const c of el.glyphGrid.children) c.classList.toggle('on', +c.dataset.index === i);
  el.charIn.value = label(codes[i]);
  el.charIn.select();
  updateGlyphButtons();
  el.glyphGrid.children[i]?.scrollIntoView({ block: 'nearest' });
}

/** Сетка найденных букв: растр из кропа плюс обведённый контур поверх. */
function renderGlyphGrid() {
  el.glyphGrid.replaceChildren();
  const crop = store.get('crop');
  if (!glyphs || !crop) {
    // Пустота без объяснения читается как поломка. Говорим, что происходит.
    const note = document.createElement('p');
    note.className = 'grid-note';
    note.textContent = !crop
      ? 'Сначала выделите кропом лист с буквами на шаге «Картинка».'
      : (el.busy.hidden ? 'Разбор ещё не приходил — поменяйте любую настройку.' : 'Разбираю буквы…');
    el.glyphGrid.append(note);
    return;
  }
  const src = toCanvas(crop.imageData);

  glyphs.glyphs.forEach((g, i) => {
    // Сетка живёт в рабочей области, а не в узкой панели: плитке есть где
    // развернуться, и букву видно, не приглядываясь.
    // Ноль на ползунке — «авто»: подогнать плитку под ~92 px, чтобы буква
    // читалась и на мелком листе. Иначе кратность задаёт человек.
    const manual = Number(el.tileZoom.value);
    const zoom = manual > 0 ? manual
      : Math.max(1, Math.min(10, Math.floor(92 / Math.max(g.bbox.w, g.bbox.h))));
    const w = g.bbox.w * zoom;
    const h = g.bbox.h * zoom;

    const cell = document.createElement('div');
    cell.className = `glyph${glyphSel.has(i) ? ' on' : ''}`;
    cell.dataset.index = i;
    // Число узлов — рядом с ожиданием по настоящим шрифтам: перебор и
    // недобор видны, не открывая контур.
    cell.title = `буква ${i + 1}, строка ${g.row + 1}, ${g.bbox.w}×${g.bbox.h} px,`
      + ` увеличение ×${g.scale}, ${describeNodes(label(codes[i]), g.nodes)}`;

    const stack = document.createElement('div');
    stack.className = 'stack';
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const g2 = cv.getContext('2d');
    g2.imageSmoothingEnabled = false;
    g2.drawImage(src, g.bbox.x, g.bbox.y, g.bbox.w, g.bbox.h, 0, 0, w, h);

    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('width', w);
    svg.setAttribute('height', h);
    svg.setAttribute('viewBox', `${g.bbox.x} ${g.bbox.y} ${g.bbox.w} ${g.bbox.h}`);
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', toPathData(g.shape, 2));
    path.setAttribute('class', 'gpath');
    path.setAttribute('vector-effect', 'non-scaling-stroke');
    svg.append(path);

    stack.append(cv, svg);
    // Номер живёт только в подсказке: два значка четырнадцатого кегля
    // на плитку не влезают, а нужен из них один — буква.
    const ch = document.createElement('span');
    const letter = label(codes[i]);
    ch.className = letter ? 'ch' : 'ch none';
    ch.textContent = letter || '?';
    cell.append(stack, ch);
    el.glyphGrid.append(cell);
  });
  updateGlyphButtons();
}

function updateGlyphButtons() {
  el.charIn.disabled = glyphSel.size !== 1;
  el.glEdit.disabled = glyphSel.size !== 1;
  el.glMerge.disabled = glyphSel.size < 2;
  el.glSplit.disabled = glyphSel.size === 0;
  el.glReset.disabled = manualGroups === null;
}

/**
 * ЕДИНСТВЕННАЯ точка, решающая видимость видов и инструментов.
 * Раньше stage/grid/зум щёлкали три места независимо (setStep, вход и выход
 * из правки буквы) — и рассинхрон давал то пустую сетку при спрятанном столе,
 * то зум без стола. Производное состояние не хранится, а выводится.
 */
function syncView() {
  const view = glyphEdit >= 0 ? 'stage' : VIEW[step];
  el.stage.hidden = view !== 'stage';
  el.gridView.hidden = view !== 'grid';
  el.fontView.hidden = view !== 'font';
  el.zoomGroup.style.visibility = view === 'stage' ? '' : 'hidden';
  el.editTools.hidden = !(step === 'contour' || glyphEdit >= 0);
  el.glyphEditRow.hidden = glyphEdit < 0;
}

function enterGlyphEdit(i) {
  const g = glyphs && glyphs.glyphs[i];
  const crop = store.get('crop');
  if (!g || !crop) return;
  glyphEdit = i;
  shape = g.shape;
  selection = new Set();
  history.reset(shape);
  syncView();
  viewport.setContentSize(crop.imageData.width, crop.imageData.height);
  syncViewSize();
  viewport.fitRect(g.bbox, 60);
  updateEditPanel();
  draw();
  say('Правка буквы. Изменения переживают пересчёт, пока букв столько же; Esc — назад к сетке.');
}

function leaveGlyphEdit() {
  if (glyphEdit < 0) return;
  glyphEdit = -1;
  shape = cur() ? cur().shape : null;
  selection = new Set();
  history.reset(shape);
  editor.clearHover();
  syncView();
  if (step === 'glyphs') renderGlyphGrid();
  updateStats();
  draw();
  say(null);
}

el.glEdit.addEventListener('click', () => {
  if (glyphSel.size === 1) enterGlyphEdit([...glyphSel][0]);
});
el.glDone.addEventListener('click', leaveGlyphEdit);

el.glShapeReset.addEventListener('click', () => {
  if (glyphEdit < 0) return;
  glyphEdits.delete(glyphEdit);
  requestTrace();
  say('Буква будет обведена заново по нынешним настройкам.');
});

el.glyphGrid.addEventListener('dblclick', (ev) => {
  const cell = ev.target instanceof Element && ev.target.closest('.glyph');
  if (cell) enterGlyphEdit(+cell.dataset.index);
});

el.glyphGrid.addEventListener('click', (ev) => {
  const cell = ev.target.closest('.glyph');
  if (!cell) return;
  const i = +cell.dataset.index;
  if (ev.ctrlKey || ev.metaKey) {
    if (glyphSel.has(i)) glyphSel.delete(i); else glyphSel.add(i);
  } else {
    glyphSel = glyphSel.has(i) && glyphSel.size === 1 ? new Set() : new Set([i]);
  }
  for (const c of el.glyphGrid.children) {
    c.classList.toggle('on', glyphSel.has(+c.dataset.index));
  }
  el.charIn.value = glyphSel.size === 1 ? label(codes[[...glyphSel][0]]) : '';
  el.charIn.disabled = glyphSel.size !== 1;
  updateGlyphButtons();
});

const currentGroups = () => glyphs.glyphs.map((g) => g.ids);

function sendGroups(groups) {
  manualGroups = groups;
  gen += 1;
  worker.postMessage({ type: 'regroup', gen, groups });
}

el.glMerge.addEventListener('click', () => {
  if (!glyphs || glyphSel.size < 2) return;
  const groups = currentGroups();
  const merged = [];
  const rest = [];
  groups.forEach((ids, i) => (glyphSel.has(i) ? merged.push(...ids) : rest.push(ids)));
  sendGroups([...rest, merged.sort((a, b) => a - b)]);
});

el.glSplit.addEventListener('click', () => {
  if (!glyphs || !glyphSel.size) return;
  const out = [];
  currentGroups().forEach((ids, i) => {
    if (glyphSel.has(i) && ids.length > 1) out.push(...ids.map((x) => [x]));
    else out.push(ids);
  });
  sendGroups(out);
});

el.glReset.addEventListener('click', () => { manualGroups = null; requestTrace(); });

// ─── метрики ────────────────────────────────────────────────────────────────

const guidesTool = createGuidesTool({
  el: el.overlay,
  viewport,
  isEnabled: () => step === 'metrics',
  get: () => ({ guides }),
  set: (patch) => {
    if (patch.guides) guides = patch.guides;
    draw();
    renderMetrics();
    scheduleSave();
  },
});

const M_CONTROLS = [
  { key: 'capUnits', label: 'Высота прописных', min: 400, max: 900, step: 10,
    hint: 'Во что превращается высота прописной буквы в единицах шрифта. '
      + 'Кегельная площадка — 1000; семьсот это обычная пропорция.' },
  { key: 'sideBearing', label: 'Боковой отступ', min: 0, max: 200, step: 5,
    hint: 'Воздух слева и справа от буквы. Измерен по зазорам между буквами '
      + 'на самой картинке: рисовавший её уже выбрал расстояние.' },
  { key: 'spaceUnits', label: 'Ширина пробела', min: 50, max: 600, step: 10,
    hint: 'Пробел глифа не имеет, его ширина задаётся отдельно. Если в тексте '
      + 'были пробелы, она измерена по широким зазорам в строке.' },
];

function buildMetricControls() {
  if (el.mControls.children.length) return;
  for (const c of M_CONTROLS) {
    const row = document.createElement('div');
    row.className = 'ctl';
    const lab = document.createElement('label');
    lab.textContent = c.label;
    lab.htmlFor = `m-${c.key}`;
    const head = document.createElement('div');
    head.className = 'ctl-head';
    head.append(lab, hintButton(c.hint));
    const val = document.createElement('span');
    val.className = 'ctl-value';
    const input = document.createElement('input');
    input.type = 'range';
    input.id = `m-${c.key}`;
    input.min = c.min; input.max = c.max; input.step = c.step;
    input.value = metrics[c.key];
    const show = () => { val.textContent = String(metrics[c.key]); };
    show();
    input.addEventListener('input', () => {
      metrics[c.key] = Number(input.value);
      show();
      renderMetrics();
      scheduleSave();
    });
    row.append(head, val, input);
    el.mControls.append(row);
  }
}

/** Глифы в единицах шрифта, в порядке чтения. */
function fontGlyphs() {
  if (!glyphs || !guides) return [];
  return glyphs.glyphs.map((g, i) => buildGlyph(
    { ...g, codepoint: codes[i] ?? null }, guides, metrics,
  ));
}

function renderMetrics() {
  if (!guides || !glyphs) return;
  scheduleFont();
  const fm = fontMetrics(guides, metrics);
  el.mCap.textContent = String(fm.capHeight);
  el.mX.textContent = String(fm.xHeight);
  el.mAsc.textContent = String(fm.ascender);
  el.mDesc.textContent = String(fm.descender);
  el.mScale.textContent = `${scaleFor(guides, metrics).toFixed(1)} ед.`;
  renderStrip(fm);
}

/**
 * Полоска-превью: буквы, поставленные по своим ширинам на общую базовую линию.
 * Это и есть проверка этапа — если хоть одна пляшет по вертикали, видно сразу.
 */
function renderStrip(fm) {
  const list = fontGlyphs();
  el.strip.replaceChildren();
  if (!list.length) return;

  const top = fm.ascender * 1.08;
  const bottom = fm.descender * 1.15;
  const pad = 40;
  let x = pad;
  const parts = [];
  for (const g of list) {
    parts.push({ d: toPathData(translateShape(g.shape, x, 0), 1) });
    x += g.advance;
  }
  const w = x + pad;
  const h = top - bottom;
  el.strip.setAttribute('viewBox', `0 ${-top} ${w} ${h}`);
  el.strip.setAttribute('width', Math.round(h ? (w / h) * 88 : 0));

  const line = (y, cls) => {
    const e = document.createElementNS(SVG_NS, 'line');
    e.setAttribute('x1', 0); e.setAttribute('x2', w);
    e.setAttribute('y1', -y); e.setAttribute('y2', -y);
    e.setAttribute('class', cls);
    e.setAttribute('vector-effect', 'non-scaling-stroke');
    el.strip.append(e);
  };
  line(fm.capHeight, 'rule-line');
  line(fm.xHeight, 'rule-line');
  line(0, 'base');

  for (const p of parts) {
    const path = document.createElementNS(SVG_NS, 'path');
    // Ось Y в шрифте вверх, а в SVG вниз — поэтому отражаем при показе.
    path.setAttribute('d', p.d);
    path.setAttribute('class', 'g');
    path.setAttribute('transform', 'scale(1,-1)');
    el.strip.append(path);
  }
}

el.mGuess.addEventListener('click', () => {
  if (!glyphs) return;
  guides = normalizeGuides(guessGuides(glyphs.glyphs));
  Object.assign(metrics, guessSpacing(glyphs.glyphs, guides, metrics));
  for (const c of M_CONTROLS) {
    const input = document.getElementById(`m-${c.key}`);
    if (input) { input.value = metrics[c.key]; input.dispatchEvent(new Event('input')); }
  }
  draw();
  renderMetrics();
  say('Направляющие поставлены по габаритам букв.');
});

// ─── сборка шрифта ──────────────────────────────────────────────────────────

const PREVIEW_FAMILY = 'ПантографПревью';
let previewFace = null;
let fontTimer = 0;

function assembleFont() {
  const list = fontGlyphs();
  if (!list.length || !guides) return null;
  return buildFont(list, fontMetrics(guides, metrics), {
    familyName: el.fontName.value.trim() || 'Пантограф',
    spaceUnits: metrics.spaceUnits,
  });
}

/**
 * Живое превью: собранный шрифт скармливается странице через FontFace.
 * Проба пера набирается тем самым файлом, который скачается, — а не картинкой
 * контуров, похожей на него.
 */
async function refreshFontPreview() {
  if (route !== 'font' || !glyphs) return;

  const built = assembleFont();
  // Шрифт собирается и из ничего — из .notdef и пробела, поэтому считать надо
  // не буквы на листе, а глифы в файле. Иначе проба пера набирается системной
  // гарнитурой на подмену, и чужой шрифт выдаётся за собранный.
  if (!built || built.count <= 2) {
    el.fontSample.classList.add('empty');
    el.fontSample.textContent = 'Пока нечего набирать: ни одной букве не задан символ.';
    el.fontNote.textContent = '';
    el.fontSave.disabled = true;
    return;
  }

  const dup = built.dropped.length;
  el.fontNote.textContent = `${built.count} глифов, включая .notdef и пробел`
    + (dup ? ` · отброшено повторов: ${dup} (${built.dropped.map((d) => label(d.codepoint)).join(', ')})` : '');
  el.fontSave.disabled = false;

  try {
    if (previewFace) { document.fonts.delete(previewFace); previewFace = null; }
    const face = new FontFace(PREVIEW_FAMILY, toArrayBuffer(built.font));
    await face.load();
    document.fonts.add(face);
    previewFace = face;
    el.fontSample.classList.remove('empty');
    el.fontSample.style.fontFamily = `"${PREVIEW_FAMILY}", serif`;
    el.fontSample.textContent = el.fontSampleIn.value || ' ';
  } catch (err) {
    el.fontSample.classList.add('empty');
    el.fontSample.textContent = `Шрифт не собрался: ${err.message}`;
  }
}

const scheduleFont = () => {
  clearTimeout(fontTimer);
  fontTimer = setTimeout(refreshFontPreview, 250);
};

el.fontName.addEventListener('input', scheduleFont);
el.fontSampleIn.addEventListener('input', () => {
  // Пока шрифта нет, в рабочей области стоит объяснение — набирать поверх него
  // пробу нечем, кроме системной гарнитуры.
  if (el.fontSample.classList.contains('empty')) return;
  el.fontSample.textContent = el.fontSampleIn.value || ' ';
});

el.fontSave.addEventListener('click', () => {
  const built = assembleFont();
  if (!built || built.count <= 2) { say('Сначала нужно задать буквам символы.', true); return; }
  const name = el.fontName.value.trim() || 'Пантограф';
  const url = URL.createObjectURL(new Blob([toArrayBuffer(built.font)], { type: 'font/otf' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = fileName(name);
  a.click();
  URL.revokeObjectURL(url);
  say(`Сохранён ${fileName(name)} — ${built.count} глифов.`);
});

// ─── редактор ───────────────────────────────────────────────────────────────

const editor = createEditorTool({
  el: el.overlay,
  viewport,
  isEnabled: () => step === 'contour' || glyphEdit >= 0,
  history,
  get: () => ({ shape, selection, snap: el.edSnap.checked ? 0.5 : 0 }),
  set: (patch) => {
    if (patch.shape && patch.shape !== shape) {
      setShape(patch.shape);
      ownEdit();
    }
    if (patch.selection) selection = patch.selection;
    draw();
    updateEditPanel();
    scheduleSave();
  },
});

/**
 * Кому принадлежит только что сделанная правка. У иконки она отчуждает всю
 * работу; у буквы — ложится в glyphEdits и переживает пересчёты, пока разбор
 * даёт столько же букв (правки позиционны, как и привязка к символам).
 */
function ownEdit() {
  if (glyphEdit < 0) { detach(); return; }
  const g = glyphs && glyphs.glyphs[glyphEdit];
  if (!g) return;
  if (!glyphEdits.size) glyphEditBase = glyphs.glyphs.length;
  g.shape = shape;
  g.nodes = countNodes(shape);
  glyphEdits.set(glyphEdit, shape);
  scheduleFont();
}

/** Первая правка отчуждает контур у конвейера. Обратно — только явно. */
function detach() {
  if (phase === 'detached') return;
  phase = 'detached';
  document.body.classList.add('detached');
  el.detached.hidden = false;
  for (const input of paramInputs()) input.disabled = true;
  say('Контур отчуждён: настройки заморожены, правки принадлежат вам.');
}

function reattach() {
  phase = 'derived';
  document.body.classList.remove('detached');
  el.detached.hidden = true;
  for (const input of paramInputs()) input.disabled = false;
  selection = new Set();
  requestTrace();
}

/**
 * Этапы обработки. Каждый решает сам, что показывать в рабочей области и
 * какие настройки держать под рукой: раньше всё лежало одной простынёй,
 * и ползунок оказывался через полэкрана от того, на что он влияет.
 */
const STEPS = {
  icon: [
    { key: 'image', name: 'Картинка' },
    { key: 'mask', name: 'Маска' },
    { key: 'contour', name: 'Контур' },
    { key: 'export', name: 'Экспорт' },
  ],
  font: [
    { key: 'image', name: 'Картинка' },
    { key: 'mask', name: 'Маска' },
    { key: 'glyphs', name: 'Буквы' },
    { key: 'metrics', name: 'Метрики' },
    { key: 'font', name: 'Шрифт' },
  ],
};

/** Что показывает рабочая область на каждом шаге. */
const VIEW = {
  image: 'stage', mask: 'stage', contour: 'stage',
  metrics: 'stage', export: 'stage', glyphs: 'grid', font: 'font',
};

function buildStepList() {
  el.stepList.replaceChildren();
  const hasCrop = Boolean(store.get('crop'));
  STEPS[route].forEach((s2, i) => {
    if (i) {
      const sep = document.createElement('li');
      sep.className = 'step-sep';
      sep.textContent = '›';
      el.stepList.append(sep);
    }
    const li = document.createElement('li');
    const b = document.createElement('button');
    b.type = 'button';
    b.className = `step${s2.key === step ? ' on' : ''}`;
    b.disabled = s2.key !== 'image' && !hasCrop;
    b.dataset.step = s2.key;
    const num = document.createElement('span');
    num.className = 'num';
    num.textContent = String(i + 1);
    b.append(num, document.createTextNode(s2.name));
    li.append(b);
    el.stepList.append(li);
  });
}

function setStep(next) {
  if (next !== 'image' && !store.get('crop')) return;
  if (!STEPS[route].some((s2) => s2.key === next)) return;
  leaveGlyphEdit();
  step = next;
  document.body.dataset.step = step;

  for (const sec of el.panel.querySelectorAll('.step-panel')) {
    if (sec.classList.contains('always')) continue;
    sec.hidden = sec.dataset.step !== step;
  }
  syncView();
  const view = VIEW[step];

  editor.clearHover();
  guidesTool.clearHover();

  const src = store.get('source');
  const crop = store.get('crop');
  if (view === 'stage') {
    if (step === 'image' && src) viewport.setContentSize(src.w, src.h);
    else if (crop) viewport.setContentSize(crop.imageData.width, crop.imageData.height);
    syncViewSize();
    viewport.fit();
  }

  buildStepList();
  updateEditPanel();
  updateStats();
  if (step === 'glyphs') renderGlyphGrid();
  if (step === 'font') refreshFontPreview();
  if (step === 'metrics') renderMetrics();
  draw();
  scheduleSave();
}

el.stepList.addEventListener('click', (ev) => {
  const b = ev.target.closest('button[data-step]');
  if (b && !b.disabled) setStep(b.dataset.step);
});

/**
 * На что похожи контуры. Программа только предлагает: иногда картошка
 * и задумана картошкой, а молча превращать её в круг — самоуправство.
 */
function renderPrimitives() {
  el.primList.replaceChildren();
  el.primBox.hidden = step !== 'contour' || !shape;
  if (el.primBox.hidden) return;

  let found = 0;
  shape.contours.forEach((c, ci) => {
    if (c.nodes.length < 3) return;
    const match = detectPrimitive(c, primShare);
    if (!match || !match.fits) return;
    found += 1;

    const row = document.createElement('div');
    row.className = 'prim';
    const what = document.createElement('span');
    what.className = 'prim-what';
    what.innerHTML = `контур ${ci + 1}: <b></b>`;
    what.querySelector('b').textContent = match.name;
    const err = document.createElement('span');
    err.className = 'prim-err';
    err.textContent = `${match.error.toFixed(2)} px`;
    err.title = 'наибольшее отклонение контура от примитива';
    const btn = document.createElement('button');
    btn.className = 'btn';
    btn.textContent = 'Привести';
    btn.addEventListener('click', () => {
      setShape({
        contours: shape.contours.map((x, i) => (i === ci ? applyPrimitive(x, match) : x)),
      });
      selection = new Set();
      ownEdit();
      history.push(shape);
      draw();
      updateEditPanel();
      say(`Контур ${ci + 1} приведён: ${match.name}.`);
    });
    row.append(what, err, btn);
    el.primList.append(row);
  });

  if (!found) {
    const none = document.createElement('div');
    none.className = 'prim-none';
    none.textContent = 'Ни один контур не похож на простую фигуру.';
    el.primList.append(none);
  }
}

function updateEditPanel() {
  const n = selection.size;
  el.selCount.textContent = n === 0 ? 'ничего не выделено'
    : `выделено узлов: ${n}`;
  for (const b of [el.edSmooth, el.edCorner, el.edDelete]) b.disabled = n === 0;
  el.edUndo.disabled = !history.canUndo;
  el.edRedo.disabled = !history.canRedo;
  renderPrimitives();
}

function applyToSelection(fn) {
  if (!selection.size || !shape) return;
  let next = shape;
  for (const k of selection) next = fn(next, parseKey(k));
  setShape(next);
  ownEdit();
  history.push(shape);
  draw();
  updateEditPanel();
}


el.edSmooth.addEventListener('click', () => applyToSelection((sh, at) => setNodeType(sh, at, 'smooth')));
el.edCorner.addEventListener('click', () => applyToSelection((sh, at) => setNodeType(sh, at, 'corner')));

el.edDelete.addEventListener('click', () => {
  if (!selection.size || !shape) return;
  setShape(removeNodes(shape, [...selection]));
  selection = new Set();
  ownEdit();
  history.push(shape);
  draw();
  updateEditPanel();
});

const stepHistory = (fn) => {
  const next = fn();
  if (!next) return;
  // Отмена — такая же запись контура, как правка: слой обязан её увидеть,
  // иначе экспорт отдаст то, что человек только что отменил.
  setShape(next);
  ownEdit();
  selection = new Set();
  draw();
  updateEditPanel();
};

el.edUndo.addEventListener('click', () => stepHistory(() => history.undo()));
el.edRedo.addEventListener('click', () => stepHistory(() => history.redo()));
el.retrace.addEventListener('click', () => {
  if (!window.confirm('Перетрассировать заново? Все правки контура пропадут.')) return;
  reattach();
});

// ─── проект ─────────────────────────────────────────────────────────────────

function currentState() {
  const src = store.get('source');
  const crop = store.get('crop');
  return {
    imageName: src?.name, crop: crop?.rect ?? null, route, params, colors,
    layers, exclusive, stroke: traceKind === 'assemble' ? 'assemble' : strokeTrace,
    glyphEdits: [...glyphEdits],
    phase, shape, text: el.textIn.value, codes,
    glyphCount: glyphs ? glyphs.glyphs.length : 0,
    manualGroups, guides, metrics,
    fontName: el.fontName.value, fontSample: el.fontSampleIn.value,
  };
}

/** Тихое автосохранение. Не удалось — работаем дальше, но говорим об этом. */
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    const src = store.get('source');
    if (!src) return;
    try {
      await saveLocal({ record: snapshot(currentState()), image: src.blob ?? null });
      el.prNote.textContent = `Сохранено в ${new Date().toLocaleTimeString('ru')}`;
      el.prNote.classList.remove('warn-text');
    } catch {
      el.prNote.textContent = 'Хранилище браузера недоступно — работа не сохраняется.';
      el.prNote.classList.add('warn-text');
    }
  }, 700);
}

/** Разложить сохранённые решения по местам. Глифы придут позже, их ждёт pending. */
async function applyRecord(rec, imageBlob) {
  if (imageBlob) await loadBlob(imageBlob, rec.imageName);
  Object.assign(params, rec.params);
  for (const c of CONTROLS) {
    const input = document.getElementById(`ctl-${c.key}`);
    if (input && params[c.key] !== undefined) input.value = params[c.key];
    if (c.type === 'select') continue;
    const row = input?.closest('.ctl')?.querySelector('.ctl-value');
    if (row) row.textContent = `${params[c.key]}${c.unit ?? ''}`;
  }
  paramsTouched = true;   // восстановленные настройки — уже решение человека
  colors.fg = rec.colors.fg;
  colors.bg = rec.colors.bg;
  updateSwatches();
  el.textIn.value = rec.text;
  el.fontName.value = rec.font.name;
  el.fontSampleIn.value = rec.font.sample || el.fontSampleIn.value;
  manualGroups = rec.manualGroups;
  if (rec.metrics) Object.assign(metrics, rec.metrics);

  pending = rec;
  if (rec.route !== route) setRoute(rec.route);

  if (rec.crop) {
    setRect(rec.crop);
    commitCrop(rec.crop);
    // Слои ставятся ПОСЛЕ кропа: он заводит свой единственный слой по догадке,
    // и сохранённые чернила должны его заменить, а не наоборот.
    if (rec.layers && rec.layers.length) {
      layers = rec.layers.map((L) => ({ ...L, fg: [...L.fg], shape: null }));
      layerSeq = Math.max(layerSeq, layers.length);
      active = 0;
      colors.fg = [...layers[0].fg];
      params.tolerance = layers[0].tolerance;
      if (tolSync) tolSync();
      exclusive = rec.exclusive !== false;
      el.layExclusive.checked = exclusive;
      traceKind = rec.stroke === 'assemble' ? 'assemble' : (rec.stroke ? 'stroke' : 'fill');
      strokeTrace = traceKind !== 'fill';
      for (const b of el.traceMode.querySelectorAll('button')) {
        b.classList.toggle('on', b.dataset.trace === traceKind);
      }
      el.strokeNote.hidden = traceKind !== 'stroke';
      el.assembleNote.hidden = traceKind !== 'assemble';
      updateSwatches();
      requestTrace();
    }
    if (rec.detachedShape) {
      setShape(rec.detachedShape);
      detach();
    }
  }
  say(rec.savedAt ? `Проект от ${new Date(rec.savedAt).toLocaleString('ru')} восстановлен.` : null);
}

el.prExport.addEventListener('click', async () => {
  const src = store.get('source');
  if (!src) { say('Нечего выгружать: картинка не открыта.', true); return; }
  const blob = await exportBundle(snapshot(currentState()), src.blob ?? null);
  download(blob, `пантограф-${new Date().toISOString().slice(0, 10)}.zip`);
  say('Проект выгружен одним файлом.');
});

el.prImportFile.addEventListener('change', async () => {
  const file = el.prImportFile.files[0];
  el.prImportFile.value = '';
  if (!file) return;
  try {
    const { record, imageBlob } = await importBundle(file);
    await applyRecord(record, imageBlob);
  } catch (err) {
    say(`Не удалось загрузить проект: ${err.message}`, true);
  }
});

/** Один файл: контур в координатах кропа, как и обещает панель шага. */
el.saveSvg.addEventListener('click', () => {
  const crop = store.get('crop');
  const live = layers.filter((L) => L.visible && L.shape && L.shape.contours.length);
  if (!live.length || !crop) { say('Сначала нужен контур.', true); return; }
  const src = store.get('source');
  const base = (src && src.name ? src.name.split('/').pop().replace(/\.[^.]+$/, '') : 'контур');
  // Сборка уходит настоящими примитивами; несколько слоёв сборкой — по
  // очереди в одном файле пока не собираются, честно отдаём кривые.
  const asmLayer = traceKind === 'assemble' && live.length === 1 && live[0].assembly ? live[0] : null;
  const doc = asmLayer
    ? toAssemblySvg(asmLayer.assembly, { width: crop.imageData.width, height: crop.imageData.height })
    : toLayeredSvg(live, {
      width: crop.imageData.width,
      height: crop.imageData.height,
      colored: fillMode === 'color',
    });
  download(new Blob([doc], { type: 'image/svg+xml' }), `${base}.svg`);
  if (asmLayer) {
    say(`Сохранён ${base}.svg — сборка: примитивов ${asmLayer.assembly.parts.length}, `
      + `толщина штриха ${asmLayer.assembly.width.toFixed(1)} px.`);
    return;
  }
  const nodes = live.reduce((a, L) => a + L.shape.contours.reduce((b, c) => b + c.nodes.length, 0), 0);
  say(`Сохранён ${base}.svg — ${live.length > 1 ? `слоёв ${live.length}, ` : ''}`
    + `контуров ${live.reduce((a, L) => a + L.shape.contours.length, 0)}, узлов ${nodes}.`);
});

el.traceMode.addEventListener('click', (ev) => {
  const btn = ev.target instanceof Element && ev.target.closest('button[data-trace]');
  if (!btn) return;
  traceKind = btn.dataset.trace;
  strokeTrace = traceKind !== 'fill';
  for (const b of el.traceMode.querySelectorAll('button')) b.classList.toggle('on', b === btn);
  el.strokeNote.hidden = traceKind !== 'stroke';
  el.assembleNote.hidden = traceKind !== 'assemble';
  // Ход трассировки сменился — прежние правки к новому контуру не относятся.
  if (phase === 'detached') reattach();
  selection = new Set();
  requestTrace();
  scheduleSave();
});

// Выбор заливки помнится между сохранениями: он про привычку, а не про кроп.
el.fillMode.addEventListener('click', (ev) => {
  const btn = ev.target instanceof Element && ev.target.closest('button[data-fill]');
  if (!btn) return;
  fillMode = btn.dataset.fill;
  for (const b of el.fillMode.querySelectorAll('button')) b.classList.toggle('on', b === btn);
  localStorage.setItem('pantograph.fill', fillMode);
});

/** Пакет SVG: по файлу на букву, названный самой буквой. */
el.prPack.addEventListener('click', async () => {
  const crop = store.get('crop');
  if (!glyphs || !crop) { say('Сначала нужен разбор на буквы.', true); return; }
  const used = new Map();
  const files = glyphs.glyphs.map((g, i) => {
    const ch = label(codes[i]);
    const base = ch ? `${ch}-${(codes[i]).toString(16).toUpperCase().padStart(4, '0')}`
      : `буква-${String(i + 1).padStart(2, '0')}`;
    const n = (used.get(base) ?? 0) + 1;
    used.set(base, n);
    const name = n > 1 ? `${base}(${n}).svg` : `${base}.svg`;
    const local = translateShape(g.shape, -g.bbox.x, -g.bbox.y);
    return {
      name,
      data: toSvgDocument(local, { width: g.bbox.w, height: g.bbox.h }),
    };
  });
  download(await makeZip(files), 'буквы-svg.zip');
  say(`Сохранён пакет из ${files.length} файлов.`);
});

function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  URL.revokeObjectURL(url);
}

// ─── настройки ──────────────────────────────────────────────────────────────

/**
 * Построить панель настроек под заданный масштаб кропа.
 * Перестраивается заново при новом кропе: у мастера в тысячу пикселей и
 * ползунки должны быть другими, а не только их значения.
 */
/**
 * Подогнать допуски под маршрут и размер кропа.
 *
 * Единица формы разная: в иконочном маршруте это весь кроп, в шрифтовом —
 * отдельная буква, и соразмерность там считается внутри buildGlyphs. Поэтому
 * пересчитывать надо не только при новом кропе, но и при смене маршрута:
 * кроп обычно делают ещё в иконочном режиме, а потом переключаются на шрифт —
 * и допуск, рассчитанный на лист целиком, съедал все буквы разом.
 *
 * Если человек уже крутил ползунки — не лезем.
 */
let ctlFactor = 1;   // под какой фактор построена панель — пределы ползунков

function retuneParams(force = false) {
  const crop = store.get('crop');
  if (!crop) return;
  const factor = route === 'font'
    ? 1
    : sizeFactor(crop.imageData.width, crop.imageData.height);
  if (!paramsTouched || force) {
    // Значения — раньше панели: иначе ползунок строится со старым значением,
    // браузер зажимает его к новому пределу, и панель показывает не то,
    // что считается.
    for (const c of scaleControls(factor)) params[c.key] = c.value;
    primShare = 0.03;
    paramsTouched = false;
    ctlFactor = factor;
  }
  // Панель перестраивается ВСЕГДА, даже когда значения не трогаем: группы
  // разложены по маршрутам, и без перестройки «Кривые» оставались в панели
  // другого маршрута — на «Буквах» пропадала «Точность» со товарищи.
  buildControls(ctlFactor);
}

function buildControls(factor = 1) {
  // Настройки живут рядом с тем, на что влияют: цвет и маска — на шаге «Маска»,
  // кривые — там, где виден их результат.
  const boxes = {
    Цвет: el.controlsMask,
    Маска: el.controlsMask,
    Симметрия: el.controlsMask,
    Кривые: route === 'font' ? el.controlsCurvesFont : el.controlsCurves,
  };
  for (const box of new Set(Object.values(boxes))) box.replaceChildren();
  el.controlsCurves.replaceChildren();
  el.controlsCurvesFont.replaceChildren();

  const scaled = scaleControls(factor);
  const byKey = new Map(scaled.map((c) => [c.key, c]));

  for (const name of groups()) {
    const host = boxes[name];
    if (!host) continue;
    const box = document.createElement('details');
    box.open = true;
    const head = document.createElement('summary');
    head.textContent = name;
    box.append(head);

    for (const base of CONTROLS.filter((x) => x.group === name)) {
      if (base.routes && !base.routes.includes(route)) continue;
      const c = byKey.get(base.key) ?? base;
      const row = document.createElement('div');
      row.className = 'ctl';

      const label = document.createElement('label');
      label.textContent = c.label;
      label.htmlFor = `ctl-${c.key}`;

      const head2 = document.createElement('div');
      head2.className = 'ctl-head';
      head2.append(label);
      if (c.hint) head2.append(hintButton(c.hint));

      const value = document.createElement('span');
      value.className = 'ctl-value';

      if (c.type === 'check') {
        const wrap = document.createElement('label');
        wrap.className = 'check';
        const box2 = document.createElement('input');
        box2.type = 'checkbox';
        box2.id = `ctl-${c.key}`;
        box2.checked = params[c.key] !== false;
        box2.addEventListener('change', () => {
          params[c.key] = box2.checked;
          paramsTouched = true;
          requestTrace();
          scheduleSave();
        });
        wrap.append(box2, document.createTextNode(` ${c.label}`));
        if (c.hint) wrap.append(hintButton(c.hint));
        row.append(wrap);
        box.append(row);
        continue;
      }

      if (c.type === 'select') {
        const sel = document.createElement('select');
        sel.className = 'pick';
        sel.id = `ctl-${c.key}`;
        for (const [val, text] of c.options) {
          const o = document.createElement('option');
          o.value = val;
          o.textContent = text;
          sel.append(o);
        }
        sel.value = params[c.key];
        sel.addEventListener('change', () => {
          params[c.key] = sel.value;
          paramsTouched = true;
          requestTrace();
          scheduleSave();
        });
        row.append(head2, value, sel);
        box.append(row);
        continue;
      }

      const input = document.createElement('input');
      input.type = 'range';
      input.id = `ctl-${c.key}`;
      input.min = c.min; input.max = c.max; input.step = c.step;
      input.value = params[c.key];

      const show = () => {
        const v = params[c.key];
        value.textContent = `${Number.isInteger(v) ? v : v.toFixed(2)}${c.unit ?? ''}`;
      };
      show();

      // Допуск — единственная настройка слоя, а не кропа: ползунок правит
      // активный слой, а при переключении слоя перечитывается с него.
      if (c.key === 'tolerance') tolSync = () => { input.value = params.tolerance; show(); };

      input.addEventListener('input', () => {
        params[c.key] = Number(input.value);
        if (c.key === 'tolerance' && cur()) cur().tolerance = params.tolerance;
        paramsTouched = true;
        show();
        requestTrace();
        scheduleSave();
      });

      row.append(head2, value, input);
      box.append(row);
    }
    host.append(box);
  }
}

// ─── пипетка ────────────────────────────────────────────────────────────────

// Пиксели берём из того же массива, который лежит на столе: на шаге «Картинка»
// это исходник, дальше — кроп. Иначе координаты указателя, приходящие в системе
// кропа, читались бы по исходнику — и цвет прилетал бы из другого места
// картинки, тем дальше, чем дальше кроп от левого верхнего угла.
let srcPixels = null;
let srcPixelsFor = null;

function pixelPlane() {
  const src = store.get('source');
  const crop = store.get('crop');
  if (step !== 'image' && crop) return crop.imageData;
  if (!src) return null;
  if (srcPixelsFor !== src.bitmap) {
    srcPixels = cropFrom(src.bitmap, { x: 0, y: 0, w: src.w, h: src.h });
    srcPixelsFor = src.bitmap;
  }
  return srcPixels;
}

function colorUnder(ev) {
  const img = pixelPlane();
  if (!img) return null;
  const box = el.overlay.getBoundingClientRect();
  const p = viewport.toImage({ x: ev.clientX - box.left, y: ev.clientY - box.top });
  const x = Math.round(p.x);
  const y = Math.round(p.y);
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return null;
  return sampleColor(img, x, y, 1);
}

// Лупа у курсора: цвет виден ДО клика. Без неё в тонкий штрих не прицелиться —
// особенно на двухтоновой иконке, где промах меняет весь разбор.
let lens = null;

function moveLens(ev) {
  if (!lens) {
    lens = document.createElement('div');
    lens.className = 'lens';
    const sw = document.createElement('span');
    sw.className = 'lens-swatch';
    const lb = document.createElement('span');
    lb.className = 'lens-label';
    lens.append(sw, lb);
    document.body.append(lens);
  }
  const c = colorUnder(ev);
  const flipX = ev.clientX > window.innerWidth - 170;
  lens.style.left = `${ev.clientX + (flipX ? -18 : 18)}px`;
  lens.style.top = `${ev.clientY + (ev.clientY > window.innerHeight - 70 ? -46 : 22)}px`;
  lens.style.transform = flipX ? 'translateX(-100%)' : '';
  lens.firstElementChild.style.background = c ? rgb(c) : 'transparent';
  lens.lastElementChild.textContent = c ? `${c[0]}, ${c[1]}, ${c[2]}` : '—';
}

function hideLens() {
  if (lens) { lens.remove(); lens = null; }
}

// Цель пипетки — 'bg' либо id слоя: чернил на кропе может быть несколько,
// и у каждого своя строка со своей пипеткой.
function setPick(mode) {
  pickMode = pickMode === mode ? null : mode;
  el.pickBg.classList.toggle('picking', pickMode === 'bg');
  el.overlay.classList.toggle('picking', Boolean(pickMode));
  el.stage.classList.toggle('picking', Boolean(pickMode));
  if (!pickMode) hideLens();
  renderLayers();
  const L = pickMode && layers.find((x) => x.id === pickMode);
  say(pickMode
    ? `Щёлкните по картинке: берём цвет ${pickMode === 'bg' ? 'фона' : `«${L ? L.name : 'слоя'}»`}.`
      + ' Esc — отмена.'
    : null);
}

el.pickBg.addEventListener('click', () => setPick('bg'));

el.stage.addEventListener('pointermove', (ev) => {
  if (pickMode && !el.stage.hidden) moveLens(ev);
});
el.stage.addEventListener('pointerleave', hideLens);

// Правая кнопка отменяет — привычка из любой пипетки.
el.stage.addEventListener('contextmenu', (ev) => {
  if (!pickMode) return;
  ev.preventDefault();
  setPick(null);
});

// Перехват на родителе в фазе погружения: иначе инструмент кропа,
// подписанный на самом оверлее, успеет начать рисовать рамку.
el.stage.addEventListener('pointerdown', (ev) => {
  if (!pickMode || el.stage.hidden || ev.button !== 0) return;
  // Переключатель подложки лежит на столе, но кнопкой быть не перестаёт.
  if (ev.target instanceof Element && ev.target.closest('.stage-seg')) return;
  ev.stopPropagation();
  ev.preventDefault();
  const mode = pickMode;           // setPick(null) ниже обнуляет режим
  const c = colorUnder(ev);
  setPick(null);
  if (!c) { say('Мимо картинки — цвет не взят.', true); return; }
  if (mode === 'bg') {
    colors.bg = c;
  } else {
    const L = layers.find((x) => x.id === mode);
    if (!L) return;
    L.fg = c;
    if (L === cur()) colors.fg = c;
  }
  updateSwatches();
  requestTrace();
}, true);

// ─── переключатели показа ───────────────────────────────────────────────────

el.bgMode.addEventListener('click', (ev) => {
  const btn = ev.target.closest('button[data-mode]');
  if (!btn) return;
  bgMode = btn.dataset.mode;
  for (const b of el.bgMode.querySelectorAll('button')) b.classList.toggle('on', b === btn);
  draw();
});

for (const box of [el.showFill, el.showNodes]) {
  box.addEventListener('change', () => draw());
}

el.tileZoom.addEventListener('input', () => {
  const v = Number(el.tileZoom.value);
  el.tileZoomVal.textContent = v > 0 ? `×${v}` : 'авто';
  renderGlyphGrid();
});

el.sampleSize.addEventListener('input', () => {
  el.sampleSizeVal.textContent = `${el.sampleSize.value} px`;
  el.fontSample.style.fontSize = `${el.sampleSize.value}px`;
});

// ─── зум, панорама, клавиатура ──────────────────────────────────────────────

const ZOOM_STEP = 1.25;

// Стол — единственное, что зумится; на шагах без него группа скрыта.
const stageLive = () => !el.stage.hidden && Boolean(store.get('source'));

el.zoomIn.addEventListener('click', () => { if (stageLive()) viewport.zoomBy(ZOOM_STEP); });
el.zoomOut.addEventListener('click', () => { if (stageLive()) viewport.zoomBy(1 / ZOOM_STEP); });
el.zoom1.addEventListener('click', () => { if (stageLive()) viewport.setScale(1); });
el.fit.addEventListener('click', () => { if (stageLive()) viewport.fit(); });

el.stage.addEventListener('wheel', (ev) => {
  if (!stageLive()) return;
  ev.preventDefault();
  const box = el.overlay.getBoundingClientRect();
  viewport.zoomAt(
    { x: ev.clientX - box.left, y: ev.clientY - box.top },
    ev.deltaY < 0 ? ZOOM_STEP : 1 / ZOOM_STEP,
  );
}, { passive: false });

// Панорама: средняя кнопка или Shift+перетаскивание. Перехват на погружении —
// иначе кроп и редактор, подписанные на оверлее, успеют начать своё.
let panFrom = null;
el.stage.addEventListener('pointerdown', (ev) => {
  if (!stageLive()) return;
  if (ev.button !== 1 && !(ev.button === 0 && ev.shiftKey)) return;
  ev.preventDefault();
  ev.stopPropagation();
  panFrom = { x: ev.clientX, y: ev.clientY };
  // Захват не обязателен: без него панорама просто оборвётся за краем стола.
  try { el.stage.setPointerCapture(ev.pointerId); } catch { /* указателя уже нет */ }
}, true);

el.stage.addEventListener('pointermove', (ev) => {
  if (!panFrom) return;
  viewport.panBy(ev.clientX - panFrom.x, ev.clientY - panFrom.y);
  panFrom = { x: ev.clientX, y: ev.clientY };
});

const endPan = (ev) => {
  if (!panFrom) return;
  panFrom = null;
  try {
    if (el.stage.hasPointerCapture(ev.pointerId)) el.stage.releasePointerCapture(ev.pointerId);
  } catch { /* захвата не было */ }
};
el.stage.addEventListener('pointerup', endPan);
el.stage.addEventListener('pointercancel', endPan);

// Клавиатура молчит, пока человек набирает текст: иначе «0» в поле пробы пера
// вписывал бы картинку вместо цифры.
const typing = () => {
  const a = document.activeElement;
  if (!a) return false;
  const tag = a.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || a.isContentEditable;
};

window.addEventListener('keydown', (ev) => {
  if (ev.key === 'Escape') {
    if (pickMode) { setPick(null); return; }
    if (selection.size) { selection = new Set(); draw(); updateEditPanel(); return; }
    if (glyphEdit >= 0) { leaveGlyphEdit(); return; }
    if (glyphSel.size) { glyphSel = new Set(); renderGlyphGrid(); }
    return;
  }
  if (typing() || ev.ctrlKey || ev.metaKey || ev.altKey) {
    if ((ev.ctrlKey || ev.metaKey) && !typing() && ev.key.toLowerCase() === 'z') {
      ev.preventDefault();
      stepHistory(() => (ev.shiftKey ? history.redo() : history.undo()));
    }
    return;
  }
  if (ev.key === 'Delete' || ev.key === 'Backspace') {
    if ((step === 'contour' || glyphEdit >= 0) && selection.size) {
      ev.preventDefault();
      el.edDelete.click();
    }
    return;
  }
  if (!stageLive()) return;
  if (ev.key === '0') { ev.preventDefault(); viewport.fit(); }
  else if (ev.key === '1') { ev.preventDefault(); viewport.setScale(1); }
  else if (ev.key === '+' || ev.key === '=') { ev.preventDefault(); viewport.zoomBy(ZOOM_STEP); }
  else if (ev.key === '-') { ev.preventDefault(); viewport.zoomBy(1 / ZOOM_STEP); }
});

// ─── запуск ─────────────────────────────────────────────────────────────────

// Удобство разработки: ?img=путь-к-картинке переживает перезагрузку страницы
// и имеет преимущество перед сохранённым проектом.
const preload = new URLSearchParams(location.search).get('img');
if (preload) {
  fetch(preload)
    .then((r) => (r.ok ? r.blob() : Promise.reject(new Error(String(r.status)))))
    .then((b) => loadBlob(b, preload))
    .catch(() => say(`Не удалось загрузить «${preload}».`, true));
} else {
  loadLocal()
    .then((saved) => {
      if (!saved?.record) return;
      return applyRecord(restore(saved.record), saved.image);
    })
    .catch(() => { /* хранилища нет — начинаем с чистого листа */ });
}

buildControls();
installHints();
setStep('image');

createSplitter({
  el: el.splitter,
  host: el.main,
  toggle: el.panelToggle,
  deflt: 340,
  onResize: () => {
    // Панель поехала — превью кропа и сетка букв считают свой масштаб заново.
    syncViewSize();
    draw();
    if (glyphs && step === 'glyphs') renderGlyphGrid();
  },
});

updateSwatches();
updateEditPanel();
updateGlyphButtons();
el.sampleSizeVal.textContent = `${el.sampleSize.value} px`;
el.fontSample.style.fontSize = `${el.sampleSize.value}px`;

viewport.onChange(draw);
new ResizeObserver(() => { syncViewSize(); draw(); }).observe(el.stage);
store.subscribe('source', draw);
draw();
