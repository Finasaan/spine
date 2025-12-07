# Spine API - Finasaan Backend Service

The Spine is a Cloudflare Worker that serves as the backend API for the Finasaan application, providing financial data and services through HTTP REST endpoints.

## Database Setup

This service connects to a PostgreSQL database via Supabase. The schema is defined in `supabase/schema.sql` and `supabase/migrations/*.sql`.

### Local Development

For local development, the service connects to a local Supabase instance (Docker).

From the project root:

```bash
cd supabase
supabase start
```

2. Connect the service (use `.dev.vars`)

```bash
# create or update .dev.vars in project root
cat > .dev.vars <<'EOF'
SUPABASE_URL=http://localhost:54321
SUPABASE_KEY=<anon-or-service-key>
EOF

# load into your shell for local runs
export $(cat .dev.vars | xargs)
```

3. Run the app locally (Wrangler dev)

```bash
cd spine
npx wrangler dev
```

Local URL

- When you run `npx wrangler dev` it prints the local worker URL (`http://127.0.0.1:8787`).
- The Spine API will be available at `{LOCAL_URL}/api` (e.g. `http://127.0.0.1:8787/api/health`).

4. Generate TypeScript types (required for typed DB access)

```bash
# regenerate types from the running DB (run from project root)
./jobs/sync-db gen-types

# then sync into services
./jobs/sync-db sync
```

Why: generated types (`supabase/types/schema.ts`) provide accurate `Database` types used across services and prevent runtime type mismatches.

5. Cloudflare bindings — what & why

- Cloudflare bindings are the environment variables and secrets (e.g., `KV`, `R2`, `SUPABASE_URL`) that Workers use.
- You declare them in `wrangler.toml` or as secrets via `wrangler secret put` so the worker can access external services securely.

6. Update schema (workflow)

Option A — Manual migration (recommended):

```bash
cd supabase
supabase migration new add-company-colors
# edit the created file under supabase/migrations/*.sql and add your CREATE/ALTER statements
cd ..
./jobs/sync-db push    # apply migrations to local DB
./jobs/sync-db gen-types
./jobs/sync-db sync
```

Option B — Make change in running DB and capture diff:

```bash
# 1) connect to DB and run DDL
psql <DB_URL>
# run: CREATE TABLE ...;

# 2) capture diff
./jobs/sync-db migrate add-company-colors
# 3) review supabase/migrations and commit the new file
```

7. Commit and push migrations/types

```bash
git add supabase/migrations/* supabase/types/schema.ts
git commit -m "db(migration): add company_colors table"
git push
```

That's it — minimal, command-focused steps to get Spine running locally and keep DB schema/types in sync.
