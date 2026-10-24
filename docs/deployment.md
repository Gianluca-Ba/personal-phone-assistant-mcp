# Deployment nell’account Cloudflare esistente

Sono stati aggiornati esclusivamente `personal-phone-assistant-auth` e `personal-phone-assistant-mcp`, nell’ordine bootstrap → MCP → auth. Il Worker telefonico `personal-phone-assistant`, le impostazioni Telnyx e le tabelle D1 non sono stati modificati. Outbound è disabilitato (`OUTBOUND_ENABLED=false`, `OUTBOUND_CONTRACT_VERIFIED=false`, allowlist vuota).

## Risorse verificate

- KV `personal-phone-assistant-oauth-kv`: `800d14564916429199eea261a1b71cab`.
- D1 `phone-assistant-db`: `f8604adb-ac12-4298-a9be-327727a20675`.
- auth `OAUTH_KV` → namespace esistente.
- auth `MCP_SERVER` → MCP, entrypoint `ApprovalServer`.
- MCP `AUTH_SERVER` → auth, entrypoint `AuthServer`.
- MCP `DB` → database esistente.
- MCP `PHONE_API` → servizio telefonico esistente; non utilizzato con outbound disabilitato.
- MCP `OUTBOUND_GATE` → classe Durable Object nello stesso Worker MCP; nessuna nuova tabella nel database telefonico.
- Il secret `OWNER_LOGIN_SECRET` è configurato su auth e non è incluso nei file o nei rapporti di verifica.
- Le preview URL e i log di osservabilità sono disabilitati su entrambi i Worker.

## Schema reale e adattamento

Lo schema è stato interrogato con `PRAGMA table_info`, senza migrazioni o scritture D1.

| Dato restituito         | Colonna verificata                     |
| ----------------------- | -------------------------------------- |
| Identificativo chiamata | `calls.id`                             |
| Numero chiamante        | `calls.caller_number`                  |
| Numero destinatario     | `calls.destination_number`             |
| Nome chiamante          | `calls.caller_name`                    |
| Data di riferimento     | `calls.created_at`                     |
| Riepilogo italiano      | `call_summaries.summary_it`            |
| Azione richiesta        | `call_summaries.action_required`       |
| Priorità/esito          | `call_summaries.priority` / `outcome`  |
| Destinazione outbound   | `outbound_requests.destination_number` |
| Data richiesta outbound | `outbound_requests.created_at`         |

Nel campione iniziale tutte le 10 chiamate avevano `started_at` nullo; `created_at` era valido per tutte. Per questo la configurazione di produzione usa `created_at`, con formato ISO/datetime SQLite, sia per ordinare sia per i filtri data. I 10 riepiloghi corrispondevano a 10 distinti `call_id`; erano presenti 5 richieste outbound. Questi conteggi sono una fotografia del controllo iniziale, non dati di esempio inseriti dal progetto.

## Versioni pubblicate

- Bootstrap auth: `cc499afd-c827-4c73-840a-6095eb90b487`.
- MCP: `f45f25bd-c586-423c-8c30-a92ea4f35672`.
- Auth finale: `d6eed026-3db3-44ce-a895-cb2710d432cc`.
- Versione del Worker telefonico preesistente: `e21a07d0-b52a-4832-bb41-54b18f85a1ae`, distribuita prima di questo intervento.

Il collaudo pubblico è completato: [rapporto con soli esiti e conteggi](deployment-verification.json). Sono state lette tramite MCP 10 chiamate e 5 richieste outbound. Sono riusciti login proprietario, PKCE, quattro strumenti di sola lettura, filtri data, refresh e revoca. Il grant di prova è stato revocato.

Le versioni dei due Worker possono cambiare ai successivi aggiornamenti. Il rapporto `deployment-verification.json`, quando presente, descrive le verifiche dal vivo completate, con soli conteggi e risultati booleani: non contiene dati delle telefonate o credenziali.

## Collaudo dal vivo ripetibile

```sh
npm run smoke:live
```

Il comando apre la pagina OAuth sul dominio auth. Inserire il secret esclusivamente in quella pagina e autorizzare il client **Personal Phone Assistant — read-only deployment verification** con `calls:read offline_access`. Il callback di verifica è su `127.0.0.1`, sulla porta effimera scelta dal sistema.

Lo script verifica discovery, rifiuto di accessi anonimi/token invalidi, PKCE, inizializzazione MCP, presenza dei soli quattro strumenti di lettura, consultazioni reali, mapping dei riepiloghi, filtri temporali, refresh e revoca. Le credenziali rimangono soltanto in memoria; il grant di test viene revocato. Non chiama le API outbound e non scrive in D1. Il client OAuth di verifica resta registrato nel namespace OAuth.

## Collegamento a ChatGPT

Aprire **Aggiungi un server MCP personalizzato** e impostare:

- Nome: **Personal Phone Assistant**.
- URL: `https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp`.
- Autenticazione: **OAuth**.

Completare la pagina di consenso sul dominio auth usando il secret nel password manager. Non inserire secret come API key nella configurazione ChatGPT. Richiedere `calls:read offline_access`; i permessi di scrittura non sono necessari con outbound disabilitato. Se la schermata presenta solo la scelta OAuth, lasciare che il client usi discovery e registrazione dinamica.

Provare «Quali telefonate ho ricevuto oggi, ora di Tokyo?» e «Mostrami il riepilogo dell’ultima chiamata». Il grant del collaudo è separato dalla futura connessione ChatGPT: questa richiede la propria autorizzazione iniziale.

Il consenso OAuth usa le transazioni monouso della libreria Cloudflare (`beginConsent` / `approveConsent`), cookie `__Host-` con `SameSite=Lax`, validazione stretta di Origin, autenticazione del proprietario e PKCE. La policy referrer `same-origin` permette i moduli browser senza inviare riferimenti a domini esterni.

Il modulo di esecuzione outbound rimane intenzionalmente disabilitato. Prima di una futura abilitazione occorrerà verificare e adattare anche il suo contratto SQL/HTTP: lo schema reale usa `destination_number`, mentre l’adattatore di esecuzione iniziale presumeva `destination`. Il collaudo corrente riguarda esclusivamente la lettura.
