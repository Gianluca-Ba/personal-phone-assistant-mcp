// The adapter supplies authenticated playback/recipient state. This watchdog
// cannot classify music as human speech and never fabricates a recipient turn.
export class SilenceWatchdog {
  constructor({
    now,
    initialMs = 25000,
    responseMs = 20000,
    afterCheckMs = 15000,
  }) {
    this.now = now;
    this.initialMs = initialMs;
    this.responseMs = responseMs;
    this.afterCheckMs = afterCheckMs;
    this.lastActivity = now();
    this.checkStarted = false;
    this.checkCompletedAt = null;
    this.checkedOnce = false;
  }
  activity() {
    this.lastActivity = this.now();
  }
  checkCompleted() {
    this.checkStarted = false;
    this.checkCompletedAt = this.now();
    this.activity();
  }
  cancelCheck() {
    this.checkStarted = false;
    this.checkCompletedAt = this.now();
    this.activity();
  }
  next({
    live,
    quiet,
    held,
    terminal,
    outputPending,
    awaitingAnswer,
    heardRecipient,
  }) {
    if (
      !live ||
      !quiet ||
      held ||
      terminal ||
      outputPending ||
      this.checkStarted
    )
      return null;
    const idle = this.now() - this.lastActivity;
    if (this.checkedOnce) {
      return this.checkCompletedAt !== null && idle >= this.afterCheckMs
        ? "close"
        : null;
    }
    if (
      idle <
      (heardRecipient || awaitingAnswer ? this.responseMs : this.initialMs)
    )
      return null;
    this.checkedOnce = true;
    this.checkStarted = true;
    return "check";
  }
}
