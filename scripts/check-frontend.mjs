import { readFile } from 'node:fs/promises';

for (const file of ['src/main.js', 'src/editor.js']) {
  const source = await readFile(new URL(`../${file}`, import.meta.url), 'utf8');
  new Function(source);
  console.log(`${file} parses OK`);
}
