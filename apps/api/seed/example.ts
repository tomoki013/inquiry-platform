import type { DeploymentSeed } from "./types.ts";

/**
 * A minimal deployment seed, for local development and as a starting point
 * for your own. Copy it next to your deployment's configuration and edit it
 * there; see docs/operations/deployment.md.
 *
 *   pnpm --filter @inquiry-platform/api seed seed/example.ts > /tmp/seed.sql
 */
const seed: DeploymentSeed = {
  apps: [
    {
      slug: "example-app",
      name: "Example App",
      platform: "ios",
      status: "live",
      description: "An app this deployment answers questions about.",
      publicUrl: "https://app.example.com",
      supportUrl: "https://example.com/support",
      links: [
        { type: "brand", label: "Brand site", url: "https://app.example.com" },
        { type: "privacy", label: "Privacy", url: "https://app.example.com/privacy" },
      ],
    },
  ],
  replyTemplates: [
    {
      key: "general_reply",
      name: "General reply",
      category: "general",
      subject: "Re: Your message about {{appName}}",
      body: [
        "Hello {{userName}},",
        "",
        "Thank you for contacting us about {{appName}}.",
        "",
        "{{answer}}",
        "",
        "If anything else comes up, you can reach us at {{supportUrl}}.",
      ].join("\n"),
      includeSignature: true,
      sortOrder: 10,
    },
  ],
  signature: ["Example Support", "https://example.com/support"].join("\n"),
  services: [{ id: "general", name: "General", slug: "general" }],
  defaultServiceId: "general",
};

export default seed;
