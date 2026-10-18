/** Маршрути реєстру: діагностика інтеграцій. */
import type { Router } from 'express';

import { ConfluenceModule, TestrailApiModule, loadModule, INTEGRATIONS } from './common.js';

export function registerIntegrationsRoutes(router: Router): void {
  /**
   * Стан усіх зовнішніх залежностей по ролях.
   *
   * Модель у Jules налаштовується трьома різними адресами (виконання, планування,
   * критик), і коли одна з них лежить, скіл падає з загальним «модель недоступна».
   * Цей маршрут показує, яка саме адреса не відповідає.
   */
  router.get('/integrations/health', async (_req, res) => {
    const roles: Array<{ role: string; label: string; baseUrl?: string; model?: string; key?: string }> = [
      {
        role: 'execution',
        label: 'Виконання сценаріїв (Midscene)',
        baseUrl: process.env.MIDSCENE_MODEL_BASE_URL,
        model: process.env.MIDSCENE_MODEL_NAME,
        key: process.env.MIDSCENE_MODEL_API_KEY,
      },
      {
        role: 'planning',
        label: 'Генерація кейсів (planner)',
        baseUrl: process.env.PLANNER_MODEL_BASE_URL ?? process.env.MIDSCENE_MODEL_BASE_URL,
        model: process.env.PLANNER_MODEL_NAME ?? process.env.MIDSCENE_MODEL_NAME,
        key: process.env.PLANNER_MODEL_API_KEY ?? process.env.MIDSCENE_MODEL_API_KEY,
      },
      {
        role: 'critic',
        label: 'Перевірка згенерованого (critic)',
        baseUrl: process.env.CRITIC_MODEL_BASE_URL ?? process.env.MIDSCENE_MODEL_BASE_URL,
        model: process.env.CRITIC_MODEL_NAME ?? process.env.MIDSCENE_MODEL_NAME,
        key: process.env.CRITIC_MODEL_API_KEY ?? process.env.MIDSCENE_MODEL_API_KEY,
      },
    ];

    const models = await Promise.all(
      roles.map(async (role) => {
        if (!role.baseUrl) {
          return { role: role.role, label: role.label, configured: false, ok: false, error: 'адресу не задано' };
        }
        const started = Date.now();
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8_000);
          const response = await fetch(`${role.baseUrl.replace(/\/$/, '')}/models`, {
            headers: role.key ? { Authorization: `Bearer ${role.key}` } : {},
            signal: controller.signal,
          });
          clearTimeout(timer);
          const payload = (await response.json().catch(() => ({}))) as { data?: Array<{ id?: string }> };
          const available = (payload.data ?? []).map((entry) => entry.id).filter(Boolean) as string[];
          return {
            role: role.role,
            label: role.label,
            configured: true,
            baseUrl: role.baseUrl,
            model: role.model,
            ok: response.ok,
            status: response.status,
            durationMs: Date.now() - started,
            // Найчастіша прихована помилка: адреса жива, але моделі з .env там немає.
            modelAvailable: role.model ? available.includes(role.model) : undefined,
            models: available.slice(0, 20),
            ...(response.ok ? {} : { error: `HTTP ${response.status}` }),
          };
        } catch (error) {
          const cause = (error as { cause?: { code?: string } })?.cause?.code;
          return {
            role: role.role,
            label: role.label,
            configured: true,
            baseUrl: role.baseUrl,
            model: role.model,
            ok: false,
            durationMs: Date.now() - started,
            error: cause ?? (error instanceof Error ? error.message : 'невідома помилка'),
          };
        }
      }),
    );

    let confluence = { configured: false };
    let testrail = { configured: false };
    try {
      const mod = await loadModule<ConfluenceModule>(INTEGRATIONS.confluence, 'src/integrations/confluence.ts');
      confluence = { configured: mod.isConfluenceConfigured() };
    } catch {
      /* модуль недоступний — лишаємо configured: false */
    }
    try {
      const mod = await loadModule<TestrailApiModule>(INTEGRATIONS.testrailApi, 'src/integrations/testrail-api.ts');
      testrail = { configured: mod.isTestrailConfigured() };
    } catch {
      /* те саме */
    }

    res.json({
      models,
      confluence: { ...confluence, baseUrl: process.env.CONFLUENCE_BASE_URL },
      testrail: { ...testrail, baseUrl: process.env.TESTRAIL_BASE_URL },
      registry: { db: process.env.REGISTRY_DB ?? 'data/registry.db', node: process.versions.node },
    });
  });
}
