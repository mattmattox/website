#!/usr/bin/env node
// Runs every per-file content check (headings, categories, tags, spelling)
// over blog/content and prints one combined per-file report
// (scripts/lib/check-report.mjs). It always exits 0 once the report is
// written: failures are data here, and CI gates on the individual check-*.mjs
// scripts. The publisher's daily-publish job (scripts/jobs/daily-publish.sh)
// runs it and the console stores the results for Post detail.
// Usage: node scripts/check-posts.mjs --json [--out FILE]
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { loadContent, report, writeReport } from './lib/check-report.mjs';
import { fileResults as headingResults } from './check-headings.mjs';
import { fileResults as categoryResults, parseAllowlist } from './check-categories.mjs';
import { fileResults as tagResults } from './check-tags.mjs';
import { fileResults as spellingResults, BASELINE_PATH as SPELLING_BASELINE } from './check-spelling.mjs';

const readJSON = (p) => JSON.parse(readFileSync(p, 'utf8'));

export async function checkPosts(files) {
  const results = [
    ...headingResults(files, readJSON('scripts/heading-baseline.json')),
    ...categoryResults(files, parseAllowlist(readFileSync('blog/data/categories.yaml', 'utf8'))),
    ...tagResults(files, new Set(readJSON('scripts/tag-baseline.json'))),
    ...(await spellingResults(files, readJSON(SPELLING_BASELINE))),
  ];
  return report(['categories', 'headings', 'spelling', 'tags'], results);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!process.argv.includes('--json')) {
    console.error('usage: node scripts/check-posts.mjs --json [--out FILE]');
    process.exit(2);
  }
  writeReport(await checkPosts(loadContent()));
}
