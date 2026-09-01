// prep/crop.js — вырезание фрагмента. Выход всегда в crop-пространстве:
// начало координат — левый верх кропа, ось Y вниз, единицы — пиксели исходника.

/**
 * @param {ImageBitmap|HTMLImageElement|HTMLCanvasElement} source
 * @param {{x:number,y:number,w:number,h:number}} rect — image-пространство, целые пиксели
 * @returns {ImageData}
 */
export function cropFrom(source, rect) {
  if (rect.w < 1 || rect.h < 1) throw new Error('cropFrom: пустой прямоугольник');
  const c = document.createElement('canvas');
  c.width = rect.w;
  c.height = rect.h;
  const g = c.getContext('2d', { willReadFrequently: true });
  g.imageSmoothingEnabled = false;
  g.drawImage(source, rect.x, rect.y, rect.w, rect.h, 0, 0, rect.w, rect.h);
  return g.getImageData(0, 0, rect.w, rect.h);
}

/** ImageData → canvas, чтобы его можно было масштабировать при показе. */
export function toCanvas(imageData) {
  const c = document.createElement('canvas');
  c.width = imageData.width;
  c.height = imageData.height;
  c.getContext('2d').putImageData(imageData, 0, 0);
  return c;
}

/**
 * Наибольшее ЦЕЛОЕ увеличение, при котором кроп влезает в коробку.
 * Целое и без сглаживания — потому что на этом этапе человек должен видеть
 * ровно те пиксели, что есть, включая краевые: их тут 82%.
 */
export function pixelZoom(imageData, box, max = 24) {
  const k = Math.min(box.w / imageData.width, box.h / imageData.height);
  return Math.max(1, Math.min(max, Math.floor(k)));
}
