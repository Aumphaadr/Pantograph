// Внутренняя разметка значка Klaarheid Icons (вариант svg/fill) для вставки
// в интерфейс — общая для tools/sync-icons.mjs и стража tests/icons.test.js,
// чтобы страж сверял icon-data.js той же меркой, какой его собирают.
//
// Значок обязан быть сеткой 24×24 из одних <path> цвета currentColor: тогда
// он красится цветом текста кнопки, и чужого цвета в интерфейс не попадёт.

export function innerMarkup(svg) {
  const root = /<svg\b[^>]*>/u.exec(svg);
  if (!root) throw new Error('нет корневого <svg>');
  if (!/\sviewBox="0 0 24 24"/u.test(root[0])) throw new Error('viewBox не «0 0 24 24»');
  const end = svg.lastIndexOf('</svg>');
  if (end < 0) throw new Error('нет закрывающего </svg>');
  const body = svg.slice(root.index + root[0].length, end).trim();
  const tags = [...body.matchAll(/<\/?([a-zA-Z][\w:-]*)\b/gu)].map((m) => m[1]);
  const foreign = tags.find((t) => t !== 'path');
  if (foreign) throw new Error(`кроме <path> есть <${foreign}> — интерфейс рисует только пути`);
  if (!tags.length) throw new Error('ни одного <path>');
  for (const m of body.matchAll(/\s(fill|stroke)="([^"]*)"/gu)) {
    if (m[2] !== 'currentColor' && m[2] !== 'none') throw new Error(`зашитый цвет ${m[1]}="${m[2]}"`);
  }
  return body.replace(/>\s+</gu, '><');
}
