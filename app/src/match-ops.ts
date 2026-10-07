/**
 * Private Match Ops UI — /ops/matches
 * Never linked from consumer navigation.
 */
const rootEl = document.querySelector("#match-ops");
if (!(rootEl instanceof HTMLElement)) throw new Error("missing match-ops root");
const matchOpsRoot: HTMLElement = rootEl;

type Json = Record<string, unknown>;
let token: string | null = sessionStorage.getItem("kickr_match_ops_token");
let wallet = sessionStorage.getItem("kickr_match_ops_wallet") ?? "";
let role = "";
let flash: { text: string; err?: boolean } | null = null;

async function api(path: string, init?: RequestInit): Promise<Json> {
  const headers = new Headers(init?.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init?.body) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) {
    const error = body.error as Json | undefined;
    throw new Error(typeof error?.message === "string" ? error.message : `Request failed (${response.status})`);
  }
  return body;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function route(): { page: string; matchId: string | null; tab: string } {
  const hash = location.hash.replace(/^#\/?/, "");
  const parts = hash.split("/").filter(Boolean);
  if (parts[0] === "match" && parts[1]) {
    return { page: "detail", matchId: parts[1], tab: parts[2] ?? "overview" };
  }
  if (parts[0] === "create") return { page: "create", matchId: null, tab: "" };
  if (parts[0] === "audit") return { page: "audit", matchId: null, tab: "" };
  return { page: "list", matchId: null, tab: "" };
}

function setFlash(text: string, err = false) {
  flash = { text, err };
}

async function loginFlow(host: HTMLElement) {
  host.replaceChildren();
  const box = el("div", undefined, "login");
  box.append(el("h1", "Match Ops"), el("p", "Private operator surface. Requires MANAGE_MATCH_OPERATIONS.", "muted"));
  const walletInput = el("input") as HTMLInputElement;
  walletInput.placeholder = "Solana wallet address";
  walletInput.value = wallet;
  const msg = el("textarea") as HTMLTextAreaElement;
  msg.rows = 4;
  msg.placeholder = "Signed login message";
  const sig = el("input") as HTMLInputElement;
  sig.placeholder = "Signature (base58)";
  const nonceBtn = el("button", "1. Issue nonce", "ghost");
  const loginBtn = el("button", "2. Login", "primary");
  const status = el("p", "", "muted");
  nonceBtn.addEventListener("click", async () => {
    try {
      wallet = walletInput.value.trim();
      const body = await api("/v1/auth/nonce", { method: "POST", body: JSON.stringify({ walletAddress: wallet }) });
      msg.value = String(body.message ?? "");
      status.textContent = "Sign the message with the wallet, then paste the signature.";
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Nonce failed";
    }
  });
  loginBtn.addEventListener("click", async () => {
    try {
      wallet = walletInput.value.trim();
      const body = await api("/v1/auth/login", {
        method: "POST",
        body: JSON.stringify({ walletAddress: wallet, message: msg.value, signature: sig.value.trim() }),
      });
      token = String(body.token ?? "");
      sessionStorage.setItem("kickr_match_ops_token", token);
      sessionStorage.setItem("kickr_match_ops_wallet", wallet);
      await render();
    } catch (e) {
      status.textContent = e instanceof Error ? e.message : "Login failed";
    }
  });
  box.append(walletInput, nonceBtn, msg, sig, loginBtn, status);
  host.append(box);
}

function shell(content: HTMLElement) {
  const frame = el("div", undefined, "frame");
  const nav = el("aside", undefined, "nav");
  nav.append(el("h1", "Match Ops"), el("p", "OPERATOR_MANAGED · not Sportmonks · not Tutorial"));
  const links: Array<[string, string]> = [
    ["#/", "Match list"],
    ["#/create", "Create fixture"],
    ["#/audit", "Audit"],
  ];
  const { page, matchId } = route();
  for (const [href, label] of links) {
    const a = el("a", label) as HTMLAnchorElement;
    a.href = href;
    if (
      (href === "#/" && page === "list") ||
      (href === "#/create" && page === "create") ||
      (href === "#/audit" && page === "audit")
    ) {
      a.setAttribute("aria-current", "page");
    }
    nav.append(a);
  }
  if (matchId) {
    const back = el("a", "← Current match") as HTMLAnchorElement;
    back.href = `#/match/${matchId}`;
    back.setAttribute("aria-current", "page");
    nav.append(back);
  }
  const main = el("main", undefined, "main");
  const bar = el("div", undefined, "bar");
  bar.append(
    el("div", `Signed in as ${wallet.slice(0, 4)}…${wallet.slice(-4)} · ${role || "staff"}`, "muted"),
  );
  const logout = el("button", "Log out", "ghost");
  logout.addEventListener("click", () => {
    token = null;
    sessionStorage.removeItem("kickr_match_ops_token");
    render();
  });
  bar.append(logout);
  main.append(bar);
  if (flash) {
    const f = el("div", flash.text, flash.err ? "flash err" : "flash");
    main.append(f);
    flash = null;
  }
  main.append(content);
  frame.append(nav, main);
  return frame;
}

async function renderList(): Promise<HTMLElement> {
  const body = await api("/v1/ops/match-ops/matches");
  const matches = (body.matches as Json[]) ?? [];
  const wrap = el("div");
  wrap.append(el("h2", "Operator-managed fixtures"));
  wrap.append(el("p", "Sportmonks LIVE and Tutorial SIMULATED fixtures are never editable here.", "muted"));
  const table = el("table");
  const head = el("tr");
  for (const h of ["Competition", "Fixture", "Kickoff", "Status", "Provenance", ""]) head.append(el("th", h));
  table.append(head);
  if (matches.length === 0) {
    const row = el("tr");
    const cell = el("td", "No operator fixtures yet");
    cell.colSpan = 6;
    row.append(cell);
    table.append(row);
  }
  for (const m of matches) {
    const home = m.home as Json | null;
    const away = m.away as Json | null;
    const row = el("tr");
    row.append(el("td", String(m.competition ?? "")));
    row.append(el("td", `${String(home?.shortName ?? "?")} vs ${String(away?.shortName ?? "?")}`));
    row.append(el("td", String(m.kickoffAt ?? "")));
    const st = el("td");
    st.append(el("span", String(m.status ?? ""), "badge"));
    row.append(st);
    const prov = el("td");
    prov.append(el("span", String(m.provenance ?? "OPERATOR_MANAGED"), "badge ok"));
    row.append(prov);
    const open = el("td");
    const a = el("a", "Open") as HTMLAnchorElement;
    a.href = `#/match/${String(m.id)}`;
    open.append(a);
    row.append(open);
    table.append(row);
  }
  const panel = el("div", undefined, "panel");
  panel.append(table);
  wrap.append(panel);
  return wrap;
}

async function renderCreate(): Promise<HTMLElement> {
  const wrap = el("div", undefined, "panel");
  wrap.append(el("h2", "Create upcoming fixture"));
  const form = el("div", undefined, "stack");
  const competition = el("input") as HTMLInputElement;
  competition.placeholder = "Competition";
  competition.value = "Operator Cup";
  const venue = el("input") as HTMLInputElement;
  venue.placeholder = "Venue";
  venue.value = "Ops Arena";
  const kickoff = el("input") as HTMLInputElement;
  kickoff.type = "datetime-local";
  const soon = new Date(Date.now() + 86400000);
  kickoff.value = soon.toISOString().slice(0, 16);
  const homeName = el("input") as HTMLInputElement;
  homeName.placeholder = "Home club";
  homeName.value = "Ops United";
  const awayName = el("input") as HTMLInputElement;
  awayName.placeholder = "Away club";
  awayName.value = "Manual City";
  const submit = el("button", "Create OPERATOR_MANAGED fixture", "primary");
  submit.addEventListener("click", async () => {
    try {
      const kickoffAt = new Date(kickoff.value).toISOString();
      const positions = ["GK", "DEF", "DEF", "DEF", "DEF", "MID", "MID", "MID", "FWD", "FWD", "FWD"] as const;
      const players = [];
      for (const side of ["home", "away"] as const) {
        for (let i = 0; i < positions.length; i++) {
          const pos = positions[i]!;
          players.push({
            displayName: `${side === "home" ? "Home" : "Away"} ${pos}${i}`,
            shortName: `${side === "home" ? "H" : "A"}${pos}${i}`,
            position: pos,
            clubSide: side,
            creditValue: pos === "FWD" ? 12 : 9,
            startingStatus: "STARTER" as const,
            availability: "AVAILABLE" as const,
          });
        }
      }
      const created = await api("/v1/ops/match-ops/matches", {
        method: "POST",
        body: JSON.stringify({
          competition: competition.value.trim(),
          venue: venue.value.trim(),
          kickoffAt,
          homeClub: { name: homeName.value.trim(), shortName: "OPS" },
          awayClub: { name: awayName.value.trim(), shortName: "MAN" },
          players,
        }),
      });
      const match = created.match as Json;
      setFlash("Fixture created");
      location.hash = `#/match/${String(match.id)}`;
      await render();
    } catch (e) {
      setFlash(e instanceof Error ? e.message : "Create failed", true);
      await render();
    }
  });
  form.append(competition, venue, kickoff, homeName, awayName, submit);
  wrap.append(form);
  return wrap;
}

async function renderDetail(matchId: string, tab: string): Promise<HTMLElement> {
  const bundle = await api(`/v1/ops/match-ops/matches/${matchId}`);
  const match = bundle.match as Json;
  const wrap = el("div");
  const title = el("div", undefined, "bar");
  title.append(el("h2", `${String((bundle.home as Json)?.name ?? "Home")} vs ${String((bundle.away as Json)?.name ?? "Away")}`));
  title.append(el("span", String(bundle.authority ?? "OPERATOR_MANAGED"), "badge ok"));
  wrap.append(title);
  wrap.append(
    el(
      "p",
      `${String(match.competition)} · ${String(match.status)} · ${String(match.kickoffAt)} · ${String((match.dataSource as Json)?.label ?? "")}`,
      "muted",
    ),
  );

  const tabs = el("div", undefined, "tabs");
  for (const [id, label] of [
    ["overview", "Detail"],
    ["players", "Players"],
    ["credits", "Credits"],
    ["lineup", "Lineup"],
    ["events", "Live Events"],
    ["corrections", "Corrections"],
    ["audit", "Audit"],
  ] as const) {
    const a = el("a", label) as HTMLAnchorElement;
    a.href = `#/match/${matchId}/${id}`;
    if (tab === id) a.setAttribute("aria-current", "page");
    tabs.append(a);
  }
  wrap.append(tabs);

  const panel = el("div", undefined, "panel");
  if (tab === "overview") {
    panel.append(el("p", `Manual scoring allowed: ${String(bundle.manualScoringAllowed)}`));
    panel.append(el("p", `Provider: ${String((match.dataSource as Json)?.provider)}`));
    panel.append(el("p", `Provenance: ${String((match.dataSource as Json)?.provenance ?? "OPERATOR_MANAGED")}`));
    if (match.status === "SCHEDULED" || match.status === "LINEUPS_AVAILABLE") {
      const adv = el("button", "Advance to LIVE", "primary");
      adv.addEventListener("click", async () => {
        try {
          for (const status of ["LINEUPS_AVAILABLE", "LOCKED", "LIVE"] as const) {
            await api(`/v1/ops/match-ops/matches/${matchId}`, {
              method: "PATCH",
              body: JSON.stringify({ status, reason: `advance to ${status}` }),
            });
          }
          setFlash("Match advanced to LIVE");
          await render();
        } catch (e) {
          setFlash(e instanceof Error ? e.message : "Advance failed", true);
          await render();
        }
      });
      panel.append(adv);
    }
  } else if (tab === "players" || tab === "lineup") {
    const players = (bundle.players as Json[]) ?? [];
    const squad = (bundle.squad as Json[]) ?? [];
    const table = el("table");
    const head = el("tr");
    for (const h of ["Player", "Pos", "Credits", "Start", "Avail"]) head.append(el("th", h));
    table.append(head);
    for (const s of squad) {
      const p = players.find((x) => x.id === s.playerId);
      const row = el("tr");
      row.append(el("td", String(p?.displayName ?? s.playerId)));
      row.append(el("td", String(s.fantasyPosition)));
      row.append(el("td", String(s.creditValue)));
      row.append(el("td", String(s.startingStatus)));
      row.append(el("td", String(s.availability)));
      table.append(row);
    }
    panel.append(table);
  } else if (tab === "credits") {
    const squad = (bundle.squad as Json[]) ?? [];
    const players = (bundle.players as Json[]) ?? [];
    const audits = (bundle.creditAudits as Json[]) ?? [];
    const form = el("div", undefined, "stack");
    const select = el("select") as HTMLSelectElement;
    for (const s of squad) {
      const p = players.find((x) => x.id === s.playerId);
      const opt = el("option", `${String(p?.displayName)} (${s.creditValue})`) as HTMLOptionElement;
      opt.value = String(s.playerId);
      select.append(opt);
    }
    const credit = el("input") as HTMLInputElement;
    credit.type = "number";
    credit.min = "1";
    credit.max = "20";
    credit.value = "10";
    const reason = el("input") as HTMLInputElement;
    reason.placeholder = "Reason (required)";
    const btn = el("button", "Edit credit (future XI only)", "primary");
    btn.addEventListener("click", async () => {
      try {
        await api(`/v1/ops/match-ops/matches/${matchId}/credits`, {
          method: "POST",
          body: JSON.stringify({
            playerId: select.value,
            creditValue: Number(credit.value),
            reason: reason.value.trim(),
          }),
        });
        setFlash("Credit updated — frozen team versions unchanged");
        await render();
      } catch (e) {
        setFlash(e instanceof Error ? e.message : "Credit edit failed", true);
        await render();
      }
    });
    form.append(select, credit, reason, btn);
    panel.append(form, el("h3", "Credit audit"));
    const table = el("table");
    const head = el("tr");
    for (const h of ["When", "Player", "Prev", "New", "Reason", "Actor"]) head.append(el("th", h));
    table.append(head);
    for (const a of audits) {
      const row = el("tr");
      row.append(el("td", String(a.createdAt)));
      row.append(el("td", String(a.playerId).slice(0, 8)));
      row.append(el("td", String(a.previousCredit)));
      row.append(el("td", String(a.newCredit)));
      row.append(el("td", String(a.reason)));
      row.append(el("td", String(a.actorRole)));
      table.append(row);
    }
    panel.append(table);
  } else if (tab === "events") {
    const events = (bundle.events as Json[]) ?? [];
    const proposals = (bundle.proposals as Json[]) ?? [];
    const players = (bundle.players as Json[]) ?? [];
    const squad = (bundle.squad as Json[]) ?? [];
    const form = el("div", undefined, "stack");
    form.append(el("h3", "Propose / confirm event"));
    const playerSelect = el("select") as HTMLSelectElement;
    for (const s of squad) {
      const p = players.find((x) => x.id === s.playerId);
      const opt = el("option", String(p?.displayName ?? s.playerId)) as HTMLOptionElement;
      opt.value = String(s.playerId);
      playerSelect.append(opt);
    }
    const typeSelect = el("select") as HTMLSelectElement;
    for (const t of ["GOAL", "ASSIST", "SHOT_ON_TARGET", "YELLOW_CARD", "RED_CARD", "OWN_GOAL", "PENALTY_MISS", "PENALTY_SAVE", "SUBSTITUTION", "VAR_REVERSAL"]) {
      typeSelect.append(el("option", t));
    }
    const minute = el("input") as HTMLInputElement;
    minute.type = "number";
    minute.placeholder = "Minute";
    minute.value = "37";
    const note = el("input") as HTMLInputElement;
    note.placeholder = "Note / source";
    const source = el("select") as HTMLSelectElement;
    source.append(el("option", "MANUAL_OPERATOR"));
    const grokOpt = el("option", "GROK_PROPOSED") as HTMLOptionElement;
    grokOpt.value = "GROK_PROPOSED";
    source.append(grokOpt);
    const proposeBtn = el("button", "Propose event", "ghost");
    const confirmLast = el("button", "Confirm latest proposal", "primary");
    proposeBtn.addEventListener("click", async () => {
      try {
        await api("/v1/ops/match-ops/proposals", {
          method: "POST",
          body: JSON.stringify({
            matchId,
            eventType: typeSelect.value,
            primaryPlayerId: playerSelect.value,
            matchMinute: Number(minute.value),
            note: note.value || `GOAL — player — ${minute.value}'`,
            source: source.value,
          }),
        });
        setFlash("Proposal created (does not score until human confirm)");
        await render();
      } catch (e) {
        setFlash(e instanceof Error ? e.message : "Propose failed", true);
        await render();
      }
    });
    confirmLast.addEventListener("click", async () => {
      try {
        const open = proposals.filter((p) => p.status === "PROPOSED" || p.status === "REVIEWED");
        const latest = open[open.length - 1];
        if (!latest) throw new Error("No open proposal");
        if (latest.status === "PROPOSED") {
          await api(`/v1/ops/match-ops/proposals/${String(latest.id)}/review`, { method: "POST", body: "{}" });
        }
        await api(`/v1/ops/match-ops/proposals/${String(latest.id)}/confirm`, { method: "POST", body: "{}" });
        setFlash("Confirmed → match_events → LIVE_V1 scoring");
        await render();
      } catch (e) {
        setFlash(e instanceof Error ? e.message : "Confirm failed", true);
        await render();
      }
    });
    form.append(playerSelect, typeSelect, minute, note, source, proposeBtn, confirmLast);
    panel.append(form);
    panel.append(el("h3", "Proposals"));
    const ptable = el("table");
    const phead = el("tr");
    for (const h of ["Status", "Type", "Min", "Source", "Provenance", "Id"]) phead.append(el("th", h));
    ptable.append(phead);
    for (const p of proposals) {
      const row = el("tr");
      row.append(el("td", String(p.status)));
      row.append(el("td", String(p.eventType)));
      row.append(el("td", String(p.matchMinute ?? "")));
      row.append(el("td", String(p.source)));
      row.append(el("td", String(p.provenance)));
      row.append(el("td", String(p.id).slice(0, 8)));
      ptable.append(row);
    }
    panel.append(ptable);
    panel.append(el("h3", "Published match_events"));
    const etable = el("table");
    const ehead = el("tr");
    for (const h of ["Seq", "Type", "Min", "Player", "Provenance", "Supersedes"]) ehead.append(el("th", h));
    etable.append(ehead);
    for (const e of events) {
      const row = el("tr");
      row.append(el("td", String(e.sequence)));
      row.append(el("td", String(e.eventType)));
      row.append(el("td", String(e.matchMinute ?? "")));
      row.append(el("td", String(e.primaryPlayerId ?? "").slice(0, 8)));
      const meta = (e.metadata as Json) ?? {};
      row.append(el("td", String(meta.provenance ?? e.provider)));
      row.append(el("td", String(e.supersedesEventId ?? "").slice(0, 8)));
      etable.append(row);
    }
    panel.append(etable);
  } else if (tab === "corrections") {
    const events = (bundle.events as Json[]) ?? [];
    const form = el("div", undefined, "stack");
    const select = el("select") as HTMLSelectElement;
    for (const e of events.filter((x) => !x.supersedesEventId)) {
      const opt = el("option", `${e.eventType} @ ${e.matchMinute ?? "?"} (${String(e.eventId).slice(0, 8)})`) as HTMLOptionElement;
      opt.value = String(e.eventId);
      select.append(opt);
    }
    const note = el("input") as HTMLInputElement;
    note.placeholder = "Correction note";
    const btn = el("button", "Append correction (no delete)", "danger");
    btn.addEventListener("click", async () => {
      try {
        await api(`/v1/ops/match-ops/matches/${matchId}/corrections`, {
          method: "POST",
          body: JSON.stringify({ originalEventId: select.value, note: note.value }),
        });
        setFlash("Correction appended · scores recomputed");
        await render();
      } catch (e) {
        setFlash(e instanceof Error ? e.message : "Correction failed", true);
        await render();
      }
    });
    form.append(el("p", "Historical events are never edited or deleted. Corrections append and reverse points deterministically.", "muted"), select, note, btn);
    panel.append(form);
  } else {
    const mutations = (bundle.mutations as Json[]) ?? [];
    const table = el("table");
    const head = el("tr");
    for (const h of ["When", "Action", "Entity", "Role", "Request"]) head.append(el("th", h));
    table.append(head);
    for (const m of mutations) {
      const row = el("tr");
      row.append(el("td", String(m.createdAt)));
      row.append(el("td", String(m.action)));
      row.append(el("td", `${m.entityType}:${String(m.entityId).slice(0, 8)}`));
      row.append(el("td", String(m.actorRole)));
      row.append(el("td", String(m.requestId ?? "").slice(0, 8)));
      table.append(row);
    }
    panel.append(table);
  }
  wrap.append(panel);
  return wrap;
}

async function renderAudit(): Promise<HTMLElement> {
  const body = await api("/v1/ops/match-ops/audit");
  const mutations = (body.mutations as Json[]) ?? [];
  const panel = el("div", undefined, "panel");
  panel.append(el("h2", "Match Ops audit (append-only)"));
  const table = el("table");
  const head = el("tr");
  for (const h of ["When", "Action", "Fixture", "Entity", "Role"]) head.append(el("th", h));
  table.append(head);
  for (const m of mutations) {
    const row = el("tr");
    row.append(el("td", String(m.createdAt)));
    row.append(el("td", String(m.action)));
    row.append(el("td", String(m.fixtureId ?? "").slice(0, 8)));
    row.append(el("td", `${m.entityType}`));
    row.append(el("td", String(m.actorRole)));
    table.append(row);
  }
  panel.append(table);
  return panel;
}

async function render() {
  matchOpsRoot.replaceChildren(el("p", "Loading…", "muted"));
  try {
    if (!token) {
      await loginFlow(matchOpsRoot);
      return;
    }
    const session = await api("/v1/ops/match-ops/session");
    role = String(session.role ?? "");
    const { page, matchId, tab } = route();
    let content: HTMLElement;
    if (page === "create") content = await renderCreate();
    else if (page === "audit") content = await renderAudit();
    else if (page === "detail" && matchId) content = await renderDetail(matchId, tab);
    else content = await renderList();
    matchOpsRoot.replaceChildren(shell(content));
  } catch (e) {
    if (String(e).includes("MANAGE_MATCH_OPERATIONS") || String(e).includes("403")) {
      token = null;
      sessionStorage.removeItem("kickr_match_ops_token");
    }
    matchOpsRoot.replaceChildren(el("p", e instanceof Error ? e.message : "Failed", "muted"));
    const retry = el("button", "Back to login", "ghost");
    retry.addEventListener("click", () => {
      token = null;
      render();
    });
    matchOpsRoot.append(retry);
  }
}

window.addEventListener("hashchange", () => {
  void render();
});
void render();

export {};
