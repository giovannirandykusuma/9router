// Real loopback transport regression; also runs unchanged in the final Node image.
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { once } from 'node:events';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import path from 'node:path';

// Never inherit an outbound proxy or credentials. Every destination below is loopback.
for (const name of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy']) {
  process.env[name] = 'http://127.0.0.1:9';
}
process.env.NO_PROXY = process.env.no_proxy = '127.0.0.1,localhost';
const root = path.resolve(process.argv[2] || '.');
const constructors = { Request, Response, FormData, Headers };
await import(pathToFileURL(path.join(root, 'open-sse/utils/proxyFetch.js')));
const { proxyAwareFetch } = await import(pathToFileURL(path.join(root, 'open-sse/utils/proxyFetch.js')));
let count = 0;
const server = http.createServer(async (req, res) => {
  count++;
  if (req.url === '/wait') return; // Abort must close this request, never replay it.
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  const bytes = Buffer.concat(chunks);
  if (req.url === '/reset') { req.socket.destroy(); return; }
  const type = req.headers['content-type'] || '';
  let entries;
  if (type.startsWith('multipart/form-data; boundary=')) {
    const form = await new Response(bytes, { headers: { 'content-type': type } }).formData();
    entries = await Promise.all([...form].map(async ([name, value]) => [name,
      typeof value === 'string' ? value : { name: value.name, type: value.type, text: await value.text() }]));
  }
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ method: req.method, url: req.url, headers: req.headers, body: bytes.toString(), entries }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const url = `http://127.0.0.1:${server.address().port}`;
const json = async (...args) => (await fetch(...args)).json();
try {
  await test('global FormData preserves repeated fields, file names and MIME types', async () => {
    const form = new FormData();
    form.append('tag', 'one'); form.append('tag', 'two');
    form.append('file', new Blob(['RIFFfixture'], { type: 'audio/wav' }), 'voice.wav');
    form.append('file', new File(['second'], 'other.txt', { type: 'text/plain' }));
    const out = await json(url + '/multipart', { method: 'POST', body: form });
    assert.match(out.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.deepEqual(out.entries, [['tag', 'one'], ['tag', 'two'],
      ['file', { name: 'voice.wav', type: 'audio/wav', text: 'RIFFfixture' }],
      ['file', { name: 'other.txt', type: 'text/plain', text: 'second' }]]);
  });
  await test('actual OpenAI-compatible STT path sends multipart rather than object text', async () => {
    const { handleSttCore } = await import(pathToFileURL(path.join(root, 'open-sse/handlers/sttCore.js')));
    const formData = new FormData();
    formData.append('file', new File(['audio'], 'test.wav', { type: 'audio/wav' }));
    formData.append('language', 'en');
    const result = await handleSttCore({ provider: 'openai', model: 'whisper-1', formData,
      credentials: { apiKey: 'synthetic-loopback-only' }, sttConfig: { baseUrl: url + '/stt', authHeader: 'bearer' } });
    assert.equal(result.success, true);
    const out = await result.response.json();
    assert.match(out.headers['content-type'], /^multipart\/form-data; boundary=/);
    assert.equal(out.headers.authorization, 'Bearer synthetic-loopback-only');
    assert.deepEqual(out.entries.find(([key]) => key === 'file')[1], { name: 'test.wav', type: 'audio/wav', text: 'audio' });
    assert.ok(out.entries.some(([key, value]) => key === 'model' && value === 'whisper-1'));
  });
  await test('string, URLSearchParams and Blob bodies retain their encoding', async () => {
    assert.equal((await json(url, { method: 'POST', body: 'plain' })).body, 'plain');
    const encoded = await json(url, { method: 'POST', body: new URLSearchParams({ a: 'a b' }) });
    assert.equal(encoded.body, 'a=a+b');
    assert.match(encoded.headers['content-type'], /^application\/x-www-form-urlencoded/);
    const blob = await json(url, { method: 'POST', body: new Blob(['blob'], { type: 'text/custom' }) });
    assert.equal(blob.body, 'blob'); assert.equal(blob.headers['content-type'], 'text/custom');
  });
  await test('global Request retains URL, method, headers and body', async () => {
    const request = new Request(url + '/request', { method: 'POST', headers: { 'x-fixture': 'original' }, body: 'request-body' });
    const out = await json(request);
    assert.equal(out.url, '/request'); assert.equal(out.method, 'POST');
    assert.equal(out.headers['x-fixture'], 'original'); assert.equal(out.body, 'request-body');
  });
  await test('Request init overrides method, headers, body and signal without merging headers', async () => {
    const request = new Request(url + '/override', { method: 'POST', headers: { 'x-old': 'old' }, body: 'old' });
    const out = await json(request, { method: 'PUT', headers: { 'x-new': 'new' }, body: 'new' });
    assert.equal(out.method, 'PUT'); assert.equal(out.body, 'new');
    assert.equal(out.headers['x-old'], undefined); assert.equal(out.headers['x-new'], 'new');
    const controller = new AbortController(); controller.abort();
    await assert.rejects(fetch(new Request(url), { signal: controller.signal }), { name: 'AbortError' });
  });
  await test('Request init can replace an aborted source signal', async () => {
    const source = new AbortController(); source.abort();
    const replacement = new AbortController();
    const request = new Request(url + '/signal-override', { method: 'POST', body: 'override', signal: source.signal });
    const out = await json(request, { signal: replacement.signal });
    assert.equal(out.body, 'override');
  });
  await test('streaming Request init overrides keep duplex and send exactly once', async () => {
    const body = new ReadableStream({ start(controller) { controller.enqueue(new TextEncoder().encode('stream')); controller.close(); } });
    const before = count;
    const out = await json(new Request(url, { method: 'POST', body: 'old' }), { body, duplex: 'half' });
    assert.equal(out.body, 'stream'); assert.equal(count, before + 1);
  });
  await test('used Request and locked stream are rejected before another POST', async () => {
    const request = new Request(url, { method: 'POST', body: 'used' });
    await request.text(); const before = count;
    await assert.rejects(fetch(request), TypeError);
    const stream = new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array([1])); controller.close(); } });
    const reader = stream.getReader();
    await assert.rejects(fetch(url, { method: 'POST', body: stream, duplex: 'half' }), TypeError);
    reader.releaseLock(); assert.equal(count, before);
  });
  await test('a consumed Request stream is not replayed after a response-phase reset', async () => {
    const before = count;
    await assert.rejects(fetch(new Request(url + '/reset', { method: 'POST', body: 'once' })), TypeError);
    assert.equal(count, before + 1);
  });
  await test('Request signal aborts pending transport without replay', async () => {
    const controller = new AbortController(); const before = count;
    const received = once(server, 'request');
    const pending = fetch(new Request(url + '/wait', { method: 'POST', body: 'once', signal: controller.signal }));
    // An immediate Request conversion error must fail, not leave the test waiting for a socket.
    await Promise.race([received, pending.then(() => { throw new Error('Expected pending response'); })]);
    controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    assert.equal(count, before + 1);
  });
  await test('real loopback proxy preserves multipart and never reaches another host', async () => {
    const proxy = http.createServer();
    const sockets = new Set();
    proxy.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
    proxy.on('request', (req, res) => {
      const target = new URL(req.url);
      if (target.origin !== url) { res.writeHead(403); res.end(); return; }
      const upstream = http.request(target, { method: req.method, headers: req.headers }, response => {
        res.writeHead(response.statusCode, response.headers); response.pipe(res);
      });
      upstream.on('error', () => { res.writeHead(502); res.end(); });
      req.pipe(upstream);
    });
    proxy.on('connect', (req, client, head) => {
      if (req.url !== `127.0.0.1:${server.address().port}`) { client.destroy(); return; }
      const upstream = net.connect(server.address().port, '127.0.0.1', () => {
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length) upstream.write(head);
        client.pipe(upstream); upstream.pipe(client);
      });
      sockets.add(upstream); upstream.on('close', () => sockets.delete(upstream));
      upstream.on('error', () => client.destroy()); client.on('error', () => upstream.destroy());
      client.on('close', () => upstream.destroy());
    });
    await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
    try {
      const body = new FormData(); body.append('file', new Blob(['proxy'], { type: 'text/plain' }), 'proxy.txt');
      const before = count;
      const res = await proxyAwareFetch(url + '/proxy', { method: 'POST', body, signal: AbortSignal.timeout(5000) }, {
        enabled: true, url: `http://127.0.0.1:${proxy.address().port}`, strictProxy: true,
      });
      const out = await res.json();
      assert.deepEqual(out.entries, [['file', { name: 'proxy.txt', type: 'text/plain', text: 'proxy' }]]);
      assert.equal(count, before + 1);
    } finally {
      for (const socket of sockets) socket.destroy();
      await new Promise(resolve => proxy.close(resolve));
    }
  });
  await test('strict proxy refusal never falls back to a direct POST', async () => {
    const before = count;
    await assert.rejects(proxyAwareFetch(url, { method: 'POST', body: 'once' }, {
      enabled: true, url: 'http://127.0.0.1:9', strictProxy: true,
    }), /Proxy required but failed/);
    assert.equal(count, before);
  });
  await test('global constructors remain unchanged and response streams can be rewrapped', async () => {
    for (const [name, value] of Object.entries(constructors)) assert.equal(globalThis[name], value);
    const response = await fetch(url);
    const wrapped = new Response(response.body, { status: response.status, headers: response.headers });
    assert.equal((await wrapped.json()).method, 'GET');
  });
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
