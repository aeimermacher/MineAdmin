import { createHmac, randomUUID } from 'node:crypto';

const API = 'https://api2.nicehash.com';

export function createNicehash(cfg = {}) {
  const {
    apiKey = '',
    apiSecret = '',
    organizationId = '',
    currency = 'EUR',
    pollIntervalSeconds = 60,
  } = cfg;
  const enabled = Boolean(apiKey && apiSecret && organizationId);
  const state = { enabled, currency, updated: null, error: null, data: null };
  let timeOffset = 0;

  async function request(apiPath, query = '', signed = true) {
    const headers = {};
    if (signed) {
      const time = String(Date.now() + timeOffset);
      const nonce = randomUUID();
      const input = [apiKey, time, nonce, '', organizationId, '', 'GET', apiPath, query].join('\0');
      const signature = createHmac('sha256', apiSecret).update(input, 'latin1').digest('hex');
      Object.assign(headers, {
        'X-Time': time,
        'X-Nonce': nonce,
        'X-Organization-Id': organizationId,
        'X-Request-Id': randomUUID(),
        'X-Auth': `${apiKey}:${signature}`,
      });
    }
    const res = await fetch(`${API}${apiPath}${query ? `?${query}` : ''}`, {
      headers,
      signal: AbortSignal.timeout(10000),
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) {
      const msg = body?.errors?.[0]?.message || `HTTP ${res.status}`;
      throw new Error(`NiceHash ${apiPath}: ${msg}`);
    }
    return body;
  }

  // Signed requests are rejected if our clock is more than 5 minutes off NiceHash's.
  async function syncTime() {
    const { serverTime } = await request('/api/v2/time', '', false);
    timeOffset = Number(serverTime) - Date.now();
  }

  async function fiatRate() {
    const { list = [] } = await request('/main/api/v2/exchangeRate/list', '', false);
    const rate = list.find((r) => r.fromCurrency === 'BTC' && r.toCurrency === currency);
    return rate ? Number(rate.exchangeRate) : null;
  }

  const num = (v) => (v == null || v === '' || isNaN(Number(v)) ? null : Number(v));

  async function poll() {
    try {
      await syncTime();
      const [rigs, payouts, rate] = await Promise.all([
        request('/main/api/v2/mining/rigs2'),
        request('/main/api/v2/mining/rigs/payouts', 'page=0&size=10'),
        fiatRate().catch(() => null),
      ]);
      state.data = {
        unpaid: num(rigs.unpaidAmount),
        profitabilityPerDay: num(rigs.totalProfitability),
        nextPayout: rigs.nextPayoutTimestamp ?? null,
        lastPayout: rigs.lastPayoutTimestamp ?? null,
        btcRate: rate,
        workers: (rigs.miningRigs ?? []).map((r) => ({
          name: r.name || r.rigId,
          status: r.minerStatus ?? null,
          profitabilityPerDay: num(r.profitability),
          unpaid: num(r.unpaidAmount),
        })),
        payouts: (payouts.list ?? []).map((p) => ({
          time: p.created ?? null,
          amount: num(p.amount),
          fee: num(p.feeAmount),
        })),
      };
      state.error = null;
      state.updated = Date.now();
    } catch (err) {
      state.error = err.name === 'TimeoutError' ? 'NiceHash did not respond (timeout)' : err.message;
    }
  }

  async function loop() {
    await poll();
    setTimeout(loop, Math.max(30, pollIntervalSeconds) * 1000);
  }

  return {
    start: () => enabled && loop(),
    snapshot: () => state,
  };
}
