import Database from 'better-sqlite3';
import crypto from 'node:crypto';

const path = process.env.SQLITE_PATH || './varmint.db';
export const db = new Database(path);
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS agents (
  id INTEGER PRIMARY KEY,
  species TEXT NOT NULL,
  name TEXT NOT NULL,
  seed INTEGER NOT NULL,
  token_hash TEXT NOT NULL UNIQUE,
  ip_hash TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
`);

export const SPECIES = ['fly', 'crow', 'cat', 'dog'];

const insertStmt = db.prepare(
  'INSERT INTO agents (species, name, seed, token_hash, ip_hash, created_at) VALUES (?, ?, ?, ?, ?, ?)'
);
const rosterStmt = db.prepare(
  'SELECT id, species, name, seed, created_at FROM agents ORDER BY id'
);
const recentByIpStmt = db.prepare(
  'SELECT COUNT(*) AS n FROM agents WHERE ip_hash = ? AND created_at > ?'
);

export function roster() {
  return rosterStmt.all();
}

export function sha256(s) {
  return crypto.createHash('sha256').update(s).digest('hex');
}

// max 5 agents per IP per day keeps spam roster growth bounded
export function ipThrottled(ipHash, now) {
  return recentByIpStmt.get(ipHash, now - 24 * 3600 * 1000).n >= 5;
}

export function createAgent({ species, name, ipHash }) {
  const token = crypto.randomBytes(24).toString('base64url');
  const seed = crypto.randomInt(1, 2 ** 31);
  const now = Date.now();
  const info = insertStmt.run(species, name, seed, sha256(token), ipHash, now);
  return {
    token,
    agent: { id: Number(info.lastInsertRowid), species, name, seed, created_at: now },
  };
}
