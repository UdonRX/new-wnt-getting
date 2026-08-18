import { readdir } from 'node:fs/promises';

const files = (await readdir(new URL('../api/', import.meta.url)))
  .filter(name => /\.(?:js|mjs|cjs|ts)$/.test(name))
  .sort();

const HOBBY_LIMIT = 12;
console.log(`Vercel API Functions: ${files.length}/${HOBBY_LIMIT}`);
files.forEach(name => console.log(` - api/${name}`));

if (files.length > HOBBY_LIMIT) {
  console.error(`ERROR: Hobby上限${HOBBY_LIMIT}個を超えています。`);
  process.exit(1);
}
