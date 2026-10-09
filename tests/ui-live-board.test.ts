import { afterEach, describe, expect, it, vi } from "vitest";
import { consumeScoreStream, watchLeaderboard } from "../app/src/live-board.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("leaderboard live updates", () => {
  it("handles split SSE frames, CRLF, heartbeats and malformed events", async () => {
    const encoder = new TextEncoder();
    const chunks = ['data: {"type":"connected"}\r', '\n\r\n: ping\n\ndata: nope\n\ndata: {"type":"score_', 'update"}\n\ndata: {"type":"health"}\n\n'];
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    } });
    const update = vi.fn();
    await consumeScoreStream(stream, update, new AbortController().signal);
    expect(update).toHaveBeenCalledTimes(3);
  });

  it("cancels a pending read when leaving the page", async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    const controller = new AbortController();
    const reading = consumeScoreStream(stream, vi.fn(), controller.signal);
    controller.abort();
    await reading;
    expect(cancel).toHaveBeenCalledOnce();
  });

  it("uses bearer auth, reconciles during an outage and stops on disposal", async () => {
    vi.useFakeTimers();
    const request = vi.fn().mockRejectedValue(new Error("offline"));
    vi.stubGlobal("fetch", request);
    const refresh = vi.fn().mockResolvedValue(false);
    const stop = watchLeaderboard({ matchId: "fixture", token: "session-token", refresh, status: vi.fn() });
    await vi.advanceTimersByTimeAsync(15_000);
    expect(request.mock.calls[0]?.[1].headers.authorization).toBe("Bearer session-token");
    expect(request.mock.calls[0]?.[0]).not.toContain("session-token");
    expect(refresh).toHaveBeenCalledOnce();
    stop();
    const calls = request.mock.calls.length;
    await vi.advanceTimersByTimeAsync(30_000);
    expect(request).toHaveBeenCalledTimes(calls);
    expect(refresh).toHaveBeenCalledOnce();
    expect(request.mock.calls[0]?.[1].signal.aborted).toBe(true);
  });

  it("stops automatic refresh when a final result arrives", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("offline")));
    const refresh = vi.fn().mockResolvedValue(true);
    const status = vi.fn();
    const stop = watchLeaderboard({ matchId: "fixture", token: "token", refresh, status });
    await vi.advanceTimersByTimeAsync(45_000);
    expect(refresh).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith("Final result", false);
    stop();
  });

  it("coalesces score events into a refresh and cancels the active stream", async () => {
    vi.useFakeTimers();
    const encoder = new TextEncoder();
    let push!: ReadableStreamDefaultController<Uint8Array>;
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ start(controller) { push = controller; }, cancel });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(stream, { headers: { "content-type": "text/event-stream" } })));
    const refresh = vi.fn().mockResolvedValue(false);
    const status = vi.fn();
    const stop = watchLeaderboard({ matchId: "fixture", token: "token", refresh, status });
    await vi.advanceTimersByTimeAsync(0);
    push.enqueue(encoder.encode('data: {"type":"score_update"}\n\ndata: {"type":"score_update"}\n\n'));
    await vi.advanceTimersByTimeAsync(300);
    expect(refresh).toHaveBeenCalledOnce();
    expect(status).toHaveBeenLastCalledWith("Live updates connected", true);
    stop();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(cancel).toHaveBeenCalledOnce();
    expect(refresh).toHaveBeenCalledOnce();
  });
});
