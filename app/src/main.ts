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
  shareCardHtml,
  onboardingChecklistHtml,
  resultHeroHtml,
} from "./format.js";
import { landingPageHtml } from "./format-landing.js";
import { watchLeaderboard } from "./live-board.js";

Object.assign(globalThis, { Buffer });

const ONBOARD_KEY = "kickr.onboarding.seen";
/** Dismissal preference only — may remain client-side; never authoritative for progress. */
function onboardingSeen(): boolean {
  return sessionStorage.getItem(ONBOARD_KEY) === "1";
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

/** Durable invite handoff via hash query — survives refresh, new tab, copied URL. */
interface LeagueReturnContext {
  inviteCode: string;
  matchId: string;
  leagueId?: string;
  xiSaved?: boolean;
}
function parseHashParts(): { path: string; params: URLSearchParams; segments: string[] } {
  const raw = (location.hash || "#/").replace(/^#/, "");
  const q = raw.indexOf("?");
  const path = q >= 0 ? raw.slice(0, q) : raw;
  const query = q >= 0 ? raw.slice(q + 1) : "";
  const segments = path.split("/").filter(Boolean);
  return { path: path.startsWith("/") ? path : `/${path}`, params: new URLSearchParams(query), segments };
}
function hashWithQuery(path: string, params: Record<string, string | undefined>): string {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v != null && v !== "") sp.set(k, v);
  }
  const q = sp.toString();
  const base = path.startsWith("#") ? path : `#${path.startsWith("/") ? path : `/${path}`}`;
  return q ? `${base}?${q}` : base;
}
function readLeagueInviteFromRoute(): LeagueReturnContext | null {
  const { path, params, segments } = parseHashParts();
  const inviteFromJoin = path.startsWith("/leagues/join/") ? decodeURIComponent(segments[2] ?? "") : "";
  const inviteCode = params.get("leagueInvite") || inviteFromJoin;
  const matchId = params.get("matchId") || "";
  if (!inviteCode) return null;
  return {
    inviteCode,
    matchId,
    leagueId: params.get("leagueId") || undefined,
    xiSaved: params.get("xiSaved") === "1",
  };
}
function xiBuilderHash(matchId: string, invite: LeagueReturnContext): string {
  return hashWithQuery(`/matches/${matchId}/xi`, {
    leagueInvite: invite.inviteCode,
    matchId,
    leagueId: invite.leagueId,
  });
}
function joinConfirmHash(inviteCode: string, extra?: { matchId?: string; xiSaved?: boolean }): string {
  return hashWithQuery(`/leagues/join/${encodeURIComponent(inviteCode)}`, {
    matchId: extra?.matchId,
    xiSaved: extra?.xiSaved ? "1" : undefined,
  });
}
/** Persist leaderboard-viewed on the account (server), not sessionStorage. */
async function markLeaderboardViewed(): Promise<void> {
  if (!state.token) return;
  try {
    await api("/me/onboarding/leaderboard-viewed", { method: "POST", body: "{}" });
  } catch {
    /* non-blocking */
  }
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
    let freeJoined =
      mine.contests.some((c) => c.contestKind === "FREE") ||
      leagues.leagues.some((l) => l.youJoined || l.isOwner);
    // Leaderboard step: server-persisted explicit view event (not sessionStorage).
    let leaderboardReady = false;
    try {
      const ob = await api<{ onboarding: { leaderboardViewed: boolean; xiSaved: boolean; freeJoined: boolean } }>(
        "/me/onboarding",
      );
      leaderboardReady = Boolean(ob.onboarding.leaderboardViewed);
      if (ob.onboarding.xiSaved) {
        xiSaved = true;
        matchSelected = true;
        captainSet = true;
        viceSet = true;
      }
      if (ob.onboarding.freeJoined) freeJoined = true;
    } catch {
      /* fall back to derived account signals above */
    }
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
  simulated?: boolean;
  tutorial?: boolean;
  dataSource?: { provider: string; label: string; fetchedAt?: string };
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
  demoData: boolean;
  liveData: boolean;
  dualMode: boolean;
  modesAvailable: Array<"LIVE" | "DEMO">;
  /** Client-selected dataset mode (DUAL). Ignored when server is single-mode. */
  selectedMode: "LIVE" | "DEMO";
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
  demoData: false,
  liveData: false,
  dualMode: false,
  modesAvailable: [],
  selectedMode: (localStorage.getItem("kickr.ui.mode") as "LIVE" | "DEMO" | null) === "LIVE" ? "LIVE" : "DEMO",
};

let devDepositKey: Keypair | null = null;

function route(): string {
  const raw = location.hash || "#/";
  const q = raw.indexOf("?");
  return q >= 0 ? raw.slice(0, q) : raw;
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
    return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(new Date(iso));
  } catch {
    return iso;
  }
}

function effectiveDataMode(): "LIVE" | "DEMO" | null {
  if (state.dualMode) return state.selectedMode;
  if (state.liveData) return "LIVE";
  if (state.demoData) return "DEMO";
  if (state.modesAvailable.length === 1) return state.modesAvailable[0]!;
  return null;
}

function withMode(path: string): string {
  const mode = effectiveDataMode();
  if (!mode) return path;
  // Only attach mode to football/match listing paths (isolation boundary).
  if (!path.startsWith("/matches") && !path.startsWith("/v1/")) {
    // still send header below
  }
  if (!path.startsWith("/matches")) return path;
  const join = path.includes("?") ? "&" : "?";
  if (/[?&]mode=/.test(path)) return path;
  return `${path}${join}mode=${mode}`;
}

function setSelectedMode(mode: "LIVE" | "DEMO"): void {
  if (!state.modesAvailable.includes(mode) && state.dualMode === false && state.modesAvailable.length > 0) {
    return;
  }
  state.selectedMode = mode;
  localStorage.setItem("kickr.ui.mode", mode);
  // Derive banner flags from selection when dual.
  if (state.dualMode) {
    state.liveData = mode === "LIVE";
    state.demoData = mode === "DEMO";
  }
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  if (init?.body) headers.set("content-type", "application/json");
  const mode = effectiveDataMode();
  if (mode) headers.set("x-kickr-mode", mode);
  const response = await fetch(withMode(path), { ...init, headers });
  const body = (await response.json()) as T & { error?: { message: string; details?: { errors: Array<{ message: string }> } } };
  if (!response.ok) {
    const details = body.error?.details?.errors?.map((error) => error.message).join(" ");
    throw new Error(details || body.error?.message || "Request failed");
  }
  return body;
}

/** Fetch with an explicit dataset mode (dual-mode Matches IA). */
async function apiForMode<T>(path: string, mode: "LIVE" | "DEMO", init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (state.token) headers.set("authorization", `Bearer ${state.token}`);
  if (init?.body) headers.set("content-type", "application/json");
  headers.set("x-kickr-mode", mode);
  let url = path;
  if (path.startsWith("/matches")) {
    const join = path.includes("?") ? "&" : "?";
    if (!/[?&]mode=/.test(path)) url = `${path}${join}mode=${mode}`;
  }
  const response = await fetch(url, { ...init, headers });
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
    const body = await (await fetch("/v1/config/public")).json() as {
      environment?: string;
      demoData?: boolean;
      liveData?: boolean;
      appMode?: string | null;
      dualMode?: boolean;
      modesAvailable?: Array<"LIVE" | "DEMO">;
      liveFixtureId?: string | null;
    };
    state.environment = body.environment ?? "development";
    state.dualMode = body.dualMode === true || body.appMode === "DUAL";
    state.modesAvailable = Array.isArray(body.modesAvailable)
      ? body.modesAvailable.filter((m): m is "LIVE" | "DEMO" => m === "LIVE" || m === "DEMO")
      : body.appMode === "LIVE"
        ? ["LIVE"]
        : body.appMode === "DEMO"
          ? ["DEMO"]
          : body.dualMode
            ? ["LIVE", "DEMO"]
            : [];
    if (state.dualMode) {
      if (!state.modesAvailable.includes(state.selectedMode)) {
        state.selectedMode = state.modesAvailable.includes("LIVE") ? "LIVE" : "DEMO";
      }
      setSelectedMode(state.selectedMode);
    } else {
      state.demoData = body.demoData === true;
      state.liveData = body.liveData === true || body.appMode === "LIVE";
      if (state.liveData) state.selectedMode = "LIVE";
      else if (state.demoData) state.selectedMode = "DEMO";
    }
  } catch {
    state.environment = "development";
    state.demoData = false;
    state.liveData = false;
    state.dualMode = false;
    state.modesAvailable = [];
  }
  return state.environment;
}

function isTutorialMatch(match: MatchCard): boolean {
  return match.simulated === true
    || match.tutorial === true
    || match.dataSource?.provider === "demo"
    || /tutorial/i.test(match.competition);
}

function demoBannerHtml(): string {
  if (state.dualMode) {
    return `<div class="demo-banner demo-banner-chip tutorial-chip" role="status">Tutorial Match available · Simulated practice + real fixtures</div>`;
  }
  if (state.liveData || effectiveDataMode() === "LIVE") {
    return `<div class="demo-banner demo-banner-chip live-data-chip" role="status">LIVE DATA · Sportmonks match feed</div>`;
  }
  if (state.demoData || effectiveDataMode() === "DEMO") {
    return `<div class="demo-banner demo-banner-chip tutorial-chip" role="status">Tutorial Match · Simulated · Learn KICKR</div>`;
  }
  return "";
}

/** Public IA: no global LIVE/DEMO toggle — Matches page owns hierarchy. */
function modeSwitchHtml(): string {
  return "";
}

function bindModeSwitch(): void {
  /* removed public LIVE/DEMO toggle (Phase 18D.1) */
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
  await runtimeEnvironment();
  // Ephemeral keypair sign-in is allowed for DEMO DATA public demo and local development.
  if (state.environment === "production" && !state.demoData && !state.dualMode) {
    throw new Error("Development signer is disabled");
  }
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

function clearSession(): void {
  state.token = null;
  state.authMode = null;
  state.walletAddress = null;
  state.teamVersionId = null;
  state.teamMatchId = null;
  sessionStorage.removeItem("kickr.session.token");
  sessionStorage.removeItem("kickr.auth.mode");
  sessionStorage.removeItem("kickr.auth.wallet");
  sessionStorage.removeItem("kickr.dev.token");
  sessionStorage.removeItem("kickr.dev.teamVersion");
  sessionStorage.removeItem("kickr.dev.teamMatch");
  sessionStorage.removeItem("kickr.dev.reservation");
}

function shell(title: string, body: string): string {
  const hash = route();
  const accountLabel = state.token
    ? state.walletAddress
      ? shortWallet(state.walletAddress)
      : "Account"
    : "Account";
  const matchesCurrent = hash === "#/" || hash === "#/matches" || hash.startsWith("#/matches");
  const contestsCurrent = hash.startsWith("#/my-contests") || hash.startsWith("#/contests/");
  const leaguesCurrent = hash.startsWith("#/leagues") || hash.startsWith("#/share/league");
  const profileCurrent = hash.startsWith("#/profile") || hash.startsWith("#/u/");
  const accountCurrent = hash.startsWith("#/account");
  return `<div class="shell">
    <div class="top">
      <a class="brand" href="#/" aria-label="KICKR home"><span class="brand-symbol" aria-hidden="true">↗</span>KICKR<span class="brand-dot">.</span></a>
      ${modeSwitchHtml()}
      <div class="nav nav-desktop">
        <a href="#/" ${matchesCurrent ? 'aria-current="page"' : ""}>Matches</a>
        <a href="#/my-contests" ${contestsCurrent ? 'aria-current="page"' : ""}>Contests</a>
        <a href="#/leagues" ${leaguesCurrent ? 'aria-current="page"' : ""}>Leagues</a>
        <a href="#/profile" ${profileCurrent ? 'aria-current="page"' : ""}>Profile</a>
      </div>
      <a class="top-account" href="#/account" ${accountCurrent ? 'aria-current="page"' : ""} data-auth-label>${escapeText(accountLabel)}</a>
    </div>
    ${demoBannerHtml()}
    <h1 class="page-title">${title}</h1>
    ${state.error ? `<div class="error">${escapeText(state.error)}</div>` : ""}
    ${body}
    <p class="note">FREE contests &amp; private leagues need no USDC. Credits are a squad budget, not money.${state.environment === "production" || state.demoData ? "" : " Paid Devnet contests stay available only in development."}</p>
    <nav class="bottom-nav" aria-label="Primary">
      <a href="#/" ${matchesCurrent ? 'aria-current="page"' : ""}><span class="bn-label">Matches</span></a>
      <a href="#/my-contests" ${contestsCurrent ? 'aria-current="page"' : ""}><span class="bn-label">Contests</span></a>
      <a href="#/leagues" ${leaguesCurrent ? 'aria-current="page"' : ""}><span class="bn-label">Leagues</span></a>
      <a href="#/profile" ${profileCurrent ? 'aria-current="page"' : ""}><span class="bn-label">Profile</span></a>
    </nav>
  </div>`;
}

function setAuthNote(message: string): void {
  for (const id of ["#auth-note", "#auth-note-final"]) {
    const note = document.querySelector(id);
    if (note) note.textContent = message;
  }
}

function bindLandingAuth(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>("[data-scroll]")) {
    link.addEventListener("click", (event) => {
      event.preventDefault();
      document.getElementById(link.dataset.scroll ?? "")?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }
  const afterSignIn = () => {
    location.hash = "#/";
    void render();
  };
  const onPlayFree = () => {
    void (async () => {
      try {
        await runtimeEnvironment();
        if (state.demoData || state.dualMode || state.environment !== "production") {
          await signInDevelopment();
        } else {
          await signInWithWallet();
        }
        afterSignIn();
      } catch (error) {
        setAuthNote(error instanceof Error ? error.message : "Sign-in failed");
      }
    })();
  };
  const onExplore = () => {
    const el = document.querySelector("#demo");
    if (el) el.scrollIntoView({ behavior: "smooth", block: "start" });
    else location.hash = "#demo";
  };
  for (const id of ["#play-free", "#play-free-hero", "#play-free-final", "#play-free-xi"]) {
    document.querySelector(id)?.addEventListener("click", onPlayFree);
  }
  for (const id of ["#explore-demo", "#explore-demo-hero"]) {
    document.querySelector(id)?.addEventListener("click", onExplore);
  }
  document.querySelector("#signin-dev")?.addEventListener("click", () => {
    void signInDevelopment().then(afterSignIn).catch((error) => {
      setAuthNote(error instanceof Error ? error.message : "Sign-in failed");
    });
  });
  document.querySelector("#signin-wallet")?.addEventListener("click", () => {
    void signInWithWallet().then(afterSignIn).catch((error) => {
      setAuthNote(error instanceof Error ? error.message : "Wallet sign-in failed");
    });
  });
}

async function renderLanding(): Promise<void> {
  await runtimeEnvironment();
  const production = state.environment === "production";
  app.innerHTML = landingPageHtml({ demoData: state.demoData, production });
  bindLandingAuth();
}

async function renderAccount(): Promise<void> {
  const wallet = state.walletAddress ? shortWallet(state.walletAddress) : "—";
  const mode = state.authMode === "wallet" ? "Wallet" : state.authMode === "dev" ? "Demo session" : "Signed in";
  app.innerHTML = shell("Account", `
    <article class="card account-card">
      <div class="meta"><span>${escapeText(mode)}</span><span class="badge badge-free">FREE</span></div>
      <p class="quiet">Signed in as</p>
      <p class="mono">${escapeText(state.walletAddress ?? "—")}</p>
      <div class="result-stats" style="margin-top:16px">
        <div><span class="quiet">Wallet</span><strong>${escapeText(wallet)}</strong></div>
        <div><span class="quiet">Mode</span><strong>${escapeText(mode)}</strong></div>
      </div>
      <div class="row" style="margin-top:16px">
        <a class="ghost" href="#/profile">Open profile</a>
        <button type="button" class="danger" id="sign-out">Sign out</button>
      </div>
      <p class="note">Signing out clears this browser session only. FREE contests keep no monetary balance.</p>
    </article>
  `);
  document.querySelector("#sign-out")?.addEventListener("click", () => {
    clearSession();
    location.hash = "#/";
    void render();
  });
}

function loading(label = "Loading…"): string {
  return `<div class="loading">${escapeText(label)}</div><div class="skeleton" aria-hidden="true"></div>`;
}

function empty(label: string): string {
  return `<div class="empty">${escapeText(label)}</div>`;
}

let stopLiveBoard: (() => void) | undefined;

async function render(): Promise<void> {
  stopLiveBoard?.();
  stopLiveBoard = undefined;
  state.error = null;
  await runtimeEnvironment();
  const hash = route();
  try {
    if (hash === "#/welcome" || hash === "#/landing") {
      await renderLanding();
      return;
    }
    if (!state.token) {
      await renderLanding();
      return;
    }
    if (hash === "#/account") {
      await renderAccount();
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
    if (hash.startsWith("#/tutorial/") && hash.endsWith("/info")) {
      setSelectedMode("DEMO");
      await renderTutorialInfo(hash.split("/")[2] ?? "");
      return;
    }
    if (hash.startsWith("#/tutorial/") && hash.endsWith("/simulate")) {
      setSelectedMode("DEMO");
      await renderTutorialSimulate(hash.split("/")[2] ?? "");
      return;
    }
    if (hash.startsWith("#/tutorial/") && hash.endsWith("/complete")) {
      setSelectedMode("DEMO");
      await renderTutorialComplete(hash.split("/")[2] ?? "");
      return;
    }
    if (hash.startsWith("#/tutorial/") && hash.split("/").length === 3) {
      setSelectedMode("DEMO");
      await renderTutorialHub(hash.split("/")[2] ?? "");
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
  app.innerHTML = shell("Matches", loading());
  const progress = await loadOnboardingProgress();
  const onboard = onboardingChecklistHtml(onboardingSeen(), [
    { done: progress.signedIn, label: "Connect / sign in", href: "#/" },
    { done: progress.matchSelected, label: "Start the Tutorial Match", href: "#/" },
    { done: progress.xiSaved && progress.captainSet && progress.viceSet, label: "Build XI + captain/vice", href: "#/" },
    { done: progress.freeJoined, label: "Join a FREE contest or league", href: "#/leagues" },
    { done: progress.leaderboardReady, label: "Follow the leaderboard", href: "#/my-contests" },
  ]);

  let tutorial: MatchCard[] = [];
  let liveMatches: MatchCard[] = [];
  let upcoming: MatchCard[] = [];
  let results: MatchCard[] = [];
  let creditCap = state.creditCap;
  let maxFromOne = state.maxPlayersFromOneTeam;

  if (state.dualMode || state.modesAvailable.length >= 2) {
    const [demoUp, demoLive, demoDone, liveUp, liveLive, liveDone] = await Promise.all([
      apiForMode<{ matches: MatchCard[]; creditCap: number; maxPlayersFromOneTeam: number | null }>("/matches?bucket=upcoming", "DEMO").catch(() => ({ matches: [], creditCap, maxPlayersFromOneTeam: maxFromOne })),
      apiForMode<{ matches: MatchCard[] }>("/matches?bucket=live", "DEMO").catch(() => ({ matches: [] })),
      apiForMode<{ matches: MatchCard[] }>("/matches?bucket=completed", "DEMO").catch(() => ({ matches: [] })),
      apiForMode<{ matches: MatchCard[]; creditCap: number; maxPlayersFromOneTeam: number | null }>("/matches?bucket=upcoming", "LIVE").catch(() => ({ matches: [], creditCap, maxPlayersFromOneTeam: maxFromOne })),
      apiForMode<{ matches: MatchCard[] }>("/matches?bucket=live", "LIVE").catch(() => ({ matches: [] })),
      apiForMode<{ matches: MatchCard[] }>("/matches?bucket=completed", "LIVE").catch(() => ({ matches: [] })),
    ]);
    creditCap = demoUp.creditCap || liveUp.creditCap || creditCap;
    maxFromOne = demoUp.maxPlayersFromOneTeam ?? liveUp.maxPlayersFromOneTeam ?? maxFromOne;
    const demoAll = [...demoUp.matches, ...demoLive.matches, ...demoDone.matches];
    tutorial = demoAll.filter(isTutorialMatch);
    if (tutorial.length === 0 && demoAll.length) tutorial = [demoAll[0]!];
    liveMatches = liveLive.matches.filter((m) => !isTutorialMatch(m));
    upcoming = liveUp.matches.filter((m) => !isTutorialMatch(m));
    results = liveDone.matches.filter((m) => !isTutorialMatch(m));
  } else if (state.demoData || effectiveDataMode() === "DEMO") {
    const data = await api<{ matches: MatchCard[]; creditCap: number; maxPlayersFromOneTeam: number | null }>(`/matches?bucket=${state.bucket}`);
    creditCap = data.creditCap;
    maxFromOne = data.maxPlayersFromOneTeam;
    tutorial = data.matches;
  } else {
    const [up, live, done] = await Promise.all([
      api<{ matches: MatchCard[]; creditCap: number; maxPlayersFromOneTeam: number | null }>("/matches?bucket=upcoming"),
      api<{ matches: MatchCard[] }>("/matches?bucket=live"),
      api<{ matches: MatchCard[] }>("/matches?bucket=completed"),
    ]);
    creditCap = up.creditCap;
    maxFromOne = up.maxPlayersFromOneTeam;
    liveMatches = live.matches;
    upcoming = up.matches;
    results = done.matches;
  }
  state.creditCap = creditCap;
  state.maxPlayersFromOneTeam = maxFromOne;

  const realCard = (match: MatchCard, cta: string) => `<article class="card match-card">
      <div class="meta"><span>${escapeText(match.competition)}</span>${statusChip(match.status, match.bucket)}<span>${match.canBuildXi ? "XI open" : "XI locked"}</span></div>
      ${matchTile(match)}
      <div class="row match-card-footer">
        <button class="ghost" data-contests="${match.id}" data-mode="${isTutorialMatch(match) ? "DEMO" : "LIVE"}">View contests</button>
        <button class="primary" data-build="${match.id}" data-mode="${isTutorialMatch(match) ? "DEMO" : "LIVE"}" ${match.canBuildXi ? "" : "disabled"}>${cta}</button>
      </div>
    </article>`;

  const tutorialCards = tutorial.map((match) => {
    const simBadge = `<span class="badge badge-simulated">SIMULATED</span>`;
    const learn = `<span class="badge badge-tutorial">LEARN KICKR</span>`;
    let cta = "Start Tutorial";
    if (match.status === "LIVE" || match.status === "HALFTIME") cta = "Continue Simulation";
    else if (match.status === "FINAL" || match.status === "FULL_TIME") cta = "View Tutorial Result";
    else if (match.canBuildXi) cta = "Start Tutorial";
    return `<article class="card tutorial-card">
      <div class="meta"><span class="tutorial-kicker">TUTORIAL MATCH</span>${simBadge}${learn}</div>
      <h2 class="tutorial-title">${escapeText(match.home.name)} vs ${escapeText(match.away.name)}</h2>
      <p class="quiet">Learn KICKR by playing through a complete simulated match.</p>
      ${matchTile(match)}
      <div class="row">
        <button class="ghost" data-tutorial-info="${match.id}">How it works</button>
        <button class="primary" data-tutorial="${match.id}">${cta}</button>
      </div>
    </article>`;
  }).join("");

  const section = (title: string, cards: string) => cards
    ? `<section class="match-section"><h2 class="section-title">${title}</h2><div class="match-grid">${cards}</div></section>`
    : "";

  app.innerHTML = shell("Matches", `
    ${onboard}
    ${tutorialCards ? `<section class="match-section tutorial-section"><div class="match-grid">${tutorialCards}</div></section>` : ""}
    ${section("Live Now", liveMatches.map((m) => realCard(m, m.canBuildXi ? "Build XI" : "View live")).join(""))}
    ${section("Upcoming", upcoming.map((m) => realCard(m, "Build XI")).join(""))}
    ${section("Results", results.map((m) => realCard(m, "View result")).join(""))}
    ${!tutorialCards && !liveMatches.length && !upcoming.length && !results.length ? empty("No matches in this view yet.") : ""}
  `);
  bindOnboardingDismiss();
  bindModeSwitch();
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-contests]")) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode === "DEMO" ? "DEMO" : "LIVE";
      setSelectedMode(mode);
      location.hash = `#/matches/${button.dataset.contests}/contests`;
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-build]")) {
    button.addEventListener("click", () => {
      const mode = button.dataset.mode === "DEMO" ? "DEMO" : "LIVE";
      setSelectedMode(mode);
      location.hash = `#/matches/${button.dataset.build}/xi`;
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tutorial]")) {
    button.addEventListener("click", () => {
      setSelectedMode("DEMO");
      location.hash = `#/tutorial/${button.dataset.tutorial}`;
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-tutorial-info]")) {
    button.addEventListener("click", () => {
      setSelectedMode("DEMO");
      location.hash = `#/tutorial/${button.dataset.tutorialInfo}/info`;
    });
  }
}

async function renderDetail(id: string): Promise<void> {
  app.innerHTML = shell("Match", loading());
  const data = await api<{ match: MatchCard }>(`/matches/${id}`);
  const match = data.match;
  app.innerHTML = shell(escapeText(matchTitle(match)), `
    <article class="card">
      <div class="meta"><span>${escapeText(match.competition)}</span>${statusChip(match.status, match.bucket)}<span>${match.canBuildXi ? "XI open" : "XI locked"}</span></div>
      ${matchTile(match)}
      <div class="row">
        <a class="back-link" href="#/">← Matches</a>
        <button class="ghost" id="to-contests">Contests</button>
        <button class="primary" id="to-xi" ${match.canBuildXi ? "" : "disabled"}>${match.canBuildXi ? "Build XI" : "XI locked"}</button>
      </div>
    </article>
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

interface ContestBoard {
  freshness?: string;
  timestamps?: { updatedAt?: string };
  leaderboard: Array<{ wallet: string; rank: number; milliPoints: number; priorRank?: number | null; scoreDelta?: number | null }>;
}

function boardRows(rows: ContestBoard["leaderboard"]): string {
  return rows.map((row) => lbRowHtml({ ...row, label: shortWallet(row.wallet), you: row.wallet === state.walletAddress })).join("") || empty("No scored entries yet. Your matchday is just getting started.");
}

function mountLiveBoard(matchId: string, refresh: (signal: AbortSignal) => Promise<boolean>): void {
  const status = document.querySelector<HTMLElement>("#board-status");
  if (!state.token || !status) return;
  stopLiveBoard?.();
  stopLiveBoard = watchLeaderboard({ matchId, token: state.token, refresh, status: (message, connected) => {
    if (!status.isConnected) return;
    status.textContent = message;
    status.dataset.connected = String(connected);
  } });
}

async function renderLeaderboard(contestId: string): Promise<void> {
  const currentRoute = location.hash;
  app.innerHTML = shell("Leaderboard", loading());
  const { contest: card } = await api<{ contest: ContestCard }>(`/contests/${contestId}`);
  let matchLabel = "";
  if (card.matchId) {
    const { match } = await api<{ match: MatchCard }>(`/matches/${card.matchId}`);
    card.matchStatus = match.status;
    card.lifecycleBucket = classifyContestLifecycle({ matchStatus: match.status, hasFinalResult: card.hasFinalResult });
    matchLabel = matchTitle(match);
  }
  let board: ContestBoard | null = null;
  try { board = await api<ContestBoard>(`/contests/${contestId}/leaderboard`); } catch { /* Retry through live reconciliation. */ }
  if (location.hash !== currentRoute) return;
  const completed = board?.freshness === "FINAL" || resolveLifecycle(card) === "completed";
  app.innerHTML = shell(completed ? "Final standings" : "The leaderboard", `
    <div class="lb-head"><div class="meta">${contestBadge(card)}<span>${escapeText(contestTitle(card))}</span></div><span class="board-status" id="board-status" role="status">${completed ? "Final result" : "Connecting…"}</span></div>
    <p class="quiet">${escapeText(matchLabel)}</p>
    <div id="board-freshness">${freshnessBannerHtml(board?.freshness, { demoData: state.demoData })}</div>
    <article class="card"><div class="pool-caption"><span>RANK / PLAYER</span><span>POINTS</span></div><div class="leaderboard" id="live-board">${board ? boardRows(board.leaderboard) : empty("Could not load scores. Retrying…")}</div></article>
    <div class="row"><a class="back-link" href="#/my-contests">← My contests</a><button class="primary" id="to-result">${completed ? "View result ↗" : "My result ↗"}</button></div>
    <p class="quiet" id="board-updated">${board?.timestamps?.updatedAt ? `Updated ${escapeText(formatUpdated(board.timestamps.updatedAt))}` : ""}</p>`);
  document.querySelector("#to-result")?.addEventListener("click", () => { location.hash = `#/contests/${contestId}/result`; });
  void markLeaderboardViewed();
  const rows = document.querySelector("#live-board");
  const freshness = document.querySelector("#board-freshness");
  const updated = document.querySelector("#board-updated");
  if (card.matchId && !completed) mountLiveBoard(card.matchId, async (signal) => {
    const next = await api<ContestBoard>(`/contests/${contestId}/leaderboard`, { signal });
    if (signal.aborted || !rows?.isConnected) return false;
    rows.innerHTML = boardRows(next.leaderboard);
    if (freshness) freshness.innerHTML = freshnessBannerHtml(next.freshness, { demoData: state.demoData });
    if (updated) updated.textContent = next.timestamps?.updatedAt ? `Updated ${formatUpdated(next.timestamps.updatedAt)}` : "";
    if (next.freshness === "FINAL") {
      const title = document.querySelector(".page-title");
      if (title) title.textContent = "Final standings";
      const result = document.querySelector("#to-result");
      if (result) result.textContent = "View result ↗";
    }
    return next.freshness === "FINAL";
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

    const hero = resultHeroHtml({
      matchLabel,
      contestLabel: `${contestLabel}${result.contestType ? ` · ${result.contestType}` : ""}`,
      rank: result.rank,
      totalEntries: result.totalEntries,
      scoreLabel: score,
      free: isFree,
    });
    app.innerHTML = shell("Final result", `
      ${hero}
      ${isFree ? "" : claimHtml}
      <div id="claim-target"></div>
      <p class="quiet">${result.match ? escapeText(result.match.competition) + " · " + escapeText(kickoffLabel(result.match.kickoffAt)) : ""}</p>

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
        <button class="primary" id="load-share">Share FREE result</button>
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
  const currentRoute = location.hash;
  app.innerHTML = shell("Build your XI", loading());
  let matchResp = await api<{ match: MatchCard }>(`/matches/${matchId}`).catch(async () => {
    setSelectedMode("DEMO");
    return apiForMode<{ match: MatchCard }>(`/matches/${matchId}`, "DEMO");
  });
  if (isTutorialMatch(matchResp.match)) setSelectedMode("DEMO");
  else if (state.dualMode) setSelectedMode("LIVE");
  matchResp = isTutorialMatch(matchResp.match)
    ? await apiForMode<{ match: MatchCard }>(`/matches/${matchId}`, "DEMO")
    : await apiForMode<{ match: MatchCard }>(`/matches/${matchId}`, state.dualMode ? "LIVE" : (effectiveDataMode() ?? "LIVE"));
  const playersResp = await api<{ players: PoolPlayer[] }>(`/matches/${matchId}/players`);
  const rulesResp = await api<{ creditCap: number; maxPlayersFromOneTeam: number | null }>(`/matches?bucket=upcoming`);
  const saved = await api<{
    team: { id: string; status: string } | null;
    latest: { id: string; version: number; playerIds: string[]; captainId: string; viceId: string; creditsUsed: number } | null;
    readOnly: boolean;
  }>(`/matches/${matchId}/my-team`);
  if (location.hash !== currentRoute) return;
  const players = playersResp.players;
  const { creditCap, maxPlayersFromOneTeam } = rulesResp;
  const match = matchResp.match;
  const tutorial = isTutorialMatch(match);
  state.creditCap = creditCap;
  state.maxPlayersFromOneTeam = maxPlayersFromOneTeam;
  const readOnly = saved.readOnly || !match.canBuildXi;
  if (saved.latest && (state.teamMatchId !== matchId || state.draft.playerIds.length === 0)) {
    state.draft = { ...state.draft, playerIds: [...saved.latest.playerIds], captainId: saved.latest.captainId, viceId: saved.latest.viceId };
    state.teamVersionId = saved.latest.id;
    state.teamMatchId = matchId;
    sessionStorage.setItem("kickr.dev.teamVersion", saved.latest.id);
    sessionStorage.setItem("kickr.dev.teamMatch", matchId);
  } else if (state.teamMatchId !== matchId) {
    state.draft = { playerIds: [], captainId: "", viceId: "", filter: "ALL", query: "" };
    state.teamVersionId = null;
    state.teamMatchId = matchId;
  }
  const byId = new Map(players.map((p) => [p.playerId, p]));
  const validationPool = players.map((p) => ({ playerId: p.playerId, position: p.position, clubId: p.clubId, credit: p.credit }));
  let saving = false;
  let savedTeamId = saved.team?.id ?? null;
  const validate = () => validateFantasyTeam(state.draft, validationPool, match.home.id, match.away.id, { creditCap, maxPlayersFromOneTeam });
  const selectedPlayers = () => state.draft.playerIds.map((id) => byId.get(id)).filter((p): p is PoolPlayer => Boolean(p));
  const initialNote = saved.latest ? `${readOnly ? "Locked" : "Loaded"} XI · Version ${saved.latest.version}` : "Your team starts here. Make your first pick.";
  app.innerHTML = shell(readOnly ? "Your starting XI" : "Build your XI", `
    ${tutorial ? '<div class="meta" style="margin-bottom:10px"><span class="tutorial-kicker">TUTORIAL MATCH · SIMULATED</span><span class="badge badge-free">FREE</span></div>' : ""}
    <div class="xi-toolbar"><a class="back-link" href="${tutorial ? `#/tutorial/${matchId}` : `#/matches/${matchId}`}">← <strong>${escapeText(matchTitle(match))}</strong></a><span class="quiet">${readOnly ? "LINEUP LOCKED" : "YOUR PICKS. YOUR GAME."}</span></div>
    ${readOnly ? '<div class="lock-banner"><strong>Read-only</strong><span>Kickoff has passed. Your XI is locked for this match.</span></div>' : ""}
    <div class="builder-layout" id="builder">
      ${readOnly ? "" : `<section class="builder-pool card" aria-labelledby="pool-heading"><div class="row"><h2 id="pool-heading">The player pool</h2><span class="quiet">${players.length} players</span></div><p class="quiet">Pick 11. Make them count.</p><label class="sr-only" for="q">Search players or clubs</label><input class="search" id="q" type="search" placeholder="Search players or clubs…" autocomplete="off" value="${escapeText(state.draft.query)}" /><div class="filters" aria-label="Filter by position">${["ALL", "GK", "DEF", "MID", "FWD"].map((f) => `<button type="button" data-filter="${f}" aria-pressed="${state.draft.filter === f}">${f === "ALL" ? "All players" : f}</button>`).join("")}</div><div class="pool-caption"><span>PLAYER / CLUB</span><span>CREDITS / SELECT</span></div><div class="player-list" id="player-list"></div></section>`}
      <aside class="builder-summary" aria-label="Your selected team"><div class="builder-summary-top"><h2>Your starting XI</h2><span class="badge badge-state" id="formation"></span></div><div class="builder-summary-body" id="xi-summary"></div><div class="xi-save-bar">${readOnly ? '<span class="badge badge-state">LOCKED XI</span>' : '<button class="primary" id="save-xi">Save XI ↗</button>'}<button class="ghost" id="to-contests">View contests</button></div><p class="note" id="saved" role="status">${initialNote}</p></aside>
    </div>`);
  const builder = document.querySelector<HTMLElement>("#builder");
  if (!builder) return;
  if (readOnly) builder.style.gridTemplateColumns = "minmax(0, 650px)";
  const paintSummary = () => {
    const selected = selectedPlayers();
    const used = calculateCreditsUsed(selected.map((p) => p.credit));
    const left = remainingCredits(used, creditCap);
    const result = validate();
    const slot = (position: string) => selected.filter((p) => p.position === position).map((p) => playerChip({ displayName: p.displayName, selected: true, role: p.playerId === state.draft.captainId ? "C" : p.playerId === state.draft.viceId ? "VC" : "" })).join("") || `<div class="chip quiet">${position}</div>`;
    const formation = builder.querySelector("#formation");
    if (formation) formation.textContent = `${formationLabel(selected.map((p) => p.position))} · ${selected.length}/11`;
    const summary = builder.querySelector("#xi-summary");
    if (summary) summary.innerHTML = `<div class="credits-panel"><div><div class="quiet">Credits remaining</div><div class="credits-left">${left}</div></div><div class="xi-count">${used} / ${creditCap}</div></div><div class="meter${left < 0 ? " full" : left <= 10 ? " warn" : ""}"><span style="width:${Math.max(0, Math.min(100, used / creditCap * 100))}%"></span></div><div class="pitch"><div class="line">${slot("FWD")}</div><div class="line">${slot("MID")}</div><div class="line">${slot("DEF")}</div><div class="line">${slot("GK")}</div></div>${readOnly ? "" : `<p class="builder-guidance${result.valid ? " ready" : ""}">${result.valid ? "✓ Your XI is ready. Save it and find your rivals." : selected.length < 11 ? `Choose ${11 - selected.length} more player${selected.length === 10 ? "" : "s"}. 1 GK · 3–5 DEF · 3–5 MID · 1–3 FWD.` : "Set your captain (2×) and vice-captain (1.5×)."}</p>${selected.length === 11 && !result.valid ? `<ul class="builder-errors">${result.errors.map((e) => `<li>${escapeText(e.message)}</li>`).join("")}</ul>` : ""}`}`;
    const save = builder.querySelector<HTMLButtonElement>("#save-xi");
    if (save) { save.disabled = saving || !result.valid; save.textContent = saving ? "Saving…" : "Save XI ↗"; }
    const next = builder.querySelector<HTMLButtonElement>("#to-contests");
    if (next) next.disabled = saving;
  };
  const paintPlayers = () => {
    const list = builder.querySelector("#player-list");
    if (!list) return;
    const query = state.draft.query.trim().toLowerCase();
    const filtered = players.filter((p) => (state.draft.filter === "ALL" || p.position === state.draft.filter) && `${p.displayName} ${p.clubName}`.toLowerCase().includes(query));
    list.innerHTML = filtered.map((p) => {
      const selected = state.draft.playerIds.includes(p.playerId);
      return `<div class="player${selected ? " selected" : ""}"><div class="avatar">${escapeText(initials(p.displayName))}</div><div><strong>${escapeText(p.displayName)}</strong><div class="quiet">${escapeText(p.position)} · ${escapeText(p.clubName)}</div></div><div class="actions"><span class="player-credit">${p.credit}<small>CR</small></span>${selected ? `<button type="button" class="ghost" data-cap="${p.playerId}" aria-label="Captain ${escapeText(p.displayName)}" aria-pressed="${p.playerId === state.draft.captainId}" ${saving ? "disabled" : ""}>C</button><button type="button" class="ghost" data-vice="${p.playerId}" aria-label="Vice-captain ${escapeText(p.displayName)}" aria-pressed="${p.playerId === state.draft.viceId}" ${saving ? "disabled" : ""}>VC</button>` : ""}<button type="button" class="ghost" data-toggle="${p.playerId}" aria-label="${selected ? "Remove" : "Add"} ${escapeText(p.displayName)}" aria-pressed="${selected}" ${saving || (!selected && state.draft.playerIds.length >= 11) ? "disabled" : ""}>${selected ? "−" : "+"}</button></div></div>`;
    }).join("") || empty("No players found. Try another name or position.");
  };
  builder.querySelector<HTMLInputElement>("#q")?.addEventListener("input", (event) => {
    state.draft.query = (event.target as HTMLInputElement).value;
    paintPlayers();
  });
  builder.addEventListener("click", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
    if (!button || button.disabled) return;
    if (button.id === "to-contests") { location.hash = `#/matches/${matchId}/contests`; return; }
    if (readOnly || saving) return;
    if (button.dataset.filter) {
      state.draft.filter = button.dataset.filter;
      for (const tab of builder.querySelectorAll<HTMLButtonElement>("[data-filter]")) tab.setAttribute("aria-pressed", String(tab.dataset.filter === state.draft.filter));
      paintPlayers();
      return;
    }
    if (button.id === "save-xi") {
      if (!validate().valid) return;
      const selection = { playerIds: [...state.draft.playerIds], captainId: state.draft.captainId, viceId: state.draft.viceId };
      saving = true;
      paintSummary(); paintPlayers();
      void (async () => {
        const note = builder.querySelector("#saved");
        try {
          // Retain a newly created team even if saving its version fails.
          if (!savedTeamId) {
            const created = await api<{ team: { id: string } }>("/teams", { method: "POST", body: JSON.stringify({ matchId }) });
            savedTeamId = created.team.id;
          }
          await saveXi(matchId, savedTeamId, selection, currentRoute);
        } catch (error) {
          if (note) note.textContent = error instanceof Error ? error.message : "Could not save your XI. Try again.";
        } finally {
          saving = false;
          if (builder.isConnected) { paintSummary(); paintPlayers(); }
        }
      })();
      return;
    }
    const id = button.dataset.toggle ?? button.dataset.cap ?? button.dataset.vice;
    if (!id || !byId.has(id)) return;
    if (button.dataset.toggle) {
      if (state.draft.playerIds.includes(id)) {
        state.draft.playerIds = state.draft.playerIds.filter((p) => p !== id);
        if (state.draft.captainId === id) state.draft.captainId = "";
        if (state.draft.viceId === id) state.draft.viceId = "";
      } else if (state.draft.playerIds.length < 11) state.draft.playerIds.push(id);
    } else if (button.dataset.cap) {
      state.draft.captainId = id;
      if (state.draft.viceId === id) state.draft.viceId = "";
    } else {
      state.draft.viceId = id;
      if (state.draft.captainId === id) state.draft.captainId = "";
    }
    state.teamVersionId = null;
    sessionStorage.removeItem("kickr.dev.teamVersion");
    const note = builder.querySelector("#saved");
    if (note) note.textContent = "Unsaved changes · Save your XI before joining a contest.";
    paintSummary(); paintPlayers();
    // Keep keyboard navigation on the action that was just updated.
    const attribute = button.dataset.toggle ? "data-toggle" : button.dataset.cap ? "data-cap" : "data-vice";
    builder.querySelector<HTMLButtonElement>(`[${attribute}="${id}"]`)?.focus({ preventScroll: true });
  });
  paintSummary(); paintPlayers();
}

async function saveXi(
  matchId: string,
  existingTeamId: string | null,
  selection: Pick<Draft, "playerIds" | "captainId" | "viceId">,
  sourceRoute: string,
): Promise<void> {
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
      body: JSON.stringify(selection),
    },
  );
  // A completed save must not overwrite another match's draft or redirect a new page.
  if (location.hash !== sourceRoute || state.teamMatchId !== matchId) return;
  state.teamVersionId = saved.version.id;
  state.teamMatchId = matchId;
  sessionStorage.setItem("kickr.dev.teamVersion", saved.version.id);
  sessionStorage.setItem("kickr.dev.teamMatch", matchId);
  const pending = readLeagueInviteFromRoute();
  if (pending?.inviteCode && (!pending.matchId || pending.matchId === matchId)) {
    const note = document.querySelector("#saved");
    if (note) note.textContent = `Saved XI v${saved.version.version}. Returning to confirm join…`;
    location.hash = joinConfirmHash(pending.inviteCode, { matchId, xiSaved: true });
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
  const inviteCtx: LeagueReturnContext = {
    inviteCode: league.inviteCode,
    matchId: league.matchId,
    leagueId: league.id,
  };
  document.querySelector("#build-xi-return")?.addEventListener("click", () => {
    location.hash = xiBuilderHash(league.matchId, inviteCtx);
  });
  document.querySelector("#confirm-join")?.addEventListener("click", () => {
    void (async () => {
      const note = document.querySelector("#join-note");
      try {
        if (!state.teamVersionId || state.teamMatchId !== league.matchId) {
          if (note) note.textContent = "XI required — opening builder…";
          location.hash = xiBuilderHash(league.matchId, inviteCtx);
          return;
        }
        const joined = await api<{ league: LeagueCard }>("/leagues/join", {
          method: "POST",
          headers: { "idempotency-key": `lgj-${Date.now()}` },
          body: JSON.stringify({ inviteCode: league.inviteCode, teamVersionId: state.teamVersionId }),
        });
        location.hash = `#/leagues/${joined.league.id}`;
      } catch (error) {
        if (note) note.textContent = error instanceof Error ? error.message : "Join failed";
      }
    })();
  });

  // Returning from XI (durable query xiSaved=1 or in-session XI): confirm only — never auto-join.
  const routeInvite = readLeagueInviteFromRoute();
  if (
    !league.youJoined &&
    hasXi &&
    (routeInvite?.xiSaved || routeInvite?.inviteCode === league.inviteCode)
  ) {
    const note = document.querySelector("#join-note");
    if (note) note.textContent = "XI saved. Press Join League to confirm.";
  }
}

async function renderLeagueDetail(id: string): Promise<void> {
  app.innerHTML = shell("League", loading());
  const data = await api<{ league: LeagueCard }>(`/leagues/${id}`);
  const league = data.league;
  const isFinal = league.lifecycleBucket === "completed" || league.status === "FINAL" || league.status === "CLOSED";
  const isUpcoming = league.lifecycleBucket === "upcoming" || (!isFinal && league.lifecycleBucket !== "live");
  // Owner is not auto-counted as a member until they join with an XI — label that clearly.
  let memberNote = `${league.memberCount} / ${league.capacity} members`;
  if (league.isOwner && !league.youJoined) {
    memberNote += " · You own this league (join with your XI to compete)";
  } else if (league.isOwner && league.youJoined) {
    memberNote += " · You own &amp; joined";
  } else if (league.youJoined) {
    memberNote += " · Joined";
  }
  const shareBtn = isFinal
    ? `<button class="ghost" id="league-share-btn" type="button">Share result</button>`
    : "";
  const primaryInvite = isUpcoming
    ? `<button class="primary" id="copy-invite" type="button">Invite friends</button>
        <button class="ghost" id="copy-invite-code" type="button">Copy invite</button>`
    : `<button class="ghost" id="copy-invite" type="button">Copy invite</button>`;
  const xiBtn = `<button class="ghost" data-xi="${league.matchId}" type="button">Build / Review XI</button>`;
  const boardBtn = `<button class="${isUpcoming ? "ghost" : "primary"}" data-board="${league.id}" type="button">Leaderboard</button>`;
  app.innerHTML = shell(escapeText(league.name), `
    <article class="card">
      <div class="meta"><span class="badge badge-free">FREE</span><span>${escapeText(league.status)}</span>${statusChip(league.status, league.lifecycleBucket)}</div>
      <p class="quiet">${memberNote}</p>
      <p>Invite code <strong class="mono">${escapeText(league.inviteCode)}</strong></p>
      <div class="row league-actions">
        ${primaryInvite}
        ${xiBtn}
        ${boardBtn}
        ${shareBtn}
        <a class="back-link" href="#/leagues">← Leagues</a>
      </div>
      <div id="share-slot"></div>
    </article>
  `);
  const copyInvite = async (btnSel: string) => {
    try {
      await navigator.clipboard.writeText(league.inviteCode);
      const btn = document.querySelector(btnSel);
      if (btn) btn.textContent = "Copied";
    } catch { /* ignore */ }
  };
  document.querySelector("#copy-invite")?.addEventListener("click", () => { void copyInvite("#copy-invite"); });
  document.querySelector("#copy-invite-code")?.addEventListener("click", () => { void copyInvite("#copy-invite-code"); });
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
  const currentRoute = location.hash;
  app.innerHTML = shell("League leaderboard", loading());
  type LeagueBoard = { league: LeagueCard; freshness: string; rows: Array<{ rank: number; wallet: string; milliPoints: number; you: boolean }> };
  const board = await api<LeagueBoard>(`/leagues/${id}/leaderboard`);
  if (location.hash !== currentRoute) return;
  const isFinal = (value: LeagueBoard) => value.league.lifecycleBucket === "completed" || value.freshness === "FINAL";
  app.innerHTML = shell(escapeText(board.league.name), `
    <div class="lb-head"><div class="meta"><span class="badge badge-free">FREE PRIVATE LEAGUE</span></div><span class="board-status" id="board-status" role="status">${isFinal(board) ? "Final result" : "Connecting…"}</span></div>
    <div id="board-freshness">${freshnessBannerHtml(board.freshness === "FINAL" ? null : board.freshness, { demoData: state.demoData })}</div>
    <article class="card"><div class="pool-caption"><span>RANK / PLAYER</span><span>POINTS</span></div><div class="leaderboard" id="live-board">${boardRows(board.rows)}</div></article>
    <div class="row"><a class="back-link" href="#/leagues/${id}">← League</a><a class="ghost" id="league-share" href="#/share/league/${id}" ${isFinal(board) ? "" : "hidden"}>Share result ↗</a></div><div id="share-slot"></div>`);
  void markLeaderboardViewed();
  const rows = document.querySelector("#live-board");
  const freshness = document.querySelector("#board-freshness");
  if (!isFinal(board)) mountLiveBoard(board.league.matchId, async (signal) => {
    const next = await api<LeagueBoard>(`/leagues/${id}/leaderboard`, { signal });
    if (signal.aborted || !rows?.isConnected) return false;
    rows.innerHTML = boardRows(next.rows);
    if (freshness) freshness.innerHTML = freshnessBannerHtml(isFinal(next) ? null : next.freshness, { demoData: state.demoData });
    const share = document.querySelector<HTMLElement>("#league-share");
    if (share) share.hidden = !isFinal(next);
    return isFinal(next);
  });
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


async function renderTutorialInfo(matchId: string): Promise<void> {
  setSelectedMode("DEMO");
  app.innerHTML = shell("Tutorial Match", loading());
  const data = await apiForMode<{ match: MatchCard }>(`/matches/${matchId}`, "DEMO");
  const match = data.match;
  app.innerHTML = shell("Tutorial Match · Simulated", `
    <article class="card tutorial-card">
      <div class="meta"><span class="tutorial-kicker">TUTORIAL MATCH · SIMULATED</span><span class="badge badge-free">FREE</span></div>
      <h2>${escapeText(match.home.name)} vs ${escapeText(match.away.name)}</h2>
      <p>Learn KICKR by playing through a complete simulated match.</p>
      <ul class="tutorial-bullets">
        <li>Fictional clubs &amp; players — not a live Sportmonks fixture</li>
        <li>Build a real XI (11 players, C/VC, 100-credit budget, formation rules)</li>
        <li>Join the FREE Tutorial Contest — no wallet payment</li>
        <li>Start Match Simulation — auto-progress PRE → 1H → HT → 2H → FT (~4 min)</li>
        <li>See goals, assists, SOT, cards, subs, captain bonus, and a VAR reversal</li>
      </ul>
      <div class="row">
        <a class="back-link" href="#/">← Matches</a>
        <button class="primary" id="tut-build">Build Your XI</button>
      </div>
    </article>
  `);
  document.querySelector("#tut-build")?.addEventListener("click", () => {
    location.hash = `#/matches/${matchId}/xi`;
  });
}

async function renderTutorialHub(matchId: string): Promise<void> {
  setSelectedMode("DEMO");
  app.innerHTML = shell("Tutorial Match", loading());
  const data = await apiForMode<{ match: MatchCard }>(`/matches/${matchId}`, "DEMO");
  const match = data.match;
  let sim: { completed?: boolean; running?: boolean; matchStatus?: string } | null = null;
  try {
    sim = await api(`/v1/tutorial/matches/${matchId}`);
  } catch { /* not started */ }
  const saved = await apiForMode<{
    team: { id: string } | null;
    latest: { id: string } | null;
    readOnly: boolean;
  }>(`/matches/${matchId}/my-team`, "DEMO");
  if (saved.latest) {
    state.teamVersionId = saved.latest.id;
    state.teamMatchId = matchId;
  }
  const hasXi = Boolean(saved.latest);
  let joined = false;
  try {
    const contests = await apiForMode<{ contests: ContestCard[] }>(`/matches/${matchId}/contests`, "DEMO");
    const free = contests.contests.find((c) => c.contestKind === "FREE");
    if (free) {
      const mine = await api<{ contests: ContestCard[] }>("/me/contests").catch(() => ({ contests: [] }));
      joined = mine.contests.some((c) => c.contestId === free.contestId);
    }
  } catch { /* ignore */ }

  const status = sim?.matchStatus ?? match.status;
  const done = sim?.completed || status === "FINAL";
  const running = Boolean(sim?.running);

  let primary = `<button class="primary" id="tut-build">${hasXi ? "Edit XI" : "Build Your XI"}</button>`;
  if (done) {
    primary = `<button class="primary" id="tut-complete">Tutorial Complete</button>`;
  } else if (running || status === "LIVE") {
    primary = `<button class="primary" id="tut-sim">Continue Simulation</button>`;
  } else if (hasXi) {
    primary = `<button class="primary" id="tut-contests">Join Tutorial Contest</button>
      <button class="ghost" id="tut-sim-start">Start Match Simulation</button>`;
  }

  app.innerHTML = shell("Tutorial Match · Simulated", `
    <article class="card tutorial-card">
      <div class="meta"><span class="tutorial-kicker">TUTORIAL MATCH · SIMULATED</span><span class="badge badge-free">FREE</span></div>
      <h2>${escapeText(match.home.name)} vs ${escapeText(match.away.name)}</h2>
      <p class="quiet">Learn KICKR by playing through a complete simulated match.</p>
      ${matchTile(match)}
      <ol class="tutorial-steps">
        <li class="${hasXi ? "done" : ""}">Build Your XI (real squad builder)</li>
        <li class="${joined ? "done" : ""}">Join Tutorial Contest — FREE · SIMULATED</li>
        <li class="${running || done ? "done" : ""}">Start Match Simulation (auto-progress)</li>
        <li class="${done ? "done" : ""}">See final score, rank &amp; captain contribution</li>
      </ol>
      <div class="row">
        <a class="back-link" href="#/">← Matches</a>
        <button class="ghost" id="tut-info">How it works</button>
        ${primary}
      </div>
      ${done ? `<div class="row" style="margin-top:12px"><button class="ghost" id="tut-reset">Reset Tutorial</button></div>` : ""}
      <p class="note" id="tut-note"></p>
    </article>
  `);
  document.querySelector("#tut-info")?.addEventListener("click", () => { location.hash = `#/tutorial/${matchId}/info`; });
  document.querySelector("#tut-build")?.addEventListener("click", () => { location.hash = `#/matches/${matchId}/xi`; });
  document.querySelector("#tut-contests")?.addEventListener("click", () => { location.hash = `#/matches/${matchId}/contests`; });
  document.querySelector("#tut-sim")?.addEventListener("click", () => { location.hash = `#/tutorial/${matchId}/simulate`; });
  document.querySelector("#tut-sim-start")?.addEventListener("click", () => {
    void (async () => {
      const note = document.querySelector("#tut-note");
      try {
        if (!state.teamVersionId) {
          if (note) note.textContent = "Save an XI before starting the simulation.";
          return;
        }
        // Auto-join FREE contest if not joined
        const contests = await apiForMode<{ contests: ContestCard[] }>(`/matches/${matchId}/contests`, "DEMO");
        const free = contests.contests.find((c) => c.contestKind === "FREE");
        if (free && state.teamVersionId) {
          try {
            await api(`/contests/${free.contestId}/free-join`, {
              method: "POST",
              body: JSON.stringify({ teamVersionId: state.teamVersionId }),
            });
          } catch { /* may already be joined */ }
        }
        await api(`/v1/tutorial/matches/${matchId}/start`, { method: "POST", body: "{}" });
        location.hash = `#/tutorial/${matchId}/simulate`;
      } catch (error) {
        if (note) note.textContent = error instanceof Error ? error.message : "Could not start simulation";
      }
    })();
  });
  document.querySelector("#tut-complete")?.addEventListener("click", () => { location.hash = `#/tutorial/${matchId}/complete`; });
  document.querySelector("#tut-reset")?.addEventListener("click", () => {
    void (async () => {
      await api(`/v1/tutorial/matches/${matchId}/reset`, { method: "POST", body: "{}" });
      state.teamVersionId = null;
      location.hash = `#/tutorial/${matchId}`;
      void render();
    })();
  });
}

let tutorialPoll: ReturnType<typeof setInterval> | null = null;
function stopTutorialPoll(): void {
  if (tutorialPoll) {
    clearInterval(tutorialPoll);
    tutorialPoll = null;
  }
}

async function renderTutorialSimulate(matchId: string): Promise<void> {
  setSelectedMode("DEMO");
  stopTutorialPoll();
  app.innerHTML = shell("Match Simulation", loading("Simulating…"));

  const paint = async () => {
    const status = await api<{
      phase: string;
      matchMinute: number;
      period: string;
      footballScore: { home: number; away: number };
      completed: boolean;
      running: boolean;
      matchStatus: string;
      recentSteps: Array<{ label?: string; eventType?: string; matchMinute?: number; coachTip?: { id: string; title: string; body: string } }>;
      coachTips: Array<{ id: string; title: string; body: string }>;
      elapsedMs: number;
      durationMs: number;
    }>(`/v1/tutorial/matches/${matchId}`);

    const match = (await apiForMode<{ match: MatchCard }>(`/matches/${matchId}`, "DEMO")).match;
    let boardHtml = empty("Leaderboard updating…");
    let pointsHtml = "";
    try {
      const contests = await apiForMode<{ contests: ContestCard[] }>(`/matches/${matchId}/contests`, "DEMO");
      const free = contests.contests.find((c) => c.contestKind === "FREE");
      if (free) {
        const board = await api<{
          leaderboard: Array<{ wallet: string; milliPoints: number; rank: number; scoreDelta?: number | null }>;
        }>(`/contests/${free.contestId}/leaderboard`);
        boardHtml = board.leaderboard.slice(0, 8).map((row) =>
          `<div class="lb-row"><span>#${row.rank}</span><span>${escapeText(row.wallet.slice(0, 4) + "…" + row.wallet.slice(-4))}</span><strong>${(row.milliPoints / 1000).toFixed(1)}</strong></div>`
        ).join("") || empty("No entries yet");
        if (state.walletAddress) {
          const mine = board.leaderboard.find((r) => r.wallet === state.walletAddress);
          if (mine) pointsHtml = `<div class="sim-points">Your fantasy: <strong>${(mine.milliPoints / 1000).toFixed(1)}</strong> · Rank #${mine.rank}</div>`;
        }
      }
    } catch { /* ignore */ }

    const eventsHtml = status.recentSteps.map((s) =>
      `<div class="sim-event"><span class="quiet">${s.matchMinute ?? ""}'</span> <strong>${escapeText(s.label || s.eventType || "Update")}</strong></div>`
    ).join("") || `<div class="quiet">Waiting for kick-off…</div>`;

    const dismissed = new Set((sessionStorage.getItem("kickr.tutorial.tips") ?? "").split(",").filter(Boolean));
    const tips = status.coachTips.filter((t) => !dismissed.has(t.id));
    const tipHtml = tips.slice(-1).map((t) =>
      `<aside class="coach-tip" data-tip="${escapeText(t.id)}"><strong>${escapeText(t.title)}</strong><p>${escapeText(t.body)}</p><button type="button" class="ghost" data-dismiss-tip="${escapeText(t.id)}">Got it</button></aside>`
    ).join("");

    const pct = Math.min(100, Math.round((status.elapsedMs / Math.max(1, status.durationMs)) * 100));

    app.innerHTML = shell("TUTORIAL MATCH · SIMULATED", `
      <article class="card tutorial-card sim-card">
        <div class="meta"><span class="badge badge-simulated">SIMULATED</span><span class="badge badge-live">${escapeText(status.phase)}</span><span class="quiet">${status.matchMinute}' · ${escapeText(status.period)}</span></div>
        <div class="sim-scoreboard">
          <div><strong>${escapeText(match.home.shortName)}</strong><div class="sim-score">${status.footballScore.home}</div></div>
          <div class="sim-clock">${status.matchMinute}'</div>
          <div><strong>${escapeText(match.away.shortName)}</strong><div class="sim-score">${status.footballScore.away}</div></div>
        </div>
        <div class="meter"><span style="width:${pct}%"></span></div>
        ${pointsHtml}
        ${tipHtml}
        <h3>Event feed</h3>
        <div class="sim-feed">${eventsHtml}</div>
        <h3>Leaderboard</h3>
        <div class="leaderboard">${boardHtml}</div>
        <div class="row" style="margin-top:16px">
          <a class="back-link" href="#/tutorial/${matchId}">← Tutorial</a>
          ${status.completed ? `<button class="primary" id="tut-to-complete">See final result</button>` : `<span class="quiet">Auto-progressing…</span>`}
        </div>
      </article>
    `);
    document.querySelector("#tut-to-complete")?.addEventListener("click", () => {
      location.hash = `#/tutorial/${matchId}/complete`;
    });
    for (const btn of document.querySelectorAll<HTMLButtonElement>("[data-dismiss-tip]")) {
      btn.addEventListener("click", () => {
        const id = btn.dataset.dismissTip ?? "";
        const cur = new Set((sessionStorage.getItem("kickr.tutorial.tips") ?? "").split(",").filter(Boolean));
        cur.add(id);
        sessionStorage.setItem("kickr.tutorial.tips", [...cur].join(","));
        void paint();
      });
    }
    if (status.completed) {
      stopTutorialPoll();
      location.hash = `#/tutorial/${matchId}/complete`;
    }
  };

  try {
    await api(`/v1/tutorial/matches/${matchId}/start`, { method: "POST", body: "{}" }).catch(() => api(`/v1/tutorial/matches/${matchId}/tick`, { method: "POST", body: "{}" }));
  } catch { /* may already be running */ }
  await paint();
  tutorialPoll = setInterval(() => { void paint(); }, 1500);
}

async function renderTutorialComplete(matchId: string): Promise<void> {
  setSelectedMode("DEMO");
  stopTutorialPoll();
  app.innerHTML = shell("Tutorial Complete", loading());
  const match = (await apiForMode<{ match: MatchCard }>(`/matches/${matchId}`, "DEMO")).match;
  const status = await api<{
    footballScore: { home: number; away: number };
    recentSteps: Array<{ label?: string; eventType?: string; matchMinute?: number }>;
  }>(`/v1/tutorial/matches/${matchId}`);
  let rankHtml = "";
  let fantasy = "";
  let boardHtml = "";
  try {
    const contests = await apiForMode<{ contests: ContestCard[] }>(`/matches/${matchId}/contests`, "DEMO");
    const free = contests.contests.find((c) => c.contestKind === "FREE");
    if (free) {
      const board = await api<{
        leaderboard: Array<{ wallet: string; milliPoints: number; rank: number }>;
      }>(`/contests/${free.contestId}/leaderboard`);
      boardHtml = board.leaderboard.map((row) =>
        `<div class="lb-row"><span>#${row.rank}</span><span>${escapeText(row.wallet.slice(0, 4) + "…" + row.wallet.slice(-4))}</span><strong>${(row.milliPoints / 1000).toFixed(1)}</strong></div>`
      ).join("");
      const mine = board.leaderboard.find((r) => r.wallet === state.walletAddress);
      if (mine) {
        fantasy = `${(mine.milliPoints / 1000).toFixed(1)} pts`;
        rankHtml = `Rank #${mine.rank}`;
      }
    }
  } catch { /* ignore */ }
  const keyEvents = status.recentSteps.filter((s) => s.eventType === "GOAL" || s.eventType === "VAR_REVERSAL" || s.eventType === "ASSIST" || s.label?.includes("VAR")).slice(-6);
  const keyEventsHtml = keyEvents.map((s) => `<div class="sim-event">${s.matchMinute ?? ""}' ${escapeText(s.label || s.eventType || "")}</div>`).join("") || empty("No events");
  app.innerHTML = shell("Tutorial Complete", `
    <article class="card tutorial-card">
      <div class="meta"><span class="tutorial-kicker">TUTORIAL COMPLETE</span><span class="badge badge-simulated">SIMULATED</span></div>
      <h2>${escapeText(match.home.name)} ${status.footballScore.home}-${status.footballScore.away} ${escapeText(match.away.name)}</h2>
      <p class="quiet">Final football score · ${escapeText(fantasy || "Fantasy scored")} · ${escapeText(rankHtml || "")}</p>
      <h3>Key events</h3>
      <div class="sim-feed">${keyEventsHtml}</div>
      <h3>Contest leaderboard</h3>
      <div class="leaderboard">${boardHtml || empty("No leaderboard")}</div>
      <div class="row" style="margin-top:18px">
        <button class="ghost" id="tut-reset2">Reset Tutorial</button>
        <button class="primary" id="tut-upcoming">View Upcoming Matches</button>
      </div>
      <p class="note">Next up: Rangers vs Kilmarnock on the real Sportmonks fixture.</p>
    </article>
  `);
  document.querySelector("#tut-upcoming")?.addEventListener("click", () => {
    setSelectedMode("LIVE");
    location.hash = "#/";
  });
  document.querySelector("#tut-reset2")?.addEventListener("click", () => {
    void (async () => {
      await api(`/v1/tutorial/matches/${matchId}/reset`, { method: "POST", body: "{}" });
      location.hash = `#/tutorial/${matchId}`;
    })();
  });
}


window.addEventListener("pagehide", () => { stopLiveBoard?.(); });
window.addEventListener("hashchange", () => { void render(); });
void render();
