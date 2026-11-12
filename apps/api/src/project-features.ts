import { z } from "zod";

const common = {
  enabled: z.boolean().default(true),
  reply: z.boolean().default(false),
  receipt: z.boolean().default(false),
  inbound: z.boolean().default(false),
  attachments: z.boolean().default(false),
  drafts: z.boolean().default(false),
  templates: z.boolean().default(false),
  signature: z.boolean().default(false),
  receiptSignature: z.boolean().optional(),
  replySignature: z.boolean().optional(),
  notifyEmail: z.boolean().default(false),
  notifyPush: z.boolean().default(false),
  sla: z.boolean().default(false),
  assignment: z.boolean().default(false),
  classification: z.boolean().default(false),
  relations: z.boolean().default(false),
};

const turnstile = z
  .object({
    secretBinding: z.string().regex(/^TURNSTILE_SECRET_[A-Z0-9_]+$/),
    hostnames: z.array(z.hostname()).min(1),
    action: z.string().regex(/^[a-zA-Z0-9_-]{1,32}$/),
    trustedCallers: z.array(z.string().min(1)).default([]),
  })
  .strict();
const domain = z
  .object({
    ...common,
    newFromEmail: z.boolean().default(false),
    turnstile: turnstile.optional(),
  })
  .strict();
const project = z.object({ inquiry: domain.optional(), report: domain.optional() }).strict();
const legacy = domain.parse({
  reply: true,
  receipt: true,
  inbound: true,
  attachments: true,
  drafts: true,
  templates: true,
  signature: true,
  notifyEmail: true,
  notifyPush: true,
  sla: true,
  assignment: true,
  classification: true,
  relations: true,
  newFromEmail: true,
});

export type Domain = "inquiry" | "report";
export type DomainFeatures = z.infer<typeof domain>;
export type ProjectFeatures = ReturnType<typeof projectFeatures>;

/** Keys are service IDs, resolved by the Worker. An omitted domain preserves legacy behavior. */
export function projectFeatures(raw: unknown) {
  const projects = raw === undefined ? {} : z.record(z.string(), project).parse(raw);
  const configured = (id: string | undefined, kind: Domain) =>
    id && Object.hasOwn(projects, id) ? projects[id]?.[kind] : undefined;
  return Object.assign(
    (id: string | undefined, kind: Domain): DomainFeatures => configured(id, kind) ?? legacy,
    {
      configured,
      disabled: (kind: Domain, feature: "receipt" | "sla") =>
        Object.keys(projects).filter((id) => {
          const config = configured(id, kind);
          return config?.enabled === false || config?.[feature] === false;
        }),
    },
  );
}
