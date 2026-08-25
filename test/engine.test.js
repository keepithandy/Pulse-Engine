import assert from "node:assert/strict";
import test from "node:test";

import { createEngine } from "../src/index.js";

const counterSystem = {
  id: "counter",
  onAction({ action, state }) {
    if (action.type === "counter/increment") {
      return { state: { ...state, count: state.count + 1 } };
    }

    if (action.type === "counter/reject") {
      return { accepted: false, reason: "Counter is locked." };
    }

    return { state };
  }
};

test("dispatches an action through registered systems", () => {
  const engine = createEngine({
    initialState: { count: 0 },
    systems: [counterSystem]
  });

  const result = engine.dispatch({ type: "counter/increment" });

  assert.equal(result.accepted, true);
  assert.equal(result.action.id, "action-000001");
  assert.deepEqual(engine.getState(), { count: 1 });
});

test("rejected actions leave state and revision unchanged", () => {
  const engine = createEngine({
    initialState: { count: 0 },
    systems: [counterSystem]
  });

  const result = engine.dispatch({ type: "counter/reject" });

  assert.equal(result.accepted, false);
  assert.equal(result.revision, 0);
  assert.deepEqual(engine.getState(), { count: 0 });
});

test("returns defensive state copies", () => {
  const engine = createEngine({ initialState: { nested: { value: 1 } } });
  const external = engine.getState();

  external.nested.value = 99;

  assert.equal(engine.getState().nested.value, 1);
});

test("subscribers can unsubscribe and cannot corrupt committed state", () => {
  const engine = createEngine({
    initialState: { count: 0 },
    systems: [counterSystem]
  });
  let calls = 0;
  const unsubscribe = engine.subscribe(() => {
    calls += 1;
    throw new Error("listener failure");
  });

  const first = engine.dispatch({ type: "counter/increment" });
  unsubscribe();
  engine.dispatch({ type: "counter/increment" });

  assert.equal(calls, 1);
  assert.equal(first.listenerErrors.length, 1);
  assert.deepEqual(engine.getState(), { count: 2 });
});

test("rejects malformed actions", () => {
  const engine = createEngine();

  assert.throws(() => engine.dispatch({}), /non-empty type/);
});
