#!/usr/bin/env node
// Синхронизация значков Пантографа с набором Klaarheid Icons.
//
//   node tools/sync-icons.mjs <путь к Klaarheid-Icons> [имя …]
//   npm run icons:sync -- ../Klaarheid-Icons [имя …]
//
// Берёт из локальной копии набора (по сети ничего не качает) каждый значок,
// который уже лежит в icons/klaarheid/, и новые имена из командной строки —
// и копирует их байт в байт из svg/fill набора. Затем
// пересобирает js/ui/icon-data.js (разметку значков для интерфейса) и раздел
// «Значки» в THIRD-PARTY-NOTICES.md между метками klaarheid:start и
// klaarheid:end: число значков и лицензию набора — MIT-0.
//
// Убрать значок: удалить его файл из icons/klaarheid/ и запустить синхронизацию.
// Черновики набора (имена на zz-) не берутся. Страж tests/icons.test.js
// сверяет icon-data.js с файлами и имена в коде — с тем, что лежит в папке.

import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { innerMarkup } from './icon-markup.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const ICON_DIR = path.join(ROOT, 'icons', 'klaarheid');
const DATA_FILE = path.join(ROOT, 'js', 'ui', 'icon-data.js');
const NOTICES_FILE = path.join(ROOT, 'THIRD-PARTY-NOTICES.md');
const START = /<!-- klaarheid:start[^>]*-->/u;
const END = '<!-- klaarheid:end -->';
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

const SET_URL = 'https://aumphaadr.github.io/Klaarheid-Icons/';
const REPO_URL = 'https://github.com/Aumphaadr/Klaarheid-Icons';

function fail(message) {
  console.error(`sync-icons: ${message}`);
  process.exit(1);
}

/** 1 значок, 2 значка, 5 значков. */
function plural(n, one, few, many) {
  const tens = n % 100;
  const units = n % 10;
  if (tens >= 11 && tens <= 14) return many;
  if (units === 1) return one;
  if (units >= 2 && units <= 4) return few;
  return many;
}

// ─── аргументы ──────────────────────────────────────────────────────────────

const [setDirArg, ...extra] = process.argv.slice(2);
if (!setDirArg) {
  fail('укажите путь к репозиторию Klaarheid-Icons: node tools/sync-icons.mjs <путь> [имя …]');
}
// Набор берётся из локальной копии (git clone), по сети ничего не качается:
// GitHub не хостинг для раздачи файлов.
if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(setDirArg)) {
  fail(`«${setDirArg}» — адрес, а нужна папка локальной копии набора, например ../Klaarheid-Icons`);
}
const setDir = path.resolve(setDirArg);
const fillDir = path.join(setDir, 'svg', 'fill');
if (!fs.existsSync(fillDir)) fail(`в «${setDir}» нет папки svg/fill — это точно Klaarheid-Icons?`);

fs.mkdirSync(ICON_DIR, { recursive: true });
const present = fs.readdirSync(ICON_DIR).filter((f) => f.endsWith('.svg')).map((f) => f.slice(0, -4));
const names = [...new Set([...present, ...extra])].sort();
for (const name of names) {
  if (!NAME.test(name)) fail(`странное имя значка «${name}»`);
  if (name.startsWith('zz-')) fail(`«${name}» — черновик набора, в проекты он не идёт`);
}

// ─── проверки до записи ─────────────────────────────────────────────────────

// Раздел «Значки» говорит, что на значки действует только MIT-0. Если набор
// снова заведёт список значков под другими лицензиями, это будет неправдой.
if (fs.existsSync(path.join(setDir, 'src', 'third-party.mjs'))) {
  fail('в наборе есть src/third-party.mjs — часть значков снова под другими лицензиями, '
    + 'а раздел «Значки» говорит только о MIT-0; синхронизация остановлена');
}

const sources = new Map();
for (const name of names) {
  const from = path.join(fillDir, `${name}.svg`);
  if (!fs.existsSync(from)) fail(`в наборе нет значка «${name}» (svg/fill/${name}.svg)`);
  const bytes = fs.readFileSync(from);
  try {
    innerMarkup(bytes.toString('utf8'));
  } catch (err) {
    fail(`${name}.svg: ${err.message}`);
  }
  sources.set(name, bytes);
}

const notices = fs.readFileSync(NOTICES_FILE, 'utf8');
const start = START.exec(notices);
const endAt = notices.indexOf(END);
if (!start || endAt < start.index) fail('в THIRD-PARTY-NOTICES.md нет меток klaarheid:start и klaarheid:end');

// ─── копии байт в байт ──────────────────────────────────────────────────────

let added = 0;
let changed = 0;
for (const [name, bytes] of sources) {
  const to = path.join(ICON_DIR, `${name}.svg`);
  const old = fs.existsSync(to) ? fs.readFileSync(to) : null;
  if (!old) added += 1;
  else if (!old.equals(bytes)) changed += 1;
  fs.writeFileSync(to, bytes);
}

// ─── разметка для интерфейса ────────────────────────────────────────────────

const data = [
  '// Разметка значков Klaarheid Icons из icons/klaarheid/ для интерфейса.',
  '// Файл пересобирает tools/sync-icons.mjs — руками не править.',
  "export const ICON_VIEWBOX = '0 0 24 24';",
  'export const ICONS = {',
  ...names.map((n) => `  '${n}': ${JSON.stringify(innerMarkup(sources.get(n).toString('utf8')))},`),
  '};',
  '',
].join('\n');
fs.writeFileSync(DATA_FILE, data);

// ─── раздел «Значки» ────────────────────────────────────────────────────────

const count = names.length;
const parts = [
  'Значки интерфейса взяты из набора',
  `[Klaarheid Icons](${SET_URL}) ([репозиторий](${REPO_URL})),`,
  'который разработан автором Пантографа и опубликован под лицензией **MIT-0**.',
  'Лицензия разрешает любое использование без условий и без упоминания автора.',
  `В Пантограф ${plural(count, 'входит', 'входят', 'входят')} ${count} ${plural(count, 'значок', 'значка', 'значков')} набора`
    + ' в варианте «контур заливкой»; они лежат',
  'в `icons/klaarheid/` — это копии файлов набора байт в байт.',
  '',
  'Раздел пересобирается командой `npm run icons:sync`.',
];
const section = `${start[0]}\n${parts.join('\n')}\n${END}`;
fs.writeFileSync(NOTICES_FILE, notices.slice(0, start.index) + section + notices.slice(endAt + END.length));

// ─── итог ───────────────────────────────────────────────────────────────────

console.log(`значков: ${count} (новых ${added}, обновлено ${changed})`);

// Предупредить, если Пантограф берёт ещё не опубликованные версии значков
// (сверка — по git набора, если он есть).
try {
  const files = names.map((n) => `svg/fill/${n}.svg`);
  const dirty = execFileSync('git', ['-C', setDir, 'status', '--porcelain', '--', ...files], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
    .split('\n').filter(Boolean).map((l) => l.slice(3));
  if (dirty.length) {
    console.log(`внимание: в рабочей копии набора не закоммичены ${dirty.length} из взятых файлов — ${dirty.join(' ')}`);
  }
} catch {
  // набор без git — сверять нечего
}
