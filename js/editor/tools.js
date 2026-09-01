// editor/tools.js — работа указателем в редакторе.
//
// Координаты указателя переводятся в crop-пространство ПЕРВОЙ строчкой
// обработчика; дальше внутри — только crop-пространство.

import {
  hitTest, hitCurve, nodesInRect, moveNodes, moveHandle, insertNode, setNodeType, key,
} from './ops.js';
import { nearestOnContour } from '../core/path.js';
import { normRect } from '../core/geom.js';

const HIT_PX = 8;        // допуск попадания, экранные пиксели
const CURVE_PX = 6;
const DRAG_PX = 2.5;     // меньше этого — клик, а не перетаскивание

export function createEditorTool({ el, viewport, get, set, history, isEnabled }) {
  let drag = null;
  let hover = null;
  let marquee = null;

  const toCrop = (ev) => {
    const box = el.getBoundingClientRect();
    return viewport.toImage({ x: ev.clientX - box.left, y: ev.clientY - box.top });
  };
  const tol = (px) => viewport.toImageLen(px);

  function probe(p) {
    const { shape, selection } = get();
    if (!shape) return null;
    return hitTest(shape, p, tol(HIT_PX), { selection })
      ?? hitCurve(shape, p, tol(CURVE_PX), nearestOnContour);
  }

  function onDown(ev) {
    if (!isEnabled() || ev.button !== 0 || ev.shiftKey) return;
    const { shape, selection } = get();
    if (!shape) return;
    const p = toCrop(ev);
    const hit = probe(p);

    if (hit && hit.kind === 'handle') {
      history.begin();
      drag = { kind: 'handle', at: hit, from: p, moved: false };
    } else if (hit && hit.kind === 'node') {
      const k = key(hit.ci, hit.ni);
      let sel = selection;
      if (ev.ctrlKey || ev.metaKey) {
        sel = new Set(selection);
        if (sel.has(k)) sel.delete(k); else sel.add(k);
      } else if (!selection.has(k)) {
        sel = new Set([k]);
      }
      set({ selection: sel });
      history.begin();
      drag = { kind: 'nodes', from: p, last: p, moved: false };
    } else {
      drag = { kind: 'marquee', from: p, add: ev.ctrlKey || ev.metaKey, moved: false };
      marquee = { x: p.x, y: p.y, w: 0, h: 0 };
    }

    try { el.setPointerCapture?.(ev.pointerId); } catch { /* указателя уже нет */ }
    ev.preventDefault();
  }

  function onMove(ev) {
    if (!isEnabled()) return;
    const p = toCrop(ev);

    if (!drag) {
      const next = probe(p);
      const same = JSON.stringify(next) === JSON.stringify(hover);
      hover = next;
      if (!same) set({});
      el.style.cursor = next ? (next.kind === 'curve' ? 'copy' : 'move') : 'default';
      return;
    }

    if (Math.hypot(p.x - drag.from.x, p.y - drag.from.y) > tol(DRAG_PX)) drag.moved = true;

    if (drag.kind === 'handle') {
      const { shape } = get();
      set({ shape: moveHandle(shape, drag.at, p, { break: ev.altKey }) });
    } else if (drag.kind === 'nodes') {
      const { shape, selection, snap } = get();
      set({ shape: moveNodes(shape, [...selection], p.x - drag.last.x, p.y - drag.last.y, snap) });
      drag.last = p;
    } else {
      marquee = normRect(drag.from, p);
      set({});
    }
  }

  function onUp(ev) {
    if (!drag) return;
    const { shape, selection } = get();

    if (drag.kind === 'marquee') {
      const inside = marquee ? nodesInRect(shape, marquee) : [];
      const sel = drag.add ? new Set([...selection, ...inside]) : new Set(inside);
      marquee = null;
      set({ selection: sel });
    } else {
      history.end(get().shape);
    }
    drag = null;
    try { el.releasePointerCapture(ev.pointerId); } catch { /* уже отпущен */ }
    set({});
  }

  function onDouble(ev) {
    if (!isEnabled()) return;
    const { shape } = get();
    if (!shape) return;
    const p = toCrop(ev);
    const hit = probe(p);
    if (!hit) return;
    ev.preventDefault();

    if (hit.kind === 'node') {
      const type = shape.contours[hit.ci].nodes[hit.ni].type === 'smooth' ? 'corner' : 'smooth';
      set({ shape: setNodeType(shape, hit, type) });
      history.push(get().shape);
    } else if (hit.kind === 'curve') {
      const next = insertNode(shape, { ci: hit.ci, si: hit.si, t: hit.t });
      set({ shape: next, selection: new Set([key(hit.ci, hit.si + 1)]) });
      history.push(next);
    }
  }

  el.addEventListener('pointerdown', onDown);
  el.addEventListener('pointermove', onMove);
  el.addEventListener('pointerup', onUp);
  el.addEventListener('pointercancel', onUp);
  el.addEventListener('dblclick', onDouble);

  return {
    get hover() { return hover; },
    get marquee() { return marquee; },
    get dragging() { return drag !== null; },
    clearHover() { hover = null; },
  };
}
