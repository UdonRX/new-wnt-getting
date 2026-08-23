import { readdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const roots = ['api', 'server', 'lib', 'shared', 'src', 'scripts'];
const extensions = new Set(['.js', '.mjs', '.cjs']);
const files = [];

async function walk(relativeDir) {
  const absoluteDir = path.join(root, relativeDir);
  const entries = await readdir(absoluteDir, { withFileTypes: true });
  for (const entry of entries) {
    const relative = path.join(relativeDir, entry.name);
    if (entry.isDirectory()) await walk(relative);
    else if (extensions.has(path.extname(entry.name))) files.push(relative);
  }
}

for (const dir of roots) {
  try { await walk(dir); } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
}

files.sort();
for (const file of files) {
  const result = spawnSync(process.execPath, ['--check', path.join(root, file)], { stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
}

console.log(`Syntax check: OK (${files.length} files)`);
