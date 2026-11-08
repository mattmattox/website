// Per-file JSON output shared by the content checks (check-headings, check-tags,
// check-categories, check-spelling) and their runner, check-posts.mjs. The
// publisher console ingests it into check_results (one row per post and check).
//
// Shape (version 1):
//   {
//     "version": 1,
//     "commit": "<git sha or null>",
//     "generated_at": "<ISO 8601 UTC>",
//     "checks": ["headings", ...],
//     "results": [
//       { "path": "blog/content/post/x.md", "check": "headings",
//         "status": "pass" | "fail", "baselined": false, "messages": ["..."] }
//     ]
//   }
//
// status is "fail" whenever the file has a finding, including findings a
// baseline accepts; baselined is true when every finding is baseline-accepted
// (CI passes such a file). messages ending in BASELINED_SUFFIX are the
// accepted ones.
import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, relative } from 'node:path';

export const REPORT_VERSION = 1;
export const BASELINED_SUFFIX = ' (baseline-accepted)';

// result builds one file's entry from its new and baseline-accepted findings.
export function result(path, check, failures = [], accepted = []) {
  const failed = failures.length + accepted.length > 0;
  return {
    path,
    check,
    status: failed ? 'fail' : 'pass',
    baselined: failed && failures.length === 0,
    messages: [...failures, ...accepted.map((m) => m + BASELINED_SUFFIX)],
  };
}

function gitCommit() {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

export function report(checks, results, { commit = gitCommit(), now = new Date() } = {}) {
  return {
    version: REPORT_VERSION,
    commit,
    generated_at: now.toISOString(),
    checks: [...checks],
    results: [...results].sort((a, b) => a.path.localeCompare(b.path) || a.check.localeCompare(b.check)),
  };
}

// argValue returns the value after flag in argv ("--out FILE"), or null.
export function argValue(argv, flag) {
  const i = argv.indexOf(flag);
  return i !== -1 && i + 1 < argv.length ? argv[i + 1] : null;
}

// writeReport prints the report as JSON, or writes it to --out FILE.
export function writeReport(rep, argv = process.argv) {
  const body = `${JSON.stringify(rep, null, 2)}\n`;
  const out = argValue(argv, '--out');
  if (out) writeFileSync(out, body);
  else process.stdout.write(body);
}

function walk(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.name.endsWith('.md')) out.push(p);
  }
  return out;
}

// loadContent returns [path, text] for every Markdown file under dir, sorted,
// with repository-relative forward-slash paths.
export function loadContent(dir = 'blog/content') {
  return walk(dir).sort().map((p) => [relative('.', p).split('\\').join('/'), readFileSync(p, 'utf8')]);
}
