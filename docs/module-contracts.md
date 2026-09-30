# Межі модулів (контракт між шарами)

Щоб шари можна було писати й тестувати незалежно: **скіли та інтеграції — чисті функції**
без доступу до бази. Вони приймають дані й повертають дані. Запис у реєстр, транзакції
й черга апрувів — тільки в `src/registry/*-store.ts` і `src/server/registry-routes.ts`.

Усі типи — з `src/registry/types.ts`. Імпорти відносні, з розширенням `.js` (ESM + NodeNext).

## `src/registry/skills/write-cases.ts`

```ts
export interface WriteCasesInput {
  blocks: Array<{ id: string; heading: string; text: string }>;
  sectionPath: string;            // «Кібер / Карта договору / Акти» — контекст для моделі
  projectName: string;
  style?: {
    maxPerBlock?: number;         // дефолт 8
    includeDerived?: boolean;     // дефолт true — негативні/нейтральні/безпекові
    examples?: Array<{ title: string; checks: string[] }>; // few-shot зі справжніх кейсів команди
    language?: string;            // дефолт 'Ukrainian'
  };
}
export interface DraftCase {
  blockId: string;
  coverageKind: 'quote' | 'derived';
  rationale: string;              // чому цей кейс потрібен — показуємо в черзі апрувів
  case: {
    title: string;
    kind: CaseKind;
    priority: CasePriority;
    preconditions: string;
    checks: string[];
    tags: string[];
  };
}
export interface SkillUsage { promptTokens?: number; completionTokens?: number; model?: string; durationMs: number; }
export interface WriteCasesResult { drafts: DraftCase[]; usage: SkillUsage; warnings: string[]; }

export function writeCases(input: WriteCasesInput): Promise<WriteCasesResult>;
```

## `src/registry/skills/validate-coverage.ts`

```ts
export interface ValidateCoverageInput {
  blocks: Array<{ id: string; heading: string; text: string }>;
  cases: Array<{ id: string; title: string; checks: string[]; kind: CaseKind }>;
  sectionPath: string;
}
export interface CoverageReport {
  gaps: Array<{ blockId: string; fragment: string; suggestion: DraftCase['case'] }>;
  duplicates: Array<{ caseIds: string[]; reason: string }>;
  untestable: Array<{ caseId: string; reason: string }>;
  contradictions: Array<{ caseId: string; blockId: string; reason: string }>;
}
export interface ValidateCoverageResult { report: CoverageReport; usage: SkillUsage; warnings: string[]; }

export function validateCoverage(input: ValidateCoverageInput): Promise<ValidateCoverageResult>;
```

## `src/registry/skills/model.ts`

```ts
/** Обгортка над chatJson із src/config/models.ts: JSON-схема, валідація zod, до 2 повторів. */
export function askJson<T>(args: {
  role: 'planning' | 'critic';
  system: string;
  user: string;
  schema: z.ZodType<T>;
  maxRetries?: number;          // дефолт 2
}): Promise<{ value: T; usage: SkillUsage }>;
```

Правила: один блок вимог = один запит; історія не накопичується (кожен запит самодостатній);
температура низька; при невалідному JSON — повтор із текстом помилки валідації.

## `src/integrations/confluence.ts`

```ts
export interface ConfluencePage { externalId: string; title: string; version: string; html: string; url: string; }
/** Тягне сторінку за URL або ID. Потребує CONFLUENCE_BASE_URL + CONFLUENCE_EMAIL + CONFLUENCE_API_TOKEN. */
export function fetchConfluencePage(ref: { url?: string; pageId?: string }): Promise<ConfluencePage>;
export function isConfluenceConfigured(): boolean;

export interface RawBlock { heading: string; anchor?: string; text: string; position: number; }
/** Розбиває storage-HTML Confluence або звичайний текст/markdown на блоки за заголовками. */
export function splitIntoBlocks(content: string, opts?: { format?: 'html' | 'text' | 'markdown'; maxChars?: number }): RawBlock[];
export function hashBlock(text: string): string;   // sha256, перші 16 символів
```

`splitIntoBlocks` вимоги: заголовки h1–h4 стають межами; таблиці Confluence перетворюються
на текстові рядки «колонка: значення»; блок довший за `maxChars` (дефолт 4000) ділиться по абзацах;
порожні блоки й навігаційні макроси відкидаються.

## `src/integrations/testrail-csv.ts` і `testrail-xml.ts`

```ts
export interface ExportCase {            // те, що віддає сховище для експорту
  id: string; title: string; sectionPath: string; kind: CaseKind; priority: CasePriority;
  preconditions: string; checks: string[]; steps: Array<{ action: string; expected: string }>;
  tags: string[]; refs: string[];        // посилання на блоки вимог
  testrailCaseId?: number;
}
export function buildTestrailCsv(cases: ExportCase[], mapping: TestrailMapping): string;
export function parseTestrailCsv(text: string, mapping: TestrailMapping): { cases: Partial<ExportCase>[]; warnings: string[] };
export function buildTestrailXml(cases: ExportCase[], mapping: TestrailMapping): string;
export function parseTestrailXml(xml: string): { cases: Partial<ExportCase>[]; warnings: string[] };
```

CSV: UTF-8 з BOM (щоб Excel не ламав кирилицю), CRLF, лапки подвоюються. Для
`template='steps_separated'` кожен крок — окремий рядок, решта полів лише в першому.
Для `template='checklist'` перевірки склеюються в одне поле маркованим списком.

## `src/integrations/testrail-api.ts`

```ts
export interface TestrailClientOptions { baseUrl: string; user: string; apiKey: string; }
export class TestrailClient {
  constructor(opts: TestrailClientOptions);
  getSections(projectId: number, suiteId?: number): Promise<Array<{ id: number; name: string; parent_id: number | null }>>;
  addSection(projectId: number, name: string, parentId?: number, suiteId?: number): Promise<{ id: number }>;
  getCases(projectId: number, suiteId?: number, sectionId?: number): Promise<Array<Record<string, unknown>>>;
  addCase(sectionId: number, payload: Record<string, unknown>): Promise<{ id: number }>;
  updateCase(caseId: number, payload: Record<string, unknown>): Promise<void>;
  /** Пакетне оновлення однаковими значеннями — один запит на багато кейсів. */
  updateCases(suiteId: number, caseIds: number[], payload: Record<string, unknown>): Promise<void>;
  getRuns(projectId: number): Promise<Array<Record<string, unknown>>>;
  getResultsForRun(runId: number): Promise<Array<Record<string, unknown>>>;
}
export function isTestrailConfigured(): boolean;
```

Обов'язково: обробка 429 з `Retry-After` (до 5 повторів з експоненційною паузою), таймаут 30 с,
жодного логування ключа, помилки згортаються в `TestrailError` з полем `status`.

## Що викликає маршрутизатор

`src/server/registry-routes.ts` — єдине місце, де ці функції зшиваються зі сховищем:

- `POST /skills/write-cases` → читає блоки зі сховища → `writeCases(...)` → для кожного `DraftCase`
  створює `proposal` (`kind='case_create'`, `coverageKind`, `origin.blockId`, `rationale`) → пише `skillRun`.
- `POST /skills/validate-coverage` → `validateCoverage(...)` → `report` у відповідь, `gaps` додатково
  стають пропозиціями `case_create`.
- `POST /sources/import` → `fetchConfluencePage` або текст із тіла → `splitIntoBlocks` + `hashBlock`
  → зберігає `source` + `blocks`.
- `POST /sources/:id/refresh` → повторний fetch → порівняння хешів → `changeState` + пропозиції
  `case_update` для кейсів, зв'язаних із зміненими блоками.
- `GET /export/testrail.csv|xml` → `buildTestrailCsv|Xml`.
- `POST /testrail/push|pull` → `TestrailClient`.
