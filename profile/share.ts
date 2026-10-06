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
  /** Client hash route for in-app share view. */
  url: string;
  /** Absolute-ish path for OG HTML share page (served by API). */
  sharePath: string;
  text: string;
  /** Open Graph style fields for share pages / crawlers. */
  og: {
    title: string;
    description: string;
    type: "website";
    image: string;
  };
}

export function buildShareCard(input: {
  kind: "FREE_CONTEST" | "PRIVATE_LEAGUE";
  label: string;
  matchLabel: string;
  rank: number | null;
  scoreMilliPoints: number | null;
  captain: string | null;
  path: string;
  sharePath?: string;
}): ShareResultCard {
  const score = input.scoreMilliPoints != null ? input.scoreMilliPoints / 1000 : null;
  const rankLabel = input.rank != null ? `#${input.rank}` : "—";
  const scoreLabel = score != null ? score.toFixed(1) : "—";
  const kindLabel = input.kind === "PRIVATE_LEAGUE" ? "Private FREE league" : "FREE contest";
  const sharePath =
    input.sharePath ??
    (input.kind === "PRIVATE_LEAGUE"
      ? input.path.replace(/^#\/share\/league\//, "/share/league/").replace(/^#\/leagues\//, "/share/league/")
      : input.path.replace(/^#\/share\/contest\//, "/share/contest/").replace(/^#\/contests\//, "/share/contest/"));
  const title = `KICKR · ${input.label} · Rank ${rankLabel}`;
  const description = [
    `${input.matchLabel}`,
    `${kindLabel}: ${scoreLabel} pts`,
    input.captain ? `Captain: ${input.captain}` : null,
    "FREE — no entry fee, no monetary prize",
  ]
    .filter(Boolean)
    .join(" · ");
  const text = [
    "KICKR FREE result",
    `${input.matchLabel}`,
    `${input.label} · Rank ${rankLabel} · ${scoreLabel} pts`,
    input.captain ? `Captain: ${input.captain}` : null,
    "No entry fee · No monetary prize",
    sharePath,
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
    sharePath,
    text,
    og: {
      title,
      description,
      type: "website",
      image: `${sharePath.replace(/\/$/, "")}/og.png`,
    },
  };
}

/** Minimal HTML document with Open Graph tags for crawlers / messengers. */
export function renderShareHtmlPage(input: {
  card: ShareResultCard;
  canonicalPath: string;
}): string {
  const { card } = input;
  const esc = (value: string) =>
    value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  const rankLabel = card.rank != null ? `#${card.rank}` : "—";
  const scoreLabel = card.score != null ? card.score.toFixed(1) : "—";
  const appHash = card.url.startsWith("#") ? card.url : `#${card.url.replace(/^\//, "/")}`;
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${esc(card.og.title)}</title>
  <meta name="description" content="${esc(card.og.description)}" />
  <meta property="og:site_name" content="KICKR" />
  <meta property="og:title" content="${esc(card.og.title)}" />
  <meta property="og:description" content="${esc(card.og.description)}" />
  <meta property="og:type" content="website" />
  <meta property="og:url" content="${esc(input.canonicalPath)}" />
  <meta property="og:image" content="${esc(card.og.image)}" />
  <meta property="og:image:type" content="image/png" />
  <meta property="og:image:width" content="600" />
  <meta property="og:image:height" content="315" />
  <meta name="twitter:card" content="summary_large_image" />
  <meta name="twitter:image" content="${esc(card.og.image)}" />
  <meta name="twitter:title" content="${esc(card.og.title)}" />
  <meta name="twitter:description" content="${esc(card.og.description)}" />
  <meta name="kickr:free" content="true" />
  <meta name="kickr:monetary" content="false" />
  <style>
    :root { color-scheme: dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { margin: 0; background: #0b1220; color: #e8eefc; }
    main { max-width: 520px; margin: 48px auto; padding: 24px; }
    .card { background: #121a2b; border: 1px solid #243049; border-radius: 16px; padding: 24px; }
    .badge { display: inline-block; background: #0f3d34; color: #5eead4; padding: 4px 10px; border-radius: 999px; font-size: 12px; font-weight: 700; }
    h1 { font-size: 14px; letter-spacing: 0.18em; margin: 12px 0 8px; }
    h2 { margin: 0 0 8px; font-size: 22px; }
    .quiet { color: #93a0b8; }
    .note { margin-top: 16px; color: #5eead4; font-size: 13px; }
    a.btn { display: inline-block; margin-top: 18px; background: #5eead4; color: #042f2e; text-decoration: none; font-weight: 700; padding: 10px 16px; border-radius: 12px; }
  </style>
</head>
<body>
  <main>
    <article class="card">
      <span class="badge">FREE</span>
      <h1>KICKR</h1>
      <h2>${esc(card.matchLabel)}</h2>
      <p class="quiet">${esc(card.label)} · Rank ${esc(rankLabel)} · ${esc(scoreLabel)} pts${card.captain ? ` · Captain: ${esc(card.captain)}` : ""}</p>
      <p class="note">${esc(card.note)}</p>
      <a class="btn" href="/${esc(appHash)}">Open in KICKR</a>
    </article>
  </main>
</body>
</html>`;
}
