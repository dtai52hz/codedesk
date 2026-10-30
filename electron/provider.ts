export interface ToolCall { id: string; type: 'function'; function: { name: string; arguments: string } }
export interface WireMessage { role: 'system' | 'user' | 'assistant' | 'tool'; content: string | null; tool_calls?: ToolCall[]; tool_call_id?: string; reasoning_content?: string }
export interface ToolDefinition { type: 'function'; function: { name: string; description: string; parameters: Record<string, unknown> } }
export interface ProviderSettings { baseUrl: string; model: string; apiKey: string }
export interface CompletionOptions extends ProviderSettings {
  messages: WireMessage[]; tools?: ToolDefinition[]; signal?: AbortSignal; onDelta?: (text: string) => void;
}
export interface CompletionResult { message: WireMessage; usage?: { prompt_tokens?: number; completion_tokens?: number } }
function assistantMessage(value: unknown): WireMessage {
  if (!value || typeof value !== 'object') throw new Error('The API returned an invalid assistant message.');
  const message = value as WireMessage;
  if (message.role !== 'assistant' || (message.content !== undefined && message.content !== null && typeof message.content !== 'string')) throw new Error('The API returned an invalid assistant message.');
  if (message.tool_calls !== undefined && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 20 || message.tool_calls.some(call => !call || typeof call.id !== 'string' || !call.id || call.id.length > 200 || call.type !== 'function' || !call.function || typeof call.function.name !== 'string' || !call.function.name || call.function.name.length > 128 || typeof call.function.arguments !== 'string'))) throw new Error('The API returned an incomplete tool call.');
  if (message.reasoning_content !== undefined && typeof message.reasoning_content !== 'string') throw new Error('The API returned invalid reasoning data.');
  return { role: 'assistant', content: message.content ?? null, ...(message.tool_calls?.length ? { tool_calls: message.tool_calls } : {}), ...(message.reasoning_content ? { reasoning_content: message.reasoning_content } : {}) };
}
export function validateProviderSettings(input: { baseUrl: string; model: string }): { baseUrl: string; model: string } {
  const url = new URL(input.baseUrl.trim());
  if (url.username || url.password || url.search || url.hash) throw new Error('Base URL must not contain credentials, query parameters or a fragment.');
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname))) throw new Error('Use HTTPS, or HTTP for a local API server.');
  const baseUrl = url.href.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
  const model = input.model.trim();
  if (!model || model.length > 200) throw new Error('Enter a model name.');
  return { baseUrl, model };
}
function redactError(text: string, key: string): string {
  return (key ? text.replaceAll(key, '[redacted]') : text).replace(/Bearer\s+\S+/gi, 'Bearer [redacted]').slice(0, 800);
}
async function limitedText(response: Response, maxBytes: number): Promise<string> {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = '', size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > maxBytes) throw new Error(`API response exceeded ${Math.round(maxBytes / 1024)} KiB.`);
      text += decoder.decode(value, { stream: true });
    }
    return text + decoder.decode();
  } finally { await reader.cancel().catch(() => {}); }
}
export async function completion(options: CompletionOptions): Promise<CompletionResult> {
  const { baseUrl, model } = validateProviderSettings(options);
  if (!options.apiKey.trim()) throw new Error('Set an API key in Settings first.');
  const timeout = AbortSignal.timeout(180_000);
  const signal = options.signal ? AbortSignal.any([timeout, options.signal]) : timeout;
  let response: Response;
  try {
    response = await fetch(`${baseUrl}/chat/completions`, {
      method: 'POST', signal, redirect: 'error',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${options.apiKey}` },
      body: JSON.stringify({ model, messages: options.messages, ...(options.tools?.length ? { tools: options.tools, tool_choice: 'auto' } : {}), stream: true, stream_options: { include_usage: true }, max_tokens: 8192 }),
    });
  } catch (error) {
    if (options.signal?.aborted) throw new Error('Cancelled.');
    if (timeout.aborted) throw new Error('API request timed out after 3 minutes.');
    throw new Error(`Could not reach the API: ${redactError(error instanceof Error ? error.message : String(error), options.apiKey)}`);
  }
  if (!response.ok) {
    const body = await limitedText(response, 64 * 1024);
    let detail = body;
    try { detail = (JSON.parse(body) as { error?: { message?: string } }).error?.message ?? body; } catch { /* Plain error. */ }
    throw new Error(`API ${response.status}: ${redactError(detail, options.apiKey)}`);
  }
  if (response.headers.get('content-type')?.includes('application/json')) {
    let data: { choices?: { message: WireMessage }[]; usage?: CompletionResult['usage']; error?: { message: string } };
    try { data = JSON.parse(await limitedText(response, 2 * 1024 * 1024)) as typeof data; }
    catch (error) { if (error instanceof SyntaxError) throw new Error('The API returned invalid JSON.'); throw error; }
    const rawMessage = data.choices?.[0]?.message;
    if (!rawMessage) throw new Error(redactError(data.error?.message ?? 'The API returned no assistant message.', options.apiKey));
    const message = assistantMessage(rawMessage);
    if (message.content) options.onDelta?.(message.content);
    return { message, ...(data.usage ? { usage: data.usage } : {}) };
  }
  if (!response.body) throw new Error('The API returned an empty stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '', content = '', reasoning = '', total = 0, sawChoice = false;
  let usage: CompletionResult['usage'];
  const calls = new Map<number, ToolCall>();
  const parseEvent = (event: string): void => {
    const payload = event.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n').trim();
    if (!payload || payload === '[DONE]') return;
    let data: { choices?: { delta?: { content?: string; reasoning_content?: string; tool_calls?: { index: number; id?: string; function?: { name?: string; arguments?: string } }[] } }[]; usage?: CompletionResult['usage']; error?: { message?: string } };
    try { data = JSON.parse(payload); } catch { throw new Error('API sent invalid streaming JSON.'); }
    if (data.error) throw new Error(redactError(data.error.message ?? 'API stream error.', options.apiKey));
    if (data.usage) usage = data.usage;
    const choice = data.choices?.[0];
    if (!choice) return;
    sawChoice = true;
    const delta = choice.delta;
    if (!delta) return;
    if ((delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') || (delta.reasoning_content !== undefined && delta.reasoning_content !== null && typeof delta.reasoning_content !== 'string')) throw new Error('The API returned invalid text data.');
    if (delta.content) { content += delta.content; options.onDelta?.(delta.content); }
    if (delta.reasoning_content) reasoning += delta.reasoning_content;
    for (const fragment of delta.tool_calls ?? []) {
      if (!Number.isInteger(fragment.index) || fragment.index < 0 || fragment.index >= 20) throw new Error('Invalid tool call index.');
      if ((fragment.id !== undefined && typeof fragment.id !== 'string') || (fragment.function?.name !== undefined && typeof fragment.function.name !== 'string') || (fragment.function?.arguments !== undefined && typeof fragment.function.arguments !== 'string')) throw new Error('The API returned invalid tool call data.');
      const call = calls.get(fragment.index) ?? { id: '', type: 'function' as const, function: { name: '', arguments: '' } };
      if (fragment.id) call.id += fragment.id;
      if (fragment.function?.name) call.function.name += fragment.function.name;
      if (fragment.function?.arguments) call.function.arguments += fragment.function.arguments;
      calls.set(fragment.index, call);
    }
  };
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) { buffer += decoder.decode(); break; }
      total += value.length;
      if (total > 2 * 1024 * 1024) throw new Error('API response exceeded the 2 MiB limit.');
      buffer += decoder.decode(value, { stream: true });
      let match: RegExpExecArray | null;
      while ((match = /\r?\n\r?\n/.exec(buffer))) {
        parseEvent(buffer.slice(0, match.index));
        buffer = buffer.slice(match.index + match[0].length);
      }
    }
    if (buffer.trim()) parseEvent(buffer);
  } catch (error) {
    if (options.signal?.aborted) throw new Error('Cancelled.');
    if (timeout.aborted) throw new Error('API request timed out after 3 minutes.');
    throw error;
  } finally { await reader.cancel().catch(() => {}); }
  if (!sawChoice) throw new Error('The API stream did not contain an assistant message.');
  const toolCalls = [...calls.entries()].sort(([a], [b]) => a - b).map(([, call]) => call);
  if (toolCalls.some(call => !call.id || !call.function.name)) throw new Error('The API returned an incomplete tool call.');
  return { message: assistantMessage({ role: 'assistant', content: content || null, ...(reasoning ? { reasoning_content: reasoning } : {}), ...(toolCalls.length ? { tool_calls: toolCalls } : {}) }), ...(usage ? { usage } : {}) };
}
