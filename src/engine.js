import { createEventJournal } from "./events.js";
import { createPluginRegistry } from "./plugins.js";
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

export function createEngine({
  initialState = {},
  systems = [],
  plugins = [],
  eventHistoryLimit = 1000,
  seed = 0,
  branchId = "main"
} = {}) {
  let state = cloneValue(initialState);
  let revision = 0;
  let actionSequence = 0;
  const listeners = new Set();
  const pluginRegistry = createPluginRegistry([...systems, ...plugins]);
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

  function pluginContext(pluginId) {
    return Object.freeze({
      pluginId,
      getEvents: events.read,
      getState,
      random: randomApi
    });
  }

  function registerPlugin(plugin) {
    const metadata = pluginRegistry.register(plugin);
    const registered = pluginRegistry.ordered().find((item) => item.id === metadata.id);

    try {
      registered.setup?.(pluginContext(registered.id));
    } catch (error) {
      pluginRegistry.remove(registered.id);
      throw error;
    }

    return metadata;
  }

  function unregisterPlugin(pluginId) {
    const plugin = pluginRegistry.remove(pluginId);
    if (!plugin) return false;
    plugin.dispose?.(pluginContext(plugin.id));
    return true;
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
      for (const plugin of pluginRegistry.ordered()) {
        if (!plugin.onAction) continue;

        const response = plugin.onAction({
          action: cloneValue(action),
          random: randomApi,
          state: cloneValue(candidateState),
          emit(event) {
            pendingEvents.push({ ...cloneValue(event), source: event.source ?? plugin.id });
          }
        });

        if (response?.accepted === false) {
          random.setState(previousRandomState);
          return {
            accepted: false,
            action,
            reason: response.reason ?? `Rejected by ${plugin.id}`,
            revision,
            state: getState()
          };
        }

        if (response && Object.hasOwn(response, "state")) {
          candidateState = cloneValue(response.state);
        }

        if (Array.isArray(response?.events)) {
          for (const event of response.events) {
            pendingEvents.push({ ...cloneValue(event), source: event.source ?? plugin.id });
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
    const pluginErrors = [];
    for (const event of pendingEvents) {
      const publication = events.publish(event, { tick: revision });
      emittedEvents.push(publication.event);
      eventListenerErrors.push(...publication.listenerErrors);

      for (const plugin of pluginRegistry.ordered()) {
        if (!plugin.onEvent) continue;
        try {
          plugin.onEvent({
            event: cloneValue(publication.event),
            random: randomApi,
            state: getState()
          });
        } catch (error) {
          pluginErrors.push(error);
        }
      }
    }

    const result = {
      accepted: true,
      action,
      revision,
      state: getState(),
      events: emittedEvents,
      listenerErrors: [],
      eventListenerErrors,
      pluginErrors
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

  const engine = Object.freeze({
    dispatch,
    fork,
    getEvents: events.read,
    getPlugins: pluginRegistry.list,
    getRandomState: random.getState,
    getState,
    registerPlugin,
    restore,
    snapshot,
    subscribe,
    subscribeToEvents: events.subscribe,
    unregisterPlugin
  });

  for (const plugin of pluginRegistry.ordered()) {
    plugin.setup?.(pluginContext(plugin.id));
  }

  return engine;
}
