import { copyData } from "./data.js";

export const SAVE_FORMAT = "pulse-engine-save";
export const SAVE_VERSION = 1;

export function createMigrationRegistry(migrations = []) {
  const steps = new Map();
  for (const step of migrations) {
    if (!Number.isSafeInteger(step.from) || step.from < 0 || step.to !== step.from + 1 || typeof step.migrate !== "function" || steps.has(step.from)) throw new TypeError("Migrations require unique consecutive versions and a function.");
    steps.set(step.from, step);
  }
  function migrate(input, targetVersion) {
    let value = copyData(input);
    if (!Number.isSafeInteger(value?.version) || value.version < 0) throw new TypeError("Save version must be a non-negative integer.");
    if (!Number.isSafeInteger(targetVersion) || targetVersion < value.version) throw new RangeError("Unsupported future save version.");
    while (value.version < targetVersion) {
      const step = steps.get(value.version);
      if (!step) throw new RangeError(`Missing save migration from version ${value.version}.`);
      value = copyData(step.migrate(copyData(value)));
      if (value.version !== step.to) throw new TypeError("Migration did not produce its declared version.");
    }
    return value;
  }
  return Object.freeze({ migrate });
}

const defaultMigrations = [{ from: 0, to: 1, migrate: legacy => ({ format: SAVE_FORMAT, version: 1, snapshot: legacy.checkpoint }) }];

export function serializeSnapshot(snapshot) {
  return JSON.stringify(copyData({ format: SAVE_FORMAT, version: SAVE_VERSION, snapshot }));
}

export function deserializeSave(input, { migrations = defaultMigrations } = {}) {
  const value = typeof input === "string" ? JSON.parse(input) : copyData(input);
  if (!value || value.format !== SAVE_FORMAT) throw new TypeError("Invalid Pulse Engine save format.");
  const migrated = createMigrationRegistry(migrations).migrate(value, SAVE_VERSION);
  if (!migrated.snapshot) throw new TypeError("Save requires a snapshot.");
  return copyData(migrated.snapshot);
}
