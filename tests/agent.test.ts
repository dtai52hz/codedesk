import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { CodingAgent, type AgentOptions, type AgentSnapshot } from '../electron/agent.js';
import { WorkspaceFiles } from '../electron/workspace.js';
import type { AgentEvent } from '../shared/types.js';
import type { CompletionResult, ToolCall } from '../electron/provider.js';

function call(id: string, name: string, args: Record<string, unknown>): ToolCall {
  return { id, type: 'function', function: { name, arguments: JSON.stringify(args) } };
}
function tools(...calls: ToolCall[]): CompletionResult {
  return { message: { role: 'assistant', content: null, tool_calls: calls } };
}
const finished: CompletionResult = { message: { role: 'assistant', content: 'Finished.' } };

async function agentFixture(t: TestContext, complete: NonNullable<AgentOptions['complete']>, onEvent?: (event: AgentEvent) => void) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'codedesk-agent-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const files = await new WorkspaceFiles(root).initialize();
  const events: AgentEvent[] = [];
  const snapshots: AgentSnapshot[] = [];
  const agent = new CodingAgent({
    files,
    getSettings: () => ({ baseUrl: 'https://example.com/v1', model: 'test-model', apiKey: 'local-test-key', hasApiKey: true, maxSteps: 8, autoApproveEdits: false, autoApproveCommands: false }),
    complete,
    onEvent: event => { events.push(event); onEvent?.(event); },
    persist: async snapshot => { snapshots.push(structuredClone(snapshot)); },
  });
  return { root, files, agent, events, snapshots };
}

test('denied file and command approvals return tool results without modifying the workspace', { timeout: 10_000 }, async t => {
  let agent!: CodingAgent;
  let calls = 0;
  const fixture = await agentFixture(t, async options => {
    if (calls++ === 0) return tools(
      call('write_denied', 'write_file', { path: 'denied.ts', content: 'must not be written' }),
      call('command_denied', 'run_command', { command: "Set-Content -LiteralPath 'command-marker.txt' -Value 'must not run'" }),
    );
    const results = options.messages.filter(message => message.role === 'tool');
    assert.deepEqual(results.map(message => message.tool_call_id), ['write_denied', 'command_denied']);
    assert.match(results[0]!.content ?? '', /Edit was not approved/i);
    assert.match(results[1]!.content ?? '', /Command was not approved/i);
    return finished;
  }, event => {
    if (event.type === 'approval') agent.respondApproval(event.approval.id, false);
  });
  agent = fixture.agent;
  await agent.send('Create a file and run a command');
  assert.equal(agent.busy, false);
  assert.equal(calls, 2);
  assert.equal(fixture.events.filter(event => event.type === 'approval').length, 2);
  assert.equal(fixture.events.filter(event => event.type === 'approval-resolved').length, 2);
  assert.equal(fixture.events.filter(event => event.type === 'tool-end' && !event.success).length, 2);
  await assert.rejects(fs.access(path.join(fixture.root, 'denied.ts')), { code: 'ENOENT' });
  await assert.rejects(fs.access(path.join(fixture.root, 'command-marker.txt')), { code: 'ENOENT' });
  assert.equal(fixture.snapshots.at(-1)?.messages.at(-1)?.content, 'Finished.');
});

test('stopping while approval is pending cancels the write and preserves valid retry context', { timeout: 10_000 }, async t => {
  let agent!: CodingAgent;
  let pendingApproval!: (id: string) => void;
  const firstApproval = new Promise<string>(resolve => { pendingApproval = resolve; });
  let approvalCount = 0;
  let calls = 0;
  const fixture = await agentFixture(t, async options => {
    calls++;
    if (calls === 1) return tools(call('cancelled_write', 'write_file', { path: 'result.ts', content: 'old attempt' }));
    if (calls === 2) {
      const cancelled = options.messages.find(message => message.role === 'tool' && message.tool_call_id === 'cancelled_write');
      assert.ok(cancelled, 'retry must include a result for the interrupted tool call');
      assert.match(cancelled.content ?? '', /not approved|Cancelled/i);
      assert.equal(options.messages.at(-1)?.content, 'Try again');
      return tools(call('retry_write', 'write_file', { path: 'result.ts', content: 'approved retry' }));
    }
    assert.ok(options.messages.some(message => message.role === 'tool' && message.tool_call_id === 'retry_write' && /Saved result.ts/.test(message.content ?? '')));
    return finished;
  }, event => {
    if (event.type !== 'approval') return;
    if (++approvalCount === 1) pendingApproval(event.approval.id);
    else agent.respondApproval(event.approval.id, true);
  });
  agent = fixture.agent;
  const pending = agent.send('Create result.ts');
  const staleApprovalId = await firstApproval;
  assert.equal(agent.busy, true);
  agent.stop();
  await pending;
  assert.equal(agent.busy, false);
  await assert.rejects(fs.access(path.join(fixture.root, 'result.ts')), { code: 'ENOENT' });
  agent.respondApproval(staleApprovalId, true);
  await agent.send('Try again');
  assert.equal((await fixture.files.readFile('result.ts')).content, 'approved retry');
  assert.equal(calls, 3);
  assert.equal(fixture.events.filter(event => event.type === 'approval-resolved' && event.id === staleApprovalId).length, 1);
  assert.equal(fixture.events.filter(event => event.type === 'error').length, 0);
});

test('a model cannot overwrite an unseen empty file or a stale observed file', async t => {
  let root = '';
  let calls = 0;
  const fixture = await agentFixture(t, async options => {
    calls++;
    if (calls === 1) return tools(
      call('read_initial', 'read_file', { path: 'existing.ts' }),
      call('unread_empty', 'write_file', { path: 'empty.ts', content: 'unobserved overwrite' }),
    );
    if (calls === 2) {
      assert.ok(options.messages.some(message => message.role === 'tool' && message.tool_call_id === 'read_initial' && message.content === 'original'));
      const emptyRejected = options.messages.find(message => message.role === 'tool' && message.tool_call_id === 'unread_empty');
      assert.match(emptyRejected?.content ?? '', /Read this file first/i);
      await fs.writeFile(path.join(root, 'existing.ts'), 'user changed it');
      return tools(call('stale_write', 'write_file', { path: 'existing.ts', content: 'agent overwrite' }));
    }
    const rejected = options.messages.find(message => message.role === 'tool' && message.tool_call_id === 'stale_write');
    assert.match(rejected?.content ?? '', /Read this file first/i);
    return finished;
  });
  root = fixture.root;
  await fs.writeFile(path.join(root, 'existing.ts'), 'original');
  await fs.writeFile(path.join(root, 'empty.ts'), '');
  await fixture.agent.send('Update existing.ts');
  assert.equal((await fixture.files.readFile('existing.ts')).content, 'user changed it');
  assert.equal((await fixture.files.readFile('empty.ts')).content, '');
  assert.equal(fixture.events.filter(event => event.type === 'approval').length, 0);
  assert.equal(fixture.events.filter(event => event.type === 'tool-end' && !event.success).length, 2);
  assert.equal(fixture.events.filter(event => event.type === 'error').length, 0);
  assert.equal(fixture.agent.messages.at(-1)?.content, 'Finished.');
});
