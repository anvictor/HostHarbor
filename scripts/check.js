import { readdir } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
async function check(directory) {
  for (const item of await readdir(directory, { withFileTypes: true })) {
    const file = `${directory}/${item.name}`;
    if (item.isDirectory()) await check(file);
    else if (/\.(?:js|cjs)$/.test(file)) execFileSync(process.execPath, ['--check', file], { stdio: 'inherit' });
  }
}
await check('app'); await check('tests'); await check('scripts');
console.log('JavaScript syntax: OK');
