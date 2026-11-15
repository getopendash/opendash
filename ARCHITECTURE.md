# OpenDash architecture

One page: what runs, how the pieces fit, and why. The code is the detail.

## Shape

Two application images and one stateful dependency. The customer's own warehouse holds the analytical data; OpenDash
keeps only what it needs to run (conversations, definitions, results and jobs) in Postgres.

```
Browser ──HTTPS──► web (Next.js 16: UI · oRPC API · Better Auth · SSE · webhooks)
   ▲  SSE ◄── 1 LISTEN conn per web instance ◄── pg_notify (ids only) ──┐
   │                                                                     │
   │   PostgreSQL 16/17                                                  │
   │   app schema (RLS) · auth schema · pgboss schema                    │
   │   pgvector · tsvector · pg_trgm · btree_gin · uuidv7 partitions     │
   │                                                                     ▲
   └── worker (one image; WORKER_POOLS selects pools; self-host runs all)
        agent runs · query gateway + semantic compiler · routines · syncs · delivery · exports
          ├──► customer databases / warehouses (read-only users)
          ├──► model providers, through AI SDK provider packages
          └──► Slack · email
```

## Ideas that shape the code

- **Numbers are references.** The agent cites cells of recorded query runs, and a deterministic answer gate resolves
  and recomputes every claim. No model decides whether a figure is right.
- **A governed path first.** Verified query, then metric query, then SQL over datasets, then raw SQL (labelled, and
  always cross-checked). Datasets and metrics are authored in a small YAML shape and compiled to SQL by our own
  compiler, which only joins many-to-one so a fan-out can't happen.
- **Context is versioned.** Glossary terms, guides, verified queries and skills are items with immutable versions.
  Anything learned from users reaches shared scope only through a proposal that is checked, tested and reviewed.
- **Durability lives in the data model.** The transcript in Postgres is canonical. pg-boss is the only liveness
  authority, each attempt is fenced by its number, tool calls are recorded, and side effects go through an idempotent
  outbox. Long waits are rows, not sleeping jobs.
- **Postgres does everything stateful.** Data, search (full text, trigram and vectors), jobs, and change
  notification. There is no other store to run.
- **Tenancy by construction.** Every tenant table is keyed by `(org_id, id)`, has row-level security, and is reached only
  through `withTenant`, which sets the tenant for one transaction. The app role can't bypass it.
- **Only workers reach customer databases.** Connections go to a vetted address, as read-only sessions with server-side
  time limits.
- **One engine, many surfaces.** The web app, Slack, routines and the API run the same agent loop (AI SDK
  `ToolLoopAgent`, driven by our run ledger).

## Request paths

1. **Ask.** `web` saves the message and the run and enqueues it. A worker claims the run, rebuilds the messages from
   Postgres, runs the agent loop and its tools (search, metric and SQL queries through the gateway), and the answer goes
   through the answer gate. Events are written to `run_event`, announced with NOTIFY, and streamed to the browser.
2. **Dashboards.** A dashboard is an App: a definition of named queries and filters, and the App's own code, drawn in a
   sandboxed frame on an origin of its own. The frame asks for a query by its id; the server checks it, runs it as the viewer under
   row-level security, and caches the result by the complete bound query.
3. **Routines.** A dispatcher finds due routines, and a metric check that finds something starts the routines
   watching it. Each run's action produces an answer or a digest, and an outbox row per person and channel sends it
   once, by email or in Slack.

## Repository layout

```
apps/web             Next.js UI, oRPC API, SSE, Better Auth, webhooks
apps/worker          the worker: agent runs, connection checks, syncs, routines, delivery
packages/db          Drizzle schema, RLS policies, partitions, SECURITY DEFINER functions
packages/auth        Better Auth setup, organizations, API keys, tenant resolution
packages/core        tenancy, context, semantic compiler, query gateway, routines, learning, answer gate
packages/agent       the agent adapter, profiles, tools, prompts, the virtual context filesystem
packages/apps        the sandboxed frame runtime dashboards are drawn in, its bridge and checks
packages/connectors  PostgreSQL, MySQL and ClickHouse drivers, with per-dialect safety
packages/slack       the Slack bot and replies
packages/email       transactional and routine email templates
packages/pdf         answer PDFs
packages/ui          the design system (HeroUI-based) and its tokens
packages/evals       DashBench: generators, questions, graders
infra/               docker compose files, Caddy, the self-host smoke test
ee/                  enterprise features (OCVSAL): the license gate; only the apps' enterprise.ts import it
```

## Stack

| Layer | Choice |
|---|---|
| Runtime | Node 24 · pnpm + Turborepo · Biome · Vitest |
| Web | Next.js 16 · React 19 · Tailwind 4 · HeroUI · oRPC |
| Auth | Better Auth (organizations, API keys) |
| Agent | AI SDK 7 (`ToolLoopAgent`) with provider packages for Anthropic, OpenAI, Google, Bedrock, Vertex, OpenRouter and the Vercel AI Gateway |
| Documents | Apache ECharts · `@react-pdf/renderer` |
| Data | PostgreSQL · Drizzle · pgvector · pg-boss |
| Integrations | Chat SDK (Slack) · Resend or SMTP for email |

See [AGENTS.md](AGENTS.md) for the rules the code follows, and [the development guide](docs/operations/DEVELOPMENT.md)
to run it.
