# Pulse Engine

Pulse Engine is a framework-independent JavaScript simulation engine for deterministic, event-driven worlds.

## Project boundary

Pulse Engine owns simulation state, actions, rules, events, scheduling, seeded randomness, snapshots, plug-ins, persistence, and diagnostic traces. It does not own game-specific story, presentation, balance, or content.

**Outpost Zero** is the first separate game planned to consume Pulse Engine.

## Status

Pre-alpha. The core roadmap (#1-#12) now has implementations for dispatch, immutable
events, rules and decision traces, seeded randomness, snapshots, tick scheduling,
plug-ins, JSON persistence/migration, validated scenarios, a headless runner and
read-only diagnostics. Game consumers remain separate projects.

## Try it

```sh
npm ci
npm test
node bin/pulse-run.js --scenario scenarios/resource-network.json --ticks 10
```

Import `createEngine` from `src/index.js` in a browser or from the package in Node
22+. Engine runtime code has no third-party dependencies; Playwright is a development
dependency for compatibility checks. See [engine contracts](docs/engine-contracts.md)
for API, snapshot compatibility, lifecycle, trace, migration and scheduler behavior.

CI runs syntax/determinism checks, tests and coverage thresholds, package validation,
the headless smoke scenario and Chromium/WebKit module checks. No npm publication is
performed by these workflows.
