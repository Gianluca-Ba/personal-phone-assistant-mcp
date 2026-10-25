> Le limitazioni di esecuzione descritte sotto sono storiche. Per il flusso corrente con conferma conversazionale vedere [outbound-execution.md](outbound-execution.md).

# Diagnosi della riconnessione OAuth dalla chat

**Aggiornamento operativo:** la fase corrente abilita soltanto la preparazione e blocca esplicitamente l’approvazione. Vedi [sola creazione](creation-only.md). Gli esiti operativi precedenti riportati sotto sono storici.

## Riproduzione e causa

Dopo `e929422` il challenge `insufficient_scope` veniva riconosciuto: il client richiedeva `calls:read calls:write`. La riconnessione base dal pannello plugin poteva completarsi, mentre il percorso dalla chat falliva prima della pagina del secret.

La cattura Cloudflare filtrata ha mostrato questo schema nel percorso incrementale:

1. Token di lettura rinnovato con `POST /oauth/token → 200`.
2. La chiamata outbound riceve ancora `POST /mcp → 403`.
3. Il client esegue discovery, ma non apre un nuovo `GET /authorize` per i permessi aggiuntivi.

La stessa sequenza è stata **riprodotta con il client MCP TypeScript ufficiale**, usando il provider OAuth reale nei Worker locali: l’errore preciso era `Server returned 403 after trying upscoping`; `redirectToAuthorization` non veniva mai invocato. Il client provava a usare il refresh token esistente, senza includere gli scope aggiuntivi nella richiesta di refresh. Auth rilasciava correttamente solo i vecchi permessi di lettura; il client considerava il refresh un’autorizzazione riuscita, ritentava la chiamata e fermava il secondo challenge identico con la protezione anti-loop.

I test precedenti eseguivano esplicitamente un nuovo consenso, quindi non esercitavano questo tentativo automatico di refresh del client. Il nuovo test percorre invece il trasporto SDK e il suo gestore OAuth dall’inizio alla fine.

## Verifiche del resto del flusso

- La discovery OAuth pubblica è `200`, con issuer identico a quello indicato dai metadati del resource server, Authorization Code, PKCE S256, refresh token e i quattro scope dichiarati.
- Il Protected Resource Metadata indicato nel challenge è `/.well-known/oauth-protected-resource/mcp` e risponde `200`. Il percorso senza `/mcp` restituisce `404`, ma non è quello indicato dal challenge né quello richiesto nel flusso osservato; non è stato modificato come falsa soluzione del problema.
- Registrazione DCR diagnostica con redirect ufficiale ChatGPT: `201`. Apertura del consenso DCR: `200`.
- CIMD reale `https://chatgpt.com/oauth/client.json` risolvibile e compatibile con il redirect ufficiale `https://chatgpt.com/connector_platform_oauth_redirect`. Apertura del consenso in produzione: `200`.
- Il collegamento base realmente effettuato durante la diagnosi ha prodotto `GET /authorize → 200`, `POST /authorize → 302` e `POST /oauth/token → 200`, con client ChatGPT CIMD. Quindi registrazione/client metadata, redirect, cookie di consenso, callback e scambio dei token non fallivano globalmente.
- L’endpoint opzionale OIDC `/.well-known/openid-configuration` può rispondere `404`: il servizio è OAuth e non dichiara scope OpenID. La documentazione OpenAI conferma che l’ID token e `id_token_hint` sono ottimizzazioni opzionali per la riautorizzazione, non requisiti per l’OAuth incrementale.
- Header `WWW-Authenticate`, errore `insufficient_scope`, elenco completo degli scope, `resource_metadata`, `securitySchemes` e `_meta["mcp/www_authenticate"]` restano presenti. Il client riconosceva già questi segnali; non è stato sostituito il protocollo con un errore testuale.

## Correzione

Prima di rispondere al challenge, MCP segnala al servizio Auth che quel proprietario/client/resource richiede un nuovo consenso OAuth. Auth valida nuovamente il bearer sul service binding e registra soltanto gli scope richiesti e una scadenza di 10 minuti in un Durable Object `OAUTH_STEP_UP`, nello stesso Worker auth. La chiave è un hash del contesto; non vengono memorizzati token, codici, secret o dati delle telefonate.

È necessario storage coerente immediatamente: un semplice marker KV eventualmente consistente potrebbe non essere visibile alla richiesta di refresh successiva, riproducendo il problema. Il Durable Object non è un Worker aggiuntivo e non modifica D1.

Se il client tenta il refresh di un grant che non copre gli scope appena richiesti, `tokenExchangeCallback` risponde con l’errore standard **`invalid_grant`**, richiedendo una nuova autorizzazione del proprietario. La libreria Cloudflare revoca quel grant secondo il suo comportamento documentato. Il client ufficiale elimina le vecchie credenziali e apre finalmente il nuovo consenso PKCE con gli scope del challenge.

Un nuovo Authorization Code, ottenuto dopo il consenso del proprietario, azzera il marker. Non si aggiungono mai scope con un refresh. Se il proprietario sceglie soltanto permessi di lettura, quelli restano i soli permessi concessi. I refresh normali senza una richiesta incrementale pendente e quelli di altri client continuano a funzionare.

Il marker di step-up è **soltanto una richiesta di consenso OAuth**: non autorizza una telefonata. `verifiedNativeConsent()` non è stato modificato, outbound resta disabilitato e l’allowlist resta vuota.

## Test e rilascio

La suite copre 16 casi, fra cui:

- Client ufficiale: challenge → vecchio refresh rifiutato → apertura consenso con `calls:read calls:write` → PKCE → token nuovo → richiesta simulata pending.
- Refresh di lettura di un altro client non invalidato.
- Scadenze, duplicati, concorrenza e blocco delle telefonate già presenti nella suite.
- Redirect non registrato rifiutato e verifier PKCE errato rifiutato.
- Cookie, protezione Origin, consenso monouso, refresh normale e revoca.

Build dei due Worker superate. Ordine di aggiornamento necessario: **Auth → MCP**, perché MCP usa il nuovo metodo RPC Auth `requireScopeUpgrade`. Nessun aggiornamento del Worker telefonico o di Telnyx, nessuna telefonata reale e nessuna modifica alle tabelle D1.

## Completare il consenso

Usare una richiesta **nuova dalla chat**, dopo l’aggiornamento, e l’azione di riautorizzazione associata a quella richiesta. La pagina OAuth deve mostrare `calls:read calls:write`; completare lì il consenso con il segreto già conservato nel password manager. Una riconnessione generica dal pannello plugin può richiedere soltanto `calls:read`: non è il collaudo dell’aumento dei permessi.

Ripetere la richiesta dopo il consenso. L’esito operativo atteso, con la configurazione attuale, è `OUTBOUND_DISABLED`: i permessi saranno sufficienti ma non verrà creata né eseguita una telefonata. Se viene chiesto `calls:execute`, il consenso OAuth non supera il blocco di consenso attendibile per singola telefonata.

## Fonti

- [OpenAI: metadati, CIMD/DCR, redirect e contesto opzionale di riautorizzazione](https://developers.openai.com/plugins/build/auth).
- [Cloudflare: configurazione del token exchange callback e gestione di invalid_grant](https://github.com/cloudflare/workers-oauth-provider/blob/main/docs/authorization-server.md).
- [Client MCP TypeScript ufficiale](https://github.com/modelcontextprotocol/typescript-sdk).

## Conferma nel client reale

Dopo la correzione l’utente ha completato la riautorizzazione dalla chat. La cattura filtrata ha confermato `GET /authorize → 200` e `POST /authorize → 302` con entrambi gli scope `calls:read calls:write`, seguiti da `POST /oauth/token → 200`. Una nuova richiesta tramite il plugin collegato ha restituito **OUTBOUND_DISABLED**, anziché un errore OAuth o una nuova richiesta di riconnessione. Questo dimostra che il nuovo token ha superato il controllo di scope; il blocco operativo delle telefonate è rimasto attivo.

L’ipotesi intermedia che la riconnessione perdesse sistematicamente gli scope non è stata applicata al codice: i tentativi con il solo `calls:read` erano riconnessioni generiche dal pannello. Il flusso specifico dalla chat ha trasmesso correttamente `calls:read calls:write` una volta risolto il ciclo di refresh. Non sono stati ampliati automaticamente gli scope della pagina base.

L’utente ha già completato il consenso corretto: non serve ripeterlo. Per futuri incrementi usare l’azione associata alla richiesta dalla chat, verificando gli scope mostrati nella pagina di consenso. Un nuovo `OUTBOUND_DISABLED` è il risultato operativo previsto e non richiede ulteriori riconnessioni.

Il rapporto del rilascio, senza credenziali o dati delle telefonate, è in [oauth-reconnect-verification.json](oauth-reconnect-verification.json). Versioni pubblicate: Auth `9bf63d07-dadb-4722-b6a7-c26dae6a4a99`, MCP `3e30f0f6-390e-4abc-976d-4717c2de0d72`. Il monitoraggio temporaneo è stato terminato; i log grezzi sono stati scartati e non sono presenti nel repository.
