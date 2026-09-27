# Platform API (`apps/api`)

The Worker that holds every ticket, report, reply and audit row. How to run
it in your own account: [docs/operations/deployment.md](../../docs/operations/deployment.md).
Ticket lifecycle, priority/resolution rules, SLA settings and operations:
[Operations Tickets](../../docs/operations/tickets.md).

## Why three Workers

```
                    Cloudflare Access
                            │
                   admin.example.com
                            │
                     inquiry-admin            ← the only public one
                            │  Service Binding
                     inquiry-core             ← no route, no workers.dev
                     ┌──────┴──────┐
                    D1            R2
                                  (private)

a Project's Worker ──(Intake)──┐
inquiry-mail-ingress ──────────┴─→ inquiry-core
```

Core holds the D1 and R2 bindings; the admin console holds neither. A bug in
an internet-facing route handler cannot reach a database it was never given,
and the Projects that send reports never learn the schema — they call
`@inquiry-platform/sdk` and nothing else.

Core has `workers_dev: false` and no route. The only way in is a Service
Binding from inside the account.

## Packages

| Path | What it is |
| --- | --- |
| `packages/core` | Types, Zod schemas, the `AdminCoreApi` interface, the error vocabulary. The boundary itself. |
| `packages/notification` | `MailProvider`, a Resend adapter, and an "unconfigured" one that refuses clearly; Web Push. |
| `packages/sdk` | What a Project uses: the `Intake` contract and a client. No dependencies. |
| `apps/api` | D1, R2, domain services, audit log. RPC plus a `fetch` for bytes. |
| `apps/admin` | React + Hono. Access JWT verification, security headers, the API. |
| `apps/mail-ingress` | Support mailbox → parse → Core → forward. |

The repositories are used only by Core and live in `apps/api/src/db`, and
validation is inseparable from the contracts it validates, so the Zod schemas
live beside the types they describe.

## Local development

```bash
pnpm install
pnpm --filter @inquiry-platform/api migrate:local
pnpm --filter @inquiry-platform/api seed seed/example.ts > /tmp/seed.sql
pnpm --filter @inquiry-platform/api exec wrangler d1 execute DB --local --file /tmp/seed.sql
```

Then, in three terminals:

```bash
pnpm --filter @inquiry-platform/api dev            # :8788
pnpm --filter @inquiry-platform/admin dev          # :4330, Vite
pnpm --filter @inquiry-platform/mail-ingress dev   # :8789
```

Set `ENVIRONMENT=local` and `DEV_ADMIN_EMAIL` in `apps/admin/.dev.vars` to
sign in without Access. That combination is refused in production — see
`worker/identity.ts`.

## Checks

```bash
pnpm run ci
```

## Deletion policy

There is no "delete" anywhere in this screen. Apps are archived, reports are
closed, threads are resolved or marked spam, templates are deactivated. The one
`DELETE` in the codebase removes an app link a person typed a moment ago.

Retention and purge for evidence and personal data is a separate, deliberate
job — the schema is shaped so it can be added without a rewrite, and it is not
implemented here.
