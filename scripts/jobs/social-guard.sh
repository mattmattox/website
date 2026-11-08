#!/usr/bin/env bash
# In-cluster social link guards (publisher job kinds social-guard-preflight-am,
# -preflight-pm, -promote-night, -promote-am and -check): one run of scripts/social/guard.mjs,
# the work the cluster-services blog-social-guard CronJobs did until #25332 moved them
# into the publisher chart. Usage: social-guard.sh preflight|promote|check [guard args],
# for example `social-guard.sh preflight --dry-run`.
#
#   1. node --test tests/social: if main's guard code is broken, do not let it edit
#      Buffer. The tests start their own fake Buffer server, so they run without the
#      real key, the GitHub token or the Pushgateway. A failure pushes
#      blog_social_guard_success 0 for the command (alert BlogSocialGuardFailed) and
#      exits 1.
#   2. node scripts/social/guard.mjs <command> [args]. It pushes its own metrics to
#      PUSHGATEWAY_URL as job="blog_social_guard", instance=<command>. Exit 2 (problems
#      found) is already reported through those metrics, so it exits 0; any other
#      code passes through.
#
# Needs BUFFER_API_KEY. The guard reads nothing from GitHub and changes no files:
# GH_TOKEN (website-job's clone token, contents read for these jobs) is dropped first.
# Node built-ins only, so the CronJobs skip npm ci (WEBSITE_NPM_CI=0).
set -uo pipefail
cd "$(dirname "$0")/../.." || exit 1
# shellcheck source=scripts/jobs/lib.sh
. scripts/jobs/lib.sh

unset GH_TOKEN GITHUB_TOKEN
cmd="${1:-}"
case "$cmd" in
  preflight|promote|check) ;;
  *) echo "usage: social-guard.sh preflight|promote|check [guard args]" >&2; exit 1 ;;
esac
require_env BUFFER_API_KEY || exit 1

push_failed() {
  [ -n "${PUSHGATEWAY_URL:-}" ] || return 0
  node -e 'fetch(`${process.env.PUSHGATEWAY_URL}/metrics/job/blog_social_guard/instance/${process.argv[1]}`,
    {method: "PUT", body: `blog_social_guard_last_run_timestamp_seconds ${Math.floor(Date.now() / 1000)}\nblog_social_guard_success 0\n`,
     signal: AbortSignal.timeout(10000)}).catch((e) => console.error(`pushgateway: ${e.message}`))' "$cmd"
}

log="$(mktemp)"
if ! env -u BUFFER_API_KEY PUSHGATEWAY_URL= node --test tests/social/*.test.mjs >"$log" 2>&1; then
  cat "$log"
  echo "social guard tests fail on main; not running $cmd"
  push_failed
  exit 1
fi
echo "social guard tests pass"

node scripts/social/guard.mjs "$@"
rc=$?
# 2 = problems found, already pushed as metrics and alerted on; the run itself worked.
[ "$rc" -eq 2 ] && exit 0
exit "$rc"
