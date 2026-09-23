/**
 * The only HTML this system ever generates for an outgoing mail.
 *
 * Plain text is the source of truth; some clients render `text/plain` badly
 * enough that a `<pre>` copy is worth sending alongside. It is built by
 * escaping, never by templating, so nothing an operator types — or pastes out
 * of a customer's message — can become markup.
 */

/**
 * The one picture an HTML mail may carry, beside the signature. Chosen by the
 * deployment, never by anything an operator types: nothing in `signatureText`
 * can add another `<img>`.
 */
export interface MailLogo {
  url: string;
  alt: string;
}

function escapeAttribute(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function renderContent(text: string, signatureText?: string, logo?: MailLogo): string {
  if (signatureText && text.endsWith(`\n\n${signatureText}`)) {
    const body = text.slice(0, -signatureText.length - 2);
    const lines = signatureText.split("\n").filter((line) => !/^[─━—-]+$/.test(line));
    const brand = renderContent(lines.shift() ?? "");
    const details = renderContent(lines.join("\n"));
    const picture = logo
      ? `<td style="padding:4px 16px 4px 0;vertical-align:top"><img src="${escapeAttribute(logo.url)}" width="56" height="56" alt="${escapeAttribute(logo.alt)}" style="display:block;width:56px;height:56px;border-radius:50%"></td>`
      : "";
    return `${renderContent(body)}<table role="presentation" style="margin-top:28px;border-collapse:collapse"><tr>${picture}<td style="border-left:3px solid #426b62;padding:4px 0 4px 18px;vertical-align:top"><div class="mail-brand" style="font-weight:600;letter-spacing:0.06em;color:#254b43;margin-bottom:6px">${brand}</div><div class="mail-muted" style="color:#58655f">${details}</div></td></tr></table>`;
  }
  const escaped = escapeAttribute(text);
  return `<div style="white-space:pre-wrap;font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.7">${escaped}</div>`;
}

/** A single document wrapper lets mail readers opt in to their dark appearance. */
export function plainTextToSafeHtml(text: string, signatureText?: string, logo?: MailLogo): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="color-scheme" content="light dark"><meta name="supported-color-schemes" content="light dark"><style>
:root { color-scheme: light dark; supported-color-schemes: light dark; }
body { margin: 0; padding: 16px; background-color: #ffffff; color: #222222; }
@media (prefers-color-scheme: dark) {
  body, .mail-body { background-color: #1c1c1e !important; color: #f2f2f7 !important; }
  .mail-brand { color: #a8d5c9 !important; }
  .mail-muted { color: #c2ccc7 !important; }
}
[data-ogsc] .mail-body { background-color: #1c1c1e !important; color: #f2f2f7 !important; }
[data-ogsc] .mail-brand { color: #a8d5c9 !important; }
[data-ogsc] .mail-muted { color: #c2ccc7 !important; }
</style></head><body class="mail-body">${renderContent(text, signatureText, logo)}</body></html>`;
}
