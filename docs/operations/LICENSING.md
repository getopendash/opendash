# Licensing

OpenDash is **open core**. Everything is under the **Apache License 2.0** except the **`ee/`** directory, which is
under the **Open Core Ventures Source Available License (OCVSAL)**. It is one repository, and the same images serve
every deployment.

## 1. Layout

```
LICENSE          Apache License 2.0, with a note that ee/ is not covered by it
ee/LICENSE       the OCVSAL 1.0 text (https://github.com/OpenCoreVentures/open-core-ventures-source-available-license)
NOTICE           copyright and third-party material; Apache 2.0 asks redistributors to keep it
TRADEMARKS.md    what the OpenDash name and logo may be used for
```

## 2. What each license allows

| | Apache 2.0 core | OCVSAL `ee/` |
|---|---|---|
| View and modify the source | yes | yes |
| Test, and publish modifications | yes | yes, for non-production use |
| Use in production | yes | **only with a commercial agreement** from the copyright holder |
| Redistribute | yes, keeping LICENSE and NOTICE and marking changed files | keeping the license on every copy |
| Patents | contributors grant a patent license for their contributions | not granted |
| Feedback and contributions | stay yours (Apache 2.0) | the licensor gets an irrevocable, royalty-free license to use them |

For a commercial agreement, and the license key that comes with it, write to hello@opendash.cloud.

**OpenDash Cloud, during its beta.** The hosted service is free to try while it is in beta, and every workspace on it
has every feature, the `ee/` ones included (single sign-on, directory sync, the audit chain and its exports): the
service runs on the licensor's own service key, which covers the whole instance. Plans and prices come during the
beta; what a workspace set up keeps working, and each decides then how it goes on.

## 3. What's open and what's in `ee/`

Features an operator uses are open; admin, governance and scale features are paid. **We never move a core feature into
`ee/`**: a feature that turns out to matter to individual operators moves out of `ee/` into the Apache 2.0 core, never
the other way.

- **What's in `ee/` today:** the license gate; the audit log's hash chain, Verify, long retention and exports; and single
  sign-on (OIDC and SAML 2.0 identity providers, requiring them for a domain); and directory sync (SCIM 2.0). The audit
  log itself (recording, and the last 90 days in Settings → Audit log) is in the Apache 2.0 core, on every instance.
- **The core never imports from `ee/`.** Only `apps/web/enterprise.ts` and `apps/worker/src/enterprise.ts` do, and lint
  refuses any other import. A build without `ee/` deletes the folder, has those two files return
  `communityEdition(...)` from `@opendash/core/enterprise` (and no auth extension), drops `@opendash/ee` from
  `apps/web/package.json` and `apps/worker/package.json`, and removes the worker Dockerfile's copy of `ee/`.
- **How it unlocks:** a license key, set as `OPENDASH_LICENSE_KEY`, is checked offline against the licensor's public
  keys, so an instance without internet access works. Owners see what it covers in Settings → License.
  - Outside production (`NODE_ENV` isn't `production`), enterprise features can be set up without a key, as the OCVSAL
    allows for development and testing.
  - In production, a feature can be set up only when the key covers it. Disabling an identity provider, a new directory
    token and disconnecting a directory are the exceptions: they only take access away.
  - A key that lapses or is removed never switches security off: what's set up keeps running (sign-in through SSO,
    requiring it, directory sync, audit recording). Only changes to it wait for a valid key. Audit retention beyond
    90 days is kept through a lapsed or invalid key, but a removed key returns it to 90 days.

## 4. Contributions

- Contributions to the **Apache 2.0 core** are welcome, under the **Developer Certificate of Origin**: every commit
  carries a `Signed-off-by:` line (`git commit -s`). There is no CLA: under section 5 of the Apache License, a
  contribution is licensed under the same terms. See [CONTRIBUTING.md](../../CONTRIBUTING.md).
- **`ee/` is maintainer-only.** Its package is `@opendash/ee`, licensed `SEE LICENSE IN LICENSE`.

## 5. Dependency rule

Everything outside `ee/` must be **OSI-licensed** and **installable without tokens or accounts**. `pnpm check:licenses`
checks the resolved dependency tree against an allowlist, and CI runs it.

- **Allowed:** MIT, Apache-2.0, BSD-2/3-Clause, ISC, 0BSD, Unlicense/CC0, Zlib and similar permissive licenses.
- **Not allowed:** SSPL, BSL/BUSL, ELv2, Commons Clause and other source-available licenses; GPL and AGPL in anything
  linked or bundled; anything that needs a token or account to install.
- **Known exceptions**, each listed with its reason in `scripts/check-licenses.mjs`:
  - MPL-2.0 (file-level copyleft), used unmodified: `@resvg/resvg-js` (draws charts in PDFs) and `lightningcss`
    (a build tool);
  - LGPL-3.0: `@img/sharp-libvips-*`, the prebuilt image library that Next.js installs through `sharp`, loaded
    dynamically and unmodified;
  - CC-BY-4.0: `caniuse-lite`, browser data used at build time;
  - the SIL Open Font License for the font files in `packages/pdf/fonts` (their license texts ship beside them).

A new exception needs a reason in that file and a note in the pull request.

## 6. Telemetry

Self-hosted builds send **no telemetry by default**. Two kinds are opt-in, each off until you set its variable:

- **Traces** to your own OpenTelemetry collector (`OTEL_EXPORTER_OTLP_ENDPOINT`).
- **Product analytics** to a PostHog project (`POSTHOG_KEY`, and `POSTHOG_HOST` for one other than PostHog's EU
  cloud). This is how OpenDash Cloud counts sign-ups and use; a self-hosted install sends nothing unless you set it to
  your own project. What it sends is listed in `packages/core/src/ops/analytics.ts` (server) and
  `apps/web/components/shell/analytics.tsx` (browser): ids, fixed words and counts, never a name, an email, a
  question, SQL, a value or an error's message; no cookies, and the browser sends only to this server's `/ingest`.

Third-party telemetry in dependencies is audited and disabled.

## 7. Trademarks

The **OpenDash** name and logo are not covered by the Apache License or the OCVSAL: see
[TRADEMARKS.md](../../TRADEMARKS.md).
