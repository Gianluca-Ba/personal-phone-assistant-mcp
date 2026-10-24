import type { ApprovalServer } from "../../mcp/src/approval";
export interface ConfirmationEnv {
  OAUTH_KV: KVNamespace;
  OWNER_LOGIN_SECRET: string;
  OWNER_TOKEN_VERSION: string;
  LOGIN_LIMITER: RateLimit;
  MCP_SERVER: Service<ApprovalServer>;
}
const issuer =
  "https://personal-phone-assistant-auth.barsaglini-gianluca.workers.dev";
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const cookie = (request: Request, name: string) =>
  request.headers
    .get("cookie")
    ?.match(new RegExp(`(?:^|;\\s*)${name}=([^;]+)`))?.[1];
async function key(secret: string) {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}
export async function sessionCookie(env: ConfirmationEnv) {
  const payload = `${Date.now() + 2592000000}:${env.OWNER_TOKEN_VERSION}`;
  const signature = await crypto.subtle.sign(
    "HMAC",
    await key(env.OWNER_LOGIN_SECRET),
    new TextEncoder().encode(payload),
  );
  const hex = Array.from(new Uint8Array(signature), (b) =>
    b.toString(16).padStart(2, "0"),
  ).join("");
  return `owner_session=${payload}.${hex}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=2592000`;
}
async function authenticated(request: Request, env: ConfirmationEnv) {
  const value = cookie(request, "owner_session") ?? "";
  const match = /^(\d+):([A-Za-z0-9_-]+)\.([a-f0-9]{64})$/.exec(value);
  if (
    !match ||
    Number(match[1]) < Date.now() ||
    match[2] !== env.OWNER_TOKEN_VERSION
  )
    return false;
  const bytes = new Uint8Array(
    match[3].match(/../g)!.map((v) => parseInt(v, 16)),
  );
  return crypto.subtle.verify(
    "HMAC",
    await key(env.OWNER_LOGIN_SECRET),
    bytes,
    new TextEncoder().encode(`${match[1]}:${match[2]}`),
  );
}
function page(body: string, setCookie?: string) {
  return new Response(
    `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Conferma telefonata</title><body><h1>Conferma telefonata a pagamento</h1>${body}</body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "same-origin",
        "Content-Security-Policy":
          "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        ...(setCookie ? { "Set-Cookie": setCookie } : {}),
      },
    },
  );
}
export async function confirmation(request: Request, env: ConfirmationEnv) {
  if (!env.OWNER_LOGIN_SECRET || env.OWNER_LOGIN_SECRET.length < 32)
    return new Response("Not configured", { status: 503 });
  if (request.method === "GET") {
    const u = new URL(request.url),
      id = u.searchParams.get("id") ?? "",
      ticket = u.searchParams.get("ticket") ?? "";
    if (!/^[a-f0-9-]{36}$/.test(id) || !/^[a-f0-9-]{72}$/.test(ticket))
      return new Response("Invalid confirmation", { status: 400 });
    const logged = await authenticated(request, env);
    let body =
      "<p>Accedi per visualizzare e confermare la richiesta. Questo passaggio non avvia la chiamata.</p>";
    if (logged) {
      const details = await env.MCP_SERVER.describeTicket(id, ticket);
      body = `<p>Destinatario: <strong>${escape(details.destination)}</strong></p><p>Lingua: ${escape(details.language)}</p><p>Istruzioni:</p><pre>${escape(details.instructions)}</pre><p>Confermando, l’assistente avvierà una telefonata che può generare costi.</p>`;
    }
    const nonce = crypto.randomUUID();
    await env.OAUTH_KV.put(
      `confirm:${nonce}`,
      JSON.stringify({ id, ticket, action: logged ? "confirm" : "login" }),
      { expirationTtl: 600 },
    );
    return page(
      body +
        `<form method="post" action="/confirm"><input type="hidden" name="nonce" value="${nonce}">${logged ? "" : '<label>Segreto proprietario <input type="password" name="secret" required maxlength="256" autocomplete="current-password"></label>'}<button type="submit">${logged ? "Confermo: avvia questa telefonata" : "Accedi e mostra i dettagli"}</button></form>`,
      `confirm_nonce=${nonce}; HttpOnly; Secure; SameSite=Lax; Path=/confirm; Max-Age=600`,
    );
  }
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (request.headers.get("Origin") !== issuer)
    return new Response("Forbidden", { status: 403 });
  const limited = await env.LOGIN_LIMITER.limit({
    key: request.headers.get("CF-Connecting-IP") ?? "unknown",
  });
  if (!limited.success) return new Response("Try again later", { status: 429 });
  const text = await request.text();
  if (text.length > 4096) return new Response("Too large", { status: 413 });
  const form = new URLSearchParams(text),
    nonce = form.get("nonce") ?? "";
  if (
    !/^[a-f0-9-]{36}$/.test(nonce) ||
    cookie(request, "confirm_nonce") !== nonce
  )
    return new Response("Invalid confirmation", { status: 403 });
  const saved = await env.OAUTH_KV.get(`confirm:${nonce}`);
  if (!saved) return new Response("Expired confirmation", { status: 403 });
  const { id, ticket, action } = JSON.parse(saved);
  if (action === "login") {
    const signature = await crypto.subtle.sign(
      "HMAC",
      await key(env.OWNER_LOGIN_SECRET),
      new TextEncoder().encode("owner-login"),
    );
    const correct = await crypto.subtle.verify(
      "HMAC",
      await key(form.get("secret") ?? "invalid"),
      signature,
      new TextEncoder().encode("owner-login"),
    );
    if (!correct) return new Response("Invalid credentials", { status: 403 });
    await env.OAUTH_KV.delete(`confirm:${nonce}`);
    return new Response(null, {
      status: 302,
      headers: {
        Location: `/confirm?id=${id}&ticket=${ticket}`,
        "Set-Cookie": await sessionCookie(env),
        "Cache-Control": "no-store",
        "Referrer-Policy": "same-origin",
      },
    });
  }
  if (!(await authenticated(request, env)))
    return new Response("Sign in again", { status: 403 });
  await env.OAUTH_KV.delete(`confirm:${nonce}`);
  const result = await env.MCP_SERVER.confirmTicket(id, ticket);
  return page(
    `<p>Richiesta ${escape(result.id)} inviata. Controlla l’esito da ChatGPT con get_outbound_status.</p>`,
  );
}
