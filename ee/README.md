# ee/

Enterprise features, source-available under the Open Core Ventures Source Available License (OCVSAL, see
[LICENSE](LICENSE)): you may read, modify and test the code, and production use needs a commercial agreement with the
licensor (hello@opendash.cloud). The directory is maintainer-only: outside contributions go to the Apache 2.0 core.
See [LICENSING](../docs/operations/LICENSING.md).

**What's here:** the license gate (`@opendash/ee/license`), the audit chain (`@opendash/ee/audit`), single sign-on
(`@opendash/ee/sso`) and directory sync (`@opendash/ee/scim`).

**The core never imports `ee/`.** Only `apps/web/enterprise.ts` and `apps/worker/src/enterprise.ts` do, and lint
refuses any other import. Code elsewhere asks those files' `enterprise()` and types against `@opendash/core/enterprise`.

## The license gate

- A license key looks like `odl1.<payload>.<signature>`: the payload says who it's for, the features it covers, an
  optional seat count and instance address, and when it expires. The licensor signs it with Ed25519.
- An instance reads it from `OPENDASH_LICENSE_KEY` and checks it offline, against the public keys in
  [src/license/keys.ts](src/license/keys.ts).
- Outside production every feature can be set up without a key. In production a feature can be set up only when a valid
  key covers it. A lapsed or removed key never stops what's already set up.
- **The service key** is the one the licensor signs for its own service, OpenDash Cloud: every feature, no expiry, no
  address, so it never needs renewing and moving the service's address doesn't touch it. Where it's set, nobody sees
  licensing: no Settings → License, no "Enterprise" badges.

## The audit chain

The Apache 2.0 core records the audit log on every instance (`packages/core/src/audit`) and shows its last 90 days.
With a license that covers `audit`, this adds:

- **The hash chain.** The worker's minute tick seals each organization's new rows in order: each row's hash is SHA-256
  of the hash before it and the row's canonical form (`src/audit/chain.ts`), so a row changed, removed or reordered
  after sealing breaks every link after it. Sealing holds the organization's chain head with `FOR UPDATE SKIP LOCKED`
  and advances it by compare-and-set, so it never waits and never forks.
- **Verify** walks the chain from its first remaining row: the button on Settings → Audit log, or from the server
  `pnpm audit:verify --org <organization id>`.
- **Exports**, CSV or JSON Lines, oldest first, each row with its place and hash and the chain head first, so a copy of
  the head lives outside the database. An export is itself recorded.
- **Retention** up to seven years (`OPENDASH_AUDIT_RETENTION_DAYS`, in days; 90 without the license). A lapsed or
  invalid key never shortens it: nothing is dropped until a valid key or a shorter setting says so. Removing the key
  altogether returns it to 90 days, so replace a key rather than remove it.

## Single sign-on

OIDC and SAML 2.0 identity providers per workspace, on `@better-auth/sso`, set up in Settings → Single sign-on by owners
and admins. The auth server gets it through `createAuth`'s `extension` (`packages/auth/src/extension.ts`); the plugin's
own management routes answer 404 over HTTP.

- **Two proofs, never confused.** A TXT record, `_opendash-verification-<provider id>.<domain>`, proves the workspace
  may claim the domain; it's asked of the domain's own nameservers. A validated ID token or SAML assertion proves the
  person. Only both create or link an account (even on an invite-only instance), and only at exactly that domain: a
  subdomain needs its own provider. One workspace per verified domain (`auth.sso_domain`).
- **The lifecycle:** draft (nothing leaves the server), verified (signs people in), active (a test sign-in through it
  passed after its last change), then required for its domain, and disabled.
- **Requiring it** applies to everyone with an email at the domain, in every workspace on the instance: their other
  sessions end, their API keys and the workspace keys they made are revoked, and password and email-link sign-in are
  refused for them. Their sessions must come from the provider and be younger than `OPENDASH_SSO_MAX_AUTH_AGE_HOURS`
  (12 by default).
- **Newcomers** join the provider's workspace as viewers, or with the role a pending invitation gave them.
- **Secrets** (the client secret, SAML settings) are sealed in the auth schema with the workspace's data key.
- **Addresses.** A provider's issuer and metadata must be https and on public addresses, checked again before each
  sign-in. An operator can trust more origins with `OPENDASH_SSO_TRUSTED_IDP_ORIGINS` (http allowed outside production,
  for a local Keycloak).
- **Break-glass:** Disable on the settings page (it works without a license), or from the server
  `pnpm sso:disable --provider <provider id>`. Its sessions end and requiring it lifts; its settings and domain proof stay.
- **What the identity provider needs** is built from `BETTER_AUTH_URL`: the OIDC redirect URI
  `<url>/api/auth/sso/callback/<provider id>`, or SAML's ACS URL `<url>/api/auth/sso/saml2/sp/acs/<provider id>` and
  entity ID `<url>/api/auth`. Changing `BETTER_AUTH_URL` breaks every provider set up against it.

## Directory sync

SCIM 2.0 on `@better-auth/scim`, one connection per workspace, set up in Settings → Directory sync by owners and admins.
The directory calls `<BETTER_AUTH_URL>/api/auth/scim/v2` with a token shown once, which lasts a year; a new token ends
the old one at once. Tokens are kept only as HMAC digests, under a key derived from the auth secret, so changing
`BETTER_AUTH_SECRET` ends every directory's token: make new ones in Settings.

- **Only at verified domains.** Someone is added only at a domain the workspace verified for single sign-on, so a
  directory can't claim strangers. An address that already has an account is linked (its name and address stay the
  person's); anyone else gets an account with no password, and signs in through single sign-on.
- **Roles from groups.** Each group the directory pushes can give admin, member or viewer; a person gets the highest.
  Someone it adds in no mapped group is a viewer. It changes only roles it gave: a role set by hand stays until a
  mapped group says otherwise. Owner is never given or changed.
- **Deprovisioning.** Deactivated or deleted, a person leaves the workspace as if removed, and loses their sessions once
  no directory still has them as active. A workspace's last owner is kept, and the audit log says so.
- **Disconnect** ends the tokens: nobody is added or removed until you connect again, and people already added stay. A
  new token and Disconnect work without a license; connecting and mapping groups need one in production.
- Okta's and Microsoft Entra's request shapes are covered, Entra's legacy Group schema marker included. Requests to
  `/api/auth` are capped at 1 MiB, and the directory's are rate-limited (600 a minute) where limits are on.

## Issuing licenses (the licensor only)

```sh
# Once: the licensor's key pair. The private key goes outside this repository, readable by you alone.
pnpm license:keygen --out ~/opendash-licensor.pem
# Add the line it prints to ISSUER_KEYS in src/license/keys.ts, and release that version.

# A license, printed for OPENDASH_LICENSE_KEY. A date alone expires at the end of that day (UTC).
pnpm license:issue --key ~/opendash-licensor.pem --licensee "Acme Inc." --features sso,scim,audit \
  --expires 2027-12-31 --instance https://opendash.acme.com
```

`--seats` is optional, and `--instance` ties the key to one address: moving the instance to another address then
needs a new key. Whoever holds the private key can issue licenses: keep it off every instance and out of this repository
(the tool refuses paths inside it).

```sh
# The service key, for the licensor's own service only: every feature, no expiry, no address.
pnpm license:issue --key ~/opendash-licensor.pem --service --licensee "OpenDash Cloud"
```
