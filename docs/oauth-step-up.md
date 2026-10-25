# OAuth incrementale per ChatGPT

**Aggiornamento operativo:** la fase corrente abilita soltanto la preparazione e blocca esplicitamente l’approvazione. Vedi [sola creazione](creation-only.md). Gli esiti operativi precedenti riportati sotto sono storici.

**Aggiornamento:** il ciclo di refresh osservato dopo questo rilascio è stato corretto. Vedi [diagnosi e correzione della riconnessione dalla chat](oauth-reconnect-diagnosis.md). Il catalogo scope era corretto, ma serviva obbligare il client a ottenere un nuovo consenso invece di riutilizzare il vecchio grant.

## Problema e correzione

Il vecchio token `calls:read` veniva rifiutato dal callback del tool con un normale `isError` e testo “Missing calls:write authorization”. Mancava il challenge necessario a far richiedere al client gli scope aggiuntivi. Riconnettere il plugin ripartiva dal minimo di lettura, senza risolvere la causa.

Ora il preflight HTTP esamina il singolo messaggio JSON-RPC **prima** del dispatch e di qualunque operazione:

| Operazione                            | Scope completi richiesti   |
| ------------------------------------- | -------------------------- |
| Consultazione, initialize, tools/list | `calls:read`               |
| `create_outbound_request`             | `calls:read calls:write`   |
| `approve_outbound_request`            | `calls:read calls:execute` |

Un token valido ma insufficiente riceve il `403` prodotto da `insufficientScope()` della libreria Cloudflare, con `WWW-Authenticate` contenente `error="insufficient_scope"`, `error_description`, l’elenco **completo** degli scope e `resource_metadata`. Il corpo conserva l’ID JSON-RPC e include un risultato errore con `_meta["mcp/www_authenticate"]` identico al challenge HTTP, per il collegamento OAuth a livello di tool di ChatGPT.

La lista strumenti pubblica inoltre `securitySchemes` OAuth per ogni tool, sia al livello principale sia nel mirror `_meta.securitySchemes`. La versione SDK fissata nel progetto conserva il mirror; un adattatore della risposta `tools/list` espone anche il livello principale documentato da OpenAI. Non si usano euristiche basate sullo user agent per scegliere l’autorizzazione.

La lettura resta il minimo pubblicizzato dal protected resource; la discovery del server auth pubblicizza il catalogo completo `calls:read`, `calls:write`, `calls:execute`, `offline_access`. Il provider concede gli scope richiesti al nuovo consenso. Non si aggiungono scope a un grant con il solo refresh: i test verificano che un refresh del grant di lettura non ottenga `calls:write`. Una nuova autorizzazione dello stesso client può revocare il vecchio grant: usare il nuovo token, senza riutilizzare quello precedente.

## Verifiche

La suite percorre il flusso completo nei Worker locali con il provider reale:

1. Autorizzazione `calls:read offline_access`, chiamata di creazione rifiutata con HTTP 403, header e metadati di challenge; nessuna creazione nel servizio telefonico simulato.
2. Discovery del server a partire dal `resource_metadata` del challenge.
3. Nuovo consenso PKCE per **lo stesso client OAuth**, aggiungendo `calls:write`; nuova chiamata di creazione riuscita con stato pending nel servizio locale.
4. Approvazione rifiutata con challenge `calls:read calls:execute`.
5. Nuovo consenso per lo stesso client con `calls:read calls:execute` (senza richiedere `calls:write`); la stessa approvazione raggiunge il controllo `verifiedNativeConsent()` e viene bloccata con `TRUSTED_CONFIRMATION_UNAVAILABLE`.
6. Un token con il solo `calls:write` riceve il challenge completo, che include anche `calls:read`.
7. Descrittori strumenti e mirror dichiarano gli scope corretti. Le protezioni outbound precedenti restano testate.

Il servizio telefonico nei test è locale e simulato. Non vengono effettuate telefonate reali. In produzione restano `OUTBOUND_ENABLED=false`, allowlist vuota e il blocco di consenso attendibile: ottenere gli scope corretti non abilita le telefonate.

## Aggiornare ChatGPT

1. Nelle impostazioni della connessione **Personal Phone Assistant**, aggiornare/ricaricare la lista degli strumenti per acquisire i nuovi `securitySchemes`. L’URL resta `https://personal-phone-assistant-mcp.barsaglini-gianluca.workers.dev/mcp`.
2. Aprire una nuova conversazione e selezionare esplicitamente il plugin, così non si riutilizzano definizioni di tool già caricate nella conversazione precedente.
3. Chiedere una preparazione, ad esempio «Prepara una richiesta outbound, senza avviare alcuna telefonata». Quando ChatGPT richiede il collegamento o l’autorizzazione aggiuntiva, completare la pagina OAuth verificando che fra i permessi ci siano **calls:read e calls:write**. `offline_access` permette il rinnovo automatico.
4. Ripetere la richiesta dopo il consenso. Con la configurazione operativa attuale l’esito può essere `OUTBOUND_DISABLED`: significa che l’autorizzazione ha superato il controllo di scope, ma la preparazione è ancora disabilitata. Non confonderlo con `insufficient_scope`.
5. Il tool di approvazione richiede separatamente **calls:read e calls:execute**. Una riautorizzazione corretta non sostituisce il consenso attendibile per singola chiamata e non rimuove `verifiedNativeConsent()`.

Non è necessario disconnettere e riconnettere ripetutamente per ampliare gli scope: è il tentativo del tool, con challenge e metadati aggiornati, a richiedere l’incremento. Se il client continua a mostrare le vecchie definizioni dopo l’aggiornamento, riconnettere **una sola volta dopo aver aggiornato gli strumenti** e riprovare in una nuova conversazione. La disponibilità e le etichette dell’interfaccia dipendono dal workspace; non è stata eseguita una riautorizzazione privata nel tuo client durante questo rilascio. Il percorso standard e i segnali richiesti dal client sono verificati dal lato server e dai test di integrazione.

## Fonti

- [Cloudflare: insufficientScope e scope completi per lo step-up](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/resource-servers.md).
- [OpenAI: policy dei tool, securitySchemes e mcp/www_authenticate](https://developers.openai.com/plugins/build/auth).
- [OpenAI: metadati di autenticazione dei tool](https://developers.openai.com/plugins/reference).

La discovery pubblica del Worker auth già distribuito include gli scope necessari; non serve distribuire auth per questa correzione. Si distribuisce soltanto MCP, lasciando invariati auth, Worker telefonico e Telnyx.

## Esito sul plugin collegato e rilascio

Distribuito esclusivamente MCP, versione `0a1a7bcf-6a9a-4169-b1e0-652856c7c8f8`. Sono passati 14 test e le build. La discovery pubblica auth supporta tutti gli scope richiesti; le versioni di auth e del Worker telefonico sono rimaste invariate. Il codice `verifiedNativeConsent()` non è cambiato e outbound resta disabilitato.

È stato eseguito un controllo anche attraverso il plugin effettivamente collegato a questa conversazione. Il client ha riconosciuto il challenge e restituito `action: TRIGGER_REAUTHENTICATION`, `reason: www_authenticate_reauth`, `requested_scopes: [calls:read, calls:write]`. Non è più soltanto un errore testuale del tool: il client richiede l’autorizzazione incrementale. Il consenso privato dell’utente resta da completare nell’interfaccia ChatGPT. Non sono state create richieste telefoniche o effettuate chiamate reali.

Il rapporto senza credenziali è in [oauth-step-up-verification.json](oauth-step-up-verification.json). Per completare il flusso usare l’azione di riautorizzazione associata al tool, che porta con sé gli scope richiesti dal challenge, quindi ripetere la richiesta.
