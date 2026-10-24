# Conferma outbound: proprietà e limite del protocollo

## Decisione di rilascio

Rimosso il flusso di approvazione via browser. `approve_outbound_request` non crea ticket o URL e non rimanda a una pagina. È dichiarato al client come tool con effetti potenzialmente irreversibili (`readOnlyHint=false`, `destructiveHint=true`, `openWorldHint=true`). La descrizione richiede presentazione dei dettagli e un nuovo messaggio esplicito del proprietario, prima della chiamata al tool.

**Non viene abilitata l’esecuzione reale.** Lo scope `calls:execute` autentica una capacità, non il consenso umano alla singola telefonata. La normale richiesta MCP non include una ricevuta documentata e attendibile di un nuovo messaggio approvativo. Annotazioni, elicitation, nonce, digest, metadati dichiarati dal client e ID messaggio forniti dal modello non sono attestazioni.

La documentazione OpenAI descrive conferme native e la possibilità di ricordare una scelta per le chiamate successive della conversazione. Questo non soddisfa il requisito «nuovo messaggio che approva esattamente questa chiamata». Non viene affermato che l’assenza di una ricevuta dimostri assenza di consenso: il server semplicemente non dispone della prova richiesta e rifiuta l’esecuzione.

Fonti consultate:

- [Custom MCP server: conferme e scelte ricordate](https://developers.openai.com/api/docs/guides/custom-mcp-server).
- [MCP server: annotazioni ed elicitation, senza sostituire controlli server](https://developers.openai.com/plugins/build/mcp-server).
- [Riferimento delle annotazioni e metadati](https://developers.openai.com/plugins/reference).
- [Specifica MCP elicitation: il protocollo non impone uno specifico modello di interazione](https://modelcontextprotocol.io/specification/2025-11-25/client/elicitation).

## Protezione server

La preparazione salva uno snapshot per ID richiesta, proprietario e client OAuth con numero E.164, lingua, istruzioni complete, nonce, digest, data e scadenza di 10 minuti. Creazione e invio hanno prenotazioni persistenti prima delle richieste esterne. Le quote sono per proprietario e non possono essere aggirate cambiando client o ID richiesta.

L’approvazione richiede tutti i dettagli e i valori di binding identici allo snapshot. Legge D1 sul primary e richiede `pending_approval`; rifiuta cambi dei dettagli, destinazioni fuori allowlist, identità/client/scope/versioni differenti, scadenze e invii già riservati. Nessuna istruzione esterna viene interpretata come consenso.

Infine `verifiedNativeConsent()` deve produrre una decisione interna fidata, legata a identità, client, digest, nonce e scadenza. L’implementazione di produzione restituisce sempre `null`, quindi l’esito è `TRUSTED_CONFIRMATION_UNAVAILABLE` anche con OAuth e argomenti validi. Non esiste una ricevuta inventata, un parametro `confirmed=true` o un interruttore che renda vero il controllo. Un futuro adattatore richiederebbe una verifica separata del client e dell’azione approvata, non soltanto un certificato mTLS che identifica il client.

La transazione atomica impedisce invii concorrenti. Un invio riuscito significa soltanto `submitted`, non che la telefonata sia completata. Timeout ed errori ambigui diventano `unknown` e restano bloccati contro retry e replay. Gli stati e i codici di audit sono consultabili con `get_outbound_status` per gli ID gestiti da MCP.

## Prove e limiti dei test

Il codice di produzione viene provato con configurazione e token OAuth validi: metadati `_meta` di approvazione/elicitation inventati non sbloccano l’API. Un servizio telefonico locale conta separatamente creazioni e approvazioni, permettendo di verificare che i rifiuti non producano invii.

Un secondo Worker **esclusivamente locale ai test** usa una sottoclasse che simula un adattatore fidato. Serve a verificare che, se una componente attendibile esistesse, i controlli di binding, le prenotazioni atomiche, il rate limit, le scadenze e il trattamento dell’esito incerto continuerebbero a funzionare. Non dimostra né abilita tale componente in ChatGPT. La classe e il driver HTTP dei test non sono esportati o inclusi nel Worker pubblicato.

Il contratto dell’API outbound reale non è stato collaudato effettuando chiamate; resta marcato non verificato. Il rilascio conserva i secret separati, l’allowlist vuota e outbound disabilitato. Non modifica il Worker telefonico, Telnyx o le tabelle D1.

## Compatibilità del rilascio solo MCP

Il sorgente della pagina web auth è stato eliminato e la route sorgente restituisce 410. Non si distribuisce auth in questo rilascio. Perciò il suo vecchio codice può ancora rispondere sulla vecchia route, ma ogni suo tentativo RPC viene bloccato dal tombstone `ApprovalServer` del nuovo MCP. Entrambi i metodi legacy sono provati come inerti. Rimuovere fisicamente quel binding/route dall’auth già pubblicato richiederebbe un futuro deployment auth, fuori dal perimetro autorizzato di questo rilascio.

## Rilascio verificato

Pubblicato soltanto `personal-phone-assistant-mcp`, versione `827e5866-1c6a-413d-b65a-ab6705fdbd30`. I 13 test locali e le build passano. Il bundle effettivo non contiene `installTestReceipt`, `expireTestRequest`, lo storage di prova o generatori di URL di approvazione; il suo adattatore di consenso restituisce `null`.

Dopo il deployment sono stati verificati i blocchi HTTP per richieste anonime/token invalidi, la discovery OAuth invariata, le versioni invariate di auth e del Worker telefonico e le variabili operative: outbound disabilitato, contratto non verificato, allowlist vuota e quota 5/ora. Non sono state effettuate chiamate reali. Il rapporto con soli esiti tecnici è in [outbound-release-verification.json](outbound-release-verification.json). Non è stato richiesto un nuovo login privato o un consenso umano reale ai fini di questo rilascio, perché nessun test dal vivo tenta di eseguire chiamate.
