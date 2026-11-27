#!/usr/bin/env node
/**
 * S3 spike: HLC (hybrid logical clock) behaviour under a 5-second clock rollback,
 * multi-actor merge, same-parent concurrency, uniqueness and stable total order.
 *
 * Investigative prototype ONLY. No persistence, no concurrency, no I/O. The
 * virtual clock makes every run reproducible.
 *
 * Usage: node scripts/spikes/s3-hlc.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..', '..');
const EVIDENCE = path.join(ROOT, 'docs', 'evidence', 's3-hlc.json');

const START = Date.UTC(2026, 0, 1, 0, 0, 0); // fixed epoch, virtual clock only
const TICK_MS = 5;

class VirtualClock {
  constructor(start = START) { this.t = start; this.history = []; }
  now() { return this.t; }
  advance(ms) { this.t += ms; this.history.push({ op: 'advance', ms, t: this.t }); }
  set(t) { this.t = t; this.history.push({ op: 'set', t }); }
  rollback(ms) { this.t -= ms; this.history.push({ op: 'rollback', ms, t: this.t }); }
}

/** Standard HLC: local event, then receive with max(local, remote, wall). */
class Hlc {
  constructor() { this.physical = 0; this.logical = 0; this.last = null; }
  local(wall) {
    if (wall > this.physical) { this.physical = wall; this.logical = 0; }
    else { this.logical += 1; }
    this.last = { physical: this.physical, logical: this.logical };
    return this.last;
  }
  receive(wall, remote) {
    const maxPhysical = Math.max(this.physical, remote.physical, wall);
    if (maxPhysical === this.physical && maxPhysical === remote.physical) {
      this.logical = Math.max(this.logical, remote.logical) + 1;
    } else if (maxPhysical === this.physical) {
      this.logical = this.logical + 1;
    } else if (maxPhysical === remote.physical) {
      this.logical = remote.logical + 1;
    } else {
      this.logical = 0;
    }
    this.physical = maxPhysical;
    this.last = { physical: this.physical, logical: this.logical };
    return this.last;
  }
}

class Actor {
  constructor(id, clock) {
    this.id = id;
    this.clock = clock;
    this.hlc = new Hlc();
    this.events = [];
    this.counter = 0;
  }
  emit(scenario, kind, parents = [], payload = {}) {
    const hlc = this.hlc.local(this.clock.now());
    const ev = {
      id: `${scenario}:${this.id}:${++this.counter}`,
      scenario, actor: this.id, kind,
      physical: hlc.physical, logical: hlc.logical,
      parents: parents.map((p) => p.id),
      payload
    };
    this.events.push(ev);
    return ev;
  }
  /** Receive a remote event into this actor's HLC; returns the updated timestamp. */
  receive(remoteEvent) {
    return this.hlc.receive(this.clock.now(), remoteEvent);
  }
  /** Receive then emit a causally-after event. */
  after(scenario, kind, remoteEvents, payload = {}) {
    for (const r of remoteEvents) this.receive(r);
    return this.emit(scenario, kind, remoteEvents, payload);
  }
}

const cmpHlc = (a, b) =>
  a.physical - b.physical || a.logical - b.logical || (a.actor < b.actor ? -1 : a.actor > b.actor ? 1 : 0);
// HLC alone (no actor tie-break). Used to demonstrate that HLC is not a total order.
const cmpHlcOnly = (a, b) => a.physical - b.physical || a.logical - b.logical;

const sortHlc = (events) => [...events].sort(cmpHlc);

function hashOrder(events) {
  return crypto.createHash('sha256').update(events.map((e) => e.id).join('|')).digest('hex').slice(0, 16);
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffled(list, rand) {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rand() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function permutations(list) {
  if (list.length <= 1) return [list];
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const rest = [...list.slice(0, i), ...list.slice(i + 1)];
    for (const p of permutations(rest)) out.push([list[i], ...p]);
  }
  return out;
}

const checks = [];
function check(id, name, pass, detail) {
  checks.push({ id, name, pass, detail });
  return pass;
}

function reachableAncestors(ev, byId) {
  const seen = new Set();
  const stack = [...ev.parents];
  while (stack.length) {
    const id = stack.pop();
    if (seen.has(id)) continue;
    seen.add(id);
    const parent = byId.get(id);
    if (parent) stack.push(...parent.parents);
  }
  return seen;
}

function verifyCausality(events, label) {
  const byId = new Map(events.map((e) => [e.id, e]));
  let edges = 0;
  let violations = 0;
  let transitivePairs = 0;
  const examples = [];
  for (const ev of events) {
    for (const pid of ev.parents) {
      edges++;
      const parent = byId.get(pid);
      if (!parent) { violations++; examples.push({ type: 'missing-parent', event: ev.id, parent: pid }); continue; }
      if (cmpHlc(parent, ev) >= 0) {
        violations++;
        if (examples.length < 5) examples.push({ type: 'direct-edge', parent: pid, child: ev.id, parentHlc: [parent.physical, parent.logical], childHlc: [ev.physical, ev.logical] });
      }
    }
    for (const aid of reachableAncestors(ev, byId)) {
      transitivePairs++;
      const anc = byId.get(aid);
      if (anc && cmpHlc(anc, ev) >= 0) {
        violations++;
        if (examples.length < 5) examples.push({ type: 'transitive', ancestor: aid, child: ev.id });
      }
    }
  }
  return { label, events: events.length, directEdges: edges, transitivePairs, violations, examples };
}

function duplicateStats(events) {
  const seen = new Map();
  let duplicatePairs = 0;
  for (const e of events) {
    const k = `${e.physical}:${e.logical}`;
    if (seen.has(k)) duplicatePairs++;
    else seen.set(k, e.id);
  }
  const distinctTriples = new Set(events.map((e) => `${e.physical}:${e.logical}:${e.actor}`)).size;
  return {
    events: events.length,
    distinctPhysicalLogical: seen.size,
    duplicatePhysicalLogical: duplicatePairs,
    distinctTriples,
    duplicateTriples: events.length - distinctTriples
  };
}

function main() {
  const clock = new VirtualClock();
  const scenarios = {};
  const all = [];

  // A. Single actor, monotonic virtual clock: 200 events.
  {
    const a = new Actor('A', clock);
    for (let i = 0; i < 200; i++) { a.emit('A', 'tick', [], { i }); clock.advance(TICK_MS); }
    const sorted = sortHlc(a.events);
    const monotonic = sorted.every((e, i) => i === 0 || cmpHlc(sorted[i - 1], e) < 0);
    const backwards = a.events.filter((e, i) => i > 0 && cmpHlc(a.events[i - 1], e) >= 0).length;
    scenarios.A = {
      description: 'single actor, monotonic clock, 200 events',
      events: a.events.length, monotonic, backwardsInLog: backwards,
      first: a.events[0], last: a.events.at(-1),
      physicalStart: a.events[0].physical, physicalEnd: a.events.at(-1).physical,
      logicalMax: Math.max(...a.events.map((e) => e.logical))
    };
    all.push(...a.events);
    check('P1a', 'single-actor monotonic log strictly increasing', monotonic && backwards === 0, { backwards });
  }

  // B. Single actor: 200 events, then clock rolls back 5s, then 100 events.
  {
    const b = new Actor('B', clock);
    for (let i = 0; i < 200; i++) { b.emit('B', 'pre-rollback', [], { i }); clock.advance(TICK_MS); }
    const lastBefore = b.events.at(-1);
    const wallBefore = clock.now();
    clock.rollback(5000);
    const wallAfter = clock.now();
    for (let i = 0; i < 100; i++) { b.emit('B', 'post-rollback', [], { i }); clock.advance(TICK_MS); }
    const firstAfter = b.events[200];
    const post = b.events.slice(200);
    const pinned = post.filter((e) => e.physical === lastBefore.physical).length;
    const logicalAdvanced = post.filter((e) => e.logical > 0).length;
    const noRegression = post.every((e, i) => i === 0 || cmpHlc(post[i - 1], e) < 0);
    const allUnique = new Set(b.events.map((e) => `${e.physical}:${e.logical}`)).size === b.events.length;
    // Recovery: advance past the rollback and emit one more event.
    clock.advance(6000);
    const recovered = b.emit('B', 'recovered', []);
    scenarios.B = {
      description: 'single actor: 200 events, rollback 5000ms, 100 events, then recover',
      events: b.events.length, rollbackMs: 5000, wallBefore, wallAfter,
      lastBefore: { id: lastBefore.id, hlc: [lastBefore.physical, lastBefore.logical] },
      firstAfter: { id: firstAfter.id, hlc: [firstAfter.physical, firstAfter.logical] },
      firstAfterStrictlyGreater: cmpHlc(lastBefore, firstAfter) < 0,
      postRollbackStrictlyIncreasing: noRegression,
      physicalPinnedEvents: pinned,
      logicalAdvancedEvents: logicalAdvanced,
      uniquePhysicalLogical: allUnique,
      recoveredHlc: [recovered.physical, recovered.logical],
      recoveredPhysicalJumpMs: recovered.physical - firstAfter.physical,
      wallRecovered: clock.now()
    };
    all.push(...b.events);
    check('P1', 'rollback does not move HLC backwards', cmpHlc(lastBefore, firstAfter) < 0 && noRegression,
      { lastBefore: [lastBefore.physical, lastBefore.logical], firstAfter: [firstAfter.physical, firstAfter.logical] });
    check('P2', 'all 300 rollback-scenario events present and unique', b.events.slice(0, 300).length === 300 && allUnique,
      { events: b.events.length, coreEvents: 300, unique: allUnique });
  }

  // C. Three actors, 100 events each, explicit send/receive causal chains, merged.
  {
    const a = new Actor('A', clock);
    const b = new Actor('B', clock);
    const c = new Actor('C', clock);
    const events = [];
    let prevC = null;
    for (let i = 0; i < 100; i++) {
      clock.advance(1);
      // A and B are concurrent siblings: both only know the previous C event.
      const ea = a.after('C', 'work', prevC ? [prevC] : [], { i, who: 'A' });
      const eb = b.after('C', 'work', prevC ? [prevC] : [], { i, who: 'B' });
      // C joins both siblings into its next event.
      const ec = c.after('C', 'work', [ea, eb], { i, who: 'C' });
      events.push(ea, eb, ec);
      prevC = ec;
      clock.advance(1);
    }
    const sorted = sortHlc(events);
    const causal = verifyCausality(events, 'C');
    const dup = duplicateStats(events);
    const rand = mulberry32(42);
    const hashes = new Set();
    for (let k = 0; k < 8; k++) hashes.add(hashOrder(sortHlc(shuffled(events, rand))));
    // Comparator without actor tie-break: stable sort makes order depend on input.
    const noTieHashes = new Set();
    for (let k = 0; k < 4; k++) {
      noTieHashes.add(hashOrder([...shuffled(events, rand)].sort(cmpHlcOnly)));
    }
    scenarios.C = {
      description: '3 actors x 100 events, A/B concurrent siblings joined by C, merged',
      events: events.length,
      causal,
      duplicates: dup,
      stableOrderHashes: [...hashes],
      stableAcrossShuffles: hashes.size === 1,
      withoutTieBreakHashes: [...noTieHashes],
      withoutTieBreakStable: noTieHashes.size === 1,
      firstTen: sorted.slice(0, 10).map((e) => ({ id: e.id, hlc: [e.physical, e.logical] })),
      lastTen: sorted.slice(-10).map((e) => ({ id: e.id, hlc: [e.physical, e.logical] }))
    };
    all.push(...events);
    check('P3', 'multi-actor merge preserves every causal edge', causal.violations === 0, causal);
    check('P6', 'merge is a stable total order under 8 shuffles', hashes.size === 1, [...hashes]);
  }

  // D. Same parent, three concurrent children; 50 rounds; 6 merge permutations.
  {
    const parent = new Actor('P', clock);
    const childrenActors = [new Actor('B', clock), new Actor('C', clock), new Actor('D', clock)];
    const rounds = [];
    let unstable = 0;
    let parentNotFirst = 0;
    let identicalPLLogical = 0;
    for (let r = 0; r < 50; r++) {
      clock.advance(10);
      const p = parent.emit('D', 'parent', [], { round: r });
      const children = childrenActors.map((actor, idx) => {
        // Freeze the clock so every child observes the same wall time: true concurrency.
        return actor.after('D', 'child', [p], { round: r, idx });
      });
      const group = [p, ...children];
      const hashes = new Set();
      for (const perm of permutations(group)) hashes.add(hashOrder(sortHlc(perm)));
      if (hashes.size !== 1) unstable++;
      const ordered = sortHlc(group);
      if (ordered[0].id !== p.id) parentNotFirst++;
      if (new Set(children.map((c) => `${c.physical}:${c.logical}`)).size < 3) identicalPLLogical++;
      rounds.push({
        round: r,
        parentHlc: [p.physical, p.logical],
        childHlc: children.map((c) => [c.physical, c.logical]),
        childActors: children.map((c) => c.actor),
        order: ordered.map((e) => e.id),
        permutations: 6,
        distinctOrderHashes: hashes.size
      });
      all.push(...group);
    }
    scenarios.D = {
      description: 'one parent, 3 concurrent children from 3 actors, 50 rounds, 6 permutations each',
      rounds: 50,
      unstableRounds: unstable,
      parentNotFirstRounds: parentNotFirst,
      roundsWithIdenticalChildHlc: identicalPLLogical,
      sampleRound: rounds[0],
      roundsWithDistinctHashes: rounds.filter((r) => r.distinctOrderHashes !== 1).length
    };
    check('P4', 'same-parent concurrent children have one deterministic order per round',
      unstable === 0 && parentNotFirst === 0, { unstable, parentNotFirst });
  }

  // E. Rollback + receiving messages: (1) future vs the rolled-back wall but
  // behind the pinned physical; (2) far ahead of the pinned physical.
  {
    const e = new Actor('E', clock);
    clock.advance(1000);
    const pre = e.emit('E', 'pre', []);
    clock.rollback(5000);
    const rolled = clock.now();
    const pinnedPhysical = pre.physical;

    const futureVsWall = {
      id: 'remote:future-vs-wall', scenario: 'E', actor: 'F',
      physical: rolled + 3000, logical: 7, parents: [], payload: {}
    };
    e.receive(futureVsWall);
    const afterReceive1 = e.emit('E', 'after-receive-1', []);
    const afterLocal1 = e.emit('E', 'after-local-1', []);

    const futureVsLocal = {
      id: 'remote:future-vs-local', scenario: 'E', actor: 'G',
      physical: pinnedPhysical + 5000, logical: 1, parents: [], payload: {}
    };
    e.receive(futureVsLocal);
    const afterReceive2 = e.emit('E', 'after-receive-2', []);

    scenarios.E = {
      description: 'clock rolled back 5s, then receive (1) an event 3s ahead of the rolled wall but behind the pinned physical, (2) an event 5s ahead of the pinned physical',
      rolledWall: rolled,
      pinnedPhysical,
      case1: {
        remote: { id: futureVsWall.id, hlc: [futureVsWall.physical, futureVsWall.logical] },
        afterReceive: [afterReceive1.physical, afterReceive1.logical],
        afterLocal: [afterLocal1.physical, afterLocal1.logical],
        receiveAdvancedPastRemote: cmpHlc(futureVsWall, afterReceive1) < 0,
        localAfterReceiveAdvanced: cmpHlc(afterReceive1, afterLocal1) < 0,
        physicalUnchanged: afterReceive1.physical === pinnedPhysical,
        note: 'remote is behind the pinned physical, so only logical advances'
      },
      case2: {
        remote: { id: futureVsLocal.id, hlc: [futureVsLocal.physical, futureVsLocal.logical] },
        afterReceive: [afterReceive2.physical, afterReceive2.logical],
        receiveAdvancedPastRemote: cmpHlc(futureVsLocal, afterReceive2) < 0,
        physicalJumpMs: afterReceive2.physical - pinnedPhysical,
        note: 'a remote event ahead of the local HLC drags physical forward by its full amount; HLC has no upper bound on remote skew'
      }
    };
    all.push(pre, afterReceive1, afterLocal1, afterReceive2);
    check('P1b', 'receive after rollback never regresses below remote or local state',
      cmpHlc(futureVsWall, afterReceive1) < 0 && cmpHlc(futureVsLocal, afterReceive2) < 0 &&
      cmpHlc(afterReceive1, afterLocal1) < 0 && cmpHlc(pre, afterReceive1) < 0,
      { case1: scenarios.E.case1, case2: scenarios.E.case2 });
  }

  // F/G. Global uniqueness and causality over every event produced.
  const globalDup = duplicateStats(all);
  const globalCausal = verifyCausality(all, 'ALL');
  const sortedAll = sortHlc(all);
  const uniqueIds = new Set(all.map((e) => e.id)).size === all.length;
  const strictPairs = sortedAll.every((e, i) => i === 0 || cmpHlc(sortedAll[i - 1], e) < 0);

  scenarios.F = { description: 'global uniqueness over all scenarios', ...globalDup, uniqueIds };
  scenarios.G = {
    description: 'global causal verification (direct + transitive)',
    ...globalCausal
  };
  check('P5', 'every event has a unique (physical, logical, actor) and id', globalDup.duplicateTriples === 0 && uniqueIds,
    { duplicatePhysicalLogical: globalDup.duplicatePhysicalLogical, duplicateTriples: globalDup.duplicateTriples, uniqueIds });
  check('P6b', 'global total order is strict (no equal neighbours)', strictPairs, { total: all.length });

  const evidence = {
    spike: 'S3',
    status: 'measured',
    startedAt: new Date().toISOString(),
    environment: {
      node: process.version,
      platform: process.platform,
      note: 'Virtual clock only. No Date.now(), no NTP, no sleep, no persistence.'
    },
    algorithm: {
      name: 'Hybrid Logical Clock (Kulkarni et al. 2014)',
      local: 'p=max(prev.p, wall); l=(p===prev.p ? prev.l+1 : 0)',
      receive: 'p=max(prev.p, remote.p, wall); l depends on which component won (max(l,lr)+1 or winner+1 or 0)',
      orderKey: '(physical, logical, actorId)',
      tieBreakNote: 'actorId is an external convention; HLC itself only orders (physical, logical).'
    },
    config: { startEpoch: START, tickMs: TICK_MS, rollbackMs: 5000, roundsD: 50, permutationsPerRound: 6 },
    scenarios,
    checks,
    totals: {
      events: all.length,
      duplicatePhysicalLogical: globalDup.duplicatePhysicalLogical,
      causalViolations: globalCausal.violations,
      firstEvent: sortedAll[0],
      lastEvent: sortedAll.at(-1)
    },
    verdict: {
      passed: checks.every((c) => c.pass),
      failed: checks.filter((c) => !c.pass).map((c) => c.id)
    }
  };

  fs.mkdirSync(path.dirname(EVIDENCE), { recursive: true });
  fs.writeFileSync(EVIDENCE, JSON.stringify(evidence, null, 2), 'utf8');
  console.log(JSON.stringify({ checks, totals: evidence.totals.scenarios ?? undefined, events: all.length, duplicatePhysicalLogical: globalDup.duplicatePhysicalLogical, causalViolations: globalCausal.violations, withoutTieBreakStable: scenarios.C.withoutTieBreakStable, identicalChildHlcRounds: scenarios.D.roundsWithIdenticalChildHlc }, null, 2));
  console.log('evidence written to', EVIDENCE);
}

main();
