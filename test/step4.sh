#!/usr/bin/env bash
# Step 4 acceptance checks (SPEC.md section 7, Step 4): callback handling
# (D23, D24), one-way status transitions (D25), backoff (D18).
#
# Prereqs:
#   supabase start
#   supabase db reset
#   supabase functions serve --env-file .env.local --no-verify-jwt
#
# Run from the repo root: test/step4.sh
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
: "${DIGEST_CRON_SECRET:?DIGEST_CRON_SECRET not set (check .env.local)}"

WEBHOOK_URL="${WEBHOOK_URL:-http://127.0.0.1:54321/functions/v1/telegram-webhook}"
DIGEST_URL="${DIGEST_URL:-http://127.0.0.1:54321/functions/v1/daily-digest}"
DB_CONTAINER="${DB_CONTAINER:-supabase_db_goldfish}"
FIXTURE_DIR="test/fixtures"

BASE_UPDATE_ID=$(( $(date +%s) * 10 ))

PASS=true

sql() {
  docker exec "$DB_CONTAINER" psql -U postgres -tA -c "$1" | tr -d '[:space:]'
}

# Runs a multi-statement SQL block through a file so `sql()`'s single -c
# stays simple. Never echoes the block (it carries ALLOWED_CHAT_ID).
sql_file() {
  docker cp "$1" "$DB_CONTAINER:/tmp/step4.sql" >/dev/null
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -q -f /tmp/step4.sql
}

render() {
  local file="$1" update_id="$2" callback_id="$3" message_id="$4" callback_data="$5"
  sed -e "s/__UPDATE_ID__/${update_id}/g" \
      -e "s/__ALLOWED_CHAT_ID__/${ALLOWED_CHAT_ID}/g" \
      -e "s/__CALLBACK_ID__/${callback_id}/g" \
      -e "s/__MESSAGE_ID__/${message_id}/g" \
      -e "s/__CALLBACK_DATA__/${callback_data}/g" \
      "${FIXTURE_DIR}/${file}"
}

post() {
  local url="$1" body_file="$2"
  curl -s -o /dev/null -w "%{http_code}" \
    -X POST "$url" \
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
values ('link', 'https://step4.example/a', 'step4.example/a', 'step4.example', 'Step 4 Test Article', null, true);
insert into sent_messages (chat_id, telegram_message_id, kind, article_id)
select ${ALLOWED_CHAT_ID}, 900001, 'article', id from articles where url_key = 'step4.example/a';
SQL
sql_file "$TMP/seed.sql" >/dev/null
ARTICLE_ID=$(sql "select id from articles where url_key = 'step4.example/a';")
echo "  seeded article id ${ARTICLE_ID}"

echo
echo "== Check 1: r:<id> callback marks the article read =="
UPDATE_1=$((BASE_UPDATE_ID + 1))
render callback-query.json "$UPDATE_1" "cb-${UPDATE_1}" "900001" "r:${ARTICLE_ID}" > "$TMP/1.json"
status=$(post "$WEBHOOK_URL" "$TMP/1.json")
assert_eq "status" "$status" "200"
wait_for "select status from articles where id = ${ARTICLE_ID};" "read" || PASS=false
resolved=$(sql "select (resolved_at is not null) from articles where id = ${ARTICLE_ID};")
assert_eq "resolved_at set" "$resolved" "t"

echo
echo "== Check 2: one-way transition — a second r: callback on the same article is a no-op (D25) =="
UPDATE_2=$((BASE_UPDATE_ID + 2))
resolved_before=$(sql "select resolved_at from articles where id = ${ARTICLE_ID};")
render callback-query.json "$UPDATE_2" "cb-${UPDATE_2}" "900001" "r:${ARTICLE_ID}" > "$TMP/2.json"
status=$(post "$WEBHOOK_URL" "$TMP/2.json")
assert_eq "status" "$status" "200"
sleep 0.5
resolved_after=$(sql "select resolved_at from articles where id = ${ARTICLE_ID};")
assert_eq "resolved_at unchanged" "$resolved_after" "$resolved_before"
assert_eq "status still read" "$(sql "select status from articles where id = ${ARTICLE_ID};")" "read"

echo
echo "== Check 3: noop callback is a pure ack, touches nothing =="
UPDATE_3=$((BASE_UPDATE_ID + 3))
render callback-query.json "$UPDATE_3" "cb-${UPDATE_3}" "900001" "noop" > "$TMP/3.json"
status=$(post "$WEBHOOK_URL" "$TMP/3.json")
assert_eq "status" "$status" "200"
sleep 0.3
assert_eq "status still read" "$(sql "select status from articles where id = ${ARTICLE_ID};")" "read"

echo
echo "== Check 4: backoff — two deliveries, all items unread, digest writes nothing (D18) =="
cat > "$TMP/backoff_seed.sql" <<'SQL'
insert into articles (kind, url, url_key, domain, title, fetch_ok)
values
  ('link', 'https://step4.example/b1', 'step4.example/b1', 'b1.example', 'Backoff 1', true),
  ('link', 'https://step4.example/b2', 'step4.example/b2', 'b2.example', 'Backoff 2', true);

insert into deliveries (sent_on, sent_at) values (current_date - 2, now() - interval '2 days');
insert into deliveries (sent_on, sent_at) values (current_date - 1, now() - interval '1 day');

insert into delivery_items (delivery_id, article_id, position)
select d.id, a.id, 1
from deliveries d, articles a
where d.sent_on = current_date - 2 and a.url_key = 'step4.example/b1';

insert into delivery_items (delivery_id, article_id, position)
select d.id, a.id, 1
from deliveries d, articles a
where d.sent_on = current_date - 1 and a.url_key = 'step4.example/b2';
SQL
sql_file "$TMP/backoff_seed.sql" >/dev/null

deliveries_before=$(sql "select count(*) from deliveries;")
resp=$(curl -s -X POST "$DIGEST_URL" -H "Authorization: Bearer ${DIGEST_CRON_SECRET}")
echo "  digest response: $resp"
deliveries_after=$(sql "select count(*) from deliveries;")
assert_eq "response mentions backoff" "$(echo "$resp" | grep -o '"backoff":true')" '"backoff":true'
assert_eq "deliveries count unchanged" "$deliveries_after" "$deliveries_before"

echo
if $PASS; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
