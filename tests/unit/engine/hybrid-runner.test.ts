import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resetEnvCache, scenarioKey } from '../../../src/config/env.js';
import { executeChecklist } from '../../../src/engine/hybrid-runner.js';
import { loadRunResults } from '../../../src/engine/results.js';
import type { Checklist } from '../../../src/planning/types.js';
import {
  applyWorkspaceEnv,
  clearWorkspaceEnv,
  createTempWorkspace,
  type TempWorkspace,
} from '../../helpers/temp-workspace.js';

type ExecuteArgs = Parameters<typeof executeChecklist>[0];

/** Сторінка-заглушка: без блокерів, з робочими goto/locator. */
function mockPage(): ExecuteArgs['page'] {
  return {
    goto: async () => undefined,
    title: async () => 'Заглушка',
    waitForLoadState: async () => undefined,
    keyboard: { press: async () => undefined, type: async () => undefined },
    locator: () => ({
      count: async () => 0,
      first: () => ({ isVisible: async () => false }),
      isVisible: async () => false,
      innerText: async () => '',
    }),
  } as unknown as ExecuteArgs['page'];
}

/** Агент, який падає на кроці з заданим індексом (1-based) і проходить решту. */
function mockAgent(failOnStep: number): ExecuteArgs['agent'] {
  let stepCalls = 0;
  return {
    aiAction: async (instruction: string) => {
      stepCalls++;
      if (instruction.includes(`#${failOnStep}`)) {
        throw new Error(`boom on step ${failOnStep} (call ${stepCalls})`);
      }
    },
    aiAssert: async () => ({ pass: true, thought: 'ok' }),
    aiWaitFor: async () => undefined,
  } as unknown as ExecuteArgs['agent'];
}

function checklist(): Checklist {
  return {
    scenarioId: 'skip-demo',
    goal: 'Перевірити позначення пропущених кроків',
    targetUrl: 'https://skip.example/app',
    steps: ['Click button #1', 'Click button #2', 'Click button #3'],
    assertions: ['Final state A', 'Final state B'],
    checkpoints: [
      { afterStep: 1, assertion: 'Checkpoint after 1' },
      { afterStep: 3, assertion: 'Checkpoint after 3' },
    ],
    generatedAt: new Date().toISOString(),
  };
}

describe('executeChecklist — skipped bookkeeping', () => {
  let ws: TempWorkspace;

  beforeEach(async () => {
    ws = await createTempWorkspace();
    applyWorkspaceEnv(ws);
    process.env.QA_MODE = 'warm-up';
    process.env.QA_TARGET_URL = 'https://skip.example/app';
    // Не даємо self-heal розтягувати тест на хвилини.
    process.env.QA_STEP_TIMEOUT_MS = '5000';
    resetEnvCache();
  });

  afterEach(async () => {
    delete process.env.QA_STEP_TIMEOUT_MS;
    clearWorkspaceEnv();
    resetEnvCache();
    await ws.cleanup();
  });

  it('records unreached steps, checkpoints and assertions as skipped', async () => {
    await expect(
      executeChecklist({
        page: mockPage(),
        agent: mockAgent(2),
        checklist: checklist(),
      }),
    ).rejects.toThrow(/boom on step 2/);

    const results = await loadRunResults(
      scenarioKey('skip-demo', 'https://skip.example/app'),
    );
    expect(results).not.toBeNull();

    const steps = results!.steps.filter((s) => s.kind === 'step');
    const assertions = results!.steps.filter((s) => s.kind === 'assertion');

    // Крок 1 пройшов, крок 2 упав, крок 3 не досягнутий.
    expect(steps.map((s) => s.status)).toEqual(['passed', 'failed', 'skipped']);

    // Чекпойнт після кроку 1 оцінено; чекпойнт після кроку 3 і обидва фінальні
    // ассершени — пропущені.
    expect(assertions.filter((a) => a.status === 'skipped')).toHaveLength(3);
    expect(assertions.filter((a) => a.status === 'passed')).toHaveLength(1);
  });

  it('keeps summary.total stable regardless of where the run stopped', async () => {
    const totals: number[] = [];

    for (const failOn of [1, 2, 3]) {
      await expect(
        executeChecklist({
          page: mockPage(),
          agent: mockAgent(failOn),
          checklist: checklist(),
        }),
      ).rejects.toThrow();

      const results = await loadRunResults(
        scenarioKey('skip-demo', 'https://skip.example/app'),
      );
      totals.push(results!.summary.total);
    }

    // 3 кроки + 2 чекпойнти + 2 фінальні ассершени = 7 у КОЖНОМУ прогоні.
    expect(totals).toEqual([7, 7, 7]);
  });

  it('writes results under the URL-scoped key', async () => {
    await expect(
      executeChecklist({
        page: mockPage(),
        agent: mockAgent(1),
        checklist: checklist(),
      }),
    ).rejects.toThrow();

    // Інша ціль — інший ключ, тож результати не читаються «чужим» ключем.
    expect(await loadRunResults(scenarioKey('skip-demo', 'https://other.example'))).toBeNull();
    expect(await loadRunResults(scenarioKey('skip-demo', 'https://skip.example/app'))).not.toBeNull();
  });

  it('records nothing as skipped on a fully successful run', async () => {
    await executeChecklist({
      page: mockPage(),
      agent: mockAgent(0), // жоден крок не падає
      checklist: checklist(),
    });

    const results = await loadRunResults(
      scenarioKey('skip-demo', 'https://skip.example/app'),
    );
    expect(results!.summary.skipped).toBe(0);
    expect(results!.summary.total).toBe(7);
    expect(results!.passed).toBe(true);
  });

  it('records modelCalls per step', async () => {
    await expect(
      executeChecklist({
        page: mockPage(),
        agent: mockAgent(1),
        checklist: checklist(),
      }),
    ).rejects.toThrow();

    const results = await loadRunResults(
      scenarioKey('skip-demo', 'https://skip.example/app'),
    );
    // Проксі в тесті не піднятий, а локальний fetch-хук нічого не бачив, тож
    // чесна відповідь — «невідомо», а не вигаданий нуль: саме через вигаданий
    // нуль реальні прогони показували 0 викликів там, де модель працювала.
    for (const step of results!.steps) {
      if (step.status === 'skipped') {
        // Пропущений крок нічого не викликав — тут нуль чесний.
        expect(step.modelCalls).toBe(0);
      } else {
        expect(step.modelCalls).toBeUndefined();
      }
    }
    expect(results!.summary.modelCalls).toBe(0);
    expect(results!.summary.skipped).toBeGreaterThan(0);
  });
});
