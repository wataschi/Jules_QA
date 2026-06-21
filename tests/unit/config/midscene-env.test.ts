import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bootstrapMidsceneEnv } from '../../../src/config/midscene-env.js';

describe('bootstrapMidsceneEnv', () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    for (const key of [
      'MIDSCENE_OPENAI_BASE_URL',
      'MIDSCENE_OPENAI_API_KEY',
      'OPENAI_BASE_URL',
      'OPENAI_API_KEY',
      'MIDSCENE_VQA_MODEL_NAME',
      'MIDSCENE_VQA_OPENAI_BASE_URL',
      'MIDSCENE_VQA_OPENAI_API_KEY',
      'MIDSCENE_PLANNING_MODEL_NAME',
      'MIDSCENE_PLANNING_OPENAI_BASE_URL',
      'MIDSCENE_PLANNING_OPENAI_API_KEY',
      'MIDSCENE_USE_QWEN3_VL',
      'MIDSCENE_VQA_VL_MODE',
      'MIDSCENE_PLANNING_VL_MODE',
      'MIDSCENE_MODEL_BASE_URL',
      'MIDSCENE_MODEL_API_KEY',
      'MIDSCENE_MODEL_NAME',
      'MIDSCENE_MODEL_FAMILY',
      'LMSTUDIO_PROXY_ENABLED',
      'LMSTUDIO_PROXY_PORT',
    ]) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const [key, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });

  it('maps MIDSCENE_MODEL_* to OpenAI-compatible keys (proxy disabled)', () => {
    process.env.LMSTUDIO_PROXY_ENABLED = 'false';
    process.env.MIDSCENE_MODEL_BASE_URL = 'http://llm.test/v1';
    process.env.MIDSCENE_MODEL_API_KEY = 'test-key';
    process.env.MIDSCENE_MODEL_NAME = 'test-model';

    bootstrapMidsceneEnv();

    expect(process.env.MIDSCENE_OPENAI_BASE_URL).toBe('http://llm.test/v1');
    expect(process.env.MIDSCENE_OPENAI_API_KEY).toBe('test-key');
    expect(process.env.MIDSCENE_VQA_MODEL_NAME).toBe('test-model');
    expect(process.env.MIDSCENE_PLANNING_MODEL_NAME).toBe('test-model');
  });

  it('routes model traffic through the local webp->png proxy when enabled', () => {
    process.env.LMSTUDIO_PROXY_ENABLED = 'true';
    process.env.LMSTUDIO_PROXY_PORT = '3941';
    process.env.MIDSCENE_MODEL_BASE_URL = 'https://macstudio.example/v1';
    process.env.MIDSCENE_MODEL_NAME = 'test-model';

    bootstrapMidsceneEnv();

    expect(process.env.MIDSCENE_OPENAI_BASE_URL).toBe('http://127.0.0.1:3941/v1');
    expect(process.env.MIDSCENE_VQA_OPENAI_BASE_URL).toBe('http://127.0.0.1:3941/v1');
    expect(process.env.MIDSCENE_PLANNING_OPENAI_BASE_URL).toBe('http://127.0.0.1:3941/v1');
  });

  it('does not overwrite existing MIDSCENE_OPENAI_* keys', () => {
    process.env.MIDSCENE_MODEL_BASE_URL = 'http://legacy/v1';
    process.env.MIDSCENE_OPENAI_BASE_URL = 'http://explicit/v1';

    bootstrapMidsceneEnv();

    expect(process.env.MIDSCENE_OPENAI_BASE_URL).toBe('http://explicit/v1');
  });

  it('enables qwen3-vl flags for qwen3-vl family', () => {
    process.env.MIDSCENE_MODEL_FAMILY = 'qwen3-vl';
    process.env.MIDSCENE_MODEL_BASE_URL = 'http://llm/v1';

    bootstrapMidsceneEnv();

    expect(process.env.MIDSCENE_USE_QWEN3_VL).toBe('true');
    expect(process.env.MIDSCENE_VQA_VL_MODE).toBe('qwen3-vl');
  });
});
