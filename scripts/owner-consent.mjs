#!/usr/bin/env node
// Owner-operated only. Agents must never initialize or unlock the owner's key.
import { generateKeyPairSync, createPrivateKey, sign } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface, emitKeypressEvents } from "node:readline";
import { pathToFileURL } from "node:url";

export function consentPayload(s) {
  return JSON.stringify({
    purpose: "personal-phone-assistant:approve:v1",
    resource:
      "https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp",
    id: s.id,
    destination: s.destination,
    language: s.language,
    instructions: s.instructions,
    owner: s.owner,
    clientId: s.clientId,
    created_at: s.created_at,
    expires_at: s.expires_at,
    approval_nonce: s.approval_nonce,
    request_digest: s.request_digest,
  });
}
export function validateRequest(s, now = Date.now()) {
  const uuid =
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (
    !s ||
    !uuid.test(s.id) ||
    !uuid.test(s.approval_nonce) ||
    !/^\+[1-9]\d{7,14}$/.test(s.destination) ||
    !["auto", "ja", "it", "en", "pt"].includes(s.language) ||
    typeof s.instructions !== "string" ||
    s.instructions.length < 10 ||
    s.instructions.length > 3000 ||
    s.owner !== "owner" ||
    typeof s.clientId !== "string" ||
    !s.clientId ||
    !/^[a-f0-9]{64}$/.test(s.request_digest) ||
    s.state !== "pending_approval" ||
    !Number.isSafeInteger(s.created_at) ||
    !Number.isSafeInteger(s.expires_at) ||
    s.expires_at - s.created_at !== 600000 ||
    s.created_at > now + 30000 ||
    s.expires_at <= now
  )
    throw new Error(
      "Richiesta non valida o scaduta. Preparare una nuova richiesta.",
    );
  // Prevent terminal control characters from concealing destination or instructions.
  for (const value of [s.destination, s.instructions, s.clientId])
    if (/[\x00-\x08\x0b-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/u.test(value))
      throw new Error("Caratteri di controllo non ammessi.");
  return s;
}
async function question(prompt, hidden = false) {
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw new Error(
      "Usare un Terminale personale interattivo, mai una sessione agente o una pipe.",
    );
  if (!hidden) {
    const rl = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    try {
      return await new Promise((resolve) => rl.question(prompt, resolve));
    } finally {
      rl.close();
    }
  }
  process.stdout.write(prompt);
  emitKeypressEvents(process.stdin);
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = () => {
      process.stdin.off("keypress", handler);
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdout.write("\n");
    };
    const handler = (text, key = {}) => {
      if (key.ctrl && key.name === "c") {
        done();
        reject(new Error("Annullato"));
      } else if (key.name === "return" || key.name === "enter") {
        done();
        resolve(value);
      } else if (key.name === "backspace") value = value.slice(0, -1);
      else if (text && !key.ctrl && !key.meta && !/[\x00-\x1f\x7f]/.test(text))
        value += text;
    };
    process.stdin.on("keypress", handler);
  });
}
async function main() {
  const dir = join(homedir(), ".config", "personal-phone-assistant");
  const file = join(dir, "owner-signing-key.pem");
  const mode = process.argv[2];
  if (mode === "init") {
    if (existsSync(file))
      throw new Error("Chiave esistente: non viene sovrascritta.");
    const passphrase = await question(
      "Nuova passphrase casuale (almeno 20 caratteri, conservarla nel password manager): ",
      true,
    );
    if (
      passphrase.length < 20 ||
      passphrase !== (await question("Ripeti la passphrase: ", true))
    )
      throw new Error("Passphrase corta o conferma diversa.");
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    writeFileSync(
      file,
      privateKey.export({
        type: "pkcs8",
        format: "pem",
        cipher: "aes-256-cbc",
        passphrase,
      }),
      { mode: 0o600, flag: "wx" },
    );
    const raw = publicKey
      .export({ type: "spki", format: "der" })
      .subarray(-32)
      .toString("base64url");
    const pub = join(dir, "owner-consent-public.txt");
    writeFileSync(pub, raw + "\n", { mode: 0o600 });
    console.log(
      "Chiave privata cifrata salvata. Non condividerla né fornire la passphrase agli agenti.\nChiave PUBBLICA (configurabile su MCP come OUTBOUND_CONSENT_PUBLIC_KEY):\n" +
        raw +
        "\nFile pubblico: " +
        pub,
    );
  } else if (mode === "sign" && process.argv[3]) {
    const decoded = JSON.parse(readFileSync(resolve(process.argv[3]), "utf8"));
    const s = validateRequest(decoded.request ?? decoded);
    console.log(
      "\nAUTORIZZAZIONE DI UNA TELEFONATA REALE (possibili costi)\n" +
        JSON.stringify(
          {
            id: s.id,
            destinatario: s.destination,
            lingua: s.language,
            istruzioni: s.instructions,
            client: s.clientId,
            nonce: s.approval_nonce,
            digest: s.request_digest,
            scadenza: new Date(s.expires_at).toISOString(),
          },
          null,
          2,
        ),
    );
    if (
      (await question(
        "Per approvare esattamente questa chiamata, digita APPROVO " +
          s.destination +
          ": ",
      )) !==
      "APPROVO " + s.destination
    )
      throw new Error("Annullato.");
    const passphrase = await question(
      "Passphrase della chiave privata (solo qui, mai in chat): ",
      true,
    );
    const key = createPrivateKey({
      key: readFileSync(file),
      format: "pem",
      passphrase,
    });
    if (key.asymmetricKeyType !== "ed25519")
      throw new Error("Tipo di chiave errato.");
    validateRequest(s); // Recheck expiry after human interaction.
    const signature =
      "ppa1." +
      sign(null, Buffer.from(consentPayload(s)), key).toString("base64url");
    console.log(
      "\nIn un NUOVO messaggio ChatGPT scrivi: Approvo la richiesta " +
        s.id +
        ". Firma: " +
        signature +
        "\nNon condividere la chiave privata o la passphrase. La firma autorizza solo questa richiesta entro la scadenza.",
    );
  } else
    throw new Error(
      "Uso: node scripts/owner-consent.mjs init | sign /percorso/richiesta.json",
    );
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
) {
  main().catch(() => {
    console.error(
      "Operazione non completata. Verifica comando, richiesta, scadenza e passphrase. Nessuna chiamata è stata inviata dal programma.",
    );
    process.exitCode = 1;
  });
}
