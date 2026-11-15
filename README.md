# OpenDash

**The open-source AI analyst for startup operators.** Connect a read-only database, ask in plain language, and get
answers whose numbers trace back to a query you can open.

[Website](https://www.opendash.cloud) · [OpenDash Cloud](https://app.opendash.cloud) ·
[Self-host](docs/operations/HOSTING.md) · [Architecture](ARCHITECTURE.md) · [DashBench](docs/evals/DASHBENCH.md) ·
[Contributing](CONTRIBUTING.md)

> **Status: beta.** OpenDash is under active development: expect rough edges and breaking changes before 1.0. You
> can run it yourself (read the [self-hosting guide](docs/operations/HOSTING.md) before putting it in front of real
> data), or use **OpenDash Cloud**, the hosted service, free to try during its beta with every feature included.
> Questions, and feedback on either: hello@opendash.cloud. What changed is in the [changelog](CHANGELOG.md).

## What it does

- **Answers you can check.** Ask a question about your data in plain language, and attach documents, spreadsheets,
  PDFs or images for context. The figures the analyst takes from your data are references to recorded query results
  (or calculations over them), and a deterministic check (code, not a model) resolves each one before you see the
  answer; an answer it can't confirm is marked Unverified. Open a cited number to see the query behind it, or download
  the answer as a PDF.
- **Apps and dashboards, built for you.** Ask for a dashboard or a working tool and the analyst builds it as an App,
  which you watch take shape. An App can be charts and numbers, a list of records your team works through (owners,
  statuses, notes and follow-ups), a what-if model, or a button that takes a confirmed action in a connected service.
  Each App's code runs in a sandboxed frame, and its queries are checked against what the viewer may see in OpenDash.
  Share it with named people, a project or the whole workspace, and invite teammates to edit it.
- **Routines, goals, insights and tasks.** A weekly summary by email or in Slack, or a watch on a metric that tells you
  when something moves. Set goals on your metrics; investigate what a routine found, turn it into a task, and see
  afterwards whether the metric moved.
- **Knowledge that grows.** Metrics, datasets, a glossary, guides, verified queries and skills teach the analyst how
  your business talks. Your own corrections and preferences are remembered for you; ones for the whole team become
  proposed learnings that are checked and tested, and reviewed unless they're simple new terms a rule can release.
  Each workspace can measure the analyst on its own questions.
- **Your databases, read only.** It queries PostgreSQL, MySQL and ClickHouse where they are, through read-only users,
  and never writes to them. Query results do leave the database: OpenDash keeps previews and caches of them, and sends
  what a question needs to your model provider. Snowflake and BigQuery are next.
- **The tools your team uses.** Connect services such as Jira, Linear or Notion over MCP, approved by an admin, either
  as each person's own account or one shared account. Admins choose, tool by tool, what runs on its own, what asks the
  person first and what's blocked; changes go through a person's own account, and tools the server marks as
  destructive never run.
- **Your models.** Connect Anthropic, OpenAI, Google, Amazon Bedrock, Google Vertex AI, Vercel AI Gateway or OpenRouter
  per workspace, or use the deployment's own keys (included on OpenDash Cloud). Only models OpenDash has measured on
  [DashBench](docs/evals/DASHBENCH.md) can be picked: today that's Claude Haiku, Sonnet, Opus and Fable, on whichever of
  those providers serves them.
- **Slack and email.** Ask in Slack, in a direct message or by mentioning OpenDash in a channel; get routines by Slack
  or email.
- **Workspaces and projects.** Owners, admins, members and viewers each see what their role allows. A project keeps a
  piece of work's conversations and dashboards together, with its own managers, editors and viewers.
- **Self-hosted or hosted.** Docker Compose runs the whole thing on one machine; OpenDash Cloud runs the same two
  images for you.

## OpenDash Cloud

The quickest way to start: [app.opendash.cloud](https://app.opendash.cloud) is OpenDash run by us, with nothing to
install, upgrades and backups taken care of, and AI models included. It's the same code as this repository.

## Try it locally

You need Node.js 24, pnpm, Docker, and a model key (an Anthropic key, or a Vercel AI Gateway key).

```bash
corepack enable && pnpm install
cp .env.example .env.local        # set BETTER_AUTH_SECRET and OPENDASH_KEK (`openssl rand -base64 32` for each),
                                  # and ANTHROPIC_API_KEY or AI_GATEWAY_API_KEY
pnpm dx                           # checks your setup, starts Postgres, runs migrations, then runs the app and worker
```

Optionally, in a second terminal, create a sample company to ask questions about:

```bash
pnpm demo:seed
```

Open <http://localhost:3000>, sign up (the sign-in link is printed in the server log when no email provider is set),
create a workspace, and connect a source. The [development guide](docs/operations/DEVELOPMENT.md) has the details.

## Self-host

```bash
cp infra/selfhost.env.example .env    # fill in passwords, keys, your addresses, email and a model key
docker compose --profile caddy up -d  # postgres, setup, web, worker, and Caddy for HTTPS
```

Sign-in needs HTTPS: leave out the Caddy profile only if your own TLS proxy sits in front. Apps and dashboards are drawn
on an address of their own, so point a second host name at the same server (Caddy serves `frames.<your domain>`) and
set `OPENDASH_FRAMES_URL` to it. The [self-hosting guide](docs/operations/HOSTING.md) covers that, email, Slack, who
can sign up, backups and upgrades.

## How it works

Numbers aren't typed by a model: the ones taken from your data are references to cells of recorded query runs, and the
answer gate resolves each one and recomputes any calculation over them. The analyst works from the semantic layer
first, reusing verified queries and preferring metrics compiled from your dataset definitions, and falls back to SQL
over your tables when nothing governed fits. Such an answer is labelled Unmodelled and has to pass a check by a
separate query, or it's marked Unverified. OpenDash ships two application images, a web app and a worker, with
PostgreSQL as its only store. [DashBench](docs/evals/DASHBENCH.md), an open benchmark, measures the answers. The
[architecture overview](ARCHITECTURE.md) is one page.

## Contributing

Contributions to the Apache 2.0 core are welcome: see [CONTRIBUTING.md](CONTRIBUTING.md). To report a vulnerability, see
[SECURITY.md](SECURITY.md).

## Enterprise features

Every instance keeps an audit log of the last 90 days. Single sign-on (OIDC and SAML), directory sync (SCIM), and
the audit log's tamper-evident chain, longer retention and exports are in [`ee/`](ee/README.md). On a self-hosted instance in production they need a license: write to
[hello@opendash.cloud](mailto:hello@opendash.cloud).

## Contact

Questions, partnerships or anything else: [hello@opendash.cloud](mailto:hello@opendash.cloud).

## License

Apache License 2.0, except the `ee/` directory, which is source-available under the Open Core Ventures Source
Available License (OCVSAL). See [LICENSE](LICENSE), [NOTICE](NOTICE), [ee/LICENSE](ee/LICENSE) and
[LICENSING](docs/operations/LICENSING.md). The OpenDash name and logo are not covered by either license: see
[TRADEMARKS.md](TRADEMARKS.md).
