/** Маршрути реєстру: проєкти. */
import type { Router } from 'express';
import { projectInputSchema } from '../../registry/types.js';
import { createProject, getProject, listProjects, updateProject } from '../../registry/projects-store.js';
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
      const patch = projectInputSchema.partial().parse(req.body);
      res.json(updateProject(req.params.id, patch));
    } catch (error) {
      fail(res, error);
    }
  });
}
