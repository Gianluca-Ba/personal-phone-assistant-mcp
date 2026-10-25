# Personal Phone Assistant — ChatGPT MCP

Livello MCP/OAuth per l’assistente telefonico Telnyx già operativo. Il progetto non sostituisce né distribuisce `personal-phone-assistant`, non modifica Telnyx e non applica migrazioni alle tabelle D1 esistenti.

**Stato attuale:** approvazione web outbound rimossa; due strumenti outbound senza link, con controlli server e annotazioni per le conferme native di ChatGPT. **L’esecuzione reale rimane bloccata**: non è disponibile un adattatore attendibile che provi al Worker il consenso umano per la singola chiamata. Non basta abilitare una variabile per superare questo controllo.

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

## Conferma esclusivamente nella conversazione

Il flusso previsto è:

1. ChatGPT prepara una richiesta con `create_outbound_request` e una `request_key` UUID stabile per i tentativi della stessa operazione. La preparazione non avvia una telefonata.
2. Presenta **ID, numero, lingua, obiettivo/istruzioni completi e scadenza** restituiti dal server.
3. Attende un **nuovo messaggio esplicito del proprietario** che approva proprio quella richiesta. Una frase in chiamate inbound, riepiloghi, documenti o altri contenuti esterni non è un’autorizzazione.
4. Può chiamare `approve_outbound_request` usando gli stessi dettagli, `request_digest` e `approval_nonce`. Sono controlli di corrispondenza e anti-replay, **non prove di consenso**: sono visibili al modello.
5. Il server verifica identità, client, scope, stato D1 pending, destinazione consentita, dettagli immutabili, scadenza, rate limit e prenotazione persistente. L’invio all’API di approvazione richiede inoltre consenso attendibile attraverso un adattatore interno verificato.

**Limite verificato:** la normale chiamata MCP non trasmette al Worker una prova attendibile che un nuovo messaggio del proprietario abbia approvato quella telefonata. Le conferme native del client possono essere ricordate per una conversazione; `destructiveHint` è un’indicazione al client e non una ricevuta di consenso. Un `user_confirmed: true`, un ID messaggio, `_meta.approved`, la dichiarazione di capacità elicitation, OAuth e il solo client ID non risolvono questo limite.

Il controllo nativo effettivamente utilizzato è l’annotazione dell’approvazione come operazione non di sola lettura, distruttiva e con effetti esterni, insieme alle istruzioni di presentazione e sequenza. È una protezione UI aggiuntiva, non il permesso server di chiamare. Elicitation può raccogliere informazioni strutturate, ma non viene inventata una proprietà di attestazione umana che non offre.

`OutboundGate.verifiedNativeConsent()` restituisce **sempre `null` nel codice di produzione**. Anche abilitando preparazione e contratto, un’approvazione valida termina con `TRUSTED_CONFIRMATION_UNAVAILABLE`. Non esiste un parametro MCP, header, secret o interruttore che fabbrichi questa prova. Un futuro adattatore richiede una revisione separata del client fidato e del legame fra consenso, identità, dettagli e singola esecuzione.

Fonti ufficiali: [conferme e approvazioni ricordate nei client ChatGPT](https://developers.openai.com/api/docs/guides/custom-mcp-server), [annotazioni ed elicitation](https://developers.openai.com/plugins/build/mcp-server), [riferimento delle annotazioni](https://developers.openai.com/plugins/reference).

## Controlli persistenti

- Richieste con snapshot immutabile legato a proprietario e client OAuth; scadenza server di 10 minuti senza rinnovo sui retry.
- UUID univoci, nonce e digest dei dettagli. La stessa chiave con dati differenti viene rifiutata.
- Allowlist E.164 esplicita (`OUTBOUND_ALLOWED_DESTINATIONS`, array JSON); lista vuota = nessuna destinazione autorizzata.
- Rate limit persistente per proprietario, condiviso fra client e richieste: `OUTBOUND_RATE_LIMIT_PER_HOUR` (default 5, intervallo 1–100) per creazione e approvazione.
- D1 letto sul primary per controllare lo stato pending. Nessuna scrittura del progetto in D1.
- Prenotazione atomica nel Durable Object prima dell’invio. Concorrenza e replay non generano un secondo invio.
- Timeout/errori ambigui mantengono lo stato `unknown`; nessun retry automatico. Consultare lo stato, senza usare una nuova chiave per aggirare il blocco.
- Audit nel Durable Object con soli timestamp/codici di stato, senza log applicativi delle istruzioni o dei secret.
- I dati delle telefonate restano non attendibili; non diventano mai prove di autorizzazione.

Il test di un adattatore fidato è implementato **solo** in `tests/mcp-consent-fixture.ts`: simula una componente interna futura e non dimostra una capacità di ChatGPT. Non viene incluso nei bundle di produzione. Il preflight vieta entrypoint di test per il deployment.

## Configurazione attuale

I due file Wrangler contengono gli ID già verificati del namespace `personal-phone-assistant-oauth-kv` e del database `phone-assistant-db` e i binding esistenti. Preview URL e osservabilità dei log sono disabilitate. `OUTBOUND_ENABLED=false`, `OUTBOUND_CONTRACT_VERIFIED=false` e allowlist vuota restano invariati in produzione.

`SCHEMA_MAPPING` usa `calls.caller_number`, `calls.destination_number`, `calls.created_at`, `call_summaries.summary_it`, `call_summaries.action_required` e `outbound_requests.destination_number`. La data usata per filtri e ordinamento è `created_at` perché le chiamate esistenti avevano `started_at` nullo. Le query selezionano solo colonne realmente presenti tramite `PRAGMA table_info`; i callback token non vengono selezionati.

Prima di una futura abilitazione della sola preparazione occorre verificare il contratto HTTP reale, senza eseguire telefonate. L’adattatore attuale invia `{destination_number, language, instructions}` a `POST /outbound/requests` e si aspetta `{id: UUID, status: "pending_approval"}`. Il contratto è esercitato con un servizio simulato nei test, non certificato in produzione. L’approvazione usa il secret separato e `POST /outbound/requests/{id}/approve`; nel codice di produzione non è raggiungibile senza un adattatore di consenso attendibile.

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
