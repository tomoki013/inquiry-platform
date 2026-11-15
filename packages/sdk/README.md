# @inquiry-platform/sdk

The contract and client a Project uses to hand contacts and reports to an
inquiry-platform deployment. It also contains transport for the
platform-owned operator API. No UI is included and there are no runtime
dependencies.

## Install

Pin a release tag:

```jsonc
// package.json
"dependencies": {
  "@inquiry-platform/sdk": "github:example-org/inquiry-platform#v0.3.1&path:/packages/sdk"
}
```

## Bind

The Project's Worker binds to the platform's `Intake` entrypoint. `props`
decide which Projects this Worker may write for; without valid `props` every
call is refused.

```jsonc
// wrangler.jsonc of the Project's Worker
"services": [
  {
    "binding": "INQUIRY",
    "service": "<your inquiry-core Worker name>",
    "entrypoint": "Intake",
    "props": { "caller": "my-api", "projects": ["my-app"], "allowUnassigned": true }
  }
]
```

## Use

```ts
import { createInquiryClient } from "@inquiry-platform/sdk";

const inquiry = createInquiryClient(env.INQUIRY);
await inquiry.createContact({
  projectSlug: "my-app",
  idempotencyKey: requestId,
  subject,
  message,
  email,
  channel: "web_form",
});

const report = await inquiry.createReport({
  projectSlug: "my-app",
  externalReportId,
  targetType: "post",
  targetId,
  targetOwnerId,
  reason: "spam",
  description,
});
if (report.ok) await inquiry.attachReportEvidence(report.value.reportId, { bytes, contentType });
```

Every call returns a `Result`: a receipt number and a simplified status
(`OPEN`, `IN_PROGRESS`, `RESOLVED`, `CLOSED`) on success, an error code
otherwise. Nothing the platform stores is ever read back through this client.
See [docs/architecture/overview.md §7](../../docs/architecture/overview.md#7-intake-と-sdk).

A Project that wants to carry out moderation decisions itself implements the
`ModerationAdapter` contract (`ModerationRequest` and friends are exported
here) as a `WorkerEntrypoint` and is registered in the deployment's
`SIGNED_MODERATION`.

## Turnstile on public intake

When the deployment requires Turnstile for an intake, render its widget in the Project's form and pass the response as `turnstileToken` to `createContact` or `createReport`. The platform verifies it before saving. Keep the same submission key when retrying the same input. A submission that already succeeded returns its original receipt. A new submission needs a fresh token.

## Your own console: `ProjectOperator`

A Project that runs its own admin binds a second entrypoint to work its own
tickets. The binding's `props` name the projects; nothing is added to the
platform's gateway or its Access application.

```jsonc
"services": [
  {
    "binding": "INQUIRY_OPERATOR",
    "service": "<your inquiry-core Worker name>",
    "entrypoint": "ProjectOperator",
    "props": { "caller": "my-api", "projects": ["my-app"] }
  }
]
```

```ts
import { createProjectOperatorClient } from "@inquiry-platform/sdk";

const tickets = createProjectOperatorClient(env.INQUIRY_OPERATOR, "my-app");
const page = await tickets.listTickets({ status: "open", offset: 0 });
const ticket = await tickets.getTicket("TK-000123"); // id or number
await tickets.changeTicket(ticket.id, { revision, status: "ACKNOWLEDGED" }, { id: operatorId });
await tickets.reply(ticket.id, { body, idempotencyKey }, { id: operatorId });
await tickets.setSignature("My App\nhttps://my-app.example", { id: operatorId });
```

### Copying yourself on a reply

`reply` takes `ccSelf: true` to put the operator's own private address on the
mail's Cc. The address is the project's notification recipient
(`mailSettings[].notificationEmail`) or, without one, the deployment's
`NOTIFICATION_EMAIL`. The request never names an address: recipient, Cc,
sender and subject all stay the platform's decision.

```ts
const sent = await tickets.reply(ticket.id, { body, idempotencyKey, ccSelf: true }, { id: operatorId });
if (sent.ok && sent.value.selfCopy === "not_configured") {
  // Sent to the person, without your copy: no operator address is set.
}
```

`selfCopy` is `copied`, `not_configured` (no address; the reply is still sent)
or `is_recipient` (the address is the person's or the support address, which
get the mail anyway). It is present only when `ccSelf` was asked for and this
call sent the reply; a retried `idempotencyKey` answers without it. Nobody is
copied twice: if the person's mail already had the address on it, reply-all
keeps one. Each timeline message carries `recipient` (the person, then every
Cc), so the copy shows there too. The audit log records the number of Cc
addresses and the `selfCopy` outcome, never the addresses.

A reply is threaded (`In-Reply-To`) onto the latest mail in the
conversation, whichever side sent it, so a second reply in a row follows your
first one.

Who may use the console is your admin's authentication; the platform records
`operator.id` (an opaque id of your choosing, never an address) in its audit
log. Point notification links at your console with the deployment seed's
`mailSettings[].ticketUrlTemplate`.

## Operator API

基盤全体を運用する画面、CLI、自動化は gateway の API を呼びます（Access の背後）。Project 自身の管理画面は上の `ProjectOperator` を使います。ブラウザから別 Origin へ直接呼ぶ CORS は提供しないため、同一 Origin または利用者側の BFF を使ってください。

```ts
import { createPlatformApiClient } from "@inquiry-platform/sdk";

const api = createPlatformApiClient({ origin: "https://api.example.com", token });
const descriptor = await api.describe();
```

`GET /api` と SDK の descriptor が示す機能は platform-owned です。認証・認可・検証・監査・通知・エラー形式を Project 側で複製しないでください。独自機能は gateway の標準 path を上書きせず、別 Worker / 別 namespace として追加します。
