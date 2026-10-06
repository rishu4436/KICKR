import { Buffer } from "buffer";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Connection, Keypair } from "@solana/web3.js";
import { buildDepositTransaction, type DepositPlan, type ClaimPlan } from "../../solana/escrow.js";
import { assertDevCluster } from "../../solana/ids.js";
import {
  loginWithBrowserWallet,
  publicRpcForCluster,
  readBrowserWallet,
  signAndSubmitClaim,
  assertWalletClaimInvariant,
  shortWallet,
} from "./claim-flow.js";
import { contestAcceptsNewEntry } from "../../contests/types.js";
import { calculateCreditsUsed, remainingCredits } from "../../domain/football/credits.js";
import {
  classifyContestLifecycle,
  contestPrimaryCta,
  formationLabel,
  type ContestLifecycleBucket,
  type ContestPrimaryCta,
} from "../../domain/football/presentation.js";
import { validateFantasyTeam } from "../../domain/football/validate-team.js";
import {
  escapeText,
  initials,
  matchTitle,
  playerChip,
  lbRowHtml,
  freshnessBannerHtml,
  freshnessChipLabel,
  shareCardHtml,
  onboardingChecklistHtml,
} from "./format.js";

Object.assign(globalThis, { Buffer });

const ONBOARD_KEY = "kickr.onboarding.seen";
const LB_VIEWED_KEY = "kickr.onboarding.leaderboardViewed";
/** Dismissal preference only — never used as completion source of truth. */
function onboardingSeen(): boolean {
  return sessionStorage.getItem(ONBOARD_KEY) === "1";
}
/** Explicit client event: user opened a leaderboard view. */
function leaderboardViewed(): boolean {
  return sessionStorage.getItem(LB_VIEWED_KEY) === "1";
}
function markLeaderboardViewed(): void {
  sessionStorage.setItem(LB_VIEWED_KEY, "1");
}
function dismissOnboarding(): void {
  sessionStorage.setItem(ONBOARD_KEY, "1");
}
function bindOnboardingDismiss(): void {
  document.querySelector("[data-dismiss-onboarding]")?.addEventListener("click", () => {
    dismissOnboarding();
    void render();
  });
}

const LEAGUE_RETURN_KEY = "kickr.league.return";
interface LeagueReturnContext {
  inviteCode: string;
  matchId: string;
  leagueId?: string;
}
function readLeagueReturn(): LeagueReturnContext | null {
  try {
    const raw = sessionStorage.getItem(LEAGUE_RETURN_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as LeagueReturnContext;
    if (!parsed?.inviteCode || !parsed?.matchId) return null;
    return parsed;
  } catch {
    return null;
  }
}
function writeLeagueReturn(ctx: LeagueReturnContext): void {
  sessionStorage.setItem(LEAGUE_RETURN_KEY, JSON.stringify(ctx));
}
function clearLeagueReturn(): void {
  sessionStorage.removeItem(LEAGUE_RETURN_KEY);
}

/** Onboarding completion from real account state (not sessionStorage checklist marks). */
async function loadOnboardingProgress(): Promise<{
  signedIn: boolean;
  matchSelected: boolean;
  xiSaved: boolean;
  captainSet: boolean;
  viceSet: boolean;
  freeJoined: boolean;
  leaderboardReady: boolean;
}> {
  const signedIn = Boolean(state.token);
  const empty = {
    signedIn,
    matchSelected: false,
    xiSaved: false,
    captainSet: false,
    viceSet: false,
    freeJoined: false,
    leaderboardReady: false,
  };
  if (!signedIn) return empty;
  try {
    const [upcoming, live, mine, leagues] = await Promise.all([
      api<{ matches: MatchCard[] }>("/matches?bucket=upcoming"),
      api<{ matches: MatchCard[] }>("/matches?bucket=live"),
      api<{ contests: ContestCard[] }>("/me/contests"),
      api<{ leagues: LeagueCard[] }>("/leagues/mine"),
    ]);
    const candidates = [...upcoming.matches, ...live.matches].slice(0, 6);
    let matchSelected = false;
    let xiSaved = false;
    let captainSet = false;
    let viceSet = false;
    for (const match of candidates) {
      try {
        const mineTeam = await api<{
          team: { id: string } | null;
          latest: { playerIds: string[]; captainId: string; viceId: string; validationResult?: { valid: boolean } } | null;
        }>(`/matches/${match.id}/my-team`);
        if (mineTeam.team) matchSelected = true;
        if (mineTeam.latest?.playerIds?.length === 11) {
          xiSaved = true;
          captainSet = Boolean(mineTeam.latest.captainId);
          viceSet = Boolean(mineTeam.latest.viceId);
          break;
        }
      } catch {
        /* ignore per-match */
      }
    }
    // Also honour in-session saved XI when API round-trip is sparse.
    if (state.teamVersionId && state.teamMatchId) {
      matchSelected = true;
      xiSaved = true;
      captainSet = true;
      viceSet = true;
    }
    const freeJoined =
      mine.contests.some((c) => c.contestKind === "FREE") ||
      leagues.leagues.some((l) => l.youJoined || l.isOwner);
    // Leaderboard step requires an explicit view event — never infer from join/live/completed.
    const leaderboardReady = leaderboardViewed();
    return { signedIn, matchSelected, xiSaved, captainSet, viceSet, freeJoined, leaderboardReady };
  } catch {
    return empty;
  }
}



interface MatchCard {
  id: string;
  competition: string;
  kickoffAt: string;
  status: string;
  venue: string | null;
  canBuildXi: boolean;
  bucket: "upcoming" | "live" | "completed";
  home: { id: string; name: string; shortName: string };
  away: { id: string; name: string; shortName: string };
}

interface PoolPlayer {
  playerId: string;
  displayName: string;
  shortName: string;
  position: "GK" | "DEF" | "MID" | "FWD";
  clubId: string;
  clubName: string;
  credit: number;
  availability: string;
}

interface ContestCard {
  matchId?: string;
  contestId: string;
  templateId?: string;
  templateCode: string;
  contestType: string;
  contestKind: "FREE" | "PAID_DEVNET";
  entryFeeBaseUnits: number;
  prizePoolBaseUnits?: number;
  capacity: number;
  filledCount: number;
  remaining: number;
  status: string;
  lockTime: string;
  estimatedPrizePoolBaseUnits: number;
  entryId?: string;
  teamVersionId?: string;
  joinedAt?: string;
  matchStatus?: string | null;
  lifecycleBucket?: ContestLifecycleBucket;
  primaryCta?: ContestPrimaryCta;
  hasFinalResult?: boolean;
}

interface Draft {
  playerIds: string[];
  captainId: string;
  viceId: string;
  filter: string;
  query: string;
}

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) throw new Error("missing app root");
const app: HTMLElement = root;

const state: {
  token: string | null;
  authMode: "dev" | "wallet" | null;
  walletAddress: string | null;
  bucket: "upcoming" | "live" | "completed";
  myBucket: "upcoming" | "live" | "completed";
  showPaidDevnet: boolean;
  creditCap: number;
  maxPlayersFromOneTeam: number | null;
  draft: Draft;
  teamVersionId: string | null;
  teamMatchId: string | null;
  joinNote: string;
  joinPhase: string;
  depositPlan: DepositPlan | null;
  depositSignature: string | null;
  publicCluster: string;
  loading: boolean;
  error: string | null;
  environment: string | null;
} = {
  token: sessionStorage.getItem("kickr.session.token") ?? sessionStorage.getItem("kickr.dev.token"),
  authMode: (sessionStorage.getItem("kickr.auth.mode") as "dev" | "wallet" | null) ?? (sessionStorage.getItem("kickr.dev.token") ? "dev" : null),
  walletAddress: sessionStorage.getItem("kickr.auth.wallet"),
  bucket: "upcoming",
  myBucket: "upcoming",
  showPaidDevnet: false,
  creditCap: 100,
  maxPlayersFromOneTeam: null,
  draft: { playerIds: [], captainId: "", viceId: "", filter: "ALL", query: "" },
  teamVersionId: sessionStorage.getItem("kickr.dev.teamVersion"),
  teamMatchId: sessionStorage.getItem("kickr.dev.teamMatch"),
  joinNote: "",
  joinPhase: "",
  depositPlan: null,
  depositSignature: null,
  publicCluster: "devnet",
  loading: false,
  error: null,
  environment: null,
};

let devDepositKey: Keypair | null = null;

function route(): string {
  return location.hash || "#/";
}

function kickoffLabel(iso: string): string {
  return new Intl.DateTimeFormat(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(new Date(iso));
}

function formatUsdc(baseUnits: number): string {
  const whole = Math.trunc(baseUnits / 1_000_000);
  const fraction = Math.abs(baseUnits % 1_000_000);
  if (fraction === 0) return String(whole);
  return `${whole}.${String(fraction).padStart(6, "0").replace(/0+$/, "")}`;
}

function statusChip(status: string, bucket?: string): string {
  const label = status.replaceAll("_", " ");
  const kind = bucket === "live" || status === "LIVE" || status === "HALFTIME"
    ? "live"
    : bucket === "completed" || status === "FINAL" || status === "FULL_TIME" || status === "DATA_FINALIZING"
      ? "completed"
      : "upcoming";
  return `<span class="status-chip ${kind}">${escapeText(label)}</span>`;
}

function formatUpdated(iso: string | null | undefined): string {
  if (!iso) return "—";
  try {
    return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json()) as T & { error?: { message: string; details?: { errors: Array<{ message: string }> } } };
  if (!response.ok) {
    const details = body.error?.details?.errors?.map((error) => error.message).join(" ");
    throw new Error(details || body.error?.message || "Request failed");
  }
  return body;
}

async function runtimeEnvironment(): Promise<string> {
  if (state.environment) return state.environment;
  try {
    const body = await (await fetch("/v1/config/public")).json() as { environment?: string };
    state.environment = body.environment ?? "development";
  } catch {
    state.environment = "development";
  }
  return state.environment;
}

function persistSession(input: { token: string; mode: "dev" | "wallet"; walletAddress: string }): void {
  state.token = input.token;
  state.authMode = input.mode;
  state.walletAddress = input.walletAddress;
  sessionStorage.setItem("kickr.session.token", input.token);
  sessionStorage.setItem("kickr.auth.mode", input.mode);
  sessionStorage.setItem("kickr.auth.wallet", input.walletAddress);
  if (input.mode === "dev") sessionStorage.setItem("kickr.dev.token", input.token);
  else sessionStorage.removeItem("kickr.dev.token");
}

async function signInDevelopment(): Promise<void> {
  if ((await runtimeEnvironment()) === "production") throw new Error("Development signer is disabled");
  const pair = nacl.sign.keyPair();
  const walletAddress = bs58.encode(pair.publicKey);
  const nonce = await api<{ message: string }>("/v1/auth/nonce", { method: "POST", body: JSON.stringify({ walletAddress }) });
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(nonce.message), pair.secretKey));
  const session = await api<{ token: string; account: { walletAddress: string } }>("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ walletAddress, message: nonce.message, signature }),
  });
  persistSession({ token: session.token, mode: "dev", walletAddress: session.account.walletAddress });
}

async function signInWithWallet(): Promise<void> {
  const wallet = readBrowserWallet();
  if (!wallet) throw new Error("No Phantom/Solflare provider found.");
  const result = await loginWithBrowserWallet({
    wallet,
    requestNonce: async (walletAddress) =>
      api<{ message: string }>("/v1/auth/nonce", { method: "POST", body: JSON.stringify({ walletAddress }) }),
    requestLogin: async (body) =>
      api<{ token: string; account: { walletAddress: string } }>("/v1/auth/login", { method: "POST", body: JSON.stringify(body) }),
  });
  persistSession({ token: result.token, mode: "wallet", walletAddress: result.walletAddress });
}

function shell(title: string, body: string): string {
  const hash = route();
  const auth = state.token
    ? state.authMode === "wallet" && state.walletAddress
      ? `Wallet · ${shortWallet(state.walletAddress)}`
      : "Dev signer"
    : "";
  return `<div class="shell">
    <div class="top">
      <div class="brand">KICKR</div>
      <div class="nav">
        <a href="#/" ${hash === "#/" || hash.startsWith("#/matches") ? 'aria-current="page"' : ""}>Matches</a>
        <a href="#/my-contests" ${hash.startsWith("#/my-contests") ? 'aria-current="page"' : ""}>My Contests</a>
        <a href="#/leagues" ${hash.startsWith("#/leagues") ? 'aria-current="page"' : ""}>Leagues</a>
        <a href="#/profile" ${hash.startsWith("#/profile") || hash.startsWith("#/u/") ? 'aria-current="page"' : ""}>Profile</a>
      </div>
      <div class="quiet auth-label" data-auth-label>${escapeText(auth)}</div>
    </div>
    <h1>${title}</h1>
    ${state.error ? `<div class="error">${escapeText(state.error)}</div>` : ""}
    ${body}
    <p class="note">FREE contests &amp; private leagues need no USDC. Credits are a squad budget, not money. Paid Devnet contests stay available only in development.</p>
  </div>`;
}

function loading(label = "Loading…"): string {
  return `<div class="loading">${escapeText(label)}</div><div class="skeleton" aria-hidden="true"></div>`;
}

function empty(label: string): string {
  return `<div class="empty">${escapeText(label)}</div>`;
}

async function render(): Promise<void> {
  state.error = null;
  const hash = route();
  try {
    if (!state.token) {
      app.innerHTML = shell(
        "Fantasy football, free to play.",
        `<p class="quiet">Build an XI, join FREE contests, climb the leaderboard.</p>
         <div class="row">
           <button class="primary" id="signin-wallet">Connect wallet</button>
           ${(await runtimeEnvironment()) === "production" ? "" : '<button class="ghost" id="signin-dev">Sign in (development)</button>'}
         </div>
         <p class="note" id="auth-note"></p>`,
      );
      document.querySelector("#signin-dev")?.addEventListener("click", () => {
        void signInDevelopment().then(render).catch((error) => {
          const note = document.querySelector("#auth-note");
          if (note) note.textContent = error instanceof Error ? error.message : "Sign-in failed";
        });
      });
      document.querySelector("#signin-wallet")?.addEventListener("click", () => {
        void signInWithWallet().then(render).catch((error) => {
          const note = document.querySelector("#auth-note");
          if (note) note.textContent = error instanceof Error ? error.message : "Wallet sign-in failed";
        });
      });
      return;
    }
        if (hash === "#/leagues" || hash === "#/leagues/") {
      await renderLeaguesHome();
      return;
    }
    if (hash === "#/leagues/create") {
      await renderLeagueCreate();
      return;
    }
    if (hash.startsWith("#/share/contest/")) {
      await renderShareContest(hash.split("/")[3] ?? "");
      return;
    }
    if (hash.startsWith("#/share/league/")) {
      await renderShareLeague(hash.split("/")[3] ?? "");
      return;
    }
    if (hash.startsWith("#/leagues/join/")) {
      await renderLeagueJoin(decodeURIComponent(hash.split("/")[3] ?? ""));
      return;
    }
    if (hash.startsWith("#/leagues/") && hash.endsWith("/leaderboard")) {
      await renderLeagueLeaderboard(hash.split("/")[2] ?? "");
      return;
    }
    if (hash.startsWith("#/leagues/") && hash.split("/").length === 3) {
      await renderLeagueDetail(hash.split("/")[2] ?? "");
      return;
    }
    if (hash === "#/profile") {
      await renderProfile(state.walletAddress);
      return;
    }
    if (hash.startsWith("#/u/")) {
      await renderProfile(decodeURIComponent(hash.slice(4)));
      return;
    }
    if (hash === "#/my-contests") {
      await renderMyContests();
      return;
    }
    if (hash.startsWith("#/contests/") && hash.endsWith("/result")) {
      await renderResult(hash.split("/")[2] ?? "");
      return;
    }
    if (hash.startsWith("#/contests/") && hash.endsWith("/leaderboard")) {
      await renderLeaderboard(hash.split("/")[2] ?? "");
      return;
    }
    if (hash.startsWith("#/matches/") && hash.endsWith("/xi")) {
      await renderBuilder(hash.split("/")[2] ?? "");
      return;
    }
    if (hash.startsWith("#/matches/") && hash.endsWith("/contests")) {
      await renderContests(hash.split("/")[2] ?? "");
      return;
    }
    if (hash.startsWith("#/matches/")) {
      await renderDetail(hash.split("/")[2] ?? "");
      return;
    }
    await renderList();
  } catch (error) {
    state.error = error instanceof Error ? error.message : "Something went wrong";
    app.innerHTML = shell("Error", empty(state.error));
  }
}

function matchTile(match: MatchCard): string {
  return `<div class="match-tile">
    <div class="team-side"><div class="crest">${escapeText(initials(match.home.name))}</div><div><strong>${escapeText(match.home.name)}</strong><div class="quiet">${escapeText(match.home.shortName)}</div></div></div>
    <div class="kickoff">${escapeText(kickoffLabel(match.kickoffAt))}<div style="margin-top:6px">${statusChip(match.status, match.bucket)}</div></div>
    <div class="team-side away"><div class="crest">${escapeText(initials(match.away.name))}</div><div><strong>${escapeText(match.away.name)}</strong><div class="quiet">${escapeText(match.away.shortName)}</div></div></div>
  </div>`;
}

async function renderList(): Promise<void> {
  app.innerHTML = shell("Upcoming matches", loading());
  const data = await api<{ matches: MatchCard[]; creditCap: number; maxPlayersFromOneTeam: number | null }>(`/matches?bucket=${state.bucket}`);
  state.creditCap = data.creditCap;
  state.maxPlayersFromOneTeam = data.maxPlayersFromOneTeam;
  const cards = data.matches.map((match) => `<article class="card">
      <div class="meta"><span>${escapeText(match.competition)}</span>${statusChip(match.status, match.bucket)}<span>${match.canBuildXi ? "XI open" : "XI locked"}</span></div>
      ${matchTile(match)}
      <div class="row">
        <button class="ghost" data-contests="${match.id}">Contests</button>
        <button class="primary" data-build="${match.id}" ${match.canBuildXi ? "" : "disabled"}>${match.canBuildXi ? "Build XI" : match.bucket === "live" ? "View live" : "Closed"}</button>
      </div>
    </article>`).join("");
  const progress = await loadOnboardingProgress();
  const onboard = onboardingChecklistHtml(onboardingSeen(), [
    { done: progress.signedIn, label: "Connect / sign in", href: "#/" },
    { done: progress.matchSelected, label: "Choose a match", href: "#/" },
    { done: progress.xiSaved && progress.captainSet && progress.viceSet, label: "Build XI + captain/vice", href: "#/" },
    { done: progress.freeJoined, label: "Join a FREE contest or league", href: "#/leagues" },
    { done: progress.leaderboardReady, label: "Follow the leaderboard", href: "#/my-contests" },
  ]);
  app.innerHTML = shell("Matches", `
    ${onboard}
    <div class="tabs">
      ${(["upcoming", "live", "completed"] as const).map((bucket) => `<button type="button" data-bucket="${bucket}" aria-pressed="${state.bucket === bucket}">${bucket}</button>`).join("")}
    </div>
    ${cards || empty("No matches in this view. Try LOCAL_DEV / DEMO Cup fixtures.")}
  `);
  bindOnboardingDismiss();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-bucket]")) {
    button.addEventListener("click", () => {
      state.bucket = button.dataset.bucket as typeof state.bucket;
      void render();
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-contests]")) {
    button.addEventListener("click", () => { location.hash = `#/matches/${button.dataset.contests}/contests`; });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-build]")) {
    button.addEventListener("click", () => { location.hash = `#/matches/${button.dataset.build}/xi`; });
  }
}

async function renderDetail(id: string): Promise<void> {
  app.innerHTML = shell("Match", loading());
  const data = await api<{ match: MatchCard }>(`/matches/${id}`);
  const match = data.match;
  app.innerHTML = shell(escapeText(matchTitle(match)), `
    <div class="meta"><span>${escapeText(match.competition)}</span>${statusChip(match.status, match.bucket)}</div>
    ${matchTile(match)}
    <div class="row">
      <a class="back-link" href="#/">← Matches</a>
      <button class="ghost" id="to-contests">Contests</button>
      <button class="primary" id="to-xi" ${match.canBuildXi ? "" : "disabled"}>${match.canBuildXi ? "Build XI" : "XI locked"}</button>
    </div>
  `);
  document.querySelector("#to-contests")?.addEventListener("click", () => { location.hash = `#/matches/${id}/contests`; });
  document.querySelector("#to-xi")?.addEventListener("click", () => { location.hash = `#/matches/${id}/xi`; });
}

function contestTitle(card: ContestCard): string {
  if (card.contestKind === "FREE") {
    if (card.contestType === "HEAD_TO_HEAD") return "FREE Head to Head";
    if (card.contestType === "GRAND_LEAGUE") return "FREE Grand League";
    return "FREE Contest";
  }
  const dollars = formatUsdc(card.entryFeeBaseUnits);
  if (card.contestType === "HEAD_TO_HEAD") return `H2H $${dollars}`;
  if (card.contestType === "GRAND_LEAGUE") return `Grand League $${dollars}`;
  return `WTA $${dollars}`;
}

function contestBadge(card: ContestCard): string {
  if (card.contestKind === "FREE") return `<span class="badge badge-free">FREE</span>`;
  return `<span class="badge badge-paid">PAID DEVNET</span>`;
}

async function renderContests(matchId: string): Promise<void> {
  app.innerHTML = shell("Contests", loading());
  const env = await runtimeEnvironment();
  const data = await api<{ contests: ContestCard[] }>(`/matches/${matchId}/contests`);
  const free = data.contests.filter((c) => c.contestKind === "FREE");
  const paid = data.contests.filter((c) => c.contestKind !== "FREE");
  const renderCard = (contest: ContestCard, disabledPaid: boolean) => {
    const joinable = contestAcceptsNewEntry(contest.status) && !(disabledPaid && contest.contestKind !== "FREE");
    return `<article class="card">
      <div class="meta"><span>${escapeText(contest.templateCode)}</span>${contestBadge(contest)}</div>
      <h2>${escapeText(contestTitle(contest))}</h2>
      <p class="quiet">${contest.filledCount}/${contest.capacity} spots · ${escapeText(contest.status.replaceAll("_", " "))}</p>
      ${contest.contestKind === "FREE"
        ? `<p class="quiet">No USDC entry · No monetary prize · Rank & points only</p>`
        : `<p class="quiet">${formatUsdc(contest.entryFeeBaseUnits)} USDC entry · Devnet only${disabledPaid ? " · Disabled in production" : ""}</p>`}
      <div class="row">
        ${joinable
          ? `<button class="primary" data-join="${contest.contestId}" data-kind="${contest.contestKind}">${contest.contestKind === "FREE" ? "Join FREE" : "Join (paid)"}</button>`
          : `<p class="quiet">${disabledPaid && contest.contestKind !== "FREE" ? "Paid contests disabled" : "Closed to new entries"}</p>`}
        <button class="ghost" data-board="${contest.contestId}">Leaderboard</button>
      </div>
    </article>`;
  };
  const paidDisabled = env === "production";
  const showPaid = !paidDisabled && state.showPaidDevnet && paid.length > 0;
  const paidSection = paidDisabled || paid.length === 0
    ? ""
    : showPaid
      ? `<section class="dev-only-panel" style="margin-top:24px">
          <div class="meta"><h2 style="margin:0">Paid Devnet (development only)</h2>
            <button type="button" class="ghost" id="hide-paid">Hide</button></div>
          <p class="quiet">Not part of the FREE journey. Requires USDC on Devnet. Disabled in production.</p>
          ${paid.map((c) => renderCard(c, false)).join("")}
        </section>`
      : `<div class="row" style="margin-top:24px">
          <button type="button" class="ghost" id="show-paid">Show Paid Devnet contests (dev only)</button>
        </div>`;
  let matchName = "Match";
  try {
    const m = await api<{ match: MatchCard }>(`/matches/${matchId}`);
    matchName = matchTitle(m.match);
  } catch { /* ignore */ }
  app.innerHTML = shell("Choose a contest", `
    <div class="row"><a class="back-link" href="#/matches/${matchId}">← <strong>${escapeText(matchName)}</strong></a><a class="quiet" href="#/">All matches</a></div>
    <h2 style="margin-top:18px">FREE to play</h2>
    <p class="quiet">No USDC · No monetary prize · Rank &amp; points only</p>
    ${free.map((c) => renderCard(c, false)).join("") || empty("No FREE contests yet.")}
    ${paidSection}
    <p class="note" id="join-note">${escapeText(state.joinNote)}</p>
  `);
  document.querySelector("#show-paid")?.addEventListener("click", () => {
    state.showPaidDevnet = true;
    void renderContests(matchId);
  });
  document.querySelector("#hide-paid")?.addEventListener("click", () => {
    state.showPaidDevnet = false;
    void renderContests(matchId);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-join]")) {
    button.addEventListener("click", () => {
      void joinContest(matchId, button.dataset.join ?? "", (button.dataset.kind as ContestCard["contestKind"]) ?? "FREE");
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-board]")) {
    button.addEventListener("click", () => { location.hash = `#/contests/${button.dataset.board}/leaderboard`; });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-result]")) {
    button.addEventListener("click", () => { location.hash = `#/contests/${button.dataset.result}/result`; });
  }
}

async function joinContest(matchId: string, contestId: string, kind: ContestCard["contestKind"]): Promise<void> {
  if (!state.teamVersionId || state.teamMatchId !== matchId) {
    state.joinNote = "Save an XI for this match before joining.";
    await renderContests(matchId);
    return;
  }
  state.joinNote = kind === "FREE" ? "Joining FREE contest…" : "Reserving paid seat…";
  await renderContests(matchId);
  try {
    if (kind === "FREE") {
      const joined = await api<{ confirmed: boolean; payment: string; entry: { status: string } }>(
        `/contests/${contestId}/free-join`,
        { method: "POST", body: JSON.stringify({ teamVersionId: state.teamVersionId }) },
      );
      if (!joined.confirmed || joined.payment !== "FREE_NO_PAYMENT" || joined.entry.status !== "CONFIRMED") {
        throw new Error("FREE join did not confirm");
      }
      state.joinNote = "Joined FREE contest. Entry confirmed — no USDC required.";
      state.joinPhase = "CONFIRMED";
    } else {
      await loadPublicEscrow();
      const reserved = await api<{
        payment: string;
        reservation: { id: string; status: string };
        entry: { status: string };
        depositPlan: DepositPlan | null;
      }>(`/contests/${contestId}/reservations`, {
        method: "POST",
        body: JSON.stringify({ teamVersionId: state.teamVersionId }),
      });
      if (reserved.reservation.status !== "PENDING" || !reserved.depositPlan) {
        throw new Error("Paid reservation failed or mint not configured");
      }
      state.depositPlan = reserved.depositPlan;
      sessionStorage.setItem("kickr.dev.reservation", reserved.reservation.id);
      state.joinNote = "Paid reservation ready. Sign deposit in the wallet flow (devnet only).";
      await signDeposit(matchId);
      return;
    }
  } catch (error) {
    state.joinNote = error instanceof Error ? error.message : "Join failed";
  }
  await renderContests(matchId);
}

async function loadPublicEscrow(): Promise<void> {
  const config = await api<{ solanaCluster: string }>("/v1/config/public");
  state.publicCluster = config.solanaCluster;
  assertDevCluster(config.solanaCluster);
}

async function signDeposit(matchId: string): Promise<void> {
  const plan = state.depositPlan;
  const reservationId = sessionStorage.getItem("kickr.dev.reservation");
  if (!plan || !reservationId) {
    state.joinNote = "No deposit plan.";
    await renderContests(matchId);
    return;
  }
  try {
    assertDevCluster(plan.cluster);
    const connection = new Connection(publicRpcForCluster(plan.cluster), "finalized");
    const blockhash = await connection.getLatestBlockhash("finalized");
    if (!devDepositKey) devDepositKey = Keypair.generate();
    const tx = buildDepositTransaction({ plan, feePayer: devDepositKey.publicKey, recentBlockhash: blockhash.blockhash });
    tx.sign(devDepositKey);
    const signature = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: false });
    state.depositSignature = signature;
    await api(`/reservations/${reservationId}/deposit-submission`, {
      method: "POST",
      body: JSON.stringify({ signature }),
    });
    state.joinNote = "Deposit submitted. Waiting for indexer confirmation…";
  } catch (error) {
    state.joinNote = error instanceof Error ? error.message : "Deposit failed";
  }
  await renderContests(matchId);
}

function resolveLifecycle(contest: ContestCard): ContestLifecycleBucket {
  if (contest.lifecycleBucket) return contest.lifecycleBucket;
  return classifyContestLifecycle({
    matchStatus: contest.matchStatus,
    hasFinalResult: contest.hasFinalResult,
  });
}

function myContestActions(contest: ContestCard): string {
  const bucket = resolveLifecycle(contest);
  const cta = contest.primaryCta ?? contestPrimaryCta(bucket);
  if (cta === "view_result") {
    return `<div class="row">
        <button class="ghost" data-board="${contest.contestId}">Leaderboard</button>
        <button class="primary" data-result="${contest.contestId}">View result</button>
      </div>`;
  }
  if (cta === "live_leaderboard") {
    return `<div class="row">
        <button class="primary" data-board="${contest.contestId}">Live leaderboard</button>
        <button class="ghost" data-view="${contest.contestId}">View contest</button>
      </div>`;
  }
  return `<div class="row">
        <button class="primary" data-view="${contest.contestId}">View contest</button>
        <button class="ghost" data-board="${contest.contestId}">Leaderboard</button>
      </div>`;
}

async function renderMyContests(): Promise<void> {
  app.innerHTML = shell("My Contests", loading());
  const data = await api<{ contests: ContestCard[] }>("/me/contests");
  // Mutually exclusive tabs from match/result lifecycle (API-enriched when present).
  const rows = data.contests.filter((contest) => resolveLifecycle(contest) === state.myBucket);
  const cards = rows.map((contest) => {
    const life = resolveLifecycle(contest);
    return `<article class="card">
      <div class="meta"><span>${escapeText(contest.templateCode)}</span>${contestBadge(contest)}${statusChip(contest.matchStatus ?? life, life)}</div>
      <h2>${escapeText(contestTitle(contest))}</h2>
      <p class="quiet">${escapeText(contest.status.replaceAll("_", " "))} · ${contest.filledCount}/${contest.capacity} filled</p>
      ${myContestActions(contest)}
    </article>`;
  }).join("");
  app.innerHTML = shell("My Contests", `
    <div class="tabs">
      ${(["upcoming", "live", "completed"] as const).map((bucket) => `<button type="button" data-my="${bucket}" aria-pressed="${state.myBucket === bucket}">${bucket}</button>`).join("")}
    </div>
    ${cards || empty(`No ${state.myBucket} contests. Join a FREE contest from a match.`)}
  `);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-my]")) {
    button.addEventListener("click", () => {
      state.myBucket = button.dataset.my as typeof state.myBucket;
      void render();
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-board]")) {
    button.addEventListener("click", () => { location.hash = `#/contests/${button.dataset.board}/leaderboard`; });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-result]")) {
    button.addEventListener("click", () => { location.hash = `#/contests/${button.dataset.result}/result`; });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-view]")) {
    button.addEventListener("click", () => {
      const id = button.dataset.view ?? "";
      const row = data.contests.find((c) => c.contestId === id);
      if (row?.matchId) location.hash = `#/matches/${row.matchId}/contests`;
      else location.hash = `#/contests/${id}/leaderboard`;
    });
  }
}

async function renderLeaderboard(contestId: string): Promise<void> {
  app.innerHTML = shell("Leaderboard", loading());
  const contestResp = await api<{ contest: ContestCard }>(`/contests/${contestId}`);
  const card = contestResp.contest;
  let matchLabel = "";
  if (card.matchId) {
    try {
      const matchResp = await api<{ match: MatchCard }>(`/matches/${card.matchId}`);
      card.matchStatus = matchResp.match.status;
      card.lifecycleBucket = classifyContestLifecycle({
        matchStatus: matchResp.match.status,
        hasFinalResult: card.hasFinalResult,
      });
      card.primaryCta = contestPrimaryCta(card.lifecycleBucket);
      matchLabel = matchTitle(matchResp.match);
    } catch {
      /* keep defaults */
    }
  }
  let updatedAt: string | null = null;
  let freshness: string | null = null;
  let staleNote = "";
  let rowsHtml: string;
  try {
    const board = await api<{
      freshness?: string;
      timestamps?: { updatedAt?: string };
      leaderboard: Array<{
        entryId: string;
        contestId: string;
        wallet: string;
        milliPoints: number;
        rank: number;
        priorRank?: number | null;
        scoreDelta?: number | null;
      }>;
    }>(`/contests/${contestId}/leaderboard`);
    freshness = board.freshness ?? null;
    updatedAt = board.timestamps?.updatedAt ?? null;
    // Server already contest-scopes + re-ranks; never display global match ranks.
    if (board.leaderboard.length) {
      rowsHtml = board.leaderboard.map((row) =>
        lbRowHtml({
          rank: row.rank,
          label: shortWallet(row.wallet),
          milliPoints: row.milliPoints,
          you: row.wallet === state.walletAddress,
          priorRank: row.priorRank,
          scoreDelta: row.scoreDelta,
        }),
      ).join("");
    } else {
      rowsHtml = empty("No scored entries yet for this contest.");
    }
    staleNote = freshnessBannerHtml(freshness);
  } catch {
    rowsHtml = empty("Could not load leaderboard.");
  }
  markLeaderboardViewed();
  const bucket = resolveLifecycle(card);
  const live = bucket === "live";
  const resultBtn = bucket === "completed"
    ? `<button class="primary" id="to-result">View result</button>`
    : `<button class="ghost" id="to-result">My result</button>`;
  app.innerHTML = shell(live ? "Live leaderboard" : "Leaderboard", `
    <div class="lb-head">
      <div class="meta">${contestBadge(card)}<span>${escapeText(contestTitle(card))}</span>${live ? '<span class="badge badge-live">LIVE</span>' : statusChip(card.matchStatus ?? bucket, bucket)}</div>
      <div class="quiet">Updated ${escapeText(formatUpdated(updatedAt))}${freshness ? ` · ${escapeText(freshnessChipLabel(freshness))}` : ""}</div>
    </div>
    ${matchLabel ? `<p class="quiet" style="margin:4px 0 12px">${escapeText(matchLabel)}</p>` : ""}
    ${staleNote}
    <div class="leaderboard">${rowsHtml}</div>
    <div class="row" style="margin-top:16px">
      <a class="back-link" href="#/my-contests">← My Contests</a>
      ${resultBtn}
    </div>
  `);
  document.querySelector("#to-result")?.addEventListener("click", () => {
    location.hash = `#/contests/${contestId}/result`;
  });
}

async function renderResult(contestId: string): Promise<void> {
  app.innerHTML = shell("Your result", loading());
  try {
    const result = await api<{
      contestKind?: string;
      contestName?: string;
      contestType?: string;
      templateCode?: string;
      claimUiState: string;
      rank: number | null;
      finalScoreMilliPoints: number | null;
      totalEntries: number;
      prizeBaseUnits: number | null;
      claimPlan: ClaimPlan | null;
      stages: string[];
      entryId: string;
      captainId: string | null;
      viceId: string | null;
      creditsUsed: number | null;
      monetaryPrize?: boolean;
      freeContest?: boolean;
      match: {
        id: string;
        competition: string;
        kickoffAt: string;
        status: string;
        home: { name: string; shortName: string };
        away: { name: string; shortName: string };
      } | null;
      xiSummary: Array<{
        playerId: string;
        displayName: string;
        shortName: string;
        position: string;
        clubName: string;
        isCaptain: boolean;
        isVice: boolean;
      }>;
      topLeaderboard: Array<{
        entryId: string;
        wallet: string;
        rank: number;
        finalScoreMilliPoints: number;
        isYou: boolean;
      }>;
    }>(`/contests/${contestId}/my-result`);
    const score = result.finalScoreMilliPoints == null ? "—" : (result.finalScoreMilliPoints / 1000).toFixed(1);
    const isFree = result.contestKind === "FREE" || result.freeContest === true || (result.prizeBaseUnits === 0 && !result.claimPlan);
    const captain = result.xiSummary?.find((p) => p.isCaptain);
    const vice = result.xiSummary?.find((p) => p.isVice);
    const matchLabel = result.match
      ? matchTitle(result.match)
      : "Match";
    const contestLabel = result.contestName ?? result.templateCode ?? result.contestType ?? "Contest";

    let claimHtml = "";
    if (isFree) {
      claimHtml = `
        <div class="free-banner">
          <strong>FREE contest</strong>
          <span>No entry fee · No monetary prize · Rank &amp; score only</span>
        </div>`;
    } else if (result.claimUiState === "claimable" && result.claimPlan) {
      claimHtml = `<button class="primary" id="claim-btn">Claim Prize</button><p class="quiet">Paid Devnet only. Not paid until independently verified.</p>`;
    } else {
      claimHtml = `<p class="quiet">Claim state: ${escapeText(result.claimUiState)}</p>`;
    }

    const xiByPos = (pos: string) =>
      (result.xiSummary ?? [])
        .filter((p) => p.position === pos)
        .map((p) =>
          playerChip({
            displayName: p.displayName,
            shortName: p.shortName,
            role: p.isCaptain ? "C" : p.isVice ? "VC" : "",
          }),
        )
        .join("") || `<div class="chip quiet">${pos}</div>`;

    const boardHtml = (result.topLeaderboard ?? []).length
      ? result.topLeaderboard.map((row) =>
          lbRowHtml({
            rank: row.rank,
            label: row.wallet.length > 10 ? `${row.wallet.slice(0, 4)}…${row.wallet.slice(-4)}` : row.wallet,
            milliPoints: row.finalScoreMilliPoints,
            you: row.isYou,
          }),
        ).join("")
      : empty("Leaderboard pending finalization.");

    app.innerHTML = shell("Final result", `
      <article class="card result-hero">
        <div class="meta">
          <span>${escapeText((result.stages ?? []).join(" → "))}</span>
          <span class="badge ${isFree ? "badge-free" : "badge-paid"}">${escapeText(isFree ? "FREE" : (result.contestKind ?? "RESULT"))}</span>
        </div>
        <p class="quiet result-kicker">${escapeText(contestLabel)} · ${escapeText(result.contestType ?? "")}</p>
        <h2>${escapeText(matchLabel)}</h2>
        <p class="quiet">${result.match ? escapeText(result.match.competition) + " · " + escapeText(kickoffLabel(result.match.kickoffAt)) : ""}</p>
        <div class="result-stats">
          <div><span class="quiet">Final rank</span><strong class="rank-hero">#${result.rank ?? "—"}</strong><span class="quiet">of ${result.totalEntries}</span></div>
          <div><span class="quiet">Final score</span><strong>${score}</strong><span class="quiet">pts</span></div>
          <div><span class="quiet">Entrants</span><strong>${result.totalEntries}</strong></div>
        </div>
        ${claimHtml}
        <div id="claim-target"></div>
      </article>

      <article class="card">
        <div class="meta"><span>Your XI</span><span class="quiet">${result.creditsUsed != null ? `${result.creditsUsed} credits` : ""}</span></div>
        <div class="row" style="margin:10px 0">
          <span>Captain <strong>${escapeText(captain?.displayName ?? "—")}</strong> <span class="badge badge-c">C</span></span>
          <span>Vice <strong>${escapeText(vice?.displayName ?? "—")}</strong> <span class="badge badge-vc">VC</span></span>
        </div>
        <div class="pitch result-pitch">
          <div class="line">${xiByPos("FWD")}</div>
          <div class="line">${xiByPos("MID")}</div>
          <div class="line">${xiByPos("DEF")}</div>
          <div class="line">${xiByPos("GK")}</div>
        </div>
      </article>

      <article class="card">
        <div class="meta"><span>Top of the table</span><span class="quiet">Final</span></div>
        <div class="leaderboard" style="margin-top:12px">${boardHtml}</div>
      </article>

      <div id="share-slot"></div>
      <div class="row" style="margin-top:8px">
        <a class="quiet" href="#/contests/${contestId}/leaderboard">Full leaderboard</a>
        <a class="quiet" href="#/my-contests">My Contests</a>
        <button class="ghost" id="load-share">Share FREE result</button>
      </div>
    `);
    document.querySelector("#claim-btn")?.addEventListener("click", () => {
      const target = document.querySelector("#claim-target");
      if (target) void startClaim(contestId, result.entryId, target);
    });
    document.querySelector("#load-share")?.addEventListener("click", () => {
      location.hash = `#/share/contest/${contestId}`;
    });
  } catch (error) {
    app.innerHTML = shell("Your result", empty(error instanceof Error ? error.message : "No confirmed entry yet."));
  }
}

async function startClaim(contestId: string, entryId: string, target: Element): Promise<void> {
  target.innerHTML = `<p class="quiet">Fetching claim plan…</p>`;
  try {
    await loadPublicEscrow();
    const me = await api<{ walletAddress: string }>("/v1/me");
    const plan = await api<ClaimPlan & { claimUiState?: string; settlementId: string }>(
      `/entries/${entryId}/claim?contestId=${contestId}`,
    );
    if (plan.claimStatus === "CLAIMED" || plan.claimUiState === "already_claimed") {
      target.innerHTML = `<p>Already claimed</p>`;
      return;
    }
    const wallet = readBrowserWallet();
    if (!wallet) {
      target.innerHTML = `<p class="error">Connect a wallet to claim.</p>`;
      return;
    }
    let connected = wallet.publicKey;
    if (!connected) connected = await wallet.connect();
    assertWalletClaimInvariant({
      principalWallet: me.walletAddress,
      connectedWallet: connected.toBase58(),
      destinationWallet: plan.destinationWallet,
    });
    const submitted = await signAndSubmitClaim({
      plan,
      wallet,
      rpcUrl: publicRpcForCluster(plan.cluster),
      appCluster: state.publicCluster,
      principalWallet: me.walletAddress,
    });
    if (!submitted.signature) {
      target.innerHTML = `<p class="error">${escapeText(submitted.note)}</p>`;
      return;
    }
    await api(`/settlements/${plan.settlementId}/claim-submit`, {
      method: "POST",
      body: JSON.stringify({ entryId: plan.entryId, signature: submitted.signature }),
    });
    target.innerHTML = `<p>Submitted — confirming…</p>`;
  } catch (error) {
    target.innerHTML = `<p class="error">${escapeText(error instanceof Error ? error.message : "Claim failed")}</p>`;
  }
}

async function renderBuilder(matchId: string): Promise<void> {
  app.innerHTML = shell("Build your XI", loading());
  const matchResp = await api<{ match: MatchCard }>(`/matches/${matchId}`);
  const playersResp = await api<{ players: PoolPlayer[] }>(`/matches/${matchId}/players`);
  const rulesResp = await api<{ creditCap: number; maxPlayersFromOneTeam: number | null }>(`/matches?bucket=upcoming`);
  const saved = await api<{
    team: { id: string; status: string } | null;
    latest: { id: string; version: number; playerIds: string[]; captainId: string; viceId: string; creditsUsed: number } | null;
    readOnly: boolean;
  }>(`/matches/${matchId}/my-team`);
  const players = playersResp.players;
  const creditCap = rulesResp.creditCap;
  const maxFromOne = rulesResp.maxPlayersFromOneTeam;
  state.creditCap = creditCap;
  state.maxPlayersFromOneTeam = maxFromOne;
  const readOnly = saved.readOnly || !matchResp.match.canBuildXi;
  // Reload latest saved XI when returning to this match (unless user already has an in-memory draft for it).
  if (saved.latest && (state.teamMatchId !== matchId || state.draft.playerIds.length === 0)) {
    state.draft.playerIds = [...saved.latest.playerIds];
    state.draft.captainId = saved.latest.captainId;
    state.draft.viceId = saved.latest.viceId;
    state.teamVersionId = saved.latest.id;
    state.teamMatchId = matchId;
    sessionStorage.setItem("kickr.dev.teamVersion", saved.latest.id);
    sessionStorage.setItem("kickr.dev.teamMatch", matchId);
  } else if (state.teamMatchId !== matchId) {
    state.draft = { playerIds: [], captainId: "", viceId: "", filter: "ALL", query: "" };
    state.teamVersionId = null;
    state.teamMatchId = matchId;
  }
  const savedTeamId = saved.team?.id ?? null;
  const byId = new Map(players.map((p) => [p.playerId, p]));
  const used = calculateCreditsUsed(state.draft.playerIds.map((id) => byId.get(id)?.credit ?? 0));
  const left = remainingCredits(used, creditCap);
  const homeClubId = matchResp.match.home.id;
  const awayClubId = matchResp.match.away.id;
  const validation = validateFantasyTeam(
    {
      playerIds: state.draft.playerIds,
      captainId: state.draft.captainId,
      viceId: state.draft.viceId,
    },
    players.map((p) => ({
      playerId: p.playerId,
      position: p.position,
      clubId: p.clubId,
      credit: p.credit,
    })),
    homeClubId,
    awayClubId,
    { creditCap, maxPlayersFromOneTeam: maxFromOne },
  );

  const slot = (pos: "GK" | "DEF" | "MID" | "FWD") =>
    state.draft.playerIds
      .map((id) => byId.get(id))
      .filter((p): p is PoolPlayer => !!p && p.position === pos)
      .map((p) =>
        playerChip({
          displayName: p.displayName,
          shortName: p.shortName,
          role: p.playerId === state.draft.captainId ? "C" : p.playerId === state.draft.viceId ? "VC" : "",
          selected: true,
        }),
      )
      .join("") || `<div class="chip quiet">${pos}</div>`;

  const filtered = players.filter((p) => {
    if (state.draft.filter !== "ALL" && p.position !== state.draft.filter) return false;
    if (state.draft.query && !`${p.displayName} ${p.clubName}`.toLowerCase().includes(state.draft.query.toLowerCase())) return false;
    return true;
  });

  const selectedCount = state.draft.playerIds.length;
  const formation = formationLabel(state.draft.playerIds.map((id) => byId.get(id)?.position ?? "MID"));
  const meterClass = left <= 0 ? "meter full" : left <= 10 ? "meter warn" : "meter";
  const title = matchTitle(matchResp.match);
  const lockBanner = readOnly
    ? `<div class="lock-banner"><strong>Read-only</strong><span>Match is locked — you can review this XI but not change it.</span></div>`
    : "";
  const validationHtml = validation.valid
    ? ""
    : `<ul class="errors">${validation.errors.map((e) => `<li>${escapeText(e.message)}</li>`).join("")}</ul>`;

  app.innerHTML = shell(readOnly ? "Your XI" : "Build your XI", `
    <div class="row">
      <a class="back-link" href="#/matches/${matchId}">← <strong>${escapeText(title)}</strong></a>
      <span class="quiet">${escapeText(formation)} · ${selectedCount}/11 selected</span>
    </div>
    ${lockBanner}
    <article class="card">
      <div class="credits-panel">
        <div>
          <div class="quiet">Credits remaining</div>
          <div class="credits-left">${left}</div>
        </div>
        <div class="xi-count">${used} / ${creditCap} used</div>
      </div>
      <div class="${meterClass}"><span style="width:${Math.min(100, (used / creditCap) * 100)}%"></span></div>
      <div class="pitch" style="margin-top:16px">
        <div class="line">${slot("FWD")}</div>
        <div class="line">${slot("MID")}</div>
        <div class="line">${slot("DEF")}</div>
        <div class="line">${slot("GK")}</div>
      </div>
      ${validationHtml}
      <div class="row" style="margin-top:14px">
        ${readOnly
          ? `<span class="pill badge-paid">LOCKED XI</span>`
          : `<button class="primary" id="save-xi" ${validation.valid ? "" : "disabled"}>Save XI</button>`}
        <button class="ghost" id="to-contests">${readOnly ? "View contests" : "Choose contest"}</button>
      </div>
      <p class="note" id="saved">${saved.latest && !readOnly ? `Loaded saved XI v${saved.latest.version} · ${saved.latest.creditsUsed} credits` : readOnly && saved.latest ? `Locked XI v${saved.latest.version}` : "Pick 11 players, then set Captain (C) and Vice (VC)."}</p>
    </article>
    ${readOnly ? "" : `
    <div class="filters">
      ${(["ALL", "GK", "DEF", "MID", "FWD"] as const).map((f) => `<button type="button" data-filter="${f}" aria-pressed="${state.draft.filter === f}">${f}</button>`).join("")}
    </div>
    <input class="search" id="q" placeholder="Search players by name" value="${escapeText(state.draft.query)}" ${readOnly ? "disabled" : ""} />
    <div class="stack">
      ${filtered.map((p) => {
        const selected = state.draft.playerIds.includes(p.playerId);
        const isC = state.draft.captainId === p.playerId;
        const isVc = state.draft.viceId === p.playerId;
        return `<div class="player${selected ? " selected" : ""}">
          <div class="avatar">${escapeText(initials(p.displayName))}</div>
          <div><strong>${escapeText(p.displayName)}</strong><div class="quiet">${escapeText(p.position)} · ${escapeText(p.clubName)} · ${p.credit} cr</div></div>
          <div class="actions">
            <button class="ghost" data-toggle="${p.playerId}" ${readOnly ? "disabled" : ""}>${selected ? "Remove" : "Add"}</button>
            ${selected ? `<button class="ghost" data-cap="${p.playerId}" aria-pressed="${isC}" title="Set captain">C</button><button class="ghost" data-vice="${p.playerId}" aria-pressed="${isVc}" title="Set vice-captain">VC</button>` : ""}
          </div>
        </div>`;
      }).join("") || empty("No players match this filter.")}
    </div>`}
  `);

  document.querySelector("#q")?.addEventListener("input", (event) => {
    state.draft.query = (event.target as HTMLInputElement).value;
    void renderBuilder(matchId);
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
    button.addEventListener("click", () => {
      state.draft.filter = button.dataset.filter ?? "ALL";
      void renderBuilder(matchId);
    });
  }
  if (!readOnly) {
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-toggle]")) {
      button.addEventListener("click", () => {
        const id = button.dataset.toggle ?? "";
        if (state.draft.playerIds.includes(id)) {
          state.draft.playerIds = state.draft.playerIds.filter((x) => x !== id);
          if (state.draft.captainId === id) state.draft.captainId = "";
          if (state.draft.viceId === id) state.draft.viceId = "";
        } else if (state.draft.playerIds.length < 11) {
          state.draft.playerIds = [...state.draft.playerIds, id];
        }
        void renderBuilder(matchId);
      });
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-cap]")) {
      button.addEventListener("click", () => {
        state.draft.captainId = button.dataset.cap ?? "";
        if (state.draft.viceId === state.draft.captainId) state.draft.viceId = "";
        void renderBuilder(matchId);
      });
    }
    for (const button of document.querySelectorAll<HTMLButtonElement>("[data-vice]")) {
      button.addEventListener("click", () => {
        state.draft.viceId = button.dataset.vice ?? "";
        if (state.draft.captainId === state.draft.viceId) state.draft.captainId = "";
        void renderBuilder(matchId);
      });
    }
    document.querySelector("#save-xi")?.addEventListener("click", () => {
      void saveXi(matchId, savedTeamId);
    });
  }
  document.querySelector("#to-contests")?.addEventListener("click", () => {
    location.hash = `#/matches/${matchId}/contests`;
  });
}

async function saveXi(matchId: string, existingTeamId: string | null = null): Promise<void> {
  let teamId = existingTeamId;
  if (!teamId) {
    const created = await api<{ team: { id: string } }>("/teams", {
      method: "POST",
      body: JSON.stringify({ matchId }),
    });
    teamId = created.team.id;
  }
  const saved = await api<{ version: { id: string; version: number; playerIds: string[]; captainId: string; viceId: string } }>(
    `/teams/${teamId}/versions`,
    {
      method: "POST",
      body: JSON.stringify({
        playerIds: state.draft.playerIds,
        captainId: state.draft.captainId,
        viceId: state.draft.viceId,
      }),
    },
  );
  state.teamVersionId = saved.version.id;
  state.teamMatchId = matchId;
  sessionStorage.setItem("kickr.dev.teamVersion", saved.version.id);
  sessionStorage.setItem("kickr.dev.teamMatch", matchId);
  const pending = readLeagueReturn();
  if (pending && pending.matchId === matchId) {
    const note = document.querySelector("#saved");
    if (note) note.textContent = `Saved XI v${saved.version.version}. Returning to confirm join…`;
    location.hash = `#/leagues/join/${encodeURIComponent(pending.inviteCode)}`;
    return;
  }
  const note = document.querySelector("#saved");
  if (note) note.textContent = `Saved version ${saved.version.version}. Continue to contests to join FREE.`;
}


interface LeagueCard {
  id: string;
  name: string;
  matchId: string;
  inviteCode: string;
  invitePath: string;
  capacity: number;
  memberCount: number;
  remaining: number;
  status: string;
  lifecycleBucket: string;
  isOwner: boolean;
  youJoined: boolean;
  free: boolean;
}

async function renderLeaguesHome(): Promise<void> {
  app.innerHTML = shell("Private FREE leagues", loading());
  const data = await api<{ leagues: LeagueCard[] }>("/leagues/mine");
  const cards = data.leagues.map((league) => `<article class="card">
    <div class="meta"><span class="badge badge-free">FREE</span><span>${escapeText(league.status)}</span><span>${escapeText(league.lifecycleBucket)}</span></div>
    <h3>${escapeText(league.name)}</h3>
    <p class="quiet">${league.memberCount} / ${league.capacity} members · invite <span class="mono">${escapeText(league.inviteCode)}</span></p>
    <div class="row">
      <button class="primary" data-league="${league.id}">Open</button>
      <button class="ghost" data-board="${league.id}">Leaderboard</button>
      <button class="ghost" data-copy-invite="${escapeText(league.inviteCode)}">Copy invite</button>
    </div>
  </article>`).join("");
  app.innerHTML = shell("Private FREE leagues", `
    <p class="quiet">Invite-only FREE leagues. No USDC, no prize, no settlement.</p>
    <div class="row league-actions" style="margin-bottom:14px">
      <button class="primary" id="create-league">Create league</button>
      <button class="ghost" id="join-league">Join with invite</button>
    </div>
    <form id="invite-form" class="card league-invite-form" style="margin-bottom:14px">
      <label>Invite code
        <input name="code" maxlength="16" autocomplete="off" placeholder="e.g. AB12CD" required />
      </label>
      <div class="row"><button class="primary" type="submit">Preview invite</button></div>
      <p class="quiet" id="invite-form-note"></p>
    </form>
    ${cards || empty("No leagues yet. Create one or join with an invite code.")}
  `);
  document.querySelector("#create-league")?.addEventListener("click", () => { location.hash = "#/leagues/create"; });
  document.querySelector("#join-league")?.addEventListener("click", () => {
    document.querySelector<HTMLInputElement>("#invite-form input[name=code]")?.focus();
  });
  document.querySelector("#invite-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const fd = new FormData(event.target as HTMLFormElement);
    const code = String(fd.get("code") ?? "").trim();
    const note = document.querySelector("#invite-form-note");
    if (code.length < 6) {
      if (note) note.textContent = "Invite codes are at least 6 characters.";
      return;
    }
    location.hash = `#/leagues/join/${encodeURIComponent(code)}`;
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-league]")) {
    button.addEventListener("click", () => { location.hash = `#/leagues/${button.dataset.league}`; });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-board]")) {
    button.addEventListener("click", () => { location.hash = `#/leagues/${button.dataset.board}/leaderboard`; });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-copy-invite]")) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(button.dataset.copyInvite ?? "");
        button.textContent = "Copied";
      } catch { /* ignore */ }
    });
  }
}

async function renderLeagueCreate(): Promise<void> {
  app.innerHTML = shell("Create FREE league", loading());
  const matches = await api<{ matches: MatchCard[] }>("/matches?bucket=upcoming");
  const options = matches.matches.map((m) => `<option value="${m.id}">${escapeText(matchTitle(m))}</option>`).join("");
  app.innerHTML = shell("Create FREE league", `
    <form id="league-form" class="card">
      <label>Name <input name="name" maxlength="48" required placeholder="Friday Five" /></label>
      <label>Match <select name="matchId" required>${options || "<option value=''>No upcoming matches</option>"}</select></label>
      <label>Capacity
        <select name="capacity" required>
          ${[2, 4, 5, 8, 10, 12, 20, 50].map((n) => `<option value="${n}" ${n === 8 ? "selected" : ""}>${n} players</option>`).join("")}
        </select>
      </label>
      <p class="note">FREE · invite link · no USDC · no prize pool</p>
      <div class="row"><button class="primary" type="submit">Create</button><a class="back-link" href="#/leagues">Cancel</a></div>
      <p class="quiet" id="league-note"></p>
    </form>
  `);
  document.querySelector("#league-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const fd = new FormData(form);
    void (async () => {
      const note = document.querySelector("#league-note");
      const submit = form.querySelector("button[type=submit]") as HTMLButtonElement | null;
      if (submit) submit.disabled = true;
      try {
        const created = await api<{ league: LeagueCard }>("/leagues", {
          method: "POST",
          headers: { "idempotency-key": `lg-${Date.now()}` },
          body: JSON.stringify({
            name: String(fd.get("name") ?? ""),
            matchId: String(fd.get("matchId") ?? ""),
            capacity: Number(fd.get("capacity") ?? 8),
          }),
        });
        location.hash = `#/leagues/${created.league.id}`;
      } catch (error) {
        if (note) note.textContent = error instanceof Error ? error.message : "Create failed";
        if (submit) submit.disabled = false;
      }
    })();
  });
}

async function renderLeagueJoin(code: string): Promise<void> {
  app.innerHTML = shell("Join FREE league", loading());
  let preview: { league: LeagueCard };
  try {
    preview = await api<{ league: LeagueCard }>(`/leagues/invite/${encodeURIComponent(code)}`);
  } catch (error) {
    app.innerHTML = shell("Join FREE league", `
      <article class="card">
        <p class="note">${escapeText(error instanceof Error ? error.message : "Invalid invite")}</p>
        <a class="back-link" href="#/leagues">← Leagues</a>
      </article>
    `);
    return;
  }
  const league = preview.league;
  const hasXi = Boolean(state.teamVersionId && state.teamMatchId === league.matchId);
  const needsXi = !league.youJoined && !hasXi;
  app.innerHTML = shell("Join FREE league", `
    <article class="card">
      <div class="meta"><span class="badge badge-free">FREE</span><span>${league.memberCount}/${league.capacity}</span><span>${escapeText(league.status)}</span></div>
      <h3>${escapeText(league.name)}</h3>
      <p class="quiet">Invite <span class="mono">${escapeText(league.inviteCode)}</span> · ${escapeText(league.lifecycleBucket)}</p>
      ${needsXi
        ? `<p class="note">An XI for this match is required before you can join. Build your XI, then you will return here to confirm.</p>`
        : `<p class="note">XI ready for this match. Confirm below to join — nothing is submitted until you press Join League. No USDC.</p>`}
      ${league.youJoined ? `<p class="note">You already joined this league.</p>` : ""}
      <div class="row">
        ${needsXi
          ? `<button class="primary" id="build-xi-return">Build XI for this match</button>`
          : `<button class="primary" id="confirm-join" ${league.youJoined ? "disabled" : ""}>${league.youJoined ? "Already joined" : "Join League"}</button>`}
        <a class="back-link" href="#/leagues">Back</a>
      </div>
      <p class="quiet" id="join-note"></p>
    </article>
  `);
  document.querySelector("#build-xi-return")?.addEventListener("click", () => {
    writeLeagueReturn({ inviteCode: league.inviteCode, matchId: league.matchId, leagueId: league.id });
    location.hash = `#/matches/${league.matchId}/xi`;
  });
  document.querySelector("#confirm-join")?.addEventListener("click", () => {
    void (async () => {
      const note = document.querySelector("#join-note");
      try {
        if (!state.teamVersionId || state.teamMatchId !== league.matchId) {
          writeLeagueReturn({ inviteCode: league.inviteCode, matchId: league.matchId, leagueId: league.id });
          if (note) note.textContent = "XI required — opening builder…";
          location.hash = `#/matches/${league.matchId}/xi`;
          return;
        }
        const joined = await api<{ league: LeagueCard }>("/leagues/join", {
          method: "POST",
          headers: { "idempotency-key": `lgj-${Date.now()}` },
          body: JSON.stringify({ inviteCode: league.inviteCode, teamVersionId: state.teamVersionId }),
        });
        clearLeagueReturn();
        location.hash = `#/leagues/${joined.league.id}`;
      } catch (error) {
        if (note) note.textContent = error instanceof Error ? error.message : "Join failed";
      }
    })();
  });

  // Returning from XI: show confirmation only — never auto-join.
  if (!league.youJoined && hasXi && readLeagueReturn()?.inviteCode === league.inviteCode) {
    const note = document.querySelector("#join-note");
    if (note) note.textContent = "XI saved. Press Join League to confirm.";
  }
}

async function renderLeagueDetail(id: string): Promise<void> {
  app.innerHTML = shell("League", loading());
  const data = await api<{ league: LeagueCard }>(`/leagues/${id}`);
  const league = data.league;
  app.innerHTML = shell(escapeText(league.name), `
    <article class="card">
      <div class="meta"><span class="badge badge-free">FREE</span><span>${escapeText(league.status)}</span><span>${escapeText(league.lifecycleBucket)}</span></div>
      <p class="quiet">${league.memberCount} / ${league.capacity} members${league.isOwner ? " · you own this league" : ""}${league.youJoined ? " · joined" : ""}</p>
      <p>Invite code <strong class="mono">${escapeText(league.inviteCode)}</strong>
        <button class="ghost" id="copy-invite" type="button">Copy</button></p>
      <p class="quiet">Share path: ${escapeText(league.invitePath)}</p>
      <div class="row">
        <button class="primary" data-board="${league.id}">Leaderboard</button>
        <button class="ghost" data-xi="${league.matchId}">Build / review XI</button>
        <button class="ghost" id="league-share-btn">Share result</button>
        <a class="back-link" href="#/leagues">← Leagues</a>
      </div>
      <div id="share-slot"></div>
    </article>
  `);
  document.querySelector("#copy-invite")?.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(league.inviteCode);
      const btn = document.querySelector("#copy-invite");
      if (btn) btn.textContent = "Copied";
    } catch { /* ignore */ }
  });
  document.querySelector("[data-board]")?.addEventListener("click", () => {
    location.hash = `#/leagues/${id}/leaderboard`;
  });
  document.querySelector("[data-xi]")?.addEventListener("click", () => {
    location.hash = `#/matches/${league.matchId}/xi`;
  });
  document.querySelector("#league-share-btn")?.addEventListener("click", () => {
    location.hash = `#/share/league/${id}`;
  });
}

async function renderLeagueLeaderboard(id: string): Promise<void> {
  app.innerHTML = shell("League leaderboard", loading());
  const board = await api<{
    league: LeagueCard;
    freshness: string;
    scoreSnapshotId?: string | null;
    rows: Array<{ rank: number; wallet: string; milliPoints: number; you: boolean }>;
  }>(`/leagues/${id}/leaderboard`);
  const rows = board.rows.map((row) =>
    lbRowHtml({
      rank: row.rank,
      label: shortWallet(row.wallet),
      milliPoints: row.milliPoints,
      you: row.you,
    }),
  ).join("") || empty("No members yet. Share the invite code to fill this FREE league.");
  app.innerHTML = shell(escapeText(board.league.name), `
    <div class="lb-head">
      <div class="meta"><span class="badge badge-free">FREE</span><span>${escapeText(freshnessChipLabel(board.freshness))}</span></div>
      ${board.scoreSnapshotId ? `<div class="quiet mono">snapshot ${escapeText(board.scoreSnapshotId.slice(0, 48))}…</div>` : ""}
    </div>
    ${freshnessBannerHtml(board.freshness === "UNKNOWN" ? "UNKNOWN" : board.freshness === "FINAL" ? null : board.freshness)}
    <div class="leaderboard">${rows}</div>
    <div class="row" style="margin-top:16px">
      <a class="back-link" href="#/leagues/${id}">← League</a>
      <button class="ghost" id="league-share">Share</button>
    </div>
    <div id="share-slot"></div>
  `);
  document.querySelector("#league-share")?.addEventListener("click", () => {
    location.hash = `#/share/league/${id}`;
  });
  markLeaderboardViewed();
}

async function renderShareContest(contestId: string): Promise<void> {
  app.innerHTML = shell("Share FREE result", loading());
  try {
    const payload = await api<{ share: {
      matchLabel: string; label: string; rank: number | null; score: number | null;
      captain: string | null; note: string; text: string; url: string; sharePath?: string;
    } }>(`/contests/${contestId}/share`);
    app.innerHTML = shell("Share FREE result", `
      ${shareCardHtml(payload.share)}
      <div class="row" style="margin-top:12px">
        <a class="back-link" href="#/contests/${contestId}/result">← Result</a>
        <a class="ghost" href="${escapeText(payload.share.sharePath ?? `/share/contest/${contestId}`)}" target="_blank" rel="noopener">OG page</a>
      </div>
    `);
    document.querySelector("[data-copy-share]")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(payload.share.text); } catch { /* ignore */ }
    });
  } catch (error) {
    app.innerHTML = shell("Share FREE result", empty(error instanceof Error ? error.message : "Share unavailable"));
  }
}

async function renderShareLeague(leagueId: string): Promise<void> {
  app.innerHTML = shell("Share FREE league", loading());
  try {
    const payload = await api<{ share: {
      matchLabel: string; label: string; rank: number | null; score: number | null;
      captain: string | null; note: string; text: string; url: string; sharePath?: string;
    } }>(`/leagues/${leagueId}/share`);
    app.innerHTML = shell("Share FREE league", `
      ${shareCardHtml(payload.share)}
      <div class="row" style="margin-top:12px">
        <a class="back-link" href="#/leagues/${leagueId}">← League</a>
        <a class="ghost" href="${escapeText(payload.share.sharePath ?? `/share/league/${leagueId}`)}" target="_blank" rel="noopener">OG page</a>
      </div>
    `);
    document.querySelector("[data-copy-share]")?.addEventListener("click", async () => {
      try { await navigator.clipboard.writeText(payload.share.text); } catch { /* ignore */ }
    });
  } catch (error) {
    app.innerHTML = shell("Share FREE league", empty(error instanceof Error ? error.message : "Share unavailable"));
  }
}

async function renderProfile(wallet: string | null): Promise<void> {
  if (!wallet) {
    app.innerHTML = shell("Profile", empty("Sign in to view your profile."));
    return;
  }
  app.innerHTML = shell("Profile", loading());
  const data = await api<{ profile: {
    wallet: string;
    displayName: string | null;
    contestsPlayed: number;
    wins: number;
    top3Finishes: number;
    averagePoints: number;
    recentContests: Array<{ kind: string; label: string; rank: number; scoreMilliPoints: number; id: string }>;
    freeOnly: boolean;
  } }>(wallet === state.walletAddress ? "/v1/me/profile" : `/v1/profile/${encodeURIComponent(wallet)}`);
  const profile = data.profile;
  const recent = profile.recentContests.map((row) =>
    `<div class="lb-row"><div class="rank">#${row.rank}</div><div>${escapeText(row.label)} <span class="quiet">${escapeText(row.kind)}</span></div><div><strong>${(row.scoreMilliPoints / 1000).toFixed(1)}</strong></div></div>`
  ).join("") || empty("No finalized FREE results yet.");
  const editable = wallet === state.walletAddress;
  app.innerHTML = shell(escapeText(profile.displayName || shortWallet(profile.wallet)), `
    <article class="card">
      <p class="quiet mono">${escapeText(profile.wallet)}</p>
      <div class="result-stats">
        <div><span class="quiet">Played</span><strong>${profile.contestsPlayed}</strong></div>
        <div><span class="quiet">Wins</span><strong>${profile.wins}</strong></div>
        <div><span class="quiet">Top 3</span><strong>${profile.top3Finishes}</strong></div>
        <div><span class="quiet">Avg pts</span><strong>${profile.averagePoints.toFixed(1)}</strong></div>
      </div>
      <p class="note">FREE results only — no monetary stats.</p>
      ${editable ? `<form id="name-form" class="row"><input name="displayName" maxlength="32" value="${escapeText(profile.displayName ?? "")}" placeholder="Display name" /><button class="ghost" type="submit">Save</button></form><p class="quiet" id="name-note"></p>` : ""}
    </article>
    <article class="card"><div class="meta"><span>Recent FREE results</span></div><div class="leaderboard">${recent}</div></article>
  `);
  document.querySelector("#name-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    const fd = new FormData(event.target as HTMLFormElement);
    void (async () => {
      const note = document.querySelector("#name-note");
      try {
        await api("/v1/me/profile", {
          method: "PATCH",
          headers: { "idempotency-key": `name-${Date.now()}` },
          body: JSON.stringify({ displayName: String(fd.get("displayName") ?? "") }),
        });
        void renderProfile(wallet);
      } catch (error) {
        if (note) note.textContent = error instanceof Error ? error.message : "Update failed";
      }
    })();
  });
}


window.addEventListener("hashchange", () => { void render(); });
void render();
