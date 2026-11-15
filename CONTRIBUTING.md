# Contributing to OpenDash

Thanks for helping. Contributions to the Apache 2.0 core are welcome; `ee/` is maintained by the maintainers only.

## Before you start

- For anything larger than a small fix, **open an issue first** so we can agree on the approach before you spend time on it.
- Read [AGENTS.md](AGENTS.md). It lists the rules the code follows (how numbers are checked, tenant isolation,
  durability, the agent runtime, the design system), and most of them are enforced by lint rules and tests.
- [ARCHITECTURE.md](ARCHITECTURE.md) is the whole system on one page.
- Everyone taking part follows the [Code of Conduct](CODE_OF_CONDUCT.md).

## Set up

Follow the [development guide](docs/operations/DEVELOPMENT.md): Node 24, pnpm and Docker, then `pnpm dx`.

## Making a change

1. Branch from `main`.
2. Keep the change focused. Follow the nearest existing example of the same kind of thing.
3. Run the checks CI runs: `pnpm lint`, `pnpm typecheck`, `pnpm test`, `pnpm build`, and `pnpm check:notes` (a
   comment explains why, never who or when).
4. Changing prompts, tools, retrieval, the compiler or the answer gate? Also run `pnpm golden` (or `pnpm evals`) and put
   the score change in the pull request. These need a model key, so CI doesn't run them.
5. New components go in `packages/ui` with an entry in the `/dev/ui` gallery.
6. A new runtime dependency must pass `pnpm check:licenses` (see [LICENSING](docs/operations/LICENSING.md)).

## Sign your commits

OpenDash uses the [Developer Certificate of Origin](https://developercertificate.org/). Add a `Signed-off-by:` line to
each commit with `git commit -s`. There is no CLA. By contributing you agree your work is licensed under the Apache
License 2.0.

## Examples and data

Examples in code, tests, comments, docs and commit messages come from the demo company (`pnpm demo:seed`), never from a
real workspace: no customer's or user's company name, table or column names, dashboard titles or values.

## Security

Please don't open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
