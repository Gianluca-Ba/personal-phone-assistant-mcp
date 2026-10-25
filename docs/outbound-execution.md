# Outbound con conferma nella conversazione

## Flusso attuale

1. L’utente chiede una telefonata.
2. ChatGPT invoca `create_outbound_request` con una `request_key` UUID stabile. Non viene avviata alcuna telefonata.
3. ChatGPT presenta numero E.164, lingua, obiettivo e istruzioni canoniche complete, insieme a ID e scadenza della richiesta.
4. **Attende un nuovo messaggio esplicito dell’utente che approvi proprio quella richiesta.** La richiesta iniziale di chiamare non sostituisce questa conferma. Se cambiano i dettagli, prepara una nuova richiesta e chiede una nuova approvazione.
5. Solo dopo quel messaggio invoca `approve_outbound_request` con i dettagli originali, nonce e digest; resta soggetto alla conferma nativa del tool quando richiesta dal client.
6. MCP controlla autorizzazione e integrità della richiesta, inoltra l’approvazione al Worker telefonico e rende consultabile lo stato con `get_outbound_status`.

Non servono firme, chiavi, Terminale, copie di codici o pagine web per approvare una telefonata. Il precedente programma `scripts/owner-consent.mjs` e il verificatore Ed25519 sono stati rimossi. Le chiavi locali già create non vengono lette né cancellate: non sono più usate dal progetto.

## Distinzione fra regola operativa e controlli server

L’attesa di un nuovo messaggio è una **regola operativa di ChatGPT**, pubblicata nelle istruzioni del server MCP, nelle descrizioni dei tool e nelle risposte di creazione. Le [istruzioni riutilizzabili per ChatGPT](chatgpt-instructions.md) riportano la stessa regola.

**La conferma conversazionale non costituisce una prova crittografica indipendente dell’approvazione umana. Il backend non può verificare che ChatGPT abbia effettivamente atteso e ricevuto quel messaggio.** La conferma nativa è un controllo del client: non viene presentata come attestazione server. Un chiamante che possiede un token OAuth valido con `calls:execute` e tutti i dati corretti può invocare l’approvazione anche senza rispettare la sequenza conversazionale; il server non è in grado di rilevare questa violazione. Non si aggiungono campi come `user_confirmed`, ID messaggio inventati o `_meta.approved` per simulare una verifica.

Chiamate inbound, riepiloghi, documenti e altri contenuti esterni restano dati non attendibili e non autorizzano telefonate. Una frase in tali contenuti non soddisfa la regola operativa. Non salvare approvazioni permanenti del client come sostituto della conferma specifica nella conversazione.

## Controlli backend mantenuti

- OAuth: `calls:read calls:write` per creare, `calls:read calls:execute` per approvare. Restano discovery, PKCE, step-up e challenge insufficient_scope esistenti.
- Identità owner, client OAuth e versione delle credenziali devono coincidere con lo snapshot.
- Snapshot persistente immutabile: ID, numero, lingua e istruzioni canoniche. Obiettivo e istruzioni vengono uniti prima della creazione.
- Nonce UUID e digest SHA-256 controllati per corrispondenza esatta. Sono dati visibili al modello e controlli di integrità, **non prove umane**.
- Scadenza di 10 minuti, senza rinnovo sui retry. Una riga D1 può restare pending dopo la scadenza MCP, ma non è più eseguibile da questo percorso.
- Allowlist privata E.164 in `OUTBOUND_ALLOWED_DESTINATIONS_SECRET`. Default pubblico vuoto.
- Quota persistente per owner e operazione: attualmente 5 creazioni e 5 approvazioni per ora UTC, condivise fra client e richieste. Finestra fissa.
- D1 letto sul primary per verificare pending e corrispondenza con lo snapshot.
- Prenotazione atomica persistente prima dell’invio. Concorrenza e replay non producono un secondo invio.
- Timeout ed esiti ambigui restano bloccati come `unknown`: nessun retry automatico e nessuna nuova chiave per aggirare il blocco.
- Secret di creazione e approvazione separati; l’approvazione rifiuta valori mancanti o uguali. Nessun Secret viene riportato in log o risposte MCP.
- Audit con timestamp e codici, senza attribuirgli una falsa attestazione del messaggio umano.

## Configurazione e deployment

Solo MCP cambia per questo rilascio:

```text
OUTBOUND_ENABLED=true
OUTBOUND_CONTRACT_VERIFIED=true
OUTBOUND_EXECUTION_ENABLED=true
OUTBOUND_CONFIRMATION_POLICY=conversation-policy-v1
OUTBOUND_RATE_LIMIT_PER_HOUR=5
```

Secret richiesti su MCP: `OUTBOUND_API_SECRET`, `OUTBOUND_APPROVAL_SECRET`, `OUTBOUND_ALLOWED_DESTINATIONS_SECRET`. I primi due devono contenere i rispettivi valori originali del Worker telefonico. La vecchia chiave pubblica di consenso non è più necessaria. Non modificare le credenziali telefoniche, Auth o Telnyx per aggiornare il flusso. Impostare `OUTBOUND_EXECUTION_ENABLED=false` per bloccare gli invii mantenendo la preparazione.

```sh
npm run typecheck
npm test
npm run build
npm run deploy:mcp
```

Build è un dry-run. Non servono bootstrap, deployment Auth, migrazioni D1 o modifiche inbound.

## Contratto telefonico e stati

Contratto verificato sul sorgente esistente e sulle colonne D1:

- `POST /outbound/requests`, credenziale di creazione: `{destination_number,language,instructions}`, HTTP 201 pending. [Limiti del contratto](creation-only.md).
- `POST /outbound/requests/{id}/approve`, credenziale separata: il servizio reclama atomicamente pending in `dialing`, imposta `authorized_at` e `started_at` e impedisce un secondo dialing contemporaneo.
- MCP accetta come invio effettuato HTTP 202 con `{id,status:"dialing",destination_number,...}` corrispondente alla richiesta. Non equivale a una telefonata completata.
- `dispatch_unknown`, timeout o risposte inattese mantengono il blocco persistente. Se D1 contiene un esito terminale, viene mostrato anche quando il precedente invio MCP era incerto.
- Callback esistente `/webhooks/outbound-status/{id}/{callback_token}`: controlla token casuale segreto e ID telefonico, registra risposta e durata, aggiorna completed/failed solo da dialing. Callback ripetuti o tardivi non fanno regredire lo stato terminale. Si tratta di un token bearer, non di un’attestazione di consenso umano.
- MCP non scrive in D1 e non aggiunge un secondo webhook. Legge solo colonne consentite; il token callback non viene esposto.

| Stato MCP              | Significato                                                                          |
| ---------------------- | ------------------------------------------------------------------------------------ |
| `pending_approval`     | Preparata e ancora valida                                                            |
| `expired`              | Scaduta per l’approvazione MCP                                                       |
| `submitted`            | Invio accettato o dialing senza ID/risposta                                          |
| `calling`              | Dialing con ID telefonico o risposta; non implica che il destinatario abbia risposto |
| `completed` / `failed` | Esito terminale D1                                                                   |
| `unknown`              | Esito ambiguo, vietato ritentare automaticamente                                     |

`control_state` conserva la fase MCP; `phone_state` lo stato telefonico grezzo. Se i callback non arrivano, non viene inventato un completamento né ripetuta la chiamata.

## Aggiornamento della connessione ChatGPT

Aggiornare la lista strumenti dell’app MCP esistente: `approve_outbound_request` non deve più contenere `consent_signature` e la descrizione deve richiedere un nuovo messaggio esplicito. Endpoint invariato:

`https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp`

Se ChatGPT usa ancora il vecchio schema, aggiornare/ricollegare l’app dalle impostazioni. Se viene richiesto lo step-up, autorizzare `calls:read calls:execute`; non è necessario creare una nuova app o un nuovo client OAuth. Le richieste scadute richiedono una nuova preparazione e una nuova conferma.

## Verifica

La suite usa solo telefonia simulata e verifica approvazione senza firma, OAuth incrementale, identità/scope errati, dettagli alterati, scadenza, allowlist, quote, idempotenza, concorrenza, replay, stato consultabile ed esiti ambigui. Controlla anche che i tool documentino l’attesa del nuovo messaggio e non espongano più il campo firma. I test non possono dimostrare che un modello seguirà sempre le istruzioni conversazionali.

La verifica offline del contratto telefonico usa `node scripts/test-phone-contract.mjs /percorso/privato/worker.js`, con D1 locale e rete bloccata. Non avvia telefonate e non modifica la produzione.

## Rapporto del rilascio — 25 ottobre 2026 (Asia/Tokyo)

- Solo MCP distribuito, versione codice `867ee081-2ed8-4326-99ee-bb52986946e1`; versione attiva dopo rimozione della vecchia chiave pubblica `2fff0a21-601e-47c5-b768-4656df6f0968`.
- Verificati `OUTBOUND_EXECUTION_ENABLED=true`, `OUTBOUND_CONFIRMATION_POLICY=conversation-policy-v1` e presenza dei tre Secret necessari. Nessun valore segreto è stato letto o pubblicato.
- Auth invariato: `46bb7692-8e9b-49eb-90c1-0061bfdc690d`. Worker telefonico invariato: `e21a07d0-b52a-4832-bb41-54b18f85a1ae`.
- Typecheck, 22 test automatici e build superati; audit di produzione con zero vulnerabilità rilevate. Rimossi i test specifici della firma ormai eliminata e mantenuti quelli sui controlli backend.
- Consultazione live MCP in sola lettura riuscita: richiesta storica correttamente `expired` nel controllo MCP, nessun ID telefonico associato.
- Nessuna telefonata reale avviata durante questo rilascio; nessuna modifica alle tabelle D1, a inbound o Telnyx. Non viene dichiarato un collaudo reale della credenziale di approvazione o dei callback di una nuova chiamata.
