import { MAX_ATTACHMENT_BYTES } from "@inquiry-platform/core";

/** Reads the body only if it is small enough, so an oversized upload cannot be
 * buffered into memory before being rejected. */
export async function readBounded(request: Request): Promise<Uint8Array | null> {
  const declared = Number(request.headers.get("Content-Length") ?? "0");
  if (declared > MAX_ATTACHMENT_BYTES) return null;
  const bytes = new Uint8Array(await request.arrayBuffer());
  return bytes.byteLength > MAX_ATTACHMENT_BYTES ? null : bytes;
}

export function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}
