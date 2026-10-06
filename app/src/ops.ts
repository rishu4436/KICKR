const root = document.querySelector("#ops");
if (!(root instanceof HTMLElement)) {
  throw new Error("missing ops root");
}
const opsRoot: HTMLElement = root;

const SECTIONS = [
  { id: "overview", label: "Overview", capability: "READ_PLATFORM" },
  { id: "matches", label: "Matches", capability: "READ_MATCHES" },
  { id: "contests", label: "Contests", capability: "READ_CONTESTS" },
  { id: "entries", label: "Entries", capability: "READ_ENTRIES" },
  { id: "settlements", label: "Settlements", capability: "READ_SETTLEMENTS" },
  { id: "claims", label: "Claims", capability: "READ_CLAIMS" },
  { id: "diagnostics", label: "Data Health", capability: "READ_DIAGNOSTICS" },
  { id: "audit", label: "Audit Log", capability: "READ_AUDIT" },
  { id: "access", label: "Team/Access", capability: "MANAGE_USERS" },
] as const;

type SectionId = (typeof SECTIONS)[number]["id"];

let token: string | null = null;
let wallet = "";
let capabilities: string[] = [];
let section: SectionId = "overview";

type Json = Record<string, unknown>;

async function api(path: string, init?: RequestInit): Promise<Json> {
  const headers = new Headers(init?.headers);
  if (token) {
    headers.set("authorization", `Bearer ${token}`);
  }
  if (init?.body) {
    headers.set("content-type", "application/json");
  }
  const response = await fetch(path, { ...init, headers });
  const body = (await response.json().catch(() => ({}))) as Json;
  if (!response.ok) {
    const error = body.error as Json | undefined;
    throw new Error(typeof error?.message === "string" ? error.message : "Request failed");
  }
  return body;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, text?: string, className?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function badge(text: string): HTMLElement {
  const node = el("span", text, "badge");
  if (/FAIL|DENIED|SUSPENDED|BLOCK|STALE|unavailable/i.test(text)) node.classList.add("bad");
  else if (/CONFIRM|PENDING|REVIEW|CALCULAT|unknown/i.test(text)) node.classList.add("warn");
  else if (/OK|CLAIMED|ACTIVE|CONFIRMED|approved|finalized/i.test(text)) node.classList.add("ok");
  return node;
}

function appendCell(value: Node): HTMLTableCellElement {
  const cell = document.createElement("td");
  cell.append(value);
  return cell;
}

function rowCells(values: Array<Node | string>): HTMLTableRowElement {
  const row = document.createElement("tr");
  for (const value of values) {
    if (typeof value === "string") row.append(el("td", value));
    else row.append(appendCell(value));
  }
  return row;
}

function dataTable(headers: string[], rows: Array<Array<Node | string>>): HTMLTableElement {
  const node = document.createElement("table");
  const head = document.createElement("tr");
  for (const header of headers) head.append(el("th", header));
  node.append(head);
  if (rows.length === 0) {
    const row = document.createElement("tr");
    const cell = el("td", "No records");
    cell.colSpan = headers.length;
    row.append(cell);
    node.append(row);
    return node;
  }
  for (const values of rows) node.append(rowCells(values));
  return node;
}

function panel(title: string, body: Node): HTMLElement {
  const wrap = el("section", undefined, "panel");
  wrap.append(el("h2", title), body);
  return wrap;
}

function textBlock(value: unknown): HTMLElement {
  return el("p", value === null || value === undefined || value === "" ? "unavailable" : String(value), "muted");
}

async function loadSection(host: HTMLElement): Promise<void> {
  host.replaceChildren(el("p", "Loading…", "muted"));
  try {
    if (section === "overview") host.replaceChildren(renderOverview(await api("/v1/ops/overview")));
    else if (section === "matches") host.replaceChildren(await renderMatches());
    else if (section === "contests") host.replaceChildren(await renderContests());
    else if (section === "entries") host.replaceChildren(await renderEntries());
    else if (section === "settlements") host.replaceChildren(renderSettlements(await api("/v1/ops/settlements")));
    else if (section === "claims") host.replaceChildren(renderClaims(await api("/v1/ops/claims")));
    else if (section === "diagnostics") host.replaceChildren(renderDiagnostics(await api("/v1/ops/diagnostics")));
    else if (section === "audit") host.replaceChildren(await renderAudit());
    else host.replaceChildren(await renderAccess());
  } catch (error) {
    host.replaceChildren(el("p", error instanceof Error ? error.message : "Could not load", "muted"));
  }
}

function countCard(label: string, value: unknown): HTMLElement {
  const card = el("article", undefined, "card");
  card.append(el("span", label, "muted"));
  const shown = value && typeof value === "object" && "available" in (value as Json) && (value as Json).available === false
    ? String((value as Json).reason ?? "unavailable")
    : value === null || value === undefined
      ? "unavailable"
      : typeof value === "object"
        ? JSON.stringify(value)
        : String(value);
  card.append(el("strong", shown));
  return card;
}

function renderOverview(body: Json): HTMLElement {
  const wrap = el("div");
  const cards = el("div", undefined, "cards");
  cards.append(
    countCard("Health", body.health),
    countCard("Matches ingesting", body.matchesIngesting),
    countCard("Contests", body.contests),
    countCard("Settlements", body.settlements),
    countCard("Claims", body.claims),
    countCard("Operational errors", body.operationalErrors),
    countCard("Suspicious authz", body.suspiciousAuthz),
  );
  wrap.append(cards, el("p", "Counts come from live queries. Missing sources stay unavailable or stale.", "muted"));
  return wrap;
}

async function renderMatches(): Promise<HTMLElement> {
  const body = await api("/v1/ops/matches");
  const matches = Array.isArray(body.matches) ? body.matches as Json[] : [];
  const wrap = el("div");
  wrap.append(dataTable(
    ["Match", "State", "Kickoff", "Provider", "Freshness"],
    matches.map((match) => {
      const button = el("button", String(match.id), "ghost");
      button.addEventListener("click", () => { void showMatch(String(match.id), wrap); });
      const freshness = match.freshness as Json | undefined;
      return [
        button,
        badge(String(match.status ?? "unavailable")),
        String(match.kickoffAt ?? "unavailable"),
        String((match.dataSource as Json | undefined)?.provider ?? "unavailable"),
        badge(freshness?.available === false ? String(freshness.reason) : String(freshness?.state ?? "unavailable")),
      ];
    }),
  ));
  return wrap;
}

async function showMatch(id: string, host: HTMLElement): Promise<void> {
  host.replaceChildren(el("p", "Loading…", "muted"));
  const body = await api(`/v1/ops/matches/${encodeURIComponent(id)}`);
  const match = body.match as Json;
  const events = Array.isArray(body.events) ? body.events as Json[] : [];
  host.replaceChildren(
    panel("Match", textBlock(`${String(match.status)} · ${String(match.kickoffAt)}`)),
    panel("Events", dataTable(
      ["Sequence", "Type", "Provider", "Correction"],
      events.map((event) => [
        String(event.sequence ?? ""),
        String(event.eventType ?? ""),
        String(event.provider ?? ""),
        String(event.correctionType ?? ""),
      ]),
    )),
    panel("Lineup", textBlock(Array.isArray(body.lineup) ? `${body.lineup.length} squad rows` : "unavailable")),
    panel("Scoring / snapshots", textBlock(body.scoring && (body.scoring as Json).available === false ? (body.scoring as Json).reason : "observed")),
    el("p", "Append-only. No manual scoring.", "muted"),
  );
}

async function renderContests(): Promise<HTMLElement> {
  const body = await api("/v1/ops/contests");
  const contests = Array.isArray(body.contests) ? body.contests as Json[] : [];
  return dataTable(
    ["Contest", "Template", "Status", "Joinable", "Capacity", "Confirmed", "Pending", "Fee", "Lock"],
    contests.map((contest) => [
      String(contest.id),
      String(contest.templateCode ?? ""),
      badge(String(contest.status ?? "")),
      contest.joinable ? "OPEN/joinable" : "FULL/LOCKED/SETTLED or closed",
      String(contest.capacity ?? ""),
      String(contest.confirmedSeats ?? ""),
      String(contest.pendingReservations ?? ""),
      String(contest.entryFeeBaseUnits ?? ""),
      String(contest.lockTime ?? ""),
    ]),
  );
}

async function renderEntries(): Promise<HTMLElement> {
  const body = await api("/v1/ops/entries");
  const entries = Array.isArray(body.entries) ? body.entries as Json[] : [];
  return dataTable(
    ["Entry", "Contest", "Wallet", "Auth", "Created", "Last activity", "Revoked"],
    entries.map((entry) => [
      String(entry.entryId),
      String(entry.contestId),
      String(entry.wallet),
      String(entry.authMode ?? "solana_wallet"),
      String(entry.createdAt ?? entry.joinedAt ?? ""),
      entry.lastActivityAvailable ? String(entry.lastActivityAt) : "unavailable",
      entry.revoked === null ? "unavailable" : String(entry.revoked),
    ]),
  );
}

function renderSettlements(body: Json): HTMLElement {
  if (body.available === false) return el("p", String(body.reason ?? "unavailable"), "muted");
  const settlements = Array.isArray(body.settlements) ? body.settlements as Json[] : [];
  const wrap = el("div");
  wrap.append(el("p", "RUN settlement authority is not granted. No payout control is shown.", "muted"));
  wrap.append(dataTable(
    ["Settlement", "Stage", "Status", "Result hash", "Merkle", "Version", "Commitment", "Reconciliation"],
    settlements.map((row) => [
      String(row.id),
      badge(String(row.stage ?? "")),
      badge(String(row.status ?? "")),
      String(row.resultHash ?? ""),
      String(row.merkleRoot ?? ""),
      String(row.settlementVersion ?? ""),
      String(row.commitmentSignature ?? ""),
      String(row.reconciliation ?? ""),
    ]),
  ));
  if (capabilities.includes("RUN_SCORING")) {
    wrap.append(actionButton("Calculate result", "CALCULATE_RESULT", "Select a contest id", async (resource) => {
      await api(`/v1/ops/contests/${encodeURIComponent(resource)}/settlement/calculate`, {
        method: "POST",
        body: JSON.stringify({ confirm: true, confirmationText: "CALCULATE_RESULT" }),
      });
    }));
  }
  if (capabilities.includes("REVIEW_RESULT")) {
    wrap.append(actionButton("Mark reviewed", "REVIEW_RESULT", "Settlement id", async (resource) => {
      await api(`/v1/ops/settlements/${encodeURIComponent(resource)}/review`, {
        method: "POST",
        body: JSON.stringify({ confirm: true, confirmationText: "REVIEW_RESULT" }),
      });
    }));
    wrap.append(actionButton("Approve result", "APPROVE_RESULT", "Settlement id", async (resource) => {
      await api(`/v1/ops/settlements/${encodeURIComponent(resource)}/approve`, {
        method: "POST",
        body: JSON.stringify({ confirm: true, confirmationText: "APPROVE_RESULT" }),
      });
    }));
  }
  return wrap;
}

function renderClaims(body: Json): HTMLElement {
  if (body.available === false) return el("p", String(body.reason ?? "unavailable"), "muted");
  const claims = Array.isArray(body.claims) ? body.claims as Json[] : [];
  const wrap = el("div");
  wrap.append(el("p", "Claim proofs stay owner-scoped. A signature is not paid until finalized reconciliation.", "muted"));
  wrap.append(dataTable(
    ["Claimant", "Entry", "Payout", "Status", "Signature", "Finalized", "Reconciliation", "Explorer"],
    claims.map((claim) => {
      const link = el("span", claim.explorerUrl ? "explorer" : "unavailable");
      return [
        String(claim.claimant ?? ""),
        String(claim.entryId ?? ""),
        String(claim.payoutBaseUnits ?? ""),
        badge(String(claim.displayStatus ?? claim.rawStatus ?? "")),
        String(claim.signature ?? ""),
        claim.finalized ? "finalized" : "not finalized",
        String(claim.reconciliation ?? ""),
        link,
      ];
    }),
  ));
  return wrap;
}

function renderDiagnostics(body: Json): HTMLElement {
  const wrap = el("div");
  if (body.available === false) {
    wrap.append(badge(String(body.reason ?? "unavailable")), el("p", "Diagnostics source is not available.", "muted"));
  } else {
  const metrics = (body.metrics ?? {}) as Json;
  const keys = [
    "providerLatencyMsLast",
    "providerLatencyMsAvg",
    "providerErrors",
    "ingestionLagMs",
    "unresolvedPlayerMappings",
    "duplicateEventsRejected",
    "correctionsReceived",
    "scoringRecomputations",
    "redisRebuilds",
    "staleMatches",
  ];
  wrap.append(dataTable(
    ["Signal", "Value"],
    keys.map((key) => [key, metrics[key] === null || metrics[key] === undefined ? "unavailable" : String(metrics[key])]),
  ));
  wrap.append(el("p", "Reused Phase 5 diagnostics. No second ingest implementation.", "muted"));
  }
  const counters = body.counters;
  if (counters && typeof counters === "object") {
    const rows = Object.entries(counters as Json).map(([key, value]) => [key, String(value)]);
    wrap.append(el("h2", "Reliability counters"));
    wrap.append(dataTable(["Counter", "Count"], rows));
    wrap.append(el("p", "Counters increment only when the API records the event. Liveness, readiness, and dependency health stay on /health, /ready, and /health/dependencies.", "muted"));
  }
  return wrap;
}

async function renderAudit(): Promise<HTMLElement> {
  const wrap = el("div");
  const filters = el("form", undefined, "filters");
  const actor = labeled("Actor", "text");
  const action = labeled("Action", "text");
  const entity = labeled("Entity", "text");
  const from = labeled("From", "text");
  const failure = labeled("Failures only", "checkbox");
  const denied = labeled("Permission denials", "checkbox");
  const submit = el("button", "Filter", "primary");
  submit.type = "submit";
  filters.append(actor.label, action.label, entity.label, from.label, failure.label, denied.label, submit);
  const host = el("div");
  filters.addEventListener("submit", (event) => {
    event.preventDefault();
    const params = new URLSearchParams();
    if (actor.input.value) params.set("actor", actor.input.value);
    if (action.input.value) params.set("action", action.input.value);
    if (entity.input.value) params.set("entityType", entity.input.value);
    if (from.input.value) params.set("from", from.input.value);
    if ((failure.input as HTMLInputElement).checked) params.set("failure", "1");
    if ((denied.input as HTMLInputElement).checked) params.set("denied", "1");
    void api(`/v1/ops/audit/events?${params.toString()}`).then((body) => {
      host.replaceChildren(auditTable(body));
    }).catch((error: unknown) => {
      host.replaceChildren(el("p", error instanceof Error ? error.message : "Could not load"));
    });
  });
  wrap.append(filters, host, el("p", "Read only. Audit rows cannot be edited or deleted.", "muted"));
  host.replaceChildren(auditTable(await api("/v1/ops/audit/events")));
  return wrap;
}

function auditTable(body: Json): HTMLTableElement {
  const events = Array.isArray(body.events) ? body.events as Json[] : [];
  return dataTable(
    ["Time", "Actor", "Wallet", "Action", "Entity", "Id", "Correlation", "Result", "Metadata"],
    events.map((event) => [
      String(event.occurredAt ?? ""),
      String(event.actorAccountId ?? ""),
      String(event.actorWallet ?? ""),
      String(event.action ?? ""),
      String(event.entityType ?? ""),
      String(event.entityId ?? ""),
      String(event.correlationId ?? ""),
      String(event.result ?? ""),
      JSON.stringify(event.metadata ?? {}),
    ]),
  );
}

async function renderAccess(): Promise<HTMLElement> {
  const [catalog, listing] = await Promise.all([
    api("/v1/ops/access/catalog"),
    api("/v1/ops/access/members"),
  ]);
  const wrap = el("div");
  const members = Array.isArray(listing.members) ? listing.members as Json[] : [];
  wrap.append(dataTable(
    ["Wallet", "Capabilities", "Status", "Last activity", "Scope", "Sessions"],
    members.map((member) => [
      String(member.walletAddress ?? ""),
      Array.isArray(member.capabilityClasses) ? member.capabilityClasses.join(", ") : "",
      badge(String(member.status ?? "")),
      member.lastActivityAvailable ? String(member.lastActivityAt) : "unavailable",
      String(member.scope ?? "platform"),
      String(member.activeSessions ?? "0"),
    ]),
  ));
  const roles = Array.isArray(catalog.assignableRoles) ? catalog.assignableRoles.map(String) : [];
  const caps = Array.isArray(catalog.assignableCapabilities) ? catalog.assignableCapabilities.map(String) : [];
  const blocked = Array.isArray(catalog.notAssignable) ? catalog.notAssignable.map(String) : [];
  wrap.append(el("p", `Not assignable: ${blocked.join(", ") || "none"}. ${String(catalog.note ?? "")}`, "muted"));
  wrap.append(accessForm("Grant assignment", roles, "GRANT_ROLE", "/v1/ops/access/roles", "role"));
  wrap.append(accessForm("Remove assignment", roles, "REMOVE_ROLE", "/v1/ops/access/roles/remove", "role"));
  wrap.append(accessForm("Grant capability", caps, "GRANT_CAPABILITY", "/v1/ops/access/capabilities", "capability"));
  wrap.append(accessForm("Remove capability", caps, "REMOVE_CAPABILITY", "/v1/ops/access/capabilities/remove", "capability"));
  return wrap;
}

function accessForm(title: string, choices: string[], confirmationText: string, path: string, field: string): HTMLElement {
  return actionButton(title, confirmationText, "Account id", async (resource, extra) => {
    await api(path, {
      method: "POST",
      body: JSON.stringify({
        confirm: true,
        confirmationText,
        accountId: resource,
        [field]: extra,
      }),
    });
  }, choices);
}

function actionButton(
  label: string,
  confirmationText: string,
  resourceLabel: string,
  run: (resource: string, extra: string) => Promise<void>,
  choices?: string[],
): HTMLElement {
  const button = el("button", label, "danger");
  button.addEventListener("click", () => {
    const modal = el("div", undefined, "modal");
    const form = el("form", undefined, "stack");
    form.append(el("h3", label), el("p", `Actor: ${wallet || "signed-in session"}`), el("p", "This does not move USDC."));
    const resource = labeled(resourceLabel, "text");
    form.append(resource.label);
    let extra = "";
    if (choices) {
      const select = document.createElement("select");
      for (const choice of choices) select.append(new Option(choice, choice));
      extra = select.value;
      select.addEventListener("change", () => { extra = select.value; });
      form.append(select);
    }
    const accept = el("button", `Confirm ${confirmationText}`, "primary");
    accept.type = "submit";
    const cancel = el("button", "Cancel", "ghost");
    cancel.type = "button";
    cancel.addEventListener("click", () => modal.remove());
    form.append(accept, cancel);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      void run(resource.input.value.trim(), extra).then(() => {
        modal.remove();
        const host = document.querySelector("#ops-main");
        if (host instanceof HTMLElement) void loadSection(host);
      }).catch((error: unknown) => {
        form.append(el("p", error instanceof Error ? error.message : "Action failed"));
      });
    });
    modal.append(form);
    document.body.append(modal);
  });
  return button;
}

function labeled(name: string, type: string): { label: HTMLLabelElement; input: HTMLInputElement } {
  const label = el("label", `${name} `);
  const input = document.createElement("input");
  input.type = type;
  input.autocomplete = "off";
  label.append(input);
  return { label, input };
}

function draw(): void {
  opsRoot.replaceChildren();
  if (!token) {
    const box = el("form", undefined, "login stack");
    box.append(el("h1", "Operations Control Center"), el("p", "Internal console. Session token stays in memory for this tab only.", "muted"));
    const field = labeled("Session token", "password");
    const submit = el("button", "Enter", "primary");
    submit.type = "submit";
    box.append(field.label, submit);
    box.addEventListener("submit", (event) => {
      event.preventDefault();
      token = field.input.value.trim();
      void api("/v1/ops/session").then((body) => {
        wallet = String(body.walletAddress ?? "");
        capabilities = Array.isArray(body.capabilities) ? body.capabilities.map(String) : [];
        const first = SECTIONS.find((item) => capabilities.includes(item.capability));
        section = first?.id ?? "overview";
        draw();
      }).catch((error: unknown) => {
        token = null;
        box.append(el("p", error instanceof Error ? error.message : "Rejected"));
      });
    });
    opsRoot.append(box);
    return;
  }
  const frame = el("div", undefined, "frame");
  const nav = el("nav", undefined, "nav");
  nav.append(el("h1", "KICKR OPS"), el("p", wallet));
  for (const item of SECTIONS) {
    if (!capabilities.includes(item.capability)) continue;
    const button = el("button", item.label);
    if (item.id === section) button.setAttribute("aria-current", "page");
    button.addEventListener("click", () => {
      section = item.id;
      draw();
    });
    nav.append(button);
  }
  const leave = el("button", "Leave");
  leave.addEventListener("click", () => {
    token = null;
    capabilities = [];
    draw();
  });
  nav.append(leave);
  const main = el("div", undefined, "main");
  main.id = "ops-main";
  const bar = el("div", undefined, "bar");
  bar.append(el("strong", SECTIONS.find((item) => item.id === section)?.label ?? "Operations"), el("span", "Desktop operations console", "muted"));
  main.append(bar);
  frame.append(nav, main);
  opsRoot.append(frame);
  void loadSection(main);
}

draw();
