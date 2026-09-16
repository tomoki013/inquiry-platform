/**
 * The only HTML this system ever generates for an outgoing mail.
 *
 * Plain text is the source of truth; some clients render `text/plain` badly
 * enough that a `<pre>` copy is worth sending alongside. It is built by
 * escaping, never by templating, so nothing an operator types — or pastes out
 * of a customer's message — can become markup.
 */

/**
 * The studio logo shown beside the HTML signature. Served from the main site
 * so every mail points at one file, and the only `<img>` this system ever
 * emits — nothing in `signatureText` can add another.
 */
export const SIGNATURE_LOGO_URL = "https://tmkch.io/assets/mail-logo.png";

export function plainTextToSafeHtml(text: string, signatureText?: string): string {
  if (signatureText && text.endsWith(`\n\n${signatureText}`)) {
    const body = text.slice(0, -signatureText.length - 2);
    const lines = signatureText.split("\n").filter((line) => !/^[─━—-]+$/.test(line));
    const brand = plainTextToSafeHtml(lines.shift() ?? "");
    const details = plainTextToSafeHtml(lines.join("\n"));
    const logo = `<img src="${SIGNATURE_LOGO_URL}" width="56" height="56" alt="Tomokichi Studio" style="display:block;width:56px;height:56px;border-radius:50%">`;
    return `${plainTextToSafeHtml(body)}<table role="presentation" style="margin-top:28px;border-collapse:collapse"><tr><td style="padding:4px 16px 4px 0;vertical-align:top">${logo}</td><td style="border-left:3px solid #426b62;padding:4px 0 4px 18px;vertical-align:top"><div style="font-weight:600;letter-spacing:0.06em;color:#254b43;margin-bottom:6px">${brand}</div><div style="color:#58655f">${details}</div></td></tr></table>`;
  }
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<div style="white-space:pre-wrap;font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.7">${escaped}</div>`;
}
