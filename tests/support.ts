let authorizationSequence = 0;
// OAuth client simulation for local tests; never sends a real phone request.
export async function login(
  auth: { fetch: Function },
  scope: string,
  secret: string,
  existingClientId?: string,
  exchangeVerifier?: string,
) {
  const issuer =
    "https://personal-phone-assistant-auth.barsaglini-gianluca.workers.dev";
  const resource =
    "https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp";
  const redirect = "https://client.example/callback";
  const meta = await (
    await auth.fetch(issuer + "/.well-known/oauth-authorization-server")
  ).json();
  const client = existingClientId
    ? { client_id: existingClientId }
    : await (
        await auth.fetch(meta.registration_endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            redirect_uris: [redirect],
            token_endpoint_auth_method: "none",
          }),
        })
      ).json();
  const verifier = "b".repeat(64),
    digest = await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(verifier),
    );
  const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
  const url = new URL(meta.authorization_endpoint);
  for (const [k, v] of Object.entries({
    response_type: "code",
    client_id: client.client_id,
    redirect_uri: redirect,
    scope,
    code_challenge: challenge,
    code_challenge_method: "S256",
    resource,
  }))
    url.searchParams.set(k, v);
  const consent = await auth.fetch(url);
  const html = await consent.text();
  const nonce = /name="nonce" value="([^"]+)"/.exec(html)![1];
  const approved = await auth.fetch(issuer + "/authorize", {
    method: "POST",
    redirect: "manual",
    headers: {
      "CF-Connecting-IP": `192.0.2.${++authorizationSequence}`,
      Origin: issuer,
      Cookie: consent.headers.get("set-cookie")!.split(";")[0],
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({ nonce, secret }),
  });
  const code = new URL(approved.headers.get("location")).searchParams.get(
    "code",
  )!;
  const tokens = await (
    await auth.fetch(meta.token_endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        client_id: client.client_id,
        redirect_uri: redirect,
        code,
        code_verifier: exchangeVerifier ?? verifier,
        resource,
      }),
    })
  ).json();
  return { ...tokens, clientId: client.client_id };
}
