# Personal Phone Assistant — ChatGPT MCP

Livello MCP/OAuth per l’assistente telefonico Telnyx già operativo. Il progetto non sostituisce né distribuisce `personal-phone-assistant`, non modifica Telnyx e non applica migrazioni alle tabelle D1 esistenti.

**Stato attuale:** outbound attivo con conferma nella conversazione. ChatGPT deve preparare la richiesta, mostrarne tutti i dettagli e attendere un nuovo messaggio esplicito prima di approvarla. Non servono firme o Terminale. Il backend verifica OAuth e integrità della richiesta, ma **non verifica che il nuovo messaggio umano sia stato ricevuto**. [Flusso e limiti](docs/outbound-execution.md).

Endpoint: `https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp`.

## Autenticazione e strumenti

Il Worker auth gestisce Authorization Code, PKCE, discovery, DCR/CIMD, access token di 5 minuti e refresh di 30 giorni tramite `@cloudflare/workers-oauth-provider`. L’accesso iniziale OAuth continua a usare una pagina di login: è distinto dalla conferma delle telefonate, che non usa più pagine o link.

Il Worker MCP verifica token attraverso il binding `AUTH_SERVER`, identità `owner`, client OAuth, versione delle credenziali e scope. Non inviare mai i secret in chat. `OWNER_LOGIN_SECRET` resta su auth; `OUTBOUND_API_SECRET` e `OUTBOUND_APPROVAL_SECRET`, se configurati, restano su MCP e devono essere diversi.

| Strumento                  | Scope aggiuntivo | Comportamento                                                                         |
| -------------------------- | ---------------- | ------------------------------------------------------------------------------------- |
| `list_calls`               | `calls:read`     | Consulta chiamate e filtri data/direzione/priorità                                    |
| `get_call_details`         | `calls:read`     | Legge dettagli e riepilogo                                                            |
| `search_calls`             | `calls:read`     | Cerca numeri e testo del riepilogo                                                    |
| `get_outbound_status`      | `calls:read`     | Legge D1; con ID include lo stato di controllo MCP, se gestito                        |
| `create_outbound_request`  | `calls:write`    | Prepara soltanto una richiesta pending, se configurazione e contratto sono verificati |
| `approve_outbound_request` | `calls:execute`  | Valida la specifica richiesta; esecuzione negata senza consenso umano attendibile     |

Tutti gli strumenti richiedono anche lo scope base `calls:read`. I due strumenti outbound sono sempre descritti nella lista MCP: configurazione disabilitata e scope mancanti producono un errore esplicito, senza chiamare le API telefoniche.

## Conferma per singola chiamata

ChatGPT prepara la richiesta, presenta numero, lingua, obiettivo e istruzioni complete e attende un **nuovo messaggio esplicito** che approvi quella specifica chiamata. Solo dopo invoca `approve_outbound_request`, soggetto anche alla conferma nativa quando richiesta. Le istruzioni sono pubblicate dal server MCP, dai tool e nelle risposte di creazione; una copia riutilizzabile è in [istruzioni ChatGPT](docs/chatgpt-instructions.md).

È una regola operativa del client, non un’attestazione crittografica. Il backend controlla identità OAuth, scope, snapshot, nonce, digest, scadenza, policy destinazioni, quota e anti-replay. Un chiamante OAuth autorizzato con i dati corretti può approvare anche se non ha seguito la conversazione: il backend non può rilevarlo. Non si richiedono firme, Terminale, messaggi inventati o metadati di consenso. [Procedura completa](docs/outbound-execution.md).

## Controlli persistenti

- Richieste con snapshot immutabile legato a proprietario e client OAuth; scadenza server di 30 minuti nella configurazione pubblicata (`OUTBOUND_APPROVAL_TTL_MINUTES`, intervallo 5–30, default 10 se assente). Nessun rinnovo sui retry o sulle richieste esistenti.
- UUID univoci, nonce e digest dei dettagli. La stessa chiave con dati differenti viene rifiutata.
- Policy esplicita `OUTBOUND_DESTINATION_POLICY=all_standard`: numeri E.164 validi di categoria standard, con blocchi configurabili. La modalità `allowlist` resta disponibile. [Regole e limiti del Worker telefonico](docs/outbound-destinations.md).
- Rate limit persistente per proprietario, condiviso fra client e richieste: `OUTBOUND_RATE_LIMIT_PER_HOUR` (default 5, intervallo 1–100) per creazione e approvazione.
- D1 letto sul primary per controllare lo stato pending. Nessuna scrittura del progetto in D1.
- Prenotazione atomica nel Durable Object prima dell’invio. Concorrenza e replay non generano un secondo invio.
- Timeout/errori ambigui mantengono lo stato `unknown`; nessun retry automatico. Consultare lo stato, senza usare una nuova chiave per aggirare il blocco.
- Audit nel Durable Object con soli timestamp/codici di stato, senza log applicativi delle istruzioni o dei secret.
- I dati delle telefonate restano non attendibili; non diventano mai prove di autorizzazione.

La fixture `tests/mcp-gate-fixture.ts` modifica soltanto configurazione e scadenza nel runtime locale dei test. Non viene inclusa nel deployment; il preflight vieta entrypoint di test.

## Configurazione attuale

I due file Wrangler contengono gli ID già verificati del namespace `personal-phone-assistant-oauth-kv` e del database `phone-assistant-db` e i binding esistenti. Preview URL e osservabilità dei log sono disabilitate. `OUTBOUND_ENABLED=true` e `OUTBOUND_CONTRACT_VERIFIED=true` abilitano la sola preparazione. `OUTBOUND_EXECUTION_ENABLED=true` abilita il percorso di approvazione con la regola operativa `conversation-policy-v1` e la configurazione completa. Impostare false per disabilitare immediatamente gli invii. La modalità attiva è `all_standard`; il Secret `OUTBOUND_ALLOWED_DESTINATIONS_SECRET` è conservato ma ignorato in questa modalità. Il Worker telefonico mantiene i propri limiti indipendenti sulle destinazioni.

`SCHEMA_MAPPING` usa `calls.caller_number`, `calls.destination_number`, `calls.created_at`, `call_summaries.summary_it`, `call_summaries.action_required` e `outbound_requests.destination_number`. La data usata per filtri e ordinamento è `created_at` perché le chiamate esistenti avevano `started_at` nullo. Le query selezionano solo colonne realmente presenti tramite `PRAGMA table_info`; i callback token non vengono selezionati.

Il contratto HTTP di sola preparazione è stato verificato in lettura sul codice del Worker telefonico, senza eseguire telefonate. L’adattatore attuale invia `{destination_number, language, instructions}` a `POST /outbound/requests` e si aspetta `{id: UUID, status: "pending_approval"}`. Il contratto è esercitato con un servizio simulato nei test; il collaudo reale di preparazione richiede la credenziale originale esatta. L’approvazione usa il secret separato e `POST /outbound/requests/{id}/approve`; è raggiungibile soltanto con configurazione completa e controlli sulla richiesta superati.

Per ispezionare lo schema usare esclusivamente query di lettura:

```sh
npx wrangler d1 execute phone-assistant-db --remote --command 'PRAGMA table_info(calls); PRAGMA table_info(call_summaries); PRAGMA table_info(outbound_requests);'
```

## Build, test e deployment

Node.js 22+, versioni npm esatte fissate nel lockfile:

```sh
npm ci
npm run typecheck
npm test
npm run build
```

La suite verifica anche identità/scope errati, metadati inventati, duplicati, cambi dei dettagli, scadenze, richieste non pending, rate limit, concorrenza, replay e risultati incerti. La telefonia è un servizio locale simulato; nessun test chiama la produzione.

Per IVR e prima risposta: `npm run test:voice-timings` esegue 1.440 variazioni temporali senza rete; `npm run test:voice-campaign` esegue 1.000 scenari simulati. [Confronto offline prima/dopo e limiti](docs/offline-ivr-first-reply-2026-10-28.md).

`npm run test:voice-handoff` aggiunge 1.225 combinazioni di prima risposta e 96 casi di chiusura con turni STT sospesi. Audio, callback e ritardi sono simulati; nessuna chiamata viene avviata. [Chiusura e aizuchi: correzioni e limiti](docs/outbound-closure-handoff-2026-10-28.md).

Per il rilascio che corregge il refresh incrementale distribuire **Auth → MCP**:

```sh
npm run deploy:auth
npm run deploy:mcp
```

Non eseguire bootstrap per questo aggiornamento. Auth espone il metodo RPC autenticato `requireScopeUpgrade` e usa `OAUTH_STEP_UP` per lo stato temporaneo di richiesta di un nuovo consenso. Non viene aggiunto un Worker e non viene modificato D1. L’entrypoint `ApprovalServer` resta un tombstone inerte per compatibilità con vecchie versioni: i suoi metodi legacy non possono eseguire chiamate. La route auth `/confirm` restituisce 410 e nessun link di approvazione viene generato.

`npm run build` effettua soltanto dry-run. La CI esegue controlli e non distribuisce. Non distribuire mai questo progetto al Worker telefonico `personal-phone-assistant`.

## Uso in ChatGPT

Aggiornare la lista strumenti della connessione MCP esistente. Endpoint invariato:

`https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp`

Le consultazioni restano disponibili con OAuth. Per vedere le autorizzazioni dei tool outbound può essere necessaria una riautorizzazione con gli scope aggiuntivi; questa non abilita l’esecuzione reale. Non selezionare approvazioni permanenti come sostituto del consenso per una specifica telefonata.

La revoca standard è pubblicata nella discovery. KV è eventualmente consistente: per invalidare tutti i vecchi grant aggiornare `OWNER_TOKEN_VERSION` in entrambi i Worker con un rilascio coordinato; non fare questa operazione nel rilascio MCP corrente. L’ultimo collaudo pubblico di lettura è documentato in [deployment](docs/deployment.md); il nuovo limite di consenso e i test sono in [sicurezza outbound](docs/outbound-confirmation.md).

## Autorizzazione incrementale OAuth

I tool outbound richiedono ora un challenge HTTP `403 insufficient_scope`, completo di `WWW-Authenticate` e `_meta["mcp/www_authenticate"]`, invece di un normale errore “Missing authorization”. `tools/list` dichiara gli scope OAuth per ciascun tool. [Procedura precisa per aggiornare l’autorizzazione ChatGPT](docs/oauth-step-up.md). Lo scope aggiuntivo non abilita l’esecuzione reale.

La riconnessione dalla chat è stata corretta anche nel percorso di refresh automatico: [causa riprodotta, correzione e consenso richiesto](docs/oauth-reconnect-diagnosis.md). Per questo rilascio sono necessari Auth e MCP, in quest’ordine; non il Worker telefonico.

Per l’intervento corrente con conferma conversazionale si distribuisce **soltanto MCP** (`npm run deploy:mcp`): [procedura e protezioni](docs/outbound-execution.md). L’ordine Auth → MCP descritto sopra riguarda il precedente aggiornamento OAuth.
