export const BRIEF_COMPACT_MIN_BUDGET = 24;

type BriefRecord = Record<string, unknown>;
type Section = { readonly name: string; readonly value: BriefRecord };

function codePoints(value: string): number {
  return Array.from(value).length;
}

function encoded(value: BriefRecord): string {
  return JSON.stringify(value);
}

function focusSection(full: BriefRecord): BriefRecord {
  const tasks = Array.isArray(full['tasks']) ? full['tasks'] as BriefRecord[] : [];
  const focus = tasks.filter((task) => task['status'] === 'in_progress');
  const memory = full['memory'] !== null && typeof full['memory'] === 'object'
    ? full['memory'] as BriefRecord
    : {};
  return {
    tasks: focus.length > 0 ? focus : tasks.slice(0, 5),
    memory: { focus: memory['focus'] ?? null },
  };
}

function lastSessionSection(full: BriefRecord, part: 'unmet_checks' | 'summaries'): BriefRecord {
  const sessions = full['last_sessions'] !== null && typeof full['last_sessions'] === 'object'
    ? full['last_sessions'] as BriefRecord
    : {};
  return {
    last_sessions: part === 'unmet_checks'
      ? { unmet_checks: sessions['unmet_checks'] ?? [] }
      : { latest: sessions['latest'] ?? null, recent: sessions['recent'] ?? [] },
  };
}

function memoryPart(full: BriefRecord, key: string): BriefRecord {
  const memory = full['memory'] !== null && typeof full['memory'] === 'object'
    ? full['memory'] as BriefRecord
    : {};
  return { memory: { [key]: memory[key] ?? null } };
}

function mergeSections(sections: readonly Section[], truncated: readonly string[]): BriefRecord {
  const out: BriefRecord = {};
  for (const section of sections) {
    for (const [key, value] of Object.entries(section.value)) {
      if (key === 'memory' || key === 'last_sessions') {
        out[key] = { ...(out[key] as BriefRecord | undefined), ...(value as BriefRecord) };
      } else out[key] = value;
    }
  }
  if (truncated.length > 0) out['truncated'] = truncated;
  return out;
}

/** Additive, bounded projection. Budget counts Unicode code points, not UTF-16 units. */
export function compactBrief(full: BriefRecord, budgetChars = 6000): BriefRecord {
  if (!Number.isSafeInteger(budgetChars) || budgetChars < BRIEF_COMPACT_MIN_BUDGET) {
    throw new RangeError(`budgetChars must be an integer >= ${BRIEF_COMPACT_MIN_BUDGET}`);
  }
  const sections: readonly Section[] = [
    { name: 'focus_tasks_and_breakpoints', value: focusSection(full) },
    { name: 'last_session_summary', value: lastSessionSection(full, 'summaries') },
    { name: 'knowledge', value: memoryPart(full, 'knowledge') },
    { name: 'freshness', value: { graph: full['graph'] ?? null } },
    { name: 'structure', value: memoryPart(full, 'structure') },
    { name: 'unexplored_changes', value: memoryPart(full, 'unexploredChanges') },
    { name: 'caches', value: memoryPart(full, 'caches') },
    { name: 'limitations', value: { limitations: full['limitations'] ?? [] } },
    { name: 'other', value: Object.fromEntries(Object.entries(full).filter(([key]) => !['tasks', 'memory', 'last_sessions', 'graph', 'limitations', 'truncated'].includes(key))) },
  ];
  // The unmet-check section is separate so it outranks session summaries.
  const ordered = [sections[0]!, { name: 'unmet_checks', value: lastSessionSection(full, 'unmet_checks') }, ...sections.slice(1)];
  const selected: Section[] = [];
  const selectedNames = new Set<string>();
  for (const section of ordered) {
    const candidate = [...selected, section];
    if (codePoints(encoded(mergeSections(candidate, []))) <= budgetChars) {
      selected.push(section);
      selectedNames.add(section.name);
    }
  }
  // Reserve room for explicit truncation by discarding lowest-priority sections.
  while (selected.length > 0) {
    const result = mergeSections(selected, ordered.filter((item) => !selectedNames.has(item.name)).map((item) => item.name));
    if (codePoints(encoded(result)) <= budgetChars) return result;
    const removed = selected.pop();
    if (removed) selectedNames.delete(removed.name);
  }
  return { truncated: ['all'] };
}
