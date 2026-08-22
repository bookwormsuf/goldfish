#!/usr/bin/env bash
# Step 1 acceptance checks (SPEC.md section 7, Step 1).
#
# Prereqs:
#   supabase start
#   supabase db reset
#   supabase functions serve telegram-webhook --env-file .env.local --no-verify-jwt
#
# Run from the repo root: test/smoke.sh
set -euo pipefail

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

counts() {
  docker exec "$DB_CONTAINER" psql -U postgres -tA -c \
    "select (select count(*) from articles), (select count(*) from processed_updates);"
}

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "== Check 1: valid update inserts a row, returns 200 =="
render message-with-url.json 1001 > "$TMP/1.json"
before=$(counts)
status=$(post "$TMP/1.json" "$TELEGRAM_SECRET_TOKEN")
sleep 1
after=$(counts)
echo "status: $status"
echo "articles,processed_updates before: $before  after: $after"

echo
echo "== Check 2: same update_id again, inserts nothing, still 200 =="
render message-with-url.json 1001 > "$TMP/2.json"
before=$(counts)
status=$(post "$TMP/2.json" "$TELEGRAM_SECRET_TOKEN")
sleep 1
after=$(counts)
echo "status: $status"
echo "articles,processed_updates before: $before  after: $after"

echo
echo "== Check 3: wrong secret header returns 401 =="
render message-with-url.json 1002 > "$TMP/3.json"
status=$(post "$TMP/3.json" "wrong-secret")
echo "status: $status"

echo
echo "== Check 4: foreign chat id returns 200, inserts nothing =="
render message-foreign-chat.json 1003 > "$TMP/4.json"
before=$(counts)
status=$(post "$TMP/4.json" "$TELEGRAM_SECRET_TOKEN")
sleep 1
after=$(counts)
echo "status: $status"
echo "articles,processed_updates before: $before  after: $after"
