# Security policy

## Reporting a vulnerability

Please report it privately, not in a public issue or discussion: on GitHub, open the repository's **Security** tab and
choose **Report a vulnerability**, or email hello@opendash.cloud. Include what you found, how to reproduce it, and what
it affects.

We'll acknowledge the report as soon as we can, work on a fix, and credit you in the release notes if you'd like.

## Supported versions

OpenDash is pre-1.0. Security fixes go into `main` and the latest release.

## What's in scope

The code in this repository and the images built from it: tenant isolation, authentication and API keys, the query
gateway and its read-only guarantees, the answer gate, stored secrets, and the Slack and email integrations.

## Hardening you can rely on

- Every tenant table uses row-level security, and the application role can't bypass it.
- Customer databases are reached only by workers, through read-only sessions with server-side limits, and their
  connection secrets are encrypted with your key (`OPENDASH_KEK`).
- Self-hosted instances are invite-only by default, and sign-in requires HTTPS.
- A workspace's owners can delete it, and anyone can delete their own account, with everything that was theirs; both
  can download their data first.

See the [self-hosting guide](docs/operations/HOSTING.md) for how to run it safely.
