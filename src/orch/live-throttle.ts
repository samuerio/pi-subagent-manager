import type { TranscriptSnapshot } from "../types.ts";

/**
 * Throttling for live spawn updates. Tool-call changes emit immediately (a
 * running→completed transition must not wait for a heartbeat); metrics ride a
 * heartbeat interval; `flush()` forces one last emit (the abort path) and
 * `stop()` tears the timer down. `heartbeatMs: 0` disables the heartbeat so
 * tests can drive emission deterministically.
 */
export interface LiveThrottler {
  push(snapshot: TranscriptSnapshot): void;
  flush(): void;
  stop(): void;
}

/** Tool identity plus lifecycle: the minimal observable change worth an immediate emit. */
function fingerprintOf(snapshot: TranscriptSnapshot): string {
  return snapshot.tools
    .map((tool) => `${tool.toolCallId}:${tool.state}:${tool.isError ? 1 : 0}`)
    .join("|");
}

export function createLiveThrottler(options: {
  heartbeatMs?: number;
  emit: (snapshot: TranscriptSnapshot) => void;
}): LiveThrottler {
  const heartbeatMs = Math.max(0, options.heartbeatMs ?? 0);
  let latest: TranscriptSnapshot | undefined;
  let fingerprint: string | undefined;
  let lastEmitted: TranscriptSnapshot | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const emitNow = (snapshot: TranscriptSnapshot) => {
    lastEmitted = snapshot;
    try {
      options.emit(snapshot);
    } catch (error) {
      // A failing consumer must never break the blocked tool execution, but a
      // silently dead live stream is invisible to the operator.
      console.warn(
        `Subagent live update failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  };

  const startHeartbeat = () => {
    if (heartbeatMs <= 0 || timer !== undefined) return;
    timer = setInterval(() => {
      if (latest) emitNow(latest);
    }, heartbeatMs);
    timer.unref?.();
  };

  return {
    push(snapshot: TranscriptSnapshot) {
      // Mirror live-agent-view's accept() gate: drop regressing snapshots, and a
      // generation change invalidates everything observed for the old driver.
      if (
        latest &&
        (snapshot.generation < latest.generation ||
          (snapshot.generation === latest.generation &&
            snapshot.revision < latest.revision))
      )
        return;
      if (latest && snapshot.generation !== latest.generation)
        fingerprint = undefined;
      latest = snapshot;
      const next = fingerprintOf(snapshot);
      if (next === fingerprint) return;
      fingerprint = next;
      startHeartbeat();
      emitNow(snapshot);
    },
    flush() {
      // Reference identity: a newer metrics-only snapshot still deserves a final frame.
      if (latest && latest !== lastEmitted) emitNow(latest);
    },
    stop() {
      if (timer !== undefined) clearInterval(timer);
      timer = undefined;
      latest = undefined;
    },
  };
}
