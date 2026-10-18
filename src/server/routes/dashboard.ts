/** Маршрути реєстру: дашборд. */
import type { Router } from 'express';
import { dashboard } from '../../registry/dashboard.js';
import { fail, requireProjectId } from './common.js';

export function registerDashboardRoutes(router: Router): void {
  router.get('/dashboard', (req, res) => {
    try {
      res.json(dashboard(requireProjectId(req)));
    } catch (error) {
      fail(res, error);
    }
  });
}
