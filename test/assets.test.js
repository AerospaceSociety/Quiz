import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, readdirSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { onRequest } from '../functions/config/[[path]].js';
import { buildStatic } from '../scripts/build-static.js';

for (const dir of ['scripts', 'functions']) {
  const checkDir = (d) => {
    for (const ent of readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, ent.name);
      if (ent.isDirectory()) checkDir(full);
      else if (ent.name.endsWith('.js')) {
        execFileSync(process.execPath, ['--check', full]);
      }
    }
  };
  checkDir(dir);
}

for (const path of [
  '/config/questions.json',
  '/CONFIG/questions.json',
  '/config%2fquestions.json',
  '/config//questions.json',
  '/%63onfig/questions.json'
]) {
  const response = onRequest({ request: new Request(`https://quiz.pages.dev${path}`), next: () => null });
  assert.equal(response.status, 404, `${path} must not expose the question bank`);
  assert.equal(response.headers.get('Cache-Control'), 'no-store');
}

let fellThrough = false;
onRequest({
  request: new Request('https://quiz.pages.dev/config/settings.json'),
  next: () => { fellThrough = true; return 'static asset'; }
});
assert.equal(fellThrough, true);

const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), 'quizzitch-public-assets-'));
try {
  const output = buildStatic(path.join(temporaryRoot, 'dist'));
  assert.equal(existsSync(path.join(output, 'index.html')), true);
  assert.equal(existsSync(path.join(output, 'config', 'settings.json')), true);
  assert.equal(existsSync(path.join(output, 'config', 'questions.json')), false);
  assert.equal(existsSync(path.join(output, 'scripts', 'build-static.js')), false);
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}

console.log('Private question-bank route is blocked.');
