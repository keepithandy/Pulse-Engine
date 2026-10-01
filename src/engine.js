import { assertCounter, copyData, freezeData } from "./data.js";
import { createEventJournal } from "./events.js";
import { createPluginRegistry } from "./plugins.js";
import { createSeededRandom } from "./random.js";
import { createRuleEvaluator } from "./rules.js";
import { createTickScheduler } from "./scheduler.js";
import { deserializeSave, serializeSnapshot } from "./persistence.js";
import { createSnapshotRecord, forkSnapshotRecord, validateSnapshotRecord } from "./snapshots.js";

function assertAction(action) {
  copyData(action);
  if (!action || typeof action !== "object" || Array.isArray(action) || typeof action.type !== "string" || !action.type.trim()) throw new TypeError("Pulse Engine actions require a non-empty type.");
  if (action.id !== undefined && (typeof action.id !== "string" || !action.id.trim())) throw new TypeError("Action ids must be non-empty strings.");
}

export function createEngine({ initialState = {}, systems = [], plugins = [], rules = [],
  eventHistoryLimit = 1000, seed = 0, branchId = "main", scheduleCapacity = 10000,
  diagnostics = true, traceLimit = 1000, redact = value => value } = {}) {
  if (!Number.isSafeInteger(traceLimit) || traceLimit < 1 || typeof redact !== "function") throw new TypeError("Invalid diagnostics configuration.");
  let state = copyData(initialState);
  let revision = 0;
  let actionSequence = 0;
  let tick = 0;
  let paused = false;
  let busy = false;
  let disposed = false;
  const listeners = new Set();
  const pluginRegistry = createPluginRegistry([...systems, ...plugins]);
  const events = createEventJournal({ historyLimit: eventHistoryLimit });
  const scheduler = createTickScheduler({ capacity: scheduleCapacity });
  const evaluator = createRuleEvaluator(rules);
  const random = createSeededRandom(seed);
  const randomApi = Object.freeze({ float: random.float, integer: random.integer, next: random.next, pick: random.pick });
  let branch = { id: branchId, parentId: null };
  let explanations = [];

  function assertMutable() {
    if (disposed) throw new Error("Engine has been disposed.");
    if (busy) throw new Error("Reentrant engine mutation is unsupported.");
  }
  function getState() { return copyData(state); }
  function getTick() { return tick; }
  function subscribe(listener) {
    if (typeof listener !== "function") throw new TypeError("Engine subscribers must be functions.");
    listeners.add(listener);
    return () => listeners.delete(listener);
  }
  function pluginContext(pluginId) {
    return Object.freeze({ pluginId, getEvents: events.read, getState, getTick, getRandomState: random.getState });
  }
  function invoke(hook, context) {
    const response = hook(context);
    if (response && typeof response.then === "function") throw new TypeError("Engine hooks must be synchronous.");
    return response;
  }
  function registerPlugin(plugin) {
    assertMutable();
    const metadata = pluginRegistry.register(plugin);
    const registered = pluginRegistry.ordered().find(item => item.id === metadata.id);
    busy = true;
    try { if (registered.setup) invoke(registered.setup, pluginContext(registered.id)); }
    catch (error) {
      try { if (registered.dispose) invoke(registered.dispose, pluginContext(registered.id)); } catch { /* preserve setup error */ }
      pluginRegistry.remove(registered.id);
      throw error;
    }
    finally { busy = false; }
    return metadata;
  }
  function unregisterPlugin(pluginId) {
    assertMutable();
    const plugin = pluginRegistry.remove(pluginId);
    if (!plugin) return false;
    busy = true;
    try { if (plugin.dispose) invoke(plugin.dispose, pluginContext(plugin.id)); }
    finally { busy = false; }
    return true;
  }
  function snapshot({ label } = {}) {
    return createSnapshotRecord({ actionSequence, branch, events: events.exportState(), label,
      randomState: random.getState(), revision, state: getState(), tick, schedules: scheduler.exportState() });
  }
  function installSnapshot(input) {
    const next = validateSnapshotRecord(input);
    // Validate every component in temporary instances before touching live state.
    const trialRandom = createSeededRandom(0);
    trialRandom.setState(next.randomState);
    const trialEvents = createEventJournal({ historyLimit: eventHistoryLimit });
    trialEvents.restoreState(next.events);
    const trialScheduler = createTickScheduler({ capacity: scheduleCapacity });
    trialScheduler.restoreState(next.schedules, next.tick);
    state = copyData(next.state);
    random.setState(next.randomState);
    events.restoreState(next.events);
    scheduler.restoreState(next.schedules, next.tick);
    revision = next.revision;
    actionSequence = next.actionSequence;
    tick = next.tick;
    branch = copyData(next.branch);
  }
  function restore(input) {
    assertMutable();
    installSnapshot(input);
    explanations = [];
    return { restored: true, branch: copyData(branch), revision, state: getState() };
  }
  function remember(action, accepted, reason, traces) {
    if (!diagnostics) return;
    explanations.push(copyData({ actionId: action.id, tick, revision, accepted, reason: String(reason ?? "Accepted."), traces }));
    explanations = explanations.slice(-traceLimit);
  }
  function execute(input, { advancing = false } = {}) {
    assertAction(input);
    const before = snapshot();
    const action = copyData(input);
    assertCounter(actionSequence + 1, "Action sequence");
    assertCounter(revision + 1, "Revision");
    if (advancing) assertCounter(tick + 1, "Tick");
    actionSequence += 1;
    action.id ??= `action-${String(actionSequence).padStart(6, "0")}`;
    const previousState = getState();
    const targetTick = advancing ? tick + 1 : tick;
    let candidateState = getState();
    const pendingEvents = [];
    let traces = [];
    const reject = reason => {
      installSnapshot(before);
      remember(action, false, reason, traces);
      return { accepted: false, action, reason, revision, tick, state: getState() };
    };
    function applyResponse(response, source) {
      if (response?.accepted === false) return response.reason ?? `Rejected by ${source}`;
      if (response && Object.hasOwn(response, "state")) candidateState = copyData(response.state);
      if (response?.events !== undefined && !Array.isArray(response.events)) throw new TypeError("Hook events must be an array.");
      for (const event of response?.events ?? []) pendingEvents.push({ ...copyData(event), source: event.source ?? source });
      return null;
    }
    try {
      for (const plugin of pluginRegistry.ordered()) {
        const context = () => ({ action: freezeData(copyData(action)), random: randomApi, state: copyData(candidateState), tick: targetTick,
          emit(event) { pendingEvents.push({ ...copyData(event), source: event.source ?? plugin.id }); } });
        if (advancing && plugin.beforeTick) {
          const reason = applyResponse(invoke(plugin.beforeTick, context()), plugin.id);
          if (reason !== null) return reject(reason);
        }
        if (plugin.onAction) {
          const reason = applyResponse(invoke(plugin.onAction, context()), plugin.id);
          if (reason !== null) return reject(reason);
        }
      }
      const decision = evaluator.evaluate({ action, state: candidateState, random: randomApi, tick: targetTick, collectTraces: diagnostics });
      traces = decision.traces;
      if (!decision.accepted) return reject(decision.reason);
      candidateState = copyData(decision.state);
      pendingEvents.push(...decision.events);
      if (advancing) pendingEvents.push({ type: "engine/tick", source: "engine", payload: { tick: targetTick } });
      const prepared = events.prepare(pendingEvents, { tick: targetTick });
      state = candidateState;
      revision += 1;
      tick = targetTick;
      const result = { accepted: true, action, revision, tick, state: getState(), events: [], listenerErrors: [], eventListenerErrors: [], pluginErrors: [] };
      for (const event of prepared) {
        const publication = events.publish(event);
        result.events.push(publication.event);
        result.eventListenerErrors.push(...publication.listenerErrors);
        for (const plugin of pluginRegistry.ordered()) {
          if (!plugin.onEvent) continue;
          try { invoke(plugin.onEvent, { ...pluginContext(plugin.id), event: publication.event, state: getState(), tick }); }
          catch (error) { result.pluginErrors.push(error); }
        }
      }
      if (advancing) for (const plugin of pluginRegistry.ordered()) {
        if (!plugin.afterTick) continue;
        try { invoke(plugin.afterTick, { ...pluginContext(plugin.id), state: getState(), tick }); }
        catch (error) { result.pluginErrors.push(error); }
      }
      remember(action, true, null, traces);
      for (const listener of listeners) {
        try { listener({ action: copyData(action), previousState: copyData(previousState), state: getState(), revision, tick }); }
        catch (error) { result.listenerErrors.push(error); }
      }
      return result;
    } catch (error) {
      installSnapshot(before);
      throw error;
    }
  }
  function dispatch(input) {
    assertMutable(); busy = true;
    try { return execute(input); } finally { busy = false; }
  }
  function step() {
    assertMutable(); busy = true;
    try {
      const result = execute({ type: "@pulse/tick" }, { advancing: true });
      const scheduled = [];
      if (result.accepted) for (const job of scheduler.due(tick)) {
        scheduler.consume(job.id);
        try { scheduled.push({ scheduleId: job.id, ...execute(job.action) }); }
        catch (error) { scheduled.push({ scheduleId: job.id, accepted: false, reason: String(error.message) }); }
      }
      return { advanced: result.accepted, tick, result, scheduled };
    } finally { busy = false; }
  }
  function advance(count = 1) {
    assertMutable();
    if (!Number.isSafeInteger(count) || count < 0) throw new RangeError("Tick count must be a non-negative integer.");
    const results = [];
    for (let i = 0; i < count && !paused; i += 1) {
      const result = step(); results.push(result);
      if (!result.advanced) break;
    }
    return results;
  }
  function schedule(action, options) { assertMutable(); return scheduler.schedule(action, options, tick); }
  function cancelSchedule(id) { assertMutable(); return scheduler.cancel(id); }
  function pause() { assertMutable(); paused = true; }
  function resume() { assertMutable(); paused = false; }
  function getExplanation(actionId) {
    if (!diagnostics) return null;
    return copyData(explanations.findLast(item => item.actionId === actionId) ?? null);
  }
  function inspect() {
    if (!diagnostics) return null;
    return freezeData(copyData(redact(copyData({ state: getState(), tick, revision, branch, paused, schedules: scheduler.list(), plugins: pluginRegistry.list(), events: events.read(), traces: explanations }))));
  }
  function dispose() {
    assertMutable(); busy = true;
    const errors = [];
    try { for (const plugin of [...pluginRegistry.ordered()].reverse()) {
      try { if (plugin.dispose) invoke(plugin.dispose, pluginContext(plugin.id)); } catch (error) { errors.push(error); }
      pluginRegistry.remove(plugin.id);
    } } finally { disposed = true; busy = false; listeners.clear(); }
    return errors;
  }
  snapshot(); busy = true;
  const initialized = [];
  try { for (const plugin of pluginRegistry.ordered()) {
    initialized.push(plugin);
    if (plugin.setup) invoke(plugin.setup, pluginContext(plugin.id));
  } } catch (error) {
    for (const plugin of initialized.reverse()) { try { plugin.dispose?.(pluginContext(plugin.id)); } catch { /* preserve setup error */ } }
    throw error;
  } finally { busy = false; }
  return Object.freeze({ dispatch, getState, getTick, subscribe, subscribeToEvents: events.subscribe,
    getEvents: events.read, getRandomState: random.getState, getPlugins: pluginRegistry.list,
    registerPlugin, unregisterPlugin, snapshot, restore, fork: id => forkSnapshotRecord(snapshot(), id),
    schedule, cancelSchedule, getSchedules: scheduler.list, step, advance, pause, resume, inspect,
    getExplanation, dispose, exportSave: () => serializeSnapshot(snapshot()),
    importSave: (input, options) => restore(deserializeSave(input, options)) });
}
