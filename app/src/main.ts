import { Buffer } from "buffer";
import nacl from "tweetnacl";
import bs58 from "bs58";
import { Connection, Keypair, type Transaction } from "@solana/web3.js";
import { buildDepositTransaction, type DepositPlan } from "../../solana/escrow.js";
import { assertDevCluster } from "../../solana/ids.js";

Object.assign(globalThis, { Buffer });
import { calculateCreditsUsed, remainingCredits } from "../../domain/football/credits.js";
import { formationLabel } from "../../domain/football/presentation.js";
import { validateFantasyTeam } from "../../domain/football/validate-team.js";

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

interface Draft {
  playerIds: string[];
  captainId: string;
  viceId: string;
  filter: string;
  query: string;
}

const root = document.querySelector("#app");
if (!(root instanceof HTMLElement)) {
  throw new Error("missing app root");
}
const app: HTMLElement = root;

const state: {
  token: string | null;
  bucket: "upcoming" | "live" | "completed";
  creditCap: number;
  maxPlayersFromOneTeam: number | null;
  draft: Draft;
  teamVersionId: string | null;
  teamMatchId: string | null;
  joinNote: string;
  joinPhase: "RESERVING" | "AWAITING_WALLET" | "SUBMITTED" | "VERIFYING" | "CONFIRMED" | "FAILED" | "EXPIRED" | "";
  depositPlan: DepositPlan | null;
  depositSignature: string | null;
  publicCluster: string;
  publicProgramId: string;
  publicMint: string;
  publicDecimals: number;
} = {
  token: sessionStorage.getItem("kickr.dev.token"),
  bucket: "upcoming",
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
  publicProgramId: "",
  publicMint: "",
  publicDecimals: 6,
};

function route(): string {
  return location.hash || "#/";
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  if (state.token) {
    headers.set("authorization", `Bearer ${state.token}`);
  }
  if (init?.body) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json()) as T & { error?: { message: string; details?: { errors: Array<{ message: string }> } } };
  if (!response.ok) {
    const details = body.error?.details?.errors?.map((error) => error.message).join(" ");
    throw new Error(details || body.error?.message || "Request failed");
  }
  return body;
}

async function signIn(): Promise<void> {
  const pair = nacl.sign.keyPair();
  const walletAddress = bs58.encode(pair.publicKey);
  const nonce = await api<{ message: string }>("/v1/auth/nonce", {
    method: "POST",
    body: JSON.stringify({ walletAddress }),
  });
  const signature = bs58.encode(nacl.sign.detached(new TextEncoder().encode(nonce.message), pair.secretKey));
  const session = await api<{ token: string }>("/v1/auth/login", {
    method: "POST",
    body: JSON.stringify({ walletAddress, message: nonce.message, signature }),
  });
  state.token = session.token;
  sessionStorage.setItem("kickr.dev.token", session.token);
}

function shell(title: string, body: string): string {
  return `<div class="shell">
    <div class="top"><div class="brand">KICKR</div><div class="quiet">${state.token ? "Development signer" : ""}</div></div>
    <h1>${title}</h1>
    ${body}
    <p class="note">Credits are a squad budget, not USDC. A reservation is not a seat. Entry confirmed appears only after the backend verifies a finalized deposit. Development matches are not a live feed.</p>
  </div>`;
}

function kickoffLabel(iso: string): string {
  return new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(iso));
}

async function render(): Promise<void> {
  const hash = route();
  if (!state.token) {
    app.innerHTML = shell("Build an XI.", `<p class="quiet">Sign in with a development key to open matches. This is not a production wallet.</p><button class="primary" id="signin">Sign in</button>`);
    document.querySelector("#signin")?.addEventListener("click", () => {
      void signIn().then(render);
    });
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
}

async function renderList(): Promise<void> {
  const data = await api<{ matches: MatchCard[]; creditCap: number; maxPlayersFromOneTeam: number | null }>(`/matches?bucket=${state.bucket}`);
  state.creditCap = data.creditCap;
  state.maxPlayersFromOneTeam = data.maxPlayersFromOneTeam;
  const cards = data.matches.map((match) => `<article class="card">
      <div class="meta"><span>${match.competition}</span><span>${match.status.replaceAll("_", " ")}</span></div>
      <h2>${match.home.shortName} vs ${match.away.shortName}</h2>
      <p class="quiet">${match.home.name} · ${match.away.name}<br>${kickoffLabel(match.kickoffAt)}</p>
      <div class="row">
        <span class="quiet">${match.canBuildXi ? "XI open" : "XI closed"}</span>
        <button class="ghost" data-contests="${match.id}">Contests</button>
        <button class="primary" data-build="${match.id}" ${match.canBuildXi ? "" : "disabled"}>${match.canBuildXi ? "Build XI" : match.bucket === "live" ? "Live" : "Closed"}</button>
      </div>
    </article>`).join("");
  app.innerHTML = shell("Matches", `
    <div class="tabs">
      ${(["upcoming", "live", "completed"] as const).map((bucket) => `<button type="button" data-bucket="${bucket}" aria-pressed="${state.bucket === bucket}">${bucket}</button>`).join("")}
    </div>
    ${cards || `<p class="quiet">No matches in this view.</p>`}
  `);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-bucket]")) {
    button.addEventListener("click", () => {
      state.bucket = button.dataset.bucket as typeof state.bucket;
      void render();
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-contests]")) {
    button.addEventListener("click", () => {
      location.hash = `#/matches/${button.dataset.contests}/contests`;
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-build]")) {
    button.addEventListener("click", () => {
      location.hash = `#/matches/${button.dataset.build}/xi`;
    });
  }
}


interface ContestCard {
  contestId: string;
  templateCode: string;
  contestType: string;
  entryFeeBaseUnits: number;
  capacity: number;
  filledCount: number;
  remaining: number;
  status: string;
  lockTime: string;
  estimatedPrizePoolBaseUnits: number;
  estimated: true;
  funded: false;
  estimateLabel: string;
}

function formatUsdc(baseUnits: number): string {
  const whole = Math.trunc(baseUnits / 1_000_000);
  const fraction = Math.abs(baseUnits % 1_000_000);
  if (fraction === 0) {
    return String(whole);
  }
  const digits = String(fraction).padStart(6, "0").replace(/0+$/, "");
  return `${whole}.${digits}`;
}

function contestTitle(card: ContestCard): string {
  const dollars = formatUsdc(card.entryFeeBaseUnits);
  if (card.contestType === "HEAD_TO_HEAD") {
    return `H2H $${dollars}`;
  }
  if (card.contestType === "GRAND_LEAGUE") {
    return `Grand League $${dollars}`;
  }
  return `WTA $${dollars}`;
}

async function renderContests(id: string): Promise<void> {
  const data = await api<{ contests: ContestCard[] }>(`/matches/${id}/contests`);
  const cards = data.contests.map((contest) => `<article class="card">
      <div class="meta"><span>${contest.templateCode}</span><span>${contest.filledCount}/${contest.capacity}</span></div>
      <h2>${contestTitle(contest)}</h2>
      <p class="quiet">${formatUsdc(contest.entryFeeBaseUnits)} USDC entry · ${contest.remaining} seats left · ${contest.status.replaceAll("_", " ")}</p>
      <p class="quiet">Estimated pool ${formatUsdc(contest.estimatedPrizePoolBaseUnits)} USDC. ${contest.estimateLabel}.</p>
      <button class="primary" data-join="${contest.contestId}">Join</button>
    </article>`).join("");
  app.innerHTML = shell("Contests", `
    <div class="row"><a class="quiet" href="#/matches/${id}">Match</a><a class="quiet" href="#/">Matches</a></div>
    ${cards || `<p class="quiet">No open contests.</p>`}
    ${joinPanel()}
  `);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-join]")) {
    button.addEventListener("click", () => {
      void joinContest(id, button.dataset.join ?? "");
    });
  }
  document.querySelector("#sign-deposit")?.addEventListener("click", () => {
    void signDeposit(id);
  });
}

function joinPanel(): string {
  if (!state.joinPhase) {
    return `<p class="note" id="join-note">${escapeText(state.joinNote)}</p>`;
  }
  const plan = state.depositPlan;
  const planText = plan
    ? `<ul class="quiet">
        <li>Contest ${escapeText(plan.contestId)}</li>
        <li>Fee ${formatUsdc(plan.feeBaseUnits)} USDC (${plan.feeBaseUnits} base units)</li>
        <li>Mint ${escapeText(plan.mint)}</li>
        <li>Team version ${escapeText(plan.teamVersionId)}</li>
        <li>Vault ${escapeText(plan.vault)}</li>
        <li>Network ${escapeText(plan.cluster)}</li>
        <li>Expires ${escapeText(plan.expiresAt)}</li>
      </ul>`
    : `<p class="quiet">Deposit plan is unavailable until a devnet USDC mint is configured.</p>`;
  const signature = state.depositSignature
    ? `<p>Signature ${escapeText(state.depositSignature)}</p><p><a href="${explorerTx(state.depositSignature, state.publicCluster)}">Explorer</a></p>`
    : "";
  const sign = state.joinPhase === "AWAITING_WALLET"
    ? `<button class="primary" id="sign-deposit">Sign deposit</button>`
    : "";
  const label = phaseLabel(state.joinPhase);
  return `<section class="card"><h2>${escapeText(label)}</h2>${planText}<p class="note">${escapeText(state.joinNote)}</p>${signature}${sign}</section>`;
}

function phaseLabel(phase: typeof state.joinPhase): string {
  if (phase === "RESERVING") return "Reserving";
  if (phase === "AWAITING_WALLET") return "Awaiting wallet";
  if (phase === "SUBMITTED") return "Transaction submitted";
  if (phase === "VERIFYING") return "Verifying finalized deposit";
  if (phase === "CONFIRMED") return "Entry confirmed";
  if (phase === "FAILED") return "Failed";
  if (phase === "EXPIRED") return "Expired";
  return "";
}

function explorerTx(signature: string, cluster: string): string {
  const suffix = cluster === "devnet" || cluster === "testnet" ? `?cluster=${cluster}` : "";
  return `https://explorer.solana.com/tx/${encodeURIComponent(signature)}${suffix}`;
}

function escapeText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");
}

function publicRpc(cluster: string): string {
  if (cluster === "devnet") return "https://api.devnet.solana.com";
  if (cluster === "testnet") return "https://api.testnet.solana.com";
  if (cluster === "localhost" || cluster === "localnet") return "http://127.0.0.1:8899";
  throw new Error("Unsupported cluster");
}

async function loadPublicEscrow(): Promise<void> {
  const config = await api<{
    solanaCluster: string;
    escrowProgramId: string;
    usdcMint: string;
    usdcDecimals: number;
  }>("/v1/config/public");
  state.publicCluster = config.solanaCluster;
  state.publicProgramId = config.escrowProgramId;
  state.publicMint = config.usdcMint;
  state.publicDecimals = config.usdcDecimals;
  assertDevCluster(config.solanaCluster);
}

async function joinContest(matchId: string, contestId: string): Promise<void> {
  if (!state.teamVersionId || state.teamMatchId !== matchId) {
    state.joinPhase = "FAILED";
    state.joinNote = "Save an XI for this match before reserving a seat.";
    await renderContests(matchId);
    return;
  }
  state.joinPhase = "RESERVING";
  state.depositPlan = null;
  state.depositSignature = null;
  state.joinNote = "Reserving a seat. This is not a deposit and not an entry.";
  await renderContests(matchId);
  try {
    await loadPublicEscrow();
    const reserved = await api<{
      payment: string;
      reservation: { id: string; status: string; expiresAt: string };
      entry: { status: string };
      depositPlan: DepositPlan | null;
    }>(`/contests/${contestId}/reservations`, {
      method: "POST",
      body: JSON.stringify({ teamVersionId: state.teamVersionId }),
    });
    if (reserved.reservation.status !== "PENDING" || reserved.entry.status !== "PENDING" || reserved.payment !== "PAYMENT COMING IN PHASE 4") {
      state.joinPhase = "FAILED";
      state.joinNote = "Reservation failed. Nothing was marked paid.";
    } else if (!reserved.depositPlan) {
      state.joinPhase = "FAILED";
      state.joinNote = "Reservation is pending. USDC mint is not configured, so there is nothing to sign.";
    } else {
      state.depositPlan = reserved.depositPlan;
      state.joinPhase = "AWAITING_WALLET";
      state.joinNote = "Review the contest, fee, mint, team version, vault, network, and expiry before signing. Transaction submitted is not entry confirmed.";
      sessionStorage.setItem("kickr.dev.reservation", reserved.reservation.id);
    }
  } catch (error) {
    state.joinPhase = "FAILED";
    state.joinNote = error instanceof Error ? error.message : "Reservation failed";
  }
  await renderContests(matchId);
}

async function signDeposit(matchId: string): Promise<void> {
  const plan = state.depositPlan;
  const reservationId = sessionStorage.getItem("kickr.dev.reservation");
  if (!plan || !reservationId) {
    state.joinPhase = "FAILED";
    state.joinNote = "No deposit plan. The entry is not confirmed.";
    await renderContests(matchId);
    return;
  }
  if (Date.parse(plan.expiresAt) <= Date.now()) {
    state.joinPhase = "EXPIRED";
    state.joinNote = "The reservation expired before a finalized deposit. This is not an entry.";
    await renderContests(matchId);
    return;
  }
  state.joinPhase = "AWAITING_WALLET";
  state.joinNote = "Wallet requested. A signature alone is not a seat.";
  await renderContests(matchId);
  try {
    assertDevCluster(plan.cluster);
    const connection = new Connection(publicRpc(plan.cluster), "finalized");
    const payer = await devDepositKeypair();
    const blockhash = await connection.getLatestBlockhash("finalized");
    const tx = buildDepositTransaction({
      plan,
      feePayer: payer.publicKey,
      recentBlockhash: blockhash.blockhash,
    });
    const signed = await signWithWallet(tx, payer);
    const signature = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: false });
    state.depositSignature = signature;
    state.joinPhase = "SUBMITTED";
    state.joinNote = "Transaction submitted. Entry is not confirmed.";
    await renderContests(matchId);
    await api(`/reservations/${reservationId}/deposit-submission`, {
      method: "POST",
      body: JSON.stringify({ signature }),
    });
    state.joinPhase = "VERIFYING";
    state.joinNote = "Verifying the finalized transaction against the reservation. Do not treat this as joined.";
    await renderContests(matchId);
    await pollConfirmation(matchId, reservationId);
  } catch (error) {
    state.joinPhase = "FAILED";
    state.joinNote = error instanceof Error ? error.message : "Deposit failed. The entry was not confirmed.";
    await renderContests(matchId);
  }
}

async function pollConfirmation(matchId: string, reservationId: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const viewed = await api<{
      entry: { status: string; depositSignature: string | null };
      reservation: { status: string; expiresAt: string };
    }>(`/reservations/${reservationId}`);
    if (viewed.entry.status === "CONFIRMED" && viewed.reservation.status === "CONFIRMED") {
      state.joinPhase = "CONFIRMED";
      state.joinNote = "Entry confirmed after backend verification of a finalized deposit.";
      await renderContests(matchId);
      return;
    }
    if (Date.parse(viewed.reservation.expiresAt) <= Date.now() && viewed.entry.status !== "CONFIRMED") {
      state.joinPhase = "EXPIRED";
      state.joinNote = "Reservation expired before confirmation. The entry is not confirmed.";
      await renderContests(matchId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 2000));
  }
  state.joinPhase = "VERIFYING";
  state.joinNote = "Transaction submitted. Still waiting for a finalized match. Entry is not confirmed.";
  await renderContests(matchId);
}

async function signWithWallet(tx: Transaction, fallback: Keypair): Promise<Transaction> {
  const provider = (window as Window & { solana?: { signTransaction?: (tx: Transaction) => Promise<Transaction> } }).solana;
  if (provider?.signTransaction) {
    return provider.signTransaction(tx);
  }
  tx.sign(fallback);
  return tx;
}

async function devDepositKeypair(): Promise<Keypair> {
  const existing = sessionStorage.getItem("kickr.dev.depositSecret");
  if (existing) {
    return Keypair.fromSecretKey(bs58.decode(existing));
  }
  const created = Keypair.generate();
  sessionStorage.setItem("kickr.dev.depositSecret", bs58.encode(created.secretKey));
  sessionStorage.setItem("kickr.dev.depositSecretLabel", "throwaway browser devnet signer, not a committed key");
  return created;
}

async function renderDetail(id: string): Promise<void> {
  const data = await api<{ match: MatchCard }>(`/matches/${id}`);
  const match = data.match;
  let liveHtml: string;
  try {
    const live = await api<{
      freshness: string;
      eventCount: number;
      providerName: string | null;
      dataHealth: {
        connected: boolean;
        delayed: boolean;
        lastEventAgeMs: number | null;
        providerName: string | null;
        eventCount: number;
      };
      playerScores: Array<{ playerId: string; baseMilliPoints: number }>;
      timestamps: { updatedAt: string; lastEventAt: string | null };
      scale: number;
    }>(`/matches/${id}/live`);
    const events = await api<{
      events: Array<{
        eventId: string;
        eventType: string;
        primaryPlayerId: string | null;
        timestamp: string;
        matchMinute: number | null;
      }>;
    }>(`/matches/${id}/events`);
    const health = live.dataHealth;
    liveHtml = `
      <div class="card">
        <div class="meta"><span>Live data</span><span>${live.freshness}</span></div>
        <p class="quiet">
          ${health.connected ? "Connected" : "Disconnected"}
          · ${health.delayed ? "Delayed" : "On time"}
          · provider ${health.providerName ?? "n/a"}
          · events ${health.eventCount}
          · last event age ${health.lastEventAgeMs === null ? "n/a" : `${Math.round(health.lastEventAgeMs / 1000)}s`}
        </p>
        <div id="live-feed" class="stack"></div>
        <p class="note">Base player points are before captain/vice. Team contribution applies the multiplier once.</p>
        <ul>${events.events.slice(-8).map((event) => `<li class="quiet">${event.matchMinute ?? "-"}' ${event.eventType} · player ${event.primaryPlayerId ?? "n/a"} · ${event.timestamp}</li>`).join("")}</ul>
      </div>`;
  } catch {
    liveHtml = `<p class="quiet">No live score payload yet for this match.</p>`;
  }
  app.innerHTML = shell(`${match.home.name} vs ${match.away.name}`, `
    <p class="quiet">${match.competition} · ${kickoffLabel(match.kickoffAt)} · ${match.status.replaceAll("_", " ")}${match.venue ? ` · ${match.venue}` : ""}</p>
    <div class="row">
      <a class="quiet" href="#/">Matches</a>
      <button class="ghost" id="contests">Contests</button>
      <button class="primary" id="build" ${match.canBuildXi ? "" : "disabled"}>${match.canBuildXi ? "Build XI" : "XI closed"}</button>
    </div>
    ${liveHtml}
  `);
  document.querySelector("#contests")?.addEventListener("click", () => {
    location.hash = `#/matches/${id}/contests`;
  });
  document.querySelector("#build")?.addEventListener("click", () => {
    if (match.canBuildXi) {
      location.hash = `#/matches/${id}/xi`;
    }
  });
  if (state.token && (match.bucket === "live" || match.status === "LIVE" || match.status === "FULL_TIME" || match.status === "DATA_FINALIZING")) {
    const feed = document.querySelector("#live-feed");
    // Prefer fetch streaming so the bearer token can be sent (EventSource cannot).
    void attachLiveStream(id, feed);
  }
}

async function attachLiveStream(matchId: string, feed: Element | null): Promise<void> {
  if (!feed || !state.token) {
    return;
  }
  try {
    const response = await fetch(`/matches/${idPath(matchId)}/live-stream`, {
      headers: { authorization: `Bearer ${state.token}` },
    });
    if (!response.ok || !response.body) {
      feed.textContent = "Live channel unavailable.";
      return;
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      buffer += decoder.decode(value, { stream: true });
      const chunks = buffer.split("\n\n");
      buffer = chunks.pop() ?? "";
      for (const chunk of chunks) {
        const line = chunk.split("\n").find((row) => row.startsWith("data: "));
        if (!line) {
          continue;
        }
        const payload = JSON.parse(line.slice(6)) as {
          type?: string;
          eventType?: string;
          playerId?: string | null;
          timestamp?: string;
          explanation?: {
            event: string;
            playerId: string | null;
            basePoints: number;
            multiplierLabel: string | null;
            contribution: number;
            newTeamTotal: number | null;
          };
        };
        if (payload.type === "score_update" && payload.explanation) {
          const item = document.createElement("div");
          item.className = "quiet";
          item.textContent = `${payload.explanation.event} · player ${payload.explanation.playerId ?? "n/a"} · base ${payload.explanation.basePoints} · ${payload.explanation.multiplierLabel ?? "no multiplier"} · contribution ${payload.explanation.contribution} · team ${payload.explanation.newTeamTotal ?? "n/a"} · ${payload.timestamp ?? ""}`;
          feed.prepend(item);
        }
      }
      if (location.hash !== `#/matches/${matchId}`) {
        await reader.cancel();
        break;
      }
    }
  } catch {
    feed.textContent = "Live channel interrupted.";
  }
}

function idPath(id: string): string {
  return id;
}

async function renderBuilder(id: string): Promise<void> {
  const matchData = await api<{ match: MatchCard }>(`/matches/${id}`);
  const poolData = await api<{ players: PoolPlayer[] }>(`/matches/${id}/players`);
  const match = matchData.match;
  const players = poolData.players;
  if (!match.canBuildXi) {
    app.innerHTML = shell("XI closed", `<p class="quiet">This match is ${match.status.replaceAll("_", " ")}. Team changes are not open.</p><a href="#/">Back</a>`);
    return;
  }
  const selected = state.draft.playerIds
    .map((playerId) => players.find((player) => player.playerId === playerId))
    .filter((player): player is PoolPlayer => Boolean(player));
  const used = selected.length ? calculateCreditsUsed(selected.map((player) => player.credit)) : 0;
  const left = remainingCredits(used, state.creditCap);
  const visible = players.filter((player) => {
    const positionOk = state.draft.filter === "ALL" || player.position === state.draft.filter;
    const query = state.draft.query.toLowerCase();
    const text = `${player.displayName} ${player.clubName}`.toLowerCase();
    return positionOk && text.includes(query);
  });
  const result = selected.length
    ? validateFantasyTeam(
        {
          playerIds: state.draft.playerIds,
          captainId: state.draft.captainId,
          viceId: state.draft.viceId,
        },
        players.map((player) => ({
          playerId: player.playerId,
          clubId: player.clubId,
          position: player.position,
          credit: player.credit,
        })),
        match.home.id,
        match.away.id,
        { creditCap: state.creditCap, maxPlayersFromOneTeam: state.maxPlayersFromOneTeam },
      )
    : { valid: false, errors: [] };
  const lines = ["GK", "DEF", "MID", "FWD"].map((role) => {
    const chips = selected.filter((player) => player.position === role).map((player) => {
      const badge = player.playerId === state.draft.captainId ? `<div class="badge">C</div>` : player.playerId === state.draft.viceId ? `<div class="badge">V</div>` : "";
      return `<div class="chip">${player.shortName}${badge}</div>`;
    }).join("");
    return `<div class="line">${chips}</div>`;
  }).join("");
  app.innerHTML = shell("Build XI", `
    <div class="meta"><span>${match.home.shortName} vs ${match.away.shortName}</span><a href="#/matches/${id}">Match</a></div>
    <div class="row"><strong>${selected.length}/11</strong><span>${left} credits left</span></div>
    <p class="quiet">Formation ${formationLabel(selected.map((player) => player.position))}</p>
    <div class="pitch">${lines}</div>
    <div class="stack">
      <label>Captain<select id="captain">${selected.map((player) => `<option value="${player.playerId}" ${player.playerId === state.draft.captainId ? "selected" : ""}>${player.shortName}</option>`).join("")}</select></label>
      <label>Vice<select id="vice">${selected.map((player) => `<option value="${player.playerId}" ${player.playerId === state.draft.viceId ? "selected" : ""}>${player.shortName}</option>`).join("")}</select></label>
    </div>
    <div class="filters">${["ALL", "GK", "DEF", "MID", "FWD"].map((role) => `<button type="button" data-filter="${role}" aria-pressed="${state.draft.filter === role}">${role}</button>`).join("")}</div>
    <input class="search" id="search" placeholder="Search players" value="${state.draft.query}" />
    <div>${visible.map((player) => `<div class="player"><div><strong>${player.displayName}</strong><div class="quiet">${player.position} · ${player.clubName} · ${player.availability}</div></div><div><div>${player.credit}</div><button class="ghost" data-toggle="${player.playerId}">${state.draft.playerIds.includes(player.playerId) ? "Remove" : "Add"}</button></div></div>`).join("")}</div>
    <div class="errors">${result.errors.map((error) => error.message).join("<br>")}</div>
    <button class="primary" id="save" ${result.valid ? "" : "disabled"}>Save team</button>
    <p class="note" id="saved"></p>
  `);
  document.querySelector("#search")?.addEventListener("input", (event) => {
    state.draft.query = (event.target as HTMLInputElement).value;
    void render();
  });
  document.querySelector("#captain")?.addEventListener("change", (event) => {
    state.draft.captainId = (event.target as HTMLSelectElement).value;
    void render();
  });
  document.querySelector("#vice")?.addEventListener("change", (event) => {
    state.draft.viceId = (event.target as HTMLSelectElement).value;
    void render();
  });
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-filter]")) {
    button.addEventListener("click", () => {
      state.draft.filter = button.dataset.filter ?? "ALL";
      void render();
    });
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-toggle]")) {
    button.addEventListener("click", () => {
      const playerId = button.dataset.toggle ?? "";
      if (state.draft.playerIds.includes(playerId)) {
        state.draft.playerIds = state.draft.playerIds.filter((id) => id !== playerId);
      } else if (state.draft.playerIds.length < 11) {
        state.draft.playerIds = [...state.draft.playerIds, playerId];
      }
      if (!state.draft.playerIds.includes(state.draft.captainId)) {
        state.draft.captainId = state.draft.playerIds[0] ?? "";
      }
      if (!state.draft.playerIds.includes(state.draft.viceId) || state.draft.viceId === state.draft.captainId) {
        state.draft.viceId = state.draft.playerIds.find((item) => item !== state.draft.captainId) ?? "";
      }
      void render();
    });
  }
  document.querySelector("#save")?.addEventListener("click", () => {
    void saveTeam(id, players, match);
  });
}

async function saveTeam(matchId: string, players: PoolPlayer[], match: MatchCard): Promise<void> {
  const local = validateFantasyTeam(
    state.draft,
    players.map((player) => ({
      playerId: player.playerId,
      clubId: player.clubId,
      position: player.position,
      credit: player.credit,
    })),
    match.home.id,
    match.away.id,
    { creditCap: state.creditCap, maxPlayersFromOneTeam: state.maxPlayersFromOneTeam },
  );
  if (!local.valid) {
    return;
  }
  const created = await api<{ team: { id: string } }>("/teams", {
    method: "POST",
    body: JSON.stringify({ matchId }),
  });
  const saved = await api<{ version: { id: string; version: number; playerIds: string[]; captainId: string; viceId: string } }>(
    `/teams/${created.team.id}/versions`,
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
  state.draft.playerIds = saved.version.playerIds;
  state.draft.captainId = saved.version.captainId;
  state.draft.viceId = saved.version.viceId;
  const note = document.querySelector("#saved");
  if (note) {
    note.textContent = `Saved version ${saved.version.version}. The server copy is the canonical team.`;
  }
}

window.addEventListener("hashchange", () => {
  void render();
});
void render();
