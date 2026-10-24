import { insufficientScope } from "@cloudflare/workers-oauth-provider";
// Scope discovery is a read-only preflight. It must run before MCP dispatch/side effects.
export function requiredToolScopes(name: unknown): string[] {
  if (name === "create_outbound_request") return ["calls:read", "calls:write"];
  if (name === "approve_outbound_request")
    return ["calls:read", "calls:execute"];
  return ["calls:read"];
}
export function oauthToolMetadata(name: string) {
  // The pinned SDK preserves _meta on tools/list; this is ChatGPT's documented
  // compatibility location for securitySchemes. Enforcement remains server-side.
  return {
    _meta: {
      securitySchemes: [{ type: "oauth2", scopes: requiredToolScopes(name) }],
    },
  };
}
export async function scopePreflight(request: Request): Promise<
  | {
      request: Request;
      scopes: string[];
      rpcId?: string | number;
      listTools?: boolean;
    }
  | Response
> {
  if (
    request.method !== "POST" ||
    !request.headers
      .get("Content-Type")
      ?.toLowerCase()
      .startsWith("application/json")
  )
    return { request, scopes: ["calls:read"] };
  const reader = request.body?.getReader();
  let text = "",
    size = 0;
  const decoder = new TextDecoder();
  if (reader) {
    try {
      for (;;) {
        const part = await reader.read();
        if (part.done) break;
        size += part.value.byteLength;
        if (size > 65536) {
          void reader.cancel();
          return new Response("MCP request too large", { status: 413 });
        }
        text += decoder.decode(part.value, { stream: true });
      }
      text += decoder.decode();
    } catch {
      return new Response("Invalid MCP body", { status: 400 });
    }
  }
  let rpc: unknown;
  try {
    rpc = JSON.parse(text);
  } catch {
    return new Response("Invalid JSON", { status: 400 });
  }
  // MCP 2025-06-18+ does not support JSON-RPC batching. Reject it explicitly so
  // no hidden tools/call can evade the operation-specific scope preflight.
  if (!rpc || typeof rpc !== "object" || Array.isArray(rpc))
    return new Response("Expected one JSON-RPC message", { status: 400 });
  const message = rpc as {
    id?: unknown;
    method?: unknown;
    params?: { name?: unknown };
  };
  const scopes =
    message.method === "tools/call"
      ? requiredToolScopes(message.params?.name)
      : ["calls:read"];
  const headers = new Headers(request.headers);
  headers.delete("Content-Length");
  return {
    request: new Request(request, { body: text, headers }),
    scopes,
    rpcId:
      typeof message.id === "string" || typeof message.id === "number"
        ? message.id
        : undefined,
    listTools: message.method === "tools/list",
  };
}

export function scopeChallenge(
  auth: Parameters<typeof insufficientScope>[0],
  scopes: string[],
  id?: string | number,
) {
  const challenge = insufficientScope(
    auth,
    scopes,
    "Additional OAuth permissions required for this operation",
  );
  if (id === undefined) return challenge;
  // Preserve the provider's normative HTTP 403 + WWW-Authenticate response and
  // also carry ChatGPT's documented tool-level authentication signal.
  return Response.json(
    {
      jsonrpc: "2.0",
      id,
      result: {
        isError: true,
        content: [
          {
            type: "text",
            text: "Additional OAuth permissions required. Authorize the requested scopes and retry.",
          },
        ],
        _meta: {
          "mcp/www_authenticate": [challenge.headers.get("WWW-Authenticate")!],
        },
      },
    },
    { status: challenge.status, headers: challenge.headers },
  );
}
export async function exposeSecuritySchemes(response: Response) {
  if (
    !response.ok ||
    !response.headers.get("Content-Type")?.includes("application/json")
  )
    return response;
  const body = (await response.json()) as {
    result?: {
      tools?: Array<{
        _meta?: { securitySchemes?: unknown };
        securitySchemes?: unknown;
      }>;
    };
  };
  for (const tool of body.result?.tools ?? [])
    if (tool._meta?.securitySchemes)
      tool.securitySchemes = tool._meta.securitySchemes;
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  return Response.json(body, {
    status: response.status,
    headers,
  });
}
