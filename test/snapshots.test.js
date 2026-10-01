import assert from "node:assert/strict";
import test from "node:test";

import { createEngine } from "../src/index.js";

const rollingSystem = {
  id: "rolling-system",
  onAction({ action, emit, random, state }) {
    if (action.type !== "roll") return { state };
    const roll = random.integer(1, 100);
    emit({ type: "rolled", payload: { roll } });
    return { state: { rolls: [...state.rolls, roll] } };
  }
};

test("restore reproduces subsequent state, randomness, and event ids", () => {
  const engine = createEngine({
    initialState: { rolls: [] },
    seed: "timeline",
    systems: [rollingSystem]
  });
  engine.dispatch({ type: "roll" });
  const checkpoint = engine.snapshot({ label: "first roll" });

  const firstFuture = engine.dispatch({ type: "roll" });
  engine.restore(checkpoint);
  const repeatedFuture = engine.dispatch({ type: "roll" });

  assert.deepEqual(repeatedFuture.state, firstFuture.state);
  assert.deepEqual(repeatedFuture.events, firstFuture.events);
});

test("fork creates new branch metadata without mutating the source", () => {
  const engine = createEngine({ branchId: "original" });
  const source = engine.snapshot();
  const fork = engine.fork("alternate-route");

  assert.equal(source.branch.id, "original");
  assert.equal(source.branch.parentId, null);
  assert.equal(fork.branch.id, "alternate-route");
  assert.equal(fork.branch.parentId, "original");
  assert.deepEqual(engine.snapshot().branch, source.branch);
});

test("invalid restore leaves the current simulation unchanged", () => {
  const engine = createEngine({ initialState: { stable: true } });
  const before = engine.snapshot();
  const invalid = structuredClone(before);
  invalid.events.format = "unknown-journal";

  assert.throws(() => engine.restore(invalid), /event journal/);
  assert.deepEqual(engine.snapshot(), before);
});
