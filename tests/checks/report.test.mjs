// Per-file JSON output of the content checks (scripts/lib/check-report.mjs) and
// the spell check. The spelling tests load cspell's dictionaries, no network.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { result, report, BASELINED_SUFFIX } from '../../scripts/lib/check-report.mjs';
import { fileResults as headingResults } from '../../scripts/check-headings.mjs';
import { fileResults as categoryResults } from '../../scripts/check-categories.mjs';
import { fileResults as tagResults, checkTags } from '../../scripts/check-tags.mjs';
import { misspellings, fileResult, fileResults as spellingResults } from '../../scripts/check-spelling.mjs';
import { checkPosts } from '../../scripts/check-posts.mjs';
import { maskNonProse } from '../../scripts/lib/prose.mjs';

const post = (fm, body = 'Some plain text.\n') => `---\ntitle: "T"\n${fm}---\n\n${body}`;

test('result: pass, new fail, and a fail the baseline accepts', () => {
  assert.deepEqual(result('p.md', 'x'), { path: 'p.md', check: 'x', status: 'pass', baselined: false, messages: [] });
  assert.deepEqual(result('p.md', 'x', ['bad']), { path: 'p.md', check: 'x', status: 'fail', baselined: false, messages: ['bad'] });
  const legacy = result('p.md', 'x', [], ['old']);
  assert.equal(legacy.status, 'fail');
  assert.equal(legacy.baselined, true);
  assert.deepEqual(legacy.messages, [`old${BASELINED_SUFFIX}`]);
  const mixed = result('p.md', 'x', ['new'], ['old']);
  assert.equal(mixed.baselined, false, 'a new finding makes the file a plain fail');
});

test('report: version, commit, sorted results', () => {
  const rep = report(['b', 'a'], [result('z.md', 'a'), result('a.md', 'b'), result('a.md', 'a')], { commit: 'abc', now: new Date('2026-11-08T00:00:00Z') });
  assert.equal(rep.version, 1);
  assert.equal(rep.commit, 'abc');
  assert.equal(rep.generated_at, '2026-11-08T00:00:00.000Z');
  assert.deepEqual(rep.results.map((r) => `${r.path}:${r.check}`), ['a.md:a', 'a.md:b', 'z.md:a']);
});

test('headings: a baselined file that still violates is a baseline-accepted fail', () => {
  const bad = post('', '## A\n\n#### B\n');
  const [legacy, fresh, clean] = headingResults([['old.md', bad], ['new.md', bad], ['ok.md', post('')]], ['old.md']);
  assert.equal(legacy.status, 'fail');
  assert.equal(legacy.baselined, true);
  assert.match(legacy.messages[0], /skips from H2/);
  assert.equal(fresh.status, 'fail');
  assert.equal(fresh.baselined, false);
  assert.equal(clean.status, 'pass');
});

test('categories: one result per file, no baseline', () => {
  const [ok, bad] = categoryResults([['a.md', post('categories: ["Kubernetes"]\n')], ['b.md', post('categories: ["Nope"]\n')]], ['Kubernetes']);
  assert.equal(ok.status, 'pass');
  assert.equal(bad.status, 'fail');
  assert.equal(bad.baselined, false);
  assert.match(bad.messages[0], /"Nope" is not in/);
});

test('tags: known single-use tags are baseline-accepted fails; new ones fail; shared tags pass', () => {
  const files = [
    ['a.md', post('tags: ["shared", "legacy-one"]\n')],
    ['b.md', post('tags: ["shared", "brand-new"]\n')],
    ['c.md', post('tags: ["shared"]\n')],
  ];
  const known = new Set(['shared', 'legacy-one']);
  const [a, b, c] = tagResults(files, known);
  assert.equal(a.status, 'fail');
  assert.equal(a.baselined, true);
  assert.match(a.messages[0], /"legacy-one" is used by no other post/);
  assert.equal(b.status, 'fail');
  assert.equal(b.baselined, false);
  assert.equal(c.status, 'pass');
  // CI behaviour is unchanged: only the new tag fails.
  assert.deepEqual(checkTags(files, known).map((f) => f.split(':')[0]), ['b.md']);
});

test('prose mask keeps line numbers and blanks code, links and other frontmatter', () => {
  const text = '---\ntitle: "Helo"\nurl: "/zzqx/"\n---\nSee `zzqx` and [docs](https://zzqx.example/a).\n\n```\nzzqx\n```\n\n    zzqx indented\n\n{{< zzqx >}} Plain\n';
  const masked = maskNonProse(text);
  assert.equal(masked.split('\n').length, text.split('\n').length);
  assert.equal(masked.length, text.length);
  assert.doesNotMatch(masked, /zzqx/);
  assert.match(masked, /Helo/);
  assert.match(masked, /See/);
  assert.match(masked, /docs/);
  assert.match(masked, /Plain/);
});

test('spelling: finds a misspelling in prose with its line, not in code', async () => {
  const found = await misspellings('x.md', post('', 'This is mispeled.\n\n```\nnotaword_xq\n```\n\nRun `kubectl`.\n'));
  assert.deepEqual(found, [{ word: 'mispeled', lines: [5] }]);
});

test('spelling: the title is checked; site terms, British English and spellcheck_ignore pass', async () => {
  const text = '---\ntitle: "Velero colour Grafana"\nspellcheck_ignore: ["Zorblax"]\n---\n\nZorblax and zorblax are fine here, Qwertyuiopz is not.\n';
  const found = await misspellings('x.md', text);
  assert.deepEqual(found.map((f) => f.word), ['Qwertyuiopz']);
});

test('spelling: baseline accepts only the listed words of that file', () => {
  const found = [{ word: 'teh', lines: [3] }, { word: 'recieve', lines: [4, 9] }];
  const legacy = fileResult('a.md', found, { 'a.md': ['teh', 'recieve'] });
  assert.equal(legacy.status, 'fail');
  assert.equal(legacy.baselined, true);
  assert.deepEqual(legacy.messages, [`unknown word "teh" (line 3)${BASELINED_SUFFIX}`, `unknown word "recieve" (lines 4, 9)${BASELINED_SUFFIX}`]);
  const partly = fileResult('a.md', found, { 'a.md': ['teh'] });
  assert.equal(partly.baselined, false);
  assert.equal(fileResult('b.md', found, { 'a.md': ['teh', 'recieve'] }).baselined, false);
  assert.equal(fileResult('c.md', []).status, 'pass');
});

test('spelling: fileResults reads files and applies the baseline', async () => {
  const [r] = await spellingResults([['a.md', post('', 'A mispeled word.\n')]], { 'a.md': ['mispeled'] });
  assert.equal(r.check, 'spelling');
  assert.equal(r.baselined, true);
});

test('check-posts: one result per file and check', async () => {
  const rep = await checkPosts([['blog/content/post/x.md', post('categories: ["Kubernetes"]\ntags: ["kubernetes"]\n')]]);
  assert.deepEqual(rep.checks, ['categories', 'headings', 'spelling', 'tags']);
  assert.deepEqual(rep.results.map((r) => `${r.check}:${r.status}`), ['categories:pass', 'headings:pass', 'spelling:pass', 'tags:fail']);
});

test('the spelling baseline only names files that exist and words as found', () => {
  const baseline = JSON.parse(readFileSync('scripts/spelling-baseline.json', 'utf8'));
  for (const [path, words] of Object.entries(baseline)) {
    const text = readFileSync(path, 'utf8');
    for (const w of words) assert.ok(text.includes(w), `${path} no longer contains "${w}"; drop it from the baseline`);
  }
});
