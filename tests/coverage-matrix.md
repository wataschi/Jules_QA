# Матриця покриття QA

Оновлено: автоматизована QA-система Jules AI QA MVP.

| Компонент | Unit | API | LLM E2E | UI E2E | Статус |
|-----------|:----:|:---:|:-------:|:------:|:------:|
| YAML/Zod validation | x | x | | | covered |
| scenario-planner | x | | x | | covered |
| midscene-env bootstrap | x | | | | covered |
| self-heal (3 retries) | x | | x | | covered |
| hybrid-runner / Stagehand | | | x | | covered |
| cache warm-up/regression | | | x | | covered |
| runs/scenarios/suites stores | x | x | | | covered |
| test-runner queue/cancel | | x | x | | covered |
| aggregate-report | x | | x | | covered |
| REST API (20 routes) | | x | | | covered |
| SSE streaming | | x | | x | covered |
| LLM health check | | x | x | x | covered |
| Docker deploy | | | x | | manual |
| React Dashboard (7 pages) | | | | x | covered |
| securityHooks (TOTP/CAPTCHA) | — | — | — | — | v2 out of scope |

## Файли тестів

| Область | Файл |
|---------|------|
| Zod schemas | `tests/unit/planning/types.test.ts` |
| Planner | `tests/unit/planning/scenario-planner.test.ts` |
| Midscene env | `tests/unit/config/midscene-env.test.ts` |
| Self-heal | `tests/unit/engine/self-heal.test.ts` |
| Aggregate report | `tests/unit/reporting/aggregate-report.test.ts` |
| Stores | `tests/unit/server/stores-store.test.ts` |
| REST API | `tests/api/server.test.ts` |
| LLM warm-up | `e2e/llm-warm-up-page-load.spec.ts` |
| LLM regression | `e2e/llm-regression-page-load.spec.ts` |
| LLM suite API | `e2e/llm-suite-api.spec.ts` |
| Dashboard UI | `e2e/dashboard.spec.ts` |

## Sign-off checklist

- [ ] `npm run test:fast` — 53/53 pass
- [ ] `npm run typecheck` — 0 errors
- [ ] `npm run check:llm` — OK (Docker + Tailscale/LM Studio)
- [ ] `npm run test:llm` — LLM-01, LLM-02, LLM-04 pass
- [ ] `npm run test:ui` — 7/7 Dashboard smoke pass
- [ ] Universal suite 5/5 на цільовому URL
