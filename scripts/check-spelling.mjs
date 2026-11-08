#!/usr/bin/env node
// Spell check for blog/content (cspell, through cspell-lib). Checks prose only:
// the title and description frontmatter values and the body outside code,
// links, shortcodes and HTML (scripts/lib/prose.mjs). Words are checked
// against US and British English, cspell's software, Kubernetes, Go, cloud
// and company dictionaries, and the site's own word list in
// scripts/spelling/tech-terms.txt (one word per line, case-insensitive).
//
// A post can accept extra words in its frontmatter, for names and terms that
// belong to that post only:
//   spellcheck_ignore: ["Onosecond", "rekuberate"]
// Words used across posts belong in tech-terms.txt instead.
//
// Legacy misspellings are listed per file in scripts/spelling-baseline.json and
// accepted, like the heading and tag baselines; a word new to a file fails.
//
// Usage: node scripts/check-spelling.mjs [FILE...] [--json [--out FILE] | --candidates | --write-baseline]
//   (no mode)         fail on any misspelling the baseline does not accept
//   --json            every file's result (scripts/lib/check-report.mjs), exit 0
//   --candidates      every unknown word with its occurrence and file counts,
//                     for growing tech-terms.txt; ignores the baseline
//   --write-baseline  record every current misspelling as accepted
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spellCheckDocument } from 'cspell-lib';
import { maskNonProse } from './lib/prose.mjs';
import { parseFrontmatterList } from './lib/frontmatter.mjs';
import { BASELINED_SUFFIX, loadContent, result, report, writeReport } from './lib/check-report.mjs';

export const DICTIONARY_PATH = 'scripts/spelling/tech-terms.txt';
export const BASELINE_PATH = 'scripts/spelling-baseline.json';
export const IGNORE_KEY = 'spellcheck_ignore';

// cspell bundled dictionaries enabled on top of English.
const DICTIONARIES = [
  'softwareTerms', 'software-tools', 'networking-terms', 'web-services', 'computing-acronyms',
  'coding-compound-terms', 'k8s', 'golang', 'docker', 'bash', 'shellscript', 'aws', 'python',
  'companies', 'terraform', 'sql', 'git', 'fullstack', 'node', 'npm', 'rust',
  'data-science', 'data-science-tools', 'java', 'powershell', 'filetypes',
];

export function settings(dictionaryPath = DICTIONARY_PATH) {
  return {
    language: 'en,en-GB',
    dictionaries: [...DICTIONARIES, 'tech-terms'],
    dictionaryDefinitions: [{ name: 'tech-terms', path: resolve(dictionaryPath) }],
    minWordLength: 4,
  };
}

// misspellings returns the unknown words in one file, in first-seen order, with
// the lines they are on, less the file's own spellcheck_ignore words.
export async function misspellings(path, text, cfg = settings()) {
  const ignore = new Set(parseFrontmatterList(text, IGNORE_KEY).items.map((w) => w.toLowerCase()));
  const doc = { uri: pathToFileURL(resolve(path)).href, text: maskNonProse(text), languageId: 'markdown', locale: 'en' };
  const res = await spellCheckDocument(doc, { generateSuggestions: false, noConfigSearch: true }, cfg);
  if (res.errors && res.errors.length) throw new Error(`${path}: ${res.errors.map(String).join('; ')}`);
  const byWord = new Map();
  for (const issue of res.issues) {
    if (ignore.has(issue.text.toLowerCase())) continue;
    const line = lineOf(doc.text, issue.offset);
    if (!byWord.has(issue.text)) byWord.set(issue.text, []);
    const lines = byWord.get(issue.text);
    if (!lines.includes(line + 1)) lines.push(line + 1);
  }
  return [...byWord].map(([word, lines]) => ({ word, lines }));
}

function lineOf(text, offset) {
  let n = 0;
  for (let i = 0; i < offset && i < text.length; i++) if (text[i] === '\n') n++;
  return n;
}

const message = ({ word, lines }) => `unknown word "${word}" (line${lines.length > 1 ? 's' : ''} ${lines.join(', ')})`;

// fileResult splits one file's misspellings into new and baseline-accepted.
export function fileResult(path, found, baseline = {}) {
  const accepted = new Set(baseline[path] || []);
  const failures = found.filter((f) => !accepted.has(f.word)).map(message);
  const ok = found.filter((f) => accepted.has(f.word)).map(message);
  return result(path, 'spelling', failures, ok);
}

export async function scan(files, cfg = settings()) {
  const out = [];
  for (const [path, text] of files) out.push([path, await misspellings(path, text, cfg)]);
  return out;
}

export async function fileResults(files, baseline = {}, cfg = settings()) {
  return (await scan(files, cfg)).map(([path, found]) => fileResult(path, found, baseline));
}

function loadBaseline() {
  return JSON.parse(readFileSync(BASELINE_PATH, 'utf8'));
}

function loadFiles(argv) {
  const named = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out');
  if (!named.length) return loadContent();
  return named.map((p) => [relative('.', p).split('\\').join('/'), readFileSync(p, 'utf8')]);
}

async function main(argv) {
  const files = loadFiles(argv);
  if (argv.includes('--candidates')) {
    const words = new Map();
    for (const [path, found] of await scan(files)) {
      for (const { word, lines } of found) {
        const w = words.get(word) || { count: 0, files: 0 };
        w.count += lines.length;
        w.files += 1;
        words.set(word, w);
      }
    }
    for (const [word, w] of [...words].sort((a, b) => b[1].files - a[1].files || a[0].localeCompare(b[0]))) {
      console.log(`${w.count}\t${w.files}\t${word}`);
    }
  } else if (argv.includes('--write-baseline')) {
    const baseline = {};
    for (const [path, found] of await scan(files)) if (found.length) baseline[path] = found.map((f) => f.word).sort();
    writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
    console.log(`Wrote ${Object.keys(baseline).length} files to ${BASELINE_PATH}`);
  } else if (argv.includes('--json')) {
    writeReport(report(['spelling'], await fileResults(files, loadBaseline())), argv);
  } else {
    const baseline = loadBaseline();
    const results = await fileResults(files, baseline);
    const failing = results.filter((r) => r.status === 'fail' && !r.baselined);
    if (failing.length) {
      console.error(`Spell check failed (${failing.length} files):`);
      for (const r of failing) {
        for (const m of r.messages.filter((x) => !x.endsWith(BASELINED_SUFFIX))) console.error(`  ${r.path}: ${m}`);
      }
      console.error(`Fix the spelling; add a term used across posts to ${DICTIONARY_PATH}, or one used by one post to its ${IGNORE_KEY} frontmatter list.`);
      process.exit(1);
    }
    console.log(`Spell check passed (${files.length} files, ${Object.keys(baseline).length} with baseline-accepted words)`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main(process.argv.slice(2));
}
