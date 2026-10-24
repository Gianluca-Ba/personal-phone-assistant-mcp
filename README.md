# Personal Phone Assistant — ChatGPT MCP

Integrazione TypeScript per l’assistente telefonico Telnyx già operativo. Il repository contiene **solo** i Worker `personal-phone-assistant-auth` e `personal-phone-assistant-mcp`. Non contiene né distribuisce il Worker telefonico `personal-phone-assistant`, non cambia Telnyx e non applica migrazioni al database D1 esistente.

## Cosa è implementato

- MCP remoto **Streamable HTTP** tramite SDK ufficiale, modalità stateless e risposte JSON.
- OAuth Authorization Code + PKCE S256, discovery, registrazione dinamica dei client (DCR), supporto CIMD, access token di 5 minuti, refresh token di 30 giorni e revoca tramite la libreria Cloudflare `@cloudflare/workers-oauth-provider`.
- Autenticazione reale del proprietario con un segreto casuale di almeno 32 caratteri, pagina di consenso, protezione CSRF e rate limit. Il segreto va nel browser del proprietario e nei secret Cloudflare, **mai nella chat o nelle impostazioni del client MCP**.
- `list_calls`, `get_call_details`, `search_calls`, `get_outbound_status`: query parametrizzate, schema verificato a runtime e colonne esportate tramite allowlist. I callback token non sono selezionati.
- `create_outbound_request`: prepara una richiesta, senza telefonare. `approve_outbound_request`: genera un link di conferma; l’avvio avviene solo dopo un clic del proprietario autenticato, con numero e istruzioni visibili.
- Durable Object SQLite per idempotenza, conferme monouso e prenotazione persistente dell’invio. Lo storage è separato dal D1 telefonico, nello stesso Worker MCP: nessun terzo Worker di produzione.
- Test locali con i due Worker, KV, D1 e service binding reali nel runtime workerd. La telefonia nei test è esclusivamente un servizio simulato.

**Stato:** i due Worker sono stati distribuiti nell’account Cloudflare esistente. ID delle risorse, binding e schema D1 reale sono stati verificati in sola lettura; la configurazione riproducibile è inclusa nel repository. Il collaudo pubblico è riuscito sui quattro strumenti di sola lettura, inclusi refresh e revoca OAuth. Vedi [rapporto di deployment](docs/deployment.md) per risorse, versioni ed esiti. Outbound resta disabilitato.

## Architettura

```text
ChatGPT → MCP /mcp → AUTH_SERVER → AuthServer.validateToken
                └→ DB (D1 esistente, SELECT/PRAGMA soltanto)
                └→ OutboundGate (Durable Object nello stesso Worker)
                     └→ PHONE_API (service binding al Worker telefonico esistente)
Browser proprietario → auth /confirm → ApprovalServer → OutboundGate
```

La connessione `PHONE_API` è una chiamata al servizio esistente, non un suo deployment. Le due credenziali outbound restano nel Worker MCP. La libreria valida issuer, resource/audience, scadenze e scope; il livello applicativo controlla inoltre proprietario e versione delle credenziali.

## Installazione e verifiche

Richiede Node.js 22 o successivo, npm e accesso all’account Cloudflare corretto. Le versioni esatte sono fissate in `package.json` e `package-lock.json`.

```sh
npm ci
npm run typecheck
npm test
npm run build
```

`build` esegue due bundle Wrangler con `--dry-run`: non distribuisce niente. La CI GitHub esegue questi controlli a ogni push/PR; non effettua deployment.

## Configurazione iniziale Cloudflare

1. Recuperare l’ID del namespace KV **già esistente** `personal-phone-assistant-oauth-kv` e l’ID del database D1 **già esistente** `phone-assistant-db`, dalla dashboard Cloudflare. Non crearne copie.
2. Inserire gli ID in modo riproducibile:

   ```sh
   npm run configure -- --kv-id ID_NAMESPACE_KV --d1-id ID_DATABASE_D1
   ```

   Il comando modifica solo i due file Wrangler locali. Gli ID non sono credenziali. `npm run deploy:*` rifiuta i placeholder e i nomi di Worker diversi da quelli previsti.

3. Impostare sul Worker auth il secret **OWNER_LOGIN_SECRET**: usare almeno 32 caratteri casuali, preferibilmente 32 byte casuali codificati in esadecimale (64 caratteri), generati e conservati in un password manager. Dalla dashboard: Worker `personal-phone-assistant-auth` → Settings → Variables and Secrets → Add → Secret. Non usare una normale password breve.
4. `OWNER_TOKEN_VERSION` deve essere identico nei due file Wrangler (inizialmente `1`). Non è un secret. Non impostare un valore secret che sovrascriva la variabile omonima.
5. Verificare lo schema come indicato sotto e, se necessario, configurare `SCHEMA_MAPPING` sul Worker MCP.
6. I binding configurati dal repository sono:

   | Worker | Binding         | Destinazione                                                |
   | ------ | --------------- | ----------------------------------------------------------- |
   | auth   | `OAUTH_KV`      | namespace OAuth esistente                                   |
   | auth   | `LOGIN_LIMITER` | rate limit 5 richieste/minuto/IP                            |
   | auth   | `MCP_SERVER`    | `personal-phone-assistant-mcp`, entrypoint `ApprovalServer` |
   | MCP    | `AUTH_SERVER`   | `personal-phone-assistant-auth`, entrypoint `AuthServer`    |
   | MCP    | `DB`            | `phone-assistant-db`                                        |
   | MCP    | `PHONE_API`     | `personal-phone-assistant` già operativo                    |
   | MCP    | `OUTBOUND_GATE` | classe `OutboundGate` nello stesso Worker MCP               |

   La migrazione `v1` crea esclusivamente lo storage della nuova classe Durable Object. Non esiste una migrazione D1 in questo progetto.

Gli URL issuer/resource sono fissi ai tuoi domini `barsaglini-gianluca.workers.dev`; non cambiare un solo URL senza aggiornare entrambi i Worker, le relative stringhe issuer/resource e la connessione ChatGPT.

## Verifica non distruttiva dello schema D1

Usare la console D1 della dashboard, oppure una sessione Wrangler autenticata:

```sh
npx wrangler d1 execute phone-assistant-db --remote --command 'PRAGMA table_info(calls); PRAGMA table_info(call_summaries); PRAGMA table_info(outbound_requests);'
```

Non eseguire `CREATE`, `ALTER`, `UPDATE` o migrazioni sul database di produzione per adattarlo a questo progetto. Il codice legge `PRAGMA table_info` prima delle query e seleziona solo colonne realmente presenti; le alternative sono elencate in `workers/mcp/src/data.ts`. I campi fondamentali mancanti causano un errore sicuro. I dettagli tecnici dell’errore non vengono restituiti al modello.

Per una colonna con nome differente o per scegliere tra più alternative, impostare `SCHEMA_MAPPING` come stringa JSON nelle variabili del Worker MCP, ad esempio (solo se queste colonne esistono davvero):

```json
{
  "calls": {
    "id": "id",
    "phone": "from_number",
    "time": "started_at",
    "time_format": "iso"
  },
  "call_summaries": {
    "call": "call_id",
    "summary": "summary",
    "actions": "actions_required"
  },
  "outbound_requests": { "time": "started_at", "time_format": "iso" }
}
```

`time_format` accetta `iso` (default: ISO 8601 o datetime SQLite), `unix_seconds` o `unix_milliseconds`. Le date `from`/`to` degli strumenti devono includere il fuso orario; per “oggi in Giappone” usare inizio/fine della giornata con `+09:00`. I filtri non supportati dallo schema causano un errore, senza essere ignorati silenziosamente. La ricerca tratta `%`, `_` e barre come caratteri letterali.

Il join dei riepiloghi usa `call_summaries.call_id = calls.id`, oppure `conversation_id` quando disponibile in entrambe le tabelle. Verificare che la relazione rappresenti effettivamente le chiamate e la cardinalità dei riepiloghi nel proprio database. Gli identificativi Telnyx/conversation disponibili sono restituiti per la correlazione; questo progetto non interroga o modifica Telnyx.

## Deployment dei due Worker

Per il primo deployment, il bootstrap pubblica AuthServer senza il binding di ritorno alla conferma. Questo evita riferimenti circolari a entrypoint non ancora pubblicati. Dopo aver impostato gli ID e il secret proprietario:

```sh
npx wrangler login
npm run deploy:bootstrap
npm run deploy:mcp
npm run deploy:auth
```

Il bootstrap aggiorna soltanto il Worker auth. Finché non si completa `deploy:auth`, la conferma outbound non è disponibile. Per gli aggiornamenti successivi bastano i due comandi `deploy:mcp` e `deploy:auth`; il bootstrap è destinato al primo collegamento. Non dirigere nessun deployment a `personal-phone-assistant`.

I secret esistenti vengono mantenuti dai normali deployment Wrangler; le variabili non secret sono definite nei file Wrangler. Conservare in questi file anche le configurazioni `SCHEMA_MAPPING` e outbound scelte dalla dashboard, per evitare che un successivo deployment ripristini i default.

## Collegamento a ChatGPT

Dopo il collaudo del deployment:

1. Aprire ChatGPT sul web e la schermata **Aggiungi un server MCP personalizzato** (le etichette possono variare secondo account/workspace).
2. Nome: **Personal Phone Assistant**.
3. URL: `https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp`.
4. Autenticazione: **OAuth**. Il server pubblica discovery e registrazione dinamica; non inserire secret Telnyx o outbound. Se il client richiede una configurazione manuale, usare gli endpoint pubblicati dalla discovery, non URL inventati.
5. Nella pagina sul dominio auth verificare client e permessi, inserire il segreto proprietario e autorizzare. Richiedere `calls:read offline_access` per la lettura; aggiungere `calls:write calls:execute` quando si abilita outbound. Il refresh evita login a ogni operazione, entro la vita del grant.
6. Provare «Quali telefonate ho ricevuto oggi, ora di Tokyo?» e verificare il risultato con il database. Verificare anche ricerca, dettagli e stato outbound.

Il browser del proprietario mantiene una sessione firmata per 30 giorni per le conferme outbound; su un altro browser o dopo la scadenza occorre autenticarsi nuovamente. Il segreto non deve essere fornito a ChatGPT.

Documentazione ufficiale: [collegare e testare in ChatGPT](https://developers.openai.com/plugins/deploy/connect-chatgpt), [autenticazione OAuth](https://developers.openai.com/plugins/build/auth). La disponibilità della schermata e le policy del workspace dipendono dall’account: non sono state verificate sul tuo account.

## Abilitazione controllata dell’outbound

Non abilitare prima del collaudo della fase A in produzione. Non è stata effettuata alcuna chiamata reale durante lo sviluppo.

1. Verificare il contratto del Worker telefonico esistente, senza modificarlo. L’adattatore attuale usa:
   - `POST /outbound/requests`, Bearer `OUTBOUND_API_SECRET`, body `{destination, language, instructions}`; l’obiettivo viene anteposto alle istruzioni. Si aspetta una risposta JSON **`{id: UUID, status: "pending_approval"}`**.
   - `POST /outbound/requests/{id}/approve`, Bearer `OUTBOUND_APPROVAL_SECRET`. Una risposta 2xx indica invio; il risultato effettivo si legge poi da D1.
   - L’adattatore di esecuzione presume D1 `outbound_requests`: `id`, `destination`, `instructions`, `language`, `status`. **Lo schema reale verificato usa `destination_number`: adattare questo modulo prima di abilitare outbound.** Il Worker telefonico deve già applicare atomicamente il controllo dello stato pending prima dell’esecuzione, anche contro richieste provenienti da altri client.

   Se la forma effettiva differisce, adattare **solo** `workers/mcp/src/outbound.ts` e i test, senza modificare il Worker telefonico. Il repository non può dedurre questo contratto da un’API protetta.

2. Sul solo Worker MCP, impostare come secret le due credenziali già esistenti, distinte: `OUTBOUND_API_SECRET`, `OUTBOUND_APPROVAL_SECRET`. Non serve una API key Telnyx.
3. Impostare `OUTBOUND_ALLOWED_DESTINATIONS` come stringa JSON di numeri E.164 autorizzati esplicitamente, per esempio `["+81NUMERO_REALE"]` sostituendo un numero valido; la lista vuota blocca ogni destinazione. Aggiungere numeri richiede una scelta del proprietario, non dati provenienti da chiamate inbound.
4. Solo dopo verifica impostare `OUTBOUND_CONTRACT_VERIFIED="true"` e `OUTBOUND_ENABLED="true"` nel file MCP e ridistribuire soltanto MCP. Aggiornare la lista strumenti della connessione ChatGPT e riautorizzare con i permessi aggiuntivi se richiesto.
5. In ChatGPT creare la richiesta con `create_outbound_request`. `request_key` è un UUID stabile: riutilizzare la stessa chiave per la stessa richiesta quando si ripete un tentativo.
6. Chiedere l’approvazione con `approve_outbound_request`: il tool restituisce un link valido 10 minuti. Aprirlo nel browser, leggere **numero, lingua e istruzioni complete**, poi premere **Confermo: avvia questa telefonata**. Il semplice accesso al link non avvia nulla. Il tool da solo non avvia nulla.
7. Tornare in ChatGPT e usare `get_outbound_status` per stato, durata ed errori disponibili.

La conferma è un clic nel browser per ogni telefonata a pagamento, senza login ripetuto quando la sessione è ancora valida. È intenzionalmente separata dal possesso del token OAuth e dai dati non attendibili delle chiamate.

### Idempotenza e risultati incerti

La creazione riserva persistentemente la `request_key` prima della chiamata API; una chiave riutilizzata con dati diversi viene rifiutata. L’esecuzione riserva persistentemente l’ID richiesta prima dell’invio dell’approvazione. Concorrenza e ticket alternativi sullo stesso ID non possono causare un secondo invio da questo MCP.

Non esiste una transazione distribuita tra Durable Object e API telefonica: un timeout può significare che il servizio ha già ricevuto la richiesta. In quel caso il progetto conserva il blocco e **non ritenta automaticamente**, anche se la chiamata non è partita. Controllare D1/il servizio telefonico prima di qualunque intervento. Non aggirare il blocco con una nuova chiave e non cancellare lo storage delle esecuzioni per riprovare.

## Revoca e protezioni

- Il client può usare l’endpoint di revoca OAuth pubblicato nella discovery (nella versione fissata coincide con `/oauth/token`, distinguendo la richiesta mediante il parametro `token`). I test verificano access token rifiutati dopo la revoca nel runtime locale.
- **Limite KV:** Cloudflare KV è eventualmente consistente. Non promettere revoca istantanea globale del singolo token sulla sola cancellazione KV.
- Per invalidare tutte le credenziali e sessioni del proprietario, aumentare `OWNER_TOKEN_VERSION` in **entrambi** i file e distribuire **prima MCP, poi auth**. Dal momento in cui il nuovo MCP è attivo, i vecchi grant sono rifiutati anche se presenti in KV; le vecchie sessioni browser non passano più su auth dopo il relativo aggiornamento. Il rollout Cloudflare ha comunque i propri tempi di propagazione. Per un incidente, disabilitare inoltre il Worker MCP dalla dashboard.
- Ruotare `OWNER_LOGIN_SECRET` invalida le sessioni browser firmate ma **non** sostituisce la rotazione di versione per i token OAuth.
- Per bloccare soltanto le nuove telefonate: impostare `OUTBOUND_ENABLED="false"` e ridistribuire MCP; i ticket già creati non sono più eseguibili.
- I dati delle telefonate sono etichettati come non attendibili nelle istruzioni MCP e nelle risposte. Le annotazioni MCP sono aiuti al client; le vere protezioni sono scope, autenticazione, CSRF, destinazioni consentite, stato D1 e conferma browser.
- Non vengono scritti log applicativi di numeri, istruzioni o credenziali. I link di conferma sono temporanei ma riservati: non condividerli e non abilitare logging completo delle query URL. Le risposte HTML di autenticazione sono `no-store`, senza referrer verso altri domini e con CSP restrittiva.

## Limiti e verifica finale richiesta

Lo schema reale è stato verificato con una sessione Cloudflare autenticata e adattato tramite `SCHEMA_MAPPING`, senza cambiare il database. I test automatici locali usano dati sintetici e un contratto outbound simulato; il rapporto di deployment distingue le verifiche pubbliche completate. Il contratto outbound reale e la connessione al tuo account ChatGPT richiedono verifiche separate. Non è stato cambiato **Assistant Speaks First**, nessun webhook, nessuna configurazione Telnyx e nessun dato del database esistente.

ID namespace/database, schema D1, secret proprietario e binding/entrypoint sono stati configurati durante il deployment. Prima dell’uso completa il collegamento al tuo account ChatGPT e verifica le consultazioni dalla chat. Per outbound verificare inoltre contratto HTTP, secret distinti, allowlist e protezione atomica già presente nel servizio telefonico. Un’eventuale prova di chiamata reale resta un’azione intenzionale del proprietario e può generare costi.

Riferimento dell’architettura: [Cloudflare split-workers](https://github.com/cloudflare/workers-oauth-provider/tree/main/examples/split-workers). Lo starter ufficiale contiene un login dimostrativo: qui è stato sostituito con autenticazione proprietario, consenso e conferma separata delle telefonate.
