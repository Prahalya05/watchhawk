import { EventEmitter } from "events";

// Compresses one simulated trading day into a short real-world window so that
// session-relative concepts (volume-vs-time-of-day, overnight gaps, "nightly" stats
// recompute) are all observable within a live demo instead of requiring real hours/days.
export const SESSION_LENGTH_MS = 4 * 60 * 1000; // 4 minutes = one simulated trading day

class VirtualClock extends EventEmitter {
  private sessionStartedAt = Date.now();

  constructor() {
    super();
    // unref'd: this is a module-level singleton, so its interval would otherwise hold the
    // event loop open in any process that merely imports the replay provider — which is
    // what made `npm run seed` print "Done." and then hang forever instead of exiting.
    // The server has the HTTP listener to keep it alive; short-lived scripts shouldn't
    // inherit a reason to stay running.
    setInterval(() => this.tick(), 1000).unref();
  }

  private tick() {
    if (Date.now() - this.sessionStartedAt >= SESSION_LENGTH_MS) {
      this.sessionStartedAt = Date.now();
      this.emit("sessionBoundary", this.sessionStartedAt);
    }
  }

  elapsedSessionFraction(): number {
    return Math.min(1, (Date.now() - this.sessionStartedAt) / SESSION_LENGTH_MS);
  }

  currentSessionStartedAt(): number {
    return this.sessionStartedAt;
  }
}

export const virtualClock = new VirtualClock();
