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
  "@inquiry-platform/sdk": "github:example-org/inquiry-platform#v0.2.0&path:/packages/sdk"
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

## Operator API

運用者向けの画面、CLI、自動化は各自で実装できますが、標準機能は gateway の API を呼びます。ブラウザから別 Origin へ直接呼ぶ CORS は提供しないため、同一 Origin または利用者側の BFF を使ってください。

```ts
import { createPlatformApiClient } from "@inquiry-platform/sdk";

const api = createPlatformApiClient({ origin: "https://api.example.com", token });
const descriptor = await api.describe();
```

`GET /api` と SDK の descriptor が示す機能は platform-owned です。認証・認可・検証・監査・通知・エラー形式を Project 側で複製しないでください。独自機能は gateway の標準 path を上書きせず、別 Worker / 別 namespace として追加します。
