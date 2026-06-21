import fs from 'node:fs/promises';
import path from 'node:path';
import { parse } from 'yaml';
import { getCacheId } from '../config/env.js';
import {
  getGeneratedDir,
  getMidsceneCacheDir,
  getPlansDir,
} from '../server/data-paths.js';

/**
 * Transpiles a Midscene warm-up cache into a deterministic, standalone
 * Playwright spec. Actions resolved during the vision warm-up pass (with their
 * cached XPaths) become plain Playwright calls — no LLM at regression time.
 *
 * Locator priority (best practice): a stable accessibility/text locator is used
 * when one can be derived from the element description; the cached `xpath=` is
 * the deterministic fallback. Semantic assertions that cannot be reduced to the
 * DOM are emitted as annotated TODOs (they remain the rare LLM call).
 */

interface LocateCacheEntry {
  type: 'locate';
  prompt: string;
  cache?: { xpaths?: string[] };
}

interface PlanCacheEntry {
  type: 'plan';
  prompt: string;
  yamlWorkflow?: string;
}

type CacheEntry = LocateCacheEntry | PlanCacheEntry | { type: string; prompt?: string };

interface CacheFile {
  cacheId?: string;
  caches?: CacheEntry[];
}

interface FlowItem {
  locate?: string | { prompt?: string };
  direction?: 'up' | 'down' | 'left' | 'right';
  distance?: number;
  scrollType?: string;
  aiTap?: string;
  aiHover?: string;
  aiDoubleClick?: string;
  aiRightClick?: string;
  aiInput?: string;
  aiKeyboardPress?: string;
  aiScroll?: string;
  aiWaitFor?: string;
  sleep?: number;
  value?: string;
  keyName?: string;
}

export interface TranspileResult {
  specPath: string;
  code: string;
  steps: number;
  actions: number;
  resolvedLocators: number;
  unresolvedLocators: number;
}

const ACTION_KEYS = [
  'aiTap',
  'aiHover',
  'aiDoubleClick',
  'aiRightClick',
  'aiInput',
  'aiKeyboardPress',
  'aiScroll',
  'aiWaitFor',
  'sleep',
] as const;

function jsString(value: string): string {
  return JSON.stringify(value);
}

function extractQuotedText(description: string): string | null {
  const match = description.match(/'([^']+)'|"([^"]+)"|«([^»]+)»/);
  return match ? (match[1] ?? match[2] ?? match[3] ?? null) : null;
}

function locateDescription(item: FlowItem): string | undefined {
  if (typeof item.locate === 'string') return item.locate;
  if (item.locate && typeof item.locate === 'object') return item.locate.prompt;
  return undefined;
}

/** Builds a Playwright locator expression, preferring a stable text locator. */
function buildLocatorExpr(
  description: string | undefined,
  xpathMap: Map<string, string>,
): { expr: string | null; resolved: boolean } {
  if (!description) return { expr: null, resolved: false };

  const xpath = xpathMap.get(description.trim());
  const quoted = extractQuotedText(description);

  if (quoted) {
    // Accessibility-first: prefer a visible-text locator, fall back to xpath.
    if (xpath) {
      return {
        expr: `page.getByText(${jsString(quoted)}, { exact: false }).or(page.locator(${jsString(
          'xpath=' + xpath,
        )})).first()`,
        resolved: true,
      };
    }
    return { expr: `page.getByText(${jsString(quoted)}, { exact: false }).first()`, resolved: true };
  }

  if (xpath) {
    return { expr: `page.locator(${jsString('xpath=' + xpath)})`, resolved: true };
  }

  return { expr: null, resolved: false };
}

function scrollDeltas(direction: string | undefined, distance?: number): [number, number] {
  const d = distance && distance > 0 ? distance : 600;
  switch (direction) {
    case 'up':
      return [0, -d];
    case 'left':
      return [-d, 0];
    case 'right':
      return [d, 0];
    case 'down':
    default:
      return [0, d];
  }
}

function emitFlowItem(
  item: FlowItem,
  xpathMap: Map<string, string>,
  counters: { resolved: number; unresolved: number; actions: number },
): string[] {
  const lines: string[] = [];
  const actionKey = ACTION_KEYS.find((key) => item[key] !== undefined);
  if (!actionKey) return lines;

  counters.actions++;
  const desc = locateDescription(item);
  const { expr, resolved } = buildLocatorExpr(desc, xpathMap);
  if (desc) {
    if (resolved) counters.resolved++;
    else counters.unresolved++;
  }

  const guardUnresolved = (): boolean => {
    if (desc && !expr) {
      lines.push(`    // [unresolved locator] ${desc}`);
      lines.push(`    await page.waitForTimeout(300); // skipped: no cached locator`);
      return true;
    }
    return false;
  };

  switch (actionKey) {
    case 'aiTap':
      if (guardUnresolved()) break;
      lines.push(`    await ${expr}.click();`);
      break;
    case 'aiHover':
      if (guardUnresolved()) break;
      lines.push(`    await ${expr}.hover();`);
      break;
    case 'aiDoubleClick':
      if (guardUnresolved()) break;
      lines.push(`    await ${expr}.dblclick();`);
      break;
    case 'aiRightClick':
      if (guardUnresolved()) break;
      lines.push(`    await ${expr}.click({ button: 'right' });`);
      break;
    case 'aiInput': {
      if (guardUnresolved()) break;
      const value = item.aiInput ?? item.value ?? '';
      lines.push(`    await ${expr}.fill(${jsString(String(value))});`);
      break;
    }
    case 'aiKeyboardPress': {
      const key = item.aiKeyboardPress || item.keyName || 'Enter';
      if (expr) {
        lines.push(`    await ${expr}.press(${jsString(String(key))});`);
      } else {
        lines.push(`    await page.keyboard.press(${jsString(String(key))});`);
      }
      break;
    }
    case 'aiScroll': {
      const [dx, dy] = scrollDeltas(item.direction, item.distance ?? undefined);
      lines.push(`    await page.mouse.wheel(${dx}, ${dy});`);
      break;
    }
    case 'aiWaitFor':
      lines.push(`    await page.waitForLoadState('networkidle').catch(() => {});`);
      break;
    case 'sleep':
      lines.push(`    await page.waitForTimeout(${Number(item.sleep) || 1000});`);
      break;
  }

  return lines;
}

export function generateSpecCode(input: {
  scenarioId: string;
  targetUrl: string;
  cache: CacheFile;
  assertions: string[];
}): Omit<TranspileResult, 'specPath'> {
  const { scenarioId, targetUrl, cache, assertions } = input;

  const xpathMap = new Map<string, string>();
  for (const entry of cache.caches ?? []) {
    if (entry.type === 'locate') {
      const locateEntry = entry as LocateCacheEntry;
      const xpath = locateEntry.cache?.xpaths?.[0];
      if (locateEntry.prompt && xpath) {
        xpathMap.set(locateEntry.prompt.trim(), xpath);
      }
    }
  }

  const counters = { resolved: 0, unresolved: 0, actions: 0 };
  const body: string[] = [];
  let steps = 0;

  for (const entry of cache.caches ?? []) {
    if (entry.type !== 'plan') continue;
    const planEntry = entry as PlanCacheEntry;
    steps++;
    body.push('');
    body.push(`    // ── Step ${steps}: ${planEntry.prompt?.replace(/\s+/g, ' ').trim()}`);

    if (!planEntry.yamlWorkflow) continue;
    let workflow: { tasks?: Array<{ flow?: FlowItem[] }> };
    try {
      workflow = parse(planEntry.yamlWorkflow) as { tasks?: Array<{ flow?: FlowItem[] }> };
    } catch {
      body.push(`    // [warn] could not parse cached workflow for this step`);
      continue;
    }

    for (const task of workflow.tasks ?? []) {
      for (const item of task.flow ?? []) {
        body.push(...emitFlowItem(item, xpathMap, counters));
      }
    }
  }

  const assertionBlock = assertions.length
    ? assertions
        .map(
          (a) =>
            `    // SEMANTIC ASSERT (requires vision agent): ${a.replace(/\s+/g, ' ').trim()}`,
        )
        .join('\n')
    : '    // (no assertions)';

  const code = `// AUTO-GENERATED by src/codegen/transpile.ts — do not edit by hand.
// Deterministic replay of the '${scenarioId}' warm-up cache (no LLM at runtime).
// Regenerate with: npm run qa:transpile ${scenarioId}
import { test, expect } from '@playwright/test';

test.describe('generated: ${scenarioId}', () => {
  test('deterministic replay', async ({ page }) => {
    await page.goto(${jsString(targetUrl)}, { waitUntil: 'domcontentloaded' });
${body.join('\n')}

    // Smoke check that the page is still alive after the replayed actions.
    await expect(page.locator('body')).toBeVisible();

    // Semantic assertions below are intentionally NOT auto-verified here; they
    // require the Midscene vision agent (run the scenario in regression mode).
${assertionBlock}
  });
});
`;

  return {
    code,
    steps,
    actions: counters.actions,
    resolvedLocators: counters.resolved,
    unresolvedLocators: counters.unresolved,
  };
}

async function readCacheFile(scenarioId: string): Promise<CacheFile | null> {
  const cachePath = path.join(getMidsceneCacheDir(), `${getCacheId(scenarioId)}.cache.yaml`);
  try {
    const raw = await fs.readFile(cachePath, 'utf-8');
    return parse(raw) as CacheFile;
  } catch {
    return null;
  }
}

async function readPlan(scenarioId: string): Promise<{ targetUrl?: string; assertions: string[] }> {
  try {
    const raw = await fs.readFile(path.join(getPlansDir(), `${scenarioId}.json`), 'utf-8');
    const plan = JSON.parse(raw) as { targetUrl?: string; assertions?: string[] };
    return { targetUrl: plan.targetUrl, assertions: plan.assertions ?? [] };
  } catch {
    return { assertions: [] };
  }
}

export async function transpileScenario(
  scenarioId: string,
  opts?: { targetUrl?: string },
): Promise<TranspileResult | null> {
  const cache = await readCacheFile(scenarioId);
  if (!cache || !(cache.caches ?? []).some((c) => c.type === 'plan')) {
    return null;
  }

  const plan = await readPlan(scenarioId);
  const targetUrl = opts?.targetUrl ?? plan.targetUrl ?? process.env.QA_TARGET_URL ?? 'https://example.com';

  const generated = generateSpecCode({
    scenarioId,
    targetUrl,
    cache,
    assertions: plan.assertions,
  });

  const outDir = getGeneratedDir();
  await fs.mkdir(outDir, { recursive: true });
  const specPath = path.join(outDir, `${scenarioId}.spec.ts`);
  await fs.writeFile(specPath, generated.code, 'utf-8');

  return { specPath, ...generated };
}

async function main(): Promise<void> {
  const scenarioId = process.argv[2];
  if (!scenarioId) {
    console.error('Usage: npm run qa:transpile <scenarioId>');
    process.exit(1);
  }
  const result = await transpileScenario(scenarioId);
  if (!result) {
    console.error(`[transpile] No usable cache found for "${scenarioId}". Run a warm-up first.`);
    process.exit(1);
  }
  console.log(
    `[transpile] ${result.specPath} — steps=${result.steps}, actions=${result.actions}, ` +
      `locators resolved=${result.resolvedLocators}/${result.resolvedLocators + result.unresolvedLocators}`,
  );
}

const entryArg = process.argv[1]?.replace(/\\/g, '/');
if (entryArg?.endsWith('transpile.ts') || entryArg?.endsWith('transpile.js')) {
  main().catch((error) => {
    console.error(error);
    process.exit(1);
  });
}
