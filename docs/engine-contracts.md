# Engine contracts

Pulse is a synchronous ES-module simulation kernel. Consumers own game content,
UI and balance. Engine data contains JSON-safe values; runtime hooks remain outside
snapshots. Node 22+ and modern browsers with `structuredClone` and native ES modules
are supported. CI tests Node 22/24 on Linux, Windows and macOS, plus Chromium and
WebKit through Playwright. Physical-device testing is a separate consumer concern.

## Dispatch and rules

`createEngine({ initialState, systems, plugins, rules, seed })` returns an engine.
`dispatch({ type, ...data })` returns `accepted`, `action`, `revision`, `tick`,
`state`, and, on acceptance, emitted `events` plus observer-error arrays. State and
randomness roll back on rejection or an exception. Every pending event is validated
before committing state or notifying observers. Event observers and state listeners
receive independent data; their exceptions are returned without reverting a commit.
Hooks must be synchronous. Reentrant writes are rejected. `getState()` returns a copy;
`subscribe(listener)` returns an unsubscribe function.

Systems are plug-ins with an `onAction({ action, state, random, tick, emit })` hook.
They can return `{ state, events }` or `{ accepted: false, reason }`. All systems run
in dependency order, followed by rules. Rules require unique `id`, `condition` and
`effect` functions. Conditions return booleans; effects use the same response shape.
Higher `priority` runs first; equal priority is ordered by id. Once a matching rule
claims `conflictKey`, lower rules in that group are skipped. False conditions and
conflicts have explicit trace reasons. `getExplanation(actionId)` reads the latest
bounded record for an action. Rejected attempts do not consume committed action ids.

## Events

Envelopes contain `version: 1`, `id`, `type`, `tick`, `source`, `payload` and `metadata`.
Omitted payload and metadata become empty objects. Publication order is deterministic;
custom ids still consume journal sequence positions. Events are deeply frozen and
copied for observers. `subscribeToEvents(listener, { type })` supports filtering and
unsubscribe; `getEvents({ type, limit })` reads bounded history. `limit: 0` returns no
events. Invalid types, versions, ids, ticks and non-data payloads fail explicitly.

## Time and scheduling

Dispatching an ordinary action does not advance time. `step()` attempts exactly one
tick, runs dependency-ordered `beforeTick` hooks and dispatches `@pulse/tick`, commits
an `engine/tick` event, then runs read-only `afterTick` hooks and due scheduled actions.
A rejected tick does not advance time. `advance(count)` stops on rejection and honors
`pause()`; `step()` remains available while paused. `resume()` re-enables advance.

`schedule(action, { at, interval, limit, id })` returns an id. `at` must be a future
integer tick. Omitting interval schedules once; a positive interval repeats, with an
optional positive attempt limit. Due jobs use tick then insertion sequence order.
`cancelSchedule(id)` removes work before it fires. A rejected/throwing scheduled action
counts as an attempted firing; failure appears in `step().scheduled` and does not skip
other due jobs. Scheduling is bounded (10,000 jobs by default), with explicit overflow
errors. No wall-clock timer affects simulation behavior.

## Snapshots and persistence

`snapshot({ label })` captures state, revision, tick, branch, PRNG state, journal and
scheduler. `restore(snapshot)` validates all components before replacing live state.
`fork(id)` returns an independent snapshot with a new branch id and parent identity;
it does not mutate the source. Snapshots intentionally exclude functions, listeners,
runtime handles, plug-in hooks, diagnostics and the host's pause preference. The host
must recreate the same systems/rules configuration before restoring. Old v1 snapshots
without scheduling fields restore at tick zero with an empty schedule.

`exportSave()` writes a JSON `pulse-engine-save` envelope (version 1); `importSave()`
migrates and validates before restore. Version 0 uses `checkpoint` instead of `snapshot`
and has a built-in migration. `createMigrationRegistry([{ from, to, migrate }])` applies
unique consecutive migrations in order. Missing steps, future versions, bad outputs,
functions, Dates, Maps, undefined values and cycles are rejected. Consumer-supplied
migrations replace the default registry. A failed import leaves live state unchanged.

## Plug-ins and diagnostics

A manifest contains `id`, `version`, `dependsOn` and optional `setup`, `onAction`,
`onEvent`, `beforeTick`, `afterTick`, `dispose` hooks. Missing versions default to
`0.0.0` for legacy systems. Dependencies run before dependents; duplicate, missing and
cyclic dependencies fail. `registerPlugin()` runs setup; `unregisterPlugin()` refuses
removal while dependents remain and runs dispose. `dispose()` tears down the entire
registry in reverse dependency order and reports disposal errors. Observational hooks
receive state/events/tick getters and a random-state getter, not mutable PRNG methods.
`resource-flow` in the scenario registry is the reusable example plug-in.

`inspect()` returns a frozen copy of state, tick, revision, branch, pause flag, schedules,
plug-ins, events and traces. `redact(data)` runs on a copy for consumer-owned fields.
`eventHistoryLimit` and `traceLimit` bound memory. `diagnostics: false` disables trace
collection and makes inspect/explanation queries return null.

## Entity/component world

Install the generic world model as a system with `createWorldPlugin()`. It stores
entities under `state.world`, so the existing snapshot, restore and save APIs include
the world automatically. Entity ids are generated in deterministic creation order;
explicit ids are supported. Entities have a type and a map of JSON-safe components.

Supported actions are `world/entity.create`, `world/entity.destroy`,
`world/component.set` and `world/component.remove`. Successful mutations emit
versioned world events. Duplicate ids, unknown entities and missing components are
rejected without committing state. Component names and ids cannot use prototype
reserved keys.

`getEntity(state, id)` returns a detached entity record or `null`.
`queryEntities(state, { type, with, without })` returns detached records in creation
order, filtered by entity type and required or excluded component names.

```js
import { createEngine, createWorldPlugin, queryEntities } from "@keepithandy/pulse-engine";

const engine = createEngine({ systems: [createWorldPlugin()] });
engine.dispatch({
  type: "world/entity.create",
  entityType: "worker",
  components: { position: { x: 3, y: 5 }, health: 100 }
});

const workers = queryEntities(engine.getState(), { type: "worker", with: ["position"] });
```

World storage stays game-agnostic: consumers define component meanings and run their
own systems against the returned state.

## Scenarios and runner

`scenarios/scenario.schema.json` describes v1 entities, resources, relationships,
seed and enabled systems. `validateScenario()` adds semantic uniqueness/reference
checks and JSON-path errors. Game-specific fields live in `gameData`; a consumer can
provide `validateGameData` returning error strings. `createEngineFromScenario()`
requires explicit allowlisted system factories and validates before engine setup.
Both checked-in example scenarios run without a DOM.

```sh
npm ci
npm run lint
npm run test:coverage
npm run check:package
node bin/pulse-run.js --scenario scenarios/resource-network.json --seed demo --ticks 100 --events events.json
node tools/browser-check.mjs
```

The runner writes deterministic JSON to stdout, optionally exports the complete
event log, and exits nonzero on invalid input or runtime failures. It bounds tick
count at one million. Browser checks use `PULSE_BROWSER=chromium|webkit`; an optional
`PULSE_BROWSER_PATH` selects an installed compatible binary for local verification.

## Backlog verification

Issues #1-#12 map to existing layer tests and `test/completion.test.js`: immutable
events/atomic dispatch, rule decisions/conflicts, state isolation, seeded randomness,
snapshot branches, restored schedules, lifecycle dependencies, legacy migration,
scenario validation, subprocess runner behavior, read-only diagnostics, and CI/package/
compatibility gates. Coverage minimums are 80% lines, 85% functions, 70% branches.
Deterministic repeat/restore fixtures run in every test job; any failure fails the job.
