const ALGORITHM = "mulberry32-v1";

function hashString(value) {
  let hash = 0x811c9dc5;

  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }

  return hash >>> 0;
}

function normalizeSeed(seed) {
  if (typeof seed === "number" && Number.isFinite(seed)) {
    return Math.trunc(seed) >>> 0;
  }

  if (typeof seed === "string") {
    return hashString(seed);
  }

  throw new TypeError("Pulse Engine seeds must be finite numbers or strings.");
}

function assertFiniteRange(min, max) {
  if (!Number.isFinite(min) || !Number.isFinite(max) || max < min) {
    throw new RangeError("Random ranges require finite values with max >= min.");
  }
}

export function createSeededRandom(seed = 0) {
  const normalizedSeed = normalizeSeed(seed);
  let state = normalizedSeed;

  function next() {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  function float(min = 0, max = 1) {
    assertFiniteRange(min, max);
    return min + next() * (max - min);
  }

  function integer(min, max) {
    if (!Number.isInteger(min) || !Number.isInteger(max)) {
      throw new RangeError("Random integer ranges require integer boundaries.");
    }

    assertFiniteRange(min, max);
    return Math.floor(float(min, max + 1));
  }

  function pick(values) {
    if (!Array.isArray(values) || values.length === 0) {
      throw new RangeError("Random pick requires a non-empty array.");
    }

    return values[integer(0, values.length - 1)];
  }

  function getState() {
    return Object.freeze({
      algorithm: ALGORITHM,
      seed: normalizedSeed,
      state
    });
  }

  function setState(snapshot) {
    if (
      !snapshot ||
      snapshot.algorithm !== ALGORITHM ||
      !Number.isInteger(snapshot.state)
    ) {
      throw new TypeError("Invalid seeded-random state.");
    }

    state = snapshot.state >>> 0;
  }

  return Object.freeze({ float, getState, integer, next, pick, setState });
}
