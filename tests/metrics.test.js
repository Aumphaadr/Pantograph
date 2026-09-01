import {
  median, guessGuides, normalizeGuides, scaleFor, toGlyphSpace,
  measureGaps, guessSpacing, buildGlyph, fontMetrics, DEFAULTS,
} from '../js/glyphs/metrics.js';
import { node, contourArea, bounds, flatten } from '../js/core/path.js';

const P = (x, y) => ({ x, y });

/** Прямоугольный контур в crop-пространстве, обход по часовой. */
const rect = (x, y, w, h) => ({
  contours: [{
    closed: true,
    nodes: [
      node(P(x, y), P(x, y), P(x, y), 'corner'),
      node(P(x + w, y), P(x + w, y), P(x + w, y), 'corner'),
      node(P(x + w, y + h), P(x + w, y + h), P(x + w, y + h), 'corner'),
      node(P(x, y + h), P(x, y + h), P(x, y + h), 'corner'),
    ],
  }],
});

const glyph = (x, y, w, h, row = 0) => ({
  index: 0, row, bbox: { x, y, w, h }, shape: rect(x, y, w, h),
});

// ─── медиана ────────────────────────────────────────────────────────────────

test('median берёт середину и переживает пустоту', () => {
  eq(median([3, 1, 2]), 2);
  eq(median([4, 1, 3, 2]), 2.5);
  eq(median([]), 0);
});

// ─── догадка о направляющих ─────────────────────────────────────────────────

test('базовая линия — медиана низов, выносные её не утаскивают', () => {
  // три буквы стоят на 40, одна свисает до 48
  const g = [glyph(0, 10, 8, 30), glyph(10, 10, 8, 30), glyph(20, 10, 8, 30), glyph(30, 10, 8, 38)];
  const gu = guessGuides(g);
  eq(gu.baseline, 40);
  eq(gu.descender, 48, 'глубина выносных — самый нижний низ');
});

test('строчные и прописные разделяются по разрыву в верхах', () => {
  const g = [glyph(0, 10, 8, 30), glyph(10, 10, 8, 30), glyph(20, 22, 8, 18), glyph(30, 22, 8, 18)];
  const gu = guessGuides(g);
  eq([gu.capHeight, gu.xHeight, gu.baseline], [10, 22, 40]);
});

test('когда все буквы одного роста, строчная ставится по соотношению', () => {
  const g = [glyph(0, 10, 8, 30), glyph(10, 10, 8, 30), glyph(20, 10, 8, 30)];
  const gu = guessGuides(g);
  eq([gu.capHeight, gu.baseline], [10, 40]);
  eq(gu.xHeight > gu.capHeight && gu.xHeight < gu.baseline, true,
    `строчная ${gu.xHeight} между прописной и базовой, а не слипается с ними`);
});

test('пустой набор не роняет догадку', () => {
  const g = guessGuides([]);
  eq([g.baseline, g.xHeight, g.capHeight, g.descender], [0, 0, 0, 0]);
  eq(g.rows.size, 0);
});

test('у каждой строки своя базовая линия', () => {
  // Два ряда: верхний стоит на 40, нижний на 140
  const list = [glyph(0, 10, 8, 30, 0), glyph(12, 10, 8, 30, 0),
    glyph(0, 110, 8, 30, 1), glyph(12, 110, 8, 30, 1)];
  const g = guessGuides(list);
  eq(g.rows.get(0), 40);
  eq(g.rows.get(1), 140);
});

test('высоты считаются от своей строки, а не от общей медианы', () => {
  // Без этого на листе из шести рядов «глубина выносных» становится
  // расстоянием до нижнего ряда.
  const rows = [];
  for (let r = 0; r < 6; r += 1) {
    for (let i = 0; i < 5; i += 1) rows.push(glyph(i * 12, 10 + r * 100, 8, 30, r));
  }
  rows.push(glyph(70, 10, 8, 38, 0));   // выносной элемент в первой строке
  const g = guessGuides(rows);
  eq(g.descender - g.baseline, 8, `глубина выносных ${g.descender - g.baseline}, а не сотни`);
});

test('эталоном берётся самая населённая строка', () => {
  const list = [glyph(0, 10, 8, 30, 0),
    glyph(0, 110, 8, 30, 1), glyph(12, 110, 8, 30, 1), glyph(24, 110, 8, 30, 1)];
  eq(guessGuides(list).baseline, 140, 'базовая — от строки с тремя буквами');
});

test('буквы разных строк садятся на общий ноль в единицах шрифта', () => {
  const list = [glyph(0, 10, 8, 30, 0), glyph(0, 110, 8, 30, 1)];
  const g = normalizeGuides(guessGuides(list));
  const lows = list.map((x) => Math.round(bounds(buildGlyph(x, g).shape).y));
  eq(lows, [0, 0], `низы ${lows.join(', ')} — обе строки на базовой`);
});

test('normalizeGuides выправляет перепутанный порядок', () => {
  const g = normalizeGuides({ capHeight: 50, xHeight: 5, baseline: 40, descender: 20 });
  eq(g.capHeight < g.baseline, true, 'прописные выше базовой');
  eq(g.xHeight >= g.capHeight && g.xHeight < g.baseline, true, 'строчные между ними');
  eq(g.descender >= g.baseline, true, 'выносные не выше базовой');
});

// ─── перевод ────────────────────────────────────────────────────────────────

const guides = { capHeight: 10, xHeight: 22, baseline: 40, descender: 48 };

test('множитель считается от высоты прописных', () => {
  eq(scaleFor(guides), 700 / 30);
  eq(scaleFor({ ...guides, capHeight: 40 }), 1, 'вырожденные направляющие не делят на ноль');
});

test('ось Y переворачивается: базовая линия становится нулём', () => {
  const out = toGlyphSpace(rect(0, 10, 8, 30), guides);
  const b = bounds(out);
  eq(Math.round(b.y), 0, 'низ буквы лёг на базовую линию');
  eq(Math.round(b.y + b.h), 700, 'верх — на высоту прописных');
});

test('выносной элемент уходит ниже нуля', () => {
  const out = toGlyphSpace(rect(0, 10, 8, 38), guides);
  eq(bounds(out).y < 0, true, `низ ${bounds(out).y.toFixed(0)} под базовой линией`);
});

test('переворот Y сам меняет обход на тот, что ждёт CFF', () => {
  const before = contourArea(rect(0, 10, 8, 30).contours[0]);
  const after = contourArea(toGlyphSpace(rect(0, 10, 8, 30), guides).contours[0]);
  eq(before > 0, true, 'в кропе внешний контур по часовой');
  eq(after < 0, true, 'в шрифте — против, пересчитывать обход не надо');
});

test('начало координат уезжает к левому краю буквы плюс отступ', () => {
  const out = toGlyphSpace(rect(25, 10, 8, 30), guides, { originX: 25, lsb: 40 });
  eq(Math.round(bounds(out).x), 40);
});

// ─── ширины ─────────────────────────────────────────────────────────────────

test('зазоры меряются только между соседями одной строки', () => {
  const g = [glyph(0, 10, 10, 30, 0), glyph(14, 10, 10, 30, 0), glyph(0, 60, 10, 30, 1)];
  eq(measureGaps(g), [4], 'через строку зазор не считается');
});

test('боковой отступ — половина медианного зазора', () => {
  const g = [glyph(0, 10, 10, 30), glyph(20, 10, 10, 30), glyph(40, 10, 10, 30)];
  const sp = guessSpacing(g, guides);
  eq(sp.sideBearing, Math.round(5 * scaleFor(guides)));
});

test('широкие зазоры распознаются как пробелы', () => {
  // «АБ ВГ»: три обычных зазора по 4 и один широкий 30
  const g = [glyph(0, 10, 10, 30), glyph(14, 10, 10, 30),
    glyph(58, 10, 10, 30), glyph(72, 10, 10, 30)];
  const sp = guessSpacing(g, guides);
  eq(sp.spaceUnits, Math.round(34 * scaleFor(guides)), `ширина пробела ${sp.spaceUnits}`);
});

test('без широких зазоров ширина пробела берётся из умолчаний', () => {
  const g = [glyph(0, 10, 10, 30), glyph(14, 10, 10, 30)];
  eq(guessSpacing(g, guides).spaceUnits, DEFAULTS.spaceUnits);
});

// ─── сборка глифа ───────────────────────────────────────────────────────────

test('buildGlyph считает ширину как тело плюс два отступа', () => {
  const k = scaleFor(guides);
  const b = buildGlyph(glyph(25, 10, 12, 30), guides, { sideBearing: 40 });
  eq(b.advance, Math.round(12 * k + 80));
  eq(b.lsb, 40);
  eq(Math.round(b.bbox.x), 40, 'тело начинается после левого отступа');
});

test('все буквы садятся на одну базовую линию', () => {
  // Разной высоты и в разных местах кропа — но низ у всех на 40.
  const list = [glyph(0, 10, 8, 30), glyph(20, 22, 8, 18), glyph(40, 16, 8, 24)];
  const lows = list.map((g) => Math.round(bounds(buildGlyph(g, guides).shape).y));
  eq(lows, [0, 0, 0], `низы ${lows.join(', ')} — ни одна не пляшет`);
});

// ─── метрики шрифта ─────────────────────────────────────────────────────────

test('fontMetrics переводит направляющие в единицы шрифта', () => {
  const m = fontMetrics(guides);
  eq(m.upm, 1000);
  eq(m.capHeight, 700);
  eq(m.xHeight, Math.round(18 * scaleFor(guides)));
  eq(m.descender < 0, true, 'глубина выносных отрицательна, как в таблицах шрифта');
  eq(m.ascender > m.capHeight, true, 'восходящая выше прописных, иначе строки слипнутся');
});

test('высота прописных задаётся настройкой', () => {
  eq(fontMetrics(guides, { capUnits: 500 }).capHeight, 500);
});
