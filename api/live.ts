import type { Context, Hono } from "hono";
import type { Principal } from "../auth/types.js";
import { AppError } from "../shared/errors.js";
import type { AppEnv, AppDeps } from "./server.js";
import { DEV_V1_SCALE } from "../domain/scoring/dev-v1.js";

export function registerLiveRoutes(
  app: Hono<AppEnv>,
  deps: AppDeps,
  authenticate: (c: Context<AppEnv>) => Promise<Principal>,
  requirePermission: (c: Context<AppEnv>, permission: "READ_SYSTEM") => Promise<void>,
): void {
  app.get("/matches/:id/live", async (c) => {
    await authenticate(c);
    const live = deps.live;
    if (!live) {
      throw new AppError("NOT_FOUND", 404, "Live scoring is not available");
    }
    const view = await live.getMatchLive(c.req.param("id"), {
      now: deps.clock(),
      correlationId: c.get("requestId") ?? null,
    });
    if (!view) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return c.json(view);
  });

  app.get("/matches/:id/events", async (c) => {
    await authenticate(c);
    const live = deps.live;
    if (!live) {
      throw new AppError("NOT_FOUND", 404, "Live scoring is not available");
    }
    const view = await live.getMatchEvents(c.req.param("id"));
    if (!view) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return c.json(view);
  });

  app.get("/matches/:id/leaderboard", async (c) => {
    await authenticate(c);
    const live = deps.live;
    if (!live) {
      throw new AppError("NOT_FOUND", 404, "Live scoring is not available");
    }
    const view = await live.getLeaderboard(c.req.param("id"), {
      now: deps.clock(),
      correlationId: c.get("requestId") ?? null,
    });
    if (!view) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return c.json(view);
  });

  app.get("/teams/:id/live-score", async (c) => {
    const principal = await authenticate(c);
    const live = deps.live;
    if (!live) {
      throw new AppError("NOT_FOUND", 404, "Live scoring is not available");
    }
    const view = await live.getTeamLiveScore(c.req.param("id"), principal.accountId, {
      now: deps.clock(),
      correlationId: c.get("requestId") ?? null,
    });
    if (!view) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }
    return c.json(view);
  });

  app.get("/matches/:id/live-stream", async (c) => {
    await authenticate(c);
    const live = deps.live;
    if (!live) {
      throw new AppError("NOT_FOUND", 404, "Live scoring is not available");
    }
    const matchId = c.req.param("id");
    const match = await deps.football.getMatch(matchId);
    if (!match) {
      throw new AppError("NOT_FOUND", 404, "Not found");
    }

    const encoder = new TextEncoder();
    let unsubscribe: (() => void) | null = null;
    let heartbeat: ReturnType<typeof setInterval> | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const send = (payload: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
        };
        send({
          type: "connected",
          matchId,
          scale: DEV_V1_SCALE,
          liveProviderConfigured: deps.config.public.liveProviderConfigured,
        });
        unsubscribe = live.hub.subscribe(matchId, (message) => send(message));
        heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(`: ping\n\n`));
        }, 15000);
      },
      cancel() {
        unsubscribe?.();
        if (heartbeat) {
          clearInterval(heartbeat);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        Connection: "keep-alive",
        "Cache-Control": "no-cache",
      },
    });
  });

  app.get("/v1/diagnostics/live", async (c) => {
    await authenticate(c);
    await requirePermission(c, "READ_SYSTEM");
    const live = deps.live;
    return c.json({
      LIVE_PROVIDER_CONFIGURED: deps.config.public.liveProviderConfigured,
      missingCredential: deps.config.public.liveProviderConfigured ? null : "SPORTS_API_KEY",
      provider: deps.config.server.sportsData.liveProvider,
      metrics: live?.metrics.snapshot() ?? null,
      unresolved: live?.pipeline.getUnresolved().slice(0, 100) ?? [],
    });
  });
}
