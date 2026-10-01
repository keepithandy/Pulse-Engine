import { copyData } from "./data.js";
import { createEngine } from "./engine.js";

export const SCENARIO_VERSION = 1;

export function validateScenario(input, { validateGameData } = {}) {
  const errors = [];
  let value;
  try { value = copyData(input); } catch (error) { return { valid: false, errors: [error.message], value: null }; }
  if (!value || typeof value !== "object" || Array.isArray(value)) return { valid: false, errors: ["$: expected scenario object."], value: null };
  if (value.version !== SCENARIO_VERSION) errors.push("$.version: unsupported scenario version; expected 1.");
  if (typeof value.seed !== "string" && !(typeof value.seed === "number" && Number.isFinite(value.seed))) errors.push("$.seed: expected string or finite number.");
  if (!Array.isArray(value.systems) || value.systems.some(id => typeof id !== "string" || !id.trim()) || new Set(value.systems).size !== value.systems.length) errors.push("$.systems: expected unique non-empty system ids.");
  const entityIds = new Set();
  if (!Array.isArray(value.entities)) errors.push("$.entities: expected array.");
  else value.entities.forEach((entity, index) => {
    const path = `$.entities[${index}]`;
    if (!entity || typeof entity.id !== "string" || !entity.id.trim() || entityIds.has(entity.id)) errors.push(`${path}.id: expected unique non-empty id.`);
    else entityIds.add(entity.id);
    if (!entity || typeof entity.type !== "string" || !entity.type.trim()) errors.push(`${path}.type: expected non-empty type.`);
  });
  if (!value.resources || typeof value.resources !== "object" || Array.isArray(value.resources)) errors.push("$.resources: expected resource object.");
  else for (const [key, quantity] of Object.entries(value.resources)) {
    if (!Number.isFinite(quantity)) errors.push(`$.resources.${key}: expected finite number.`);
  }
  if (!Array.isArray(value.relationships)) errors.push("$.relationships: expected array.");
  else value.relationships.forEach((relation, index) => {
    const path = `$.relationships[${index}]`;
    if (!relation || !entityIds.has(relation.from)) errors.push(`${path}.from: unknown entity id.`);
    if (!relation || !entityIds.has(relation.to)) errors.push(`${path}.to: unknown entity id.`);
    if (!relation || typeof relation.type !== "string" || !relation.type.trim()) errors.push(`${path}.type: expected non-empty relationship type.`);
  });
  if (value.gameData !== undefined && (!value.gameData || typeof value.gameData !== "object" || Array.isArray(value.gameData))) errors.push("$.gameData: expected extension object.");
  if (validateGameData) {
    if (typeof validateGameData !== "function") throw new TypeError("Game-data validator must be a function.");
    const extra = validateGameData(copyData(value.gameData ?? {}));
    if (!Array.isArray(extra) || extra.some(error => typeof error !== "string")) throw new TypeError("Game-data validator must return an array of errors.");
    errors.push(...extra.map(error => `$.gameData: ${error}`));
  }
  return { valid: errors.length === 0, errors, value: errors.length ? null : value };
}

export function createEngineFromScenario(input, { systemRegistry = {}, validateGameData, seed, ...options } = {}) {
  const result = validateScenario(input, { validateGameData });
  if (!result.valid) throw new TypeError(result.errors.join("\n"));
  const scenario = result.value;
  const systems = scenario.systems.map(id => {
    if (!Object.hasOwn(systemRegistry, id) || typeof systemRegistry[id] !== "function") throw new TypeError(`$.systems: unknown system ${id}.`);
    const plugin = systemRegistry[id](copyData(scenario));
    if (plugin?.id !== id) throw new TypeError(`System factory ${id} returned a different id.`);
    return plugin;
  });
  return createEngine({ ...options, systems, seed: seed ?? scenario.seed, initialState: {
    entities: scenario.entities, resources: scenario.resources, relationships: scenario.relationships, gameData: scenario.gameData ?? {}
  } });
}

// Reusable example: deterministic resource changes, with no game or presentation code.
export const exampleSystemRegistry = Object.freeze({
  "resource-flow": () => ({ id: "resource-flow", version: "1.0.0", onAction({ action, state, emit }) {
    if (action.type !== "@pulse/tick") return;
    const resources = { ...state.resources };
    for (const [id, amount] of Object.entries(state.gameData.production ?? {})) {
      if (!Number.isFinite(amount) || !Object.hasOwn(resources, id)) throw new TypeError(`Invalid resource production for ${id}.`);
      resources[id] += amount;
      emit({ type: "resource/changed", payload: { id, amount, total: resources[id] } });
    }
    return { state: { ...state, resources } };
  } })
});
