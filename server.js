import http from 'node:http';
import { readFile, writeFile, rename } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createNicehash } from './nicehash.js';
import { createSessionStore, verifyPassword } from './auth.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(root, 'public');
const configPath = path.join(root, 'config.json');
const config = JSON.parse(await readFile(configPath, 'utf8'));
const {
  host = '127.0.0.1',
  port = 8080,
  pollIntervalSeconds = 10,
  requestTimeoutMs = 4000,
  limits = {},
} = config;

const nicehash = createNicehash(config.nicehash);
const sessions = createSessionStore();
const loginFailures = new Map();

let nextId = 0;
const createMiner = (m) => ({
  id: String(nextId++),
  name: m.name || m.ip,
  ip: m.ip,
  online: false,
  lastSeen: null,
  error: null,
  info: null,
});
const miners = (config.miners ?? []).map(createMiner);

let saveQueue = Promise.resolve();
// Re-reads the file so external edits (password, NiceHash keys) aren't overwritten.
function saveConfig() {
  const minerList = miners.map(({ name, ip }) => ({ name, ip }));
  const write = saveQueue.then(async () => {
    const current = JSON.parse(await readFile(configPath, 'utf8'));
    current.miners = minerList;
    const tmp = `${configPath}.tmp`;
    await writeFile(tmp, JSON.stringify(current, null, 2) + '\n');
    await rename(tmp, configPath);
  });
  saveQueue = write.catch(() => {});
  return write;
}

const history = [];
const HISTORY_MAX = Math.ceil((6 * 3600) / pollIntervalSeconds);

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// ---------- AxeOS communication ----------

async function minerRequest(miner, method, apiPath, body) {
  const res = await fetch(`http://${miner.ip}${apiPath}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(requestTimeoutMs),
  });
  if (!res.ok) throw new HttpError(502, `${miner.name}: HTTP ${res.status}`);
  const text = await res.text();
  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return text;
  }
}

async function pollMiner(miner) {
  try {
    miner.info = await minerRequest(miner, 'GET', '/api/system/info');
    miner.online = true;
    miner.lastSeen = Date.now();
    miner.error = null;
  } catch (err) {
    miner.online = false;
    miner.error = err.name === 'TimeoutError' ? 'timeout' : err.message;
  }
}

function totals() {
  const on = miners.filter((m) => m.online && m.info);
  const sum = (key) => on.reduce((s, m) => s + (Number(m.info[key]) || 0), 0);
  const hashrate = sum('hashRate');
  const power = sum('power');
  return {
    online: on.length,
    total: miners.length,
    hashrate,
    power,
    efficiency: hashrate > 0 ? power / (hashrate / 1000) : null,
    sharesAccepted: sum('sharesAccepted'),
    sharesRejected: sum('sharesRejected'),
  };
}

async function pollAll() {
  await Promise.all(miners.map(pollMiner));
  const t = totals();
  history.push({ t: Date.now(), hashrate: t.hashrate, power: t.power });
  if (history.length > HISTORY_MAX) history.shift();
}

async function pollLoop() {
  await pollAll();
  setTimeout(pollLoop, pollIntervalSeconds * 1000);
}

function publicMiner(m) {
  let info = null;
  if (m.info && typeof m.info === 'object') {
    info = Object.fromEntries(Object.entries(m.info).filter(([k]) => !/pass/i.test(k)));
  }
  return { id: m.id, name: m.name, ip: m.ip, online: m.online, lastSeen: m.lastSeen, error: m.error, info };
}

// ---------- Settings validation ----------

const SETTINGS = {
  frequency: { type: 'int', range: limits.frequency ?? [400, 800] },
  coreVoltage: { type: 'int', range: limits.coreVoltage ?? [1000, 1300] },
  fanspeed: { type: 'int', range: [0, 100] },
  autofanspeed: { type: 'int', range: [0, 1] },
  stratumURL: { type: 'string', max: 128 },
  stratumPort: { type: 'int', range: [1, 65535] },
  stratumUser: { type: 'string', max: 128 },
  stratumPassword: { type: 'string', max: 64 },
  hostname: { type: 'string', max: 32 },
};

function validateSettings(input, { bulk = false } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new HttpError(400, 'settings object required');
  }
  const out = {};
  for (const [key, value] of Object.entries(input)) {
    const rule = SETTINGS[key];
    if (!rule) throw new HttpError(400, `Unsupported setting: ${key}`);
    if (bulk && key === 'hostname') throw new HttpError(400, 'hostname cannot be set in bulk');
    if (rule.type === 'int') {
      const n = Number(value);
      const [min, max] = rule.range;
      if (!Number.isInteger(n) || n < min || n > max) {
        throw new HttpError(400, `${key} must be an integer between ${min} and ${max}`);
      }
      out[key] = n;
    } else {
      if (typeof value !== 'string' || value.length > rule.max) {
        throw new HttpError(400, `${key} must be a string of at most ${rule.max} characters`);
      }
      out[key] = value;
    }
  }
  if (!Object.keys(out).length) throw new HttpError(400, 'No settings provided');
  return out;
}

function validateNewMiner(body) {
  const ip = typeof body.ip === 'string'
    ? body.ip.trim().replace(/^https?:\/\//i, '').replace(/\/+$/, '')
    : '';
  if (!/^[a-z0-9.-]{1,253}$/i.test(ip)) {
    throw new HttpError(400, 'Enter a valid IP address or hostname');
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (name.length > 32) throw new HttpError(400, 'Name must be at most 32 characters');
  return { ip, name };
}

function assertNotDuplicate(ip) {
  if (miners.some((m) => m.ip.toLowerCase() === ip.toLowerCase())) {
    throw new HttpError(409, `${ip} is already added`);
  }
}

// ---------- Actions ----------

async function runAction(miner, action, body) {
  switch (action) {
    case 'restart':
      await minerRequest(miner, 'POST', '/api/system/restart');
      miner.online = false;
      miner.error = 'restarting';
      return;
    case 'identify':
      await minerRequest(miner, 'POST', '/api/system/identify');
      return;
    case 'refresh':
      await pollMiner(miner);
      return;
    case 'settings': {
      const settings = validateSettings(body.settings, { bulk: body.bulk === true });
      if (body.bulk === true && settings.stratumUser) {
        settings.stratumUser = `${settings.stratumUser}.${miner.info?.hostname || miner.name}`;
      }
      await minerRequest(miner, 'PATCH', '/api/system', settings);
      if (body.restart === true) return runAction(miner, 'restart');
      await pollMiner(miner);
      return;
    }
    default:
      throw new HttpError(400, `Unknown action: ${action}`);
  }
}

// ---------- HTTP helpers ----------

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...headers });
  res.end(JSON.stringify(data));
}

async function readJson(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 64 * 1024) throw new HttpError(413, 'Body too large');
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

// Blocks cross-site requests: JSON content type forces a CORS preflight we never approve.
function checkCsrf(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) {
    throw new HttpError(415, 'Content-Type must be application/json');
  }
  const origin = req.headers.origin;
  if (origin && new URL(origin).host !== req.headers.host) {
    throw new HttpError(403, 'Cross-origin request rejected');
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
};

async function serveStatic(res, pathname) {
  const rel = pathname === '/' ? 'index.html' : pathname.slice(1);
  const file = path.normalize(path.join(publicDir, rel));
  if (!file.startsWith(publicDir + path.sep)) throw new HttpError(404, 'Not found');
  let data;
  try {
    data = await readFile(file);
  } catch {
    throw new HttpError(404, 'Not found');
  }
  res.writeHead(200, {
    'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function getMiner(id) {
  const miner = miners.find((m) => m.id === String(id));
  if (!miner) throw new HttpError(404, 'Miner not found');
  return miner;
}

// ---------- Auth ----------

const SESSION_COOKIE = 'mineadmin_session';

function sessionToken(req) {
  return (req.headers.cookie || '').match(/(?:^|;\s*)mineadmin_session=([a-f0-9]{64})/)?.[1];
}

const isAuthed = (req) => sessions.valid(sessionToken(req));

function requireAuth(req) {
  if (!isAuthed(req)) throw new HttpError(401, 'Log in to make changes');
}

async function readPasswordHash() {
  const current = JSON.parse(await readFile(configPath, 'utf8'));
  return current.auth?.passwordHash ?? null;
}

async function login(req, res) {
  const ip = req.socket.remoteAddress;
  const failure = loginFailures.get(ip);
  if (failure?.lockedUntil > Date.now()) {
    throw new HttpError(429, 'Too many failed attempts, try again in a minute');
  }
  const { password } = await readJson(req);
  const hash = await readPasswordHash();
  if (!hash) throw new HttpError(400, 'No password set. Run "npm run set-password" on the server.');
  if (typeof password !== 'string' || !(await verifyPassword(password, hash))) {
    const count = (failure?.count ?? 0) + 1;
    loginFailures.set(ip, count >= 5 ? { count: 0, lockedUntil: Date.now() + 60_000 } : { count, lockedUntil: 0 });
    throw new HttpError(401, 'Wrong password');
  }
  loginFailures.delete(ip);
  const token = sessions.create();
  sendJson(res, 200, { authenticated: true }, {
    'Set-Cookie': `${SESSION_COOKIE}=${token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${sessions.ttlSeconds}`,
  });
}

// ---------- Server ----------

const server = http.createServer(async (req, res) => {
  try {
    const { pathname } = new URL(req.url, 'http://localhost');
    const isGet = req.method === 'GET' || req.method === 'HEAD';
    if (!isGet) checkCsrf(req);

    if (isGet && pathname === '/api/miners') {
      return sendJson(res, 200, { miners: miners.map(publicMiner), totals: totals(), pollIntervalSeconds, limits: {
        frequency: SETTINGS.frequency.range,
        coreVoltage: SETTINGS.coreVoltage.range,
      } });
    }
    if (isGet && pathname === '/api/history') {
      return sendJson(res, 200, history);
    }
    if (isGet && pathname === '/api/nicehash') {
      return sendJson(res, 200, nicehash.snapshot());
    }

    if (isGet && pathname === '/api/session') {
      return sendJson(res, 200, { authenticated: isAuthed(req), passwordSet: Boolean(await readPasswordHash()) });
    }
    if (pathname === '/api/login' && req.method === 'POST') {
      return await login(req, res);
    }
    if (pathname === '/api/logout' && req.method === 'POST') {
      sessions.destroy(sessionToken(req));
      return sendJson(res, 200, { authenticated: false }, {
        'Set-Cookie': `${SESSION_COOKIE}=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0`,
      });
    }

    if (pathname === '/api/miners' && req.method === 'POST') {
      requireAuth(req);
      const { ip, name } = validateNewMiner(await readJson(req));
      assertNotDuplicate(ip);
      const miner = createMiner({ ip, name });
      await pollMiner(miner);
      if (!name && miner.info?.hostname) miner.name = miner.info.hostname;
      assertNotDuplicate(ip);
      miners.push(miner);
      await saveConfig();
      return sendJson(res, 201, { miner: publicMiner(miner) });
    }

    const del = pathname.match(/^\/api\/miners\/(\d+)$/);
    if (del && req.method === 'DELETE') {
      requireAuth(req);
      const miner = getMiner(del[1]);
      miners.splice(miners.indexOf(miner), 1);
      await saveConfig();
      return sendJson(res, 200, { ok: true });
    }

    const single = pathname.match(/^\/api\/miners\/(\d+)\/(restart|identify|refresh|settings)$/);
    if (single && req.method === 'POST') {
      if (single[2] !== 'refresh') requireAuth(req);
      const miner = getMiner(single[1]);
      const body = await readJson(req);
      await runAction(miner, single[2], { ...body, bulk: false });
      return sendJson(res, 200, { ok: true, miner: publicMiner(miner) });
    }

    if (pathname === '/api/bulk' && req.method === 'POST') {
      const body = await readJson(req);
      if (body.action !== 'refresh') requireAuth(req);
      if (!Array.isArray(body.ids) || !body.ids.length) throw new HttpError(400, 'ids array required');
      const targets = [...new Set(body.ids.map(String))].map(getMiner);
      if (body.action === 'settings') validateSettings(body.settings, { bulk: true });
      const results = await Promise.allSettled(
        targets.map((m) => runAction(m, body.action, { ...body, bulk: true })),
      );
      return sendJson(res, 200, {
        results: results.map((r, i) => ({
          id: targets[i].id,
          name: targets[i].name,
          ok: r.status === 'fulfilled',
          error: r.status === 'rejected' ? (r.reason.name === 'TimeoutError' ? 'timeout' : r.reason.message) : null,
        })),
      });
    }

    if (pathname.startsWith('/api/')) throw new HttpError(404, 'Not found');
    if (!isGet) throw new HttpError(405, 'Method not allowed');
    await serveStatic(res, pathname);
  } catch (err) {
    const status = err.status || (err.name === 'TimeoutError' ? 504 : 502);
    sendJson(res, status, { error: err.name === 'TimeoutError' ? 'Miner did not respond (timeout)' : err.message });
  }
});

server.listen(port, host, () => {
  console.log(`MineAdmin running at http://${host}:${port} - monitoring ${miners.length} miners`);
});
pollLoop();
nicehash.start();
