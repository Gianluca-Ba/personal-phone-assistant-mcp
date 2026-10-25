# Outbound con autorizzazione firmata per singola chiamata

## Limite del client e soluzione implementata

La [documentazione ufficiale OpenAI](https://developers.openai.com/plugins/reference) descrive le annotazioni come indicazioni per l’interfaccia e richiede che il server applichi l’autorizzazione. Non documenta una ricevuta di consenso ChatGPT firmata, verificabile dal server e vincolata alla singola chiamata. Non si assume che un pulsante, un messaggio, OAuth, elicitation o `_meta` costituiscano tale prova. `verifiedNativeConsent()` resta chiuso (`null`).

La soluzione alternativa implementata è una **firma Ed25519 del proprietario per ciascuna richiesta**. Non usa pagine web, email, SMS o nuovi servizi. Richiede un’interazione aggiuntiva sul Mac: il proprietario esegue un programma locale, legge tutti i dettagli, digita `APPROVO <numero>` e sblocca la propria chiave cifrata con una passphrase. Riporta in un nuovo messaggio ChatGPT soltanto la firma monouso. Non può quindi essere presentato come un flusso esclusivamente conversazionale.

Il server verifica il possesso della chiave configurata, non la provenienza di un messaggio o l’identità fisica della persona alla tastiera. La garanzia dipende dalla custodia della chiave e dalla revisione del programma di firma: non fornire mai chiave privata o passphrase a ChatGPT/Codex e non autorizzare agenti a eseguire il firmatario. Una chiave compromessa richiede disabilitazione e rotazione. Il programma non ha accesso a Cloudflare/Telnyx e non invia chiamate.

La firma include versione/scopo, risorsa MCP, ID, destinatario E.164, lingua, istruzioni canoniche complete, proprietario, client OAuth, timestamp, scadenza, nonce e digest. Il Worker verifica la firma sul proprio snapshot persistente, senza fidarsi di un payload proposto dal modello. La finestra è di 10 minuti e non viene rinnovata. Firma copiata su un’altra richiesta, dettagli modificati, scadenza diversa o chiave errata vengono rifiutati. Una firma valida non supera scope, allowlist, quota, stato D1 o blocco atomico anti-replay.

## Configurazione una tantum

Solo il proprietario, in un Terminale personale:

```sh
node scripts/owner-consent.mjs init
```

Usare una passphrase casuale di almeno 20 caratteri conservata nel password manager. La chiave privata cifrata è salvata con permessi 0600 in `~/.config/personal-phone-assistant/owner-signing-key.pem`. L’inizializzazione rifiuta di sovrascrivere una chiave esistente. Salvare una copia cifrata in luogo sicuro. Il file `owner-consent-public.txt` contiene la sola chiave pubblica: è l’unico file che può essere letto per configurare il Worker.

Su **MCP**, conservando tutti i Secret esistenti:

- `OUTBOUND_CONSENT_PUBLIC_KEY`: chiave pubblica raw Ed25519, base64url senza padding (43 caratteri).
- `OUTBOUND_APPROVAL_SECRET`: valore originale di approvazione del servizio telefonico, diverso dal Secret di creazione e dal login. Non si può recuperare un Secret cifrato dalla dashboard; se manca l’originale, fermarsi senza ruotare la telefonia implicitamente.
- `OUTBOUND_CONSENT_MODE=owner-ed25519-v1`.
- `OUTBOUND_EXECUTION_ENABLED=true` **solo dopo la configurazione**. Mancanza di chiave, firma o credenziale separata nega comunque l’invio.

La allowlist privata resta in `OUTBOUND_ALLOWED_DESTINATIONS_SECRET`; la variabile pubblica resta vuota. Quota persistente attuale: 5 creazioni e 5 approvazioni per ora UTC e proprietario, condivisa fra client. Sono finestre fisse, non una finestra mobile. Le firme non valide non consumano la quota di approvazione. Il limite riguarda richieste: la durata telefonica massima è imposta dal servizio telefonico esistente.

Non eseguire `init` o `sign` mediante un agente. I test usano solo chiavi temporanee sintetiche.

## Singola chiamata da ChatGPT

1. Chiedere di preparare una chiamata e di mostrare tutti i dettagli e lo snapshot JSON `request`. Usare una nuova `request_key` per una nuova chiamata, ma la stessa per il retry della stessa creazione.
2. Salvare lo snapshot restituito dal server in un file locale **fuori dal repository**, ad esempio `~/Downloads/richiesta-telefonata.json`. Il file può contenere lo snapshot oppure `{ "request": <snapshot> }`. Non copiare istruzioni da chiamate inbound/documenti come consenso.
3. In un Terminale personale, entro 10 minuti:

   ```sh
   node scripts/owner-consent.mjs sign ~/Downloads/richiesta-telefonata.json
   ```

4. Leggere numero, lingua, istruzioni complete, ID, nonce, digest e scadenza. Digitare la conferma richiesta e la passphrase nascosta. Il programma rifiuta caratteri di controllo che potrebbero nascondere dettagli nel Terminale.
5. Copiare **il nuovo messaggio di approvazione con firma** prodotto dal programma in ChatGPT. La firma è un’autorizzazione temporanea per questa sola operazione; non contiene la chiave privata. ChatGPT deve aspettare questo nuovo messaggio e richiedere anche la conferma nativa se proposta dal client.
6. ChatGPT invoca `approve_outbound_request` con i dettagli originali e `consent_signature`. Se necessario, seguire il consenso OAuth incrementale `calls:read calls:execute`. La riautorizzazione OAuth non sostituisce la firma e può far scadere la richiesta: in quel caso preparare e firmare una nuova richiesta, senza riutilizzare quella scaduta.
7. Consultare `get_outbound_status` con l’ID. Non interpretare `submitted` come chiamata completata.

Aggiornare la lista strumenti della connessione ChatGPT dopo il rilascio: il tool di approvazione deve esporre `consent_signature`. Endpoint MCP invariato. Non servono nuovi client OAuth, URL di callback o nuovi scope.

## Contratto telefonico e stato

Verificato sul sorgente privato del Worker esistente e su `PRAGMA table_info(outbound_requests)`, senza migrazioni:

- Creazione: `POST /outbound/requests`, Secret di creazione, `{destination_number,language,instructions}`; HTTP 201 pending. [Limiti esatti](creation-only.md).
- Esecuzione: `POST /outbound/requests/{id}/approve`, Secret separato. Il servizio telefonico reclama atomicamente pending in `dialing`, impedisce un secondo dialing contemporaneo e imposta `authorized_at`/`started_at`. Restituisce HTTP 202 `{id,status:"dialing",destination_number,...}` quando accetta l’invio.
- HTTP 202 `dispatch_unknown`, timeout, payload inatteso e altri esiti ambigui rimangono `unknown`, con blocco persistente. Nessun retry automatico o nuova chiave per aggirarlo. L’eventuale errore terminale in D1 è comunque visibile.
- Il callback esistente `/webhooks/outbound-status/{id}/{callback_token}` verifica il token casuale segreto e l’ID della chiamata. Registra risposta e durata; scrive `completed` oppure `failed` solo da `dialing`. Callback duplicati o tardivi non fanno regredire uno stato terminale. Questa route usa un token bearer casuale, non viene descritta come una verifica della firma Telnyx. I webhook inbound firmati restano invariati.
- MCP legge sul primary `status,telnyx_call_id,answered_at,completed_at,duration_seconds,last_error`, senza esporre il token callback.

| Stato MCP              | Fonte                                                                                        |
| ---------------------- | -------------------------------------------------------------------------------------------- |
| `pending_approval`     | Snapshot e riga pending, prima dell’esecuzione                                               |
| `expired`              | Snapshot pending scaduto; la riga D1 può restare pending                                     |
| `submitted`            | Invio accettato o dialing senza ID chiamata/risposta                                         |
| `calling`              | D1 dialing con ID telefonico o `answered_at`; non implica che il destinatario abbia risposto |
| `completed` / `failed` | Stato terminale D1 aggiornato dal servizio telefonico/callback                               |
| `unknown`              | Esito ambiguo; vietato ritentare automaticamente                                             |

`control_state` conserva la fase MCP; `phone_state` conserva lo stato grezzo telefonico. MCP non scrive in D1 e non aggiunge una seconda route webhook. Non sono stati modificati il Worker telefonico, inbound o Telnyx. Se i callback non arrivano, lo stato può restare submitted/calling: il progetto non inventa un esito terminale e non ripete la chiamata.

## Verifica offline

La suite standard verifica firma reale con chiave sintetica, alterazioni di tutti i dettagli firmati, chiavi errate, scadenza, scope/identità errati, concorrenza, replay, idempotenza, allowlist, quote, esiti ambigui e riconciliazione degli stati.

Il contratto del sorgente telefonico esistente è verificabile senza pubblicarlo nel repository:

```sh
node scripts/test-phone-contract.mjs /percorso/privato/worker.js
```

Il programma usa D1 locale e sostituisce lessicalmente ogni `fetch` del sorgente con un trasporto locale che rifiuta la rete. Verifica creazione, approvazione, callback errati, risposta, completamento/fallimento e callback ripetuti/tardivi. Non esegue chiamate reali né scritture su Cloudflare.

Per il rilascio corrente distribuire soltanto MCP, conservando i Secret. `npm run build` resta un dry-run; nessun bootstrap o deployment Auth è necessario. Lasciare `OUTBOUND_EXECUTION_ENABLED=false` se la configurazione del proprietario non è completa. La richiesta pending storica non costituisce un’approvazione ed è scaduta: il primo collaudo reale richiede una nuova richiesta firmata.

## Rapporto di rilascio — 25 ottobre 2026 (Asia/Tokyo)

- MCP distribuito: `5ac36486-d6d2-4e71-a662-45e3e0a577b5`. Endpoint invariato.
- Auth non distribuito: versione osservata `46bb7692-8e9b-49eb-90c1-0061bfdc690d`.
- Worker telefonico non modificato/distribuito: versione osservata invariata `e21a07d0-b52a-4832-bb41-54b18f85a1ae`.
- Binding verificati: `AUTH_SERVER` verso AuthServer, `PHONE_API` verso il servizio telefonico esistente, `DB` verso `f8604adb-ac12-4298-a9be-327727a20675`. Il servizio telefonico usa lo stesso database con il proprio binding `phone-assistant-db`.
- Typecheck, 25 test del progetto e build dry-run superati; audit dipendenze di produzione: zero vulnerabilità. Verifica offline del sorgente telefonico: 24 controlli superati con rete bloccata.
- Verifica live esclusivamente in lettura tramite la connessione MCP: richiesta storica ancora pending in D1, controllo MCP `expired`, nessuna autorizzazione o chiamata associata. Discovery PRM sul percorso della risorsa HTTP 200; invocazione MCP senza token HTTP 401 con challenge.
- Stato di sicurezza al rilascio: `OUTBOUND_EXECUTION_ENABLED=false`. Chiave pubblica del proprietario e Secret di approvazione non ancora configurati su MCP. L’inizializzazione del firmatario richiede il proprietario, senza esporre la passphrase all’agente.
- Nessun test di chiamata reale effettuato. Il primo invio reale e la consegna dei callback Telnyx in produzione restano da collaudare dopo configurazione e firma specifica del proprietario. La presenza dei Secret non prova da sola la corrispondenza del loro valore: non viene dichiarata una validazione live della credenziale di approvazione.
