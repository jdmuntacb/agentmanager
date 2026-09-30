import fs from 'node:fs';
import path from 'node:path';

/**
 * JSON-file persistence for agent records. Writes are atomic (tmp + rename)
 * so a crash mid-write never loses the session IDs.
 */
export class Store {
  constructor(file) {
    this.file = file;
    this.data = { version: 1, agents: {} };
    this.load();
  }

  load() {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { version: 1, agents: {}, ...parsed };
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`Cannot read ${this.file}: ${err.message}`);
    }
  }

  save() {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
    fs.renameSync(tmp, this.file);
  }

  list() {
    return Object.values(this.data.agents).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id) {
    return this.data.agents[id];
  }

  /** Find by exact id, then unique id prefix, then unique name. */
  resolve(ref) {
    if (this.data.agents[ref]) return this.data.agents[ref];
    const all = this.list();
    const byPrefix = all.filter((a) => a.id.startsWith(ref));
    if (byPrefix.length === 1) return byPrefix[0];
    const byName = all.filter((a) => a.name === ref);
    if (byName.length === 1) return byName[0];
    return undefined;
  }

  put(agent) {
    this.data.agents[agent.id] = agent;
    this.save();
    return agent;
  }

  patch(id, fields) {
    const agent = this.data.agents[id];
    if (!agent) return undefined;
    Object.assign(agent, fields, { updatedAt: new Date().toISOString() });
    this.save();
    return agent;
  }

  remove(id) {
    delete this.data.agents[id];
    this.save();
  }
}
