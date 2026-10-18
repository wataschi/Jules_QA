/** Маршрути реєстру: TestRail. */
import type { Router } from 'express';
import { z } from 'zod';
import { caseFilterSchema, testrailMappingSchema, type CaseFilter } from '../../registry/types.js';
import { requireProject } from '../../registry/projects-store.js';
import { getCase, listAllCases, setTestrailMeta } from '../../registry/cases-store.js';
import { createRun, setItemStatus, updateRun } from '../../registry/runs-store.js';
import { createMapping, listMappings, requireMapping, updateMapping } from '../../registry/mappings-store.js';
import { caseSyncHash, pullCases, pullResults, pushCases, type TestrailClientLike, type TestrailSyncCase } from '../../registry/testrail-sync.js';
import { TestrailCsvModule, TestrailXmlModule, TestrailApiModule, loadModule, INTEGRATIONS, fail, requireProjectId, filterFromQuery, exportCases } from './common.js';

export function registerTestrailRoutes(router: Router): void {
  router.get('/testrail/mappings', (req, res) => {
    try {
      res.json(listMappings(requireProjectId(req)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/testrail/mappings', (req, res) => {
    try {
      const body = testrailMappingSchema.omit({ id: true, createdAt: true, updatedAt: true }).parse(req.body);
      requireProject(body.projectId);
      res.status(201).json(createMapping(body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/testrail/mappings/:id', (req, res) => {
    try {
      const body = testrailMappingSchema
        .omit({ id: true, projectId: true, createdAt: true, updatedAt: true })
        .partial()
        .parse(req.body);
      res.json(updateMapping(req.params.id, body));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/testrail/push', async (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          caseIds: z.array(z.string()).optional(),
          filter: caseFilterSchema.partial().optional(),
          mappingId: z.string().min(1),
          dryRun: z.boolean().default(true),
          /** Оновити навіть ті кейси, чий хеш синхронізації не змінився. */
          force: z.boolean().default(false),
        })
        .parse(req.body);
      const project = requireProject(body.projectId);
      const mapping = requireMapping(body.mappingId);
      const api = await loadModule<TestrailApiModule>(INTEGRATIONS.testrailApi, 'src/integrations/testrail-api.ts');
      if (!api.isTestrailConfigured()) {
        res.status(400).json({
          error:
            'TestRail не налаштовано: задайте TESTRAIL_BASE_URL, TESTRAIL_USER, TESTRAIL_API_KEY. Без них доступні лише CSV/XML.',
        });
        return;
      }
      if (!project.testrailProjectId) {
        res.status(400).json({ error: 'У проєкті не заданий testrailProjectId' });
        return;
      }

      const syncCases: TestrailSyncCase[] = exportCases(project.id, {
        caseIds: body.caseIds,
        filter: body.filter as CaseFilter | undefined,
      }).map((item) => {
        const stored = getCase(item.id)?.testrail;
        return { ...item, ...(stored?.syncHash ? { syncHash: stored.syncHash } : {}) };
      });
      const projectRef = {
        testrailProjectId: project.testrailProjectId,
        ...(project.testrailSuiteId ? { testrailSuiteId: project.testrailSuiteId } : {}),
      };

      if (body.dryRun) {
        const willCreate: string[] = [];
        const willUpdate: string[] = [];
        const unchanged: string[] = [];
        for (const item of syncCases) {
          if (!item.testrailCaseId) willCreate.push(item.id);
          else if (!body.force && item.syncHash === caseSyncHash(item, mapping)) unchanged.push(item.id);
          else willUpdate.push(item.id);
        }
        res.json({
          applied: false,
          willCreate,
          willUpdate,
          unchanged,
          sections: Array.from(new Set(syncCases.map((item) => item.sectionPath).filter(Boolean))),
          errors: [],
        });
        return;
      }

      const client = new api.TestrailClient({
        baseUrl: process.env.TESTRAIL_BASE_URL as string,
        user: process.env.TESTRAIL_USER as string,
        apiKey: process.env.TESTRAIL_API_KEY as string,
      }) as unknown as TestrailClientLike;

      const pushed = await pushCases({
        client,
        project: projectRef,
        mapping,
        cases: syncCases,
        onSynced: (caseId, patch) => setTestrailMeta(caseId, patch),
        force: body.force,
      });

      res.json({
        applied: true,
        created: pushed.created,
        updated: pushed.updated,
        unchanged: pushed.unchanged,
        sectionsCreated: pushed.sectionsCreated,
        errors: pushed.errors,
        mapping: mapping.id,
      });
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.post('/testrail/pull', async (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          mappingId: z.string().min(1),
          scope: z.enum(['cases', 'results']),
          /** Конкретний ран TestRail; без нього беремо найсвіжіший. */
          runId: z.number().int().positive().optional(),
          /** Записати знайдені `testrailCaseId` у реєстр. */
          adopt: z.boolean().default(true),
        })
        .parse(req.body);
      const project = requireProject(body.projectId);
      const mapping = requireMapping(body.mappingId);
      const api = await loadModule<TestrailApiModule>(INTEGRATIONS.testrailApi, 'src/integrations/testrail-api.ts');
      if (!api.isTestrailConfigured()) {
        res.status(400).json({
          error:
            'TestRail не налаштовано: задайте TESTRAIL_BASE_URL, TESTRAIL_USER, TESTRAIL_API_KEY. Без них доступні лише CSV/XML.',
        });
        return;
      }
      if (!project.testrailProjectId) {
        res.status(400).json({ error: 'У проєкті не заданий testrailProjectId' });
        return;
      }

      const client = new api.TestrailClient({
        baseUrl: process.env.TESTRAIL_BASE_URL as string,
        user: process.env.TESTRAIL_USER as string,
        apiKey: process.env.TESTRAIL_API_KEY as string,
      }) as unknown as TestrailClientLike;
      const projectRef = {
        testrailProjectId: project.testrailProjectId,
        ...(project.testrailSuiteId ? { testrailSuiteId: project.testrailSuiteId } : {}),
      };

      if (body.scope === 'cases') {
        const ours: TestrailSyncCase[] = exportCases(project.id, {}).map((item) => {
          const stored = getCase(item.id)?.testrail;
          return { ...item, ...(stored?.syncHash ? { syncHash: stored.syncHash } : {}) };
        });
        const pulled = await pullCases({ client, project: projectRef, mapping, ours });
        if (body.adopt) {
          const syncedAt = new Date().toISOString();
          for (const row of pulled.adopted) {
            setTestrailMeta(row.caseId, { caseId: row.testrailCaseId, syncedAt });
          }
        }
        res.json({
          scope: 'cases',
          imported: pulled.total,
          adopted: pulled.adopted,
          drift: pulled.drift,
          unknown: pulled.unknown.slice(0, 100),
          unknownTotal: pulled.unknown.length,
        });
        return;
      }

      // scope === 'results': ран TestRail стає прогоном реєстру з історією по кейсах.
      const pulled = await pullResults({
        client,
        project: projectRef,
        ...(body.runId ? { runId: body.runId } : {}),
      });
      const byTestrailId = new Map<number, string>();
      for (const item of listAllCases(project.id)) {
        if (item.testrail?.caseId) byTestrailId.set(item.testrail.caseId, item.id);
      }
      const matched = pulled.results.filter((row) => byTestrailId.has(row.testrailCaseId));
      const unmatched = pulled.results.length - matched.length;

      if (!pulled.run || matched.length === 0) {
        res.json({
          scope: 'results',
          imported: 0,
          unmatched,
          run: pulled.run ?? null,
          note:
            unmatched > 0
              ? 'Результати є, але жоден кейс TestRail не пов’язаний із реєстром — спершу зробіть pull зі scope=cases'
              : 'У TestRail немає результатів для імпорту',
        });
        return;
      }

      const run = createRun({
        projectId: project.id,
        kind: 'manual',
        title: `TestRail: ${pulled.run.name}`,
        caseIds: matched.map((row) => byTestrailId.get(row.testrailCaseId) as string),
        executor: 'testrail',
        note: `Імпортовано з TestRail run ${pulled.run.id}`,
      });
      for (const row of matched) {
        setItemStatus(run.id, byTestrailId.get(row.testrailCaseId) as string, {
          status: row.status,
          comment: row.comment.slice(0, 2000),
          updatedBy: 'testrail',
        });
      }
      updateRun(run.id, { state: 'completed' });

      res.json({
        scope: 'results',
        imported: matched.length,
        unmatched,
        run: pulled.run,
        registryRunId: run.id,
      });
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.get('/testrail/drift', (req, res) => {
    try {
      const projectId = requireProjectId(req);
      const mappingId = typeof req.query.mappingId === 'string' ? req.query.mappingId : undefined;
      const mapping = mappingId ? requireMapping(mappingId) : listMappings(projectId)[0];

      const rows: Array<{
        caseId: string;
        title: string;
        fields: string[];
        ours: string;
        theirs: string;
      }> = [];

      for (const item of exportCases(projectId, {})) {
        const caseRow = getCase(item.id);
        const stored = caseRow?.testrail;
        if (!stored?.caseId) continue;

        if (!mapping) {
          // Без профілю мапінгу хеш не порахувати — лишається порівняння часу.
          if (!stored.syncedAt || (caseRow && caseRow.updatedAt > stored.syncedAt)) {
            rows.push({
              caseId: item.id,
              title: item.title,
              fields: ['updatedAt'],
              ours: caseRow?.updatedAt ?? '',
              theirs: stored.syncedAt ?? 'ніколи не синхронізовано',
            });
          }
          continue;
        }

        const current = caseSyncHash(item, mapping);
        if (stored.syncHash === current) continue;
        rows.push({
          caseId: item.id,
          title: item.title,
          fields: stored.syncHash ? ['заголовок або перевірки'] : ['ніколи не синхронізовано'],
          ours: current,
          theirs: stored.syncHash ?? '—',
        });
      }

      res.json(rows);
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/export/testrail.csv', async (req, res) => {
    try {
      const projectId = requireProjectId(req);
      const mapping = requireMapping(String(req.query.mappingId ?? ''));
      const cases = exportCases(projectId, { filter: filterFromQuery(req) as CaseFilter });
      const mod = await loadModule<TestrailCsvModule>(INTEGRATIONS.testrailCsv, 'src/integrations/testrail-csv.ts');
      const csv = mod.buildTestrailCsv(cases, mapping);
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="testrail-${projectId}.csv"`);
      res.send(csv);
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.get('/export/testrail.xml', async (req, res) => {
    try {
      const projectId = requireProjectId(req);
      const mapping = requireMapping(String(req.query.mappingId ?? ''));
      const cases = exportCases(projectId, { filter: filterFromQuery(req) as CaseFilter });
      const mod = await loadModule<TestrailXmlModule>(INTEGRATIONS.testrailXml, 'src/integrations/testrail-xml.ts');
      const xml = mod.buildTestrailXml(cases, mapping);
      res.setHeader('Content-Type', 'application/xml; charset=utf-8');
      res.setHeader('Content-Disposition', `attachment; filename="testrail-${projectId}.xml"`);
      res.send(xml);
    } catch (error) {
      fail(res, error, 502);
    }
  });
}
