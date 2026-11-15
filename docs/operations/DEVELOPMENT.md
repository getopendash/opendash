# Development guide

How to run OpenDash on your machine, the commands you'll use, and what CI checks. For the rules the code follows, see
[AGENTS.md](../../AGENTS.md); for the shape of the system, [ARCHITECTURE.md](../../ARCHITECTURE.md).

## 1. Prerequisites

| Tool | Version | Notes |
|---|---|---|
| Node.js | **24 LTS** (`.nvmrc`: 24.16.0) | `nvm use`; `engines` requires ≥ 24.11 |
| pnpm | 11.5.1, pinned in `packageManager` | run `corepack enable` once |
| Docker | Compose v2 | Postgres 17 with pgvector on `127.0.0.1:5444` (5432 is often taken by other projects) |
| git | any recent | commits are signed off (`git commit -s`, the DCO) |

## 2. First run

```bash
corepack enable && pnpm install
cp .env.example .env.local   # then set BETTER_AUTH_SECRET and OPENDASH_KEK: `openssl rand -base64 32` for each
pnpm dx
```

`pnpm dx` checks your setup (`pnpm dev:doctor`), installs, starts Postgres (`pnpm db:up`), creates the database roles
(`pnpm db:bootstrap`), runs migrations (`pnpm db:migrate`, which also installs the job queues), and starts the web app
and the worker. Every step can be re-run safely.

Then open <http://localhost:3000/sign-up>, sign up with a name and email, open the link (without an email provider,
development prints each link in the web server's log), choose a password, and create an organization. A new workspace
opens on the guided setup (`/get-started`): **Use sample data** connects ClickHouse's public playground in one press,
and the model step asks for a provider's key when `.env.local` has none.

- **A sample company:** `pnpm demo:seed` creates **Acme**, the DashBench `dash-saas` dataset, as its own database
  `opendash_demo` with a read-only user `opendash_demo_reader` (password `opendash-demo` locally). It is a database like
  any customer's: connect it under Data → Connect source (the command prints the details). The connection check
  recognises it and marks it "Sample data". `pnpm demo:seed --clickhouse` and `--mysql` seed the same company in those
  databases (start them with `pnpm clickhouse:up` / `pnpm mysql:up`).
- **A second sample company:** `pnpm demo:seed --commerce` creates **Lumen**, a home-lighting brand (about 125,000
  orders, returns and refunds, campaigns, sessions, warehouse stock and support tickets, in USD, EUR, GBP and CAD), as
  its own database `opendash_demo_lumen` with a read-only user `opendash_lumen_reader`. Its data runs to the end of
  yesterday (UTC); `--as-of YYYY-MM-DD` gives another end date (for the same date the data is the same). Its storylines
  sit on fixed dates, so they hold for any end date after October 2026.
- **Public sample data:** Data → Connect source → **Use the playground** connects ClickHouse's public playground
  (`play.clickhouse.com`, user `explorer`, no password): house prices, GitHub events, taxi trips and more. It needs
  internet access, and you choose which tables to learn.
- **Real email:** put `RESEND_API_KEY` and `EMAIL_FROM` (or `SMTP_URL`) in `.env.local`. To try Resend without emailing
  anyone, send to `delivered@resend.dev`.
- **A model:** the analyst needs a provider. Put a key in `.env.local` (`ANTHROPIC_API_KEY`, `OPENAI_API_KEY`,
  `GOOGLE_GENERATIVE_AI_API_KEY` or `AI_GATEWAY_API_KEY`), or add one for the workspace under Settings → AI.
- **Env precedence** (`scripts/load-env.mjs`): the real environment, then `.env.local`, then `.env`. Empty values never
  win, so a blank line copied from `.env.example` can't hide a real value.
- **Port:** the web app listens on `PORT` (default 3000). Set `PORT=3010` if something else has 3000.
- **Stuck workspace:** `pnpm auth:repair` finishes setting up any organization left without its data key.

### Toolchain notes

- **TypeScript is pinned to 6.0.3, not 7.** Next.js 16's built-in type check needs TypeScript's JavaScript API; the
  native compiler of TypeScript 7 only works behind Next's experimental `useTypeScriptCli`.
- **pnpm 11 runs no install scripts by default.** The approved ones are listed under `allowBuilds` in
  `pnpm-workspace.yaml`.
- **pnpm 11 refuses versions published very recently** (a minimum release age). Pick an older patch rather than adding
  an exclusion.
- **Security patches are pinned** in `pnpm-workspace.yaml` under `overrides`, so one version of each is installed.

## 3. Everyday commands

| Command | What it does |
|---|---|
| `pnpm dev` | runs the web app and the worker in watch mode (Turborepo) |
| `pnpm lint` / `pnpm lint:fix` | Biome lint and format (no ESLint or Prettier) |
| `pnpm typecheck` | strict TypeScript across the workspace |
| `pnpm test` | Vitest unit and integration tests; integration tests use the compose Postgres (`pnpm db:up`) |
| `pnpm e2e` | the end-to-end browser tests (`apps/web/e2e`, Playwright): signing up, a workspace, connecting the sample database, in Chromium against a web app and worker it starts on a database of their own (`opendash_e2e`). Needs `pnpm db:up` and `pnpm mail:up`, and your own `pnpm dev` stopped. `pnpm e2e --serve` leaves the instance up to write a test against; `E2E_MODEL=1 pnpm e2e` also asks a question of the real model (it spends); `E2E_PLAYGROUND=1 pnpm e2e` also connects the sample data in one press (it reaches ClickHouse's public playground); `pnpm e2e -- --headed` passes options on. The first time: `pnpm --filter @opendash/web exec playwright install chromium` |
| `pnpm build` | builds every package and the web app |
| `pnpm check:links` | checks relative links in the Markdown files |
| `pnpm check:licenses` | checks every dependency's licence against the policy in [LICENSING](LICENSING.md) |
| `pnpm email:logo` | redraws the logo emails show (`apps/web/public/email/`) from the app's logo |
| `pnpm license:keygen` / `pnpm license:issue` | the licensor's tool for Enterprise license keys ([ee/README](../../ee/README.md)) |
| `pnpm db:up` / `pnpm db:down` | start or stop the development databases (`infra/docker-compose.yml`) |
| `pnpm db:migrate` | applies the SQL migrations in `packages/db/migrations` and installs the job queues |
| `pnpm dev:doctor` | checks Node, pnpm, Docker, ports and required settings, with a fix hint for each |
| `pnpm ask "question"` | asks the analyst about a learned source in your local database and prints the run as it goes: thinking, SQL, results, the gate's problems, the answer. Runs in this process; needs a model key |
| `pnpm golden` | the golden set: 21 questions about the sample company, asked of the real model and graded against answers computed from the data. About 90 model calls, so on demand rather than in CI |
| `pnpm evals` | the DashBench run ([DASHBENCH](../evals/DASHBENCH.md)) |
| `pnpm slack:manifest` / `pnpm slack:tunnel` | the Slack app manifest for your address, or for a local tunnel |

**Tests that need other databases.** ClickHouse and MySQL tests skip with a notice unless the databases are running
(`pnpm clickhouse:up`, `pnpm mysql:up`; or point `TEST_CLICKHOUSE_ADMIN_URL` / `TEST_MYSQL_ADMIN_URL` elsewhere). CI
starts both, and with `CI` set a missing server fails these tests instead of skipping them. Each test file creates its
own databases, so run single files while iterating on a shared development Postgres.

## 4. Conventions

[AGENTS.md](../../AGENTS.md) has the invariants (tenancy, numbers, durability, the agent runtime, the design system).
In short:

- TypeScript strict, ESM, Node 24. Files in kebab-case; React components in PascalCase. Biome only.
- **Only `withTenant(ctx, fn)` touches tenant data.** Importing the raw database handle is lint-banned. Never hold a
  transaction open across a model call or a warehouse query.
- **New tables** use the `(org_id, id)` primary key with composite foreign keys and row-level security policies for
  both app roles; the tenancy test suite checks it. High-volume tables are partitioned, with future partitions
  pre-created.
- **Migrations** are forward-only and must work with the previous version running, so rolling deploys are safe. Long
  backfills run as background jobs.
- **Pinned exact versions:** the AI SDK (`ai` and every `@ai-sdk/*` package), Better Auth and pg-boss. Upgrades get
  their own PRs.
- **New runtime dependencies** must pass the licence rule ([LICENSING](LICENSING.md)).
- **Secrets** are never logged, never put in prompts, and never returned to the client.

## 5. CI

`.github/workflows/ci.yml` runs on every pull request and push to `main`, against a pgvector Postgres service:

1. `pnpm lint`: Biome, including the design-system and raw-database rules
2. `pnpm typecheck`
3. `pnpm check:licenses`: every dependency's licence against the allowlist
4. `pnpm test`: unit tests, the tenancy suite (every tenant table has its policies and cross-organization access is
   denied), theme contrast and token freshness
5. `pnpm e2e`: the end-to-end browser tests, with a mail sink for the sign-up link and no model key (the test that asks
   a question is skipped)
6. `pnpm build`
7. `pnpm check:links`

`.github/workflows/images.yml` builds both images and runs the self-host smoke test (`infra/selfhost-smoke.sh`: the
stack with Caddy, setup, health over HTTPS, the sign-in page, the worker, and a sign-up through a mail sink) on every
change. On `main` and `v*` tags it publishes `opendash-web` and `opendash-worker` to GHCR.

`.github/workflows/evals.yml` asks DashBench's PR subset (10 questions, the real analyst on Haiku, a few cents) on a
pull request that touches the agent, the core, the connectors or the evals, and puts the score on the run's summary. It
needs the repository secret `ANTHROPIC_API_KEY`; without it (a fork's pull request) it says so and passes, and a
maintainer runs `pnpm evals --subset pr`. The whole set stays on demand: run `pnpm golden` or `pnpm evals` yourself
for a larger change to prompts, tools, retrieval, the compiler or the answer gate, and include the score change in your
pull request.

## 6. Troubleshooting

| Symptom | Likely cause | Fix |
|---|---|---|
| Streams never update | `LISTEN` going through a transaction pooler | use `DATABASE_DIRECT_URL` (direct or session mode); see [HOSTING](HOSTING.md) |
| `extension "vector" does not exist` | the Postgres image lacks pgvector | use a pgvector image (e.g. `pgvector/pgvector:pg17`) |
| Queries return nothing under a correct-looking organization | the tenant context isn't set | run inside `withTenant`; check `app.org_id()` |
| Port 3000 in use | another local app | set `PORT=3010` |
| "No worker has picked up the check yet" when connecting a source | only the web app is running | run `pnpm dev` (web and worker), or `pnpm --filter @opendash/worker dev` next to the web app |
| `relation "pgboss.job" does not exist` | the queues aren't installed | `pnpm db:migrate` (it installs them), or start a worker |
