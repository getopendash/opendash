/**
 * LISTEN for NOTIFY on a channel (Streaming): one connection per process, direct or session-mode, never a
 * transaction pooler. Payloads carry ids only, so a listener learns that something changed, never what: it reads the
 * rows itself, through withTenant.
 */
import postgres from "postgres";

export interface Listener {
  /**
   * Resolves once listening. `onPayload` gets each notify; `onListen` runs each time the LISTEN is (re)established,
   * so a caller can catch up on what a dropped connection missed.
   */
  listen(channel: string, onPayload: (payload: string) => void, onListen?: () => void): Promise<void>;
  end(): Promise<void>;
}

export function createListener(url: string): Listener {
  const client = postgres(url, { max: 1, connect_timeout: 10, onnotice: () => {} });
  return {
    async listen(channel, onPayload, onListen) {
      await client.listen(channel, onPayload, onListen);
    },
    end: () => client.end({ timeout: 5 }),
  };
}

/** The process's listener on DATABASE_DIRECT_URL, or null without one (callers fall back to polling). */
export function directListener(): Listener | null {
  const url = process.env.DATABASE_DIRECT_URL;
  return url ? createListener(url) : null;
}
