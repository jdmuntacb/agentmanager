// Conflict radar: agents working in the same repository that change the same files.
// Pure functions over each agent's change set (see git.changes), so it is cheap to
// recompute whenever any agent's changes move.

const SLACK = 3; // lines: edits this close together usually conflict when merged

/** Repository identity: agents sharing a clone (or a source folder) can step on each other. */
export function repoKey(agent) {
  return agent.sourceDir || agent.repo || null;
}

const overlaps = (a, b) => a.some(([s1, e1]) => b.some(([s2, e2]) => s1 <= e2 + SLACK && s2 <= e1 + SLACK));

/**
 * entries: [{ agent, changes: { files }, baseSha }]. Returns Map agentId -> [conflict], where
 * conflict = { file, severity: 'lines' | 'file', with: { id, name }, mergeFirst: id }.
 * 'lines' means both edit the same region (likely merge conflict); 'file' only the same file.
 */
export function findConflicts(entries) {
  const out = new Map();
  const groups = new Map();
  for (const e of entries) {
    const key = repoKey(e.agent);
    if (!key || !e.changes) continue;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(e);
  }
  for (const group of groups.values()) {
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const a = group[i];
        const b = group[j];
        if (related(a.agent, b.agent)) continue;
        const shared = Object.keys(a.changes.files).filter((f) => b.changes.files[f]);
        if (!shared.length) continue;
        const first = mergeFirst(a, b, shared);
        for (const file of shared) {
          const fa = a.changes.files[file];
          const fb = b.changes.files[file];
          // Line numbers are only comparable when both branched from the same commit.
          const severity = a.baseSha && a.baseSha === b.baseSha && overlaps(fa.ranges, fb.ranges) ? 'lines' : 'file';
          push(out, a.agent.id, { file, severity, with: { id: b.agent.id, name: b.agent.name }, mergeFirst: first });
          push(out, b.agent.id, { file, severity, with: { id: a.agent.id, name: a.agent.name }, mergeFirst: first });
        }
      }
    }
  }
  for (const list of out.values()) list.sort((x, y) => (x.severity === y.severity ? x.file.localeCompare(y.file) : x.severity === 'lines' ? -1 : 1));
  return out;
}

/** Attempts of one race, or a fork and its source, are meant to touch the same code. */
function related(x, y) {
  if (x.raceId && x.raceId === y.raceId) return true;
  return x.forkOf?.agentId === y.id || y.forkOf?.agentId === x.id || (x.forkOf && x.forkOf.agentId === y.forkOf?.agentId);
}

function push(map, id, c) {
  if (!map.has(id)) map.set(id, []);
  map.get(id).push(c);
}

const prRank = (agent) => {
  const states = Object.values(agent.prs ?? {}).map((p) => p.state);
  return states.includes('MERGED') ? 0 : states.includes('OPEN') ? 1 : 2;
};
const churn = (e, files) => files.reduce((n, f) => n + (e.changes.files[f].added ?? 0) + (e.changes.files[f].removed ?? 0), 0);

/**
 * Which of two agents should land first: one whose PR is merged or open goes first; otherwise
 * the one with the smaller change in the shared files (cheaper for the other to rebase onto).
 */
export function mergeFirst(a, b, shared) {
  const ra = prRank(a.agent);
  const rb = prRank(b.agent);
  if (ra !== rb) return ra < rb ? a.agent.id : b.agent.id;
  return churn(a, shared) <= churn(b, shared) ? a.agent.id : b.agent.id;
}

/** Summary per agent for the UI: files grouped by the other agent. */
export function summarize(list = []) {
  const byAgent = new Map();
  for (const c of list) {
    if (!byAgent.has(c.with.id)) byAgent.set(c.with.id, { agent: c.with, files: [], lines: 0, mergeFirst: c.mergeFirst });
    const g = byAgent.get(c.with.id);
    g.files.push({ file: c.file, severity: c.severity });
    if (c.severity === 'lines') g.lines++;
  }
  return [...byAgent.values()];
}

/** The message an agent gets when told about an overlap. */
export function conflictMessage(self, group) {
  const files = group.files.map((f) => `${f.file}${f.severity === 'lines' ? ' (same lines)' : ''}`).join(', ');
  const order =
    group.mergeFirst === self.id
      ? `Agent Manager suggests your change lands first; ${group.agent.name} will rebase onto it.`
      : `Agent Manager suggests ${group.agent.name}'s change lands first: when it does, rebase onto it and resolve the overlap.`;
  return (
    `Heads-up from Agent Manager: another agent, ${group.agent.name}, is changing the same files as you in this repository: ${files}. ` +
    `${order} Keep your edits in those files focused, avoid unrelated reformatting there, and mention the overlap in your PR description.`
  );
}
