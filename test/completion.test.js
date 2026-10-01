import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { createEngine, createEventJournal, createMigrationRegistry, createTickScheduler,
  createEngineFromScenario, validateScenario, exampleSystemRegistry } from "../src/index.js";

const counter = { id: "counter", version: "1.0.0", onAction({ action, state, emit }) {
  if (action.type !== "add") return;
  emit({ type: "added", payload: { amount: action.amount ?? 1 } });
  return { state: { count: state.count + (action.amount ?? 1) } };
} };
const makeEngine = options => createEngine({ initialState: { count: 0 }, systems: [counter], ...options });

test("malformed late events roll the entire dispatch back before any publication", () => {
  const engine = makeEngine({ plugins: [{ id: "bad", onAction({ emit, random }) {
    random.next(); emit({ type: "valid" }); emit({ type: "" }); return { state: { count: 900 } };
  } }] });
  const before = engine.snapshot(); let observed = 0;
  engine.subscribeToEvents(() => observed += 1);
  assert.throws(() => engine.dispatch({ type: "add" }), /events require/);
  assert.deepEqual(engine.snapshot(), before);
  assert.equal(observed, 0);
});

test("event envelopes have versions, custom ids advance sequence, and limit zero is empty", () => {
  const journal = createEventJournal();
  assert.equal(journal.publish({ type: "one", id: "custom" }).event.version, 1);
  assert.equal(journal.publish({ type: "two" }).event.id, "event-000002");
  assert.deepEqual(journal.read({ limit: 0 }), []);
  for (const event of [{ type: "ok", version: 2 }, { type: "ok", tick: -1 }, { type: "ok", id: "" }, { type: "ok", source: "" }]) assert.throws(() => journal.publish(event));
  const before = journal.exportState();
  assert.throws(() => journal.publish({ type: "ok" }, { tick: -1 }));
  assert.deepEqual(journal.exportState(), before);
  const invalid = structuredClone(before); invalid.history[0].payload = new Date();
  assert.throws(() => journal.restoreState(invalid), /runtime objects/);
  assert.deepEqual(journal.exportState(), before);
});

test("priority conflicts and skipped rules produce deterministic explanations", () => {
  const rules = [
    { id: "low", priority: 1, conflictKey: "budget", condition: () => true, effect: () => ({ state: { count: 999 } }) },
    { id: "false", priority: 5, condition: () => false, effect: () => { throw Error("must not run"); } },
    { id: "high", priority: 10, conflictKey: "budget", condition: () => true, effect: ({ state }) => ({ state: { count: state.count + 5 }, events: [{ type: "bonus" }] }) }
  ];
  const first = makeEngine({ rules }); const second = makeEngine({ rules });
  const result = first.dispatch({ type: "add" }); second.dispatch({ type: "add" });
  assert.equal(result.state.count, 6);
  const explanation = first.getExplanation(result.action.id);
  assert.deepEqual(explanation, second.getExplanation(result.action.id));
  assert.deepEqual(explanation.traces.map(item => [item.ruleId, item.status]), [["high", "applied"], ["false", "skipped"], ["low", "skipped"]]);
  assert.match(explanation.traces[2].reason, /Conflict budget/);
  assert.deepEqual(explanation.traces[0].effects, ["bonus"]);
});

test("rule rejection and thrown rules leave state, events and random state unchanged", () => {
  for (const fail of [() => ({ accepted: false, reason: "budget" }), () => { throw Error("failed"); }]) {
    const engine = makeEngine({ rules: [{ id: "guard", condition: () => true, effect: ({ random }) => { random.next(); return fail(); } }] });
    const before = engine.snapshot();
    try { const result = engine.dispatch({ type: "add" }); assert.equal(result.accepted, false); assert.equal(result.reason, "budget"); }
    catch (error) { assert.match(error.message, /failed/); }
    assert.deepEqual(engine.snapshot(), before);
  }
});

test("rules reject malformed manifests and asynchronous or non-boolean conditions", () => {
  const valid = { id: "a", condition: () => true, effect: () => ({}) };
  for (const rules of [null, [valid, valid], [{ ...valid, id: "" }], [{ ...valid, condition: null }], [{ ...valid, priority: NaN }], [{ ...valid, conflictKey: "" }]]) assert.throws(() => makeEngine({ rules }));
  for (const rule of [{ ...valid, condition: () => 1 }, { ...valid, effect: () => Promise.resolve({}) }, { ...valid, effect: () => ({ events: {} }) }]) {
    const engine = makeEngine({ rules: [rule] }); assert.throws(() => engine.dispatch({ type: "add" }));
  }
});

test("tick schedules retain order, repeat counts and cancellation across save/restore", () => {
  const engine = makeEngine();
  engine.schedule({ type: "add", amount: 2 }, { at: 2, interval: 2, limit: 3 });
  engine.schedule({ type: "add", amount: 10 }, { at: 2 });
  const cancelled = engine.schedule({ type: "add", amount: 999 }, { at: 1 });
  assert.equal(engine.cancelSchedule(cancelled), true);
  assert.equal(engine.cancelSchedule(cancelled), false);
  engine.step(); const checkpoint = engine.snapshot();
  const results = engine.advance(5);
  assert.deepEqual(results[0].scheduled.map(result => result.state.count), [2, 12]);
  assert.equal(engine.getState().count, 16); assert.equal(engine.getTick(), 6);
  const future = engine.snapshot(); engine.restore(checkpoint); engine.advance(5);
  assert.deepEqual(engine.snapshot(), future);
  assert.deepEqual(engine.getSchedules(), []);
});

test("pause, one-step and tick hooks have explicit deterministic semantics", () => {
  const hooks = [];
  const engine = makeEngine({ plugins: [{ id: "ticks", beforeTick({ tick }) { hooks.push(`before:${tick}`); }, afterTick({ tick }) { hooks.push(`after:${tick}`); } }] });
  engine.pause(); assert.deepEqual(engine.advance(10), []); assert.equal(engine.getTick(), 0);
  engine.step(); assert.equal(engine.getTick(), 1);
  engine.resume(); engine.advance(2); assert.equal(engine.getTick(), 3);
  assert.deepEqual(hooks, ["before:1", "after:1", "before:2", "after:2", "before:3", "after:3"]);
  assert.equal(engine.getEvents().length, 3);
});

test("rejected ticks do not advance and scheduled errors are reported without losing other work", () => {
  const engine = makeEngine({ plugins: [{ id: "reject", onAction({ action }) { if (action.type === "bad") throw Error("bad job"); } }] });
  engine.schedule({ type: "bad" }, { at: 1 }); engine.schedule({ type: "add" }, { at: 1 });
  const result = engine.step(); assert.equal(result.scheduled[0].accepted, false); assert.equal(engine.getState().count, 1);
  const stopped = makeEngine({ plugins: [{ id: "stop", beforeTick: () => ({ accepted: false, reason: "paused by policy" }) }] });
  assert.equal(stopped.step().advanced, false); assert.equal(stopped.getTick(), 0);
});

test("scheduler validates capacity, identity, repeat options and restored records", () => {
  assert.throws(() => createTickScheduler({ capacity: 0 }));
  const scheduler = createTickScheduler({ capacity: 1 });
  for (const options of [{ at: 0 }, { at: 1, interval: 0 }, { at: 1, limit: 0 }, { at: 1, limit: 2 }, { at: 1, id: "" }]) assert.throws(() => scheduler.schedule({ type: "a" }, options));
  assert.throws(() => scheduler.schedule({}, { at: 1 }));
  scheduler.schedule({ type: "a" }, { at: 1, interval: 1, id: "only" });
  assert.throws(() => scheduler.schedule({ type: "b" }, { at: 2 }), /capacity/);
  const before = scheduler.exportState();
  const corrupt = structuredClone(before); corrupt.jobs[0].remaining = -1;
  assert.throws(() => scheduler.restoreState(corrupt)); assert.deepEqual(scheduler.exportState(), before);
  assert.equal(scheduler.consume("missing"), false);
  scheduler.consume("only"); assert.equal(scheduler.list()[0].at, 2);
});

test("JSON save roundtrip and legacy migration restore exact future execution", () => {
  const source = makeEngine({ seed: "saved" }); source.schedule({ type: "add" }, { at: 2 }); source.step();
  const saved = source.exportSave(); const restored = makeEngine({ seed: 999 }); restored.importSave(saved);
  assert.deepEqual(restored.snapshot(), source.snapshot());
  source.step(); restored.step(); assert.deepEqual(restored.snapshot(), source.snapshot());
  const legacy = { format: "pulse-engine-save", version: 0, checkpoint: source.snapshot() };
  restored.importSave(legacy); assert.deepEqual(restored.snapshot(), source.snapshot());
  const before = restored.snapshot();
  for (const invalid of ['{', { format: "bad", version: 1 }, { format: "pulse-engine-save", version: 99, snapshot: before }, { format: "pulse-engine-save", version: 1 }]) assert.throws(() => restored.importSave(invalid));
  assert.deepEqual(restored.snapshot(), before);
});

test("migrations reject missing steps, bad versions, future data and runtime objects", () => {
  for (const migrations of [[{ from: 0, to: 2, migrate: x => x }], [{ from: 0, to: 1, migrate: null }]]) assert.throws(() => createMigrationRegistry(migrations));
  const steps = createMigrationRegistry([{ from: 0, to: 1, migrate: x => ({ ...x, version: 1 }) }, { from: 1, to: 2, migrate: x => ({ ...x, version: 2, ok: true }) }]);
  assert.deepEqual(steps.migrate({ version: 0 }, 2), { version: 2, ok: true });
  assert.throws(() => steps.migrate({ version: -1 }, 2));
  assert.throws(() => steps.migrate({ version: 3 }, 2));
  assert.throws(() => steps.migrate({ version: 2 }, 3));
  assert.throws(() => createMigrationRegistry([{ from: 0, to: 1, migrate: x => x }]).migrate({ version: 0 }, 1));
  for (const invalid of [{ fn() {} }, { date: new Date() }, { map: new Map() }, { bad: Infinity }, { undef: undefined }]) assert.throws(() => makeEngine({ initialState: invalid }));
  const cyclic = {}; cyclic.self = cyclic; assert.throws(() => makeEngine({ initialState: cyclic }));
  const accessor = {}; Object.defineProperty(accessor, 'secret', { enumerable: true, get() { throw Error("accessor evaluated"); } });
  assert.throws(() => makeEngine({ initialState: accessor }), /accessors/);
});

test("snapshot validation is atomic across scheduler, seed, version and branch failures", () => {
  const engine = makeEngine(); const before = engine.snapshot();
  for (const mutate of [s => s.tick = -1, s => s.version = 99, s => s.engineVersion = "future", s => s.revision = -1, s => s.actionSequence = -1, s => s.branch.id = "", s => s.randomState.state = -1, s => s.schedules.version = 99]) {
    const bad = structuredClone(before); mutate(bad); assert.throws(() => engine.restore(bad)); assert.deepEqual(engine.snapshot(), before);
  }
});

test("inspection copies, redaction, bounded history and disabled traces cannot alter state", () => {
  const engine = makeEngine({ eventHistoryLimit: 2, traceLimit: 2, redact: data => ({ ...data, state: { hidden: true } }) });
  for (let i = 0; i < 5; i += 1) engine.dispatch({ type: "add" });
  const inspected = engine.inspect(); assert.equal(inspected.traces.length, 2); assert.equal(inspected.events.length, 2); assert.deepEqual(inspected.state, { hidden: true });
  assert.throws(() => inspected.events.push({})); assert.equal(engine.getState().count, 5);
  const quiet = makeEngine({ diagnostics: false }); quiet.dispatch({ type: "add" }); assert.equal(quiet.inspect(), null); assert.equal(quiet.getExplanation("action-000001"), null);
  assert.throws(() => makeEngine({ traceLimit: 0 }));
});

test("reentrant mutation, async hooks, failed setup and disposal have safe boundaries", () => {
  const engine = makeEngine(); engine.subscribe(() => engine.dispatch({ type: "add" }));
  const result = engine.dispatch({ type: "add" }); assert.equal(result.listenerErrors.length, 1); assert.equal(engine.getState().count, 1);
  assert.throws(() => engine.registerPlugin({ id: "bad", setup() { throw Error("setup"); } }));
  assert.equal(engine.getPlugins().some(plugin => plugin.id === "bad"), false);
  const asyncEngine = makeEngine({ plugins: [{ id: "async", onAction: () => Promise.resolve({}) }] });
  assert.throws(() => asyncEngine.dispatch({ type: "add" }), /synchronous/);
  const order = []; const disposable = makeEngine({ plugins: [{ id: "a", dispose() { order.push('a'); } }, { id: "b", dependsOn: ['a'], dispose() { order.push('b'); throw Error('dispose'); } }] });
  assert.equal(disposable.dispose().length, 1); assert.deepEqual(order, ['b', 'a']); assert.throws(() => disposable.dispatch({ type: "add" }), /disposed/);
});

test("failed initialization cleans up the failing plugin and initialized dependencies", () => {
  const disposed = [];
  assert.throws(() => makeEngine({ plugins: [
    { id: "a", dispose() { disposed.push("a"); } },
    { id: "b", dependsOn: ["a"], setup() { throw Error("setup"); }, dispose() { disposed.push("b"); } }
  ] }), /setup/);
  assert.deepEqual(disposed, ["b", "a"]);
  const engine = makeEngine();
  assert.throws(() => engine.registerPlugin({ id: "bad", setup() { throw Error("setup"); }, dispose() { disposed.push("bad"); } }), /setup/);
  assert.deepEqual(disposed, ["b", "a", "bad"]);
});

test("exhausted deterministic counters reject new work without mutating checkpoints", () => {
  const engine = makeEngine(); const checkpoint = structuredClone(engine.snapshot());
  checkpoint.actionSequence = Number.MAX_SAFE_INTEGER;
  engine.restore(checkpoint); const before = engine.snapshot();
  assert.throws(() => engine.dispatch({ type: "add" }), /Action sequence/);
  assert.deepEqual(engine.snapshot(), before);
  const scheduler = createTickScheduler();
  scheduler.restoreState({ version: 1, sequence: Number.MAX_SAFE_INTEGER, jobs: [] });
  assert.throws(() => scheduler.schedule({ type: "add" }, { at: 1 }), /Schedule sequence/);
  assert.deepEqual(scheduler.list(), []);
});

test("minimal and advanced scenarios validate, run deterministically and separate game data", () => {
  for (const path of ['scenarios/minimal.json', 'scenarios/resource-network.json']) {
    const scenario = JSON.parse(readFileSync(path)); assert.equal(validateScenario(scenario).valid, true);
    const first = createEngineFromScenario(scenario, { systemRegistry: exampleSystemRegistry }); const second = createEngineFromScenario(scenario, { systemRegistry: exampleSystemRegistry });
    first.advance(5); second.advance(5); assert.deepEqual(first.snapshot(), second.snapshot());
  }
  const scenario = JSON.parse(readFileSync('scenarios/resource-network.json'));
  assert.match(validateScenario(scenario, { validateGameData: () => ['custom error'] }).errors[0], /\$\.gameData/);
  const invalid = { ...scenario, version: 99, seed: null, systems: ['x', 'x'], entities: [{ id: '', type: '' }], resources: [], relationships: [{ from: 'bad' }], gameData: 1 };
  const errors = validateScenario(invalid).errors; assert.ok(errors.length >= 8); assert.match(errors.join('\n'), /\$\.entities\[0\]\.id/);
  assert.throws(() => createEngineFromScenario({ ...scenario, systems: ['unknown'] }));
  assert.throws(() => createEngineFromScenario(scenario, { systemRegistry: { 'resource-flow': () => ({ id: 'wrong' }) } }));
  assert.equal(validateScenario(null).valid, false);
  assert.equal(validateScenario({ bad: new Date() }).valid, false);
});

test("headless CLI repeats exact JSON, exports events, and fails invalid input", () => {
  const run = args => spawnSync(process.execPath, ['bin/pulse-run.js', ...args], { encoding: 'utf8' });
  const dir = mkdtempSync(join(tmpdir(), 'pulse-test-'));
  try {
    const args = ['--scenario', 'scenarios/resource-network.json', '--ticks', '10', '--seed', 'frozen'];
    const first = run(args); assert.equal(first.status, 0); assert.equal(first.stdout, run(args).stdout);
    assert.equal(JSON.parse(first.stdout).state.resources.energy, 20);
    const withEvents = run([...args, '--events', join(dir, 'events.json')]); assert.equal(withEvents.status, 0); assert.equal(JSON.parse(readFileSync(join(dir, 'events.json'))).length, 30);
    assert.match(run(['--help']).stdout, /--scenario/);
    for (const bad of [[], ['--bad', 'x'], ['--scenario', 'missing.json'], ['--scenario', 'scenarios/minimal.json', '--ticks', '-1']]) assert.equal(run(bad).status, 1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
