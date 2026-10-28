// Local-only replay of the observed counted-menu structure. Final fragments and
// the くだい/ください invitation variants are observed; timings/segmentation are
// deliberately varied. All keypad actions are mocks, never provider commands.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { CallController } from "./jp-call-controller.mjs";

const choices = [
  "営業時間や道順については一を",
  "Appleケアに転送するには二を",
  "法人のお客様は三を",
  "その他のご質問は五を押してください。",
];
const invitation = (typo) =>
  `ご希望の番号を選択してくだ${typo ? "い" : "さい"}。`;
const introduction = "次の四つの中から";
export async function runMenuTimingSweep({
  Controller = CallController,
  output,
} = {}) {
  const results = [];
  const readDelays = [
    0, 100, 500, 1000, 1800, 2400, 2900, 3100, 3500, 4100, 4700, 5300, 6100,
    7500, 9000,
  ];
  const selectDelays = [0, 100, 350, 750, 1100, 1800, 2600, 3400];
  for (const initialTypo of [false, true])
    for (const replayTypo of [false, true])
      for (const segmentation of ["joined", "split", "cumulative"])
        for (const readDelay of readDelays)
          for (const selectDelay of selectDelays) {
            let at = 0,
              serial = 0,
              snapshot,
              selected,
              requestedRead = false,
              requestedSelect = false;
            const sent = [];
            const c = new Controller({
              now: () => at,
              stripCumulativeHistory: false,
              token: () => `local-${++serial}`,
              requirePlaybackAck: false,
              sendDigit: async (digit) => {
                sent.push(digit);
                return { ok: true };
              },
              close: async () => {},
            });
            const fragments = [
              [1000, introduction],
              [3500, invitation(initialTypo)],
              [6500, choices[0]],
              [11000, choices[1]],
              [15000, choices[2]],
              [20000, choices[3]],
            ];
            if (segmentation === "joined")
              fragments.push([23000, introduction + invitation(replayTypo)]);
            else {
              fragments.push([23000, introduction]);
              fragments.push([
                26000,
                (segmentation === "cumulative" ? introduction : "") +
                  invitation(replayTypo),
              ]);
            }
            fragments.push(
              [29000, choices[0]],
              [32000, choices[1]],
              [35000, choices[2]],
              [38000, choices[3]],
            );
            const events = fragments
              .flatMap(([time, text]) => [
                {
                  at: time - 600,
                  event: { type: "input_audio_buffer.speech_started" },
                },
                {
                  at: time - 150,
                  event: {
                    type: "recipient_interim_transcript",
                    transcript: text,
                  },
                },
                {
                  at: time,
                  event: { type: "input_audio_buffer.speech_stopped" },
                },
                {
                  at: time,
                  event: {
                    type: "conversation.item.input_audio_transcription.completed",
                    transcript: text,
                  },
                },
              ])
              .sort((a, b) => a.at - b.at);
            let cursor = 0;
            for (at = 0; at <= 42000; at += 50) {
              while (cursor < events.length && events[cursor].at <= at)
                c.event(events[cursor++].event);
              if (!requestedRead && at >= 20000 + readDelay) {
                requestedRead = true;
                c.command("read", "read_current_menu", {}).then(
                  (s) => (snapshot = s),
                );
              }
              await c.tick();
              if (
                snapshot?.ok &&
                !requestedSelect &&
                at >= 20000 + readDelay + selectDelay
              ) {
                requestedSelect = true;
                c.command("select", "press_ivr_digit", {
                  digits: "5",
                  menu_token: snapshot.menu_token,
                }).then((s) => (selected = s));
              }
              await Promise.resolve();
              if (selected) break;
            }
            const pass =
              selected?.ok === true && sent.length === 1 && sent[0] === "5";
            if (pass) {
              await c.command("select", "press_ivr_digit", {
                digits: "5",
                menu_token: snapshot.menu_token,
              });
              if (sent.length !== 1)
                throw Error("Duplicate simulated selection");
            }
            results.push({
              initialTypo,
              replayTypo,
              segmentation,
              readDelay,
              selectDelay,
              pass,
              reason:
                selected?.reason ?? (!snapshot?.ok ? "no_complete_read" : null),
            });
          }
  const report = {
    scenario_count: results.length,
    passed: results.filter((r) => r.pass).length,
    failed: results.filter((r) => !r.pass).length,
    real_calls: 0,
    external_requests: 0,
    failures: results.filter((r) => !r.pass).slice(0, 20),
  };
  if (output)
    writeFileSync(
      output,
      JSON.stringify({ summary: report, results }, null, 2),
      { mode: 0o600 },
    );
  return report;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  // These modules use only local input and mocks; refuse any accidental fetch.
  globalThis.fetch = async () => {
    throw Error("External network forbidden in offline timing sweep");
  };
  const report = await runMenuTimingSweep({ output: process.argv[2] });
  console.log(JSON.stringify(report));
  if (report.failed) process.exitCode = 1;
}
