export const ENGINE_VERSION = "0.1.0-alpha.0";
export const SNAPSHOT_FORMAT = "pulse-engine-snapshot";
export const SNAPSHOT_VERSION = 1;

function cloneValue(value) {
  return structuredClone(value);
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) {
    return value;
  }

  Object.freeze(value);
  for (const child of Object.values(value)) {
    deepFreeze(child);
  }

  return value;
}

function assertBranchId(branchId) {
  if (typeof branchId !== "string" || branchId.trim() === "") {
    throw new TypeError("Snapshot branch ids must be non-empty strings.");
  }
}

export function createSnapshotRecord({
  actionSequence,
  branch,
  events,
  label,
  randomState,
  revision,
  state,
  tick = 0,
  schedules = { version: 1, sequence: 0, jobs: [] }
}) {
  assertBranchId(branch?.id);

  return deepFreeze(cloneValue({
    format: SNAPSHOT_FORMAT,
    version: SNAPSHOT_VERSION,
    engineVersion: ENGINE_VERSION,
    label: label ?? null,
    branch: {
      id: branch.id,
      parentId: branch.parentId ?? null
    },
    revision,
    actionSequence,
    tick,
    schedules,
    state,
    randomState,
    events
  }));
}

export function validateSnapshotRecord(input) {
  const snapshot = copyData(input);

  if (!snapshot || snapshot.format !== SNAPSHOT_FORMAT) {
    throw new TypeError("Invalid Pulse Engine snapshot format.");
  }

  if (snapshot.version !== SNAPSHOT_VERSION) {
    throw new RangeError(`Unsupported snapshot version: ${snapshot.version}.`);
  }

  if (snapshot.engineVersion !== ENGINE_VERSION) {
    throw new RangeError(
      `Snapshot engine version ${snapshot.engineVersion} is incompatible with ${ENGINE_VERSION}.`
    );
  }

  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 0) {
    throw new TypeError("Snapshot revision must be a non-negative integer.");
  }

  if (!Number.isSafeInteger(snapshot.actionSequence) || snapshot.actionSequence < 0) {
    throw new TypeError("Snapshot actionSequence must be a non-negative integer.");
  }

  assertBranchId(snapshot.branch?.id);
  if (snapshot.branch.parentId !== null) assertBranchId(snapshot.branch.parentId);
  snapshot.tick ??= 0;
  snapshot.schedules ??= { version: 1, sequence: 0, jobs: [] };
  assertCounter(snapshot.tick, "Snapshot tick");
  return snapshot;
}

export function forkSnapshotRecord(snapshot, branchId) {
  assertBranchId(branchId);
  const source = validateSnapshotRecord(snapshot);

  return deepFreeze({
    ...source,
    label: null,
    branch: {
      id: branchId.trim(),
      parentId: source.branch.id
    }
  });
}
import { assertCounter, copyData } from "./data.js";
