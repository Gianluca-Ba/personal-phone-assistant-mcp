// Runs the actual bridge in workerd. No external fetch is ever issued.
import { createTestHarness } from "wrangler";
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from "node:fs";
import { resolve, join } from "node:path";
import assert from "node:assert/strict";
mkdirSync(".wrangler", { recursive: true });
const dir = mkdtempSync(resolve(".wrangler/voice-edge-check-"));
writeFileSync(
  join(dir, "edge.mjs"),
  `
import {VoiceBridge} from ${JSON.stringify(resolve("workers/voice/src/bridge.mjs"))};
class Memory{data=new Map();async get(k){return this.data.get(k)}async put(k,v){this.data.set(k,v)}}
export default{async fetch(req){const mode=new URL(req.url).pathname;const calls=[],sockets=[];
const row={id:crypto.randomUUID(),status:'dialing',callback_token:crypto.randomUUID(),destination_number:'+819022222222',language:'ja',instructions:'Offline test; never dial.'};
const env={PREWARM_BEFORE_DIAL:'true',EXTERNAL_STT:'true',OUTBOUND_ASSISTANT_ID:'offline',OUTBOUND_ASSISTANT_VERSION:'version',TELNYX_API_KEY:'offline-only-key',VOICE_ORIGIN:'https://offline.invalid',VOICE_APP_ID:'123456',OUTBOUND_FROM:'+819011111111',DB:{prepare:()=>({bind:()=>({first:async()=>row})})}};
const b=new VoiceBridge(new Memory(),env,{providerFetch:async(url,options={})=>{
// Constructing Request here exercises workerd validation, unlike a Node fetch mock.
new Request(url,options);
if(options.redirect!=='manual')throw Error('NON_MANUAL_REDIRECT');
const u=new URL(url);if(u.pathname.startsWith('/v2/calls'))throw Error('DIAL_FORBIDDEN');
calls.push({path:u.pathname,method:options.method??'GET'});
if(u.pathname==='/v2/ai/assistants/offline')return mode==='/redirect'?new Response(null,{status:302,headers:{Location:'https://forbidden.invalid'}}):Response.json({version_id:'version',greeting:'',tools:[]});
if(options.headers?.Upgrade){const [client,server]=Object.values(new WebSocketPair());server.accept();sockets.push(server);if(u.pathname.endsWith('/conversation'))setTimeout(()=>server.send(JSON.stringify({type:'session.created',session:{conversation_id:'offline-conversation',audio:{input:{format:{rate:8000}},output:{format:{rate:24000}}}}})),20);return new Response(null,{status:101,webSocket:client})}
if(u.pathname==='/v2/ai/conversations/offline-conversation'&&options.method==='PUT')return Response.json({data:{}});
throw Error('NETWORK_FORBIDDEN');
}});
try{const r=await b.register({request_id:row.id,callback_token:row.callback_token,destination:row.destination_number,from:env.OUTBOUND_FROM});return Response.json({status:r.status,ready:!!b.voiceReady,calls})}catch(e){return Response.json({error:e.message,calls})}finally{b.ended=true;b.cleanup();for(const ws of sockets)try{ws.close()}catch{}}}}
`,
);
const harness = createTestHarness({
  workers: [
    {
      config: {
        name: "offline-voice-edge",
        main: join(dir, "edge.mjs"),
        compatibility_date: "2026-10-01",
        compatibility_flags: ["nodejs_compat"],
      },
    },
  ],
});
try {
  await harness.listen();
  const worker = harness.getWorker("offline-voice-edge");
  const success = await (
    await worker.fetch("https://offline.invalid/success")
  ).json();
  assert.equal(success.status, 200);
  assert.equal(success.ready, true);
  assert.equal(success.calls.length, 4);
  assert.equal(
    success.calls.some((c) => c.path.startsWith("/v2/calls")),
    false,
  );
  const redirect = await (
    await worker.fetch("https://offline.invalid/redirect")
  ).json();
  assert.equal(redirect.error, "Assistant preflight failed");
  assert.equal(redirect.calls.length, 1);
  console.log(
    JSON.stringify({
      checks: 6,
      passed: true,
      runtime: "workerd",
      external_network: "never invoked",
      real_calls: 0,
    }),
  );
} finally {
  await harness.close();
  rmSync(dir, { recursive: true, force: true });
}
