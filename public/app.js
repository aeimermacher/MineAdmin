const state = { miners: [], selected: new Set(), editing: null, limits: null, interval: 10, authed: false };
const $ = (sel) => document.querySelector(sel);

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

async function api(path, method = 'GET', body) {
  const opts = { method };
  if (method !== 'GET') {
    opts.headers = { 'Content-Type': 'application/json' };
    opts.body = JSON.stringify(body ?? {});
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (res.status === 401 && path !== '/api/login') {
    setAuthed(false);
    openLogin();
  }
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ---------- Auth ----------

function setAuthed(authed) {
  state.authed = authed;
  document.body.classList.toggle('locked', !authed);
}

function openLogin() {
  const dlg = $('#login-dialog');
  if (dlg.open) return;
  $('#login-form').reset();
  dlg.showModal();
}

async function checkSession() {
  const s = await api('/api/session');
  setAuthed(s.authenticated);
  $('#login-hint').textContent = s.passwordSet ? '' : 'No password set yet. Run "npm run set-password" on the server first.';
}

function toast(msg, isError = false) {
  const el = document.createElement('div');
  el.className = 'toast' + (isError ? ' error' : '');
  el.textContent = msg;
  $('#toasts').append(el);
  setTimeout(() => el.remove(), isError ? 8000 : 4000);
}

// ---------- Formatting ----------

const fmtHash = (ghs) => (ghs >= 1000 ? `${(ghs / 1000).toFixed(2)} TH/s` : `${ghs.toFixed(1)} GH/s`);
const fmtNum = (v, d = 0) => (v == null || isNaN(v) ? '-' : Number(v).toFixed(d));

function fmtDiff(v) {
  if (v == null) return '-';
  if (typeof v === 'string') return v;
  const units = ['', 'K', 'M', 'G', 'T', 'P', 'E'];
  let i = 0;
  while (v >= 1000 && i < units.length - 1) { v /= 1000; i++; }
  return `${v.toFixed(2)}${units[i]}`;
}

function fmtUptime(s) {
  if (s == null) return '-';
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : `${m}m`;
}

const tempClass = (t, warn, bad) => (t >= bad ? 'bad' : t >= warn ? 'warn' : '');

// ---------- Rendering ----------

function renderTotals(t) {
  $('#t-online').textContent = `${t.online} / ${t.total}`;
  $('#t-online').className = 'value ' + (t.online < t.total ? 'warn' : '');
  $('#t-hashrate').textContent = fmtHash(t.hashrate);
  $('#t-power').textContent = `${t.power.toFixed(1)} W`;
  $('#t-eff').textContent = t.efficiency ? `${t.efficiency.toFixed(1)} J/TH` : '-';
  $('#t-shares').textContent = `${t.sharesAccepted} / ${t.sharesRejected}`;
  $('#updated').textContent = `Updated ${new Date().toLocaleTimeString()}`;
}

function renderRow(m) {
  const i = m.info || {};
  const on = m.online && m.info;
  const checked = state.selected.has(m.id) ? 'checked' : '';
  const status = on
    ? '<span class="dot ok"></span>Online'
    : `<span class="dot bad"></span>${esc(m.error || 'Offline')}`;
  const eff = on && i.hashRate > 0 ? i.power / (i.hashRate / 1000) : null;
  const fan = on ? `${fmtNum(i.fanspeed)}%${i.autofanspeed ? ' (auto)' : ''}${i.fanrpm ? ` ${i.fanrpm} rpm` : ''}` : '-';
  const pool = on && i.stratumURL ? `${i.stratumURL}:${i.stratumPort}${i.isUsingFallbackStratum ? ' (fallback)' : ''}` : '-';
  const val = (fn) => (on ? fn() : '-');

  return `<tr class="${on ? '' : 'offline'}" data-id="${esc(m.id)}">
    <td><input type="checkbox" class="sel" ${checked}></td>
    <td>${status}</td>
    <td><strong>${esc(m.name)}</strong><br><span class="muted">${esc(i.hostname || '')} ${esc(m.ip)}</span></td>
    <td class="num">${val(() => fmtHash(Number(i.hashRate) || 0))}</td>
    <td class="num ${on ? tempClass(i.temp, 65, 70) : ''}">${val(() => `${fmtNum(i.temp, 1)} °C`)}</td>
    <td class="num ${on ? tempClass(i.vrTemp, 75, 85) : ''}">${val(() => `${fmtNum(i.vrTemp, 0)} °C`)}</td>
    <td class="num">${val(() => `${fmtNum(i.power, 1)} W`)}</td>
    <td class="num">${eff ? eff.toFixed(1) : '-'}</td>
    <td class="num">${val(() => `${fmtNum(i.frequency)} MHz`)}</td>
    <td class="num">${val(() => `${fmtNum(i.coreVoltage)} / ${fmtNum(i.coreVoltageActual)}`)}</td>
    <td>${esc(fan)}</td>
    <td class="num">${val(() => `${i.sharesAccepted ?? '-'} / ${i.sharesRejected ?? '-'}`)}</td>
    <td class="num">${val(() => esc(fmtDiff(i.bestDiff)))}</td>
    <td class="num">${val(() => fmtUptime(i.uptimeSeconds))}</td>
    <td class="pool" title="${esc(pool)}">${esc(pool)}<br><span class="muted">${esc(on ? i.stratumUser : '')}</span></td>
    <td>${esc(on ? i.version : '')}</td>
    <td class="actions">
      <button class="small auth-only" data-action="edit" ${on ? '' : 'disabled'}>Settings</button>
      <button class="small auth-only" data-action="identify" ${on ? '' : 'disabled'}>Identify</button>
      <button class="small danger auth-only" data-action="restart">Restart</button>
      <a class="small" href="http://${esc(m.ip)}/" target="_blank" rel="noopener noreferrer">AxeOS</a>
      <button class="small danger auth-only" data-action="remove" title="Remove from dashboard">&times;</button>
    </td>
  </tr>`;
}

function renderTable() {
  $('#miners').innerHTML = state.miners.length
    ? state.miners.map(renderRow).join('')
    : '<tr><td colspan="17" class="muted">No miners yet. Click "Add miner" to get started.</td></tr>';
  const n = state.selected.size;
  $('#sel-count').textContent = `${n} selected`;
  $('#bulk-settings').disabled = n === 0;
  $('#bulk-restart').disabled = n === 0;
  $('#select-all').checked = n > 0 && n === state.miners.length;
}

function renderChart(id, points, valueOf, format, color) {
  const canvas = $(id);
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = w * dpr;
  canvas.height = h * dpr;
  const ctx = canvas.getContext('2d');
  ctx.scale(dpr, dpr);
  ctx.clearRect(0, 0, w, h);
  const values = points.map(valueOf);
  const valid = values.filter((v) => v != null);
  if (points.length < 2 || !valid.length) {
    ctx.fillStyle = '#8a94a3';
    ctx.fillText('Collecting data...', 10, 20);
    return;
  }
  const pad = { l: 70, r: 10, t: 10, b: 20 };
  const max = Math.max(...valid) * 1.1 || 1;
  const t0 = points[0].t, t1 = points[points.length - 1].t;
  const x = (t) => pad.l + ((t - t0) / (t1 - t0 || 1)) * (w - pad.l - pad.r);
  const y = (v) => h - pad.b - (v / max) * (h - pad.t - pad.b);

  ctx.strokeStyle = '#262c35';
  ctx.fillStyle = '#8a94a3';
  ctx.font = '11px system-ui';
  for (let k = 0; k <= 4; k++) {
    const v = (max / 4) * k;
    ctx.beginPath(); ctx.moveTo(pad.l, y(v)); ctx.lineTo(w - pad.r, y(v)); ctx.stroke();
    ctx.fillText(format(v), 4, y(v) + 4);
  }
  ctx.fillText(new Date(t0).toLocaleTimeString(), pad.l, h - 4);
  const end = new Date(t1).toLocaleTimeString();
  ctx.fillText(end, w - pad.r - ctx.measureText(end).width, h - 4);

  ctx.strokeStyle = color;
  ctx.lineWidth = 2;
  ctx.beginPath();
  let drawing = false;
  points.forEach((p, i) => {
    const v = values[i];
    if (v == null) { drawing = false; return; }
    drawing ? ctx.lineTo(x(p.t), y(v)) : ctx.moveTo(x(p.t), y(v));
    drawing = true;
  });
  ctx.stroke();
}

function renderCharts(points) {
  renderChart('#chart-hashrate', points, (p) => p.hashrate, fmtHash, '#f7931a');
  renderChart('#chart-power', points, (p) => p.power, (v) => `${v.toFixed(0)} W`, '#58a6ff');
  renderChart('#chart-eff', points, (p) => (p.hashrate > 0 ? p.power / (p.hashrate / 1000) : null), (v) => `${v.toFixed(1)} J/TH`, '#3fb950');
}

// ---------- NiceHash ----------

function renderNicehash(nh) {
  const body = $('#nh-body');
  $('#nh-updated').textContent = nh.updated ? `- updated ${new Date(nh.updated).toLocaleTimeString()}` : '';
  if (!nh.enabled) {
    body.className = 'muted';
    body.innerHTML = 'Not configured. Add a read-only NiceHash API key (permission <em>Mining / View mining data and statistics</em>), secret and organization ID to the <code>nicehash</code> section of config.json, then restart the server.';
    return;
  }
  if (!nh.data) {
    body.className = nh.error ? 'bad' : 'muted';
    body.textContent = nh.error || 'Loading...';
    return;
  }
  const d = nh.data;
  const fiat = (btc) => (btc != null && d.btcRate
    ? new Intl.NumberFormat(undefined, { style: 'currency', currency: nh.currency }).format(btc * d.btcRate)
    : '');
  const btc = (v) => (v == null ? '-' : `${v.toFixed(8)} BTC`);
  const date = (v) => (v ? new Date(v).toLocaleString() : '-');
  const card = (label, value, sub = '') =>
    `<div class="card"><div class="label">${esc(label)}</div><div class="value">${esc(value)}</div><div class="sub">${esc(sub)}</div></div>`;

  const keyOf = (s) => String(s ?? '').toLowerCase();
  const minerFor = (worker) => state.miners.find((m) => [m.info?.hostname, m.name].some((n) => n && keyOf(n) === keyOf(worker)));
  const seen = new Set(d.workers.map((w) => minerFor(w.name)?.id).filter(Boolean));
  const missing = state.miners.filter((m) => !seen.has(m.id)).map((m) => m.info?.hostname || m.name);

  const workerRows = d.workers.map((w) => `<tr>
      <td>${esc(w.name)}</td>
      <td class="${w.status === 'MINING' ? '' : 'warn'}">${esc(w.status ?? '-')}</td>
      <td class="num">${esc(btc(w.profitabilityPerDay))}<br><span class="muted">${esc(fiat(w.profitabilityPerDay))}</span></td>
      <td class="num">${esc(btc(w.unpaid))}</td>
      <td>${esc(minerFor(w.name)?.name ?? '-')}</td>
    </tr>`).join('');
  const payoutRows = d.payouts.map((p) => `<tr>
      <td>${esc(date(p.time))}</td>
      <td class="num">${esc(btc(p.amount))}<br><span class="muted">${esc(fiat(p.amount))}</span></td>
      <td class="num">${esc(btc(p.fee))}</td>
    </tr>`).join('');

  body.className = '';
  body.innerHTML = `
    ${nh.error ? `<p class="bad">${esc(nh.error)} (showing last good data)</p>` : ''}
    <div class="cards">
      ${card('Unpaid balance', btc(d.unpaid), fiat(d.unpaid))}
      ${card('Estimated per day', btc(d.profitabilityPerDay), fiat(d.profitabilityPerDay))}
      ${card('Estimated per 30 days', btc(d.profitabilityPerDay != null ? d.profitabilityPerDay * 30 : null), fiat(d.profitabilityPerDay != null ? d.profitabilityPerDay * 30 : null))}
      ${card('Next payout', date(d.nextPayout), d.lastPayout ? `Last: ${date(d.lastPayout)}` : '')}
    </div>
    ${missing.length ? `<p class="warn">Not seen on NiceHash: ${esc(missing.join(', '))}</p>` : ''}
    <div class="nh-grid">
      <div class="table-wrap"><table>
        <thead><tr><th>Worker</th><th>Status</th><th>Est. per day</th><th>Unpaid</th><th>Dashboard miner</th></tr></thead>
        <tbody>${workerRows || '<tr><td colspan="5" class="muted">No workers reported</td></tr>'}</tbody>
      </table></div>
      <div class="table-wrap"><table>
        <thead><tr><th>Payout date</th><th>Amount</th><th>Fee</th></tr></thead>
        <tbody>${payoutRows || '<tr><td colspan="3" class="muted">No payouts yet</td></tr>'}</tbody>
      </table></div>
    </div>`;
}

// ---------- Data loading ----------

async function load() {
  try {
    const [data, hist, nh] = await Promise.all([api('/api/miners'), api('/api/history'), api('/api/nicehash')]);
    state.miners = data.miners;
    state.selected = new Set([...state.selected].filter((id) => data.miners.some((m) => m.id === id)));
    state.limits = data.limits;
    state.interval = data.pollIntervalSeconds;
    renderTotals(data.totals);
    renderTable();
    renderCharts(hist);
    renderNicehash(nh);
  } catch (err) {
    $('#updated').textContent = `Dashboard server unreachable: ${err.message}`;
  }
}

// ---------- Actions ----------

const minerById = (id) => state.miners.find((m) => m.id === id);

async function singleAction(id, action) {
  const m = minerById(id);
  if (action === 'restart' && !confirm(`Restart ${m.name}?`)) return;
  try {
    await api(`/api/miners/${id}/${action}`, 'POST');
    toast(`${m.name}: ${action} sent`);
  } catch (err) {
    toast(`${m.name}: ${err.message}`, true);
  }
  load();
}

async function bulk(action, extra = {}, ids = [...state.selected]) {
  try {
    const { results } = await api('/api/bulk', 'POST', { ids, action, ...extra });
    const failed = results.filter((r) => !r.ok);
    toast(`${action}: ${results.length - failed.length}/${results.length} succeeded`, failed.length > 0);
    failed.forEach((r) => toast(`${r.name}: ${r.error}`, true));
  } catch (err) {
    toast(err.message, true);
  }
  load();
}

// ---------- Settings dialog ----------

const FIELDS = ['hostname', 'frequency', 'coreVoltage', 'autofanspeed', 'fanspeed', 'stratumURL', 'stratumPort', 'stratumUser', 'stratumPassword'];
const NUMERIC = new Set(['frequency', 'coreVoltage', 'autofanspeed', 'fanspeed', 'stratumPort']);

function openSettings(id) {
  const dlg = $('#settings-dialog');
  const form = $('#settings-form');
  form.reset();
  state.editing = id;
  dlg.classList.toggle('bulk', id == null);
  const { frequency: f, coreVoltage: v } = state.limits || {};
  $('#limits-hint').textContent = f ? `Allowed: frequency ${f[0]}-${f[1]} MHz, core voltage ${v[0]}-${v[1]} mV.` : '';

  if (id == null) {
    $('#settings-title').textContent = `Settings for ${state.selected.size} selected miners`;
    $('#settings-hint').textContent = 'Leave a field empty to keep each miner\'s current value.';
  } else {
    const m = minerById(id);
    const i = m.info || {};
    $('#settings-title').textContent = `Settings: ${m.name}`;
    $('#settings-hint').textContent = 'Only changed fields are sent. Leave password empty to keep it.';
    for (const k of FIELDS) {
      if (k === 'stratumPassword' || i[k] == null) continue;
      form.elements[k].value = k === 'autofanspeed' ? (i[k] ? '1' : '0') : i[k];
    }
  }
  dlg.showModal();
}

async function submitSettings(e) {
  e.preventDefault();
  const form = e.target;
  const id = state.editing;
  const current = id != null ? minerById(id).info || {} : {};
  const settings = {};
  for (const k of FIELDS) {
    const raw = form.elements[k].value.trim();
    if (raw === '') continue;
    settings[k] = NUMERIC.has(k) ? Number(raw) : raw;
  }
  if (id != null) {
    for (const k of Object.keys(settings)) {
      const cur = k === 'autofanspeed' ? (current[k] ? 1 : 0) : current[k];
      if (k !== 'stratumPassword' && String(cur ?? '') === String(settings[k])) delete settings[k];
    }
  }
  if (!Object.keys(settings).length) {
    toast('No changes to apply', true);
    return;
  }
  const restart = form.elements.restart.checked;
  $('#settings-dialog').close();

  if (id == null) {
    await bulk('settings', { settings, restart });
  } else {
    const m = minerById(id);
    try {
      await api(`/api/miners/${id}/settings`, 'POST', { settings, restart });
      toast(`${m.name}: settings applied${restart ? ', restarting' : ''}`);
    } catch (err) {
      toast(`${m.name}: ${err.message}`, true);
    }
    load();
  }
}

// ---------- Events ----------

$('#miners').addEventListener('click', (e) => {
  const row = e.target.closest('tr');
  if (!row) return;
  const id = row.dataset.id;
  if (e.target.classList.contains('sel')) {
    e.target.checked ? state.selected.add(id) : state.selected.delete(id);
    renderTable();
    return;
  }
  const action = e.target.dataset.action;
  if (action === 'edit') openSettings(id);
  else if (action === 'remove') removeMiner(id);
  else if (action) singleAction(id, action);
});

async function removeMiner(id) {
  const m = minerById(id);
  if (!confirm(`Remove ${m.name} (${m.ip}) from the dashboard?`)) return;
  try {
    await api(`/api/miners/${id}`, 'DELETE');
    toast(`${m.name} removed`);
  } catch (err) {
    toast(`${m.name}: ${err.message}`, true);
  }
  load();
}

$('#add-miner').addEventListener('click', () => {
  $('#add-form').reset();
  $('#add-dialog').showModal();
});
$('#add-cancel').addEventListener('click', () => $('#add-dialog').close());
$('#add-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const form = e.target;
  const btn = $('#add-submit');
  btn.disabled = true;
  btn.textContent = 'Connecting...';
  try {
    const { miner } = await api('/api/miners', 'POST', { ip: form.elements.ip.value, name: form.elements.name.value });
    $('#add-dialog').close();
    toast(miner.online ? `${miner.name} added` : `${miner.name} added, but not reachable (${miner.error})`, !miner.online);
    load();
  } catch (err) {
    toast(err.message, true);
  } finally {
    btn.disabled = false;
    btn.textContent = 'Add';
  }
});

$('#select-all').addEventListener('change', (e) => {
  state.selected = new Set(e.target.checked ? state.miners.map((m) => m.id) : []);
  renderTable();
});

$('#bulk-settings').addEventListener('click', () => openSettings(null));
$('#bulk-restart').addEventListener('click', () => {
  if (confirm(`Restart ${state.selected.size} miners?`)) bulk('restart');
});
$('#refresh').addEventListener('click', () => bulk('refresh', {}, state.miners.map((m) => m.id)));
$('#settings-form').addEventListener('submit', submitSettings);
$('#settings-cancel').addEventListener('click', () => $('#settings-dialog').close());

$('#login-btn').addEventListener('click', openLogin);
$('#login-cancel').addEventListener('click', () => $('#login-dialog').close());
$('#login-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  try {
    await api('/api/login', 'POST', { password: e.target.elements.password.value });
    $('#login-dialog').close();
    setAuthed(true);
    toast('Logged in');
  } catch (err) {
    toast(err.message, true);
    e.target.elements.password.select();
  }
});
$('#logout-btn').addEventListener('click', async () => {
  await api('/api/logout', 'POST').catch(() => {});
  setAuthed(false);
  toast('Logged out');
});

checkSession().catch(() => setAuthed(false));
load();
setInterval(load, 5000);
