#!/usr/bin/env bash
# VPS agent: the only bridge between the cloud session and the server, over GitHub. Run by
# jev-agent.timer every 5 minutes as the unprivileged user. It does three fixed things and nothing else:
#
#   1. deploy  if origin/$DEPLOY_BRANCH moved: check it out, bun install, bun test; restart the
#              recorder only if the tests pass, otherwise roll back and remember the bad commit
#   2. report  hourly (and after every deploy): analyzer report, /health, recorder log tail, systemd's
#              view of the services and the deploy record, plus a README status page, pushed to the
#              reports repo
#   3. tidy    keep the recorder log under 50 MB
#
# It never runs commands that arrive through git other than the repo's own install and tests.
# Everything is wrapped in main() so a deploy that rewrites this file cannot corrupt the running copy.

main() {
  set -euo pipefail
  REPO_DIR="${REPO_DIR:-$HOME/jev-trader}"
  REPORTS_DIR="${REPORTS_DIR:-$HOME/jev-reports}"
  DEPLOY_BRANCH="${DEPLOY_BRANCH:-vps}"
  REPORT_EVERY_MIN="${REPORT_EVERY_MIN:-60}"
  HEALTH_URL="${HEALTH_URL:-http://127.0.0.1:3101/health}"
  # reset-failed first: after repeated start failures systemd refuses a plain restart
  RESTART_CMD="${RESTART_CMD:-systemctl --user reset-failed jev-recorder 2>/dev/null; systemctl --user restart jev-recorder}"
  INSTALL_UNITS="${INSTALL_UNITS:-1}"
  STATUS_CMD="${STATUS_CMD:-systemctl --user status jev-recorder jev-agent.timer --no-pager -l -n 30}"
  BUN="${BUN:-$HOME/.bun/bin/bun}"
  STATE_DIR="$REPO_DIR/data/agent"
  LOG_FILE="$REPO_DIR/data/recorder.log"
  mkdir -p "$STATE_DIR"

  # A run that just deployed re-executes the new version of this script (see deploy) and hands
  # over the lock it holds on fd 9.
  if [[ "${AGENT_REEXEC:-0}" != "1" ]]; then
    exec 9>"$STATE_DIR/lock"
    flock -n 9 || { echo "another agent run is in progress"; return 0; }
  fi

  NOW="$(date -u +%FT%TZ)"
  FORCE_REPORT="${AGENT_REEXEC:-0}"
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
  for u in jev-recorder.service jev-agent.service jev-agent.timer; do
    if ! cmp -s "$REPO_DIR/deploy/$u" "$dir/$u"; then cp "$REPO_DIR/deploy/$u" "$dir/$u"; changed=1; fi
  done
  [[ "$changed" == "1" ]] && systemctl --user daemon-reload || true
}

tidy() {
  if [[ -f "$LOG_FILE" ]] && (( $(stat -c %s "$LOG_FILE") > 50 * 1024 * 1024 )); then
    tail -n 20000 "$LOG_FILE" >"$LOG_FILE.tmp" && mv "$LOG_FILE.tmp" "$LOG_FILE"
  fi
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

report() {
  local stamp="$STATE_DIR/last_report"
  if [[ "$FORCE_REPORT" == "0" && -f "$stamp" ]] && [[ -z "$(find "$stamp" -mmin +"$((REPORT_EVERY_MIN - 1))")" ]]; then
    return 0
  fi
  cd "$REPORTS_DIR"
  git pull -q --rebase origin HEAD 2>/dev/null || true

  if ! curl -s --max-time 5 -o health.json "$HEALTH_URL"; then echo null >health.json; fi
  cp "$STATE_DIR/deploy.json" deploy.json 2>/dev/null || echo null >deploy.json
  if [[ -f "$LOG_FILE" ]]; then tail -n 300 "$LOG_FILE" | scrub >recorder.log; else echo "no log yet" >recorder.log; fi
  { $STATUS_CMD 2>&1 || true; } | scrub >service.txt
  (cd "$REPO_DIR" && nice -n 15 "$BUN" run src/profit/analyze.ts --json-out "$REPORTS_DIR/report.json" 2>&1) | scrub >report.txt || true
  [[ -f report.json ]] || echo null >report.json
  (cd "$REPO_DIR" && "$BUN" run src/profit/status.ts --report "$REPORTS_DIR/report.json" --health "$REPORTS_DIR/health.json" --deploy "$REPORTS_DIR/deploy.json") >README.md

  git add -A
  if git commit -q -m "status $NOW"; then
    git push -q origin HEAD || { sleep 5; git pull -q --rebase origin HEAD && git push -q origin HEAD; }
  fi
  touch "$stamp"
}

main "$@"
exit
