import { afterEach, describe, expect, it } from 'vitest';
import {
  applyThinkingControls,
  stripThinkingArtifacts,
  thinkingDisabled,
} from '../../../src/config/thinking.js';

const original = process.env.LMSTUDIO_DISABLE_THINKING;

afterEach(() => {
  if (original === undefined) delete process.env.LMSTUDIO_DISABLE_THINKING;
  else process.env.LMSTUDIO_DISABLE_THINKING = original;
});

describe('thinkingDisabled', () => {
  it('defaults to enabled (true) when unset', () => {
    delete process.env.LMSTUDIO_DISABLE_THINKING;
    expect(thinkingDisabled()).toBe(true);
  });

  it('respects an explicit opt-out', () => {
    process.env.LMSTUDIO_DISABLE_THINKING = 'false';
    expect(thinkingDisabled()).toBe(false);
  });
});

describe('applyThinkingControls', () => {
  it('injects enable_thinking=false in both places', () => {
    delete process.env.LMSTUDIO_DISABLE_THINKING;
    const body: Record<string, unknown> = { model: 'qwen', messages: [] };
    expect(applyThinkingControls(body)).toBe(true);
    expect(body.enable_thinking).toBe(false);
    expect((body.chat_template_kwargs as Record<string, unknown>).enable_thinking).toBe(false);
  });

  it('is a no-op when disabled via env', () => {
    process.env.LMSTUDIO_DISABLE_THINKING = 'false';
    const body: Record<string, unknown> = { model: 'qwen' };
    expect(applyThinkingControls(body)).toBe(false);
    expect(body.enable_thinking).toBeUndefined();
  });

  it('preserves existing chat_template_kwargs', () => {
    delete process.env.LMSTUDIO_DISABLE_THINKING;
    const body: Record<string, unknown> = { chat_template_kwargs: { foo: 1 } };
    applyThinkingControls(body);
    expect(body.chat_template_kwargs).toMatchObject({ foo: 1, enable_thinking: false });
  });
});

describe('stripThinkingArtifacts', () => {
  it('removes a leading think block', () => {
    expect(stripThinkingArtifacts('<think>reasoning</think>\n{"ok":true}')).toBe('{"ok":true}');
  });

  it('leaves plain content intact', () => {
    expect(stripThinkingArtifacts('  hello  ')).toBe('hello');
  });
});
