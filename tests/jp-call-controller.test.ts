import { expect, it } from "vitest";
const { CallController } = await import(
  new URL("../scripts/jp-call-controller.mjs", import.meta.url).href
);
function harness(sendDigit?: any) {
  let at = 0,
    n = 0;
  const digits: string[] = [],
    closed: string[] = [];
  const c = new CallController({
    requirePlaybackAck: false,
    now: () => at,
    token: () => `menu-${++n}`,
    sendDigit:
      sendDigit ??
      (async (d: string) => {
        digits.push(d);
        return { ok: true };
      }),
    close: async (o: string) => {
      closed.push(o);
    },
  });
  const menu = (text: string) => {
    c.event({ type: "input_audio_buffer.speech_started" });
    c.event({ type: "input_audio_buffer.speech_stopped" });
    c.event({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: text,
    });
    at += 800;
  };
  return {
    c,
    digits,
    closed,
    menu,
    advance: (n: number) => {
      at += n;
    },
  };
}
it("binds an advertised digit to a completed current menu and consumes its token once", async () => {
  const h = harness();
  h.menu("予約は一を、変更は二を押してください。");
  const state = await h.c.command("state", "read_current_menu", {});
  expect(state.advertised_digits).toEqual(["1", "2"]);
  expect(
    (
      await h.c.command("wrong", "press_ivr_digit", {
        digits: "3",
        menu_token: state.menu_token,
      })
    ).reason,
  ).toBe("DIGIT_NOT_ADVERTISED");
  expect(
    (
      await h.c.command("ok", "press_ivr_digit", {
        digits: "2",
        menu_token: state.menu_token,
      })
    ).ok,
  ).toBe(true);
  await h.c.command("ok", "press_ivr_digit", {
    digits: "2",
    menu_token: state.menu_token,
  });
  expect(
    (
      await h.c.command("duplicate", "press_ivr_digit", {
        digits: "2",
        menu_token: state.menu_token,
      })
    ).reason,
  ).toBe("MENU_ALREADY_USED");
  h.menu("当日の予約は3を押してください。");
  expect(
    (
      await h.c.command("stale", "press_ivr_digit", {
        digits: "2",
        menu_token: state.menu_token,
      })
    ).reason,
  ).toBe("STALE_OR_INCOMPLETE_MENU");
  expect(h.digits).toEqual(["2"]);
});
it("reserves before concurrent delivery and does not retry an uncertain provider response", async () => {
  let resolve: any,
    calls = 0;
  const h = harness(() => {
    calls++;
    return new Promise((r) => {
      resolve = r;
    });
  });
  h.menu("変更は2を押してください。");
  const { menu_token } = await h.c.command("state", "read_current_menu", {});
  const a = h.c.command("a", "press_ivr_digit", { digits: "2", menu_token });
  expect(
    (await h.c.command("b", "press_ivr_digit", { digits: "2", menu_token })).ok,
  ).toBe(false);
  resolve({ ok: true });
  await a;
  expect(calls).toBe(1);
  const f = harness(async () => {
    throw Error("timeout");
  });
  f.menu("変更は2を押してください。");
  const m = await f.c.command("s", "read_current_menu", {});
  expect(
    (
      await f.c.command("f", "press_ivr_digit", {
        digits: "2",
        menu_token: m.menu_token,
      })
    ).reason,
  ).toContain("UNCONFIRMED");
  expect(
    (
      await f.c.command("g", "press_ivr_digit", {
        digits: "2",
        menu_token: m.menu_token,
      })
    ).ok,
  ).toBe(false);
});
it("enforces explicit retry and total selection quotas in code", async () => {
  const h = harness();
  for (let i = 0; i < 3; i++) {
    h.menu(
      (i ? "選択を確認できませんでした。" : "") + "変更は2を押してください。",
    );
    const m = await h.c.command("s" + i, "read_current_menu", {});
    const r = await h.c.command("p" + i, "press_ivr_digit", {
      digits: "2",
      menu_token: m.menu_token,
    });
    expect(r.ok).toBe(i < 2);
  }
  expect(h.digits).toEqual(["2", "2"]);
  const q = harness();
  for (let i = 0; i < 6; i++) {
    q.menu(`窓口${i}です。次は1を押してください。`);
    const m = await q.c.command("s" + i, "read_current_menu", {});
    const r = await q.c.command("p" + i, "press_ivr_digit", {
      digits: "1",
      menu_token: m.menu_token,
    });
    expect(r.ok).toBe(i < 5);
  }
  expect(q.digits).toHaveLength(5);
});
it("blocks sensitive menus and rejects cross-action arguments without closing", async () => {
  const h = harness();
  h.menu("お支払いは1を押してください。");
  const m = await h.c.command("s", "read_current_menu", {});
  expect(
    (
      await h.c.command("p", "press_ivr_digit", {
        digits: "1",
        menu_token: m.menu_token,
      })
    ).reason,
  ).toBe("SENSITIVE_MENU");
  expect(
    (await h.c.command("x", "finish_call_after_goodbye", { digits: "2" }))
      .reason,
  ).toBe("INVALID_ARGUMENTS");
  await h.c.tick();
  expect(h.closed).toEqual([]);
});
it("waits for complete farewell audio and recipient silence, and cancels closing on a new turn", async () => {
  const h = harness();
  h.menu("予約は変更しました。失礼します。");
  await h.c.command("close", "finish_call_after_goodbye", {
    outcome: "confirmed",
  });
  h.c.event({ type: "assistant_audio", bytes: 32000, rate: 16000 });
  h.c.event({
    type: "assistant_completed",
    text: "ありがとうございます。失礼いたします。",
  });
  h.advance(900);
  expect(await h.c.tick()).toBe(false);
  h.advance(351);
  expect(await h.c.tick()).toBe(true);
  await h.c.tick();
  expect(h.closed).toEqual(["confirmed"]);
  const n = harness();
  n.menu("予約を変更しました。");
  await n.c.command("close", "finish_call_after_goodbye", {
    outcome: "confirmed",
  });
  n.c.event({ type: "assistant_completed", text: "失礼いたします。" });
  n.c.event({ type: "input_audio_buffer.speech_started" });
  n.advance(5000);
  expect(await n.c.tick()).toBe(false);
  expect(n.closed).toEqual([]);
});
it("never accepts the recipient farewell as the assistant farewell, or closes during a hold", async () => {
  const h = harness();
  h.menu("それでは失礼します。");
  await h.c.command("close", "finish_call_after_goodbye", {
    outcome: "confirmed",
  });
  h.advance(5000);
  expect(await h.c.tick()).toBe(false);
  h.menu("確認しますので少々お待ちください。");
  expect(
    (
      await h.c.command("hold-close", "finish_call_after_goodbye", {
        outcome: "confirmed",
      })
    ).reason,
  ).toBe("HOLD_OR_QUESTION_PENDING");
});
it("assembles segmented menu transcripts and waits for the complete menu before exposing a token", async () => {
  const h = harness();
  h.c.event({ type: "input_audio_buffer.speech_started" });
  h.c.event({ type: "input_audio_buffer.speech_stopped" });
  h.c.event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "予約変更は2を",
  });
  const pending = h.c.command("pending-read", "read_current_menu", {});
  h.advance(500);
  await h.c.tick();
  h.c.event({ type: "input_audio_buffer.speech_started" });
  h.c.event({ type: "input_audio_buffer.speech_stopped" });
  h.c.event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "押してください。",
  });
  h.advance(800);
  await h.c.tick();
  const state = await pending;
  expect(state.menu).toBe("予約変更は2を押してください。");
  expect(state.advertised_digits).toEqual(["2"]);
});
it("keeps completed farewell evidence while draining a subsequent closing acknowledgement", async () => {
  const h = harness();
  h.menu("予約を変更しました。失礼します。");
  h.c.event({ type: "response.created" });
  h.c.event({
    type: "assistant_completed",
    text: "ありがとうございます。失礼いたします。",
  });
  h.c.event({ type: "response.created" });
  await h.c.command("c", "finish_call_after_goodbye", { outcome: "confirmed" });
  h.advance(2000);
  expect(await h.c.tick()).toBe(false);
  h.c.event({ type: "assistant_audio", bytes: 32000, rate: 16000 });
  h.c.event({ type: "assistant_completed", text: "終了します。" });
  h.advance(1000);
  expect(await h.c.tick()).toBe(false);
  h.advance(251);
  expect(await h.c.tick()).toBe(true);
});
it("does not count cumulative historical transcripts as a new retry allowance", async () => {
  const h = harness();
  let history = "";
  for (let i = 0; i < 3; i++) {
    const current =
      (i ? "選択を確認できませんでした。" : "") +
      "予約の変更は2を押してください。";
    history += (history ? " " : "") + current;
    h.menu(history);
    const state = await h.c.command("read" + i, "read_current_menu", {});
    expect(state.menu).toBe(current);
    const result = await h.c.command("press" + i, "press_ivr_digit", {
      digits: "2",
      menu_token: state.menu_token,
    });
    expect(result.ok).toBe(i < 2);
  }
  expect(h.digits).toEqual(["2", "2"]);
});
it("closes on completed farewell plus silence when the model omits the closing tool, without inventing task success", async () => {
  const h = harness();
  h.menu("ご依頼は承れません。それでは失礼します。");
  h.c.event({
    type: "assistant_completed",
    text: "承知いたしました。ありがとうございます。失礼いたします。",
  });
  h.advance(1000);
  expect(await h.c.tick()).toBe(true);
  expect(h.closed).toEqual(["unspecified"]);
  const n = harness();
  n.menu("その前に質問があります。");
  n.c.event({ type: "assistant_completed", text: "失礼いたします。" });
  n.advance(5000);
  expect(await n.c.tick()).toBe(false);
});
it("lets a failed clarification end as unable to proceed after a complete farewell", async () => {
  const h = harness();
  h.menu("番号を選択してください。");
  h.c.event({
    type: "assistant_completed",
    text: "もう一度教えていただけますか？",
  });
  h.menu("申し訳ありませんが、ご案内できません。失礼します。");
  expect(
    (
      await h.c.command("close", "finish_call_after_goodbye", {
        outcome: "unable_to_proceed",
      })
    ).ok,
  ).toBe(true);
  h.advance(2000);
  expect(await h.c.tick()).toBe(false);
  h.c.event({
    type: "assistant_completed",
    text: "対応できませんので失礼いたします。",
  });
  h.advance(1000);
  expect(await h.c.tick()).toBe(true);
  expect(h.closed).toEqual(["unable_to_proceed"]);
});
it("does not treat a choice-free IVR introduction as the end of the menu or task", async () => {
  const h = harness();
  h.menu("次の四つの中からご希望の番号を選択してください。");
  expect(h.c.menuReady()).toBe(false);
  expect(
    (
      await h.c.command("early-close", "finish_call_after_goodbye", {
        outcome: "unable_to_proceed",
      })
    ).reason,
  ).toBe("MENU_NOT_COMPLETE");
  const read = h.c.command("waiting-read", "read_current_menu", {});
  h.menu(
    "営業時間は一を、サポートは二を、法人は三を、その他のご質問は五を押してください。",
  );
  await h.c.tick();
  expect((await read).advertised_digits).toEqual(["1", "2", "3", "5"]);
  expect(h.closed).toEqual([]);
});
it("queues a selection against the exact immutable menu through a replay introduction", async () => {
  const h = harness();
  h.menu("サポートは二を、その他のご質問は五を押してください。");
  const snapshot = await h.c.command("read", "read_current_menu", {});
  h.c.event({ type: "input_audio_buffer.speech_started" });
  const select = h.c.command("select", "press_ivr_digit", {
    digits: "5",
    menu_token: snapshot.menu_token,
  });
  await h.c.tick();
  expect(h.digits).toEqual([]);
  h.c.event({ type: "input_audio_buffer.speech_stopped" });
  h.c.event({
    type: "conversation.item.input_audio_transcription.completed",
    transcript: "次の四つの中からご希望の番号を選択してください。",
  });
  h.advance(800);
  await h.c.tick();
  expect((await select).ok).toBe(true);
  expect(h.digits).toEqual(["5"]);
  expect(h.c.menu.token).toBe(snapshot.menu_token);
  await h.c.command("select", "press_ivr_digit", {
    digits: "5",
    menu_token: snapshot.menu_token,
  });
  expect(h.digits).toHaveLength(1);
});
it("never retargets a queued selection when a human or a different menu intervenes", async () => {
  for (const text of [
    "はい、担当者です。ご用件は何でしょうか。",
    "予約は三を押してください。",
  ]) {
    const h = harness();
    h.menu("その他のご質問は五を押してください。");
    const m = await h.c.command("read", "read_current_menu", {});
    h.c.event({ type: "input_audio_buffer.speech_started" });
    const p = h.c.command("select", "press_ivr_digit", {
      digits: "5",
      menu_token: m.menu_token,
    });
    h.c.event({ type: "input_audio_buffer.speech_stopped" });
    h.c.event({
      type: "conversation.item.input_audio_transcription.completed",
      transcript: text,
    });
    h.advance(800);
    await h.c.tick();
    expect((await p).reason).toBe("STALE_OR_INCOMPLETE_MENU");
    expect(h.digits).toEqual([]);
  }
});
it("expires an awaiting selection without sending a tone during continuous speech", async () => {
  const h = harness();
  h.menu("その他のご質問は五を押してください。");
  const m = await h.c.command("read", "read_current_menu", {});
  h.c.event({ type: "input_audio_buffer.speech_started" });
  const p = h.c.command("select", "press_ivr_digit", {
    digits: "5",
    menu_token: m.menu_token,
  });
  h.advance(8100);
  await h.c.tick();
  expect((await p).reason).toBe("MENU_NOT_COMPLETE");
  expect(h.digits).toEqual([]);
});
