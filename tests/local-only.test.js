// Страж: всё, что нужно странице, лежит в репозитории Пантографа.
//
// Ни CDN, ни прямых ссылок на файлы репозиториев GitHub и сайтов на GitHub
// Pages, в том числе набора Klaarheid Icons: GitHub не хостинг для раздачи
// файлов сайтам. Значки набора копируются файлами (npm run icons:sync),
// библиотеки — в vendor/ со своей лицензией (CONTRIBUTING.md, «Чужие файлы»).
//
// Проверяются файлы, которые отдаёт сайт: *.html, *.css, *.js, *.svg. Кроме
// сценариев node (tools/, tests/*.js) и того, что закрыто в .gitignore и на
// сайт не попадает. Внешний адрес разрешён в ссылке для перехода
// (<a href="https://…">, в том числе внутри строки сценария) и в комментарии.
// Пространства имён XML — не адреса загрузки, они тоже пропускаются.

import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join, dirname, relative, extname, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SERVED = new Set(['.html', '.css', '.js', '.svg']);
const NAMESPACE = /^http:\/\/www\.(?:w3\.org\/(?:2000\/svg|1999\/xlink|1999\/xhtml|XML\/1998\/namespace)|inkscape\.org\/namespaces\/inkscape)$/u;

// Полный адрес или адрес без протокола: «//cdn.example.com/…».
const ADDRESS = /(?:\bhttps?:)?\/\/[a-z0-9-]+(?:\.[a-z0-9-]+)+[^\s"'`)<>]*/giu;
const COMMENT_LINE = /^\s*(?:\/\/|\/\*|\*|<!--)/u;
// Хвостовой комментарий: «код // адрес».
const TRAILING_COMMENT = /(?:^|[\s,;{}()[\]])\/\/\s/u;

/** Папки из .gitignore: на сайт они не попадают. */
function ignoredDirs() {
  const file = join(ROOT, '.gitignore');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8').split('\n').map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#') && l.endsWith('/'));
}

const SKIP = ['.git/', '.github/', 'tools/', ...ignoredDirs()];
const nodeOnly = (rel) => /^tests\/[^/]+\.js$/u.test(rel);

function servedFiles(dir = ROOT) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, e.name);
    const rel = relative(ROOT, abs).split(sep).join('/');
    if (e.isDirectory()) {
      if (!SKIP.some((s) => `${rel}/`.startsWith(s))) out.push(...servedFiles(abs));
    } else if (SERVED.has(extname(e.name)) && !nodeOnly(rel)) {
      out.push(rel);
    }
  }
  return out.sort();
}

/** Адрес стоит в href ссылки: от последнего «<» до адреса — открытый тег <a с href. */
function inAnchorHref(text, index) {
  const open = text.lastIndexOf('<', index);
  if (open < 0) return false;
  return /^<a\s[^<>]*\bhref\s*=\s*["']?$/iu.test(text.slice(open, index));
}

/** Адреса, с которых текст что-то грузил бы: [{ line, address }]. */
function externalAddresses(text) {
  const found = [];
  for (const m of text.matchAll(ADDRESS)) {
    if (NAMESPACE.test(m[0]) || inAnchorHref(text, m.index)) continue;
    const lineStart = text.lastIndexOf('\n', m.index - 1) + 1;
    const lineEnd = text.indexOf('\n', m.index);
    const lineText = text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd);
    if (COMMENT_LINE.test(lineText) || TRAILING_COMMENT.test(text.slice(lineStart, m.index))) continue;
    found.push({ line: text.slice(0, m.index).split('\n').length, address: m[0] });
  }
  return found;
}

test('страница ничего не грузит с других сайтов', () => {
  const files = servedFiles();
  const hits = [];
  for (const rel of files) {
    for (const h of externalAddresses(readFileSync(join(ROOT, rel), 'utf8'))) {
      hits.push(`${rel}:${h.line} — ${h.address}`);
    }
  }
  if (hits.length) {
    throw new Error('внешние адреса — всё, что нужно странице, кладётся в репозиторий, '
      + `значки Klaarheid копируются через npm run icons:sync:\n    ${hits.join('\n    ')}`);
  }
  // Проверка не пустая: страница, стили, сценарии, значки и библиотека — в обходе.
  for (const must of ['index.html', 'css/app.css', 'js/ui/app.js', 'js/ui/icon-data.js',
    'icons/klaarheid/eye.svg', 'vendor/opentype.module.js', 'tests/browser.html']) {
    if (!files.includes(must)) throw new Error(`страж не видит ${must}`);
  }
});

test('страж ловит загрузку извне и пропускает ссылку, комментарий и пространство имён', () => {
  const caught = (text) => externalAddresses(text).map((h) => h.address);
  const set = 'https://aumphaadr.github.io/Klaarheid-Icons/svg/fill/eye.svg';
  const raw = 'https://raw.githubusercontent.com/Aumphaadr/Klaarheid-Icons/main/svg/fill/eye.svg';
  eq(caught(`<img src="${set}" alt="">`), [set], 'картинка с сайта набора');
  eq(caught(`img.src = '${set}';`), [set], 'картинка из сценария');
  eq(caught(`const svg = await (await fetch('${raw}')).text();`), [raw], 'файл из репозитория набора');
  eq(caught('<script src="https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.module.js"></script>'),
    ['https://cdn.jsdelivr.net/npm/opentype.js@1.3.4/dist/opentype.module.js'], 'библиотека с CDN');
  eq(caught('.x { background: url(//cdn.example.com/a.png) }'), ['//cdn.example.com/a.png'], 'адрес без протокола');
  eq(caught('<link rel="stylesheet" href="https://fonts.example.com/onest.css">'),
    ['https://fonts.example.com/onest.css'], 'стили с чужого сервера');

  eq(caught('<a href="https://github.com/Aumphaadr/Pantograph">исходники</a>'), [], 'ссылка для перехода');
  eq(caught(`el.innerHTML = '<a href="https://aumphaadr.github.io/Klaarheid-Icons/">набор</a>';`), [],
    'ссылка, собранная сценарием');
  eq(caught(' * https://opentype.js.org'), [], 'строка комментария');
  eq(caught("'x-mac-gaelic': // http://unicode.org/Public/MAPPINGS/VENDORS/APPLE/GAELIC.TXT"), [],
    'хвостовой комментарий');
  eq(caught('<svg xmlns="http://www.w3.org/2000/svg" xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape">'),
    [], 'пространства имён');
});

test('у каждой библиотеки в vendor/ лежит лицензия и строка в THIRD-PARTY-NOTICES.md', () => {
  const notices = readFileSync(join(ROOT, 'THIRD-PARTY-NOTICES.md'), 'utf8');
  const names = readdirSync(join(ROOT, 'vendor'));
  const licenses = names.filter((n) => n.includes('LICENSE'));
  const libs = names.filter((n) => n !== 'README.md' && !licenses.includes(n));
  eq(libs.length > 0, true, 'в vendor/ есть библиотеки');
  for (const lib of libs) {
    const stem = lib.split('.')[0];
    const license = licenses.find((n) => n.startsWith(`${stem}.`) || n.startsWith(`${stem}-`));
    if (!license) throw new Error(`vendor/${lib}: рядом нет лицензии (${stem}…-LICENSE.txt)`);
    for (const file of [lib, license]) {
      if (!notices.includes(`vendor/${file}`)) throw new Error(`THIRD-PARTY-NOTICES.md молчит о vendor/${file}`);
    }
  }
});
