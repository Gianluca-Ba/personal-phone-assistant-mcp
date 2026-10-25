# Policy delle destinazioni outbound

## Modalità esplicite

`OUTBOUND_DESTINATION_POLICY=all_standard` è attiva su MCP. Non occorre inserire ogni nuovo numero nella allowlist. La validazione usa `libphonenumber-js/max` (versione esatta nel lockfile), con metadati completi dei piani nazionali e delle categorie. Il numero deve essere già E.164 canonico: `+`, codice internazionale e cifre, massimo 15 cifre, senza spazi, estensioni, prefissi di accesso o normalizzazioni implicite. I numeri brevi non vengono scambiati per normali destinatari internazionali.

Sono consentite le categorie riconosciute `MOBILE`, `FIXED_LINE`, `FIXED_LINE_OR_MOBILE` e `VOIP`. Categorie premium, toll-free, shared-cost, personal-number, pager, UAN, voicemail, categorie sconosciute e codici brevi/emergenza sono esclusi. Una regex E.164 da sola non è sufficiente a ottenere il permesso.

`OUTBOUND_DESTINATION_POLICY=allowlist` conserva la modalità precedente: appartenenza esatta alla lista, precedenza del Secret privato sulla variabile pubblica e default vuoto che nega tutto. Se la nuova variabile non è impostata, il default resta `allowlist`, per non ampliare accidentalmente configurazioni precedenti. In questa modalità si mantiene anche il precedente limite sintattico minimo; non vengono introdotte nuove restrizioni di categoria sulle destinazioni esplicitamente autorizzate dalla lista.

**In `all_standard` non viene letto né interpretato `OUTBOUND_ALLOWED_DESTINATIONS_SECRET`.** Non può prevalere sulla nuova modalità, nemmeno se la vecchia lista contiene un solo numero o un valore JSON errato. Il Secret resta conservato per un eventuale ritorno alla modalità restrittiva. `OUTBOUND_PRIVATE_ALLOWLIST_CONFIGURED` è irrilevante in `all_standard`.

## Restrizioni configurabili

| Variabile MCP                   | Formato                                                     | Effetto                                                                                                                     |
| ------------------------------- | ----------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| `OUTBOUND_BLOCKED_PREFIXES`     | Array JSON di prefissi E.164, ad esempio `["+44","+81364"]` | Blocca Paesi, aree o range completi con corrispondenza iniziale                                                             |
| `OUTBOUND_BLOCKED_DESTINATIONS` | Array JSON di numeri esatti                                 | Blocca destinatari specifici, incluse eventuali numerazioni di servizio da escludere localmente                             |
| `OUTBOUND_BLOCKED_NUMBER_TYPES` | Array JSON di categorie note                                | Aggiunge restrizioni alle categorie standard, ad esempio `["VOIP"]`; non permette di riabilitare categorie speciali/premium |

Il default dei prefissi è `["+870","+878","+881","+882","+883","+979"]`, una scelta conservativa per servizi internazionali/non geografici e ad alto costo potenziale. È una policy dell’applicazione, **non una lista ufficiale Telnyx aggiornata di tutte le destinazioni a rischio**. Per ulteriori Paesi o prefissi ad alto rischio aggiungerli all’array. Impostare un array esplicito sostituisce il default: conservare i blocchi desiderati quando lo si modifica. Le altre due liste hanno default vuoto. Non inserire numeri personali in configurazione pubblica: se occorrono esclusioni private, rimuovere la relativa variabile dai `vars` pubblici Wrangler e impostarla come Secret nella dashboard senza pubblicarne il valore.

Configurazioni sconosciute, JSON malformato, prefissi vuoti o categorie inesistenti negano l’operazione (`INVALID_DESTINATION_POLICY`). Anche il preflight rifiuta queste configurazioni prima del deployment. Le liste hanno massimo 1000 elementi. Nessun blocco configurato può trasformare una categoria premium/speciale in una standard.

## Limiti della validazione e del servizio esistente

I metadati descrivono piani di numerazione e categorie, non esistenza, raggiungibilità, portabilità o tariffa effettiva di una linea. Non costituiscono una verifica tariffaria in tempo reale né una garanzia di intercettare ogni range fraudolento futuro. La versione dei metadati è fissata per build riproducibili e va aggiornata periodicamente. Le restrizioni per numero/prefisso permettono di integrare rapidamente esclusioni locali o del gestore.

Resta inoltre un limite indipendente, verificato sul sorgente telefonico esistente: **`validOutboundNumber` ammette soltanto Giappone, Italia e numerazioni NANP (`+1`)**, con propri controlli su lunghezze e prefissi. MCP può ora ammettere numeri standard di altri Paesi, ma il Worker telefonico attuale li rifiuta prima della creazione. Non si può garantire l’intera copertura internazionale Telnyx senza estendere anche quel contratto. In questo intervento il Worker telefonico non viene modificato.

Restano applicabili le [destinazioni e i limiti dell’Outbound Voice Profile Telnyx](https://support.telnyx.com/en/articles/4320411-more-about-outbound-voice-profiles). Non sono stati modificati né consultati i Secret Telnyx e non viene dichiarato che tutte le destinazioni ammesse da MCP siano abilitate sull’account.

## Controlli invariati e collaudo

La policy viene verificata prima della creazione e di nuovo sul record D1 prima dell’approvazione. Un numero diventato vietato dopo la creazione non può essere eseguito. OAuth `calls:write`/`calls:execute`, identità, snapshot immutabile, nonce, digest, scadenza, quota, idempotenza, anti-replay e prenotazione atomica restano invariati. La conferma specifica nella conversazione resta una regola operativa di ChatGPT, non una prova indipendente verificata dal server.

I test includono mobili e fissi giapponesi, VoIP, numeri internazionali standard, numeri validi corti, premium, servizi speciali, emergenza, sintassi non canonica, blocchi per Paese/range/numero/categoria, compatibilità della allowlist e Secret legacy ignorati in `all_standard`. I test di integrazione preparano richieste nel mock, verificando `pending_approval`, `authorized_at=NULL` e `telnyx_call_id=NULL`, senza approvazioni o chiamate. Restano i test OAuth, scadenza, concorrenza e anti-replay.

Si distribuisce solo MCP. Il collaudo live autorizzato riguarda esclusivamente `create_outbound_request` per il fisso giapponese richiesto e una successiva lettura D1. Non deve essere invocato `approve_outbound_request` né contattato Telnyx.

## Rapporto di rilascio — 25 ottobre 2026 (Asia/Tokyo)

- Distribuito esclusivamente MCP: `257aebd5-e31c-4cd4-bbea-98927f81a763`, policy `all_standard`, vecchio Secret della allowlist conservato e ignorato dal nuovo ramo.
- Typecheck, 54 test automatici e build superati; audit dipendenze di produzione senza vulnerabilità rilevate.
- Collaudo live: una nuova richiesta al fisso giapponese indicato dal proprietario ha raggiunto `pending_approval`. Query D1 in sola lettura conferma `authorized_at=NULL` e `telnyx_call_id=NULL`. Nessuna approvazione invocata, nessuna telefonata effettuata dall’intervento. Non si tratta di un collaudo di raggiungibilità o tariffa Telnyx.
- Auth invariato: `46bb7692-8e9b-49eb-90c1-0061bfdc690d`. Worker telefonico invariato: `e21a07d0-b52a-4832-bb41-54b18f85a1ae`. Nessuna modifica Telnyx o alle tabelle D1.
- Limite residuo: la copertura globale ammessa dalla policy MCP resta limitata dai controlli JP/IT/NANP del Worker telefonico e dai permessi di destinazione del profilo Telnyx. Non sono stati aggirati.
