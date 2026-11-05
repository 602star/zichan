import { readFile, writeFile } from 'node:fs/promises';

const [tag, output] = process.argv.slice(2);
if (!/^v\d+\.\d+\.\d+$/.test(tag) || !output) {
  throw new Error('Usage: node extract-release-notes.mjs <vMAJOR.MINOR.PATCH> <output-file>');
}

const source = await readFile(new URL('../../docs/release-notes.md', import.meta.url), 'utf8');
const headings = [...source.matchAll(/^# (\S+)\s*$/gm)];
const start = headings.findIndex((heading) => heading[1] === tag.slice(1));
if (start !== 0) throw new Error(`Release notes must start with ${tag.slice(1)}`);
const end = headings[1]?.index ?? source.length;
const notes = source.slice(headings[0].index, end).trim();
if (!/^[-*] \S/m.test(notes)) throw new Error('Release notes contain no change entries');
await writeFile(output, `${notes}\n`, { flag: 'wx' });
