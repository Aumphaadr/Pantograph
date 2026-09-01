// ui/guidesTool.js — четыре направляющие, которые тянет человек.
//
// Базовую линию и высоты из картинки надёжно не вывести: догадка по габаритам
// букв даёт приемлемое начало, но последнее слово за глазом. Поэтому тянутся
// мышью, а не вычисляются.
//
// Координаты указателя переводятся в crop-пространство первой же строчкой.

import { normalizeGuides } from '../glyphs/metrics.js';

export const LINES = [
  { key: 'capHeight', label: 'прописные' },
  { key: 'xHeight', label: 'строчные' },
  { key: 'baseline', label: 'базовая' },
  { key: 'descender', label: 'выносные' },
];

const HIT_PX = 7;

export function createGuidesTool({ el, viewport, get, set, isEnabled }) {
  let drag = null;
  let hover = null;

  const toCrop = (ev) => {
    const box = el.getBoundingClientRect();
    return viewport.toImage({ x: ev.clientX - box.left, y: ev.clientY - box.top });
  };

  function pick(y) {
    const { guides } = get();
    if (!guides) return null;
    const tol = viewport.toImageLen(HIT_PX);
    let best = null;
    for (const { key } of LINES) {
      const d = Math.abs(guides[key] - y);
      if (d <= tol && (!best || d < best.d)) best = { key, d };
    }
    return best && best.key;
  }

  el.addEventListener('pointerdown', (ev) => {
    if (!isEnabled() || ev.button !== 0 || ev.shiftKey) return;
    const key = pick(toCrop(ev).y);
    if (!key) return;
    drag = key;
    try { el.setPointerCapture(ev.pointerId); } catch { /* синтетика */ }
    ev.preventDefault();
    ev.stopPropagation();
  }, true);

  el.addEventListener('pointermove', (ev) => {
    if (!isEnabled()) return;
    const p = toCrop(ev);
    if (!drag) {
      const next = pick(p.y);
      if (next !== hover) { hover = next; set({}); }
      if (next) el.style.cursor = 'ns-resize';
      return;
    }
    const { guides } = get();
    set({ guides: normalizeGuides({ ...guides, [drag]: p.y }) });
  }, true);

  for (const type of ['pointerup', 'pointercancel']) {
    el.addEventListener(type, (ev) => {
      if (!drag) return;
      drag = null;
      try { el.releasePointerCapture(ev.pointerId); } catch { /* уже отпущен */ }
      set({});
    }, true);
  }

  return {
    get hover() { return hover; },
    get dragging() { return drag; },
    clearHover() { hover = null; },
  };
}
