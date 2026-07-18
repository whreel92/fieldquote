#!/bin/sh
# Run the RLS isolation suite against a throwaway Postgres 15 container.
# Usage: sh scripts/test_rls.sh   (from apps/api)
set -e

CONTAINER=fq-rls-test
PORT="${FQ_RLS_PORT:-55432}"

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
docker run -d --rm --name "$CONTAINER" -e POSTGRES_PASSWORD=postgres \
  -p "$PORT:5432" postgres:15-alpine >/dev/null

echo "waiting for postgres..."
for i in $(seq 1 30); do
  if docker exec "$CONTAINER" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done

export FQ_RLS_DB_URL="postgresql+psycopg://postgres:postgres@localhost:$PORT/postgres"
uv run pytest -m rls -q
STATUS=$?

docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
exit $STATUS
