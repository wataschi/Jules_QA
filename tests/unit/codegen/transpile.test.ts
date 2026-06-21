import { stringify } from 'yaml';
import { describe, expect, it } from 'vitest';
import { generateSpecCode } from '../../../src/codegen/transpile.js';

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
