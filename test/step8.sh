#!/usr/bin/env bash
# Step 8 acceptance checks (SPEC.md section 7, Step 8) that don't require a
# real Telegram-hosted file: oversized rejection (D33) and digest exclusion
# (D34). The upload-and-store-the-file check needs a real file_id from an
# actual Telegram document (getFile/downloadFile hit the real Telegram API),
# so it's verified by hand against a live conversation, same as Step 6's
# real-Anthropic-API check.
#
# Prereqs:
#   supabase start
#   supabase db reset
#   supabase functions serve --env-file .env.local --no-verify-jwt
#
# Run from the repo root: test/step8.sh
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
DIGEST_URL="${DIGEST_URL:-http://127.0.0.1:54321/functions/v1/daily-digest}"
DB_CONTAINER="${DB_CONTAINER:-supabase_db_goldfish}"
FIXTURE_DIR="test/fixtures"

BASE_UPDATE_ID=$(( $(date +%s) * 10 ))

PASS=true

sql() {
  docker exec "$DB_CONTAINER" psql -U postgres -tA -c "$1" | tr -d '[:space:]'
}

sql_file() {
  docker cp "$1" "$DB_CONTAINER:/tmp/step8.sql" >/dev/null
  docker exec "$DB_CONTAINER" psql -U postgres -d postgres -q -f /tmp/step8.sql
}

render_pdf() {
  local update_id="$1" file_id="$2" file_name="$3" file_size="$4"
  sed -e "s/__UPDATE_ID__/${update_id}/g" \
      -e "s/__ALLOWED_CHAT_ID__/${ALLOWED_CHAT_ID}/g" \
      -e "s/__FILE_ID__/${file_id}/g" \
      -e "s/__FILE_NAME__/${file_name}/g" \
      -e "s/__FILE_SIZE__/${file_size}/g" \
      "${FIXTURE_DIR}/message-with-pdf.json"
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

echo "== Check 1: a 25MB document is rejected before touching the articles table (D33) =="
UPDATE_1=$((BASE_UPDATE_ID + 1))
before_pdf_articles=$(sql "select count(*) from articles where kind = 'pdf';")
before_processed=$(sql "select count(*) from processed_updates;")
render_pdf "$UPDATE_1" "fake-oversize-file-id" "big-paper.pdf" "26214400" > "$TMP/1.json"
status=$(post "$TMP/1.json")
assert_eq "status" "$status" "200"
wait_for "select count(*) from processed_updates;" "$((before_processed + 1))" || PASS=false
sleep 0.3
assert_eq "pdf article count (unchanged, no row)" "$(sql "select count(*) from articles where kind = 'pdf';")" "$before_pdf_articles"

echo
echo "== Check 2: a PDF (kind='pdf', unread) is excluded from digest selection (D19/D34) =="
cat > "$TMP/seed.sql" <<'SQL'
insert into articles (kind, title, description, fetch_ok, status, storage_path)
values ('pdf', 'Step 8 Test PDF', null, true, 'unread', 'papers/999999.pdf');
SQL
sql_file "$TMP/seed.sql" >/dev/null
PDF_TITLE_ESCAPED='Step 8 Test PDF'

resp=$(curl -s -X POST "$DIGEST_URL")
echo "  digest response: $resp"
# The digest's own selection query is select_digest_candidates (kind='link' filter, D19).
# Confirm directly that the seeded PDF never appears in its result set.
in_candidates=$(sql "select count(*) from select_digest_candidates('00000000-0000-0000-0000-000000000001') where title = '${PDF_TITLE_ESCAPED}';")
assert_eq "seeded PDF absent from select_digest_candidates" "$in_candidates" "0"

echo
if $PASS; then
  echo "ALL CHECKS PASSED"
  exit 0
else
  echo "SOME CHECKS FAILED"
  exit 1
fi
