import { type AdminRole, can, permissionFor } from "@inquiry-platform/core";

const VERSION = "2025-11-25";
const list = (name: string, description: string, path: string) => ({
  name,
  description,
  path,
  inputSchema: { type: "object", properties: {}, additionalProperties: false },
});
const detail = (name: string, description: string, path: string) => ({
  name,
  description,
  path,
  inputSchema: {
    type: "object",
    properties: { id: { type: "string", pattern: "^[A-Za-z0-9_-]{1,200}$" } },
    required: ["id"],
    additionalProperties: false,
  },
});
const tools = [
  list("list_inquiries", "List recent inquiry conversations", "/api/support/threads"),
  detail("get_inquiry", "Read an inquiry conversation by its ID", "/api/support/threads"),
  list("list_reports", "List recent moderation reports", "/api/reports"),
  detail("get_report", "Read a moderation report by its ID", "/api/reports"),
];

const object = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;

export async function readOnlyMcp(
  request: Request,
  role: AdminRole,
  origin: string,
  readApi: (path: string) => Promise<Response>,
): Promise<Response> {
  const requestOrigin = request.headers.get("Origin");
  if (requestOrigin !== null && requestOrigin !== origin)
    return new Response(null, { status: 403 });
  if (request.method !== "POST")
    return new Response(null, { status: 405, headers: { Allow: "POST" } });
  const protocolVersion = request.headers.get("MCP-Protocol-Version");
  if (protocolVersion && protocolVersion !== VERSION) return new Response(null, { status: 400 });
  if (
    request.headers.get("Content-Type")?.split(";")[0]?.trim().toLowerCase() !== "application/json"
  )
    return new Response(null, { status: 415 });

  const rpcError = (id: unknown, code: number, message: string, status = 200) =>
    Response.json({ jsonrpc: "2.0", id, error: { code, message } }, { status });
  let message: Record<string, unknown> | null;
  try {
    message = object(await request.json());
  } catch {
    return rpcError(null, -32700, "Parse error", 400);
  }
  if (message?.jsonrpc !== "2.0" || typeof message.method !== "string")
    return rpcError(null, -32600, "Invalid Request", 400);
  if (message.id === undefined) return new Response(null, { status: 202 });
  if (typeof message.id !== "string" && typeof message.id !== "number")
    return rpcError(null, -32600, "Invalid Request", 400);
  const { id, method } = message;
  const result = (value: unknown) => Response.json({ jsonrpc: "2.0", id, result: value });
  const available = tools.filter(({ path }) => {
    const permission = permissionFor("GET", path);
    return permission !== null && can(role, permission);
  });
  if (method === "initialize")
    return result({
      protocolVersion: VERSION,
      capabilities: { tools: {} },
      serverInfo: { name: "inquiry-platform", version: "1" },
    });
  if (method === "ping") return result({});
  if (method === "tools/list")
    return result({
      tools: available.map(({ name, description, inputSchema }) => ({
        name,
        description,
        inputSchema,
        annotations: { readOnlyHint: true },
      })),
    });
  if (method !== "tools/call") return rpcError(id, -32601, "Method not found");
  const params = object(message.params);
  const tool = available.find(({ name }) => name === params?.name);
  if (!tool) return rpcError(id, -32602, "Unknown tool");
  const args = params?.arguments === undefined ? {} : object(params.arguments);
  const needsId = "required" in tool.inputSchema;
  if (
    !args ||
    (needsId
      ? Object.keys(args).length !== 1 ||
        typeof args.id !== "string" ||
        !/^[A-Za-z0-9_-]{1,200}$/.test(args.id)
      : Object.keys(args).length !== 0)
  )
    return rpcError(id, -32602, "Invalid arguments");
  const response = await readApi(needsId ? `${tool.path}/${args.id}` : tool.path);
  const payload = object(await response.json());
  const data = object(payload?.data);
  const isError =
    !response.ok ||
    payload?.ok !== true ||
    (tool.name === "get_inquiry" && Boolean(data?.reportId));
  return result({
    content: [
      {
        type: "text",
        text: isError ? "The requested record is unavailable." : JSON.stringify(data),
      },
    ],
    isError,
  });
}
