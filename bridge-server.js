#!/usr/bin/env node
const http = require('http');
const { randomUUID } = require('crypto');

const PORT = 9230;
const queue = [];
const waiting = new Map();
const recordsByUrl = new Map();

function normalizeRecordUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return '';
  try {
    const u = new URL(raw.trim());
    if (!/^https?:$/.test(u.protocol)) return '';
    u.search = '';
    u.hash = '';
    return `${u.origin}${u.pathname}`;
  } catch (_) {
    return '';
  }
}

function clean(value, max = 200) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  return text.slice(0, max);
}

function upsertRecords(records, meta = {}) {
  const list = Array.isArray(records) ? records : [];
  const now = new Date().toISOString();
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const item of list) {
    const normalizedUrl = normalizeRecordUrl(
      item?.url || item?.link || item?.href || ''
    );
    if (!normalizedUrl) {
      skipped += 1;
      continue;
    }

    const nextCompanyName = clean(item?.companyName || item?.company || '', 200);
    const nextJobName = clean(item?.jobName || item?.jobTitle || item?.title || item?.positionName || '', 300);
    const nextArea = clean(item?.area || item?.jobArea || item?.city || '', 200);
    const nextSalaryRange = clean(item?.salaryRange || item?.salary || '', 120);
    const sourcePage = clean(item?.sourcePage || meta?.sourcePage || '', 500);
    const existing = recordsByUrl.get(normalizedUrl);

    if (!existing) {
      recordsByUrl.set(normalizedUrl, {
        url: normalizedUrl,
        jobName: nextJobName,
        companyName: nextCompanyName,
        area: nextArea,
        salaryRange: nextSalaryRange,
        sourcePages: sourcePage ? [sourcePage] : [],
        firstCapturedAt: now,
        lastCapturedAt: now
      });
      inserted += 1;
      continue;
    }

    const mergedSourcePages = new Set(existing.sourcePages || []);
    if (sourcePage) mergedSourcePages.add(sourcePage);

    recordsByUrl.set(normalizedUrl, {
      url: normalizedUrl,
      jobName: nextJobName || existing.jobName,
      companyName: nextCompanyName || existing.companyName,
      area: nextArea || existing.area,
      salaryRange: nextSalaryRange || existing.salaryRange,
      sourcePages: Array.from(mergedSourcePages).slice(-20),
      firstCapturedAt: existing.firstCapturedAt || now,
      lastCapturedAt: now
    });
    updated += 1;
  }

  return {
    inserted,
    updated,
    skipped,
    total: recordsByUrl.size
  };
}

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
}

function sendHtml(res, code, html) {
  res.writeHead(code, {
    'Content-Type': 'text/html; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(String(html || ''));
}

function readJson(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => (data += c));
    req.on('end', () => {
      try { resolve(JSON.parse(data || '{}')); }
      catch { resolve({}); }
    });
  });
}

function enqueue(cmd, params = {}) {
  const id = randomUUID();
  queue.push({ id, cmd, params, at: Date.now() });
  return id;
}

function waitResult(id, timeoutMs = 15000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => {
      waiting.delete(id);
      resolve({ ok: false, error: 'timeout' });
    }, timeoutMs);
    waiting.set(id, (result) => {
      clearTimeout(t);
      waiting.delete(id);
      resolve(result);
    });
  });
}

const server = http.createServer(async (req, res) => {
  if (req.method === 'OPTIONS') return send(res, 200, { ok: true });

  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === '/health') return send(res, 200, { ok: true, queue: queue.length });

  if (req.method === 'GET' && url.pathname === '/record') {
    const records = Array.from(recordsByUrl.values())
      .sort((a, b) => String(b.lastCapturedAt).localeCompare(String(a.lastCapturedAt)))
      .map((item) => ({
        url: item.url,
        jobName: item.jobName || '',
        companyName: item.companyName || '',
        area: item.area || '',
        salaryRange: item.salaryRange || ''
      }));
    return send(res, 200, { ok: true, count: records.length, records });
  }

  if (req.method === 'POST' && url.pathname === '/record') {
    const body = await readJson(req);
    const summary = upsertRecords(body.records, {
      sourcePage: body.sourcePage || ''
    });
    return send(res, 200, { ok: true, ...summary });
  }

  if (req.method === 'GET' && url.pathname === '/next-command') {
    const task = queue.shift() || null;
    return send(res, 200, task || {});
  }

  if (req.method === 'POST' && url.pathname === '/result') {
    const body = await readJson(req);
    const done = waiting.get(body.id);
    if (done) done(body.result);
    return send(res, 200, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/call') {
    const body = await readJson(req);
    const id = enqueue(body.cmd, body.params || {});
    const result = await waitResult(id, body.timeoutMs || 15000);
    return send(res, 200, { id, result });
  }

  if (req.method === 'GET' && url.pathname === '/html') {
    const params = Object.fromEntries(url.searchParams.entries());
    const id = enqueue('html', params);
    const result = await waitResult(id, 15000);
    if (result?.ok && typeof result.html === 'string') {
      return sendHtml(res, 200, result.html);
    }
    return send(res, 502, { id, result });
  }

  if (req.method === 'GET' && url.pathname === '/content') {
    const params = Object.fromEntries(url.searchParams.entries());
    const id = enqueue('content', params);
    const result = await waitResult(id, 15000);
    if (result?.ok) return send(res, 200, result);
    return send(res, 502, { id, result });
  }

  if (req.method === 'GET' && ['/status', '/dom', '/open', '/click', '/eval'].includes(url.pathname)) {
    const cmd = url.pathname.slice(1);
    const params = Object.fromEntries(url.searchParams.entries());
    const id = enqueue(cmd, params);
    const result = await waitResult(id, 15000);
    return send(res, 200, { id, result });
  }

  send(res, 404, { ok: false, error: 'not found' });
});

server.listen(PORT, () => {
  console.log(`Bridge server listening on http://127.0.0.1:${PORT}`);
  console.log('POST /call {cmd, params}');
  console.log('GET /status /content /html /dom /open?url=... /click?selector=... /eval?script=...');
  console.log('POST /record {records:[{url,jobName,companyName,area,salaryRange}], sourcePage?}');
  console.log('GET /record');
});
