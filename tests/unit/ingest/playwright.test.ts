import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { parsePlaywrightJson, ReportParseError } from '../../../src/ingest/index.js';

const content = readFileSync(path.resolve(import.meta.dirname, '../../fixtures/ingest/playwright-report.json'), 'utf-8');
const REPO = '/home/runner/work/cyber/cyber';

describe('parsePlaywrightJson', () => {
  const results = parsePlaywrightJson(content, { rootDir: REPO });

  it('дає окремий результат на кожен project і додає [project] у fullName', () => {
    expect(results).toHaveLength(6);
    expect(results.map((item) => item.fullName)).toEqual([
      'сторінка актів відкривається [chromium]',
      'сторінка актів відкривається [firefox]',
      'Акти > CYBER-ACT-014 акт без суми не зберігається [chromium]',
      'Акти > CYBER-ACT-014 акт без суми не зберігається [firefox]',
      'Акти > Видалення > CYBER-ACT-020 видалення з підтвердженням [chromium]',
      'Акти > Видалення > CYBER-ACT-020 видалення з підтвердженням [firefox]',
    ]);
    expect(results.every((item) => item.framework === 'playwright')).toBe(true);
  });

  it('переводить файл із config.rootDir (testDir) у шлях від кореня репо', () => {
    expect(new Set(results.map((item) => item.file))).toEqual(new Set(['e2e/acts/acts.spec.ts']));
  });

  it('без кореня репо лишає шлях відносно config.rootDir', () => {
    const fallback = parsePlaywrightJson(content, { rootDir: '/elsewhere' });
    expect(fallback[0]!.file).toBe('acts/acts.spec.ts');
  });

  it('flaky — це passed з retries > 0 і тривалістю останньої спроби', () => {
    expect(results[2]).toMatchObject({ status: 'passed', retries: 1, durationMs: 2310 });
    expect(results[2]!.error).toBeUndefined();
    expect(results[3]!.retries).toBeUndefined();
  });

  it('timedOut після всіх ретраїв — failed з текстом помилки', () => {
    expect(results[4]).toMatchObject({ status: 'failed', retries: 2, error: 'Test timeout of 30000ms exceeded.' });
  });

  it('skipped лишається skipped', () => {
    expect(results[5]!.status).toBe('skipped');
  });

  it('прибирає ANSI-кольори з помилки', () => {
    const json = JSON.parse(content);
    json.suites[0].suites[0].specs[0].tests[0].status = 'unexpected';
    json.suites[0].suites[0].specs[0].tests[0].results.pop();
    const [, , failed] = parsePlaywrightJson(JSON.stringify(json), { rootDir: REPO });
    expect(failed!.status).toBe('failed');
    expect(failed!.error).toBe('Error: expect(locator).toBeVisible() failed');
  });

  it('з одним project не додає [project] і відрізає абсолютний spec.file від rootDir', () => {
    const json = {
      config: { rootDir: '/repo/e2e', projects: [{ id: 'chromium', name: 'chromium' }] },
      suites: [
        {
          title: 'login.spec.ts',
          file: 'login.spec.ts',
          specs: [
            {
              title: 'входить',
              file: '/repo/e2e/login.spec.ts',
              tests: [{ projectId: 'chromium', projectName: 'chromium', results: [{ status: 'passed', duration: 10.4, retry: 0 }], status: 'expected' }],
            },
          ],
          suites: [],
        },
      ],
    };
    expect(parsePlaywrightJson(JSON.stringify(json), { rootDir: '/other' })).toEqual([
      { file: 'login.spec.ts', name: 'входить', fullName: 'входить', status: 'passed', durationMs: 10, framework: 'playwright' },
    ]);
  });

  it('для порожнього рядка повертає порожній список', () => {
    expect(parsePlaywrightJson('')).toEqual([]);
  });

  it('для зламаного JSON кидає помилку з назвою формату', () => {
    expect(() => parsePlaywrightJson(content.slice(0, 500))).toThrow(ReportParseError);
    expect(() => parsePlaywrightJson(content.slice(0, 500))).toThrow(/Playwright JSON: не вдалося розібрати JSON/);
  });

  it('для JSON без suites кидає зрозумілу помилку', () => {
    expect(() => parsePlaywrightJson('{"testResults": []}')).toThrow(/Playwright JSON: немає масиву «suites»/);
  });
});
