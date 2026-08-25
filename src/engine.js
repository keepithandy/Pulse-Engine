import { createEventJournal } from "./events.js";
import { createSeededRandom } from "./random.js";
import {
  createSnapshotRecord,
  forkSnapshotRecord,
  validateSnapshotRecord
} from "./snapshots.js";

function cloneValue(value) {
  return structuredClone(value);
}

function assertAction(action) {
  if (!action || typeof action !== "object" || Array.isArray(action)) {
    throw new TypeError("Pulse Engine actions must be objects.");
  }

  if (typeof action.type !== "string" || action.type.trim() === "") {
    throw new TypeError("Pulse Engine actions require a non-empty type.");
  }
}

function normalizeSystem(system, index) {
  if (!system || typeof system !== "object") {
    throw new TypeError(`System at index ${index} must be an object.`);
  }

  if (typeof system.id !== "string" || system.id.trim() === "") {
    throw new TypeError(`System at index ${index} requires a non-empty id.`);
  }

  if (typeof system.onAction !== "function") {
    throw new TypeError(`System "${system.id}" requires an onAction function.`);
  }

  return system;
}

export function createEngine({
  initialState = {},
  systems = [],
  eventHistoryLimit = 1000,
  seed = 0,
  branchId = "main"
} = {}) {
  let state = cloneValue(initialState);
  let revision = 0;
  let actionSequence = 0;
  const listeners = new Set();
  const normalizedSystems = systems.map(normalizeSystem);
  const events = createEventJournal({ historyLimit: eventHistoryLimit });
  const random = createSeededRandom(seed);
  const randomApi = Object.freeze({
    float: random.float,
    integer: random.integer,
    next: random.next,
    pick: random.pick
  });
  let branch = { id: branchId, parentId: null };

  function getState() {
    return cloneValue(state);
  }

  function subscribe(listener) {
    if (typeof listener !== "function") {
      throw new TypeError("Engine subscribers must be functions.");
    }

    listeners.add(listener);
    return () => listeners.delete(listener);
  }

  function snapshot({ label } = {}) {
    return createSnapshotRecord({
      actionSequence,
      branch,
      events: events.exportState(),
      label,
      randomState: random.getState(),
      revision,
      state: getState()
    });
  }

  function restore(input) {
    const next = validateSnapshotRecord(input);
    const previous = snapshot();

    try {
      random.setState(next.randomState);
      events.restoreState(next.events);
      state = cloneValue(next.state);
      revision = next.revision;
      actionSequence = next.actionSequence;
      branch = cloneValue(next.branch);
    } catch (error) {
      random.setState(previous.randomState);
      events.restoreState(previous.events);
      state = cloneValue(previous.state);
      revision = previous.revision;
      actionSequence = previous.actionSequence;
      branch = cloneValue(previous.branch);
      throw error;
    }

    return {
      restored: true,
      branch: cloneValue(branch),
      revision,
      state: getState()
    };
  }

  function fork(nextBranchId) {
    return forkSnapshotRecord(snapshot(), nextBranchId);
  }

  function dispatch(input) {
    assertAction(input);

    const action = cloneValue(input);
    action.id ??= `action-${String(++actionSequence).padStart(6, "0")}`;
    const previousState = getState();
    let candidateState = previousState;
    const pendingEvents = [];
    const previousRandomState = random.getState();

    try {
      for (const system of normalizedSystems) {
        const response = system.onAction({
          action: cloneValue(action),
          random: randomApi,
          state: cloneValue(candidateState),
          emit(event) {
            pendingEvents.push({ ...cloneValue(event), source: event.source ?? system.id });
          }
        });

        if (response?.accepted === false) {
          random.setState(previousRandomState);
          return {
            accepted: false,
            action,
            reason: response.reason ?? `Rejected by ${system.id}`,
            revision,
            state: getState()
          };
        }

        if (response && Object.hasOwn(response, "state")) {
          candidateState = cloneValue(response.state);
        }

        if (Array.isArray(response?.events)) {
          for (const event of response.events) {
            pendingEvents.push({ ...cloneValue(event), source: event.source ?? system.id });
          }
        }
      }
    } catch (error) {
      random.setState(previousRandomState);
      throw error;
    }

    state = cloneValue(candidateState);
    revision += 1;

    const emittedEvents = [];
    const eventListenerErrors = [];
    for (const event of pendingEvents) {
      const publication = events.publish(event, { tick: revision });
      emittedEvents.push(publication.event);
      eventListenerErrors.push(...publication.listenerErrors);
    }

    const result = {
      accepted: true,
      action,
      revision,
      state: getState(),
      events: emittedEvents,
      listenerErrors: [],
      eventListenerErrors
    };

    for (const listener of listeners) {
      try {
        listener({
          action: cloneValue(action),
          previousState: cloneValue(previousState),
          state: getState(),
          revision
        });
      } catch (error) {
        result.listenerErrors.push(error);
      }
    }

    return result;
  }

  return Object.freeze({
    dispatch,
    fork,
    getEvents: events.read,
    getRandomState: random.getState,
    getState,
    restore,
    snapshot,
    subscribe,
    subscribeToEvents: events.subscribe
  });
}
