/**
 * Deterministic Tutorial Match event script (Phase 18D.1).
 * Compressed PRE → 1H → HT → 2H → FT timeline (~4 minutes wall clock).
 * Fictional DEMO provider only — never Sportmonks / LIVE fixtures.
 */
import type { ProviderEvent, ProviderPlayer } from "./types.js";
import { DEMO_PROVIDER_NAME, DEMO_CLUB_A, DEMO_CLUB_B, DEMO_MATCH_UPCOMING } from "./demo-provider.js";
import { buildDemoCatalog } from "./demo-provider.js";

export const TUTORIAL_MATCH_ID = DEMO_MATCH_UPCOMING;

/** Wall-clock offsets from simulation start (ms). Total ~4 min feel. */
export const TUTORIAL_TIMELINE_MS = {
  KICKOFF: 0,
  /** 1H */
  SOT_1: 12_000,
  GOAL_1: 28_000,
  ASSIST_1: 28_500,
  YELLOW_1: 55_000,
  SOT_2: 75_000,
  GOAL_2: 95_000,
  ASSIST_2: 95_500,
  HT: 110_000,
  /** 2H */
  SECOND_HALF: 130_000,
  SOT_3: 150_000,
  /** Goal that VAR will disallow */
  GOAL_VAR: 170_000,
  SUBSTITUTION: 190_000,
  VAR_REVERSAL: 210_000,
  YELLOW_2: 225_000,
  GOAL_3: 240_000,
  FULL_TIME: 255_000,
  FINALIZE: 265_000,
} as const;

export type TutorialPhase = "PRE" | "1H" | "HT" | "2H" | "FT";

export interface TutorialScriptStep {
  /** Stable sequence within a run (1-based). */
  sequence: number;
  /** ms after simulation start when this step fires */
  atMs: number;
  kind: "STATE" | "EVENT" | "COACH";
  /** Match state target for STATE steps */
  toStatus?: "LOCKED" | "LIVE" | "FULL_TIME" | "DATA_FINALIZING" | "FINAL";
  /** Football clock display */
  matchMinute?: number;
  period?: "1" | "2" | "HT" | "FT";
  phase?: TutorialPhase;
  eventType?: ProviderEvent["eventType"];
  primaryShort?: string;
  secondaryShort?: string;
  team?: "home" | "away";
  /** When set, this event supersedes the step with this sequence */
  supersedesSequence?: number;
  coachTip?: {
    id: string;
    title: string;
    body: string;
  };
  label?: string;
}

/** Fixed educational tips — dismissible, tutorial-only. */
export const TUTORIAL_COACH_TIPS = {
  captain: {
    id: "captain",
    title: "Captain bonus",
    body: "Your captain scores 2× fantasy points. Vice-captain scores 1.5×.",
  },
  sot: {
    id: "sot",
    title: "Shot on target",
    body: "A shot on target earns +1 fantasy point under LIVE_V1 rules.",
  },
  leaderboard: {
    id: "leaderboard",
    title: "Leaderboard update",
    body: "Points and ranks refresh as match events land — watch your rank move.",
  },
  var: {
    id: "var",
    title: "VAR correction",
    body: "A disallowed goal reverses the fantasy points from that goal (and linked assist when corrected).",
  },
} as const;

function playersByShort(players: readonly ProviderPlayer[]): Map<string, ProviderPlayer> {
  const map = new Map<string, ProviderPlayer>();
  for (const p of players) {
    map.set(p.shortName, p);
  }
  return map;
}

/**
 * Canonical ordered script. Same start → same events every time.
 */
export function buildTutorialScriptSteps(): TutorialScriptStep[] {
  return [
    {
      sequence: 1,
      atMs: TUTORIAL_TIMELINE_MS.KICKOFF,
      kind: "STATE",
      toStatus: "LOCKED",
      phase: "PRE",
      matchMinute: 0,
      period: "1",
      label: "Lineups locked",
    },
    {
      sequence: 2,
      atMs: TUTORIAL_TIMELINE_MS.KICKOFF + 500,
      kind: "STATE",
      toStatus: "LIVE",
      phase: "1H",
      matchMinute: 0,
      period: "1",
      label: "Kick-off",
      coachTip: TUTORIAL_COACH_TIPS.captain,
    },
    {
      sequence: 3,
      atMs: TUTORIAL_TIMELINE_MS.SOT_1,
      kind: "EVENT",
      eventType: "SHOT_ON_TARGET",
      primaryShort: "AM1",
      team: "home",
      matchMinute: 8,
      period: "1",
      phase: "1H",
      coachTip: TUTORIAL_COACH_TIPS.sot,
    },
    {
      sequence: 4,
      atMs: TUTORIAL_TIMELINE_MS.GOAL_1,
      kind: "EVENT",
      eventType: "GOAL",
      primaryShort: "AF2",
      team: "home",
      matchMinute: 18,
      period: "1",
      phase: "1H",
      label: "GOAL",
    },
    {
      sequence: 5,
      atMs: TUTORIAL_TIMELINE_MS.ASSIST_1,
      kind: "EVENT",
      eventType: "ASSIST",
      primaryShort: "AM2",
      team: "home",
      matchMinute: 18,
      period: "1",
      phase: "1H",
    },
    {
      sequence: 6,
      atMs: TUTORIAL_TIMELINE_MS.YELLOW_1,
      kind: "EVENT",
      eventType: "YELLOW_CARD",
      primaryShort: "BD1",
      team: "away",
      matchMinute: 33,
      period: "1",
      phase: "1H",
    },
    {
      sequence: 7,
      atMs: TUTORIAL_TIMELINE_MS.SOT_2,
      kind: "EVENT",
      eventType: "SHOT_ON_TARGET",
      primaryShort: "BF2",
      team: "away",
      matchMinute: 41,
      period: "1",
      phase: "1H",
    },
    {
      sequence: 8,
      atMs: TUTORIAL_TIMELINE_MS.GOAL_2,
      kind: "EVENT",
      eventType: "GOAL",
      primaryShort: "BF2",
      team: "away",
      matchMinute: 44,
      period: "1",
      phase: "1H",
      coachTip: TUTORIAL_COACH_TIPS.leaderboard,
    },
    {
      sequence: 9,
      atMs: TUTORIAL_TIMELINE_MS.ASSIST_2,
      kind: "EVENT",
      eventType: "ASSIST",
      primaryShort: "BM2",
      team: "away",
      matchMinute: 44,
      period: "1",
      phase: "1H",
    },
    {
      sequence: 10,
      atMs: TUTORIAL_TIMELINE_MS.HT,
      kind: "COACH",
      phase: "HT",
      matchMinute: 45,
      period: "HT",
      label: "Half-time",
    },
    {
      sequence: 11,
      atMs: TUTORIAL_TIMELINE_MS.SECOND_HALF,
      kind: "COACH",
      phase: "2H",
      matchMinute: 45,
      period: "2",
      label: "Second half",
    },
    {
      sequence: 12,
      atMs: TUTORIAL_TIMELINE_MS.SOT_3,
      kind: "EVENT",
      eventType: "SHOT_ON_TARGET",
      primaryShort: "AM2",
      team: "home",
      matchMinute: 55,
      period: "2",
      phase: "2H",
    },
    {
      sequence: 13,
      atMs: TUTORIAL_TIMELINE_MS.GOAL_VAR,
      kind: "EVENT",
      eventType: "GOAL",
      primaryShort: "AF2",
      team: "home",
      matchMinute: 62,
      period: "2",
      phase: "2H",
      label: "GOAL (pending VAR)",
    },
    {
      sequence: 14,
      atMs: TUTORIAL_TIMELINE_MS.SUBSTITUTION,
      kind: "EVENT",
      eventType: "SUBSTITUTION",
      primaryShort: "AM1",
      secondaryShort: "AM3",
      team: "home",
      matchMinute: 68,
      period: "2",
      phase: "2H",
      label: "Substitution",
    },
    {
      sequence: 15,
      atMs: TUTORIAL_TIMELINE_MS.VAR_REVERSAL,
      kind: "EVENT",
      eventType: "VAR_REVERSAL",
      primaryShort: "AF2",
      team: "home",
      matchMinute: 70,
      period: "2",
      phase: "2H",
      supersedesSequence: 13,
      label: "VAR — goal disallowed",
      coachTip: TUTORIAL_COACH_TIPS.var,
    },
    {
      sequence: 16,
      atMs: TUTORIAL_TIMELINE_MS.YELLOW_2,
      kind: "EVENT",
      eventType: "YELLOW_CARD",
      primaryShort: "BD2",
      team: "away",
      matchMinute: 78,
      period: "2",
      phase: "2H",
    },
    {
      sequence: 17,
      atMs: TUTORIAL_TIMELINE_MS.GOAL_3,
      kind: "EVENT",
      eventType: "GOAL",
      primaryShort: "AF2",
      team: "home",
      matchMinute: 85,
      period: "2",
      phase: "2H",
      label: "GOAL",
    },
    {
      sequence: 18,
      atMs: TUTORIAL_TIMELINE_MS.FULL_TIME,
      kind: "STATE",
      toStatus: "FULL_TIME",
      phase: "FT",
      matchMinute: 90,
      period: "FT",
      label: "Full time",
    },
    {
      sequence: 19,
      atMs: TUTORIAL_TIMELINE_MS.FULL_TIME + 2_000,
      kind: "STATE",
      toStatus: "DATA_FINALIZING",
      phase: "FT",
      matchMinute: 90,
      period: "FT",
    },
    {
      sequence: 20,
      atMs: TUTORIAL_TIMELINE_MS.FINALIZE,
      kind: "STATE",
      toStatus: "FINAL",
      phase: "FT",
      matchMinute: 90,
      period: "FT",
      label: "Tutorial complete",
    },
  ];
}

export function tutorialProviderEventId(runId: string, sequence: number): string {
  return `tutorial-${runId}-evt-${sequence}`;
}

export function tutorialEventId(runId: string, sequence: number): string {
  const hex = `${runId.replace(/[^a-f0-9]/gi, "").slice(0, 8)}${String(sequence).padStart(4, "0")}`.padEnd(12, "0").slice(0, 12);
  return `90000000-0000-4000-8000-${hex}`;
}

/**
 * Materialize ProviderEvents for EVENT steps up to (and including) appliedThrough sequence.
 * Deterministic IDs for a given runId.
 */
export function materializeTutorialEvents(input: {
  matchId: string;
  runId: string;
  throughSequence: number;
  createdAt?: string;
}): ProviderEvent[] {
  const catalog = buildDemoCatalog();
  const byShort = playersByShort(catalog.players);
  const steps = buildTutorialScriptSteps().filter(
    (s) => s.kind === "EVENT" && s.sequence <= input.throughSequence,
  );
  const eventIdBySequence = new Map<number, string>();
  const out: ProviderEvent[] = [];

  for (const step of steps) {
    const primary = step.primaryShort ? byShort.get(step.primaryShort) : undefined;
    if (!primary) {
      throw new Error(`Tutorial script missing player ${step.primaryShort}`);
    }
    const secondary = step.secondaryShort ? byShort.get(step.secondaryShort) ?? null : null;
    if (step.secondaryShort && !secondary) {
      throw new Error(`Tutorial script missing secondary ${step.secondaryShort}`);
    }
    const teamId = step.team === "away" ? DEMO_CLUB_B : DEMO_CLUB_A;
    const eventId = tutorialEventId(input.runId, step.sequence);
    eventIdBySequence.set(step.sequence, eventId);
    let supersedesEventId: string | null = null;
    if (step.supersedesSequence != null) {
      supersedesEventId = eventIdBySequence.get(step.supersedesSequence) ?? tutorialEventId(input.runId, step.supersedesSequence);
    }
    out.push({
      eventId,
      matchId: input.matchId,
      provider: DEMO_PROVIDER_NAME,
      providerEventId: tutorialProviderEventId(input.runId, step.sequence),
      sequence: step.sequence,
      timestamp: input.createdAt ?? new Date().toISOString(),
      matchMinute: step.matchMinute ?? 0,
      period: step.period === "2" ? "2" : "1",
      eventType: step.eventType!,
      primaryPlayerId: primary.id,
      secondaryPlayerId: secondary?.id ?? null,
      teamId,
      metadata: {
        label: step.label ?? `Tutorial ${step.eventType}`,
        source: DEMO_PROVIDER_NAME,
        notSportmonks: true,
        demoData: true,
        tutorial: true,
        simulated: true,
        runId: input.runId,
        ...(step.eventType === "VAR_REVERSAL" ? { correctionType: "VAR_REVERSAL" } : {}),
      },
      supersedesEventId,
      createdAt: input.createdAt ?? new Date().toISOString(),
    });
  }
  return out;
}

export function phaseAtElapsed(elapsedMs: number): TutorialPhase {
  if (elapsedMs < TUTORIAL_TIMELINE_MS.KICKOFF + 500) return "PRE";
  if (elapsedMs < TUTORIAL_TIMELINE_MS.HT) return "1H";
  if (elapsedMs < TUTORIAL_TIMELINE_MS.SECOND_HALF) return "HT";
  if (elapsedMs < TUTORIAL_TIMELINE_MS.FULL_TIME) return "2H";
  return "FT";
}

export function footballScoreAfterSequence(throughSequence: number): { home: number; away: number } {
  let home = 0;
  let away = 0;
  const superseded = new Set<number>();
  for (const step of buildTutorialScriptSteps()) {
    if (step.kind !== "EVENT" || step.sequence > throughSequence) continue;
    if (step.supersedesSequence != null) superseded.add(step.supersedesSequence);
  }
  for (const step of buildTutorialScriptSteps()) {
    if (step.kind !== "EVENT" || step.sequence > throughSequence) continue;
    if (superseded.has(step.sequence)) continue;
    if (step.eventType === "GOAL") {
      if (step.team === "away") away += 1;
      else home += 1;
    }
  }
  return { home, away };
}

export function expectedTutorialDurationMs(): number {
  return TUTORIAL_TIMELINE_MS.FINALIZE;
}
