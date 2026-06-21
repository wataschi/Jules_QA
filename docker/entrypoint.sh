#!/bin/sh
set -e

mkdir -p \
  /app/midscene_run/plans \
  /app/midscene_run/cache \
  /app/midscene_run/report \
  /app/midscene_run/aggregate \
  /app/midscene_run/log \
  /app/.stagehand-cache \
  /app/test-results \
  /app/playwright-report \
  /app/data/runs \
  /app/data/suites

if [ -f /app/.env ]; then
  set -a
  # shellcheck disable=SC1091
  . /app/.env
  set +a
fi

exec "$@"
