import { copyData, freezeData } from "./data.js";

export function createRuleEvaluator(rules = []) {
  if (!Array.isArray(rules)) throw new TypeError("Rules must be an array.");
  const ids = new Set();
  const ordered = rules.map(rule => {
    if (!rule || typeof rule.id !== "string" || !rule.id.trim() || ids.has(rule.id)) throw new TypeError("Rule ids must be unique and non-empty.");
    if (typeof rule.condition !== "function" || typeof rule.effect !== "function") throw new TypeError(`Rule ${rule.id} requires condition and effect functions.`);
    if (rule.priority !== undefined && !Number.isFinite(rule.priority)) throw new TypeError("Rule priority must be finite.");
    if (rule.conflictKey !== undefined && (typeof rule.conflictKey !== "string" || !rule.conflictKey.trim())) throw new TypeError("Rule conflict keys must be non-empty strings.");
    ids.add(rule.id);
    return { ...rule, priority: rule.priority ?? 0 };
  }).sort((a, b) => b.priority - a.priority || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  function evaluate({ action, state, random, tick, collectTraces = true }) {
    let candidate = copyData(state);
    const events = [];
    const traces = [];
    const claimed = new Set();
    for (const rule of ordered) {
      if (rule.conflictKey && claimed.has(rule.conflictKey)) {
        if (collectTraces) traces.push({ ruleId: rule.id, status: "skipped", reason: `Conflict ${rule.conflictKey} already handled by a higher-priority rule.`, effects: [] });
        continue;
      }
      const context = () => ({ action: freezeData(copyData(action)), state: copyData(candidate), random, tick });
      const matches = rule.condition(context());
      if (typeof matches !== "boolean") throw new TypeError(`Rule ${rule.id} condition must return a boolean.`);
      if (!matches) {
        if (collectTraces) traces.push({ ruleId: rule.id, status: "skipped", reason: "Condition was false.", effects: [] });
        continue;
      }
      const response = rule.effect(context()) ?? {};
      if (response && typeof response.then === "function") throw new TypeError("Rules must be synchronous.");
      if (response.accepted === false) {
        if (collectTraces) traces.push({ ruleId: rule.id, status: "rejected", reason: String(response.reason ?? "Rule rejected the action."), effects: [] });
        return { accepted: false, reason: response.reason ?? `Rejected by ${rule.id}`, traces, events: [], state };
      }
      if (Object.hasOwn(response, "state")) candidate = copyData(response.state);
      if (response.events !== undefined && !Array.isArray(response.events)) throw new TypeError("Rule events must be an array.");
      const effects = (response.events ?? []).map(event => ({ ...copyData(event), source: event.source ?? rule.id }));
      events.push(...effects);
      if (rule.conflictKey) claimed.add(rule.conflictKey);
      if (collectTraces) traces.push({ ruleId: rule.id, status: "applied", reason: "Condition was true.", effects: effects.map(event => event.type) });
    }
    return { accepted: true, state: candidate, events, traces };
  }

  return Object.freeze({ evaluate });
}
