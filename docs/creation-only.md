# Primo intervento: preparare richieste senza effettuare telefonate

Questa fase abilita soltanto la creazione di richieste `pending_approval`. `approve_outbound_request` non può avviare telefonate: `OUTBOUND_EXECUTION_ENABLED=false` viene controllato prima delle letture di approvazione e di qualunque invio, e il preflight di deployment rifiuta un valore diverso. Il controllo `verifiedNativeConsent()` resta inoltre invariato e chiuso nel codice di produzione.

## Contratto verificato sul Worker esistente

Il sorgente del Worker telefonico è stato scaricato tramite API di sola lettura per un’ispezione temporanea privata, senza eseguirlo, modificarlo o copiarlo nel repository. La funzione `createOutboundRequest` non chiama Telnyx e non chiama la funzione di approvazione. Inserisce la richiesta in D1 e restituisce HTTP 201 con stato `pending_approval` e `authorized=false`.

Contratto di creazione:

- `POST /outbound/requests`, Bearer `OUTBOUND_API_SECRET`.
- Body `{destination_number, instructions, language}`.
- Lingue `auto`, `ja`, `it`, `en`, `pt`.
- Istruzioni finali di 10–3000 caratteri e corpo JSON di massimo 8192 byte UTF-8.
- Obiettivo e istruzioni vengono normalizzati e uniti dal MCP prima della richiesta; i limiti si applicano al testo finale, non separatamente ai due campi.
- La risposta include UUID `id` e `status="pending_approval"`; il MCP verifica in sola lettura la riga corrispondente prima di restituire lo snapshot.

Non sono state modificate le tabelle D1. L’inserimento autorizzato passa esclusivamente per l’API di creazione già esistente.

## Configurazione e privacy

Sul Worker MCP:

| Impostazione                            | Valore della fase                                           |
| --------------------------------------- | ----------------------------------------------------------- |
| `OUTBOUND_ENABLED`                      | `true`: sola preparazione, con il resto dei controlli       |
| `OUTBOUND_CONTRACT_VERIFIED`            | `true`: contratto verificato sul codice esistente           |
| `OUTBOUND_EXECUTION_ENABLED`            | `false`: approvazione ed esecuzione bloccate                |
| `OUTBOUND_PRIVATE_ALLOWLIST_CONFIGURED` | `true`                                                      |
| `OUTBOUND_ALLOWED_DESTINATIONS_SECRET`  | Secret Cloudflare contenente l’array E.164 autorizzato      |
| `OUTBOUND_API_SECRET`                   | Secret di creazione identico a quello del Worker telefonico |
| `OUTBOUND_APPROVAL_SECRET`              | Assente: non necessario e non configurato per questa fase   |

Il numero di prova viene conservato nella allowlist privata, non nei file Wrangler o nella documentazione pubblica. Se presente, la allowlist Secret ha precedenza sulla variabile pubblica `OUTBOUND_ALLOWED_DESTINATIONS`, che resta vuota come default di sicurezza. Non pubblicare numeri o credenziali nel repository.

## Idempotenza e credenziali

Usare sempre la stessa `request_key` per ritentare la stessa preparazione. Cambiare numero, lingua o istruzioni con la medesima chiave causa un conflitto. Un esito ambiguo, timeout o errore 5xx conserva il blocco persistente: non ritentare con una nuova chiave senza prima controllare lo stato.

Il sorgente verificato rifiuta HTTP 400/401/413/422 prima dell’inserimento. Questi rifiuti noti consentono di correggere input o credenziali e ritentare **con la stessa chiave**, senza una seconda richiesta. In particolare, `CREATION_CREDENTIAL_REJECTED` indica il `401` dell’API telefonica, non un problema OAuth del plugin. Non serve riconnettere ChatGPT: occorre correggere il Secret di creazione su MCP usando il valore originale esatto. Il campo contiene solo il valore, senza `Bearer`, virgolette o `OUTBOUND_API_SECRET=`.

Non è possibile rileggere da Cloudflare un Secret già salvato. Se il valore originale non è disponibile, fermarsi e concordare separatamente il recupero o un’eventuale rotazione; questo intervento non autorizza modifiche al Worker telefonico.

## Collaudo

La suite prova la preparazione pending, il retry idempotente, i limiti del contratto reale e il blocco dell’approvazione anche con un consenso sintetico valido. Il mock telefonico conta separatamente creazioni e approvazioni; i casi di sola creazione devono lasciare il contatore approvazioni invariato. È testato anche un 401 seguito dalla correzione della credenziale e da un retry con la stessa chiave.

Le chiamate reali non vengono mai utilizzate nei test. Per il collaudo autorizzato dal proprietario si invoca soltanto `create_outbound_request`, poi si verifica in lettura lo stato D1: `pending_approval`, `authorized_at` nullo e `telnyx_call_id` nullo. Non invocare il tool di approvazione per questo collaudo. La preparazione pending non è una chiamata completata o avviata.

Lo snapshot di approvazione MCP scade dopo 10 minuti; la riga D1 può restare pending anche oltre questa finestra. La fase successiva dovrà prevedere un nuovo consenso valido prima di qualsiasi esecuzione, senza disattivare i controlli esistenti.

Si distribuisce soltanto `personal-phone-assistant-mcp`. Auth, il Worker telefonico e Telnyx non vengono modificati.

## Esito del collaudo di distribuzione

Il 25 ottobre 2026 typecheck, 19 test e build sono passati. È stato distribuito esclusivamente MCP, versione `090e718a-3105-4a02-b525-185755f7f5e2`, con esecuzione disabilitata e senza Secret di approvazione. Il retry autorizzato con la medesima chiave ha ricevuto `CREATION_CREDENTIAL_REJECTED` (HTTP 401 dal servizio telefonico). La verifica D1 in sola lettura ha confermato conteggi invariati: 5 richieste totali, 0 pending. Non è stata creata una richiesta di prova né effettuata alcuna telefonata. La preparazione resta bloccata finché la credenziale di creazione sui due servizi non coincide.

Dopo il ripristino della credenziale originale, il retry con la medesima chiave è riuscito: una sola richiesta è stata preparata. La verifica D1 in sola lettura ha confermato `status=pending_approval`, `authorized_at=NULL` e `telnyx_call_id=NULL`. La versione MCP attiva dopo il salvataggio del Secret è `6e1507a2-3a65-46c5-b426-e1b266a270b7`, con `OUTBOUND_EXECUTION_ENABLED=false` e senza Secret di approvazione. Nessuna telefonata è stata avviata. Identificativi e destinazione del collaudo restano esclusi dal rapporto pubblico.
