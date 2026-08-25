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

function assertEvent(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) {
    throw new TypeError("Pulse Engine events must be objects.");
  }

  if (typeof event.type !== "string" || event.type.trim() === "") {
    throw new TypeError("Pulse Engine events require a non-empty type.");
  }
}

export function createEventJournal({ historyLimit = 1000 } = {}) {
  if (!Number.isInteger(historyLimit) || historyLimit < 1) {
    throw new RangeError("Event historyLimit must be a positive integer.");
  }

  let sequence = 0;
  let history = [];
  const subscribers = new Set();

  function publish(input, defaults = {}) {
    assertEvent(input);

    const event = deepFreeze({
      ...cloneValue(input),
      id: input.id ?? `event-${String(++sequence).padStart(6, "0")}`,
      type: input.type.trim(),
      tick: input.tick ?? defaults.tick ?? 0,
      source: input.source ?? defaults.source ?? "engine",
      payload: cloneValue(input.payload ?? {}),
      metadata: cloneValue(input.metadata ?? {})
    });

    history.push(event);
    if (history.length > historyLimit) {
      history = history.slice(-historyLimit);
    }

    const listenerErrors = [];
    for (const subscription of subscribers) {
      if (subscription.type && subscription.type !== event.type) {
        continue;
      }

      try {
        subscription.listener(deepFreeze(cloneValue(event)));
      } catch (error) {
        listenerErrors.push(error);
      }
    }

    return { event: deepFreeze(cloneValue(event)), listenerErrors };
  }

  function subscribe(listener, { type } = {}) {
    if (typeof listener !== "function") {
      throw new TypeError("Event subscribers must be functions.");
    }

    if (type !== undefined && (typeof type !== "string" || type.trim() === "")) {
      throw new TypeError("Event subscription type must be a non-empty string.");
    }

    const subscription = { listener, type: type?.trim() };
    subscribers.add(subscription);
    return () => subscribers.delete(subscription);
  }

  function read({ type, limit = historyLimit } = {}) {
    if (!Number.isInteger(limit) || limit < 0) {
      throw new RangeError("Event read limit must be a non-negative integer.");
    }

    const selected = type
      ? history.filter((event) => event.type === type)
      : history;

    return selected
      .slice(-limit)
      .map((event) => deepFreeze(cloneValue(event)));
  }

  return Object.freeze({ publish, read, subscribe });
}
