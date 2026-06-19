---
name: Drizzle push/migrate drift causes startup migration failures
description: When dev uses `drizzle push` then a migration is generated for the same tables, the migrator fails with "already exists".
---

# Drizzle push → migrate drift

The API server auto-runs pending migrations on startup. During dev, schema is iterated with `drizzle push` (creates tables directly, does NOT record a migration). When a migration file is later generated to formalize those same tables, it contains plain `CREATE TABLE` / `ADD CONSTRAINT`. On the dev DB the objects already exist (from push), so the migration transaction fails with `relation "X" already exists`, rolls back, and is never marked applied — so it retries and fails on every startup, and any backfill in that migration never runs.

**Fix:** make such "formalizing" migrations idempotent: `CREATE TABLE IF NOT EXISTS`, and wrap each `ADD CONSTRAINT` in `DO $$ BEGIN ... EXCEPTION WHEN duplicate_object THEN null; END $$;`. Backfill INSERTs should already use `NOT EXISTS` guards. This makes the migration safe both on a drifted dev DB and on a fresh production DB.

**Why:** a real startup failure observed when finalizing the app; changing the migration file is safe as long as it has not yet been recorded in `drizzle.__drizzle_migrations` (the hash changes and the migrator applies the new version).

**How to apply:** whenever a generated migration covers objects that may already exist from a prior `push`, convert it to the idempotent form before relying on startup migration — especially before deploying, where the production DB state may not be pristine.
