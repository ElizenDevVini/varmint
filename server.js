import express from 'express';
import { db, SPECIES, roster, createAgent, ipThrottled, sha256 } from './db.js';

const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '4kb' }));
app.use(express.static('public'));

const SALT = process.env.IP_SALT || 'varmint-dev-salt';
const clients = new Set();

function broadcast(type, data) {
  const msg = `event: ${type}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(msg);
    } catch {
      clients.delete(res);
    }
  }
}

app.get('/api/stream', (req, res) => {
  if (clients.size >= 300) return res.status(503).end();
  res.set({
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
  });
  res.flushHeaders();
  res.write(`event: snapshot\ndata: ${JSON.stringify({ now: Date.now(), agents: roster() })}\n\n`);
  clients.add(res);
  const cleanup = () => clients.delete(res);
  req.on('close', cleanup);
  req.on('error', cleanup);
});

setInterval(() => {
  for (const res of clients) {
    try {
      res.write(`event: time\ndata: ${Date.now()}\n\n`);
    } catch {
      clients.delete(res);
    }
  }
}, 25000);

app.get('/api/agents', (req, res) => {
  res.json({ now: Date.now(), agents: roster() });
});

const NAME_RE = /^[a-zA-Z0-9 '_-]{2,20}$/;

app.post('/api/agents', (req, res) => {
  const { species, name } = req.body || {};
  if (!SPECIES.includes(species)) {
    return res.status(400).json({ error: `species must be one of: ${SPECIES.join(', ')}` });
  }
  if (typeof name !== 'string' || !NAME_RE.test(name.trim())) {
    return res.status(400).json({ error: 'name must be 2-20 chars: letters, digits, spaces, - _ \'' });
  }
  const ipHash = sha256(SALT + (req.ip || ''));
  if (ipThrottled(ipHash, Date.now())) {
    return res.status(429).json({ error: 'too many agents created from this address today, try tomorrow' });
  }
  const { token, agent } = createAgent({ species, name: name.trim(), ipHash });
  broadcast('agent', agent);
  res.status(201).json({ token, agent });
});

const port = process.env.PORT || 4870;
app.listen(port, () => console.log(`varmint city on :${port}, ${roster().length} agents`));
