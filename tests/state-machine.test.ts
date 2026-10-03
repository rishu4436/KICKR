import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as stateMachine from "../domain/state-machine.js";
import { IllegalTransitionError } from "../shared/errors.js";

describe("state machine", () => {
  it("accepts the defined contest sequence", () => {
    const pathStates = [
      "OPEN",
      "PENDING",
      "CONFIRMED",
      "LOCKED",
      "IN_REVIEW",
      "READY_FOR_SETTLEMENT",
      "SETTLED",
    ] as const;
    let current: string = pathStates[0];
    for (const next of pathStates.slice(1)) {
      expect(stateMachine.isTransitionLegal("CONTEST", current, next)).toBe(true);
      current = stateMachine.transition("CONTEST", current, next);
    }
    expect(current).toBe("SETTLED");
  });

  it("rejects an illegal contest transition", () => {
    expect(stateMachine.isTransitionLegal("CONTEST", "OPEN", "LOCKED")).toBe(false);
    expect(() => stateMachine.transition("CONTEST", "OPEN", "SETTLED")).toThrow(IllegalTransitionError);
    expect(stateMachine.isTransitionLegal("CONTEST", "OPEN", "REFUNDED")).toBe(false);
    expect(stateMachine.isTransitionLegal("CONTEST", "SETTLED", "REFUNDED")).toBe(false);
    expect(stateMachine.isTransitionLegal("CONTEST", "LOCKED", "REFUNDED")).toBe(false);
  });

  it("rejects arbitrary status mutation and has no setStatus", () => {
    expect("setStatus" in stateMachine).toBe(false);
    expect("assignStatus" in stateMachine).toBe(false);
    const source = readFileSync(path.resolve(process.cwd(), "domain/state-machine.ts"), "utf8");
    expect(source).not.toMatch(/function setStatus/);
    expect(source).not.toMatch(/setStatus\s*[:(=]/);
    expect(() => stateMachine.transition("ACCOUNT", "ACTIVE", "DISABLED")).toThrow(IllegalTransitionError);
    expect(() => stateMachine.transition("ENTRY", "DRAFT", "CONFIRMED")).toThrow(IllegalTransitionError);
    expect(stateMachine.isTransitionLegal("NOPE" as "ACCOUNT", "A", "B")).toBe(false);
  });
});
