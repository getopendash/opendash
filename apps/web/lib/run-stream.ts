import "server-only";
import { RUN_EVENTS_CHANNEL } from "@opendash/core";
import { directListener } from "@opendash/db";

/**
 * The web process's one LISTEN connection for run events (Streaming), fanned out in memory to the streams
 * open on this process. A notify says only that a run has a new event; each stream reads it through withTenant,
 * as its viewer. Without DATABASE_DIRECT_URL, or while the connection is down, streams poll instead.
 */
type Wake = () => void;

class RunHub {
  private readonly streams = new Map<string, Set<Wake>>();
  private listening: Promise<boolean> | null = null;

  /** Whether notifies arrive: false means the caller polls. */
  start(): Promise<boolean> {
    this.listening ??= (async () => {
      const listener = directListener();
      if (!listener) return false;
      try {
        await listener.listen(
          RUN_EVENTS_CHANNEL,
          (payload) => {
            for (const part of payload.split(",")) this.wake(part.split(":")[0] ?? "");
          },
          // After a reconnect: every open stream reads again, in case a notify was missed meanwhile.
          () => {
            for (const runId of this.streams.keys()) this.wake(runId);
          },
        );
        return true;
      } catch {
        // Closed before the next stream tries again, so the process never holds two LISTEN connections.
        await listener.end().catch(() => {});
        this.listening = null;
        return false;
      }
    })();
    return this.listening;
  }

  subscribe(runId: string, wake: Wake): () => void {
    let set = this.streams.get(runId);
    if (!set) {
      set = new Set();
      this.streams.set(runId, set);
    }
    set.add(wake);
    return () => {
      set.delete(wake);
      if (!set.size) this.streams.delete(runId);
    };
  }

  private wake(runId: string) {
    for (const w of this.streams.get(runId) ?? []) w();
  }
}

// One per process, also across Next's dev reloads.
const holder = globalThis as { __openDashRunHub?: RunHub };
holder.__openDashRunHub ??= new RunHub();
export const runHub = holder.__openDashRunHub;
