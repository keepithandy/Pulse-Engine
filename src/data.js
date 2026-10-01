// Engine data is deliberately JSON-safe; runtime hooks stay in the plug-in registry.
export function assertData(value, path = "$", ancestors = new Set()) {
  if (value === null || typeof value === "string" || typeof value === "boolean") return;
  if (typeof value === "number" && Number.isFinite(value)) return;
  if (!value || typeof value !== "object") throw new TypeError(`${path}: expected JSON-safe data.`);
  if (ancestors.has(value)) throw new TypeError(`${path}: cyclic data is unsupported.`);
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) {
    throw new TypeError(`${path}: runtime objects are unsupported.`);
  }
  ancestors.add(value);
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i += 1) assertData(value[i], `${path}[${i}]`, ancestors);
  } else {
    for (const key of Object.keys(value)) {
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !Object.hasOwn(descriptor, "value")) throw new TypeError(`${path}.${key}: accessors are unsupported.`);
      assertData(descriptor.value, `${path}.${key}`, ancestors);
    }
  }
  ancestors.delete(value);
}

export function copyData(value) {
  assertData(value);
  return structuredClone(value);
}

export function freezeData(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) freezeData(child);
  return value;
}

export function assertCounter(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) throw new TypeError(`${name} must be a non-negative safe integer.`);
}
