import { assertCounter, copyData, freezeData } from "./data.js";

export function createTickScheduler({ capacity = 10000 } = {}) {
  if (!Number.isSafeInteger(capacity) || capacity < 1) throw new RangeError("Schedule capacity must be positive.");
  let sequence = 0;
  let jobs = [];

  function schedule(action, { at, interval = null, limit = null, id } = {}, currentTick = 0) {
    assertCounter(at, "Schedule tick");
    if (at <= currentTick) throw new RangeError("Schedules must target a future tick.");
    if (interval !== null && (!Number.isSafeInteger(interval) || interval < 1)) throw new RangeError("Repeat interval must be positive.");
    if (limit !== null && (!Number.isSafeInteger(limit) || limit < 1)) throw new RangeError("Repeat limit must be positive.");
    if (interval === null && limit !== null && limit !== 1) throw new RangeError("Multiple runs require an interval.");
    const input = copyData(action);
    if (!input || typeof input.type !== "string" || !input.type.trim()) throw new TypeError("Scheduled actions require a type.");
    if (jobs.length >= capacity) throw new RangeError("Schedule capacity exceeded.");
    const nextSequence = sequence + 1;
    assertCounter(nextSequence, "Schedule sequence");
    const jobId = id ?? `schedule-${String(nextSequence).padStart(6, "0")}`;
    if (typeof jobId !== "string" || !jobId.trim() || jobs.some(job => job.id === jobId)) throw new TypeError("Schedule id must be unique and non-empty.");
    sequence = nextSequence;
    jobs.push({ id: jobId, sequence, action: input, at, interval, remaining: interval === null ? 1 : limit });
    return jobId;
  }

  function cancel(id) {
    const before = jobs.length;
    jobs = jobs.filter(job => job.id !== id);
    return before !== jobs.length;
  }

  function due(tick) {
    return freezeData(copyData(jobs.filter(job => job.at <= tick).sort((a, b) => a.at - b.at || a.sequence - b.sequence)));
  }

  function consume(id) {
    const job = jobs.find(item => item.id === id);
    if (!job) return false;
    if (job.remaining === 1 || job.interval === null) return cancel(id);
    const nextAt = job.at + job.interval;
    assertCounter(nextAt, "Next schedule tick");
    job.at = nextAt;
    if (job.remaining !== null) job.remaining -= 1;
    return true;
  }

  function list() {
    return freezeData(copyData(jobs.slice().sort((a, b) => a.at - b.at || a.sequence - b.sequence)));
  }

  function exportState() { return { version: 1, sequence, jobs: list() }; }

  function restoreState(input, tick = 0) {
    const candidate = copyData(input);
    if (candidate?.version !== 1 || !Array.isArray(candidate.jobs) || candidate.jobs.length > capacity) throw new TypeError("Invalid scheduler snapshot.");
    assertCounter(candidate.sequence, "Schedule sequence");
    const ids = new Set();
    const sequences = new Set();
    for (const job of candidate.jobs) {
      assertCounter(job.at, "Schedule tick");
      if (job.at < tick || !Number.isSafeInteger(job.sequence) || job.sequence < 1 || job.sequence > candidate.sequence || sequences.has(job.sequence)) throw new TypeError("Invalid scheduler ordering.");
      if (typeof job.id !== "string" || !job.id.trim() || ids.has(job.id)) throw new TypeError("Invalid schedule id.");
      if (!job.action || typeof job.action.type !== "string" || !job.action.type.trim()) throw new TypeError("Invalid scheduled action.");
      if (job.interval !== null && (!Number.isSafeInteger(job.interval) || job.interval < 1)) throw new TypeError("Invalid schedule interval.");
      if (job.remaining !== null && (!Number.isSafeInteger(job.remaining) || job.remaining < 1)) throw new TypeError("Invalid schedule remaining count.");
      if (job.interval === null && job.remaining !== 1) throw new TypeError("Invalid one-shot schedule.");
      ids.add(job.id); sequences.add(job.sequence);
    }
    sequence = candidate.sequence;
    jobs = candidate.jobs;
  }

  return Object.freeze({ schedule, cancel, due, consume, list, exportState, restoreState });
}
