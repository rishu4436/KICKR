/** Pure presentation helpers for the consumer UI (no DOM). */
export function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

export function initials(name: string): string {
  return name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? "").join("") || "FC";
}

export function matchTitle(match: { home: { name: string; shortName: string }; away: { name: string; shortName: string } }): string {
  return `${match.home.name} vs ${match.away.name}`;
}

export function formatPts(milli: number): string {
  return (milli / 1000).toFixed(1);
}

export function rankMovementHtml(rank: number, priorRank: number | null | undefined): string {
  if (priorRank == null || priorRank === rank) {
    return priorRank == null ? "" : `<span class="rank-move same">–</span>`;
  }
  if (priorRank > rank) {
    return `<span class="rank-move up">▲${priorRank - rank}</span>`;
  }
  return `<span class="rank-move down">▼${rank - priorRank}</span>`;
}

export function scoreDeltaHtml(delta: number | null | undefined): string {
  if (delta == null || delta === 0) return "";
  const pts = (delta / 1000).toFixed(1);
  if (delta > 0) return `<div class="score-delta">+${pts}</div>`;
  return `<div class="score-delta neg">${pts}</div>`;
}

export function playerChip(opts: {
  displayName: string;
  shortName?: string;
  role?: "" | "C" | "VC";
  selected?: boolean;
}): string {
  const name = opts.displayName || opts.shortName || "Player";
  const avatar = initials(name);
  const role = opts.role
    ? `<span class="role badge ${opts.role === "C" ? "badge-c" : "badge-vc"}">${opts.role}</span>`
    : "";
  return `<div class="chip${opts.selected ? " selected-slot" : ""}"><div class="avatar">${escapeText(avatar)}</div><div class="name" title="${escapeText(name)}">${escapeText(name)}</div>${role}</div>`;
}

export function lbRowHtml(opts: {
  rank: number;
  label: string;
  milliPoints: number;
  you?: boolean;
  priorRank?: number | null;
  scoreDelta?: number | null;
}): string {
  const top = opts.rank === 1 ? " top-1" : opts.rank === 2 ? " top-2" : opts.rank === 3 ? " top-3" : "";
  const you = opts.you ? " you" : "";
  return `<div class="lb-row${you}${top}">
    <div class="rank">#${opts.rank}${rankMovementHtml(opts.rank, opts.priorRank)}</div>
    <div>${opts.you ? "<strong>You</strong>" : escapeText(opts.label)}</div>
    <div class="score-cell"><strong>${formatPts(opts.milliPoints)}</strong>${scoreDeltaHtml(opts.scoreDelta)}</div>
  </div>`;
}

export function xiPitchHtml(
  players: Array<{ displayName: string; shortName?: string; position: string; isCaptain?: boolean; isVice?: boolean }>,
): string {
  const slot = (pos: string) =>
    players
      .filter((p) => p.position === pos)
      .map((p) =>
        playerChip({
          displayName: p.displayName,
          shortName: p.shortName,
          role: p.isCaptain ? "C" : p.isVice ? "VC" : "",
          selected: true,
        }),
      )
      .join("") || `<div class="chip quiet">${pos}</div>`;
  return `<div class="pitch"><div class="line">${slot("FWD")}</div><div class="line">${slot("MID")}</div><div class="line">${slot("DEF")}</div><div class="line">${slot("GK")}</div></div>`;
}

export function resultHeroHtml(opts: {
  matchLabel: string;
  contestLabel: string;
  rank: number | null;
  totalEntries: number;
  scoreLabel: string;
  free: boolean;
}): string {
  const banner = opts.free
    ? `<div class="free-banner"><strong>FREE contest</strong><span>No entry fee · No monetary prize · Rank &amp; score only</span></div>`
    : "";
  return `<article class="card result-hero">
    <p class="quiet result-kicker">${escapeText(opts.contestLabel)}</p>
    <h2>${escapeText(opts.matchLabel)}</h2>
    <div class="result-stats">
      <div><span class="quiet">Final rank</span><strong class="rank-hero">#${opts.rank ?? "—"}</strong><span class="quiet">of ${opts.totalEntries}</span></div>
      <div><span class="quiet">Final score</span><strong>${escapeText(opts.scoreLabel)}</strong><span class="quiet">pts</span></div>
      <div><span class="quiet">Entrants</span><strong>${opts.totalEntries}</strong></div>
    </div>
    ${banner}
  </article>`;
}

export function lockedXiBannerHtml(): string {
  return `<div class="lock-banner"><strong>Read-only</strong><span>Match is locked — you can review this XI but not change it.</span></div>`;
}

export function creditsPanelHtml(used: number, cap: number, left: number): string {
  const meterClass = left <= 0 ? "meter full" : left <= 10 ? "meter warn" : "meter";
  return `<div class="credits-panel"><div><div class="quiet">Credits remaining</div><div class="credits-left">${left}</div></div><div class="xi-count">${used} / ${cap} used</div></div><div class="${meterClass}"><span style="width:${Math.min(100, (used / cap) * 100)}%"></span></div>`;
}
