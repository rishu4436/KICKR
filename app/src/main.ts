import nacl from "tweetnacl";
import bs58 from "bs58";
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
} = {
  token: sessionStorage.getItem("kickr.dev.token"),
  bucket: "upcoming",
  creditCap: 100,
  maxPlayersFromOneTeam: null,
  draft: { playerIds: [], captainId: "", viceId: "", filter: "ALL", query: "" },
  teamVersionId: sessionStorage.getItem("kickr.dev.teamVersion"),
  teamMatchId: sessionStorage.getItem("kickr.dev.teamMatch"),
  joinNote: "",
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
    <p class="note">Credits are a squad budget, not USDC. Escrow does not exist in this build. Development matches are not a live feed.</p>
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
    <p class="note" id="join-note">${state.joinNote}</p>
  `);
  for (const button of document.querySelectorAll<HTMLButtonElement>("[data-join]")) {
    button.addEventListener("click", () => {
      void joinContest(id, button.dataset.join ?? "");
    });
  }
}

async function joinContest(matchId: string, contestId: string): Promise<void> {
  if (!state.teamVersionId || state.teamMatchId !== matchId) {
    state.joinNote = "Save an XI for this match before reserving a seat.";
    await renderContests(matchId);
    return;
  }
  state.joinNote = "Creating entry";
  await renderContests(matchId);
  try {
    const reserved = await api<{ payment: string; reservation: { status: string } }>(`/contests/${contestId}/reservations`, {
      method: "POST",
      body: JSON.stringify({ teamVersionId: state.teamVersionId }),
    });
    if (reserved.reservation.status !== "PENDING" || reserved.payment !== "PAYMENT COMING IN PHASE 4") {
      state.joinNote = "Reservation failed";
    } else {
      state.joinNote = "Creating entry. Reservation created. Awaiting wallet payment. PAYMENT COMING IN PHASE 4";
    }
  } catch (error) {
    state.joinNote = error instanceof Error ? error.message : "Reservation failed";
  }
  await renderContests(matchId);
}

async function renderDetail(id: string): Promise<void> {
  const data = await api<{ match: MatchCard }>(`/matches/${id}`);
  const match = data.match;
  app.innerHTML = shell(`${match.home.name} vs ${match.away.name}`, `
    <p class="quiet">${match.competition} · ${kickoffLabel(match.kickoffAt)} · ${match.status.replaceAll("_", " ")}${match.venue ? ` · ${match.venue}` : ""}</p>
    <div class="row">
      <a class="quiet" href="#/">Matches</a>
      <button class="ghost" id="contests">Contests</button>
      <button class="primary" id="build" ${match.canBuildXi ? "" : "disabled"}>${match.canBuildXi ? "Build XI" : "XI closed"}</button>
    </div>
  `);
  document.querySelector("#contests")?.addEventListener("click", () => {
    location.hash = `#/matches/${id}/contests`;
  });
  document.querySelector("#build")?.addEventListener("click", () => {
    if (match.canBuildXi) {
      location.hash = `#/matches/${id}/xi`;
    }
  });
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
