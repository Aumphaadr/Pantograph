// ui/viewport.js — ЕДИНСТВЕННОЕ место, знающее про экранные координаты.
// Инвариант 4: ни один модуль логики не видит ни зума, ни панорамы, ни CSS-пикселей.
//
// Преобразование: screen = image * scale + t

import { fitScale } from '../core/geom.js';

const MIN_SCALE = 0.05;
const MAX_SCALE = 64;

export function createViewport() {
  let scale = 1;
  let tx = 0;
  let ty = 0;
  let view = { w: 1, h: 1 };       // размер окна просмотра, css-пиксели
  let content = { w: 0, h: 0 };    // размер картинки, image-пиксели

  const listeners = new Set();
  const changed = () => { for (const fn of [...listeners]) fn(); };

  const clampScale = (s) => Math.max(MIN_SCALE, Math.min(MAX_SCALE, s));

  return {
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },

    get state() { return { scale, tx, ty, view: { ...view }, content: { ...content } }; },
    get scale() { return scale; },

    setViewSize(w, h) { view = { w, h }; },
    setContentSize(w, h) { content = { w, h }; },

    /** Экран → image. Единственный законный вход для координат указателя. */
    toImage(sp) { return { x: (sp.x - tx) / scale, y: (sp.y - ty) / scale }; },

    /** image → экран. Для рисования оверлея. */
    toScreen(ip) { return { x: ip.x * scale + tx, y: ip.y * scale + ty }; },

    /** Длина из image в экранную и обратно — нужно для допусков попадания. */
    toScreenLen(len) { return len * scale; },
    toImageLen(len) { return len / scale; },

    fit(pad = 32) {
      scale = clampScale(fitScale(content, view, pad));
      tx = (view.w - content.w * scale) / 2;
      ty = (view.h - content.h * scale) / 2;
      changed();
    },

    /** Вписать прямоугольник (в image-координатах) в окно с полями. */
    fitRect(r, pad = 32) {
      const s = clampScale(Math.min(
        (view.w - pad * 2) / Math.max(1, r.w),
        (view.h - pad * 2) / Math.max(1, r.h),
      ));
      scale = s;
      tx = (view.w - r.w * s) / 2 - r.x * s;
      ty = (view.h - r.h * s) / 2 - r.y * s;
      changed();
    },

    /** Зум с сохранением точки под курсором. */
    zoomAt(sp, factor) {
      const before = this.toImage(sp);
      const next = clampScale(scale * factor);
      if (next === scale) return;
      scale = next;
      tx = sp.x - before.x * scale;
      ty = sp.y - before.y * scale;
      changed();
    },

    /** Зум в центр окна — для кнопок и клавиатуры. */
    zoomBy(factor) {
      this.zoomAt({ x: view.w / 2, y: view.h / 2 }, factor);
    },

    setScale(s) {
      this.zoomBy(clampScale(s) / scale);
    },

    panBy(dx, dy) { tx += dx; ty += dy; changed(); },

    /** Матрица для canvas.setTransform, с поправкой на плотность пикселей. */
    canvasTransform(dpr) { return [scale * dpr, 0, 0, scale * dpr, tx * dpr, ty * dpr]; },
  };
}
