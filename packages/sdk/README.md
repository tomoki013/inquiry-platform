# @inquiry-platform/sdk

The contract and client a Project uses to hand contacts and reports to an
inquiry-platform deployment. No runtime dependencies; TypeScript source, meant
to be bundled by Wrangler with the Project's Worker.

## Install

Pin a release tag:

```jsonc
// package.json
"dependencies": {
  "@inquiry-platform/sdk": "github:tomoki013/inquiry-platform#v0.1.0&path:/packages/sdk"
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
