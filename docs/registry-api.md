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
| POST | `/proposals/approve` | `{ ids: string[] }` (роль `qa`; рецензент — той, хто погоджує) → `{ approved, created, updated, errors }` — застосовує до реєстру в одній транзакції |
| POST | `/proposals/reject` | `{ ids: string[], note? }` (роль `qa`) |
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

---

# Jules 2.0: «QA направляє, агент робить»

План і схема — [`agent-driven-qa-plan.md`](agent-driven-qa-plan.md). Нижче — маршрути, додані до
`/api/registry`. Типи — у `src/registry/types.ts` (розділ «Jules 2.0»).

## Доступ

Хто є хто визначається в такому порядку:

1. `Tailscale-User-Login` від `tailscale serve`. Довіряємо лише для з'єднань із loopback, тому сервер
   слухає `127.0.0.1`.
2. Адмін-токен `JULES_API_TOKEN`.
3. Токен з `api_tokens`.
4. Локальний режим: якщо не задано ні `JULES_API_TOKEN`, ні `JULES_REQUIRE_AUTH=1`.

Шлях перевіряється без урахування регістру й зайвих скісних рисок, як його зіставляє Express:
`/API/...` чи `//api/...` вимагають входу так само, як `/api/...`.

**Ролі.**

| Що | Хто |
|---|---|
| Погодження, відхилення й правка пропозицій; створення, зміна й видалення кейсів; секції й модулі; налаштування проєкту; входи; рішення по прочитаннях; підтвердження, «інакше», повтор і відхилення задач; карантин тестів | `qa` |
| Задачі (створити, взяти, звітувати, питати), прогони `event: local`, резерв ID, «бачив» на коміті повз PR | `dev` і `qa` |
| Прогони `event: pr`/`main`, `ingest/pr-event`, `ingest/push-check` | `ci` |
| Користувачі, ролі, токени CI | `admin` |

Адмін проходить усі перевірки. Персональний токен не дає більше, ніж власник має зараз: після
зниження ролі токен знижується разом із нею.

Токен CI має доступ лише до `POST ingest/*`, `GET status`, `GET status.md`, `GET pr-comment.md`,
`POST cases/reserve` і `GET /projects/:id` свого проєкту. Чужий проєкт для нього — 403.

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/me` | Хто я: логін, роль (`admin`/`qa`/`dev`/`ci`), спосіб входу |
| GET · PATCH | `/users`, `/users/:login` | Користувачі; роль змінює адмін. Перші ролі — зі списків `JULES_ADMINS`, `JULES_QA_USERS` |
| GET · POST · DELETE | `/tokens`, `/tokens/:id` | Токени. Значення віддається один раз при видачі, у базі лише sha256. Токен CI прив'язаний до проєкту |

## Задачі для агентів

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/tasks?projectId=&state=&kind=&sectionId=&mine=1&q=&page=` | `Page<TaskListItem>` (з `ageHours`, `sectionName`) |
| POST | `/tasks` | `{ projectId, kind, title, text?, anchor?, priority? }` → `Task`. Модуль і власники визначаються з якоря |
| GET | `/inbox?projectId=&paths=` | Задачі, які агент може взяти: власник модуля → модулі змінених файлів → пріоритет → вік |
| GET | `/tasks/:id` | `{ task, events, jobs, context }` |
| POST | `/tasks/:id/claim` · `/heartbeat` · `/release` | Оренда (дефолт 30 хв, `thresholds.leaseMinutes`) |
| POST | `/tasks/:id/ask` · `/answer` · `/comment` | Питання агента (`needs_info`), відповідь QA (знову `queued`), коментар |
| POST | `/tasks/:id/report` | `{ summary, checks[], tests[], prUrl?, branch?, triage? }` → `review`. Для `add_test`/`change_test`/`remove_test`/`stabilize` `prUrl` обов'язковий |
| POST | `/tasks/:id/fail` · `/confirm` · `/request-changes` · `/retry` · `/reject` | Задача з PR закривається, коли QA підтвердив і злито саме PR останнього звіту; без PR — одразу після підтвердження. Підтвердження розбору (`triage`) застосовує його наслідки: дефект, задачу на тест або карантин і стабілізацію. `retry` повертає невдалу задачу в чергу; та сама причина (наприклад, тест знову впав) робить це сама |

Види задач: `add_test`, `change_test`, `remove_test`, `plan_module`, `read_asset`, `triage`,
`stabilize`, `question`. Задачі `question` — питання до людей, агенти їх не беруть.

## Входи

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/sources/tree?projectId=` | Дерево джерел (сторінки за батьками, файли Figma) |
| PATCH | `/sources/:id` | `{ included?, noAgents?, sectionId? }` — галочки «брати» і «не віддавати агентам», модуль |
| GET | `/sources/:id/view` | Блоки джерела з вкладеннями, кадрами і станом прочитання |
| GET | `/requirements?blockIds=` · `/blocks/:id` | Той самий вигляд для довільних блоків |
| POST | `/inputs/confluence/tree` | `{ projectId, ref }` — дерево сторінок без тіл (посилання на простір або сторінку, `/display/`, `/x/`, `pageId`) |
| POST | `/inputs/confluence/modules` | `{ projectId, rootSourceId }` — модулі з першого рівня дерева + задачі `plan_module` |
| POST | `/inputs/figma` | `{ projectId, url }` — файл або кадр Figma як джерело; кадр = блок + знімок |
| POST | `/inputs/sync` · `/sources/:id/sync` | Оновлення вибраних джерел (за версією сторінки чи файлу); зміни в блоках із кейсами дають `case_update` |
| PATCH | `/blocks/:id` | `{ route }` — кадр ↔ маршрут застосунку |
| GET | `/assets?projectId=&readingState=` · `/assets/:id/file` | Вкладення; файл віддається з `nosniff` і `CSP: sandbox` |
| POST | `/assets/:id/reading` · `/assets/:id/decide` | Опис картинки від агента; рішення QA (`approve`, правка тексту). Рішення закриває або повертає задачу `read_asset` |

## Результати CI і статус

| Метод | Шлях | Опис |
|---|---|---|
| POST | `/ingest/run` | `{ sha, branch, prNumber?, event: pr\|main\|local, source, runUrl?, manifest?, results[], coverage?, mutation?, assertionChanges?, codeowners? }` → `{ runId, tests, failed, unknownCases, tasks }`. Прогін `kind='ci'`; на main — `triage` на падіння, `stabilize` на флейки, кейс із тестом на main стає `automated`, а кейс, усі тести якого прибрано з коду, — знову `candidate`. Стан тестів, їхні зв'язки з кейсами й статус кейса задає лише main; прогони PR і локальні додають результати. Порожній маніфест ігнорується. Ліміт тіла — 50 МБ (решта API — 1 МБ) |
| POST | `/ingest/pr-event` | `{ prNumber, state: opened\|merged\|closed }` — злиття закриває підтверджені задачі, закриття без злиття повертає їх у чергу |
| POST | `/ingest/push-check` | `{ sha, branch, viaPr, prNumbers }` — коміт у main повз PR позначається і йде в сповіщення |
| GET | `/status.md?projectId=&branch=main` · `/status` | Вміст `QA_STATUS.md` (детермінований) або ті самі дані JSON |
| GET | `/pr-comment.md?projectId=&prNumber=&sha=` | Коментар у PR, перший рядок `<!-- jules-qa -->` |
| POST | `/cases/reserve` | `{ section, title, ... }` → `{ caseId, proposalId }`: кейс-чернетка з ID одразу, затвердження чекає QA |
| GET · PATCH | `/tests`, `/tests/:id` | Тести в коді з кейсами й останнім результатом; карантин |
| GET · POST | `/push-checks`, `/push-checks/:id/ack` | Коміти в main повз PR і позначка «бачив» |

## Звіти й стан

| Метод | Шлях | Опис |
|---|---|---|
| GET | `/dashboard/agentic?projectId=` | Зведення циклу: задачі, трасування, тести за рівнями, main, прийняття QA за моделями, стан інтеграцій |
| GET · POST | `/reports/weekly` | Перегляд і публікація тижневої задачі в Jira (одна на тиждень, мітка `jules-weekly-<тиждень>`) |
| GET · POST | `/health`, `/health/check` | Стан Confluence, Jira, Figma; перехід «працює ↔ лежить» іде в сповіщення |
| GET · POST | `/notifications`, `/notifications/test` | Журнал сповіщень і перевірка Telegram |

## Поза `/api/registry`

| Метод | Шлях | Опис |
|---|---|---|
| POST | `/mcp` | MCP-сервер для агентів розробників (Streamable HTTP, без сесій). Вхід — як для API. Інструменти: `qa_inbox`, `qa_claim`, `qa_heartbeat`, `qa_release`, `qa_get_case`, `qa_get_requirement`, `qa_get_screen`, `qa_get_asset`, `qa_propose_plan`, `qa_post_reading`, `qa_reserve_case`, `qa_ask`, `qa_raise_question`, `qa_report`, `qa_fail`, `qa_weekly_data`, `qa_weekly_publish` |
| GET | `/cli/jules-qa.mjs` | Зібраний CLI для CI і хуків репо продукту (публічно) |
