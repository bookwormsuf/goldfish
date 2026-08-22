#!/usr/bin/env bash
# Step 1 acceptance checks (SPEC.md section 7, Step 1).
#
# Prereqs:
#   supabase start
#   supabase db reset
#   supabase functions serve telegram-webhook --env-file .env.local --no-verify-jwt
#
# Run from the repo root: test/smoke.sh
# Safe to re-run without a db reset in between — update_ids are derived from
# the current time, not hardcoded, so a rerun never collides with a prior run's
# dedup rows.
set -uo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/.."

if [[ -f .env.local ]]; then
  set -a
  # shellcheck disable=SC1091
  source .env.local
  set +a
fi

: "${TELEGRAM_SECRET_TOKEN:?TELEGRAM_SECRET_TOKEN not set (check .env.local)}"
: "${ALLOWED_CHAT_ID:?ALLOWED_CHAT_ID not set (check .env.local)}"

FUNCTION_URL="${FUNCTION_URL:-http://127.0.0.1:54321/functions/v1/telegram-webhook}"
DB_CONTAINER="${DB_CONTAINER:-supabase_db_goldfish}"
FOREIGN_CHAT_ID=$((ALLOWED_CHAT_ID + 1))
FIXTURE_DIR="test/fixtures"

BASE_UPDATE_ID=$(( $(date +%s) * 10 ))
UPDATE_1=$((BASE_UPDATE_ID + 1))
UPDATE_2=$((BASE_UPDATE_ID + 2))
UPDATE_3=$((BASE_UPDATE_ID + 3))

PASS=true

render() {
  local file="$1" update_id="$2"
  sed -e "s/__UPDATE_ID__/${update_id}/g" \
      -e "s/__ALLOWED_CHAT_ID__/${ALLOWED_CHAT_ID}/g" \
      -e "s/__FOREIGN_CHAT_ID__/${FOREIGN_CHAT_ID}/g" \
      "${FIXTURE_DIR}/${file}"
}

post() {
  local body_file="$1" secret="$2"
  curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$FUNCTION_URL" \
    -H "Content-Type: application/json" \
    -H "X-Telegram-Bot-Api-Secret-Token: ${secret}" \
    --data-binary "@${body_file}"
}

sql() {
  docker exec "$DB_CONTAINER" psql -U postgres -tA -c "$1" | tr -d '[:space:]'
}

count_articles() { sql "select count(*) from articles;"; }
count_processed() { sql "select count(*) from processed_updates;"; }

# Polls until the query's scalar result equals $expected, or fails after
# $timeout seconds. waitUntil() processing is async, so a fixed sleep would
# either be too short (flaky) or too long (slow) — poll instead.
wait_for() {
  local query="$1" expected="$2" timeout="${3:-5}"
  local waited=0 val
  while true; do
    val=$(sql "$query")
    if [[ "$val" == "$expected" ]]; then
      return 0
    fi
    waited=$((waited + 1))
    if (( waited >= timeout * 5 )); then
      echo "  FAIL: expected '$expected', got '$val' after ${timeout}s"
      return 1
    fi
    sleep 0.2
  done
}

assert_eq() {
  local label="$1" actual="$2" expected="$3"
  if [[ "$actual" == "$expected" ]]; then
    echo "  ok: $label = $actual"
  else
    echo "  FAIL: $label = $actual, expected $expected"
    PASS=false
  fi
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "== Check 1: valid update inserts a row, returns 200 =="
render message-with-url.json "$UPDATE_1" > "$TMP/1.json"
before_articles=$(count_articles)
before_processed=$(count_processed)
status=$(post "$TMP/1.json" "$TELEGRAM_SECRET_TOKEN")
assert_eq "status" "$status" "200"
wait_for "select count(*) from articles;" "$((before_articles + 1))" || PASS=false
wait_for "select count(*) from processed_updates;" "$((before_processed + 1))" || PASS=false
row=$(sql "select url || '|' || title from articles order by id desc limit 1;")
assert_eq "saved row (url|title)" "$row" "https://example.com/article-one|example.com"

echo
echo "== Check 2: same update_id again, inserts nothing, still 200 =="
render message-with-url.json "$UPDATE_1" > "$TMP/2.json"
before_articles=$(count_articles)
before_processed=$(count_processed)
status=$(post "$TMP/2.json" "$TELEGRAM_SECRET_TOKEN")
assert_eq "status" "$status" "200"
sleep 0.5  # give the (fast, local) redelivery no-op time to run, if it were going to
assert_eq "articles count (unchanged)" "$(count_articles)" "$before_articles"
assert_eq "processed_updates count (unchanged)" "$(count_processed)" "$before_processed"

echo
echo "== Check 3: wrong secret header returns 401, inserts nothing =="
render message-with-url.json "$UPDATE_2" > "$TMP/3.json"
before_articles=$(count_articles)
before_processed=$(count_processed)
status=$(post "$TMP/3.json" "wrong-secret")
assert_eq "status" "$status" "401"
sleep 0.5
assert_eq "articles count (unchanged)" "$(count_articles)" "$before_articles"
assert_eq "processed_updates count (unchanged)" "$(count_processed)" "$before_processed"

echo
echo "== Check 4: foreign chat id returns 200, inserts no article =="
render message-foreign-chat.json "$UPDATE_3" > "$TMP/4.json"
before_articles=$(count_articles)
before_processed=$(count_processed)
status=$(post "$TMP/4.json" "$TELEGRAM_SECRET_TOKEN")
assert_eq "status" "$status" "200"
wait_for "select count(*) from processed_updates;" "$((before_processed + 1))" || PASS=false
sleep 0.3
assert_eq "articles count (unchanged)" "$(count_articles)" "$before_articles"

echo
if $PASS; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
