# Operations Tickets

## Existing system investigation and mapping (2026-09-17)

Admin Core owns D1 and private R2. Admin Web is authenticated on every route by Cloudflare Access JWT validation; mutation requests also require same-origin JSON. Public support/report ingestion lives in apps/api, and parsed inbound email in apps/mail-ingress. Both call private Service Bindings. Public callers receive receipt identifiers only; no public ticket read API will be added.

| Existing source | New representation |
| --- | --- |
| support_threads | tickets, preserving UUID through a source mapping |
| reports + support_thread_id | one REPORT ticket for the linked conversation; report detail remains separate |
| support_messages | ticket_messages with independent direction and visibility |
| internal_note | INTERNAL; separate note API with no mail capability |
| report_events / audit_logs | preserved, projected into the unified timeline |
| support_drafts / support_reply_sends / mail headers | retained in mail transport compatibility layer |
| report_attachments / support_attachments | retained; authenticated access only |
| apps | services with stable app IDs; unknown/Studio correspondence uses tmkch.io |
| support open / pending_user | NEW / WAITING_CUSTOMER |
| support resolved / spam | CLOSED + RESOLVED / SPAM |
| reports open / reviewing / actioned / closed | NEW / TRIAGE / RESOLVED / CLOSED |
| report low / normal / high | P4 / P3 / P2 |
| content_deleted / no_action | CONTENT_REMOVED / NO_ACTION_REQUIRED |

A linked report takes lifecycle precedence over its mail thread during migration: a resolved correspondence does not imply moderation has completed. Unknown historical resolution codes are retained and map to OTHER. Historical ACKs are not invented. Successfully sent report receipt emails count as the first customer response. Failed sends and reports without an email address remain unanswered. Migration 0008 backfills the earliest successful receipt time, including tickets with a later manual reply. The automatic flag remains visible on the message.

## Rollout

1. Add domain and additive D1 schema; no legacy table deletion.
2. Backfill using unique source keys and stable message/event IDs. Re-running does not overwrite operator edits or duplicate records.
3. Keep existing ingestion and mail transport, synchronizing durable inputs transactionally into Ticket Core.
4. Route admin operations through TicketService with optimistic revision checks and events.
5. Move navigation/list/detail/dashboard to tickets. Preserve old URLs and moderation signing/evidence access.
6. Retire legacy editing entry points only after compatibility tests pass. Retain source records and mail transport tables.

## Lifecycle

NEW → TRIAGE → ACKNOWLEDGED → IN_PROGRESS → RESOLVED → CLOSED. ACK is also available directly from NEW. IN_PROGRESS can wait on the customer or internally; either wait can resume work. CLOSED/RESOLVED can reopen to IN_PROGRESS with a REOPENED event. Spam and withdrawn/invalid/duplicate requests may be resolved at triage without fictitious investigation. A resolution is mandatory on resolution/closure; reopening clears the current resolution but retains history.

## Priority and SLA

Impact × urgency: HIGH/HIGH=P1; HIGH/MEDIUM or LOW=P2; MEDIUM/HIGH=P2; LOW/LOW=P4; remaining combinations=P3. Overrides require a recorded reason. SLA defaults (minutes): P1 15/30/240, P2 60/240/1440, P3 480/1440/4320, P4 1440/2880/best-effort for ACK/first customer response/resolution. Elapsed UTC time, no business calendar or paused waiting clock. Risk begins at 80%; breached at the deadline. Imported unknown ACKs remain visibly unknown. Goals are snapshotted for existing tickets so settings edits do not retroactively rewrite targets.

## Integrity

Ticket UUID is separate from a monotonic TK number. No hard-delete endpoint. Mutations and append-only events commit together. Internal notes have their own route and cannot reach the mail provider. Merge retains source tickets and messages, closes the source as DUPLICATE and links to its target. Report-specific content operations retain the signed proposal/manifest path; selecting a resolution alone never deletes content.

## Operator workflow

- Open **Tickets** for the shared queue, or **通報 / 障害 / 問い合わせ** for filtered views. Old detail URLs redirect to the corresponding ticket.
- ACK records the first acknowledgement once. Start work, choose customer/internal wait, and record the next action and deadline. Deadline inputs use the operator's device timezone; day filters explicitly use UTC.
- Resolve with a result, then close. To edit a closed ticket, reopen to IN_PROGRESS. A customer reply to a waiting/resolved/closed ticket resumes work and adds a status/reopen event. There is no automatic close scheduler in this release.
- A missing requester email shows an internal-note-only composer. Public replies retain existing idempotency, Message-ID/In-Reply-To/References, report Reply-To routing, automatic signature insertion and signature-free drafts. Replying does not automatically choose a waiting status.
- Remeet moderation still requires the signed content action. Select deletion or no action there; no action publishes the manifest that restores report-hidden content in the app. A status/resolution label alone cannot perform or bypass that operation.
- Relations are available across requesters. Merge requires matching requester email, a nonterminal canonical target, and completed moderation on any source report. Original messages stay on the source; the target links that history and receives subsequent replies. Search can find merged ticket numbers; normal queues hide merged sources.
- Operational service/type classification does not rewrite original evidence or the original mail transport's product branding.
- Settings can maintain services, components, type-scoped categories, groups, assignees and SLA goals. Deactivate master records rather than deleting them. This does not grant login access: Cloudflare Access remains the authorization boundary.

## API and privacy boundary

All `/api/tickets/*` endpoints are on Admin Web behind Access, including masters and reply context. JSON mutations also require a same-origin request. Core is reachable only by existing private Service Bindings. Public support/report intake has no ticket read endpoint.

| Method / path | Purpose |
| --- | --- |
| GET /api/tickets | Filters/search, count and bounded page; no message bodies |
| POST /api/tickets | Internal ticket creation |
| GET /api/tickets/:id | Ticket plus a 50-item timeline page |
| PATCH /api/tickets/:id | Validated changes with expected revision |
| POST /api/tickets/:id/ack | Idempotent ACK |
| POST /api/tickets/:id/notes | Internal-only note with idempotency key |
| POST /api/tickets/:id/relations | Relation without moving data |
| POST /api/tickets/:id/merge | Merge with both expected revisions |
| GET /api/tickets/dashboard | Operations counts and queues |
| GET / POST /api/tickets/masters | Master data and SLA settings |

The existing support reply/draft/template and authenticated attachment routes remain as the mail/evidence transport. Legacy lifecycle mutation routes return 409 so they cannot bypass the Ticket service. There is no ticket/event/message delete API. Notes are written by a service that has no mail provider. Important service failures emit structured `admin_core.error` logs with operation scope; validation/conflict failures have explicit API error codes.

## Migration rehearsal result — 2026-09-18

A private production export was restored locally and migration 0006 was applied twice. Original rows were compared in full (not just their counts); no legacy rows changed. New rows were identical on replay.

| Data | Before | After |
| --- | ---: | ---: |
| Legacy support threads | 16 | 16 |
| Legacy reports | 4 | 4 |
| Legacy support messages | 26 | 26 |
| Legacy report events | 17 | 17 |
| Legacy audit entries | 55 | 55 |
| Unified tickets | — | 18 |
| Ticket source mappings | — | 20 |
| Ticket messages | — | 26 |
| Ticket events | — | 90 |
| Ticket report details | — | 4 |
| Ticket relations | — | 1 |

Missing source mappings/messages, broken report links, internal messages with recipients and terminal tickets without a resolution: all zero. Foreign-key check passed. Separate local Wrangler migration execution succeeded; the test configuration also validates Wrangler's SQL splitter because CASE/END spacing inside triggers is significant to that splitter.

These are rehearsal counts, not a claim that production migration has run. No backup contents are checked into Git.

## Deployment and recovery

1. Export `tomokichi-admin` to a private backup and record current Worker versions. Run the rehearsal and the relevant Core/Web/API/mail tests.
2. Apply D1 migration 0006 before deploying any code that reads the new tables. The existing ingestion code continues writing legacy records; transactional triggers populate the new model.
3. Deploy Admin Core, then Admin Web. Existing API and mail ingress contracts remain compatible.
4. Compare legacy/source/message counts and foreign keys remotely. Check unauthenticated ticket APIs are denied, and check authenticated queue/detail rendering. Do not send customer emails as a deployment test.
5. If the new UI needs rollback, disable operator mutations while investigating. Retain additive tables/triggers and deploy a corrected Worker. Do not drop new tables or blindly restore the pre-migration export after new messages have arrived; that would discard later data. Restoring old admin editing routes also requires reconciliation of lifecycle edits, so prefer a forward fix.

The initial release intentionally excludes automation, AI replies, on-call scheduling, complex SLA calendars and incident-specific root-cause forms. INCIDENT tickets, relations and manual follow-up are available on the shared core.

## Production release — 2026-09-18

Migration 0006 completed remotely (75 statements). Post-migration counts matched the rehearsal: 16 legacy conversations, 4 reports, 26 legacy/new messages, 18 tickets, 20 source mappings and 90 events. Missing support/report/message mappings, internal-note recipients and terminal tickets without resolutions were all zero; `foreign_key_check` returned no violations.

- Admin Core version: `d9d8d0ff-a15f-47f0-b216-d8cdaf341354`
- Admin Web version: `c831d31e-494d-4e5a-bbcf-cd34dcc50224`
- Unauthenticated production ticket endpoints were denied. The browser reaches Cloudflare Access login; authenticated production screen verification is pending operator login.
- Local and automated verification: 356 tests passed across Core, Admin Worker/UI, public API, contracts, mail provider and ingress; related typechecks/builds passed. Browser lifecycle verification used isolated local test data and sent no emails.
