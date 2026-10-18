/**
 * MCP-сервер Jules: через нього будь-який агент розробника з підтримкою MCP
 * бере задачі, отримує контекст (кейс, вимоги, схеми, кадри макета) і звітує.
 *
 * Режим без стану: на кожен POST /mcp — свій сервер і транспорт, а особу бере
 * з того самого входу, що й API (Tailscale або токен). Тож «хто взяв задачу»
 * — це завжди справжній розробник, а не те, що агент про себе написав.
 */
import fs from 'node:fs';
import type { Request, RequestHandler, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { z } from 'zod';
import { listProjects, requireProject } from '../registry/projects-store.js';
import { getCaseDetail } from '../registry/cases-store.js';
import { listCoverageForCase } from '../registry/coverage-store.js';
import { assetFilePath, getAsset, proposeReading, requireAsset } from '../registry/assets-store.js';
import { createProposal } from '../registry/proposals-store.js';
import { getSection, getSectionByCode } from '../registry/sections-store.js';
import { testsForCase } from '../registry/code-tests-store.js';
import {
  askQuestion,
  claimTask,
  createTask,
  failTask,
  heartbeatTask,
  inbox,
  listEvents,
  recordGiven,
  releaseTask,
  reportTask,
  requireTask,
} from '../registry/tasks-store.js';
import { getBlock, getSource } from '../registry/sources-store.js';
import { normalizeDraftCases } from '../registry/skills/write-cases.js';
import { createCase } from '../registry/cases-store.js';
import { casePrioritySchema, caseKindSchema, type Task } from '../registry/types.js';
import { requestAuthor } from './auth.js';
import { DATA_NOTICE, requirementViews, taskContext } from './task-context.js';
import { triageSchemaShape } from './workflow.js';
import { publishWeekly, weeklyPreview } from './weekly.js';

const MAX_IMAGES = 4;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

type Content = { type: 'text'; text: string } | { type: 'image'; data: string; mimeType: string };

function json(value: unknown): { content: Content[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }] };
}

function failure(error: unknown): { content: Content[]; isError: true } {
  return { content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }], isError: true };
}

function imageOf(assetId: string): Content | null {
  const asset = getAsset(assetId);
  if (!asset?.mediaType?.startsWith('image/') || asset.mediaType === 'image/svg+xml') return null;
  const file = assetFilePath(asset);
  if (!file) return null;
  const stat = fs.statSync(file);
  if (stat.size > MAX_IMAGE_BYTES) return null;
  return { type: 'image', data: fs.readFileSync(file).toString('base64'), mimeType: asset.mediaType };
}

/** Проєкт інструмента: явний або єдиний наявний. */
function projectOf(projectId?: string): string {
  if (projectId) return requireProject(projectId).id;
  const projects = listProjects();
  if (projects.length === 1) return projects[0].id;
  throw new Error(`Вкажіть projectId: ${projects.map((project) => project.id).join(', ') || 'проєктів ще немає'}`);
}

/** Сторінка «не віддавати агентам» → без вмісту, і в журнал це не йде. */
function withheldBlock(blockId: string): boolean {
  const block = getBlock(blockId);
  return Boolean(block && getSource(block.sourceId)?.noAgents);
}

function guard<T>(fn: () => T | Promise<T>) {
  return async () => {
    try {
      return (await fn()) as { content: Content[] };
    } catch (error) {
      return failure(error);
    }
  };
}

export function buildMcpServer(req: Request): McpServer {
  const holder = requestAuthor(req);
  const server = new McpServer(
    { name: 'jules-qa', version: '2.0.0' },
    {
      instructions:
        'Jules — хаб QA. Порядок: qa_inbox → запропонуй задачу розробнику → qa_claim → контекст → тест за конвенціями ' +
        '(ID кейса в назві) → PR → qa_report. Незрозуміло — qa_ask. Асерти наявних тестів змінюй лише в задачах change_test. ' +
        DATA_NOTICE,
    },
  );

  server.registerTool(
    'qa_inbox',
    {
      title: 'Задачі для мене',
      description:
        'Задачі, які агент може взяти: спершу ті, де розробник власник модуля, потім модулі змінених файлів. Нічого не бере в роботу.',
      inputSchema: { projectId: z.string().optional(), paths: z.array(z.string()).max(200).optional() },
    },
    async ({ projectId, paths }) =>
      guard(() => {
        const result = inbox(projectOf(projectId), { login: holder, paths });
        return json({
          total: result.total,
          tasks: result.tasks.map((task) => ({
            id: task.id,
            kind: task.kind,
            title: task.title,
            state: task.state,
            module: task.sectionName,
            priority: task.priority,
            ageHours: task.ageHours,
            mine: task.mine,
            touched: task.touched,
          })),
          hint: 'Запропонуй розробнику задачу й бери її лише після згоди (qa_claim).',
        });
      })(),
  );

  server.registerTool(
    'qa_claim',
    {
      title: 'Взяти задачу',
      description: 'Бере задачу з орендою (30 хв, продовжується qa_heartbeat) і повертає повний контекст: кейс, вимоги, кадри, тести, обговорення.',
      inputSchema: { taskId: z.string(), agent: z.string().max(100).optional(), model: z.string().max(100).optional() },
    },
    async ({ taskId, agent, model }) =>
      guard(() => {
        const task = claimTask(taskId, holder, { agent, model });
        const context = taskContext(task, { forAgent: true });
        recordGiven(task.id, holder, context.given);
        // Текст і якір — те, що саме просить QA (або що впало); це теж дані, а не інструкції.
        const detail = { ...brief(task), text: task.text, anchor: task.anchor, priority: task.priority, sectionId: task.sectionId };
        return json({ task: detail, context, events: listEvents(task.id) });
      })(),
  );

  server.registerTool(
    'qa_heartbeat',
    { title: 'Продовжити оренду', description: 'Продовжує оренду задачі, поки агент над нею працює.', inputSchema: { taskId: z.string() } },
    async ({ taskId }) => guard(() => json(brief(heartbeatTask(taskId, holder))))(),
  );

  server.registerTool(
    'qa_release',
    { title: 'Повернути задачу', description: 'Повертає задачу в чергу без результату.', inputSchema: { taskId: z.string(), reason: z.string().max(2000).optional() } },
    async ({ taskId, reason }) => guard(() => json(brief(releaseTask(taskId, holder, reason))))(),
  );

  server.registerTool(
    'qa_get_case',
    {
      title: 'Кейс',
      description: 'Кейс із перевірками, пов’язаними блоками вимог і наявними тестами в коді.',
      inputSchema: { caseId: z.string() },
    },
    async ({ caseId }) =>
      guard(() => {
        const detail = getCaseDetail(caseId);
        if (!detail) throw new Error(`Кейс «${caseId}» не знайдено`);
        const blockIds = listCoverageForCase(caseId).map((link) => link.blockId);
        return json({
          notice: DATA_NOTICE,
          case: detail,
          requirements: requirementViews(blockIds, { forAgent: true }),
          tests: testsForCase(caseId),
        });
      })(),
  );

  server.registerTool(
    'qa_get_requirement',
    {
      title: 'Блок вимоги',
      description: 'Текст блоку вимоги, текст схем, погоджені прочитання картинок і самі картинки (до 4).',
      inputSchema: { blockId: z.string(), taskId: z.string().optional(), images: z.boolean().default(true) },
    },
    async ({ blockId, taskId, images }) =>
      guard(() => {
        const [view] = requirementViews([blockId], { forAgent: true });
        if (!view) throw new Error(`Блок «${blockId}» не знайдено`);
        if (taskId && !view.withheld) recordGiven(taskId, holder, [{ kind: 'block', id: blockId }]);
        const content: Content[] = [{ type: 'text', text: JSON.stringify({ notice: DATA_NOTICE, requirement: view }, null, 2) }];
        if (images && !view.withheld) {
          for (const asset of view.assets.slice(0, MAX_IMAGES)) {
            const image = imageOf(asset.id);
            if (image) content.push(image);
          }
        }
        return { content };
      })(),
  );

  server.registerTool(
    'qa_get_screen',
    {
      title: 'Кадр макета',
      description: 'Кадр Figma: усі тексти (для точних перевірок), компоненти зі станами, маршрут застосунку і знімок кадру.',
      inputSchema: { blockId: z.string(), taskId: z.string().optional() },
    },
    async ({ blockId, taskId }) =>
      guard(() => {
        const [view] = requirementViews([blockId], { forAgent: true });
        if (!view || view.sourceKind !== 'figma') throw new Error(`Кадр «${blockId}» не знайдено`);
        if (taskId && !view.withheld) recordGiven(taskId, holder, [{ kind: 'block', id: blockId }]);
        const meta = getBlock(blockId)?.meta ?? {};
        const content: Content[] = [
          { type: 'text', text: JSON.stringify({ notice: DATA_NOTICE, screen: { ...view, components: meta.components ?? [] } }, null, 2) },
        ];
        const frame = view.assets.find((asset) => asset.kind === 'frame');
        const image = frame && !view.withheld ? imageOf(frame.id) : null;
        if (image) content.push(image);
        return { content };
      })(),
  );

  server.registerTool(
    'qa_get_asset',
    {
      title: 'Картинка чи схема',
      description: 'Одне вкладення: витягнутий текст, стан прочитання і сама картинка — для задач read_asset.',
      inputSchema: { assetId: z.string() },
    },
    async ({ assetId }) =>
      guard(() => {
        const asset = requireAsset(assetId);
        if (asset.blockId && withheldBlock(asset.blockId)) throw new Error('Вкладення зі сторінки «не віддавати агентам»');
        const image = imageOf(asset.id);
        const content: Content[] = [{ type: 'text', text: JSON.stringify({ notice: DATA_NOTICE, asset }, null, 2) }];
        if (image) content.push(image);
        return { content };
      })(),
  );

  server.registerTool(
    'qa_propose_plan',
    {
      title: 'Запропонувати план модуля',
      description:
        'План кейсів для задачі plan_module. Кожен кейс — одна перевірка, заголовок у стилі чек-листа, blockId — блок вимоги чи кадр, ' +
        'якщо кейс з нього. QA погоджує план у черзі «Погодження», після чого з’являться задачі add_test.',
      inputSchema: {
        taskId: z.string(),
        summary: z.string().max(5000),
        cases: z
          .array(
            z.object({
              title: z.string().min(1).max(300),
              kind: caseKindSchema.optional(),
              priority: casePrioritySchema.optional(),
              preconditions: z.string().max(2000).optional(),
              checks: z.array(z.string().min(1)).max(20).default([]),
              tags: z.array(z.string()).max(6).default([]),
              blockId: z.string().optional(),
              coverageKind: z.enum(['quote', 'derived']).default('derived'),
              rationale: z.string().max(1000).default(''),
            }),
          )
          .min(1)
          .max(200),
      },
    },
    async ({ taskId, summary, cases }) =>
      guard(() => {
        const task = requireTask(taskId);
        if (task.kind !== 'plan_module') throw new Error('План пропонується лише в задачі plan_module');
        if (task.state !== 'claimed' || task.leaseHolder !== holder) throw new Error('Спершу візьміть задачу (qa_claim)');
        const sectionId = task.sectionId ?? task.anchor.sectionId;
        if (!sectionId) throw new Error('У задачі плану немає модуля');

        const groups = new Map<string, typeof cases>();
        for (const item of cases) {
          const key = item.blockId ?? '';
          groups.set(key, [...(groups.get(key) ?? []), item]);
        }
        const warnings: string[] = [];
        const proposals: string[] = [];
        for (const [blockId, items] of groups) {
          const normalized = normalizeDraftCases(items, { blockId, maxPerBlock: 50, stage: 'агент' });
          warnings.push(...normalized.warnings);
          for (const draft of normalized.drafts) {
            const proposal = createProposal({
              projectId: task.projectId,
              kind: 'case_create',
              title: draft.case.title,
              rationale: draft.rationale,
              payload: { ...draft.case, sectionId, status: 'approved', automation: { status: 'candidate' } },
              origin: { taskId: task.id, blockId: blockId || undefined, skill: 'agent' },
              coverageKind: draft.coverageKind,
            });
            proposals.push(proposal.id);
          }
        }
        const reported = reportTask(task.id, holder, { summary, checks: [`Запропоновано кейсів: ${proposals.length}`] });
        return json({ task: brief(reported), proposals: proposals.length, warnings });
      })(),
  );

  server.registerTool(
    'qa_post_reading',
    {
      title: 'Описати картинку чи схему',
      description: 'Опис картинки (кроки флоу, поля, умови, стани, тексти) на погодження QA. У задачі read_asset — також звіт.',
      inputSchema: { assetId: z.string(), reading: z.string().min(1).max(20_000), taskId: z.string().optional() },
    },
    async ({ assetId, reading, taskId }) =>
      guard(() => {
        const asset = proposeReading(assetId, reading, holder);
        let task: Task | undefined;
        if (taskId) task = reportTask(taskId, holder, { summary: reading });
        return json({ asset, task: task ? brief(task) : undefined });
      })(),
  );

  server.registerTool(
    'qa_reserve_case',
    {
      title: 'Зарезервувати ID кейса',
      description: 'Для тесту, доданого без задачі: створює кейс-чернетку з ID для назви тесту; затвердження чекає QA.',
      inputSchema: {
        projectId: z.string().optional(),
        section: z.string().describe('Код модуля (ACT) або ID секції'),
        title: z.string().min(1).max(300),
        kind: caseKindSchema.optional(),
        priority: casePrioritySchema.optional(),
        checks: z.array(z.string().min(1)).max(20).optional(),
      },
    },
    async ({ projectId, section, title, kind, priority, checks }) =>
      guard(() => {
        const project = projectOf(projectId);
        const target = getSectionByCode(project, section.toUpperCase()) ?? getSection(section);
        if (!target || target.projectId !== project) throw new Error(`Модуль «${section}» не знайдено`);
        const created = createCase(
          project,
          { sectionId: target.id, title, kind, priority, checks: checks ?? [], status: 'draft', automation: { status: 'candidate' } } as never,
          { author: holder, reason: 'ID зарезервовано агентом для нового тесту' },
        );
        const proposal = createProposal({
          projectId: project,
          kind: 'case_update',
          title: `Кейс від агента: ${title}`,
          rationale: 'Агент додав тест без задачі й зарезервував для нього кейс. Погодьте, якщо перевірка потрібна.',
          payload: { caseId: created.id, changes: { status: 'approved' } },
          origin: { caseId: created.id, reserved: true },
        });
        return json({ caseId: created.id, proposalId: proposal.id, hint: `Додай «${created.id}» на початок назви тесту.` });
      })(),
  );

  server.registerTool(
    'qa_ask',
    {
      title: 'Запитати QA',
      description: 'Задача незрозуміла — питання QA. Задача переходить у needs_info і звільняє оренду; відповідь поверне її в чергу.',
      inputSchema: { taskId: z.string(), question: z.string().min(1).max(5000) },
    },
    async ({ taskId, question }) => guard(() => json(brief(askQuestion(taskId, holder, question))))(),
  );

  server.registerTool(
    'qa_raise_question',
    {
      title: 'Суперечність для людей',
      description: 'Вимога, макет і код розходяться — питання для QA й аналітика. Агент не обирає, хто правий.',
      inputSchema: {
        projectId: z.string().optional(),
        title: z.string().min(1).max(300),
        text: z.string().max(5000).default(''),
        caseId: z.string().optional(),
        blockId: z.string().optional(),
        file: z.string().optional(),
      },
    },
    async ({ projectId, title, text, caseId, blockId, file }) =>
      guard(() => {
        const { task } = createTask({
          projectId: projectOf(projectId),
          kind: 'question',
          title,
          text,
          anchor: { caseId, blockId, file },
          author: holder,
          authorKind: 'agent',
        });
        return json(brief(task));
      })(),
  );

  server.registerTool(
    'qa_report',
    {
      title: 'Звіт по задачі',
      description:
        'Результат: для add_test/change_test/remove_test/stabilize — обов’язково prUrl; checks — «що перевіряє» простими словами для QA. ' +
        'Для triage — classification (product_bug | test_bug | flaky | environment).',
      inputSchema: {
        taskId: z.string(),
        summary: z.string().min(1).max(10_000),
        checks: z.array(z.string().min(1)).max(50).default([]),
        tests: z.array(z.object({ file: z.string(), name: z.string(), caseIds: z.array(z.string()).default([]) })).max(200).default([]),
        prUrl: z.string().url().optional(),
        branch: z.string().max(200).optional(),
        triage: z
          .object({
            classification: z.enum(triageSchemaShape),
            defectTitle: z.string().max(300).optional(),
            severity: z.enum(['low', 'medium', 'high', 'critical']).optional(),
          })
          .optional(),
      },
    },
    async ({ taskId, summary, checks, tests, prUrl, branch, triage }) =>
      guard(() => {
        const before = requireTask(taskId);
        if (before.kind === 'triage' && !triage) throw new Error('Для розбору падіння вкажіть triage.classification');
        const task = reportTask(taskId, holder, { summary, checks, tests, prUrl, branch, triage: before.kind === 'triage' ? triage : undefined });
        const next =
          task.kind === 'triage'
            ? 'QA перевірить розбір у Jules; дефект, карантин чи задача на тест з’являться після підтвердження.'
            : 'QA перевірить намір у Jules, розробник — код у PR.';
        return json({ task: brief(task), next });
      })(),
  );

  server.registerTool(
    'qa_weekly_data',
    {
      title: 'Цифри тижня',
      description: 'Цифри тижневого звіту, пораховані Jules: прогони на main, дефекти, покриття, задачі, флейки. Числа не змінюй.',
      inputSchema: { projectId: z.string().optional(), week: z.string().regex(/^\d{4}-W\d{2}$/).optional() },
    },
    async ({ projectId, week }) => guard(() => json(weeklyPreview(projectOf(projectId), week)))(),
  );

  server.registerTool(
    'qa_weekly_publish',
    {
      title: 'Опублікувати тижневий звіт',
      description: 'Публікує звіт тижня в Jira (одна задача на тиждень, повторна публікація оновлює її) з висновками агента.',
      inputSchema: { projectId: z.string().optional(), week: z.string().regex(/^\d{4}-W\d{2}$/).optional(), insights: z.string().min(1).max(10_000) },
    },
    async ({ projectId, week, insights }) =>
      guard(async () => {
        if (req.principal && !['admin', 'qa'].includes(req.principal.role)) throw new Error('Публікує QA-лід або адміністратор');
        const published = await publishWeekly(projectOf(projectId), { week, insights });
        return json({ week: published.week, jira: published.jira, summary: published.report.summary });
      })(),
  );

  server.registerTool(
    'qa_fail',
    { title: 'Не вдалося', description: 'Задачу не вдалося виконати — з причиною.', inputSchema: { taskId: z.string(), reason: z.string().min(1).max(5000) } },
    async ({ taskId, reason }) => guard(() => json(brief(failTask(taskId, holder, reason))))(),
  );

  return server;
}

function brief(task: Task) {
  return {
    id: task.id,
    kind: task.kind,
    state: task.state,
    title: task.title,
    leaseUntil: task.leaseUntil,
    prUrl: task.prUrl,
  };
}

export function createMcpHandler(): RequestHandler {
  return async (req: Request, res: Response) => {
    if (req.method !== 'POST') {
      res.status(405).json({ jsonrpc: '2.0', error: { code: -32000, message: 'Лише POST: сервер працює без сесій' }, id: null });
      return;
    }
    const server = buildMcpServer(req);
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        res.status(500).json({ jsonrpc: '2.0', error: { code: -32603, message: error instanceof Error ? error.message : 'Помилка MCP' }, id: null });
      }
    }
  };
}
