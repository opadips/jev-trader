#!/usr/bin/env bash
# VPS agent: the only bridge between the cloud session and the server, over GitHub. Run by
# jev-agent.timer every 5 minutes as the unprivileged user. It does three fixed things and nothing else:
#
#   1. deploy  if origin/$DEPLOY_BRANCH moved: check it out, bun install, bun test; restart the
#              recorder only if the tests pass, otherwise roll back and remember the bad commit.
#              A push that only changes documentation is checked out without tests or a restart.
#   2. report  hourly (and after every deploy): first a cheap liveness push (health, service status,
#              log tail, disk), then the analyzer and backtest over the last 24 h (the control market,
#              then each extra market's database in data/markets/), then at most one finished UTC day
#              per market not yet analyzed (kept in days/). Every heavy step has its own time
#              limit, and timings and errors go to agent.txt, so a slow step cannot silence the page.
#   3. tidy    keep the recorder logs under 50 MB
#
# It never runs commands that arrive through git other than the repo's own install and tests.
# Everything is wrapped in main() so a deploy that rewrites this file cannot corrupt the running copy.

main() {
  set -Eeuo pipefail
  REPO_DIR="${REPO_DIR:-$HOME/jev-trader}"
  REPORTS_DIR="${REPORTS_DIR:-$HOME/jev-reports}"
  DEPLOY_BRANCH="${DEPLOY_BRANCH:-vps}"
  REPORT_EVERY_MIN="${REPORT_EVERY_MIN:-60}"
  HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3101/health}"
  # reset-failed first: after repeated start failures systemd refuses a plain restart
  RESTART_CMD="${RESTART_CMD:-systemctl --user reset-failed jev-recorder jev-markets 2>/dev/null; systemctl --user restart jev-recorder jev-markets}"
  INSTALL_UNITS="${INSTALL_UNITS:-1}"
  STATUS_CMD="${STATUS_CMD:-systemctl --user status jev-recorder jev-markets jev-agent.timer --no-pager -l -n 30}"
  MARKETS_HEALTH_URL="${MARKETS_HEALTH_URL:-http://127.0.0.1:3102/health}"
  BUN="${BUN:-$HOME/.bun/bin/bun}"
  STATE_DIR="$REPO_DIR/data/agent"
  LOG_FILE="$REPO_DIR/data/recorder.log"
  mkdir -p "$STATE_DIR"

  # A run that just deployed re-executes the new version of this script (see deploy) and hands
  # over the lock it holds on fd 9.
  if [[ "${AGENT_REEXEC:-0}" != "1" ]]; then
    trap 'echo "$(date -u +%FT%TZ) line $LINENO: $BASH_COMMAND" >>"$STATE_DIR/errors.log"' ERR
  exec 9>"$STATE_DIR/lock"
    flock -n 9 || { echo "another agent run is in progress"; return 0; }
  fi

  NOW="$(date -u +%FT%TZ)"
  FORCE_REPORT="${AGENT_REEXEC:-0}"
  # every run, so units added by a deploy are installed by the new code (a deploy runs the old copy)
  install_units
  deploy
  tidy
  report
}

# Write deploy.json. Args: commit branch deployedAt result detail
deploy_record() {
  "$BUN" -e 'const [f, commit, branch, deployedAt, result, detail] = process.argv.slice(1);
    await Bun.write(f, JSON.stringify({ commit, branch, deployedAt, checkedAt: new Date().toISOString(), result, detail }, null, 2));' \
    "$STATE_DIR/deploy.json" "$@"
}

deploy() {
  cd "$REPO_DIR"
  git fetch -q origin "$DEPLOY_BRANCH"
  local target current bad deployed_at
  target="$(git rev-parse "origin/$DEPLOY_BRANCH")"
  current="$(git rev-parse HEAD)"
  bad="$(cat "$STATE_DIR/bad_commit" 2>/dev/null || true)"
  deployed_at="$(cat "$STATE_DIR/deployed_at" 2>/dev/null || echo "$NOW")"

  if [[ "$target" == "$current" ]]; then
    [[ -f "$STATE_DIR/deploy.json" ]] || deploy_record "$current" "$DEPLOY_BRANCH" "$deployed_at" "ok" "running since first start"
    return 0
  fi
  if [[ "$target" == "$bad" ]]; then
    return 0 # already failed its tests; wait for a new commit
  fi

  # A push that only touches documentation (docs/, *.md) needs no tests and no restart: the
  # recorder keeps running without a gap.
  if ! git diff --name-only "$current" "$target" | grep -qvE '^docs/|\.md$'; then
    echo "docs-only update ${target:0:7} (was ${current:0:7}): no restart"
    git checkout -q -f --detach "$target"
    deploy_record "$target" "$DEPLOY_BRANCH" "$deployed_at" "ok" "docs-only update ${target:0:7}; recorder not restarted"
    return 0
  fi

  echo "deploying ${target:0:7} (was ${current:0:7})"
  git checkout -q -f --detach "$target"
  if "$BUN" install --frozen-lockfile >"$STATE_DIR/deploy.log" 2>&1 && "$BUN" test >>"$STATE_DIR/deploy.log" 2>&1; then
    install_units
    bash -c "$RESTART_CMD"
    echo "$NOW" >"$STATE_DIR/deployed_at"
    rm -f "$STATE_DIR/bad_commit"
    deploy_record "$target" "$DEPLOY_BRANCH" "$NOW" "ok" "deployed ${target:0:7}, tests passed, recorder restarted"
    wait_healthy
    # Report with the code just deployed, not this older copy of the script.
    AGENT_REEXEC=1 exec bash "$REPO_DIR/deploy/vps-agent.sh"
  else
    local why
    why="$(tail -n 15 "$STATE_DIR/deploy.log" | tr '\n' ' ' | cut -c1-600)"
    git checkout -q -f --detach "$current"
    "$BUN" install --frozen-lockfile >/dev/null 2>&1 || true
    echo "$target" >"$STATE_DIR/bad_commit"
    deploy_record "$current" "$DEPLOY_BRANCH" "$deployed_at" "failed" "${target:0:7} failed install or tests and was rolled back; still running ${current:0:7}. ${why}"
  fi
  FORCE_REPORT=1
}

# After a restart, give the recorder up to 90 s to answer /health so the report shows it running.
wait_healthy() {
  local i
  for i in $(seq 1 "${HEALTH_WAIT_S:-90}"); do
    curl -sf --max-time 2 -o /dev/null "$HEALTH_URL" && return 0
    sleep 1
  done
  return 0
}

# Keep the systemd units in step with the repo.
install_units() {
  [[ "$INSTALL_UNITS" == "1" ]] || return 0
  local dir="$HOME/.config/systemd/user" changed=0 u
  mkdir -p "$dir"
  for u in jev-recorder.service jev-markets.service jev-agent.service jev-agent.timer; do
    if ! cmp -s "$REPO_DIR/deploy/$u" "$dir/$u"; then cp "$REPO_DIR/deploy/$u" "$dir/$u"; changed=1; fi
  done
  [[ "$changed" == "1" ]] && systemctl --user daemon-reload || true
  # a newly added service is enabled and started once; a later deliberate stop is left alone
  systemctl --user is-enabled -q jev-markets 2>/dev/null || systemctl --user enable --now -q jev-markets || true
}

tidy() {
  local f
  for f in "$LOG_FILE" "$REPO_DIR/data/markets.log"; do
    # rewritten in place: the recorders keep appending to the same file
    if [[ -f "$f" ]] && (( $(stat -c %s "$f") > 50 * 1024 * 1024 )); then
      tail -n 20000 "$f" >"$f.tmp" && cat "$f.tmp" >"$f" && rm -f "$f.tmp"
    fi
  done
}

# Remove anything that looks like a TypeSafe key, and the configured key itself.
scrub() {
  local key=""
  key="$(grep -E '^TYPESAFE_AI_API_KEY=' "$REPO_DIR/.env" 2>/dev/null | cut -d= -f2- || true)"
  if [[ -n "$key" ]]; then
    sed -E -e 's/apikey_[A-Za-z0-9_]+/[redacted]/g' -e "s/$(printf '%s' "$key" | sed 's/[^A-Za-z0-9_]/./g')/[redacted]/g"
  else
    sed -E 's/apikey_[A-Za-z0-9_]+/[redacted]/g'
  fi
}

# One heavy step with its own time limit, so a slow step cannot take the whole run (and the report)
# down with it. Output goes to $out (scrubbed); the outcome and duration go to agent.txt.
run_step() {
  local name="$1" secs="$2" out="$3"; shift 3
  local t0=$SECONDS rc
  set +e
  (cd "$REPO_DIR" && timeout "$secs" nice -n 15 "$BUN" run "$@" 2>&1) | scrub >"$REPORTS_DIR/$out"
  rc=${PIPESTATUS[0]}
  set -e
  echo "$name: $([[ $rc == 0 ]] && echo ok || { [[ $rc == 124 ]] && echo "TIMED OUT after ${secs}s" || echo "failed (exit $rc)"; }) in $((SECONDS - t0)) s" >>"$REPORTS_DIR/agent.txt"
}

# Commit whatever changed in the reports repo and push; a failed push is noted, never fatal.
push_reports() {
  cd "$REPORTS_DIR"
  git add -A
  if git commit -q -m "$1"; then
    git push -q origin HEAD || { sleep 5; git pull -q --rebase origin HEAD && git push -q origin HEAD; } || echo "$(date -u +%FT%TZ) push failed: $1" >>"$STATE_DIR/errors.log"
  fi
}

render_readme() {
  (cd "$REPO_DIR" && "$BUN" run src/profit/status.ts --report "$REPORTS_DIR/report.json" --health "$REPORTS_DIR/health.json" \
    --deploy "$REPORTS_DIR/deploy.json" --backtest "$REPORTS_DIR/backtest.json" --days-dir "$REPORTS_DIR/days" \
    --markets-dir "$REPORTS_DIR/markets" --markets-health "$REPORTS_DIR/markets-health.json" --agent "$REPORTS_DIR/agent.txt") \
    >"$REPORTS_DIR/README.md.tmp" && mv "$REPORTS_DIR/README.md.tmp" "$REPORTS_DIR/README.md"
}

report() {
  local stamp="$STATE_DIR/last_report"
  if [[ "$FORCE_REPORT" == "0" && -f "$stamp" ]] && [[ -z "$(find "$stamp" -mmin +"$((REPORT_EVERY_MIN - 1))")" ]]; then
    return 0
  fi
  cd "$REPORTS_DIR"
  git pull -q --rebase origin HEAD 2>/dev/null || true
  mkdir -p days markets

  # 1. Liveness first: cheap files, pushed before any heavy work, so the page never goes silent.
  {
    echo "run $NOW, code $(git -C "$REPO_DIR" rev-parse --short HEAD)"
    echo "disk: $(df -h "$REPO_DIR" | tail -1 | awk '{print $4 " free of " $2 " (" $5 " used)"}'), data: $(du -sh "$REPO_DIR/data" 2>/dev/null | cut -f1)"
    if [[ -s "$STATE_DIR/errors.log" ]]; then echo "recent agent errors:"; tail -n 5 "$STATE_DIR/errors.log"; fi
  } >agent.txt
  if ! curl -s --max-time 5 -o health.json "$HEALTH_URL"; then echo null >health.json; fi
  if ! curl -s --max-time 5 -o markets-health.json "$MARKETS_HEALTH_URL"; then echo null >markets-health.json; fi
  cp "$STATE_DIR/deploy.json" deploy.json 2>/dev/null || echo null >deploy.json
  if [[ -f "$LOG_FILE" ]]; then tail -n 300 "$LOG_FILE" | scrub >recorder.log; else echo "no log yet" >recorder.log; fi
  { $STATUS_CMD 2>&1 || true; } | scrub >service.txt
  [[ -f report.json ]] || echo null >report.json
  [[ -f backtest.json ]] || echo null >backtest.json
  render_readme || true
  push_reports "live $NOW"

  # 2. The last 24 h: bounded work, whatever the size of the recording.
  run_step "analyze (last 24 h)" 900 report.txt src/profit/analyze.ts --hours 24 --json-out "$REPORTS_DIR/report.json"
  run_step "backtest (last 24 h)" 900 backtest.txt src/profit/backtest-cli.ts --hours 24 --json-out "$REPORTS_DIR/backtest.json"

  # 2b. The same baseline measurements for each extra market (its own database, no tuning).
  local db slug
  for db in "$REPO_DIR"/data/markets/*.sqlite; do
    [[ -f "$db" ]] || continue
    slug="$(basename "$db" .sqlite)"
    run_step "$slug analyze (last 24 h)" 600 "markets/$slug.report.txt" src/profit/analyze.ts --db "$db" --hours 24 --json-out "$REPORTS_DIR/markets/$slug.report.json"
    run_step "$slug backtest (last 24 h)" 600 "markets/$slug.backtest.txt" src/profit/backtest-cli.ts --db "$db" --hours 24 --json-out "$REPORTS_DIR/markets/$slug.backtest.json"
  done

  # 3. Kuru market survey (which markets trade, how much, how deep), refreshed once a day.
  if [[ ! -f survey.json ]] || [[ -n "$(find survey.json -mmin +1440)" ]]; then
    run_step "market survey" 600 survey.txt src/profit/survey.ts --json-out "$REPORTS_DIR/survey.json"
  fi

  # 4. At most one finished day per run that has no stored analysis yet (kept for good in days/).
  local d
  for d in $(cd "$REPO_DIR" && timeout 300 "$BUN" run src/profit/days.ts 2>/dev/null); do
    if [[ ! -f "days/$d.report.json" ]]; then
      run_step "day $d analyze" 1200 "days/$d.report.txt" src/profit/analyze.ts --day "$d" --json-out "$REPORTS_DIR/days/$d.report.json"
      run_step "day $d backtest" 1200 "days/$d.backtest.txt" src/profit/backtest-cli.ts --day "$d" --json-out "$REPORTS_DIR/days/$d.backtest.json"
      [[ -f "days/$d.report.json" ]] || echo null >"days/$d.report.json" # a failed day is not retried forever
      break
    fi
  done
  # ... and the same for each extra market (days/<slug>/<day>.*)
  for db in "$REPO_DIR"/data/markets/*.sqlite; do
    [[ -f "$db" ]] || continue
    slug="$(basename "$db" .sqlite)"
    mkdir -p "days/$slug"
    for d in $(cd "$REPO_DIR" && timeout 300 "$BUN" run src/profit/days.ts --db "$db" 2>/dev/null); do
      if [[ ! -f "days/$slug/$d.report.json" ]]; then
        run_step "$slug day $d analyze" 1200 "days/$slug/$d.report.txt" src/profit/analyze.ts --db "$db" --day "$d" --json-out "$REPORTS_DIR/days/$slug/$d.report.json"
        run_step "$slug day $d backtest" 1200 "days/$slug/$d.backtest.txt" src/profit/backtest-cli.ts --db "$db" --day "$d" --json-out "$REPORTS_DIR/days/$slug/$d.backtest.json"
        [[ -f "days/$slug/$d.report.json" ]] || echo null >"days/$slug/$d.report.json"
        break
      fi
    done
  done

  echo "done in $((SECONDS)) s" >>agent.txt
  render_readme || true
  push_reports "status $NOW"
  touch "$stamp"
}

main "$@"
exit
