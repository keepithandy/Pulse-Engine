import { copyData } from "./data.js";

const ACTIONS = new Set([
  "world/entity.create",
  "world/entity.destroy",
  "world/component.set",
  "world/component.remove"
]);
const RESERVED_KEYS = new Set(["__proto__", "prototype", "constructor"]);

function assertKey(value, label) {
  if (typeof value !== "string" || !value.trim() || RESERVED_KEYS.has(value)) {
    throw new TypeError(`${label} must be a non-empty, non-reserved string.`);
  }
  return value.trim();
}

function assertRecord(value, label) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  copyData(value);
  return value;
}

function worldFrom(state) {
  const world = state.world ?? { nextEntity: 1, order: [], entities: {} };
  if (!world || typeof world !== "object" || Array.isArray(world) ||
      !Number.isSafeInteger(world.nextEntity) || world.nextEntity < 1 ||
      !Array.isArray(world.order) || !world.entities || typeof world.entities !== "object" ||
      Array.isArray(world.entities)) {
    throw new TypeError("Invalid Pulse Engine world state.");
  }
  return world;
}

function readEntityRecord(world, id) {
  const record = world.entities[id];
  return record ? copyData(record) : null;
}

/**
 * Generic deterministic entity/component storage for simulation systems.
 * State is kept under state.world and is therefore included in engine snapshots.
 */
export function createWorldPlugin({ id = "pulse-world", idPrefix = "entity" } = {}) {
  assertKey(id, "World plug-in id");
  assertKey(idPrefix, "Entity id prefix");
  return Object.freeze({
    id,
    version: "1.0.0",
    onAction({ action, state }) {
      if (!ACTIONS.has(action.type)) return;
      const nextState = copyData(state);
      const current = worldFrom(nextState);
      const world = copyData(current);
      nextState.world = world;
      const events = [];

      if (action.type === "world/entity.create") {
        const type = assertKey(action.entityType, "Entity type");
        let entityId;
        if (action.entityId !== undefined) {
          entityId = assertKey(action.entityId, "Entity id");
          if (Object.hasOwn(world.entities, entityId)) {
            return { accepted: false, reason: `Entity ${entityId} already exists.` };
          }
        } else {
          do {
            entityId = `${idPrefix}-${String(world.nextEntity).padStart(6, "0")}`;
            world.nextEntity += 1;
          } while (Object.hasOwn(world.entities, entityId));
        }
        const components = action.components ?? {};
        assertRecord(components, "Components");
        for (const key of Object.keys(components)) assertKey(key, "Component name");
        world.entities[entityId] = { type, components: copyData(components) };
        world.order.push(entityId);
        events.push({ type: "world/entity.created", payload: { entityId, entityType: type } });
        return { state: nextState, events };
      }

      const entityId = assertKey(action.entityId, "Entity id");
      const entity = world.entities[entityId];
      if (!entity) return { accepted: false, reason: `Unknown entity ${entityId}.` };

      if (action.type === "world/entity.destroy") {
        delete world.entities[entityId];
        world.order = world.order.filter(id => id !== entityId);
        events.push({ type: "world/entity.destroyed", payload: { entityId, entityType: entity.type } });
      } else {
        const component = assertKey(action.component, "Component name");
        if (action.type === "world/component.set") {
          if (!Object.hasOwn(action, "value")) throw new TypeError("Component set actions require a value.");
          entity.components[component] = copyData(action.value);
          events.push({ type: "world/component.set", payload: { entityId, component } });
        } else {
          if (!Object.hasOwn(entity.components, component)) {
            return { accepted: false, reason: `Entity ${entityId} has no ${component} component.` };
          }
          delete entity.components[component];
          events.push({ type: "world/component.removed", payload: { entityId, component } });
        }
      }
      return { state: nextState, events };
    }
  });
}

/** Return one detached entity record, or null when the id is absent. */
export function getEntity(state, entityId) {
  assertRecord(state, "World state");
  const world = worldFrom(state);
  return readEntityRecord(world, assertKey(entityId, "Entity id"))
    ? { id: entityId, ...readEntityRecord(world, entityId) }
    : null;
}

/**
 * Query entities in deterministic creation order.
 * Options: { type, with: ["position"], without: ["dead"] }.
 */
export function queryEntities(state, { type, with: required = [], without = [] } = {}) {
  assertRecord(state, "World state");
  const world = worldFrom(state);
  if (type !== undefined) type = assertKey(type, "Entity type");
  if (!Array.isArray(required) || !Array.isArray(without)) {
    throw new TypeError("World query component filters must be arrays.");
  }
  required = required.map(name => assertKey(name, "Component name"));
  without = without.map(name => assertKey(name, "Component name"));
  return world.order.flatMap(id => {
    const entity = world.entities[id];
    if (!entity || (type !== undefined && entity.type !== type)) return [];
    const components = entity.components ?? {};
    if (!required.every(name => Object.hasOwn(components, name)) ||
        without.some(name => Object.hasOwn(components, name))) return [];
    return [{ id, type: entity.type, components: copyData(components) }];
  });
}
