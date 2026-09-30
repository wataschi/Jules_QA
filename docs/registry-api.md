# Контракт API реєстру

Єдиний контракт для сервера (`src/registry`, `src/server/registry-routes.ts`), скілів
(`src/registry/skills`), інтеграцій (`src/integrations`) і веб-інтерфейсу (`web/src`).
Типи всіх тіл і відповідей — у `src/registry/types.ts`; тут лише маршрути й параметри.

Загальні правила:

- Префікс `/api/registry`. Формат — JSON, час — ISO-8601 UTC.
- Помилка: `{ "error": "<повідомлення>", "details"?: unknown }` зі статусом 400 / 404 / 409 / 502.
- Валідація вхідних тіл — zod-схемами з `types.ts`; невалідне тіло → 400 з `details` від zod.
- Списки повертають `Page<T>`: `{ items, total, page, limit }`. Дефолт `limit=50`, максимум `200`.
- Якщо задано `JULES_API_TOKEN`, кожен запит до `/api/**` вимагає `Authorization: Bearer <token>`
  (для SSE і посилань на файли також приймається `?token=`). Без змінної — режим без авторизації,
  як зараз, але сервер логує попередження при старті.
- `author` / `updatedBy` беруться з заголовка `X-Jules-User` (якщо є), інакше `'local'`.

## Проєкти

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/projects` | список проєктів |
| POST | `/projects` | `ProjectInput` → `Project` (201) |
| GET | `/projects/:id` | один проєкт |
| PATCH | `/projects/:id` | часткове оновлення |

## Секції (дерево модулів)

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/sections?projectId=` | `SectionNode[]` — дерево з `caseCount` і `caseCountDeep` |
| POST | `/sections` | `SectionInput` → `Section`; `code` генерується з назви, якщо не заданий |
| PATCH | `/sections/:id` | назва, `parentId`, `position` |
| DELETE | `/sections/:id` | 409, якщо є кейси або дочірні секції; `?moveCasesTo=<sectionId>` переносить |

## Кейси

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/cases` | фільтри: `projectId` (обов'язковий), `sectionId`, `includeSubsections=1`, `tag` (можна кілька), `kind`, `priority`, `status`, `automation`, `q` (FTS), `sort` (`id`\|`title`\|`updatedAt`\|`priority`, префікс `-` = спадання), `page`, `limit`. Повертає `Page<CaseListItem>` |
| GET | `/cases/:id` | `Case` + `sectionPath`, `coverage`, `lastResult` |
| POST | `/cases` | `{ projectId, ...CaseInput }` → `Case` (201). ID видає сервер: `<KEY>-<CODE>-<NNN>` |
| PATCH | `/cases/:id` | часткове оновлення; створює `revision`, інкрементує `version` |
| DELETE | `/cases/:id` | за замовчуванням `status='deprecated'`; `?hard=1` — фізичне видалення |
| GET | `/cases/:id/history` | `{ revisions: Revision[], results: RunItem[] }` |
| POST | `/cases/bulk` | `BulkRequest` → `BulkResult`. `dryRun=true` (дефолт) лише показує `preview` |
| POST | `/cases/bulk/undo` | `{ batchId }` — відкат застосованого пакета через ревізії |
| POST | `/cases/:id/automation` | `{ status, scenarioPath?, quarantineReason? }` — прив'язка автосценарію |

`q` шукає по `title`, `checks`, `preconditions`, `tags` через FTS5 з нормалізацією регістру
для української та російської (вимога: пошук «акти» знаходить «Акти» і «АКТИ»).

## Джерела вимог і покриття

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/sources?projectId=` | `Source[]` + `blockCount`, `gaps` (він же `gapCount`) і `changed` — скільки блоків змінилось після останнього `refresh` |
| POST | `/sources/import` | `{ projectId, kind, url?, text?, html?, title? }` → `{ source, blocks }`. Для `kind='confluence'` тягне сторінку через API за `url` або `externalId` |
| GET | `/sources/:id` | `Source` + `blocks: Block[]` |
| POST | `/sources/:id/refresh` | перезавантажує, рахує хеші, ставить `changeState`, створює `proposal` на зачеплені кейси → `{ changed, added, removed, proposals }` |
| DELETE | `/sources/:id` | видаляє джерело; зв'язки покриття лишаються як `orphan` |
| GET | `/coverage?projectId=&sourceId=` | `{ rows: CoverageRow[], stats }` — матриця та прогалини |
| POST | `/coverage` | `{ blockId, caseId, kind, confirmed }` — ручний зв'язок |
| DELETE | `/coverage/:id` | знімає зв'язок |

## Черга апрувів

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/proposals?projectId=&state=&kind=&sourceId=&blockId=&page=` | `Page<Proposal>`; кожен елемент додатково несе `blockHeading` і `blockText` (до 1200 символів) — без них у черзі апрувів не видно, де цитата вимоги, а де домисел AI |
| POST | `/proposals` | ручне створення пропозиції інженером (розширення контракту: потрібне інтерфейсу й тестам) |
| POST | `/proposals/approve` | `{ ids: string[], reviewer? }` → `{ approved, created, updated, errors }` — застосовує до реєстру в одній транзакції |
| POST | `/proposals/reject` | `{ ids: string[], note?, reviewer? }` |
| PATCH | `/proposals/:id` | правка `payload` перед апрувом (інженер редагує формулювання) |
| DELETE | `/proposals/:id` | прибрати з черги без рішення |

Апрув `case_create` створює кейс і зв'язок покриття (`coverageKind` із пропозиції);
`case_update` застосовує `changes` до кейса з новою ревізією; `bulk_edit` виконує `BulkRequest`
з `dryRun=false`; `locator_update` оновлює кеш локаторів сценарію і пише ревізію кейса.

## AI-скіли

| Метод | Шлях | Опис |
|---|---|---|
| POST | `/skills/write-cases` | `{ projectId, sectionId, blockIds?: string[], text?: string, style?: {maxPerBlock?, includeDerived?} }` → `{ skillRun, proposals }`. Один блок = один запит до моделі |
| POST | `/skills/validate-coverage` | `{ projectId, sourceId?, blockIds?, sectionId? }` → `{ skillRun, report: { gaps, duplicates, untestable, contradictions }, proposals }` |
| POST | `/skills/format-export` | `{ projectId, caseIds?|filter?, mappingId, target: 'csv'\|'xml'\|'api', dryRun? }` → `{ skillRun, preview, fileUrl? }` |
| GET | `/skills/runs?projectId=&skill=&page=` | `Page<SkillRun>` — лог запусків із токенами й часом |

Правила для всіх скілів: жорстка JSON-схема виходу, валідація zod, до 2 повторів із
повідомленням про помилку валідації, вихід у чергу апрувів, а не прямо в реєстр.

## Вибірки

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/selections?projectId=` | `Selection[]` |
| POST | `/selections` | `SelectionInput` → `Selection` |
| PATCH | `/selections/:id` · DELETE | оновлення / видалення |
| POST | `/selections/:id/resolve` | → `{ caseIds, cases: CaseListItem[] }` (для `mode='filter'` рахує наживо) |

## Прогони

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/runs?projectId=&kind=&state=&page=` | `Page<RegistryRun>` |
| POST | `/runs` | `{ projectId, kind, title?, selectionId?|caseIds?, env? }` → `RegistryRun` (201) зі створеними `runItem` у статусі `untested` |
| GET | `/runs/:id` | `RunDetail` — прогін з кейсами й статусами |
| PATCH | `/runs/:id` | `{ state?, title?, note? }`; `state='completed'` фіксує `finishedAt` |
| PUT | `/runs/:id/items/:caseId` | `{ status, comment?, evidence?, defect?: { title, severity } }` — ручний результат; створює/оновлює дефект із дедуплікацією |
| POST | `/runs/:id/auto` | `{ caseIds? }` — для кейсів з `automation.status='automated'` ставить у чергу прогони рушія і зв'язує `runItem.autoRunId` |
| POST | `/runs/:id/rerun-failed` | новий прогін лише з `failed`/`blocked` кейсами |
| POST | `/runs/:id/sync-auto` | підтягує результати прогонів рушія в елементи прогону → `{ updated, pending, missing }`. Автоматично робиться спостерігачем після `/auto`; маршрут потрібен після перезапуску сервера |
| GET | `/runs/:id/stream` | SSE: `event: item` (оновлення статусу), `event: done`. Heartbeat кожні 15 с, `id:` для відновлення |

## Дефекти

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/defects?projectId=&status=&page=` | `Page<Defect>` |
| POST | `/defects` | `{ projectId, title, ... }` → `Defect`; при однаковому `dedupKey` інкрементує `seenCount` |
| PATCH | `/defects/:id` | статус, серйозність, зовнішній ключ Jira |

## TestRail

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/testrail/mappings?projectId=` | `TestrailMapping[]` |
| POST | `/testrail/mappings` · PATCH `/testrail/mappings/:id` | профілі мапінгу |
| POST | `/testrail/push` | `{ projectId, caseIds?\|filter?, mappingId, dryRun, force? }`. `dryRun` → `{ applied: false, willCreate, willUpdate, unchanged, sections }`; застосування → `{ applied: true, created, updated, unchanged, sectionsCreated, errors }`. Відсутні секції створюються рекурсивно, `case.testrail` отримує `caseId`, `syncedAt`, `syncHash`; незмінені кейси пропускаються, якщо не заданий `force` |
| POST | `/testrail/pull` | `{ projectId, mappingId, scope: 'cases'\|'results', runId?, adopt? }`. `scope='cases'` → `{ imported, adopted, drift, unknown, unknownTotal }` (кейси знаходяться за нашим ID у полі `mapping.idField`, `adopt` записує `testrailCaseId`). `scope='results'` → ран TestRail стає прогоном реєстру: `{ imported, unmatched, run, registryRunId }` |
| GET | `/testrail/drift?projectId=&mappingId=` | **масив** рядків `{ caseId, title, fields, ours, theirs }` — кейси, чий поточний хеш не збігається зі `syncHash` останньої синхронізації (тобто їх треба пушити). Без профілю мапінгу порівнюється час оновлення |
| GET | `/export/testrail.csv?projectId=&mappingId=&...filter` | файл CSV (`Content-Disposition: attachment`) |
| GET | `/export/testrail.xml?projectId=&mappingId=&...filter` | файл XML |

Ключ і URL TestRail — зі змінних `TESTRAIL_BASE_URL`, `TESTRAIL_USER`, `TESTRAIL_API_KEY`.
Без них доступні лише CSV/XML; `push`/`pull` віддають 400 з підказкою.

## Дашборд

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/dashboard?projectId=` | `DashboardData` — кейси, покриття, прогони, flaky, зведення за модулями, черга рішень |

## Сумісність зі старим API

Наявні маршрути (`/api/scenarios`, `/api/suites`, `/api/runs`, `/api/settings`, `/api/ai/*`,
`/api/llm/check`, `/api/stats`) лишаються без змін — на них спирається рушій і старі скрипти.
Нові екрани використовують `/api/registry/**`; зв'язок між світами — поле
`case.automation.scenarioPath` і `runItem.autoRunId`.
