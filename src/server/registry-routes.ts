/**
 * HTTP-маршрути реєстру тест-кейсів (`/api/registry/**`).
 *
 * Тут і тільки тут сховища (`src/registry/*-store.ts`) зшиваються з AI-скілами
 * (`src/registry/skills/**`) та інтеграціями (`src/integrations/**`).
 * Скіли й інтеграції — чисті функції без доступу до бази: маршрут читає дані,
 * віддає їм, а результат кладе в чергу апрувів або в сховище.
 *
 * Маршрути розкладено за доменами в `src/server/routes/`, спільні помічники —
 * у `routes/common.ts`. Пагінація, фільтри й сортування живуть у SQL
 * (див. `src/registry/search.ts`), а не в JS.
 */
import express, { type Router } from 'express';
import { ensureMigrated } from '../registry/db.js';
import { registerProjectsRoutes } from './routes/projects.js';
import { registerSectionsRoutes } from './routes/sections.js';
import { registerCasesRoutes } from './routes/cases.js';
import { registerSourcesRoutes } from './routes/sources.js';
import { registerProposalsRoutes } from './routes/proposals.js';
import { registerSkillsRoutes } from './routes/skills.js';
import { registerSelectionsRoutes } from './routes/selections.js';
import { registerRunsRoutes } from './routes/runs.js';
import { registerDefectsRoutes } from './routes/defects.js';
import { registerTestrailRoutes } from './routes/testrail.js';
import { registerDashboardRoutes } from './routes/dashboard.js';
import { registerIntegrationsRoutes } from './routes/integrations.js';
import { registerAccessRoutes } from './routes/access.js';
import { registerTasksRoutes } from './routes/tasks.js';
import { registerInputsRoutes } from './routes/inputs.js';
import { registerIngestRoutes } from './routes/ingest.js';
import { registerReportsRoutes } from './routes/reports.js';

export function createRegistryRouter(): Router {
  const router = express.Router();
  ensureMigrated();

  registerAccessRoutes(router);
  registerProjectsRoutes(router);
  registerSectionsRoutes(router);
  registerCasesRoutes(router);
  registerInputsRoutes(router);
  registerSourcesRoutes(router);
  registerProposalsRoutes(router);
  registerSkillsRoutes(router);
  registerSelectionsRoutes(router);
  registerRunsRoutes(router);
  registerDefectsRoutes(router);
  registerTestrailRoutes(router);
  registerDashboardRoutes(router);
  registerIntegrationsRoutes(router);
  registerTasksRoutes(router);
  registerIngestRoutes(router);
  registerReportsRoutes(router);

  return router;
}
