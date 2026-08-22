#!/usr/bin/env bash
# Step 5 acceptance checks (SPEC.md section 7, Step 5): reply resolution
# through sent_messages (D26), note insert, react not reply (D27).
#
# Prereqs:
#   supabase start
#   supabase db reset
#   supabase functions serve --env-file .env.local --no-verify-jwt
#
# Run from the repo root: test/step5.sh
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

WEBHOOK_URL="${WEBHOOK_URL:-http://127.0.0.1:54321/functions/v1/telegram-webhook}"
DB_CONTAINER="${DB_CONTAINER:-supabase_db_goldfish}"
FIXTURE_DIR="test/fixtures"

BASE_UPDATE_ID=$(( $(date +%s) * 10 ))

PASS=true

sql() {
  docker exec "$DB_CONTAINER" psql -U postgres -tA -c "$1" | tr -d '[:space:]'
}

sql_file() {
  docker cp "$1" "$DB_CONTAINER:/tmp/step5.sql" >/dev/null
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -q -f /tmp/step5.sql
}

render() {
  local file="$1" update_id="$2" reply_message_id="$3" replied_to_message_id="$4" text="$5"
  sed -e "s/__UPDATE_ID__/${update_id}/g" \
      -e "s/__ALLOWED_CHAT_ID__/${ALLOWED_CHAT_ID}/g" \
      -e "s/__REPLY_MESSAGE_ID__/${reply_message_id}/g" \
      -e "s/__REPLIED_TO_MESSAGE_ID__/${replied_to_message_id}/g" \
      -e "s/__TEXT__/${text}/g" \
      "${FIXTURE_DIR}/${file}"
}

post() {
  local body_file="$1"
  curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$WEBHOOK_URL" \
    -H "Content-Type: application/json" \
    -H "X-Telegram-Bot-Api-Secret-Token: ${TELEGRAM_SECRET_TOKEN}" \
    --data-binary "@${body_file}"
}

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

echo "== Setup: seed an article + a sent_messages row for it =="
cat > "$TMP/seed.sql" <<SQL
insert into articles (kind, url, url_key, domain, title, description, fetch_ok)
values ('link', 'https://step5.example/a', 'step5.example/a', 'step5.example', 'Step 5 Test Article', null, true);
insert into sent_messages (chat_id, telegram_message_id, kind, article_id)
select ${ALLOWED_CHAT_ID}, 910001, 'article', id from articles where url_key = 'step5.example/a';
SQL
sql_file "$TMP/seed.sql" >/dev/null
ARTICLE_ID=$(sql "select id from articles where url_key = 'step5.example/a';")
echo "  seeded article id ${ARTICLE_ID}"

echo
echo "== Check 1: reply to a known article message inserts a note on that article =="
UPDATE_1=$((BASE_UPDATE_ID + 1))
REPLY_MSG_1=920001
render message-reply.json "$UPDATE_1" "$REPLY_MSG_1" 910001 "Loved this one" > "$TMP/1.json"
before_notes=$(sql "select count(*) from notes;")
status=$(post "$TMP/1.json")
assert_eq "status" "$status" "200"
wait_for "select count(*) from notes;" "$((before_notes + 1))" || PASS=false
row=$(sql "select article_id || '|' || body from notes order by id desc limit 1;")
assert_eq "note row (article_id|body)" "$row" "${ARTICLE_ID}|Lovedthisone"

echo
echo "== Check 2: reply to an unknown message inserts nothing, sends nothing =="
UPDATE_2=$((BASE_UPDATE_ID + 2))
REPLY_MSG_2=920002
UNKNOWN_TARGET=999999
render message-reply.json "$UPDATE_2" "$REPLY_MSG_2" "$UNKNOWN_TARGET" "Orphan reply" > "$TMP/2.json"
before_notes=$(sql "select count(*) from notes;")
status=$(post "$TMP/2.json")
assert_eq "status" "$status" "200"
sleep 0.5
assert_eq "notes count (unchanged)" "$(sql "select count(*) from notes;")" "$before_notes"

echo
if $PASS; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
