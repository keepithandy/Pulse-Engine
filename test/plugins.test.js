import assert from "node:assert/strict";
import test from "node:test";

import { createEngine, createPluginRegistry } from "../src/index.js";

test("orders plug-ins after their dependencies", () => {
  const order = [];
  const engine = createEngine({
    initialState: {},
    plugins: [
      {
        id: "consumer",
        version: "1.0.0",
        dependsOn: ["foundation"],
        onAction({ state }) {
          order.push("consumer");
          return { state };
        }
      },
      {
        id: "foundation",
        version: "1.0.0",
        onAction({ state }) {
          order.push("foundation");
          return { state };
        }
      }
    ]
  });

  engine.dispatch({ type: "inspect" });

  assert.deepEqual(order, ["foundation", "consumer"]);
  assert.deepEqual(
    engine.getPlugins().map((plugin) => plugin.id),
    ["foundation", "consumer"]
  );
});

test("rejects duplicate, missing, and cyclic dependencies", () => {
  assert.throws(
    () => createPluginRegistry([{ id: "same" }, { id: "same" }]),
    /Duplicate/
  );
  assert.throws(
    () => createPluginRegistry([{ id: "child", dependsOn: ["missing"] }]),
    /missing dependency/
  );
  assert.throws(
    () => createPluginRegistry([
      { id: "first", dependsOn: ["second"] },
      { id: "second", dependsOn: ["first"] }
    ]),
    /Cyclic/
  );
});

test("runs setup and dispose for dynamically managed plug-ins", () => {
  const lifecycle = [];
  const engine = createEngine();

  const metadata = engine.registerPlugin({
    id: "weather",
    version: "0.1.0",
    setup({ pluginId }) {
      lifecycle.push(`setup:${pluginId}`);
    },
    dispose({ pluginId }) {
      lifecycle.push(`dispose:${pluginId}`);
    }
  });
  const removed = engine.unregisterPlugin("weather");

  assert.equal(metadata.version, "0.1.0");
  assert.equal(removed, true);
  assert.deepEqual(lifecycle, ["setup:weather", "dispose:weather"]);
});

test("notifies onEvent hooks without allowing failures to corrupt state", () => {
  const seen = [];
  const engine = createEngine({
    initialState: { stable: true },
    plugins: [
      {
        id: "emitter",
        onAction({ emit, state }) {
          emit({ type: "status/checked" });
          return { state };
        }
      },
      {
        id: "observer",
        onEvent({ event }) {
          seen.push(event.type);
          throw new Error("observer failed");
        }
      }
    ]
  });

  const result = engine.dispatch({ type: "status/check" });

  assert.deepEqual(seen, ["status/checked"]);
  assert.equal(result.pluginErrors.length, 1);
  assert.deepEqual(engine.getState(), { stable: true });
});
