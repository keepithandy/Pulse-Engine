import assert from "node:assert/strict";
import test from "node:test";

import { createEngine, createSeededRandom } from "../src/index.js";

test("identical seeds produce identical sequences", () => {
  const first = createSeededRandom("outpost-zero");
  const second = createSeededRandom("outpost-zero");

  assert.deepEqual(
    Array.from({ length: 8 }, () => first.next()),
    Array.from({ length: 8 }, () => second.next())
  );
});

test("restoring generator state resumes the same sequence", () => {
  const random = createSeededRandom(42);
  random.next();
  const checkpoint = random.getState();
  const expected = [random.next(), random.integer(1, 10), random.pick(["a", "b", "c"])];

  random.setState(checkpoint);

  assert.deepEqual(
    [random.next(), random.integer(1, 10), random.pick(["a", "b", "c"])],
    expected
  );
});

test("engine systems receive deterministic random helpers", () => {
  const randomSystem = {
    id: "roll",
    onAction({ action, random, state }) {
      if (action.type !== "roll") return { state };
      return { state: { rolls: [...state.rolls, random.integer(1, 20)] } };
    }
  };
  const makeEngine = () => createEngine({
    initialState: { rolls: [] },
    seed: "same-world",
    systems: [randomSystem]
  });
  const first = makeEngine();
  const second = makeEngine();

  for (let index = 0; index < 5; index += 1) {
    first.dispatch({ type: "roll" });
    second.dispatch({ type: "roll" });
  }

  assert.deepEqual(first.getState(), second.getState());
});

test("rejected actions roll random state back", () => {
  const system = {
    id: "rejecting-roll",
    onAction({ action, random, state }) {
      const roll = random.integer(1, 100);
      if (action.type === "reject") return { accepted: false };
      return { state: { ...state, roll } };
    }
  };
  const first = createEngine({ initialState: {}, seed: 7, systems: [system] });
  const second = createEngine({ initialState: {}, seed: 7, systems: [system] });

  first.dispatch({ type: "reject" });
  first.dispatch({ type: "accept" });
  second.dispatch({ type: "accept" });

  assert.deepEqual(first.getState(), second.getState());
});
