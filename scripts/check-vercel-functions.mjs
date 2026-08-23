import { readFile, readdir } from 'node:fs/promises';

const apiDir = new URL('../api/', import.meta.url);
const vercelPath = new URL('../vercel.json', import.meta.url);
const files = (await readdir(apiDir))
  .filter(name => /\.(?:js|mjs|cjs|ts)$/.test(name))
  .sort();

const HOBBY_FUNCTION_LIMIT = 12;
const HOBBY_BUILD_RATE_PER_HOUR = 32;
const PROJECT_FUNCTION_TARGET = 4;

console.log(`Vercel API Functions: ${files.length}/${HOBBY_FUNCTION_LIMIT} (project target <= ${PROJECT_FUNCTION_TARGET})`);
files.forEach(name => console.log(` - api/${name}`));
console.log(`Estimated full deployments before the 32-build/hour Hobby ceiling: ${files.length ? Math.floor(HOBBY_BUILD_RATE_PER_HOUR / files.length) : 'n/a'} per hour`);

let failed = false;
if (files.length > HOBBY_FUNCTION_LIMIT) {
  console.error(`ERROR: Hobby function limit ${HOBBY_FUNCTION_LIMIT} exceeded.`);
  failed = true;
}
if (files.length > PROJECT_FUNCTION_TARGET) {
  console.error(`ERROR: This project intentionally caps top-level Vercel Functions at ${PROJECT_FUNCTION_TARGET}. Add new API routes to an existing router and keep implementation files outside /api.`);
  failed = true;
}

const vercel = JSON.parse(await readFile(vercelPath, 'utf8'));
const wildcard = vercel?.functions?.['api/*.mjs'];
if (wildcard?.includeFiles) {
  console.error('ERROR: Heavy includeFiles is applied to every API Function. Scope it only to the Function that actually needs it.');
  failed = true;
}

const crons = Array.isArray(vercel?.crons) ? vercel.crons : [];
if (crons.length) {
  console.warn('WARNING: Hobby cron schedules must not run more than once per day. Verify each cron schedule before deployment.');
}

if (failed) process.exit(1);
