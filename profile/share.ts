/** Shareable FREE result payload. Never implies monetary winnings. */

export interface ShareResultCard {
  app: "KICKR";
  kind: "FREE_CONTEST" | "PRIVATE_LEAGUE";
  label: string;
  matchLabel: string;
  rank: number | null;
  score: number | null;
  captain: string | null;
  free: true;
  monetary: false;
  note: string;
  url: string;
  text: string;
}

export function buildShareCard(input: {
  kind: "FREE_CONTEST" | "PRIVATE_LEAGUE";
  label: string;
  matchLabel: string;
  rank: number | null;
  scoreMilliPoints: number | null;
  captain: string | null;
  path: string;
}): ShareResultCard {
  const score = input.scoreMilliPoints != null ? input.scoreMilliPoints / 1000 : null;
  const rankLabel = input.rank != null ? `#${input.rank}` : "—";
  const scoreLabel = score != null ? score.toFixed(1) : "—";
  const text = [
    "KICKR FREE result",
    `${input.matchLabel}`,
    `${input.label} · Rank ${rankLabel} · ${scoreLabel} pts`,
    input.captain ? `Captain: ${input.captain}` : null,
    "No entry fee · No monetary prize",
    input.path,
  ]
    .filter(Boolean)
    .join("\n");
  return {
    app: "KICKR",
    kind: input.kind,
    label: input.label,
    matchLabel: input.matchLabel,
    rank: input.rank,
    score,
    captain: input.captain,
    free: true,
    monetary: false,
    note: "FREE — rank & score only. No monetary prize.",
    url: input.path,
    text,
  };
}
