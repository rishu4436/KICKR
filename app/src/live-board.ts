/** Authenticated SSE with periodic reconciliation and route-scoped cleanup. */
export async function consumeScoreStream(
  stream: ReadableStream<Uint8Array>,
  onUpdate: () => void,
  signal: AbortSignal,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  try {
    while (!signal.aborted) {
      const next = await reader.read();
      if (next.done) break;
      pending += decoder.decode(next.value, { stream: true });
      let boundary: RegExpExecArray | null;
      while ((boundary = /\r?\n\r?\n/.exec(pending))) {
        const frame = pending.slice(0, boundary.index);
        pending = pending.slice(boundary.index + boundary[0].length);
        const data = frame.split(/\r?\n/).filter((line) => line.startsWith("data:")).map((line) => line.slice(5).trimStart()).join("\n");
        if (!data || signal.aborted) continue;
        try {
          const payload = JSON.parse(data) as { type?: string };
          if (["connected", "score_update", "health"].includes(payload.type ?? "")) onUpdate();
        } catch { /* Ignore malformed events; reconciliation still runs. */ }
      }
      if (pending.length > 1_000_000) throw new Error("Score stream frame too large");
    }
  } finally {
    signal.removeEventListener("abort", cancel);
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export function watchLeaderboard(options: {
  matchId: string;
  token: string;
  refresh: (signal: AbortSignal) => Promise<boolean>;
  status: (message: string, connected: boolean) => void;
}): () => void {
  const controller = new AbortController();
  let reconnect: ReturnType<typeof setTimeout> | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let busy = false;
  let queued = false;
  let connected = false;
  let final = false;
  const stop = () => {
    controller.abort();
    clearInterval(reconcile);
    clearTimeout(reconnect);
    clearTimeout(debounce);
  };
  const refresh = async () => {
    if (controller.signal.aborted) return;
    if (busy) { queued = true; return; }
    busy = true;
    try {
      final = await options.refresh(controller.signal);
      if (controller.signal.aborted) return;
      if (final) { options.status("Final result", false); stop(); }
      else options.status(connected ? "Live updates connected" : "Scores refresh every 15s", connected);
    } catch {
      if (!controller.signal.aborted) options.status("Updates delayed · retrying", false);
    } finally {
      busy = false;
      if (queued && !controller.signal.aborted) { queued = false; schedule(); }
    }
  };
  const schedule = () => {
    if (debounce || controller.signal.aborted) return;
    debounce = setTimeout(() => { debounce = undefined; void refresh(); }, 250);
  };
  const connect = async () => {
    try {
      const response = await fetch(`/matches/${encodeURIComponent(options.matchId)}/live-stream`, {
        headers: { authorization: `Bearer ${options.token}`, accept: "text/event-stream" },
        signal: controller.signal,
      });
      if (!response.ok || !response.body || !response.headers.get("content-type")?.includes("text/event-stream")) {
        await response.body?.cancel();
        throw new Error("Score stream unavailable");
      }
      connected = true;
      await consumeScoreStream(response.body, schedule, controller.signal);
    } catch { /* Reconnect below; regular refresh covers stream outages. */ }
    finally {
      connected = false;
      if (!controller.signal.aborted) {
        options.status("Reconnecting · scores refresh every 15s", false);
        reconnect = setTimeout(() => { void connect(); }, 5000);
      }
    }
  };
  const reconcile = setInterval(() => { void refresh(); }, 15_000);
  options.status("Connecting to matchday…", false);
  void connect();
  return stop;
}
