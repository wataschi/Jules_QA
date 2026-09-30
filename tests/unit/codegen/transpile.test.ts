import fs from 'node:fs/promises';
import path from 'node:path';
import { stringify } from 'yaml';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateSpecCode, transpileScenario } from '../../../src/codegen/transpile.js';
import { getCacheId, resetEnvCache, scenarioKey } from '../../../src/config/env.js';
import {
  clearWorkspaceEnv,
  createTempWorkspace,
  type TempWorkspace,
} from '../../helpers/temp-workspace.js';

function workflow(flow: unknown[]): string {
  return stringify({ tasks: [{ name: 'task', flow }] });
}

describe('generateSpecCode', () => {
  it('emits deterministic Playwright actions from a cache', () => {
    const cache = {
      cacheId: 'jules-demo',
      caches: [
        {
          type: 'plan',
          prompt: 'Click the search button',
          yamlWorkflow: workflow([{ aiTap: '', locate: "The 'Search' button" }]),
        },
        {
          type: 'plan',
          prompt: 'Type a query',
          yamlWorkflow: workflow([{ aiInput: 'hello world', locate: 'The query input field' }]),
        },
        {
          type: 'plan',
          prompt: 'Scroll down',
          yamlWorkflow: workflow([{ aiScroll: '', direction: 'down' }]),
        },
        {
          type: 'locate',
          prompt: "The 'Search' button",
          cache: { xpaths: ['/html/body/button[1]'] },
        },
        {
          type: 'locate',
          prompt: 'The query input field',
          cache: { xpaths: ['/html/body/input[1]'] },
        },
      ],
    };

    const result = generateSpecCode({
      scenarioId: 'demo',
      targetUrl: 'https://example.com',
      cache,
      assertions: ['Results are shown'],
    });

    expect(result.steps).toBe(3);
    expect(result.actions).toBe(3);
    expect(result.resolvedLocators).toBe(2);
    expect(result.code).toContain("await page.goto(\"https://example.com\"");
    expect(result.code).toContain('.click();');
    expect(result.code).toContain('.fill("hello world");');
    expect(result.code).toContain('await page.mouse.wheel(0, 600);');
    expect(result.code).toContain('SEMANTIC ASSERT (requires vision agent): Results are shown');
    // accessibility-first locator preferred for the quoted button text
    expect(result.code).toContain('getByText("Search"');
  });

  it('marks unresolved locators without breaking generation', () => {
    const cache = {
      caches: [
        {
          type: 'plan',
          prompt: 'Click something uncached',
          yamlWorkflow: workflow([{ aiTap: '', locate: 'an element with no cached xpath' }]),
        },
      ],
    };

    const result = generateSpecCode({
      scenarioId: 'demo2',
      targetUrl: 'https://example.com',
      cache,
      assertions: [],
    });

    expect(result.unresolvedLocators).toBe(1);
    expect(result.code).toContain('[unresolved locator]');
  });
});

describe('transpileScenario artifact naming', () => {
  let ws: TempWorkspace;
  const targetUrl = 'https://transpile.example/app';

  beforeEach(async () => {
    ws = await createTempWorkspace();
    clearWorkspaceEnv();
    process.env.MIDSCENE_RUN_ROOT = ws.midsceneDir;
    process.env.GENERATED_DIR = path.join(ws.root, 'generated');
    process.env.QA_TARGET_URL = targetUrl;
    resetEnvCache();
    await fs.mkdir(path.join(ws.midsceneDir, 'cache'), { recursive: true });
  });

  afterEach(async () => {
    delete process.env.GENERATED_DIR;
    delete process.env.QA_TARGET_URL;
    clearWorkspaceEnv();
    resetEnvCache();
    await ws.cleanup();
  });

  async function writeCache(cacheId: string): Promise<void> {
    await fs.writeFile(
      path.join(ws.midsceneDir, 'cache', `${cacheId}.cache.yaml`),
      stringify({
        cacheId,
        caches: [
          {
            type: 'plan',
            prompt: 'Click the search button',
            yamlWorkflow: workflow([{ aiTap: '', locate: "The 'Search' button" }]),
          },
        ],
      }),
      'utf-8',
    );
  }

  it('writes generated/<key>.spec.ts', async () => {
    await writeCache(getCacheId('naming-demo', targetUrl));

    const result = await transpileScenario('naming-demo', { targetUrl });
    expect(result).not.toBeNull();
    expect(path.basename(result!.specPath)).toBe(`${scenarioKey('naming-demo', targetUrl)}.spec.ts`);
  });

  it('reads a legacy cache file without the hash as a fallback', async () => {
    // Стара назва без хеша — наявні дані не мають зникати.
    await writeCache('jules-legacy-demo');

    const result = await transpileScenario('legacy-demo', { targetUrl });
    expect(result).not.toBeNull();
    expect(result!.actions).toBe(1);
    // Спека все одно пишеться під новим ключем.
    expect(path.basename(result!.specPath)).toBe(`${scenarioKey('legacy-demo', targetUrl)}.spec.ts`);
  });
});
