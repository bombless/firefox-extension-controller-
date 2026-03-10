#!/usr/bin/env node
const http = require('http');
const { randomUUID } = require('crypto');

const PORT = 9230;
const queue = [];
const waiting = new Map();

function send(res, code, obj) {
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS'
  });
  res.end(JSON.stringify(obj));
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

  if (req.method === 'GET' && ['/status', '/content', '/open', '/click', '/eval'].includes(url.pathname)) {
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
  console.log('GET /status /content /open?url=... /click?selector=... /eval?script=...');
});
