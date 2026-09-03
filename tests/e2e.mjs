// tests/e2e.mjs — сквозная проверка интерфейса в настоящем браузере.
//
// `node tests/e2e.mjs` (нужен google-chrome или chromium). Скрипт сам поднимает
// статический сервер, открывает страницу в headless-браузере по протоколу
// отладчика и нажимает то же, что нажимает человек: бросает файл, тянет кроп,
// правит узлы рамкой, жмёт «Скачать SVG».
//
// Зачем: `npm test` проверяет чистые функции, а связка «правка → слой →
// экспорт» живёт в app.js и в узлах DOM. Именно там завёлся баг, ради которого
// это написано: правки узлов уходили только в локальную переменную, экспорт
// читал слой, и в файл молча уходила версия ДО правок.
//
// Картинка рисуется на месте холстом: ни одного файла со стороны.

import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { dirname, join, normalize, extname } from 'node:path';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 8791;
const DEBUG_PORT = 9333;
const TYPES = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png',
};

const checks = [];
const check = (ok, what, detail = '') => {
  checks.push(ok);
  console.log(`${ok ? '✓' : '✗'} ${what}${detail ? ` — ${detail}` : ''}`);
};

// ─── сервер и браузер ───────────────────────────────────────────────────────

const server = createServer(async (req, res) => {
  const rel = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '');
  const file = join(ROOT, rel === '/' ? 'index.html' : rel);
  try {
    const body = await readFile(file);
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404).end('нет такого файла');
  }
});
await new Promise((res) => { server.listen(PORT, '127.0.0.1', res); });

const BROWSERS = ['google-chrome', 'chromium', 'chromium-browser', 'google-chrome-stable'];
let browser = null;
for (const bin of BROWSERS) {
  try {
    browser = spawn(bin, [
      '--headless=new', `--remote-debugging-port=${DEBUG_PORT}`, '--disable-gpu',
      '--no-first-run', '--no-default-browser-check', '--hide-scrollbars',
      `--user-data-dir=/tmp/pantograph-e2e-${process.pid}`, '--window-size=1400,900', 'about:blank',
    ], { stdio: 'ignore' });
    await sleep(400);
    if (browser.exitCode === null) break;
  } catch { browser = null; }
}
if (!browser) {
  console.log('пропущено: не нашёлся google-chrome или chromium');
  server.close();
  process.exit(0);
}

const done = (code) => {
  try { browser.kill(); } catch { /* уже умер */ }
  server.close();
  process.exit(code);
};

let target = null;
for (let i = 0; i < 80 && !target; i += 1) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${DEBUG_PORT}/json/list`)).json();
    target = list.find((t) => t.type === 'page');
  } catch { /* браузер ещё поднимается */ }
  if (!target) await sleep(250);
}
if (!target) { console.log('НЕ УДАЛОСЬ: браузер не отдал вкладку'); done(1); }

// ─── протокол отладчика ─────────────────────────────────────────────────────

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
let seq = 0;
const waiting = new Map();
const pageErrors = [];
ws.onmessage = (m) => {
  const msg = JSON.parse(m.data);
  if (msg.id && waiting.has(msg.id)) { waiting.get(msg.id)(msg); waiting.delete(msg.id); return; }
  if (msg.method === 'Runtime.exceptionThrown') {
    const d = msg.params.exceptionDetails;
    pageErrors.push(d.exception?.description ?? d.text);
  }
};
const send = (method, params = {}) => new Promise((res) => {
  const id = ++seq;
  waiting.set(id, res);
  ws.send(JSON.stringify({ id, method, params }));
});

/** Выполнить выражение на странице; тело оборачивается в функцию, нужен return. */
const js = async (body, awaitPromise = false) => {
  const r = await send('Runtime.evaluate', {
    expression: `(() => { ${body} })()`, returnByValue: true, awaitPromise,
  });
  const bad = r.result?.exceptionDetails;
  if (bad) throw new Error(String(bad.exception?.description ?? bad.text).slice(0, 300));
  return r.result?.result?.value;
};
const until = async (body, what, tries = 120) => {
  for (let i = 0; i < tries; i += 1) {
    const v = await js(body);
    if (v) return v;
    await sleep(250);
  }
  throw new Error(`не дождались: ${what}`);
};
const mouse = (type, x, y) => send('Input.dispatchMouseEvent', {
  type, x, y, button: 'left', clickCount: 1, buttons: type === 'mouseReleased' ? 0 : 1,
});
/** Протяжка: нажали, провели, отпустили — как рукой. */
const drag = async (x0, y0, x1, y1) => {
  await mouse('mousePressed', x0, y0);
  for (let k = 1; k <= 8; k += 1) {
    await mouse('mouseMoved', x0 + ((x1 - x0) * k) / 8, y0 + ((y1 - y0) * k) / 8);
  }
  await mouse('mouseReleased', x1, y1);
  await sleep(150);
};

/** Бросить на страницу нарисованную на месте картинку — тот же путь, что у файла. */
const dropDrawnImage = () => js(`
  const c = document.createElement('canvas');
  c.width = 400; c.height = 400;
  const g = c.getContext('2d');
  g.fillStyle = '#fff'; g.fillRect(0, 0, 400, 400);
  g.strokeStyle = '#000'; g.lineWidth = 18; g.lineJoin = 'round';
  g.beginPath(); g.roundRect(70, 70, 260, 260, 40); g.stroke();
  g.beginPath(); g.arc(200, 200, 60, 0, Math.PI * 2); g.stroke();
  return new Promise((res) => c.toBlob((b) => {
    const dt = new DataTransfer();
    dt.items.add(new File([b], 'проба.png', { type: 'image/png' }));
    document.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
    res(true);
  }, 'image/png'));`, true);

/** Дождаться СВЕЖЕЙ обводки: сводка гасится, потом ждём числа при спящем воркере. */
const freshTrace = async () => {
  await js("document.getElementById('stat-nodes').textContent = '—'; return true");
  await until(`return /^[0-9]+$/.test(document.getElementById('stat-nodes').textContent)
    && document.getElementById('busy').hidden`, 'свежая обводка');
  await sleep(200);
};

/** Нажать «Скачать SVG» и перехватить содержимое файла. */
const grabSvg = async (tag) => {
  const rep = await js(`window.__svg = null;
    const b = document.getElementById('save-svg');
    b.click();
    return { status: document.getElementById('status').textContent };`);
  const svg = await until('return window.__svg', `SVG (${tag})`, 24).catch(() => null);
  if (!svg) throw new Error(`SVG не сохранился (${tag}): «${rep.status}»`);
  return svg;
};

// ─── сама проверка ──────────────────────────────────────────────────────────

try {
  await send('Runtime.enable');
  await send('Page.enable');
  await send('Page.setDownloadBehavior', { behavior: 'deny' }).catch(() => {});
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  await until("return typeof document.getElementById('save-svg')?.click === 'function'", 'страница поднялась');
  // Хранилище прошлого прогона не должно подмешиваться.
  await js('return indexedDB.deleteDatabase("pantograph") && true');
  await sleep(300);
  await send('Page.navigate', { url: `http://127.0.0.1:${PORT}/index.html` });
  // Ждём не просто разметку, а работающий app.js: ленту шагов строит он.
  await until(`return document.readyState === 'complete'
    && document.getElementById('step-list').children.length > 0`, 'приложение поднялось');
  await js(`const orig = URL.createObjectURL.bind(URL);
    URL.createObjectURL = (b) => { b.text().then((t) => { window.__svg = t; }); return orig(b); };
    return true`);

  // 1. Брошенный файл ставит первый шаг — даже если человек стоял на другом.
  await dropDrawnImage();
  await until("return document.body.classList.contains('has-image')", 'картинка принята', 40)
    .catch(async () => {
      throw new Error(`картинка не принята: статус «${await js("return document.getElementById('status').textContent")}»`
        + `, ошибки: ${pageErrors.slice(0, 2).join(' | ') || 'нет'}`);
    });
  const box = await js(`const r = document.getElementById('overlay').getBoundingClientRect();
    return { x: r.x, y: r.y, w: r.width, h: r.height };`);
  await drag(box.x + box.w * 0.06, box.y + box.h * 0.06, box.x + box.w * 0.94, box.y + box.h * 0.94);
  await freshTrace();
  await js(`document.querySelector('button[data-step="contour"]').click(); return true`);
  const before = await js('return document.body.dataset.step');
  await dropDrawnImage();
  await sleep(600);
  const after = await js('return document.body.dataset.step');
  check(before === 'contour' && after === 'image', 'брошенная картинка возвращает на шаг «Картинка»',
    `${before} → ${after}`);

  // 2. Правка узлов доходит до экспорта и до сводки.
  await drag(box.x + box.w * 0.06, box.y + box.h * 0.06, box.x + box.w * 0.94, box.y + box.h * 0.94);
  await freshTrace();
  await js(`document.querySelector('button[data-step="contour"]').click(); return true`);
  const svgBefore = await grabSvg('до правки');
  const nodesBefore = await js("return document.getElementById('ex-nodes').textContent");

  let picked = '';
  for (const [a, b] of [[0.1, 0.4], [0.1, 0.55], [0.05, 0.95]]) {
    await drag(box.x + box.w * a, box.y + box.h * 0.2, box.x + box.w * b, box.y + box.h * 0.8);
    picked = await js("return document.getElementById('sel-count').textContent");
    if (/[1-9]/.test(picked)) break;
  }
  check(/[1-9]/.test(picked), 'рамкой выделяются узлы', picked);
  await js("document.getElementById('ed-delete').click(); return true");
  await sleep(300);

  const nodesAfter = await js("return document.getElementById('ex-nodes').textContent");
  const svgAfter = await grabSvg('после правки');
  check(nodesBefore !== nodesAfter, 'сводка экспорта пересчитана после правки',
    `узлов ${nodesBefore} → ${nodesAfter}`);
  check(svgBefore !== svgAfter, 'в SVG уходит правленый контур',
    `${svgBefore.length} → ${svgAfter.length} байт`);

  check(pageErrors.length === 0, 'страница обошлась без ошибок', pageErrors.slice(0, 2).join(' | '));
} catch (err) {
  check(false, 'проверка дошла до конца', String(err.message ?? err));
}

const bad = checks.filter((ok) => !ok).length;
console.log(bad ? `\nПровалено ${bad} из ${checks.length}.` : `\nПройдено ${checks.length} проверок в браузере.`);
done(bad ? 1 : 0);
