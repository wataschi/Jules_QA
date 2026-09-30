import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PREVIEW_LIMIT, runBulk, undoBulk } from '../../../src/registry/bulk.js';
import { getCase, listCases } from '../../../src/registry/cases-store.js';
import { listRevisions } from '../../../src/registry/revisions-store.js';
import { createTempRegistry, seedCase, seedProject, type TempRegistry } from './temp-db.js';

describe('масові операції', () => {
  let temp: TempRegistry;

  beforeEach(() => {
    temp = createTempRegistry();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it('dryRun за замовчуванням і не змінює дані', () => {
    const { project, section } = seedProject();
    const target = seedCase(project.id, section.id, { title: 'Акти недоступні' });

    const result = runBulk({
      projectId: project.id,
      operation: { op: 'replace-text', find: 'Акти', replace: 'Договори', fields: ['title'] },
    } as never);

    expect(result.applied).toBe(false);
    expect(result.batchId).toBeUndefined();
    expect(result.affected).toBe(1);
    expect(result.preview[0]).toMatchObject({
      caseId: target.id,
      field: 'title',
      before: 'Акти недоступні',
      after: 'Договори недоступні',
      occurrences: 1,
    });
    expect(getCase(target.id)?.title).toBe('Акти недоступні');
    expect(getCase(target.id)?.version).toBe(1);
  });

  it('рахує точну кількість входжень, а не кількість кейсів', () => {
    const { project, section } = seedProject();
    seedCase(project.id, section.id, {
      title: 'акти і акти',
      checks: ['перевірити акти', 'акти акти акти'],
      preconditions: 'акти є',
    });

    const result = runBulk({
      projectId: project.id,
      operation: {
        op: 'replace-text',
        find: 'акти',
        replace: 'договори',
        fields: ['title', 'checks', 'preconditions'],
      },
    } as never);

    // 2 в заголовку + 1 + 3 у перевірках + 1 у передумовах
    expect(result.occurrences).toBe(7);
    expect(result.affected).toBe(1);
    expect(result.preview.map((row) => row.field)).toEqual([
      'title',
      'checks[0]',
      'checks[1]',
      'preconditions',
    ]);
  });

  it('replace-text працює по checks[] і по steps', () => {
    const { project, section } = seedProject();
    const target = seedCase(project.id, section.id, {
      title: 'Незмінний',
      checks: ['акт перший', 'нічого', 'акт другий'],
      steps: [{ action: 'Відкрити акт', expected: 'акт видно' }],
    });

    const applied = runBulk({
      projectId: project.id,
      operation: { op: 'replace-text', find: 'акт', replace: 'договір', fields: ['checks', 'steps'] },
      dryRun: false,
    } as never);

    expect(applied.applied).toBe(true);
    const updated = getCase(target.id);
    expect(updated?.checks).toEqual(['договір перший', 'нічого', 'договір другий']);
    expect(updated?.steps).toEqual([{ action: 'Відкрити договір', expected: 'договір видно' }]);
    expect(updated?.title).toBe('Незмінний');
  });

  it('враховує регістр за прапорцем caseSensitive', () => {
    const { project, section } = seedProject();
    seedCase(project.id, section.id, { title: 'Акти і акти' });

    const insensitive = runBulk({
      projectId: project.id,
      operation: { op: 'replace-text', find: 'акти', replace: 'X', fields: ['title'], caseSensitive: false },
    } as never);
    expect(insensitive.occurrences).toBe(2);

    const sensitive = runBulk({
      projectId: project.id,
      operation: { op: 'replace-text', find: 'акти', replace: 'X', fields: ['title'], caseSensitive: true },
    } as never);
    expect(sensitive.occurrences).toBe(1);
  });

  it('підтримує регекс і групи заміни', () => {
    const { project, section } = seedProject();
    const target = seedCase(project.id, section.id, { title: 'Помилка 404 на сторінці' });

    runBulk({
      projectId: project.id,
      operation: {
        op: 'replace-text',
        find: '(\\d{3})',
        replace: 'код $1',
        fields: ['title'],
        regex: true,
      },
      dryRun: false,
    } as never);

    expect(getCase(target.id)?.title).toBe('Помилка код 404 на сторінці');
  });

  it('падає з поясненням на зламаному регексі', () => {
    const { project, section } = seedProject();
    seedCase(project.id, section.id, { title: 'будь-що' });
    expect(() =>
      runBulk({
        projectId: project.id,
        operation: { op: 'replace-text', find: '([', replace: '', fields: ['title'], regex: true },
      } as never),
    ).toThrow(/Некоректний регулярний вираз/);
  });

  it('set-field, add-tag, remove-tag, move і set-automation', () => {
    const { project, section, child } = seedProject();
    const a = seedCase(project.id, section.id, { title: 'A', tags: ['старий'] });
    const b = seedCase(project.id, section.id, { title: 'B' });

    runBulk({
      projectId: project.id,
      operation: { op: 'set-field', field: 'priority', value: 'P1' },
      dryRun: false,
    } as never);
    expect(getCase(a.id)?.priority).toBe('P1');
    expect(getCase(b.id)?.priority).toBe('P1');

    runBulk({
      projectId: project.id,
      operation: { op: 'add-tag', tags: ['регрес', 'смоук'] },
      dryRun: false,
    } as never);
    expect(getCase(b.id)?.tags).toEqual(['регрес', 'смоук']);

    runBulk({
      projectId: project.id,
      operation: { op: 'remove-tag', tags: ['старий'] },
      dryRun: false,
    } as never);
    expect(getCase(a.id)?.tags).toEqual(['регрес', 'смоук']);

    runBulk({
      projectId: project.id,
      caseIds: [a.id],
      operation: { op: 'move', sectionId: child.id },
      dryRun: false,
    } as never);
    expect(getCase(a.id)?.sectionId).toBe(child.id);
    expect(getCase(a.id)?.id).toBe(a.id);

    runBulk({
      projectId: project.id,
      operation: { op: 'set-automation', status: 'candidate' },
      dryRun: false,
    } as never);
    expect(getCase(a.id)?.automation.status).toBe('candidate');
  });

  it('delete без hard переводить у deprecated, з hard — видаляє', () => {
    const { project, section } = seedProject();
    const soft = seedCase(project.id, section.id, { title: 'Мʼяке видалення' });
    const hard = seedCase(project.id, section.id, { title: 'Жорстке видалення' });

    runBulk({
      projectId: project.id,
      caseIds: [soft.id],
      operation: { op: 'delete' },
      dryRun: false,
    } as never);
    expect(getCase(soft.id)?.status).toBe('deprecated');

    runBulk({
      projectId: project.id,
      caseIds: [hard.id],
      operation: { op: 'delete', hard: true },
      dryRun: false,
    } as never);
    expect(getCase(hard.id)).toBeNull();
  });

  it('усі ревізії пакета мають спільний batchId', () => {
    const { project, section } = seedProject();
    const a = seedCase(project.id, section.id, { title: 'акти A' });
    const b = seedCase(project.id, section.id, { title: 'акти B' });

    const applied = runBulk({
      projectId: project.id,
      operation: { op: 'replace-text', find: 'акти', replace: 'договори', fields: ['title'] },
      dryRun: false,
      reason: 'масова заміна акти→договори',
    } as never);

    expect(applied.batchId).toBeTruthy();
    for (const id of [a.id, b.id]) {
      const [latest] = listRevisions(id);
      expect(latest?.reason).toBe('масова заміна акти→договори');
      expect(latest?.patch.title?.before).toContain('акти');
      expect(latest?.patch.title?.after).toContain('договори');
    }
  });

  it('undo повертає значення before і пише нові ревізії', () => {
    const { project, section } = seedProject();
    const a = seedCase(project.id, section.id, { title: 'акти A', checks: ['акти чек'] });
    const b = seedCase(project.id, section.id, { title: 'акти B' });

    const applied = runBulk({
      projectId: project.id,
      operation: { op: 'replace-text', find: 'акти', replace: 'договори', fields: ['title', 'checks'] },
      dryRun: false,
    } as never);
    expect(getCase(a.id)?.title).toBe('договори A');

    const undo = undoBulk(applied.batchId as string);
    expect(undo.reverted).toBe(2);
    expect(undo.errors).toEqual([]);
    expect(getCase(a.id)?.title).toBe('акти A');
    expect(getCase(a.id)?.checks).toEqual(['акти чек']);
    expect(getCase(b.id)?.title).toBe('акти B');
    // 1 створення + 1 заміна + 1 відкат
    expect(getCase(a.id)?.version).toBe(3);
    expect(listRevisions(a.id)[0]?.reason).toContain('відкат пакета');
  });

  it('undo відновлює фізично видалені кейси', () => {
    const { project, section } = seedProject();
    const target = seedCase(project.id, section.id, {
      title: 'Буде видалено',
      checks: ['перевірка'],
      tags: ['тег'],
    });

    const applied = runBulk({
      projectId: project.id,
      caseIds: [target.id],
      operation: { op: 'delete', hard: true },
      dryRun: false,
    } as never);
    expect(getCase(target.id)).toBeNull();

    const undo = undoBulk(applied.batchId as string);
    expect(undo.restored).toBe(1);
    const restored = getCase(target.id);
    expect(restored?.title).toBe('Буде видалено');
    expect(restored?.checks).toEqual(['перевірка']);
    // відновлений кейс знову шукається
    expect(listCases({ projectId: project.id, filter: { q: 'видалено' } }).total).toBe(1);
  });

  it('undo невідомого пакета кидає помилку', () => {
    seedProject();
    expect(() => undoBulk('batch_нема')).toThrow(/не знайдено/);
  });

  it('preview обрізається на 200 рядках, affected лишається точним', () => {
    const { project, section } = seedProject();
    for (let i = 0; i < PREVIEW_LIMIT + 5; i += 1) {
      seedCase(project.id, section.id, { title: `акти ${i}` });
    }
    const result = runBulk({
      projectId: project.id,
      operation: { op: 'replace-text', find: 'акти', replace: 'договори', fields: ['title'] },
    } as never);

    expect(result.affected).toBe(PREVIEW_LIMIT + 5);
    expect(result.occurrences).toBe(PREVIEW_LIMIT + 5);
    expect(result.preview).toHaveLength(PREVIEW_LIMIT);
  });

  it('фільтр замість списку ID', () => {
    const { project, section, child } = seedProject();
    const inChild = seedCase(project.id, child.id, { title: 'акти у підсекції' });
    seedCase(project.id, section.id, { title: 'акти у батьку' });

    const result = runBulk({
      projectId: project.id,
      filter: { sectionIds: [child.id], includeSubsections: false },
      operation: { op: 'add-tag', tags: ['підсекція'] },
      dryRun: false,
    } as never);

    expect(result.affected).toBe(1);
    expect(getCase(inChild.id)?.tags).toEqual(['підсекція']);
  });

  it('операція без змін дає нуль зачеплених', () => {
    const { project, section } = seedProject();
    seedCase(project.id, section.id, { title: 'нічого спільного' });
    const result = runBulk({
      projectId: project.id,
      operation: { op: 'replace-text', find: 'акти', replace: 'договори', fields: ['title'] },
    } as never);
    expect(result.affected).toBe(0);
    expect(result.occurrences).toBe(0);
    expect(result.preview).toEqual([]);
  });
});
