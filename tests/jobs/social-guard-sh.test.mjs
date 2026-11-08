// scripts/jobs/social-guard.sh: the social guard CronJobs' entry point. Runs the real
// script in a temp copy of the repo layout with a fake `node` on PATH that logs each
// call (argv and which credentials it can see) and plays the tests and the guard; no
// network, no Buffer.
import test, { beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, copyFileSync, chmodSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

let root;
let repo;
let log;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'social-guard-sh-'));
  repo = join(root, 'website');
  log = join(root, 'node.log');
  mkdirSync(join(repo, 'scripts/jobs'), { recursive: true });
  mkdirSync(join(repo, 'tests/social'), { recursive: true });
  for (const f of ['social-guard.sh', 'lib.sh']) copyFileSync(resolve('scripts/jobs', f), join(repo, 'scripts/jobs', f));
  writeFileSync(join(repo, 'tests/social/a.test.mjs'), '');
  // Fake node: one log line per call, "<kind> <args> | buffer=<set|unset> gh=<set|unset> pg=<value>".
  // --test exits FAKE_TESTS_RC; guard.mjs exits FAKE_GUARD_RC; -e (the failure push) logs only.
  mkdirSync(join(root, 'bin'));
  writeFileSync(join(root, 'bin/node'), [
    '#!/usr/bin/env bash',
    'kind=other',
    'case "$1" in --test) kind=tests ;; -e) kind=push ;; scripts/social/guard.mjs) kind=guard ;; esac',
    'shift',
    'args="$*"; [ "$kind" = push ] && args="${*: -1}"',
    'is() { if [ -n "${!1:-}" ]; then echo set; else echo unset; fi; }',
    'echo "$kind $args | buffer=$(is BUFFER_API_KEY) gh=$(is GH_TOKEN) pg=${PUSHGATEWAY_URL:-}" >> "$FAKE_NODE_LOG"',
    'case "$kind" in tests) exit "${FAKE_TESTS_RC:-0}" ;; guard) exit "${FAKE_GUARD_RC:-0}" ;; esac',
    'exit 0',
  ].join('\n'));
  chmodSync(join(root, 'bin/node'), 0o755);
});

afterEach(() => rmSync(root, { recursive: true, force: true }));

function run(args, env = {}) {
  const r = spawnSync('bash', [join(repo, 'scripts/jobs/social-guard.sh'), ...args], {
    encoding: 'utf8',
    env: {
      PATH: `${join(root, 'bin')}:/usr/bin:/bin`, FAKE_NODE_LOG: log,
      BUFFER_API_KEY: 'buffer-key', GH_TOKEN: 'clone-token', PUSHGATEWAY_URL: 'http://pg:9091', ...env,
    },
  });
  const calls = existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').filter(Boolean) : [];
  return { code: r.status, out: `${r.stdout}${r.stderr}`, calls };
}

test('runs the social tests without credentials, then the guard with the Buffer key only', () => {
  const r = run(['preflight', '--dry-run']);
  assert.equal(r.code, 0, r.out);
  assert.deepEqual(r.calls, [
    'tests tests/social/a.test.mjs | buffer=unset gh=unset pg=',
    'guard preflight --dry-run | buffer=set gh=unset pg=http://pg:9091',
  ]);
});

test('problems found (guard exit 2) is a successful run; other codes pass through', () => {
  assert.equal(run(['check'], { FAKE_GUARD_RC: '2' }).code, 0);
  rmSync(log, { force: true });
  assert.equal(run(['promote'], { FAKE_GUARD_RC: '1' }).code, 1);
});

test('failing tests stop the guard and push success 0 for the command', () => {
  const r = run(['promote'], { FAKE_TESTS_RC: '1' });
  assert.equal(r.code, 1);
  assert.match(r.out, /social guard tests fail on main; not running promote/);
  assert.deepEqual(r.calls.map((c) => c.split(' |')[0]), ['tests tests/social/a.test.mjs', 'push promote']);
});

test('without a Pushgateway a test failure pushes nothing', () => {
  const r = run(['check'], { FAKE_TESTS_RC: '1', PUSHGATEWAY_URL: '' });
  assert.equal(r.code, 1);
  assert.equal(r.calls.length, 1);
});

test('refuses an unknown command and a missing Buffer key before running anything', () => {
  let r = run(['publish']);
  assert.equal(r.code, 1);
  assert.match(r.out, /usage: social-guard\.sh/);
  r = run(['check'], { BUFFER_API_KEY: '' });
  assert.equal(r.code, 1);
  assert.match(r.out, /missing environment: BUFFER_API_KEY/);
  assert.deepEqual(r.calls, []);
});
