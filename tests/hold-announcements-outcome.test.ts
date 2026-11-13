import { afterEach, expect, it } from "vitest";
const { createOfflineVoiceFixture } = await import(
  new URL("../scripts/offline-voice-fixture.mjs", import.meta.url).href
);
const { holdReturnText, outcomeSources } = await import(
  new URL("../scripts/jp-recipient-evidence.mjs", import.meta.url).href
);
const { validateExtraction, sourceTurns } = await import(
  new URL("../workers/notifications/src/summary.mjs", import.meta.url).href
);
const fixtures: any[] = [];
afterEach(async () => {
  for (const f of fixtures.splice(0)) await f.cleanup();
});
const ads = [
  "インターネットットコムでは料金の在庫状況をお店ごとに 地続きで待たずに変える。店舗受取サービスもぜひご利用ください。",
  "在庫のある商品を三十店以内にご用意いたします。",
  "ヨドバシカメラのインターネット通販サイト、ヨドバシドットコムでは商品の在庫状況をお店ごとにリアルタイムでお知らせしております。",
  "本日もヨドバシカメラにお電話いただきまして誠にありがとうございます。",
  "お電話ありがとうございます。アップル川崎です。",
  "最高",
  "本日も",
  "大変お待たせしております。",
];
const count = (f: any, action: string) =>
  f.network.filter((x: any) => x.url.endsWith("/" + action)).length;
async function held(routing = false) {
  const f = await createOfflineVoiceFixture();
  fixtures.push(f);
  await f.recipient("もしもし。ご用件をお伺いします。");
  if (routing) {
    f.b.context.ivr_progress = {
      state: "awaiting_transition",
      command_id: "mock",
      baseline: "その他のご質問は五を押してください。",
      deadline: f.now() + 45000,
    };
    f.b.observeRoutingInterim("ただいまお電話をおつなぎしております。");
  } else await f.recipient("はい、少々お待ちくださいませ。");
  return f;
}
it.each([
  [false, false],
  [false, true],
  [true, false],
  [true, true],
])(
  "replays the whole recorded sequence without releasing or renewing the hold (routing=%s, Flux=%s)",
  async (routing, flux) => {
    const f = await held(routing),
      deadline = f.b.controller.hold.deadline;
    const before = f.b.voice.frames.filter(
      (x: any) => x.item?.role === "user",
    ).length;
    for (const [index, text] of ads.entries()) {
      f.advance(2000);
      f.b.turns.accept(
        flux
          ? {
              type: "TurnInfo",
              turn_index: index,
              event: "Update",
              transcript: text,
            }
          : { transcript: text, is_final: false },
      );
      f.b.turns.accept(
        flux
          ? {
              type: "TurnInfo",
              turn_index: index,
              event: "EndOfTurn",
              transcript: text,
            }
          : {
              transcript: text,
              is_final: true,
              speech_final: true,
            },
      );
      await Promise.all(f.jobs.splice(0));
      expect(f.b.controller.hold?.deadline, text).toBe(deadline);
      await f.b.checkDialogue();
      const result = await f.b.controller.command(
        crypto.randomUUID(),
        "finish_call_after_goodbye",
        { outcome: "confirmed" },
      );
      expect(result.ok, text).toBe(false);
    }
    expect(
      f.b.voice.frames.filter((x: any) => x.item?.role === "user"),
    ).toHaveLength(before);
    expect(count(f, "speak")).toBe(0);
    expect(count(f, "hangup")).toBe(0);
  },
);
it.each([
  "お待たせいたしました。",
  "電話代わりました。携帯コーナーの担当と申します。",
  "もしもし。",
  "どの端末をお探しですか？",
  "在庫はございません。",
  "明日の午後なら空いています。",
])("resumes an actual recipient return during hold: %s", async (text) => {
  const f = await held(true);
  await f.recipient(text);
  f.advance(800);
  expect(f.b.controller.hold).toBeNull();
  expect(f.b.routingWait()).toBe(false);
  await f.generate("real-reply", "次回の入荷予定は分かりますか。");
  expect(f.frames().length).toBeGreaterThan(0);
});
it("handles a merged recording and staff return without forwarding the advertisement", async () => {
  const f = await held();
  await f.recipient(ads[1] + "もしもし。お待たせしました。在庫がありません。");
  expect(f.b.controller.hold).toBeNull();
  const last = f.b.voice.frames
    .filter((x: any) => x.item?.role === "user")
    .at(-1).item.content[0].text;
  expect(last).toContain("在庫がありません");
  expect(last).not.toContain("三十店");
});
it("keeps the original bounded deadline through repeated advertisements and requires completed farewell before timeout hangup", async () => {
  const f = await held(),
    deadline = f.b.controller.hold.deadline;
  for (let i = 0; i < 8; i++) {
    f.advance(10000);
    await f.recipient(ads[i]);
  }
  expect(f.b.controller.hold.deadline).toBe(deadline);
  f.advance(10000);
  await f.b.checkDialogue();
  await f.b.checkDialogue();
  expect(count(f, "speak")).toBe(1);
  expect(count(f, "hangup")).toBe(0);
  await f.b.onWebhook({
    id: crypto.randomUUID(),
    event_type: "call.speak.ended",
    payload: {
      connection_id: f.b.env.VOICE_APP_ID,
      call_control_id: "mock-call",
      client_state: f.b.context.controlled_closing.state,
      status: "completed",
    },
  });
  f.advance(250);
  await f.b.checkDialogue();
  expect(count(f, "hangup")).toBe(1);
});
it("records a model confirmation separately from the effective unverified closure", async () => {
  const f = await createOfflineVoiceFixture();
  fixtures.push(f);
  await f.recipient("もしもし。");
  f.advance(800);
  await f.generate("stock-question", "在庫はありますか。");
  f.advance(250);
  for (const name of [...f.b.marks.pending.keys()]) f.b.marks.acknowledge(name);
  await f.recipient("在庫はございます。");
  f.advance(1000);
  await f.b.onVoice({
    type: "conversation.item.created",
    item: {
      type: "function_call",
      call_id: "model-claim",
      name: "finish_call_after_goodbye",
      arguments: JSON.stringify({ outcome: "confirmed" }),
    },
  });
  expect(f.b.context.model_requested_outcome).toBe("confirmed");
  expect(f.b.controller.pending.outcome).toBe("unspecified");
  const output = JSON.parse(
    f.b.voice.frames
      .filter((x: any) => x.item?.type === "function_call_output")
      .at(-1).item.output,
  );
  expect(output.requested_outcome).toBe("confirmed");
  expect(output.effective_outcome).toBe("unspecified");
});

function extraction(id: string, quote: string) {
  return {
    counterpart: null,
    title_it: "Disponibilità confermata",
    task_outcome: "successful",
    summary_it:
      "Il negozio ha confermato la disponibilità del prodotto richiesto e la possibilità di acquistarlo subito senza prenotazione. La variante indicata sarebbe presente in negozio e pronta per il ritiro. Non risultano pagamenti richiesti né ulteriori condizioni. L’assistente considera la richiesta completata e non indica altre azioni necessarie.",
    outcome_evidence: [{ source_id: id, quote }],
    confirmed_facts: [
      {
        text_it: "Il prodotto è disponibile.",
        evidence: [{ source_id: id, quote }],
      },
    ],
    uncertainties: [],
    next_action: null,
  };
}
it.each([
  ...ads,
  "はい、ありがとうございます。",
  "少々お待ちくださいませ。",
  "こちらは代表番号です。担当におつなぎします。",
])(
  "rejects the entire positive summary grounded only in non-answer text: %s",
  (text) => {
    const s = sourceTurns([
      { id: "wait", role: "user", text: "少々お待ちください。" },
      { id: "ad", role: "user", text },
    ]);
    const x = validateExtraction(extraction("ad", text), s);
    expect(x.task_outcome).toBe("unresolved");
    expect(x.title_it).not.toContain("confermata");
    expect(x.summary_it).not.toContain("ha confermato");
    expect(x.confirmed_facts).toEqual([]);
  },
);
it("prevents laundering a short stock-sounding quote from a recorded source", () => {
  const text = "在庫がございます。店舗受取サービスもぜひご利用ください。";
  const x = validateExtraction(
    extraction("ad", "在庫がございます。"),
    sourceTurns([{ id: "ad", role: "user", text }]),
  );
  expect(x.task_outcome).toBe("unresolved");
});
it("does not turn a real negative answer into a positive stock claim", () => {
  const text = "在庫がありません。入荷日は未定です。";
  const x = validateExtraction(
    extraction("answer", text),
    sourceTurns([{ id: "answer", role: "user", text }]),
  );
  expect(x.task_outcome).toBe("unresolved");
  expect(x.confirmed_facts).toEqual([]);
});
it("does not reuse a stock answer as confirmation of walk-in conditions", () => {
  const text = "在庫がございます。";
  const x = validateExtraction(
    extraction("answer", text),
    sourceTurns([{ id: "answer", role: "user", text }]),
  );
  expect(x.task_outcome).toBe("unresolved");
  expect(x.confirmed_facts).toEqual([]);
});
it("allows a genuine stock answer, preserving an actual quote after a mixed return", () => {
  const text = ads[1] + "もしもし。お待たせしました。在庫がございます。";
  const s = sourceTurns([
    { id: "hold", role: "user", text: "少々お待ちください。" },
    { id: "answer", role: "user", text },
  ]);
  const raw = extraction("answer", "在庫がございます。");
  raw.summary_it =
    "Il negozio riferisce che il prodotto richiesto è disponibile. La risposta è stata fornita dal destinatario alla domanda sulla disponibilità. Non risultano dettagli verificati sulle modalità di acquisto, sui tempi di riassortimento o su eventuali prenotazioni. Questi aspetti restano da chiarire e non vengono considerati confermati.";
  const x = validateExtraction(raw, s);
  expect(x.task_outcome).toBe("successful");
  expect(outcomeSources(s).get("answer")).not.toContain("三十店");
  expect(holdReturnText("『もしもし』と再生されます。")).toBeNull();
  expect(
    holdReturnText("インターネットで在庫確認できましたらご利用ください。"),
  ).toBeNull();
});
