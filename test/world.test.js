import assert from "node:assert/strict";
import test from "node:test";
import { createEngine, createWorldPlugin, getEntity, queryEntities } from "../src/index.js";

function makeWorld(options = {}) {
  return createEngine({
    initialState: { resources: { metal: 3 } },
    systems: [createWorldPlugin(), ...(options.systems ?? [])]
  });
}

test("world plugin creates deterministic entities and query returns detached data", () => {
  const engine = makeWorld();
  const first = engine.dispatch({ type: "world/entity.create", entityType: "worker", components: {
    position: { x: 2, y: 4 }, health: 10
  } });
  const second = engine.dispatch({ type: "world/entity.create", entityType: "depot", components: {
    position: { x: 0, y: 0 }, storage: { metal: 3 }
  } });

  assert.equal(first.accepted, true);
  assert.equal(first.action.entityId, undefined);
  assert.deepEqual(first.events[0].payload, { entityId: "entity-000001", entityType: "worker" });
  assert.deepEqual(second.events[0].payload, { entityId: "entity-000002", entityType: "depot" });
  const workers = queryEntities(engine.getState(), { type: "worker", with: ["position"] });
  assert.deepEqual(workers.map(entity => entity.id), ["entity-000001"]);
  workers[0].components.position.x = 99;
  assert.equal(getEntity(engine.getState(), "entity-000001").components.position.x, 2);
  assert.deepEqual(queryEntities(engine.getState(), { with: ["storage"], without: ["disabled"] })
    .map(entity => entity.id), ["entity-000002"]);
});

test("component actions update state and publish deterministic world events", () => {
  const engine = makeWorld();
  engine.dispatch({ type: "world/entity.create", entityType: "drone", entityId: "scout-1" });
  const set = engine.dispatch({ type: "world/component.set", entityId: "scout-1", component: "battery", value: 80 });
  assert.equal(set.accepted, true);
  assert.deepEqual(set.events.map(event => event.type), ["world/component.set"]);
  assert.equal(getEntity(engine.getState(), "scout-1").components.battery, 80);
  const remove = engine.dispatch({ type: "world/component.remove", entityId: "scout-1", component: "battery" });
  assert.equal(remove.accepted, true);
  assert.deepEqual(queryEntities(engine.getState(), { with: ["battery"] }), []);
  const missing = engine.dispatch({ type: "world/component.remove", entityId: "scout-1", component: "battery" });
  assert.equal(missing.accepted, false);
  assert.equal(missing.revision, remove.revision);
});

test("destroy removes entities from lookups while preserving other game state", () => {
  const engine = makeWorld();
  engine.dispatch({ type: "world/entity.create", entityType: "tree", entityId: "tree-1" });
  const result = engine.dispatch({ type: "world/entity.destroy", entityId: "tree-1" });
  assert.equal(result.accepted, true);
  assert.equal(result.events[0].type, "world/entity.destroyed");
  assert.equal(getEntity(engine.getState(), "tree-1"), null);
  assert.deepEqual(engine.getState().resources, { metal: 3 });
});

test("world data participates in snapshots, restores and deterministic replay", () => {
  const first = makeWorld();
  first.dispatch({ type: "world/entity.create", entityType: "raider", components: { health: 7 } });
  const checkpoint = first.snapshot();
  first.dispatch({ type: "world/component.set", entityId: "entity-000001", component: "health", value: 0 });
  const expected = first.snapshot();

  const second = makeWorld();
  second.restore(checkpoint);
  second.dispatch({ type: "world/component.set", entityId: "entity-000001", component: "health", value: 0 });
  assert.deepEqual(second.snapshot(), expected);
});

test("invalid or unsafe world commands fail without changing engine state", () => {
  const engine = makeWorld();
  const before = engine.snapshot();
  assert.throws(() => engine.dispatch({ type: "world/entity.create", entityType: "worker", components: {
    "__proto__": { polluted: true }
  } }), /must be a non-empty/);
  assert.deepEqual(engine.snapshot(), before);
  assert.equal(engine.dispatch({ type: "world/entity.destroy", entityId: "missing" }).accepted, false);
  assert.deepEqual(engine.snapshot(), before);
});
