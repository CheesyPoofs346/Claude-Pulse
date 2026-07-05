// Claude Pulse — local usage dashboard for Claude Code (terminal + desktop app)
// Zero dependencies. Reads ~/.claude/projects/**/*.jsonl (usage records, written by
// both the CLI and the desktop app) and %APPDATA%/Claude/claude-code-sessions
// (desktop session metadata, for human-readable titles).
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');

const PORT = process.env.PORT || 4747;
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects');
const DESKTOP_DIR = process.env.APPDATA ? path.join(process.env.APPDATA, 'Claude', 'claude-code-sessions') : null;
const BLOCK_MS = 5 * 3600 * 1000; // Anthropic rate-limit windows are 5h blocks

// $ per MTok: [substring, input, output]. First match wins; cache write = 1.25x in, read = 0.1x in.
const PRICING = [
  ['fable', 10, 50], ['mythos', 10, 50],
  ['opus-4-1', 15, 75], ['opus-4-0', 15, 75], ['opus-4-2', 15, 75],
  ['opus', 5, 25],
  ['haiku-3-5', 0.8, 4], ['haiku-3', 0.25, 1.25], ['haiku', 1, 5],
  ['sonnet', 3, 15],
];
const SONNET5_INTRO_END = Date.UTC(2026, 8, 1); // $2/$10 intro pricing through 2026-08-31
function priceOf(model, ts) {
  if (model.includes('sonnet-5') && ts < SONNET5_INTRO_END) return { in: 2, out: 10 };
  for (const [m, inP, outP] of PRICING) if (model.includes(m)) return { in: inP, out: outP };
  return { in: 3, out: 15 }; // ponytail: unknown models priced as sonnet-tier
}
// cache write: 1.25x input for 5m TTL, 2x for 1h TTL; cache read: 0.1x. web search: $10/1k.
function cost(e) {
  const p = priceOf(e.model, e.ts);
  return (e.in * p.in + e.out * p.out + (e.cw5 * 1.25 + e.cw1h * 2) * p.in + e.cr * p.in * 0.1) / 1e6
    + e.ws * 0.01;
}

// ---- file scanning with per-file mtime cache ----
const fileCache = new Map(); // path -> { mtime, size, entries }

function* walk(dir, ext) {
  let items;
  try { items = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const it of items) {
    const p = path.join(dir, it.name);
    if (it.isDirectory()) yield* walk(p, ext);
    else if (it.name.endsWith(ext)) yield p;
  }
}

function parseJsonl(file) {
  const entries = [];
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch { return entries; }
  for (const line of text.split('\n')) {
    if (!line.includes('"usage"')) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const u = obj.message && obj.message.usage;
    if (!u || !obj.timestamp) continue;
    const model = obj.message.model || '';
    if (!model || model === '<synthetic>') continue;
    const cw = u.cache_creation_input_tokens || 0;
    const cc = u.cache_creation; // TTL breakdown; absent on old records -> assume 5m (cheaper, conservative)
    entries.push({
      ts: Date.parse(obj.timestamp),
      key: obj.message.id && obj.requestId ? obj.message.id + ':' + obj.requestId : null,
      model,
      source: obj.entrypoint || 'cli',
      sessionId: obj.sessionId || path.basename(file, '.jsonl'),
      cwd: obj.cwd || '',
      in: u.input_tokens || 0,
      out: u.output_tokens || 0,
      cw,
      cw5: cc ? (cc.ephemeral_5m_input_tokens || 0) : cw,
      cw1h: cc ? (cc.ephemeral_1h_input_tokens || 0) : 0,
      cr: u.cache_read_input_tokens || 0,
      ws: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
    });
  }
  return entries;
}

function collectEntries() {
  const all = [];
  for (const file of walk(PROJECTS_DIR, '.jsonl')) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    const c = fileCache.get(file);
    if (!c || c.mtime !== st.mtimeMs || c.size !== st.size) {
      fileCache.set(file, { mtime: st.mtimeMs, size: st.size, entries: parseJsonl(file) });
    }
    all.push(...fileCache.get(file).entries);
  }
  // global dedupe (streaming rewrites + resumed sessions repeat message ids)
  const seen = new Set();
  const out = [];
  for (const e of all) {
    if (e.key) { if (seen.has(e.key)) continue; seen.add(e.key); }
    if (Number.isFinite(e.ts)) out.push(e);
  }
  out.sort((a, b) => a.ts - b.ts);
  return out;
}

// Desktop app session metadata -> titles keyed by CLI session id
const titleCache = new Map(); // path -> { mtime, rec }
function collectTitles() {
  const titles = {};
  if (!DESKTOP_DIR) return titles;
  for (const file of walk(DESKTOP_DIR, '.json')) {
    let st; try { st = fs.statSync(file); } catch { continue; }
    const c = titleCache.get(file);
    if (!c || c.mtime !== st.mtimeMs) {
      let rec = null;
      try {
        const j = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (j && j.title) rec = { ids: [j.cliSessionId, j.sessionId].filter(Boolean), title: j.title };
      } catch { }
      titleCache.set(file, { mtime: st.mtimeMs, rec });
    }
    const rec = titleCache.get(file).rec;
    if (rec) for (const id of rec.ids) titles[id] = rec.title;
  }
  return titles;
}

// ---- aggregation ----
function buildBlocks(entries) {
  const blocks = [];
  let cur = null;
  for (const e of entries) {
    if (!cur || e.ts >= cur.end || e.ts - cur.lastTs > BLOCK_MS) {
      const start = Math.floor(e.ts / 3600000) * 3600000;
      cur = { start, end: start + BLOCK_MS, lastTs: e.ts, tokens: 0, cost: 0, msgs: 0 };
      blocks.push(cur);
    }
    cur.lastTs = e.ts;
    cur.tokens += e.in + e.out; // in+out is the limit-relevant count (cache excluded)
    cur.cost += cost(e);
    cur.msgs++;
  }
  return blocks;
}

function aggregate() {
  const entries = collectEntries();
  const titles = collectTitles();
  const now = Date.now();
  const dayKey = ts => new Date(ts).toLocaleDateString('sv'); // yyyy-mm-dd local

  const totals = { in: 0, out: 0, cw: 0, cr: 0, cost: 0, msgs: 0 };
  const models = {}, sources = {}, sessions = {}, daily = {};

  for (const e of entries) {
    const c = cost(e);
    totals.in += e.in; totals.out += e.out; totals.cw += e.cw; totals.cr += e.cr;
    totals.cost += c; totals.msgs++;

    const m = models[e.model] || (models[e.model] = { cost: 0, tokens: 0, msgs: 0 });
    m.cost += c; m.tokens += e.in + e.out; m.msgs++;

    const s = sources[e.source] || (sources[e.source] = { cost: 0, tokens: 0, msgs: 0 });
    s.cost += c; s.tokens += e.in + e.out; s.msgs++;

    if (now - e.ts < 30 * 86400000) {
      const d = daily[dayKey(e.ts)] || (daily[dayKey(e.ts)] = { cost: 0, tokens: 0, bySource: {} });
      d.cost += c; d.tokens += e.in + e.out;
      d.bySource[e.source] = (d.bySource[e.source] || 0) + c;
    }

    const sess = sessions[e.sessionId] || (sessions[e.sessionId] = {
      id: e.sessionId, source: e.source, model: e.model, cwd: e.cwd,
      msgs: 0, tokens: 0, cost: 0, first: e.ts, last: e.ts,
    });
    sess.msgs++; sess.tokens += e.in + e.out; sess.cost += c;
    sess.last = Math.max(sess.last, e.ts); sess.model = e.model;
  }

  for (const s of Object.values(sessions)) s.title = titles[s.id] || null;

  const blocks = buildBlocks(entries);
  const last = blocks[blocks.length - 1];
  const active = last && now < last.end ? last : null;
  const past = active ? blocks.slice(0, -1) : blocks;
  const histTokens = past.map(b => b.tokens).sort((a, b) => a - b);
  const histMax = histTokens[histTokens.length - 1] || 0;
  const p90 = histTokens.length ? histTokens[Math.floor(histTokens.length * 0.9)] : 0;

  // burn rate over trailing 60 min
  const hourAgo = now - 3600000;
  let bTok = 0, bCost = 0, oldest = now;
  for (let i = entries.length - 1; i >= 0 && entries[i].ts > hourAgo; i--) {
    bTok += entries[i].in + entries[i].out; bCost += cost(entries[i]);
    oldest = entries[i].ts;
  }
  const mins = Math.max((now - oldest) / 60000, 1);

  const todayK = dayKey(now);
  let today = { cost: 0, tokens: 0, msgs: 0 }, week = { cost: 0, tokens: 0, msgs: 0 };
  let last24h = 0;
  for (let i = entries.length - 1; i >= 0 && now - entries[i].ts < 7 * 86400000; i--) {
    const e = entries[i], c = cost(e);
    week.cost += c; week.tokens += e.in + e.out; week.msgs++;
    if (now - e.ts < 86400000) last24h += e.in + e.out;
    if (dayKey(e.ts) === todayK) { today.cost += c; today.tokens += e.in + e.out; today.msgs++; }
  }
  week.last24hTokens = last24h;

  // heaviest rolling 7-day token window ever (proxy for the weekly limit)
  let histMaxWeek = 0, wsum = 0, lo = 0;
  for (let hi = 0; hi < entries.length; hi++) {
    wsum += entries[hi].in + entries[hi].out;
    while (entries[hi].ts - entries[lo].ts > 7 * 86400000) { wsum -= entries[lo].in + entries[lo].out; lo++; }
    if (wsum > histMaxWeek) histMaxWeek = wsum;
  }
  week.histMax = histMaxWeek;

  return {
    generatedAt: now,
    totals, models, sources, daily, today, week,
    burn: { tokensPerMin: bTok / mins, costPerHour: bCost / (mins / 60), windowMin: Math.round(mins) },
    block: active
      ? { start: active.start, end: active.end, tokens: active.tokens, cost: active.cost, msgs: active.msgs, histMax, p90 }
      : { start: null, end: null, tokens: 0, cost: 0, msgs: 0, histMax, p90 },
    blocks: blocks.slice(-12).map(b => ({ start: b.start, tokens: b.tokens, cost: b.cost })),
    sessions: Object.values(sessions).sort((a, b) => b.last - a.last).slice(0, 60),
  };
}

// ---- http ----
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/api/usage')) {
    try {
      const body = JSON.stringify(aggregate());
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(body);
    } catch (err) {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: String(err && err.stack || err) }));
    }
    return;
  }
  if (req.url === '/' || req.url.startsWith('/index')) {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(fs.readFileSync(path.join(__dirname, 'index.html')));
    return;
  }
  res.writeHead(404); res.end('not found');
});

server.listen(PORT, () => console.log(`Claude Pulse → http://localhost:${PORT}`));
