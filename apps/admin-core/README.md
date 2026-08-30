# Tomokichi Studio Admin

`admin.tmkch.io` — one place to work through what people report and what they
ask, for every app the Studio runs.

## Why three Workers

```
                    Cloudflare Access
                            │
                   admin.tmkch.io
                            │
                 tomokichi-admin-web          ← the only public one
                            │  Service Binding
                 tomokichi-admin-core         ← no route, no workers.dev
                     ┌──────┴──────┐
                    D1            R2
                                  (private)

tomokichi-api  ──────────┐
tomokichi-mail-ingress ──┴─→ tomokichi-admin-core
```

Admin Core holds the D1 and R2 bindings; Admin Web holds neither. A bug in an
internet-facing route handler cannot reach a database it was never given, and
the apps that send reports never learn the schema — they call
`@tomokichi/admin-contracts` and nothing else.

Admin Core has `workers_dev: false` and no route. The only way in is a Service
Binding from inside the account.

## Packages

| Path | What it is |
| --- | --- |
| `packages/admin-contracts` | Types, Zod schemas, the `AdminCoreApi` interface, the error vocabulary. The boundary itself. |
| `packages/admin-mail` | `MailProvider`, a Resend adapter, and an "unconfigured" one that refuses clearly. |
| `apps/admin-core` | D1, R2, domain services, audit log. RPC plus a `fetch` for bytes. |
| `apps/admin-web` | React + Hono. Access JWT verification, security headers, the API. |
| `apps/mail-ingress` | `support@tmkch.io` → parse → Admin Core → forward. |

The design document names `packages/db` and `packages/validation` separately.
They are not separate here: the repositories are used only by Admin Core and
live in `apps/admin-core/src/db`, and validation is inseparable from the
contracts it validates, so the Zod schemas live beside the types they describe.
Two packages instead of four, with the same boundaries.

## Local development

```bash
pnpm install
pnpm --filter @tomokichi/admin-core migrate:local
pnpm --filter @tomokichi/admin-core seed > /tmp/seed.sql
pnpm --filter @tomokichi/admin-core exec wrangler d1 execute tomokichi-admin --local --file /tmp/seed.sql
```

Then, in three terminals:

```bash
pnpm --filter @tomokichi/admin-core dev     # :8788
pnpm --filter @tomokichi/admin-web dev      # :4330, Vite
pnpm --filter @tomokichi/mail-ingress dev   # :8789
```

Set `ENVIRONMENT=local` and `DEV_ADMIN_EMAIL` in `apps/admin-web/.dev.vars` to
sign in without Access. That combination is refused in production — see
`worker/identity.ts`.

## Checks

```bash
pnpm --filter @tomokichi/admin-contracts test
pnpm --filter @tomokichi/admin-core test
pnpm --filter @tomokichi/admin-web test
pnpm --filter @tomokichi/mail-ingress test
pnpm --filter @tomokichi/api test          # the bridge lives there too
```

## What is already provisioned

Steps 1–5, 7 and 10 below have been run against the account
`Tomoki_ttttt@icloud.com's Account` (`3429f857…`). What exists today:

| Resource | State |
| --- | --- |
| D1 `tomokichi-admin` | created (`303d025d-51a8-4a90-9a19-97a08d715ec3`), migration `0001` applied, seeded |
| R2 `tomokichi-admin-files` | created, private |
| `tomokichi-admin-core` | deployed. No target — it has no route and no `workers.dev`, which is the point |
| `tomokichi-admin-web` | deployed on `admin.tmkch.io` |
| `tomokichi-mail-ingress` | deployed. No target — nothing routes mail to it yet |
| Secrets | `HASH_PEPPER`, `SUPPORT_FORWARD_EMAIL` set. `MAIL_API_KEY` **not** set |

`admin.tmkch.io` currently answers **401 to every request, including the client
bundle**, because `ACCESS_AUD` is still empty. That is the designed failure
mode, not an outage: an unconfigured Worker refuses rather than falls open. It
stays that way until step 6.

Three things remain, and none of them can be done with `wrangler`:

- **step 6**, the Access application (Zero Trust; the CLI token has no Access
  scope);
- **step 9**, connecting Remeet, which redeploys the live support and invite
  API and is worth doing *after* you can actually read the admin screen;
- **step 11**, the Email Routing switchover, which needs somebody to send real
  mail and look in a real inbox.

## Cloudflare setup, in order

Steps 1–3 and 6–7 are done by a person in the dashboard or with `wrangler`;
everything else is a deploy. **Do them in this order** — a Service Binding
cannot be created before the Worker it points at exists.

1. **D1**

   ```bash
   pnpm --filter @tomokichi/admin-core exec wrangler d1 create tomokichi-admin
   ```

   Put the id it prints into `apps/admin-core/wrangler.jsonc`. (Done — the id
   in the config is the real one.)

2. **R2**

   ```bash
   pnpm --filter @tomokichi/admin-core exec wrangler r2 bucket create tomokichi-admin-files
   ```

   Leave it private. Do not attach a public domain: report evidence is read
   through Admin Web behind Access, and there is no code path that mints a
   signed URL.

3. **Migrations and secrets**

   ```bash
   pnpm --filter @tomokichi/admin-core migrate:remote
   openssl rand -hex 32 | pnpm --filter @tomokichi/admin-core exec wrangler secret put HASH_PEPPER
   pnpm --filter @tomokichi/admin-core exec wrangler secret put MAIL_API_KEY   # optional
   ```

   `HASH_PEPPER` is effectively permanent once reports exist: changing it means
   new pseudonyms stop matching old ones. `MAIL_API_KEY` is genuinely optional —
   without it the composer works, drafts save, templates apply, internal notes
   land, and only the send button is disabled.

4. **Deploy Admin Core**, then seed:

   ```bash
   pnpm deploy:admin-core
   pnpm admin:seed > /tmp/seed.sql
   pnpm --filter @tomokichi/admin-core exec wrangler d1 execute tomokichi-admin --remote --file /tmp/seed.sql
   ```

   The seed is guarded inserts only. Running it again creates nothing twice and
   never overwrites a template edited in the admin screen.

5. **Deploy Admin Web**: `pnpm deploy:admin-web`.

6. **Cloudflare Access** — Zero Trust → Access → Applications → Add:

   - Type: Self-hosted
   - Application domain: `admin.tmkch.io`
   - Identity provider: Cloudflare, with **Restrict to account members** on
   - Copy the **Application Audience (AUD) tag**

   Put the AUD tag and your team domain (`<team>.cloudflareaccess.com`) into
   `ACCESS_AUD` and `ACCESS_TEAM_DOMAIN` in `apps/admin-web/wrangler.jsonc` and
   redeploy. They are `vars`, not Secrets: the AUD is a claim in every token
   this Worker verifies, so it is not a secret and pretending otherwise makes it
   harder to rotate.

   Until both are set, the production Worker refuses **every** request. That is
   the intended failure mode.

7. **Custom domain**: already in `apps/admin-web/wrangler.jsonc` as a
   `custom_domain` route, so `wrangler deploy` provisions it. `workers_dev` is
   off there on purpose: an Access policy is attached to a hostname, and
   leaving the `*.workers.dev` URL up would be a second door Access does not
   cover.

8. **Check Phase 1**: open `admin.tmkch.io`, sign in, confirm the Dashboard and
   the (empty) Reports list load, and confirm a private window is redirected to
   the Access login rather than to the app.

9. **Connect Remeet**: uncomment the `services` block in
   `apps/api/wrangler.jsonc` and deploy `tomokichi-api`. Until this step
   `env.ADMIN_CORE` is absent and `apps/api/src/services/admin-bridge.ts` does
   nothing — reports and support mail behave exactly as they did before.

10. **Deploy the mail Worker** and give it the forwarding address:

    ```bash
    pnpm --filter @tomokichi/mail-ingress exec wrangler secret put SUPPORT_FORWARD_EMAIL
    pnpm deploy:mail-ingress
    ```

11. **Switch Email Routing — carefully.** Do not delete the existing rule
    first.

    a. Add a *new* routing address, e.g. `admin-test@tmkch.io`, pointing at
       `tomokichi-mail-ingress`.
    b. Send a real message to it. Confirm it appears in Support **and** arrives
       in the operator's inbox.
    c. Reply to it from the admin screen; confirm the reply lands in the same
       Gmail conversation.
    d. Only then repoint `support@tmkch.io` at the Worker.
    e. Send one more real message to `support@tmkch.io` and check both halves
       again.

    The Worker forwards to `SUPPORT_FORWARD_EMAIL` itself, so the old
    destination keeps working — that is the point of doing it this way rather
    than with a second routing rule, which would deliver the raw mail twice on a
    retry.

## Deletion policy

There is no "delete" anywhere in this screen. Apps are archived, reports are
closed, threads are resolved or marked spam, templates are deactivated. The one
`DELETE` in the codebase removes an app link a person typed a moment ago.

Retention and purge for evidence and personal data is a separate, deliberate
job — the schema is shaped so it can be added without a rewrite, and it is not
implemented here.
