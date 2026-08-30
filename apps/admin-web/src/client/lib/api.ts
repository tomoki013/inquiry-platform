/**
 * The one way the client talks to the Worker.
 *
 * Same origin, always JSON, and every failure carries the `requestId` the
 * server logged — so "something went wrong" on screen can be matched to the
 * actual error without the actual error ever being sent to the browser.
 */
export class ApiError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly requestId: string | undefined,
    readonly fields?: Record<string, string>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

interface Envelope<T> {
  ok: boolean;
  data?: T;
  error?: { code: string; message: string; fields?: Record<string, string> };
  requestId?: string;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
    // Access's cookie rides along; nothing else does.
    credentials: "same-origin",
  });

  let envelope: Envelope<T>;
  try {
    envelope = (await response.json()) as Envelope<T>;
  } catch {
    throw new ApiError("INTERNAL_ERROR", "応答を読み取れませんでした。", undefined);
  }

  if (!response.ok || !envelope.ok) {
    throw new ApiError(
      envelope.error?.code ?? "INTERNAL_ERROR",
      envelope.error?.message ?? "問題が発生しました。",
      envelope.requestId,
      envelope.error?.fields,
    );
  }
  return envelope.data as T;
}

export const api = {
  get: <T>(path: string) => call<T>(path),
  post: <T>(path: string, body: unknown) =>
    call<T>(path, { method: "POST", body: JSON.stringify(body ?? {}) }),
  patch: <T>(path: string, body: unknown) =>
    call<T>(path, { method: "PATCH", body: JSON.stringify(body ?? {}) }),
  put: <T>(path: string, body: unknown) =>
    call<T>(path, { method: "PUT", body: JSON.stringify(body ?? {}) }),
  del: <T>(path: string) => call<T>(path, { method: "DELETE" }),
};

export function query(params: Record<string, string | number | boolean | undefined>): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "") continue;
    search.set(key, String(value));
  }
  const rendered = search.toString();
  return rendered ? `?${rendered}` : "";
}
