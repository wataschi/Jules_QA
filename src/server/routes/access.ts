/** Маршрути реєстру: хто я, користувачі й токени доступу. */
import type { Router } from 'express';
import { z } from 'zod';
import { issueToken, listTokens, listUsers, revokeToken, setUserRole } from '../../registry/access-store.js';
import { tokenRoleSchema, userRoleSchema } from '../../registry/types.js';
import { HttpError, requestAuthor, requireRole } from '../auth.js';
import { fail } from './common.js';

export function registerAccessRoutes(router: Router): void {
  router.get('/me', (req, res) => {
    const principal = req.principal ?? { login: 'local', role: 'admin', kind: 'local' };
    res.json({ ...principal, author: requestAuthor(req) });
  });

  router.get('/users', (req, res) => {
    try {
      requireRole(req, 'qa', 'dev');
      res.json(listUsers());
    } catch (error) {
      fail(res, error);
    }
  });

  router.patch('/users/:login', (req, res) => {
    try {
      requireRole(req, 'admin');
      const body = z.object({ role: userRoleSchema }).parse(req.body);
      res.json(setUserRole(req.params.login, body.role));
    } catch (error) {
      fail(res, error);
    }
  });

  router.get('/tokens', (req, res) => {
    try {
      requireRole(req, 'admin');
      res.json(listTokens(typeof req.query.projectId === 'string' ? req.query.projectId : undefined));
    } catch (error) {
      fail(res, error);
    }
  });

  router.post('/tokens', (req, res) => {
    try {
      const principal = requireRole(req, 'admin', 'dev', 'qa');
      const body = z
        .object({
          name: z.string().min(1).max(100),
          role: tokenRoleSchema,
          projectId: z.string().optional(),
        })
        .parse(req.body);
      // Людина без ролі адміна може видати лише персональний токен самій собі.
      if (principal.role !== 'admin' && body.role !== principal.role) {
        throw new HttpError(403, 'Без ролі адміністратора можна видати лише власний персональний токен');
      }
      const owner = body.role === 'ci' ? undefined : principal.login;
      const { token, record } = issueToken({ ...body, owner, createdBy: principal.login });
      res.status(201).json({ token, record });
    } catch (error) {
      fail(res, error);
    }
  });

  router.delete('/tokens/:id', (req, res) => {
    try {
      requireRole(req, 'admin');
      revokeToken(req.params.id);
      res.json({ revoked: true });
    } catch (error) {
      fail(res, error);
    }
  });
}
