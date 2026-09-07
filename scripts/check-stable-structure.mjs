import assert from 'node:assert/strict';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const required = [
  'src/runtime.js',
  'src/bootstrap.js',
  'src/styles/active-overrides.css',
  'lib/summary-stream.mjs',
  'lib/summary-dispatch.mjs'
];
for (const file of required) assert.equal(fs.existsSync(path.join(root, file)), true, `${file} が必要です`);

const forbidden = [
  'src/runtime-v2182.js','src/runtime-v2184.js','src/runtime-v2185.js','src/runtime-v2192.js','src/runtime-v2195.js',
  'src/bootstrap-v2195-summary.js',
  'src/styles/v2181.css','src/styles/v2182.css','src/styles/v2189.css','src/styles/v2194.css','src/styles/v2195.css',
  'lib/summary-v2184.mjs','lib/summary-dispatch-v2195.mjs'
];
for (const file of forbidden) assert.equal(fs.existsSync(path.join(root, file)), false, `${file} を残さない`);

const main = fs.readFileSync(path.join(root, 'src/main.js'), 'utf8');
const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
const sw = fs.readFileSync(path.join(root, 'sw.js'), 'utf8');
const serverSummary = fs.readFileSync(path.join(root, 'server/summary.mjs'), 'utf8');
assert.match(main, /import ['"]\.\/runtime\.js['"]/);
assert.match(index, /\/src\/bootstrap\.js/);
assert.match(index, /\/src\/styles\/active-overrides\.css/);
assert.match(sw, /\/src\/runtime\.js/);
assert.match(sw, /\/src\/bootstrap\.js/);
assert.equal(/runtime-v\d+\.js/.test(sw), false);
assert.equal(/styles\/v\d+\.css/.test(sw), false);
assert.match(serverSummary, /summary-stream\.mjs/);
assert.match(serverSummary, /summary-dispatch\.mjs/);

console.log('stable file structure guard: OK');
