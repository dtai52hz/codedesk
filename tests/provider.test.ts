import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { completion, validateProviderSettings } from '../electron/provider.js';

async function mockApi(t: TestContext, handler: (request: IncomingMessage, response: ServerResponse) => void | Promise<void>): Promise<string> {
  const server = createServer((request, response) => {
    void Promise.resolve(handler(request, response)).catch(error => {
      if (!response.headersSent) response.writeHead(500, { 'content-type': 'text/plain' });
      response.end(String(error));
    });
  });
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  t.after(() => new Promise<void>((resolve, reject) => {
    server.closeAllConnections();
    server.close(error => error ? reject(error) : resolve());
  }));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  return `http://127.0.0.1:${address.port}/v1`;
}

async function requestBody(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

const event = (data: unknown) => `data: ${JSON.stringify(data)}\r\n\r\n`;
const defaults = { model: 'deepseek-chat', apiKey: 'local-test-key', messages: [{ role: 'user' as const, content: 'Build it' }] };

test('SSE survives byte boundaries and combines Unicode, reasoning, tool fragments and usage', async t => {
  let received: { path?: string; authorization?: string; body?: Record<string, unknown> } = {};
  const baseUrl = await mockApi(t, async (request, response) => {
    received = { path: request.url, authorization: request.headers.authorization, body: await requestBody(request) };
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    const wire = ': keepalive\r\n\r\n'
      + event({ choices: [{ delta: { content: 'Xin chào 👋', reasoning_content: 'plan', tool_calls: [{ index: 1, id: 'call_read', function: { name: 'read_file', arguments: '{"path":' } }, { index: 0, id: 'call_write', function: { name: 'write_', arguments: '{"path":"src/' } }] } }] })
      + event({ choices: [{ delta: { content: '\nDone.', reasoning_content: ' done', tool_calls: [{ index: 0, function: { name: 'file', arguments: 'main.ts","content":"ok"}' } }, { index: 1, function: { arguments: '"README.md"}' } }] } }] })
      + event({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 34 } })
      + 'data: [DONE]';
    const bytes = Buffer.from(wire);
    for (let offset = 0; offset < bytes.length; offset += 7) {
      response.write(bytes.subarray(offset, offset + 7));
      await nextTurn();
    }
    response.end();
  });
  const deltas: string[] = [];
  const tools = [{ type: 'function' as const, function: { name: 'write_file', description: 'Write', parameters: { type: 'object' } } }];
  const result = await completion({ ...defaults, baseUrl, tools, onDelta: text => deltas.push(text) });
  assert.equal(result.message.content, 'Xin chào 👋\nDone.');
  assert.equal(deltas.join(''), result.message.content);
  assert.equal(result.message.reasoning_content, 'plan done');
  assert.deepEqual(result.message.tool_calls, [
    { id: 'call_write', type: 'function', function: { name: 'write_file', arguments: '{"path":"src/main.ts","content":"ok"}' } },
    { id: 'call_read', type: 'function', function: { name: 'read_file', arguments: '{"path":"README.md"}' } },
  ]);
  assert.deepEqual(result.usage, { prompt_tokens: 12, completion_tokens: 34 });
  assert.equal(received.path, '/v1/chat/completions');
  assert.equal(received.authorization, 'Bearer local-test-key');
  assert.equal(received.body?.stream, true);
  assert.equal(received.body?.model, 'deepseek-chat');
  assert.deepEqual(received.body?.tools, tools);
  assert.equal(received.body?.tool_choice, 'auto');
});

test('compatible APIs returning JSON can still deliver assistant content and tool calls', async t => {
  const message = { role: 'assistant' as const, content: 'Created a plan.', tool_calls: [{ id: 'call_one', type: 'function' as const, function: { name: 'list_files', arguments: '{}' } }] };
  const baseUrl = await mockApi(t, async (request, response) => {
    await requestBody(request);
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1, completion_tokens: 2 } }));
  });
  const deltas: string[] = [];
  const result = await completion({ ...defaults, baseUrl, onDelta: text => deltas.push(text) });
  assert.deepEqual(result.message, message);
  assert.deepEqual(deltas, ['Created a plan.']);
  assert.deepEqual(result.usage, { prompt_tokens: 1, completion_tokens: 2 });
});

test('provider URLs normalize completion endpoints and reject unsafe configuration', () => {
  assert.deepEqual(validateProviderSettings({ baseUrl: ' https://api.deepseek.com/v1/chat/completions/ ', model: ' deepseek-chat ' }), { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' });
  assert.equal(validateProviderSettings({ baseUrl: 'http://localhost:8080/v1', model: 'local' }).baseUrl, 'http://localhost:8080/v1');
  for (const baseUrl of ['http://example.com/v1', 'https://name:password@example.com/v1', 'https://example.com/v1?key=secret', 'https://example.com/v1#fragment', 'file:///tmp/mock-api']) {
    assert.throws(() => validateProviderSettings({ baseUrl, model: 'model' }), undefined, baseUrl);
  }
  assert.throws(() => validateProviderSettings({ baseUrl: 'https://example.com', model: ' ' }), /model/i);
});

test('HTTP and stream errors redact credentials while retaining useful API detail', async t => {
  const key = 'private-key-must-not-leak';
  let calls = 0;
  const baseUrl = await mockApi(t, async (request, response) => {
    await requestBody(request);
    if (calls++ === 0) {
      response.writeHead(401, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ error: { message: `Invalid key ${key}; header Bearer another-secret` } }));
    } else {
      response.writeHead(200, { 'content-type': 'text/event-stream' });
      response.end(event({ error: { message: `Quota exceeded for ${key}` } }));
    }
  });
  await assert.rejects(completion({ ...defaults, apiKey: key, baseUrl }), error => {
    assert.match(String(error), /API 401: Invalid key \[redacted\]/);
    assert.doesNotMatch(String(error), /private-key-must-not-leak|another-secret/);
    return true;
  });
  await assert.rejects(completion({ ...defaults, apiKey: key, baseUrl }), error => {
    assert.match(String(error), /Quota exceeded for \[redacted\]/);
    assert.doesNotMatch(String(error), /private-key-must-not-leak/);
    return true;
  });
});

test('malformed, empty and incomplete tool streams fail instead of producing an executable call', async t => {
  const payloads = [
    'data: {invalid json}\n\n',
    'data: [DONE]\n\n',
    event({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{}' } }] } }] }),
    event({ choices: [{ delta: { tool_calls: [{ index: -1, id: 'bad', function: { name: 'read_file', arguments: '{}' } }] } }] }),
  ];
  let index = 0;
  const baseUrl = await mockApi(t, async (request, response) => {
    await requestBody(request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end(payloads[index++]);
  });
  for (const expected of [/invalid streaming JSON/i, /did not contain an assistant message/i, /incomplete tool call/i, /Invalid tool call index/i]) {
    await assert.rejects(completion({ ...defaults, baseUrl }), expected);
  }
});

test('stopping an in-flight stream promptly aborts the provider request', { timeout: 10_000 }, async t => {
  let started!: () => void;
  const receivedFirstChunk = new Promise<void>(resolve => { started = resolve; });
  const baseUrl = await mockApi(t, async (request, response) => {
    await requestBody(request);
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write(event({ choices: [{ delta: { content: 'Working' } }] }));
  });
  const controller = new AbortController();
  const pending = completion({ ...defaults, baseUrl, signal: controller.signal, onDelta: () => started() });
  const rejected = assert.rejects(pending, /Cancelled/i);
  await receivedFirstChunk;
  controller.abort();
  await rejected;
});
