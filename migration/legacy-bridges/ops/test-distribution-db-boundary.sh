#!/usr/bin/env bash
set -euo pipefail

# Only a local Docker engine may receive this disposable test. Neither a named
# database from another run nor the application's existing database is cleaned up.
container="${DISTRIBUTION_TEST_POSTGRES_CONTAINER:-satsang-postgres}"
engine="${DOCKER_HOST:-$(docker context inspect "$(docker context show)" --format '{{.Endpoints.docker.Host}}')}"
case "$engine" in
  unix://*) ;;
  *) echo "distribution boundary test requires a local Docker engine" >&2; exit 1 ;;
esac
run_id="$(date +%s)_$$_${RANDOM}"
database="distribution_test_${run_id}"
role="distribution_runtime_${run_id}"
database_created=false
role_created=false

cleanup() {
  # Ownership flags become true only after CREATE succeeds. A name collision
  # fails safely without dropping the preexisting resource.
  if [ "$database_created" = true ]; then
    docker exec "$container" dropdb -U satsang "$database" >/dev/null 2>&1 || true
  fi
  if [ "$role_created" = true ]; then
    docker exec "$container" psql -U satsang -d satsang -v ON_ERROR_STOP=1 \
      -c "DROP ROLE $role" >/dev/null 2>&1 || true
  fi
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

docker exec "$container" createdb -U satsang "$database"
database_created=true
for migration in packages/distribution-db/drizzle/*.sql; do
  docker exec -i "$container" psql -U satsang -d "$database" -v ON_ERROR_STOP=1 \
    < "$migration" >/dev/null
done
# The migrator owns its journal; the runtime must not read or rewrite it.
docker exec "$container" psql -U satsang -d "$database" -v ON_ERROR_STOP=1 \
  -c "CREATE TABLE public.__distribution_boundary_probe(id integer); INSERT INTO public.__distribution_boundary_probe VALUES (1); CREATE SCHEMA distribution_migrations; CREATE TABLE distribution_migrations.__distribution_migrations(id serial PRIMARY KEY, hash text NOT NULL, created_at bigint); INSERT INTO distribution_migrations.__distribution_migrations(hash,created_at) VALUES ('boundary-probe',1)" \
  >/dev/null
docker exec "$container" psql -U satsang -d "$database" -v ON_ERROR_STOP=1 \
  -c "CREATE ROLE $role NOLOGIN" >/dev/null
role_created=true
docker exec -i "$container" psql -U satsang -d "$database" -v ON_ERROR_STOP=1 \
  -v distribution_runtime_role="$role" < packages/distribution-db/ops/runtime-grants.sql >/dev/null

docker exec "$container" psql -U satsang -d "$database" -v ON_ERROR_STOP=1 \
  -c "SET ROLE $role; INSERT INTO distribution.module_state(id) VALUES ('probe'); UPDATE distribution.module_state SET schema_version=2 WHERE id='probe'; SELECT id FROM distribution.module_state WHERE id='probe'" \
  >/dev/null

expect_permission_denied() {
  local label="$1"
  local statement="$2"
  local output
  if output=$(docker exec "$container" psql -U satsang -d "$database" \
      -v ON_ERROR_STOP=1 -v VERBOSITY=verbose \
      -c "SET ROLE $role; $statement" 2>&1); then
    echo "distribution boundary failed: $label unexpectedly succeeded" >&2
    exit 1
  fi
  # A connection failure, typo, missing table or broken command is not evidence
  # of isolation. Accept only PostgreSQL insufficient_privilege (42501).
  if ! printf '%s' "$output" | rg --quiet 'ERROR:[[:space:]]+42501:'; then
    echo "distribution boundary failed: $label did not return SQLSTATE 42501" >&2
    printf '%s\n' "$output" >&2
    exit 1
  fi
}

expect_permission_denied "read core schema" 'SELECT count(*) FROM public.__distribution_boundary_probe'
expect_permission_denied "create distribution table" 'CREATE TABLE distribution.__runtime_created(id integer)'
expect_permission_denied "alter distribution table" 'ALTER TABLE distribution.module_state ADD COLUMN __runtime_altered text'
expect_permission_denied "create core table" 'CREATE TABLE public.__runtime_created(id integer)'
expect_permission_denied "create schema" 'CREATE SCHEMA __runtime_created'
expect_permission_denied "read migration journal" 'SELECT count(*) FROM distribution_migrations.__distribution_migrations'
expect_permission_denied "insert migration journal" "INSERT INTO distribution_migrations.__distribution_migrations(hash,created_at) VALUES ('forged',2)"
expect_permission_denied "update migration journal" "UPDATE distribution_migrations.__distribution_migrations SET hash='forged'"
expect_permission_denied "alter migration journal" 'ALTER TABLE distribution_migrations.__distribution_migrations ADD COLUMN __runtime_altered text'
expect_permission_denied "create migration table" 'CREATE TABLE distribution_migrations.__runtime_created(id integer)'

echo "distribution DB boundary passed: scoped SELECT/INSERT/UPDATE allowed; core access, CREATE/ALTER and migration journal denied with SQLSTATE 42501"
