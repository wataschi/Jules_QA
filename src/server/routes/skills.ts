/** Маршрути реєстру: AI-скіли. */
import type { Router } from 'express';
import { z } from 'zod';
import { caseFilterSchema, skillNameSchema, type CaseFilter } from '../../registry/types.js';
import { requireProject } from '../../registry/projects-store.js';
import { sectionPathMap } from '../../registry/sections-store.js';
import { listAllCases } from '../../registry/cases-store.js';
import { listBlocks } from '../../registry/sources-store.js';
import { createProposal } from '../../registry/proposals-store.js';
import { requireMapping } from '../../registry/mappings-store.js';
import { finishSkillRun, listSkillRuns, startSkillRun } from '../../registry/skill-runs-store.js';
import { WriteCasesModule, ValidateCoverageModule, TestrailCsvModule, TestrailXmlModule, loadModule, SKILLS, INTEGRATIONS, fail, asInt, requireProjectId, exportCases, blocksForSkill } from './common.js';

export function registerSkillsRoutes(router: Router): void {
  router.post('/skills/write-cases', async (req, res) => {
    const body = z
      .object({
        projectId: z.string().min(1),
        sectionId: z.string().min(1),
        blockIds: z.array(z.string()).optional(),
        text: z.string().optional(),
        style: z
          .object({ maxPerBlock: z.number().int().positive().optional(), includeDerived: z.boolean().optional() })
          .optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      fail(res, body.error);
      return;
    }

    let skillRunId: string | null = null;
    try {
      const project = requireProject(body.data.projectId);
      const paths = sectionPathMap(project.id);
      const blocks = (body.data.blockIds ?? []).length
        ? blocksForSkill(body.data.blockIds ?? [])
        : body.data.text
          ? [{ id: 'inline', heading: '', text: body.data.text }]
          : [];
      if (blocks.length === 0) {
        res.status(400).json({ error: 'Передайте blockIds або text' });
        return;
      }

      const { writeCases } = await loadModule<WriteCasesModule>(
        SKILLS.writeCases,
        'src/registry/skills/write-cases.ts',
      );
      const skillRun = startSkillRun(project.id, 'write-cases', body.data);
      skillRunId = skillRun.id;

      const result = await writeCases({
        blocks,
        sectionPath: paths.get(body.data.sectionId) ?? '',
        projectName: project.name,
        style: body.data.style,
      });

      const proposals = result.drafts.map((draft) =>
        createProposal({
          projectId: project.id,
          kind: 'case_create',
          title: draft.case.title,
          rationale: draft.rationale,
          payload: { ...draft.case, sectionId: body.data.sectionId },
          coverageKind: draft.coverageKind,
          origin: { skill: 'write-cases', skillRunId: skillRun.id, blockId: draft.blockId },
        }),
      );

      const finished = finishSkillRun(skillRun.id, {
        state: 'done',
        output: { warnings: result.warnings, drafts: result.drafts.length },
        model: result.usage.model,
        proposalCount: proposals.length,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        durationMs: result.usage.durationMs,
      });
      res.json({ skillRun: finished, proposals, warnings: result.warnings });
    } catch (error) {
      if (skillRunId) {
        finishSkillRun(skillRunId, {
          state: 'failed',
          error: error instanceof Error ? error.message : 'невідома помилка',
        });
      }
      fail(res, error, 502);
    }
  });

  router.post('/skills/validate-coverage', async (req, res) => {
    const body = z
      .object({
        projectId: z.string().min(1),
        sourceId: z.string().optional(),
        blockIds: z.array(z.string()).optional(),
        sectionId: z.string().optional(),
      })
      .safeParse(req.body);
    if (!body.success) {
      fail(res, body.error);
      return;
    }

    let skillRunId: string | null = null;
    try {
      const project = requireProject(body.data.projectId);
      const blocks = body.data.blockIds?.length
        ? blocksForSkill(body.data.blockIds)
        : body.data.sourceId
          ? listBlocks(body.data.sourceId).map((b) => ({ id: b.id, heading: b.heading, text: b.text }))
          : [];
      const cases = listAllCases(
        project.id,
        body.data.sectionId ? { sectionIds: [body.data.sectionId], includeSubsections: true } : {},
      ).map((c) => ({ id: c.id, title: c.title, checks: c.checks, kind: c.kind }));

      const { validateCoverage } = await loadModule<ValidateCoverageModule>(
        SKILLS.validateCoverage,
        'src/registry/skills/validate-coverage.ts',
      );
      const skillRun = startSkillRun(project.id, 'validate-coverage', body.data);
      skillRunId = skillRun.id;

      const result = await validateCoverage({
        blocks,
        cases,
        sectionPath: body.data.sectionId ? (sectionPathMap(project.id).get(body.data.sectionId) ?? '') : '',
      });

      const proposals = result.report.gaps.map((gap) =>
        createProposal({
          projectId: project.id,
          kind: 'case_create',
          title: gap.suggestion.title,
          rationale: `Прогалина покриття: ${gap.fragment}`,
          payload: { ...gap.suggestion, sectionId: body.data.sectionId ?? '' },
          coverageKind: 'quote',
          origin: { skill: 'validate-coverage', skillRunId: skillRun.id, blockId: gap.blockId },
        }),
      );

      const finished = finishSkillRun(skillRun.id, {
        state: 'done',
        output: result.report,
        model: result.usage.model,
        proposalCount: proposals.length,
        promptTokens: result.usage.promptTokens,
        completionTokens: result.usage.completionTokens,
        durationMs: result.usage.durationMs,
      });
      res.json({ skillRun: finished, report: result.report, proposals, warnings: result.warnings });
    } catch (error) {
      if (skillRunId) {
        finishSkillRun(skillRunId, {
          state: 'failed',
          error: error instanceof Error ? error.message : 'невідома помилка',
        });
      }
      fail(res, error, 502);
    }
  });

  router.post('/skills/format-export', async (req, res) => {
    try {
      const body = z
        .object({
          projectId: z.string().min(1),
          caseIds: z.array(z.string()).optional(),
          filter: caseFilterSchema.partial().optional(),
          mappingId: z.string().min(1),
          target: z.enum(['csv', 'xml', 'api']),
          dryRun: z.boolean().default(true),
        })
        .parse(req.body);
      requireProject(body.projectId);
      const mapping = requireMapping(body.mappingId);
      const cases = exportCases(body.projectId, {
        caseIds: body.caseIds,
        filter: body.filter as CaseFilter | undefined,
      });

      const skillRun = startSkillRun(body.projectId, 'format-export', body);
      const started = Date.now();
      let preview = '';
      if (body.target === 'csv') {
        const mod = await loadModule<TestrailCsvModule>(INTEGRATIONS.testrailCsv, 'src/integrations/testrail-csv.ts');
        preview = mod.buildTestrailCsv(cases, mapping);
      } else if (body.target === 'xml') {
        const mod = await loadModule<TestrailXmlModule>(INTEGRATIONS.testrailXml, 'src/integrations/testrail-xml.ts');
        preview = mod.buildTestrailXml(cases, mapping);
      } else {
        preview = JSON.stringify(cases, null, 2);
      }

      const finished = finishSkillRun(skillRun.id, {
        state: 'done',
        output: { cases: cases.length, target: body.target },
        durationMs: Date.now() - started,
      });
      res.json({
        skillRun: finished,
        preview: preview.slice(0, 200_000),
        fileUrl:
          body.target === 'api'
            ? undefined
            : `/api/registry/export/testrail.${body.target}?projectId=${encodeURIComponent(body.projectId)}&mappingId=${encodeURIComponent(mapping.id)}`,
      });
    } catch (error) {
      fail(res, error, 502);
    }
  });

  router.get('/skills/runs', (req, res) => {
    try {
      res.json(
        listSkillRuns({
          projectId: requireProjectId(req),
          skill: typeof req.query.skill === 'string' ? skillNameSchema.parse(req.query.skill) : undefined,
          page: asInt(req.query.page, 1),
          limit: asInt(req.query.limit, 50),
        }),
      );
    } catch (error) {
      fail(res, error);
    }
  });
}
