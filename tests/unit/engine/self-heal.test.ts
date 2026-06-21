import { describe, expect, it, vi } from 'vitest';
import {
  aiActWithSelfHeal,
  aiAssertWithSelfHeal,
  flushCacheIfWarmUp,
} from '../../../src/engine/self-heal.js';

function mockAgent(overrides: Partial<{
  aiAction: () => Promise<void>;
  aiAssert: () => Promise<unknown>;
  aiWaitFor: () => Promise<void>;
  flushCache: () => Promise<void>;
}> = {}) {
  return {
    aiAction: overrides.aiAction ?? vi.fn().mockResolvedValue(undefined),
    // Default: assertion passes. The real aiAssert only returns this structured
    // { pass, thought } object when called with keepRawResponse: true.
    aiAssert: overrides.aiAssert ?? vi.fn().mockResolvedValue({ pass: true, thought: 'ok' }),
    aiWaitFor: overrides.aiWaitFor ?? vi.fn().mockResolvedValue(undefined),
    flushCache: overrides.flushCache ?? vi.fn().mockResolvedValue(undefined),
  };
}

describe('self-heal', () => {
  it('aiActWithSelfHeal succeeds on first attempt', async () => {
    const agent = mockAgent();
    await aiActWithSelfHeal(agent as never, 'Click submit');
    expect(agent.aiAction).toHaveBeenCalledTimes(1);
  });

  it('aiActWithSelfHeal succeeds on second attempt', async () => {
    const agent = mockAgent({
      aiAction: vi
        .fn()
        .mockRejectedValueOnce(new Error('fail'))
        .mockResolvedValue(undefined),
    });
    await aiActWithSelfHeal(agent as never, 'Click submit');
    expect(agent.aiAction).toHaveBeenCalledTimes(2);
  });

  it('aiActWithSelfHeal throws after 3 failures', async () => {
    const agent = mockAgent({
      aiAction: vi.fn().mockRejectedValue(new Error('persistent fail')),
    });
    await expect(aiActWithSelfHeal(agent as never, 'Click submit')).rejects.toThrow('persistent fail');
    expect(agent.aiAction).toHaveBeenCalledTimes(3);
  });

  it('aiActWithSelfHeal aborts immediately on a fatal error (no retries)', async () => {
    const agent = mockAgent({
      aiAction: vi
        .fn()
        .mockRejectedValue(new Error('page.evaluate: RangeError: Maximum call stack size exceeded')),
    });
    await expect(aiActWithSelfHeal(agent as never, 'Click submit')).rejects.toThrow(
      /Maximum call stack/,
    );
    expect(agent.aiAction).toHaveBeenCalledTimes(1);
  });

  it('aiAssertWithSelfHeal stops on a fatal error without further retries', async () => {
    const agent = mockAgent({
      aiAssert: vi.fn().mockRejectedValue(new Error('PageAgent has been destroyed.')),
    });
    const outcome = await aiAssertWithSelfHeal(agent as never, 'Page shows success');
    expect(outcome.pass).toBe(false);
    expect(agent.aiAssert).toHaveBeenCalledTimes(1);
  });

  it('aiActWithSelfHeal times out a hung step', async () => {
    process.env.QA_STEP_TIMEOUT_MS = '50';
    const agent = mockAgent({
      aiAction: vi.fn().mockImplementation(() => new Promise(() => {})),
    });
    await expect(aiActWithSelfHeal(agent as never, 'Hangs forever')).rejects.toThrow(/timed out/);
    delete process.env.QA_STEP_TIMEOUT_MS;
  });

  it('aiAssertWithSelfHeal passes on first attempt', async () => {
    const agent = mockAgent();
    const outcome = await aiAssertWithSelfHeal(agent as never, 'Page shows success');
    expect(outcome.pass).toBe(true);
    expect(agent.aiAssert).toHaveBeenCalledTimes(1);
  });

  it('aiAssertWithSelfHeal requests the raw structured verdict (keepRawResponse)', async () => {
    // Regression guard: without keepRawResponse the real aiAssert returns
    // undefined on a truthy assertion, which made every passing check read as
    // a failure. The option must always be forwarded.
    const aiAssert = vi.fn().mockResolvedValue({ pass: true, thought: 'ok' });
    const agent = mockAgent({ aiAssert });
    await aiAssertWithSelfHeal(agent as never, 'Page shows success');
    expect(aiAssert).toHaveBeenCalledWith(
      'Page shows success',
      undefined,
      expect.objectContaining({ keepRawResponse: true }),
    );
  });

  it('aiAssertWithSelfHeal treats an undefined response as a failure, not a pass', async () => {
    // Mirrors the real contract when keepRawResponse is omitted: a truthy
    // assertion resolves to undefined. We must never silently coerce that to a
    // pass — surface it as a (non-)result so the misconfiguration is visible.
    const agent = mockAgent({ aiAssert: vi.fn().mockResolvedValue(undefined) });
    const outcome = await aiAssertWithSelfHeal(agent as never, 'Page shows success');
    expect(outcome.pass).toBe(false);
  });

  it('aiAssertWithSelfHeal retries on a transient model error then passes', async () => {
    const agent = mockAgent({
      aiAssert: vi
        .fn()
        .mockRejectedValueOnce(new Error('failed to call AI model service: empty content'))
        .mockResolvedValue({ pass: true, thought: 'now visible' }),
    });
    const outcome = await aiAssertWithSelfHeal(agent as never, 'Page shows success');
    expect(outcome.pass).toBe(true);
    expect(outcome.healed).toBe(true);
    expect(agent.aiAssert).toHaveBeenCalledTimes(2);
  });

  it('aiAssertWithSelfHeal reports an app defect when the assertion is false', async () => {
    const agent = mockAgent({
      aiAssert: vi.fn().mockResolvedValue({ pass: false, thought: 'error banner shown' }),
    });
    const outcome = await aiAssertWithSelfHeal(agent as never, 'No error is shown');
    expect(outcome.pass).toBe(false);
    expect(outcome.errorClass).toBe('assertion');
    expect(outcome.thought).toBe('error banner shown');
  });

  it('flushCacheIfWarmUp calls flushCache in warm-up mode', async () => {
    const agent = mockAgent();
    await flushCacheIfWarmUp(agent as never, 'warm-up');
    expect(agent.flushCache).toHaveBeenCalledTimes(1);
  });

  it('flushCacheIfWarmUp skips in regression mode', async () => {
    const agent = mockAgent();
    await flushCacheIfWarmUp(agent as never, 'regression');
    expect(agent.flushCache).not.toHaveBeenCalled();
  });
});
