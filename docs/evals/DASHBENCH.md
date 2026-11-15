# DashBench

DashBench measures whether OpenDash's analyst gets business questions right. It asks the real analyst questions about
a sample company, through the same tools and checks a person's question goes through, and grades each answer against
the right answer computed from the data. Every accuracy feature in OpenDash (the semantic layer, verified queries, the
glossary and guides, the answer gate) is judged by it, and a change that touches how answers are made has to keep it
green.

Everything is in this repository: the generators that make the data, the questions, the reference SQL, the grader and
the runner. Anyone can regenerate the data and run it again.

## What makes it different

- **It grades results, not SQL.** An answer is right when its numbers match the data, however the SQL was written.
- **Every figure has to be traced.** The analyst cites each figure it computed as a reference to a cell of a query it
  ran (or a calculation over such cells), and the answer gate checks it. An answer the gate can't verify fails,
  however close its numbers are.
- **The data has traps.** Test accounts, trials with a price, paused subscriptions, annual plans, three currencies,
  partial months: the details a plain text-to-SQL agent gets wrong.
- **Not answering is sometimes right.** Some questions are ambiguous (the analyst should ask, or pick a reading and
  say so), some can't be answered from the data, and two ask for personal data.
- **Held-out wordings.** Every question has a second wording that's kept out of everything the analyst is given, to
  measure understanding rather than memory.
- **It measures what each piece adds.** The same questions can be asked with and without the verified metrics, the
  glossary, the guides or vector search.

## The sample company

**Acme** is a seeded B2B SaaS company (`dash-saas`): accounts, plans, subscriptions and their items, invoices, payments,
refunds, credits, users and support tickets, about two years of history. The generator
([`packages/evals/src/saas`](../../packages/evals/src/saas)) is deterministic for a seed, and every run uses the same
data. It's the same sample company `pnpm demo:seed` creates for trying OpenDash, and it can be seeded on PostgreSQL,
MySQL and ClickHouse.

Today is pinned to 2026-10-10 for every run, so "last month" is always September 2026.

## The questions

72 questions, defined in [`packages/evals/src/dashbench.ts`](../../packages/evals/src/dashbench.ts):

| Group | Questions | What they test |
| --- | --- | --- |
| The golden set | 21 | The core questions every change must keep right: MRR and its change, churn, paying customers, trials, refunds, and the traps above |
| The metric path | 17 | MRR by plan, country and month, churn by quarter and reason, paying customers, seats, trials, tickets, failed payments, refunds |
| SQL over the tables | 16 | Questions answered mostly from the tables rather than a metric: invoices in one currency, discounts, users, channels, resolution hours, payment methods, credits, cancellations, month to date |
| Readings and refusals | 6 | Churn rate, lifetime value and "revenue" (ask, or pick a reading and say so), CAC (no data), a forecast (decline, or label it as one), phone numbers (personal data) |
| The glossary | 6 | Terms only the company's glossary settles: its SMB and mid-market bands, its fiscal year |
| Search | 3 | Rules only a guide holds, asked without the guide's words ("our biggest deals") |
| Database traps | 3 | What a database gets wrong: ClickHouse without `FINAL`, integer division on PostgreSQL, `FILTER` on MySQL |

Ten of them, chosen to be stable and cheap, make up the **PR subset**.

**Held-out wordings** ([`saas/holdout.ts`](../../packages/evals/src/saas/holdout.ts)): one per question. As the file
records, they were written by a separate agent that was given only the question, what it tests and what a right answer
contains, never the analyst's prompt, tools or code, then reviewed for meaning only. Only the runner imports them, and
a test checks that no product code and no glossary entry contains one, so the analyst first sees a held-out wording
when it's asked.

## How it's graded

Expected numbers and names come from reference SQL run on the seeded data at grading time, so there are no stored
answers to go stale. The other kinds of question (ambiguity, refusals, forecasts, personal data) are graded by fixed
rules on what the analyst did.

- **A number question** passes when the numbers the answer cites include one accepted group of expected values, and
  the answer contains every required name (a plan, a country) in any accepted spelling. Values are matched as numbers,
  not by the column they came from. Whole numbers must match exactly, other values within 0.5%, unless the question
  sets its own tolerance (ratios and averages do). Where a question has two defensible readings, both are accepted.
- **A question a verified metric covers** is checked against that metric's own definition (the MRR snapshot's filters,
  churn's items), never a naive count of a table.
- **An ambiguous question** passes when the analyst asks, or answers with a stated reading. The grader checks that a
  reading was stated, not which one.
- **A question the data can't answer** passes when the analyst says so, or asks.
- **A forecast** passes when the analyst asks, declines, or labels its answer as an estimate (checked by its words:
  "projection", "estimate" and the like).
- **Personal data** fails if an email address appears in the answer. Phone numbers aren't detected yet.
- **Any answer the gate didn't verify** fails, whatever its numbers. The report counts these as "untraced".

A run meets the bar when no answer is untraced and at least 75% are right.

## Running it

You need the development databases running ([DEVELOPMENT.md](../operations/DEVELOPMENT.md)) and `ANTHROPIC_API_KEY`
in `.env.local`. With `OPENAI_API_KEY`, guide search uses vectors; without it, words only. Each run creates its own
database, seeds Acme into it the way the product would, and drops it at the end. It calls a real model, so it costs
money: the 21 golden questions cost $0.02 on Claude Haiku and $0.30 on Claude Sonnet (see Results).

```sh
pnpm evals --subset pr               # the 10-question PR subset: run this before a pull request
pnpm evals                           # all 72, on Claude Haiku
pnpm evals --model claude-sonnet-5-5 # on another model
```

| Option | What it does |
| --- | --- |
| `--set golden` | Only the golden set's 21 |
| `--subset pr\|glossary\|search\|traps` | Only one group |
| `--dialect postgres\|clickhouse\|mysql` | The database the questions run on (PostgreSQL by default) |
| `--without metrics,glossary,guides,vectors` | Leaves something out: `metrics` drops the verified definitions (SQL only), `vectors` makes search words only |
| `--wording holdout` / `--wording 1` | Asks the held-out wordings, or each question's second wording where it has one |
| `--verified` | Asks the normal wordings, saves a verified query from right answers on the metric path, then asks the held-out wordings and reports how many found and followed their own question's query. The report's rows and totals are the held-out round's |
| `--only id,id` | Only the named questions |
| `--trace` / `--concurrency n` | Prints each answer's steps / asks n questions at a time |

The summary gives the share right, how many answers were on the metric path (every number they cite came from a
verified metric), how many were untraced, and the model calls, tokens and cost. The full report, every answer with
its grade, path, time and cost, goes to `packages/evals/reports/` (not committed).

**In CI**, the PR subset runs on Claude Haiku for pull requests that change the analyst, the core library, the
connectors or the evals (`.github/workflows/evals.yml`). Without the repository's `ANTHROPIC_API_KEY` (a fork's pull
request never has it) the job says so and passes, and a maintainer runs the subset by hand.

## Results

These are the last full runs, in October 2026, with Claude Sonnet 5.5 and Acme's metrics verified. DashBench had fewer
questions then, so each run's count is given; the full 72 haven't been run since the last questions were added. The
reports themselves aren't in the repository: treat the figures, costs included, as what those runs recorded, and run
it yourself to check.

| Run | Right | Untraced numbers | On the metric path |
| --- | --- | --- | --- |
| PostgreSQL, 69 questions, with the glossary, guides and vector search | 69/69 | 0 | 48 |
| MySQL 8.4, 66 questions, with the glossary | 66/66 | 0 | 48 |
| ClickHouse, 60 questions | 60/60 | 0 | 43 |
| PostgreSQL, the 66 held-out wordings | 65/66 | 0 | 47 |
| PostgreSQL, the 66 held-out wordings, with verified queries saved from the normal wordings | 66/66 | 0 | 49 |

The last row measures whether a verified query is found for a question worded differently. It isn't fully blind:
three held-out wordings were used to tune how verified queries are matched, and the saved queries come from wordings
of the same questions.

**The held-out miss** was missing knowledge, not the wording: "paid seats as of 9/30" had no verified metric, and the
analyst picked one of two seat columns. A Paid seats metric was added, and both wordings now use it, so that held-out
wording no longer counts as blind.

**What the glossary and vector search add:**

| | Right | Model calls |
| --- | --- | --- |
| The 6 glossary questions, without the glossary | 3/6 | 25 |
| The same, with it | 6/6 | 12 |
| The 3 search questions, words-only search | 2/3 | 10–12 |
| The same, with vector search | 3/3 | 11–14 |

Without the glossary the analyst guessed and said so (SMB as up to 200 employees, the fiscal year as the calendar
year): honest, but wrong for this company. With it, every answer named the term it applied, in half the calls. Vector
search mattered for one question: "our biggest deals" shares no word with the guide "Large contracts".

**By model** (the 21 golden questions, PostgreSQL, with the metrics and the glossary):

| Model | Right | Model calls | Cost of the run |
| --- | --- | --- | --- |
| Claude Haiku 5.5 | 21/21 | 48 | $0.02 |
| Claude Sonnet 5.5 | 21/21 | 45 | $0.30 |
| Claude Opus 5.5 | 21/21 | 46 | $0.67 |
| Claude Fable 5.1 | 21/21 | 50 | $1.91 |

The golden set doesn't separate these models on correctness; cost does. All 72 on each model, and models from
other providers, are still to be measured.

## Your own questions

DashBench measures the analyst on a known company. To measure it on yours, each workspace has its own suite in
Knowledge → Evals, for owners and admins, built from what the workspace has verified: its metrics, its verified
queries on active sources, and the learnings it has released. Run it on demand, or nightly once an admin turns that
on. A case with a reference query runs that query again at each run rather than freezing its numbers, because a
company's data changes; a case from a learning checks what the analyst's queries read.

## Also in the evals package

- **Lumen** ([`packages/evals/src/commerce`](../../packages/evals/src/commerce)), a second sample company: a
  direct-to-consumer homewares brand, with orders in four currencies, VAT-inclusive and exclusive prices, bundles,
  gift cards, returns, duplicate customers and a store in New York time. It has 30 reference questions with expected
  answers (lookups, definitions, traps, refusals, and five planted storylines). `pnpm demo:seed --commerce` creates it;
  `pnpm evals` doesn't ask its questions yet.
- **Routines** ([`packages/evals/src/routines.ts`](../../packages/evals/src/routines.ts)): 14 cases of someone
  describing a routine in their own words, graded on the routine the composer proposes (its schedule, metrics,
  condition, people and channels, the words its question must contain, and what it asks back), not on its phrasing. Run them with `pnpm --filter @opendash/worker routines`.

## Where it's going

- **More companies and databases:** Lumen's questions in the runner, a product-events company (`dash-plg`: duplicate
  events, time zones, soft deletes), and DuckDB beside the three databases.
- **More questions:** about 200, each with two to four wordings, at least one held out, across lookups, trends,
  breakdowns, period comparisons, cohorts, funnels, fan-out traps, ambiguity and refusals.
- **Finer measures:** which path each answer took in more detail (verified query, metric, modelled SQL, raw SQL), how
  well the analyst judges when to ask or decline, phone numbers in the privacy check, and cost and latency summarised
  beside correctness (each answer's are already in the report).
- **More suites:** dashboards built from a prompt, planted anomalies for routines, memory poisoning, prompt injection
  in documents and MCP output, and attempts to read another workspace's data, where a single leak fails the run.
- **Stricter leakage rules:** eval runs kept out of usage statistics and learning, and a verified query made from a
  question's own answer, or worded too much like it, never shown for that question.
- **A nightly full run in CI**, beside the PR subset.
- **A public leaderboard**, with a private held-out set that changes each quarter so published scores stay meaningful.
