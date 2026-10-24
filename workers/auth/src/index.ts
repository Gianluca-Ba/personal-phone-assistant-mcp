import {
  confirmation,
  sessionCookie,
  type ConfirmationEnv,
} from "./confirmation";
import {
  AuthorizationError,
  OAuthAuthorizationServer,
  type AuthRequest,
} from "@cloudflare/workers-oauth-provider";
import { WorkerEntrypoint } from "cloudflare:workers";
const ISSUER =
  "https://personal-phone-assistant-auth.barsaglini-gianluca.workers.dev";
const RESOURCE =
  "https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp";
interface Env extends ConfirmationEnv {
  OAUTH_KV: KVNamespace;
  OWNER_LOGIN_SECRET: string;
  OWNER_TOKEN_VERSION: string;
  LOGIN_LIMITER: RateLimit;
}
const scopes = ["calls:read", "calls:write", "calls:execute", "offline_access"];
const provider = new OAuthAuthorizationServer<Env>({
  issuer: ISSUER,
  resources: [RESOURCE],
  scopesSupported: scopes,
  clientIdMetadataDocumentEnabled: true,
  clientRegistrationEndpoint: "/oauth/register",
  accessTokenTTL: 300,
  refreshTokenTTL: 2592000,
});
const escape = (v: string) =>
  v.replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
async function equal(a: string, b: string) {
  const digest = (s: string) =>
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  const [x, y] = await Promise.all([digest(a), digest(b)]);
  return (
    new Uint8Array(x).reduce((v, n, i) => v | (n ^ new Uint8Array(y)[i]), 0) ===
    0
  );
}
function page(body: string, cookie?: string) {
  return new Response(
    `<!doctype html><html lang="it"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>Personal Phone Assistant</title><body><h1>Collega il tuo assistente telefonico</h1>${body}</body></html>`,
    {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
        "Content-Security-Policy":
          "default-src 'none'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'",
        ...(cookie ? { "Set-Cookie": cookie } : {}),
      },
    },
  );
}
async function authorize(request: Request, env: Env) {
  if (
    !env.OWNER_LOGIN_SECRET ||
    env.OWNER_LOGIN_SECRET.length < 32 ||
    !env.OWNER_TOKEN_VERSION
  )
    return new Response("Owner authentication not configured", { status: 503 });
  const oauth = provider.getOAuthApi(env);
  if (request.method === "GET") {
    let auth: AuthRequest;
    try {
      auth = await oauth.parseAuthRequest(request);
    } catch (e) {
      if (e instanceof AuthorizationError)
        return e.redirectTo
          ? Response.redirect(e.redirectTo, 302)
          : new Response(e.description, { status: 400 });
      throw e;
    }
    if (auth.scope.some((s) => !scopes.includes(s)))
      return new Response("Unsupported scope", { status: 400 });
    const nonce = crypto.randomUUID();
    await env.OAUTH_KV.put(`consent:${nonce}`, JSON.stringify(auth), {
      expirationTtl: 600,
    });
    const client = await oauth.describeConsent(auth);
    return page(
      `<p>Client: ${escape(client.clientName)}</p><p>Destinazione dell’autorizzazione: <strong>${escape(client.redirectHost)}</strong></p><p>${client.clientDomain ? "Dominio verificato del client: " + escape(client.clientDomain) : "Il nome del client è dichiarato dal client e non è verificato."}</p>${client.redirectIsLoopback ? "<p>La destinazione è un’app locale: verifica quale applicazione stai autorizzando.</p>" : ""}<p>Permessi: ${escape(auth.scope.join(", "))}. calls:read consulta i dati privati; calls:write prepara richieste; calls:execute permette di richiedere la conferma per avviare una telefonata a pagamento. L’avvio richiede sempre un clic separato del proprietario.</p><form method="post"><input type="hidden" name="nonce" value="${nonce}"><label>Segreto proprietario <input type="password" name="secret" required autocomplete="current-password" maxlength="256"></label><button type="submit">Autorizza accesso</button></form>`,
      `consent=${nonce}; HttpOnly; Secure; SameSite=Strict; Path=/authorize; Max-Age=600`,
    );
  }
  if (request.method !== "POST")
    return new Response("Method not allowed", { status: 405 });
  if (request.headers.get("Origin") !== ISSUER)
    return new Response("Forbidden", { status: 403 });
  const limited = await env.LOGIN_LIMITER.limit({
    key: request.headers.get("CF-Connecting-IP") ?? "unknown",
  });
  if (!limited.success) return new Response("Try again later", { status: 429 });
  if (Number(request.headers.get("Content-Length") ?? 0) > 4096)
    return new Response("Too large", { status: 413 });
  const body = await request.text();
  if (body.length > 4096) return new Response("Too large", { status: 413 });
  const form = new URLSearchParams(body),
    nonce = form.get("nonce") ?? "";
  const cookie = request.headers
    .get("Cookie")
    ?.match(/(?:^|;\s*)consent=([^;]+)/)?.[1];
  if (!/^[a-f0-9-]{36}$/.test(nonce) || cookie !== nonce)
    return new Response("Invalid consent", { status: 403 });
  const stored = await env.OAUTH_KV.get(`consent:${nonce}`);
  if (
    !stored ||
    !(await equal(form.get("secret") ?? "", env.OWNER_LOGIN_SECRET))
  )
    return new Response("Invalid credentials or expired consent", {
      status: 403,
    });
  await env.OAUTH_KV.delete(`consent:${nonce}`);
  const result = await oauth.completeAuthorization({
    request: JSON.parse(stored),
    userId: "owner",
    metadata: {},
    scope: JSON.parse(stored).scope,
    props: { userId: "owner", version: env.OWNER_TOKEN_VERSION },
  });
  const headers = new Headers({
    Location: result.redirectTo,
    "Cache-Control": "no-store",
  });
  headers.append(
    "Set-Cookie",
    "consent=; HttpOnly; Secure; SameSite=Strict; Path=/authorize; Max-Age=0",
  );
  headers.append("Set-Cookie", await sessionCookie(env));
  return new Response(null, { status: 302, headers });
}
export class AuthServer extends WorkerEntrypoint<Env> {
  async fetch(request: Request) {
    try {
      if (new URL(request.url).pathname === "/confirm")
        return await confirmation(request, this.env);
      return new URL(request.url).pathname === "/authorize"
        ? await authorize(request, this.env)
        : await provider.fetch(request, this.env, this.ctx);
    } catch {
      return new Response("Authorization service unavailable", { status: 503 });
    }
  }
  validateToken(resource: string, token: string) {
    return provider.validateToken(resource, token, this.env);
  }
}
export default AuthServer;
