# Self-hosting

OpenDash ships **two container images**, `web` and `worker`. Both run on **PostgreSQL**. The same images run
everywhere, from one machine to a scaled deployment.

## 1. Shapes

| Shape | Compute | Postgres | For |
|---|---|---|---|
| **Single node** | `docker compose`: `web` + `worker` (all pools in one process) | bundled `postgres` (pgvector image) | evaluating, small teams |
| **Scaled** | several `web` replicas; workers split by `WORKER_POOLS` | external managed Postgres | larger installs |

Worker pools (`WORKER_POOLS`, comma-separated, default `all`): `query` (connection checks), `sync` (learning sources,
testing definitions) and `interactive` (agent runs and what they send, such as Slack replies). To split them, run the
worker image several times with different pools.

## 2. Run it with docker compose

```bash
git clone https://github.com/getopendash/opendash.git && cd opendash
cp infra/selfhost.env.example .env   # passwords, OPENDASH_KEK, BETTER_AUTH_*, email settings, model keys
docker compose up -d                 # postgres, setup, web, worker; add --profile caddy for HTTPS here
```

`infra/selfhost-smoke.sh` runs this stack end to end with no real keys; CI runs it on every change.

- **Services** (the root `docker-compose.yml`, project `opendash-selfhost`, apart from development's
  `infra/docker-compose.yml`): `postgres` (pgvector image, volume `pgdata`, not published), `setup` (one-shot: the
  bootstrap, migrations and queues), then `web` (127.0.0.1:3000 by default: `OPENDASH_BIND`, `OPENDASH_PORT`) and
  `worker` (`WORKER_POOLS=all`). Optionally `caddy` (`--profile caddy`).
- **Who can join:** invite-only by default (`OPENDASH_INVITE_ONLY=1`). A new instance nobody has joined takes one
  sign-up (proved with the email link): that person creates the workspace and invites everyone else. So sign up
  yourself before you share the address. `OPENDASH_INVITE_ONLY=0` lets anyone who can reach the address sign up
  and create workspaces on this server's model keys, with sources reaching its network (the community edition allows
  private addresses), so use it only on a private instance.
- **HTTPS is required.** Production sign-in accepts only an HTTPS `BETTER_AUTH_URL` and HTTPS trusted origins. Put a
  proxy with TLS in front, or use the caddy profile: a certificate for `OPENDASH_DOMAIN` from Let's Encrypt (its own
  for `localhost`). Caddy overwrites `X-Forwarded-For`, so rate limits work with nothing else to set.
- **Dashboards need an address of their own.** A dashboard's code is drawn in a sandboxed frame on another origin
  than OpenDash's, so it never runs where people's sign-in does. Point a second host at the same web app, such as
  `frames.opendash.example.com`, and set `OPENDASH_FRAMES_URL=https://frames.opendash.example.com`. The caddy profile
  serves `frames.<OPENDASH_DOMAIN>` (or `OPENDASH_FRAMES_DOMAIN`) with its own certificate: add its DNS record. The
  running server reads it, nothing is built in, so published images work on any address. Without it, dashboards say
  they can't open.
- **Boot checks.** The bootstrap names any required extension the server doesn't ship (`vector`, `pg_trgm`,
  `btree_gin`), and migrations refuse a database without them. Migrations run in `setup`, under an advisory lock,
  before `web` and `worker` start; the web image never migrates, and its health check holds the deploy until the
  database answers.
- **Sample company (optional).** `OPENDASH_SEED_DEMO=true` with `OPENDASH_DEMO_READER_PASSWORD` seeds it once, as its
  own database `opendash_demo` with a read-only `opendash_demo_reader`, to connect under Data → Connect source (host
  `postgres`). A later setup leaves it alone.
- **Secrets.** **`OPENDASH_KEK`** is the master key-encryption key for stored connection passwords and model keys.
  **Back it up**: without it they can't be recovered. `BETTER_AUTH_SECRET` signs sessions and email links.
- **Email.** Sign-up, sign-in and password reset need it. Set `EMAIL_FROM` and either `RESEND_API_KEY` (a domain verified
  in Resend) or `SMTP_URL`, any SMTP server: `smtp://user:pass@host:587` (STARTTLS) or `smtps://user:pass@host:465`.
  TLS is required unless the URL ends in `?requireTLS=false`, since sign-in links travel in these emails. Resend wins
  when both are set. SMTP has no idempotency key, so a retry after an unacknowledged send can deliver twice (the
  Message-ID is the same, so mail clients show one). In production the web app refuses to start without email, a valid
  secret, base URL and trusted origins.
- **Models.** OpenDash's own provider uses the deployment's keys: with `AI_GATEWAY_API_KEY` (Vercel AI Gateway) every
  allowed model runs through it; without one, each maker's key (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY`) runs its models. Workspaces can instead connect their own providers under Settings →
  AI: Anthropic, OpenAI, Google, Amazon Bedrock, Google Vertex AI, Vercel AI Gateway or OpenRouter. Only models
  OpenDash has measured are offered.
- **Embeddings (optional).** With `OPENAI_API_KEY` (or a workspace's own OpenAI provider), the worker embeds released
  knowledge and table names, so the analyst finds terms and guides by meaning too. Without one, nothing is sent and
  search is by words.
- **Enterprise license (optional).** `OPENDASH_LICENSE_KEY` unlocks the `ee/` features, checked offline. Owners see
  what it covers in Settings → License. A key issued for one address stops being accepted when the instance moves:
  ask for a new one before the move. See [ee/README.md](../../ee/README.md).
- **Slack (optional).** Create the app from the manifest that `pnpm slack:manifest https://<your address> --socket`
  prints (Socket Mode: Slack needs no public address for events), set `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`,
  `SLACK_SIGNING_SECRET` and an app-level token with `connections:write` as `SLACK_APP_TOKEN`, then owners and admins
  use Settings → Slack → Add to Slack. Set `SLACK_PUBLIC_URL` only when Slack must return to another HTTPS address
  than `BETTER_AUTH_URL`.
- **Help and legal links (optional).** `OPENDASH_SUPPORT_EMAIL` is the address people write to: it shows in the
  sign-in footer, the account menu, the not-found page and at the foot of every email (set it on `web` and the workers).
  `OPENDASH_DOCS_URL` and `OPENDASH_STATUS_URL` add a docs and a status link beside it; `OPENDASH_TERMS_URL`,
  `OPENDASH_PRIVACY_URL` and `OPENDASH_SECURITY_URL` the sign-up terms line and the footer's links. Each is hidden when
  empty.
- **Rate limits behind a proxy.** Set `OPENDASH_TRUSTED_PROXIES` to the proxy's addresses so per-IP limits count per
  client. Without it, a multi-entry `X-Forwarded-For` isn't trusted and those requests share one strict bucket. Don't
  expose the web app directly with no proxy: a client could send its own `X-Forwarded-For`.
- **Upgrades.** With published images (`OPENDASH_WEB_IMAGE`, `OPENDASH_WORKER_IMAGE`): `docker compose pull && docker
  compose up -d`. From a clone: `git pull && docker compose up -d --build`. Setup applies the new migrations first.
  Read the release notes for migrations and breaking changes.
- **Scaling.** Point `DATABASE_URL`, `DATABASE_DIRECT_URL` and `DATABASE_QUEUE_URL` at a managed Postgres, add `web`
  replicas, and split the workers with `WORKER_POOLS`.

## 3. PostgreSQL

**Requirements:** PostgreSQL 16, 17 or 18; the extensions `vector` (pgvector 0.7 or later), `pg_trgm` and `btree_gin`;
point-in-time recovery and daily backups for anything you care about.

**Connection URLs:**

| Variable | Mode | Used for |
|---|---|---|
| `DATABASE_URL` | **transaction pooler** is fine | app queries through `withTenant`, which sets the tenant for one transaction with `set_config(…, true)`. Use `prepare: false` with Supavisor |
| `DATABASE_DIRECT_URL` | **direct or session mode** | `LISTEN` (one connection per web or worker process) |
| `DATABASE_QUEUE_URL` | **direct or session mode**, as `opendash_queue` | pg-boss, on its own pool: workers run jobs; the web app only enqueues |

With no `LISTEN`-capable URL the web app falls back to polling `run_event` every 500 ms.

- **Neon:** use the **non-pooler** endpoint for `DATABASE_DIRECT_URL` (the `-pooler` host is PgBouncer in transaction
  mode and has no `LISTEN`), and **turn autosuspend off** in production: a suspended compute drops `LISTEN` sessions.
- **Supabase:** Supavisor **transaction mode (6543)** supports neither `LISTEN` nor prepared statements. Use **session
  mode (5432)** or a direct connection. Direct connections are IPv6 unless you buy the IPv4 add-on.
- **A certificate authority of its own** (ClickHouse Managed Postgres, Amazon RDS): add `sslmode=verify-full` to every
  URL, and give both images the CA: its PEM text as `OPENDASH_EXTRA_CA_CERTS` (for platforms without file mounts, such
  as Railway), or a mounted file named by `NODE_EXTRA_CA_CERTS`. With `sslmode=require` the connection is encrypted but
  the server isn't checked.
- **ClickHouse Managed Postgres:** port 5432 is direct (setup, `DATABASE_DIRECT_URL`, `DATABASE_QUEUE_URL`) and 6432 is
  PgBouncer in transaction mode (`DATABASE_URL` may use it). Its superuser runs the bootstrap; create the `opendash`
  database first.
- **Roles:** `opendash_owner` (migrations only), `opendash_app` (no `BYPASSRLS`), `opendash_auth`, `opendash_queue` and
  `opendash_system`. OpenDash never needs `BYPASSRLS`, which managed Postgres often won't grant.

## 4. Connecting data sources

Only the **worker** processes reach your databases and warehouses. Create a **read-only user** for each source; the
connection check tells you if the user can change data.

- **PostgreSQL, MySQL and ClickHouse** are supported. Every query runs in a read-only session with a server-side time
  limit, as the connected user.
- **ClickHouse users with `readonly = 1`** can't take any per-query setting, so OpenDash accepts one only when its server
  already sets what OpenDash would: a time limit of at most 60 s that throws, the analyzer on and UTC. If its joins
  don't return NULL (`join_use_nulls = 0`), outer joins are refused on that source. Prefer `readonly = 2` for your own
  users. This is how ClickHouse's public playground is set up, which the connect screen offers as sample data.
- **TLS.** A new PostgreSQL or MySQL source defaults to `verify-full`: the server's certificate must chain to a trusted
  CA and name the host you typed (a host typed as an IP is checked as that IP). If your own CA signed it, paste that CA's
  certificate on the connect form, and OpenDash trusts only it for that source. `require` encrypts without proving which
  server answered, and `disable` sends everything in clear text: use them only on a private network.
- **Addresses.** The community edition allows private addresses, since that's where most self-hosted databases live. To
  host OpenDash for others, set `OPENDASH_EDITION=cloud` on `web` and workers: workers then refuse private addresses.
  List the workers' fixed outbound IPs in `OPENDASH_EGRESS_IPS` (comma-separated) so the connect form can tell people
  what to allowlist.
- **Limits.** A table's sample, comments and the connection check are bounded for an honest server. A server built to
  ignore its own limits can still send more than expected, so connect only databases you trust to behave.

## 5. Operating it

- **Logs.** Both processes log JSON lines to stdout. Set `OTEL_EXPORTER_OTLP_ENDPOINT` to send traces to an
  OpenTelemetry collector (no prompts, SQL or answers are sent).
- **Product analytics (optional).** Set `POSTHOG_KEY` on `web` and `worker` to send sign-ups, the funnel's first steps,
  how questions end, each new alert (a dead letter, a stuck run), unhandled server errors and the browser's page views to a PostHog project (PostHog's EU cloud unless `POSTHOG_HOST` says
  otherwise). The browser sends to this server's `/ingest`, which relays without cookies or the client's address.
  Nothing is sent without the key. What leaves is listed in [LICENSING.md §6](LICENSING.md#6-telemetry).
- **What to watch:** queue depth and dead-letter queue size, runs active past their time budget, **missing future
  partitions** of the high-volume tables (correctness-critical: alert on it), `pg_notification_queue_usage()` above
  10%, connection counts, and per-source query failures. Each App query logs `dashboard query` with `ms.queued` (time
  in line before a worker slot took it) and `ms.slot` (time waiting for one of its source's places): a growing
  `queued` means more worker processes; a growing `slot` means a busy source. Queues someone waits on (App queries,
  questions, a number's rows, summaries) take the next job as soon as a slot frees, and each idle slot checks its
  queue every 2 s: about 12 small queries a second per worker process when idle.
- **Backups.** Back up Postgres (managed point-in-time recovery, or `pg_dump` and WAL archiving such as WAL-G) and
  `OPENDASH_KEK` separately, offline. Losing the KEK means re-entering every connection secret and model key.
- **Deleting and exporting data.** An owner deletes a workspace under Settings → Workspace (its name typed, and
  their password): its members, keys, sources, knowledge, conversations, dashboards and Slack connection go in one
  statement, and nobody can open it a moment later. Its event, query, usage and audit history (the partitioned
  tables, which no foreign key reaches) and its queued jobs are purged by the worker within about a minute, a batch at
  a time; `app.org_deletion` keeps the workspace's id and when it was deleted and purged, nothing else. Anyone deletes
  their own account under Settings → Your data: their sign-ins, sessions, keys and memberships go, a workspace only
  they were in is deleted with it, and in a workspace they leave their private conversations and dashboards are
  deleted while what they shared stays, under an id that names nobody. The only owner of a workspace others are in
  must hand it over or delete it first. Both pages also download the data as a zip (a file per table, JSON lines, a
  manifest of what's inside and what isn't): a workspace's for its owners, a person's own for themselves. Secrets are
  never in an export, and neither is another person's private work. A deletion can't be undone, and backups still
  hold the data until they expire: say so in your privacy notice, with how long you keep them.
- **Secrets** live in your environment or `.env`. They are never logged and never put in prompts.
- **Outbound calls** from tools and webhooks go through an SSRF guard, and inbound webhooks are verified by signature.

## 6. Enterprise features

Single sign-on, directory sync and the audit log's chain and exports are in `ee/` (source-available, see
[LICENSING](LICENSING.md)). Outside production they work without a key; in production they need `OPENDASH_LICENSE_KEY`
(write to hello@opendash.cloud for one), checked offline. What's set up keeps working if a key lapses.

- **Your instance's address is part of every identity provider's setup.** The redirect, assertion consumer and SCIM
  addresses are built from `BETTER_AUTH_URL`; changing it breaks every provider and directory set up against it.
  Settings → Single sign-on and Settings → Directory sync show what to paste.
- **Moving to a new address.** Point the new address at `web`, then set `BETTER_AUTH_URL` to it on `web` and the
  workers, add it to `BETTER_AUTH_TRUSTED_ORIGINS` (keep the old one while people still have it open), and put the old
  host in `OPENDASH_OLD_HOSTS`: its pages then open at the same path on the new address, while what other services call
  under `/api/` keeps working there. Set `SLACK_PUBLIC_URL` to the old address until the Slack app is created again
  from `pnpm slack:manifest https://<new address>`; update each identity provider and directory (above) and any MCP
  server whose OAuth client an admin entered (servers that registered OpenDash themselves register again). A license
  key issued for the old address needs a new one first. Everyone signs in once more on the new address.
- **Identity providers on your own network.** A provider's issuer and metadata must be https on public addresses. List
  the origin of one on your network in `OPENDASH_SSO_TRUSTED_IDP_ORIGINS` (comma-separated; http is accepted only
  outside production).
- **How often people at a required domain see their provider:** `OPENDASH_SSO_MAX_AUTH_AGE_HOURS` (12 by default).
- **Break-glass.** If a required provider fails and nobody can sign in, disable it from the server:
  `pnpm sso:disable --provider <provider id>`. Its sessions end, requiring it lifts, and people at its domain can sign
  in by email again. The audit log records it.
- **The audit log** keeps 90 days (`OPENDASH_AUDIT_RETENTION_DAYS`, up to seven years with a license that covers it).
  `pnpm audit:verify --org <organization id>` walks a workspace's chain from the server.
- **Directory tokens** are kept as digests under a key derived from `BETTER_AUTH_SECRET`: changing that secret ends
  every directory's token, and they need new ones from Settings → Directory sync.
- **Trying it.** `pnpm --filter @opendash/ee keycloak:check` starts a throwaway Keycloak in Docker and signs someone in
  through it over SAML and OIDC, against the test database.
