// tests/run.js — раннер. Никаких зависимостей: node tests/run.js
import { readdirSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));

let passed = 0;
const failures = [];
let suite = '';

globalThis.test = (name, fn) => {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failures.push({ suite, name, err });
  }
};

globalThis.eq = (got, want, what = '') => {
  const a = JSON.stringify(got);
  const b = JSON.stringify(want);
  if (a !== b) throw new Error(`${what}\n    получено: ${a}\n    ожидалось: ${b}`);
};

const files = readdirSync(here).filter((f) => f.endsWith('.test.js')).sort();

for (const f of files) {
  suite = f.replace('.test.js', '');
  await import(pathToFileURL(join(here, f)).href);
}

if (failures.length) {
  console.log('');
  for (const f of failures) console.log(`  ✗ ${f.suite} · ${f.name}\n    ${f.err.message}\n`);
  console.log(`Провалено ${failures.length}, пройдено ${passed}.`);
  process.exit(1);
}
console.log(`Пройдено ${passed} проверок в ${files.length} файлах.`);
