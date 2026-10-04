import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);
const SESSION_TTL_MS = 12 * 3600 * 1000;

export async function hashPassword(password) {
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt:${salt.toString('hex')}:${hash.toString('hex')}`;
}

export async function verifyPassword(password, stored) {
  const [alg, saltHex, hashHex] = String(stored ?? '').split(':');
  if (alg !== 'scrypt' || !saltHex || !hashHex) return false;
  const expected = Buffer.from(hashHex, 'hex');
  const actual = await scryptAsync(String(password), Buffer.from(saltHex, 'hex'), expected.length);
  return timingSafeEqual(actual, expected);
}

export function createSessionStore() {
  const sessions = new Map();
  return {
    ttlSeconds: SESSION_TTL_MS / 1000,
    create() {
      const token = randomBytes(32).toString('hex');
      sessions.set(token, Date.now() + SESSION_TTL_MS);
      return token;
    },
    valid(token) {
      const expires = token && sessions.get(token);
      if (!expires) return false;
      if (expires < Date.now()) {
        sessions.delete(token);
        return false;
      }
      return true;
    },
    destroy(token) {
      sessions.delete(token);
    },
  };
}
