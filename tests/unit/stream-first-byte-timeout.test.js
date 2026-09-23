import { afterEach, describe, expect, it, vi } from 'vitest';
import { createStreamController, pipeWithDisconnect } from '../../open-sse/utils/streamHandler.js';

const enc = new TextEncoder();
async function consume(stream) {
  const reader = stream.getReader();
  let text = '';
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return text;
    text += new TextDecoder().decode(value);
  }
}
function fixture({ first = false, close = false, empty = false, firstMs = 50, stallMs = 200 } = {}) {
  const onError = vi.fn();
  const ctrl = createStreamController({ provider: 'test', model: 'test', onError });
  let upstreamController;
  const upstream = new ReadableStream({ start(c) {
    upstreamController = c;
    if (first) c.enqueue(enc.encode('hello'));
    if (empty) c.enqueue(new Uint8Array());
    if (close) c.close();
    else ctrl.signal.addEventListener('abort', () => c.error(new Error('aborted')), { once: true });
  }});
  const terminal = vi.fn(message => enc.encode(`terminal:${message}`));
  const output = pipeWithDisconnect({ body: upstream }, new TransformStream(), ctrl, terminal, stallMs, firstMs);
  return { ctrl, terminal, upstreamController, output, onError };
}
afterEach(() => vi.useRealTimers());
describe('upstream first-byte watchdog', () => {
  it('aborts an upstream with no bytes using the prefill deadline, not the stall deadline', async () => {
    vi.useFakeTimers();
    const f = fixture({ firstMs: 80, stallMs: 20 });
    const text = consume(f.output);
    await vi.advanceTimersByTimeAsync(30);
    expect(f.ctrl.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(await text).toContain('terminal:stream first-byte timeout (80ms)');
    expect(f.terminal).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });
  it('switches to the stall timeout after a real byte', async () => {
    vi.useFakeTimers();
    const f = fixture({ first: true, firstMs: 20, stallMs: 80 });
    const text = consume(f.output);
    await vi.advanceTimersByTimeAsync(30);
    expect(f.ctrl.signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(60);
    expect(await text).toBe('helloterminal:stream stall timeout');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('does not let an empty chunk satisfy the first-byte deadline', async () => {
    vi.useFakeTimers();
    const f = fixture({ empty: true });
    const text = consume(f.output);
    await vi.advanceTimersByTimeAsync(60);
    expect(await text).toContain('first-byte timeout');
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears timers on empty EOF without a false timeout', async () => {
    vi.useFakeTimers();
    const f = fixture({ close: true });
    expect(await consume(f.output)).toBe('');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.terminal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
  it('clears timers when the downstream cancels', async () => {
    vi.useFakeTimers();
    const f = fixture();
    await f.output.cancel('test cancel');
    await vi.advanceTimersByTimeAsync(1000);
    expect(f.terminal).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });
});
