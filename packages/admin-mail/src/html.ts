/**
 * The only HTML this system ever generates for an outgoing mail.
 *
 * Plain text is the source of truth; some clients render `text/plain` badly
 * enough that a `<pre>` copy is worth sending alongside. It is built by
 * escaping, never by templating, so nothing an operator types — or pastes out
 * of a customer's message — can become markup.
 */
export function plainTextToSafeHtml(text: string): string {
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return `<div style="white-space:pre-wrap;font-family:ui-sans-serif,system-ui,sans-serif;font-size:14px;line-height:1.7">${escaped}</div>`;
}
