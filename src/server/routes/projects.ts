/** Маршрути реєстру: проєкти. */
import type { Router } from 'express';
import { projectInputSchema, projectSettingsPatchSchema } from '../../registry/types.js';
import { createProject, getProject, listProjects, updateProject } from '../../registry/projects-store.js';
import { requireRole } from '../auth.js';
import { fail } from './common.js';

export function registerProjectsRoutes(router: Router): void {
  router.get('/projects', (_req, res) => {
    try {
      res.json(listProjects());
    } catch (error) {
      fail(res, error, 500);
    }
  });

  router.post('/projects', (req, res) => {
    try {
      requireRole(req, 'qa');
      res.status(201).json(createProject(projectInputSchema.parse(req.body)));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/projects/:id', (req, res) => {
    const project = getProject(req.params.id);
    if (!project) {
      res.status(404).json({ error: `Проєкт «${req.params.id}» не знайдено` });
      return;
    }
    res.json(project);
  });

  router.patch('/projects/:id', (req, res) => {
    try {
      requireRole(req, 'qa');
      // Налаштування — без значень за замовчуванням: їх злиття з наявними робить сховище.
      const patch = projectInputSchema
        .omit({ settings: true })
        .partial()
        .extend({ settings: projectSettingsPatchSchema.optional() })
        .parse(req.body);
      res.json(updateProject(req.params.id, patch));
    } catch (error) {
      fail(res, error);
    }
  });
}
