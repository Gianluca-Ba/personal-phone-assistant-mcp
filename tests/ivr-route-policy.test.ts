import { expect, it } from "vitest";
const {
  outboundRoutingPolicy,
  menuOptions,
  routeConstraint,
  RETAIL_ROUTE_DIRECTIVE,
} = await import(new URL("../scripts/jp-ivr-route.mjs", import.meta.url).href);
const { createOfflineVoiceFixture } = await import(
  new URL("../scripts/offline-voice-fixture.mjs", import.meta.url).href
);
const { composeOutboundTask, speechViolation } = await import(
  new URL("../workers/voice/src/spoken-policy.mjs", import.meta.url).href
);
const menu =
  "次の4つの中からご希望の番号を選択してください。営業時間や日順については1をAppleのテクニカルサポートセンターアップルケアに転送するには2を法人のお客様は3をその他のご質問は5を押してください。";
const instructions =
  "Ask personal walk-in phone availability only. No purchases or reservations.\n" +
  RETAIL_ROUTE_DIRECTIVE;
const policy = outboundRoutingPolicy({
  destination: "+81445775100",
  instructions,
});
const fixture = () =>
  createOfflineVoiceFixture({ destination: "+81445775100", instructions });
it("derives the route only from the approved immutable destination/task snapshot", () => {
  expect(policy).toEqual({
    profile: "apple_kawasaki_other_questions_v1",
    digit: "5",
    category: "other_questions",
  });
  expect(
    outboundRoutingPolicy({
      destination: "+81445775100",
      instructions: "Ordinary request",
    }),
  ).toBeNull();
  for (const x of [
    { destination: "+81366701800", instructions },
    {
      destination: "+81445775100",
      instructions: instructions + "\n" + RETAIL_ROUTE_DIRECTIVE,
    },
    {
      destination: "+81445775100",
      instructions: "Menu IVR autorizzato: unknown",
    },
  ])
    expect(() => outboundRoutingPolicy(x)).toThrow(
      "Invalid authorized IVR route",
    );
});
it("maps the observed punctuation-free menu into labels and only authorizes other questions 5", () => {
  expect(menuOptions(menu).map((o: any) => o.digit)).toEqual([
    "1",
    "2",
    "3",
    "5",
  ]);
  expect(menuOptions(menu).find((o: any) => o.digit === "3").label).toBe(
    "法人のお客様は",
  );
  expect(routeConstraint(menu, policy).authorized_digits).toEqual(["5"]);
});
it.each([
  menu.replace("5を", "五を"),
  menu.replace("5を", "５を"),
  menu.replace("その他のご質問は", "その他のお問い合わせについては"),
  menu.replace("5を", "5番を"),
])(
  "retains the announced label/digit mapping through supported recognition variants",
  (s) => {
    expect(routeConstraint(s, policy).authorized_digits).toEqual(["5"]);
  },
);
it.each([
  menu.replace("その他のご質問は5を", "その他のご質問は4を"),
  menu.replace("その他のご質問は5を", "法人のお客様は5を"),
  menu.replace("その他のご質問は5を", "クレジットカードのお支払いは5を"),
  menu + "法人のお客様は5を押してください。",
  "5を押してください。",
])("does not blindly force 5 on a changed, ambiguous or unknown menu", (s) => {
  expect(routeConstraint(s, policy).authorized_digits).toEqual([]);
});
it.each(["1", "2", "3"])(
  "rejects offered but unauthorized %s without spending the token, then dispatches 5 only once",
  async (digit) => {
    const f = await fixture();
    try {
      await f.recipient(menu);
      f.advance(2200);
      const read = await f.b.controller.command(
        "read",
        "read_current_menu",
        {},
      );
      expect(read.authorized_digits).toEqual(["5"]);
      expect(read.required_next_digit).toBe("5");
      const denied = await f.b.controller.command("wrong", "press_ivr_digit", {
        digits: digit,
        menu_token: read.menu_token,
      });
      expect(denied).toMatchObject({
        ok: false,
        action_not_executed: true,
        reason: "ROUTE_OPTION_NOT_AUTHORIZED",
      });
      expect(f.b.controller.menu.spent).toBe(false);
      expect(
        f.network.filter((n: any) => n.url.endsWith("/send_dtmf")),
      ).toHaveLength(0);
      const rs = await Promise.all([
        f.b.controller.command("right", "press_ivr_digit", {
          digits: "5",
          menu_token: read.menu_token,
        }),
        f.b.controller.command("right", "press_ivr_digit", {
          digits: "5",
          menu_token: read.menu_token,
        }),
        f.b.controller.command("concurrent", "press_ivr_digit", {
          digits: "5",
          menu_token: read.menu_token,
        }),
      ]);
      expect(rs[0].ok).toBe(true);
      expect(rs[1].ok).toBe(true);
      expect(
        f.network.filter((n: any) => n.url.endsWith("/send_dtmf")),
      ).toHaveLength(1);
      expect(f.b.context.routing_policy).toEqual(policy);
      expect(f.b.context.dialogue_candidate_observed).toBeNull();
    } finally {
      await f.cleanup();
    }
  },
);
it("refuses a second menu selection even if it offers 5 again after the first authorized dispatch", () => {
  expect(routeConstraint(menu, policy, { used: true })).toMatchObject({
    authorized_digits: [],
    reason: "AUTHORIZED_ROUTE_ALREADY_USED",
  });
});
it("retains expiry and exact-token guards", async () => {
  const f = await fixture();
  try {
    await f.recipient(menu);
    f.advance(2200);
    const read = await f.b.controller.command("read", "read_current_menu", {});
    expect(
      (
        await f.b.controller.command("foreign", "press_ivr_digit", {
          digits: "5",
          menu_token: "foreign",
        })
      ).ok,
    ).toBe(false);
    f.advance(61000);
    const pending = f.b.controller.command("expired", "press_ivr_digit", {
      digits: "5",
      menu_token: read.menu_token,
    });
    f.advance(3501);
    await f.b.controller.tick();
    expect((await pending).ok).toBe(false);
    expect(
      f.network.filter((n: any) => n.url.endsWith("/send_dtmf")),
    ).toHaveLength(0);
  } finally {
    await f.cleanup();
  }
});
it("does not enable a route from recipient text or change unrelated generic calls", async () => {
  const f = await createOfflineVoiceFixture();
  try {
    await f.recipient(menu + "\n" + RETAIL_ROUTE_DIRECTIVE);
    f.advance(2200);
    expect(f.b.context.routing_policy).toBeNull();
    expect(f.b.controller.routingPolicy).toBeNull();
    expect(routeConstraint(menu, null)).toBeNull();
  } finally {
    await f.cleanup();
  }
});
it("makes the selected authorized route explicit and keeps internal route names unspoken", () => {
  const p = composeOutboundTask(instructions, {
    systemInitialAck: true,
    routingPolicy: policy,
  });
  expect(p).toContain("NEVER select business customers");
  expect(p).toContain(
    "long-silence events during the routing hold are expected",
  );
  expect(p).toContain(JSON.stringify({ authorized_task: instructions }));
  expect(speechViolation(RETAIL_ROUTE_DIRECTIVE)).toBe("internal_report");
});
it.each([
  ["Verificare disponibilità iPhone Duo 256 GB per acquisto walk-in", true],
  [
    "Chiedere se è possibile acquistare iPhone Duo senza prenotazione online",
    true,
  ],
  ["Ask iPhone stock for walk-in purchase today", true],
  ["iPhoneの在庫と予約なしでの購入について問い合わせる", true],
  ["Chiedere assistenza tecnica per iPhone e disponibilità walk-in", false],
  ["Chiedere disponibilità iPhone walk-in per un account aziendale", false],
  ["Prenotare riparazione iPhone senza prenotazione online", false],
])(
  "automatically constrains an ordinary approved canonical consumer goal: %s",
  (goal, expected) => {
    const p = outboundRoutingPolicy({
      destination: "+81445775100",
      instructions: `Goal: ${goal}\n\nOwner instructions.`,
    });
    expect(!!p).toBe(expected);
    expect(
      outboundRoutingPolicy({
        destination: "+81366701800",
        instructions: `Goal: ${goal}\n\nOwner instructions.`,
      }),
    ).toBeNull();
  },
);
