import type { Hono } from "hono";
import { buildShareCard, renderShareHtmlPage } from "../profile/share.js";
import type { AppDeps, AppEnv } from "./server.js";

/**
 * Public HTML share pages with Open Graph metadata.
 * Never imply cash winnings. Rank + score + FREE label only.
 */
export function registerSharePages(app: Hono<AppEnv>, deps: AppDeps): void {
  app.get("/share/contest/:id", async (c) => {
    const contestId = c.req.param("id");
    try {
      const contest = await deps.contests.getContest(contestId);
      const free = await deps.contests.getFreeResult(contestId);
      const wallet = c.req.query("wallet") ?? null;
      const myRow =
        wallet && free ? (free.rows.find((r) => r.wallet === wallet) ?? null) : free?.rows[0] ?? null;
      const match = await deps.football.getMatch(contest.matchId);
      const matchLabel = match ? `${match.home.name} vs ${match.away.name}` : contest.matchId;
      const card = buildShareCard({
        kind: "FREE_CONTEST",
        label: contest.contestKind === "FREE" ? `FREE ${contest.templateCode}` : contest.templateCode,
        matchLabel,
        rank: myRow?.rank ?? null,
        scoreMilliPoints: myRow?.finalScoreMilliPoints ?? null,
        captain: null,
        path: `#/share/contest/${contestId}`,
        sharePath: `/share/contest/${contestId}`,
      });
      const html = renderShareHtmlPage({ card, canonicalPath: `/share/contest/${contestId}` });
      return c.html(html);
    } catch {
      return c.html(notFoundHtml("Contest share"), 404);
    }
  });

  app.get("/share/league/:id", async (c) => {
    if (!deps.leagues) return c.html(notFoundHtml("League share"), 404);
    const leagueId = c.req.param("id");
    try {
      const league = await deps.leagues.get(leagueId, null);
      const result = await deps.leagues.getResult(leagueId);
      const wallet = c.req.query("wallet") ?? null;
      const myRow =
        wallet && result
          ? (result.rows.find((r) => r.wallet === wallet) ?? null)
          : result?.rows[0] ?? null;
      const match = await deps.football.getMatch(league.matchId);
      const matchLabel = match ? `${match.home.name} vs ${match.away.name}` : league.matchId;
      const card = buildShareCard({
        kind: "PRIVATE_LEAGUE",
        label: league.name,
        matchLabel,
        rank: myRow?.rank ?? null,
        scoreMilliPoints: myRow?.finalScoreMilliPoints ?? null,
        captain: null,
        path: `#/share/league/${leagueId}`,
        sharePath: `/share/league/${leagueId}`,
      });
      const html = renderShareHtmlPage({ card, canonicalPath: `/share/league/${leagueId}` });
      return c.html(html);
    } catch {
      return c.html(notFoundHtml("League share"), 404);
    }
  });
}

function notFoundHtml(label: string): string {
  return `<!DOCTYPE html><html><head><title>KICKR</title></head><body><p>${label} not found.</p><p>FREE fantasy — no monetary prize.</p></body></html>`;
}
