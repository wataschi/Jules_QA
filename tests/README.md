# Jules AI QA — Test Suite

Автоматизована QA-система з трьома рівнями: **швидкі** (Vitest), **UI smoke** (Playwright Dashboard), **LLM E2E** (Playwright + Midscene).

## Команди

| Команда | Опис | LLM | Час |
|---------|------|-----|-----|
| `npm run test:fast` | Unit + API (53 тести) | Ні | ~5 с |
| `npm run test:unit` | Тільки unit-тести | Ні | ~2 с |
| `npm run test:api` | REST API integration | Ні | ~3 с |
| `npm run test:ui` | Dashboard smoke (7 сторінок) | Ні | ~30 с |
| `npm run test:llm` | LLM smoke (@llm) | Так | 10–60 хв |
| `npm run typecheck` | TypeScript strict check | Ні | ~5 с |

### Docker

```bash
docker compose up -d qa
docker compose exec qa npm run test:fast
docker compose exec qa npm run check:llm
docker compose exec qa npm run test:llm
docker compose exec qa npm run test:ui
```

Або через npm-скрипти:

```bash
npm run test:docker:fast
npm run test:docker:llm
```

## Структура

```
tests/
  unit/           # Vitest: Zod, planner, self-heal, stores, reporting
  api/            # Supertest: 20 REST endpoints
  helpers/        # Temp workspace для ізольованих тестів
e2e/
  ai-scenario.spec.ts       # Основний AI-сценарій (CLI/Dashboard)
  dashboard.spec.ts         # UI smoke
  llm-warm-up-page-load.spec.ts
  llm-regression-page-load.spec.ts
  llm-suite-api.spec.ts
  helpers/llm-gate.ts
```

## Env для тестів

| Змінна | Призначення |
|--------|-------------|
| `DATA_ROOT` | Ізольована директорія `data/` (авто в unit/API) |
| `SCENARIOS_ROOT` | Ізольована `scenarios/` |
| `MIDSCENE_RUN_ROOT` | Ізольована `midscene_run/` |
| `QA_TEST_MOCK_RUNNER=1` | Mock Playwright spawn (API tests) |
| `UI_BASE_URL` | Dashboard URL для UI/LLM API тестів |

## Критерії QA sign-off

1. `npm run test:fast` — 100% pass
2. `npm run typecheck` — 0 errors
3. `npm run check:llm` — OK у Docker
4. `npm run test:llm` — warm-up + regression + suite pass на example.com
5. `npm run test:ui` — навігація по Dashboard без помилок
6. Матриця покриття: [coverage-matrix.md](./coverage-matrix.md)

## CI (рекомендовано)

```yaml
jobs:
  fast:
    run: docker compose run --rm qa npm run test:fast
  typecheck:
    run: docker compose run --rm qa npm run typecheck
  llm-nightly:
    if: schedule
    run: |
      docker compose up -d qa
      docker compose exec qa npm run check:llm
      docker compose exec qa npm run test:llm
```
