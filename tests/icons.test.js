import { readFileSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ICONS } from '../js/ui/icon-data.js';
import { CONTROLS } from '../js/ui/params.js';
import { innerMarkup } from '../tools/icon-markup.mjs';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const DIR = join(ROOT, 'icons', 'klaarheid');
const files = readdirSync(DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4)).sort();

/** Все .js под папкой, рекурсивно. */
const jsFiles = (dir) => readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
  const p = join(dir, e.name);
  return e.isDirectory() ? jsFiles(p) : e.name.endsWith('.js') ? [p] : [];
});

/**
 * Имена значков, которые просит код: data-icon в разметке, первый аргумент
 * icon(), второй — setIcon(), поле icon у настроек. Имя в аргументе может быть
 * и не одно (тернарный выбор), поэтому берутся все строки в кавычках.
 */
function usedNames() {
  const names = new Map();   // имя → где
  const add = (name, where) => { if (!names.has(name)) names.set(name, where); };
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-icon="([^"]+)"/gu)) add(m[1], 'index.html');
  for (const file of jsFiles(join(ROOT, 'js'))) {
    if (file.endsWith('icon-data.js')) continue;
    const src = readFileSync(file, 'utf8');
    const rel = file.slice(ROOT.length + 1);
    for (const m of src.matchAll(/\b(icon|setIcon)\(([^()]*)\)/gu)) {
      const args = m[2].split(',');
      const arg = m[1] === 'icon' ? args[0] : args[1];
      for (const q of (arg ?? '').matchAll(/'([a-z0-9-]+)'/gu)) add(q[1], rel);
    }
  }
  for (const c of CONTROLS) if (c.icon) add(c.icon, 'js/ui/params.js');
  return names;
}

test('icon-data.js собран из icons/klaarheid: те же имена и та же разметка', () => {
  eq(Object.keys(ICONS).sort(), files, 'имена в модуле и файлы в папке');
  for (const name of files) {
    const want = innerMarkup(readFileSync(join(DIR, `${name}.svg`), 'utf8'));
    if (ICONS[name] !== want) throw new Error(`${name}: разметка устарела — npm run icons:sync -- <набор>`);
  }
});

test('каждый значок из кода лежит в наборе, и каждый лежащий где-то нужен', () => {
  const used = usedNames();
  for (const [name, where] of used) {
    if (!ICONS[name]) throw new Error(`${where}: значка «${name}» нет в icons/klaarheid — npm run icons:sync -- <набор> ${name}`);
  }
  const idle = files.filter((n) => !used.has(n));
  eq(idle, [], 'значки, которые нигде не используются');
});

test('в интерфейсе не осталось значков-символов', () => {
  // Кнопки рисуются значками набора, а не буквами «−», «›», «✕», «●», «?».
  // Тире «—» — не значок, а «значения нет» в сводке; многоточие — «идёт работа».
  const glyph = /^[^\p{L}\p{N}\s—–…]{1,2}$/u;
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const buttons = [...html.matchAll(/<button\b[^>]*>([^<]*)<\/button>/gu)].map((m) => m[1].trim());
  eq(buttons.filter((t) => glyph.test(t)), [], 'кнопки с одним символом вместо значка');
  for (const file of ['js/ui/app.js', 'js/ui/splitter.js', 'js/ui/hints.js']) {
    const src = readFileSync(join(ROOT, file), 'utf8');
    const hits = [...src.matchAll(/textContent\s*=\s*(?:[^;]*\?\s*)?'([^']{1,2})'/gu)].map((m) => m[1]).filter((t) => glyph.test(t));
    eq(hits, [], `${file}: значок символом через textContent`);
  }
});
