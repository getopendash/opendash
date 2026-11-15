# Changelog

What changed for people who run or use OpenDash, newest first. Versions follow [semantic versioning](https://semver.org);
before 1.0 a minor version may break things, and says so here. A version is a `v*` tag: the images
`opendash-web` and `opendash-worker` are published under it ([HOSTING](docs/operations/HOSTING.md)).

## Unreleased

The first beta: what's on `main` before the first tag.

### Added

- **OpenDash Cloud, in beta.** The hosted service is free to try during its beta, with every feature included
  ([LICENSING](docs/operations/LICENSING.md)).
- **Help links.** `OPENDASH_SUPPORT_EMAIL`, `OPENDASH_DOCS_URL` and `OPENDASH_STATUS_URL` show where people get help:
  in the sign-in footer, the account menu, the not-found page and at the foot of every email. Each is hidden when
  empty.
- **Error pages.** A page that isn't there, and one that failed to draw, say so in OpenDash's own words with a way
  on, inside the app and outside it; a failed page shows a reference that finds its line in the server's log.
- **DashBench's PR subset in CI** (`.github/workflows/evals.yml`), on pull requests that touch what decides an answer.
- **End-to-end browser tests** (`pnpm e2e`): signing up, creating a workspace and connecting a source, in a real
  browser against a running instance ([DEVELOPMENT](docs/operations/DEVELOPMENT.md)).

### Changed

- **Contact.** Security reports, licensing, conduct and trademark questions go to hello@opendash.cloud.
- **Self-host compose** passes the terms, privacy and security links to the web app; they were read but never set.
