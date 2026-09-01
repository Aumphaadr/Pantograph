// ui/cropTool.js — прямоугольное выделение: рисование, перенос, ручки.
//
// События указателя приходят в экранных координатах и переводятся в image
// ПРЯМО НА ГРАНИЦЕ, первой же строчкой. Дальше внутри — только image-пространство.

import {
  normRect, roundRect, clipRect, moveRect, resizeRect, hitHandle, pointInRect,
} from '../core/geom.js';

const HANDLE_TOL_PX = 9;   // допуск попадания по ручке, экранные пиксели
const MIN_SIDE = 2;        // меньше двух пикселей — это промах, а не кроп

const CURSORS = {
  nw: 'nwse-resize', se: 'nwse-resize',
  ne: 'nesw-resize', sw: 'nesw-resize',
  n: 'ns-resize', s: 'ns-resize',
  e: 'ew-resize', w: 'ew-resize',
};

export function createCropTool({ el, viewport, getBounds, getRect, onChange, onCommit, isEnabled = () => true }) {
  let drag = null;

  const toImage = (ev) => {
    const box = el.getBoundingClientRect();
    return viewport.toImage({ x: ev.clientX - box.left, y: ev.clientY - box.top });
  };

  const tol = () => viewport.toImageLen(HANDLE_TOL_PX);

  function cursorFor(p) {
    const rect = getRect();
    if (!rect) return 'crosshair';
    const h = hitHandle(rect, p, tol());
    if (h) return CURSORS[h];
    return pointInRect(rect, p) ? 'move' : 'crosshair';
  }

  function onPointerDown(ev) {
    if (!isEnabled()) return;
    if (ev.button !== 0 || ev.shiftKey) return;   // ЛКМ без модификаторов; остальное — панорама
    const bounds = getBounds();
    if (!bounds) return;
    const p = toImage(ev);
    const rect = getRect();

    if (rect) {
      const handle = hitHandle(rect, p, tol());
      if (handle) drag = { kind: 'resize', handle };
      else if (pointInRect(rect, p)) drag = { kind: 'move', from: p, start: rect };
    }
    if (!drag) drag = { kind: 'draw', anchor: p };

    try { el.setPointerCapture(ev.pointerId); } catch { /* указатель уже не наш */ }
    ev.preventDefault();
    apply(p);
  }

  function onPointerMove(ev) {
    if (!isEnabled()) return;
    if (!drag) {
      el.style.cursor = getBounds() ? cursorFor(toImage(ev)) : 'default';
      return;
    }
    apply(toImage(ev));
  }

  function apply(p) {
    const bounds = getBounds();
    const rect = getRect();
    let next;

    if (drag.kind === 'draw') {
      next = clipRect(normRect(drag.anchor, p), bounds);
    } else if (drag.kind === 'move') {
      next = moveRect(drag.start, p.x - drag.from.x, p.y - drag.from.y, bounds);
    } else {
      next = resizeRect(rect, drag.handle, p, bounds);
    }
    onChange(roundRect(next));
  }

  function onPointerUp(ev) {
    if (!drag) return;
    const wasDraw = drag.kind === 'draw';
    drag = null;
    try { el.releasePointerCapture(ev.pointerId); } catch { /* уже отпущен */ }

    const rect = getRect();
    // Клик без протяжки — это сброс выделения, а не кроп в один пиксель.
    if (rect && wasDraw && (rect.w < MIN_SIDE || rect.h < MIN_SIDE)) {
      onChange(null);
      onCommit(null);
      return;
    }
    onCommit(rect);
  }

  el.addEventListener('pointerdown', onPointerDown);
  el.addEventListener('pointermove', onPointerMove);
  el.addEventListener('pointerup', onPointerUp);
  el.addEventListener('pointercancel', onPointerUp);

  return {
    get dragging() { return drag !== null; },
    destroy() {
      el.removeEventListener('pointerdown', onPointerDown);
      el.removeEventListener('pointermove', onPointerMove);
      el.removeEventListener('pointerup', onPointerUp);
      el.removeEventListener('pointercancel', onPointerUp);
    },
  };
}
