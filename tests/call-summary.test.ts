import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { createHash } from "node:crypto";
const {
  buildSummary,
  renderSummary,
  sourceTurns,
  validateTranslation,
  validateExtraction,
  utc,
  jst,
} = await import(
  new URL("../workers/notifications/src/summary.mjs", import.meta.url).href
);
const { fetchConversation, validateAcknowledgement } = await import(
  new URL("../workers/notifications/src/provider.mjs", import.meta.url).href
);
const { patchPhoneSummary } = await import(
  new URL("../scripts/patch-phone-summary.mjs", import.meta.url).href
);
const row = {
  call_id: "fixture-call-0001",
  direction: "outbound",
  status: "completed",
  created_at: "2026-10-25 08:26:48",
  duration_seconds: 299,
  summary_it: "Operatore non raggiunto. Nessuna informazione ottenuta.",
};
const messages = [
  {
    id: "a",
    role: "assistant",
    text: "予約なしで買えますか。",
    sent_at: "2026-10-25T08:26:49Z",
  },
  {
    id: "b",
    role: "user",
    text: "在庫がありません。入荷日は未定です。",
    sent_at: "2026-10-25T08:26:50Z",
  },
];
const sources = sourceTurns(messages);
const ev = [{ source_id: "b", quote: messages[1].text }];
const extracted = {
  counterpart: null,
  title_it: "Nessuna data di riassortimento",
  summary_it:
    "Il negozio non dispone del prodotto richiesto. Non è stata indicata una data di riassortimento. La domanda sulla disponibilità ha ricevuto risposta, ma non è possibile stabilire quando si potrà acquistare il prodotto senza prenotazione. Non sono stati presi impegni né effettuati ordini o prenotazioni.",
  task_outcome: "partially_successful",
  outcome_evidence: ev,
  confirmed_facts: [
    { text_it: "Prodotto esaurito.", evidence: ev },
    { text_it: "Prodotto esaurito", evidence: ev },
  ],
  next_action: null,
  uncertainties: [],
};
const translations = {
  turns: [
    {
      source_id: "a",
      original: messages[0].text,
      speaker: "AI Assistant",
      english: "Can I buy it without a reservation?",
    },
    {
      source_id: "b",
      original: messages[1].text,
      speaker: "Store Employee",
      english: "It is out of stock. The restock date is unknown.",
    },
  ],
};
const translateUnit = (input: any) => {
  const t = translations.turns.find((t) => t.source_id === input.source_id)!;
  return { speaker: t.speaker, english: t.english };
};
const infer = async (system: string, input: any) =>
  system.includes("Translate EVERY")
    ? translateUnit(input)
    : structuredClone(extracted);
describe("Call Summary v2", () => {
  it("separates completed carrier from unsuccessful task", async () => {
    const s = await buildSummary(row, [], {});
    expect(s.task_outcome).toBe("unresolved");
    expect(s.technical_outcome).toBe("completed");
    expect(renderSummary(s).html).toContain("Full transcript unavailable");
  });
  it("extracts partial result, deduplicates facts and translates Japanese chronologically", async () => {
    const s = await buildSummary(row, [...messages].reverse(), {
      infer,
      complete: true,
    });
    expect(s.confirmed_facts).toHaveLength(1);
    expect(s.task_outcome).toBe("partially_successful");
    expect(s.transcript.turns[0].english).toBe(translations.turns[0].english);
    const e = renderSummary(s);
    expect(e.html).not.toContain(messages[0].text);
    expect(e.html).toContain("English Translation");
    expect(e.text).toContain("AI Assistant:");
    expect(e.subject).toContain("Nessuna data");
  });
  it("allows actual successful answers with remote evidence", async () => {
    const s = await buildSummary(row, messages, {
      infer: async (system: string, input: any) =>
        system.includes("Translate EVERY")
          ? translateUnit(input)
          : { ...extracted, task_outcome: "successful" },
      complete: true,
    });
    expect(s.task_outcome).toBe("successful");
  });
  it("technical failure cannot become task success", async () => {
    const s = await buildSummary({ ...row, status: "failed" }, messages, {
      infer,
    });
    expect(s.task_outcome).toBe("failed");
  });
  it("IVR/no employee never implies success from technical completion", () => {
    const x = validateExtraction(
      {
        ...extracted,
        task_outcome: "successful",
        outcome_evidence: [{ source_id: "a", quote: messages[0].text }],
      },
      sources,
    );
    expect(x.task_outcome).toBe("unresolved");
  });
  it("removes ungrounded facts, identities and next actions", () => {
    const forged = [{ source_id: "b", quote: "invented" }];
    const s = validateExtraction(
      {
        ...extracted,
        counterpart: { name: "Someone", evidence: forged },
        confirmed_facts: [{ text_it: "invented", evidence: forged }],
        next_action: { text_it: "Call tomorrow", evidence: forged },
      },
      sources,
    );
    expect(s.counterpart).toBeNull();
    expect(s.confirmed_facts).toEqual([]);
    expect(s.next_action).toBeNull();
  });
  it("rejects fabricated or omitted turns and unsupported system events", () => {
    expect(() => validateTranslation({ turns: [] }, sources)).toThrow();
    expect(() =>
      validateTranslation(
        {
          turns: translations.turns.map((t) => ({
            ...t,
            english: "[Transferred]",
          })),
        },
        sources,
      ),
    ).toThrow();
    expect(() =>
      validateTranslation(
        {
          turns: [
            ...translations.turns,
            { ...translations.turns[1], source_id: "new" },
          ],
        },
        sources,
      ),
    ).toThrow();
  });
  it("shows partial excerpts honestly", async () => {
    const s = await buildSummary(row, messages, { infer, complete: false });
    expect(s.transcript.availability).toBe("partial");
    expect(renderSummary(s).html).toContain("Available conversation excerpts");
  });
  it("normalizes SQLite UTC to JST, including day rollover", () => {
    expect(utc("2026-10-25 08:26:48")).toBe("2026-10-25T08:26:48.000Z");
    expect(jst("2026-10-25 08:26:48")).toContain("17:26");
    expect(jst("2026-10-25T18:30:00Z")).toContain("26/10/2026");
    expect(utc("no date")).toBeNull();
  });
  it("uses email tables, inline styles, no original instructions or active content", async () => {
    const s = await buildSummary(
      { ...row, instructions: "SECRET TASK" },
      messages,
      { infer },
    );
    s.summary_it = "<script>alert(1)</script><img src=x onerror=alert(2)>";
    const e = renderSummary(s, { test: true });
    expect(e.subject).toContain("TEST — Call Summary v2");
    expect(e.html).toContain('role="presentation"');
    expect(e.html).toContain("max-width:600px");
    expect(e.html).not.toContain("<script>");
    expect(e.html).toContain("&lt;script&gt;");
    expect(e.html).not.toContain("SECRET TASK");
    expect(e.html).not.toContain("Prossima azione");
    expect(e.html).not.toContain("<link");
  });
  it("paginates without claiming incomplete data is complete", async () => {
    let count = 0;
    const f = async () => {
      count++;
      return Response.json({ data: messages, meta: { total_pages: 2 } });
    };
    const x = await fetchConversation(
      { TELNYX_API_KEY: "test" },
      "00000000-0000-4000-8000-000000000000",
      f,
    );
    expect(count).toBe(2);
    expect(x.complete).toBe(true);
    expect(
      (
        await fetchConversation(
          {},
          "00000000-0000-4000-8000-000000000000",
          async () => Response.json({ data: messages }),
        )
      ).complete,
    ).toBe(false);
  });
  it("rejects old delivery ack so legacy HTML cannot masquerade as v2", () => {
    expect(() => validateAcknowledgement({ ok: true }, "id")).toThrow();
    expect(() =>
      validateAcknowledgement({ ok: true, version: 2, call_id: "id" }, "id"),
    ).not.toThrow();
  });
});

function gasHarness() {
  const props = new Map<string, string>(),
    sent: any[] = [];
  let locked = false,
    fail = false;
  const context = {
    RECIPIENT: "owner@example.test",
    APP_NAME: "Test",
    reply: (x: any) => x,
    PropertiesService: {},
    MailApp: {
      sendEmail: (x: any) => {
        sent.push(x);
        if (fail) throw Error("uncertain");
      },
    },
    Utilities: {
      DigestAlgorithm: { SHA_256: "sha256" },
      Charset: { UTF_8: "utf8" },
      computeDigest: (_: any, id: string) => [
        ...createHash("sha256").update(id).digest(),
      ],
    },
    LockService: {
      getScriptLock: () => ({
        waitLock: () => {
          if (locked) throw Error("busy");
          locked = true;
        },
        hasLock: () => locked,
        releaseLock: () => {
          locked = false;
        },
      }),
    },
  };
  vm.createContext(context);
  vm.runInContext(readFileSync("apps-script/summary-v2.gs", "utf8"), context);
  return {
    props,
    sent,
    fail: () => {
      fail = true;
    },
    send: (d: any) =>
      (context as any).handleSummaryV2(d, {
        getProperty: (k: string) => props.get(k),
        setProperty: (k: string, v: string) => props.set(k, v),
      }),
  };
}
describe("Notification delivery deduplication", () => {
  it("sends once per call, permits distinct calls and preserves owner recipient", async () => {
    const g = gasHarness(),
      p = renderSummary(await buildSummary(row, [], {}));
    expect(g.send(p).sent).toBe(true);
    expect(g.send(p).duplicate).toBe(true);
    g.send({
      ...p,
      call_id: "fixture-call-0002",
      idempotency_key: "call-summary-v2:fixture-call-0002",
    });
    expect(g.sent).toHaveLength(2);
    expect(g.sent[0].to).toBe("owner@example.test");
  });
  it("never retries an uncertain MailApp result", async () => {
    const g = gasHarness(),
      p = renderSummary(await buildSummary(row, [], {}));
    g.fail();
    expect(g.send(p).ok).toBe(false);
    expect(g.send(p).error).toBe("delivery_outcome_unknown");
    expect(g.sent).toHaveLength(1);
  });
  it("rejects hostile HTML and subject header injection", async () => {
    const g = gasHarness(),
      p = renderSummary(await buildSummary(row, [], {}));
    expect(g.send({ ...p, html: "<!doctype html><script>x</script>" }).ok).toBe(
      false,
    );
    expect(g.send({ ...p, subject: "x\nBcc: bad" }).ok).toBe(false);
    expect(g.sent).toHaveLength(0);
  });
});

describe("Notification-only integration boundary", () => {
  it("patches only report data, renderer and cron dispatch; leaves protected code byte-identical", () => {
    const fixture = readFileSync(
      "tests/fixtures/phone-notifications.original.mjs",
      "utf8",
    );
    const prefix = "// SIGNATURE AND INBOUND ROUTES UNCHANGED\n",
      suffix =
        '\nasync function approveOutboundRequest(){return "UNMODIFIED DTMF AND AUTH"}';
    const original = prefix + fixture + suffix;
    const p = patchPhoneSummary(original, "./provider.mjs");
    expect(p.source).toContain(prefix);
    expect(p.source.endsWith(suffix)).toBe(true);
    expect(p.source).toContain(
      "outcome.summaryPresent && env.CALL_SUMMARY_FORMAT !== 'v2'",
    );
    expect(p.source).toContain("validateAcknowledgement");
    expect(() => patchPhoneSummary(p.source, "./provider.mjs")).toThrow();
    expect(() => patchPhoneSummary("changed", "./provider.mjs")).toThrow();
  });
  it("retains inbound/outbound classification independently of language", async () => {
    for (const direction of ["inbound", "outbound"]) {
      const s = await buildSummary({ ...row, direction }, messages, { infer });
      expect(s.direction).toBe(direction);
      expect(s.transcript.turns).toHaveLength(2);
    }
  });
});

describe("Real minimal excerpts from 25 October (not reconstructed transcripts)", () => {
  const fixtures = JSON.parse(
    readFileSync("tests/fixtures/call-summary-real-excerpts.json", "utf8"),
  );
  for (const fixture of fixtures)
    it(fixture.case, async () => {
      const src = { id: "excerpt", role: "user", text: fixture.japanese };
      const s = await buildSummary(row, [src], {
        complete: false,
        infer: async (system: string, input: any) => {
          if (system.includes("Translate EVERY")) {
            // Apple options are translated individually by the real pipeline.
            if (input.text !== fixture.japanese) {
              const options = sourceTurns([src])[0].menu_options;
              const i = options.findIndex((x: any) => x.text === input.text);
              return {
                speaker: "IVR",
                english: fixture.english.split("\n")[i + 1].split(" — ")[1],
              };
            }
            return { speaker: "Other Party", english: fixture.english };
          }
          return {
            ...extracted,
            task_outcome: fixture.expected_task,
            outcome_evidence: [
              { source_id: "excerpt", quote: fixture.japanese },
            ],
            confirmed_facts: [],
            next_action: null,
          };
        },
      });
      expect(s.task_outcome).toBe(fixture.expected_task);
      expect(s.transcript.availability).toBe("partial");
      expect(s.transcript.turns[0].english).toBe(fixture.english);
      expect(renderSummary(s).html).not.toContain(fixture.japanese);
    });
  it("includes supported system events, excludes system prompts", async () => {
    const s = await buildSummary(
      row,
      [
        { role: "system", text: "[long silence]" },
        { role: "system", text: "DO NOT INCLUDE PRIVATE INSTRUCTIONS" },
      ],
      { infer: async () => extracted },
    );
    expect(s.transcript.turns).toEqual([
      expect.objectContaining({
        speaker: "System Event",
        english: "[Silence]",
      }),
    ]);
  });
});

describe("Worker notification transaction", () => {
  async function sender() {
    const source = patchPhoneSummary(
      readFileSync("tests/fixtures/phone-notifications.original.mjs", "utf8"),
      "./provider.mjs",
    ).source.replace(/^import[^\n]+\n/, "");
    const states = new Map<string, string>(),
      delivered: any[] = [];
    const ctx: any = {
      crypto,
      URL,
      console: { log() {}, error() {} },
      MAX_PER_RUN: 5,
      safeError: (e: Error) => e.name,
      prepareNotification: async (_: any, r: any) => ({
        ...renderSummary(await buildSummary(r, [], {})),
        text: "Clean report",
        html: "<!doctype html><p>Clean report</p>",
      }),
      validateAcknowledgement,
      fetch: async (_: any, init: any) => {
        const data = JSON.parse(init.body);
        delivered.push(data);
        return Response.json({ ok: true, version: 2, call_id: data.call_id });
      },
    };
    vm.createContext(ctx);
    vm.runInContext(source, ctx);
    const db = {
      prepare: (sql: string) => ({
        bind: (id: string) => ({
          run: async () => {
            if (sql.includes("notification_status='sending'")) {
              if (states.has(id)) return { meta: { changes: 0 } };
              states.set(id, "sending");
              return { meta: { changes: 1 } };
            }
            states.set(id, "sent");
            return { meta: { changes: 1 } };
          },
          first: async () => ({ n: 1 }),
        }),
      }),
    };
    return {
      ctx,
      delivered,
      send: (r: any) =>
        ctx.sendOne(
          {
            CALL_SUMMARY_FORMAT: "v2",
            APPS_SCRIPT_URL: "https://script.google.com/macros/s/test/exec",
            NOTIFICATION_SECRET: "private-secret",
          },
          db,
          r,
        ),
    };
  }
  it("atomic claim permits exactly one concurrent delivery, without original instructions", async () => {
    const s = await sender();
    const r = {
      ...row,
      id: "summary-a",
      outbound_request_id: "request-a",
      instructions: "PRIVATE TASK",
      outbound_status: "completed",
    };
    expect(await Promise.all([s.send(r), s.send(r)])).toEqual([
      "sent",
      "skipped",
    ]);
    expect(s.delivered).toHaveLength(1);
    expect(s.delivered[0].summary).toBe("Clean report");
    expect(JSON.stringify(s.delivered[0])).not.toContain("PRIVATE TASK");
  });
  it("does not fall back to legacy HTML after v2 contract failure", async () => {
    const s = await sender();
    s.ctx.fetch = async () => Response.json({ ok: true });
    expect(await s.send({ ...row, id: "summary-b" })).toBe("pending");
  });
});
