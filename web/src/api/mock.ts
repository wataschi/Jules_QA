/**
 * Фікстури для розробки інтерфейсу без бекенда.
 *
 * Це НЕ «демо-режим» у продакшені: увімкнути можна лише вручну —
 * `?mock=1` в адресі або `localStorage.julesMock = '1'`. Вимкнути — `?mock=0`.
 * Дані живуть у пам'яті вкладки: правки, апруви і статуси прогону справді
 * змінюють стан, щоб можна було перевірити сценарії UI, але після
 * перезавантаження все повертається до початкового набору.
 *
 * Див. `web/README.md`.
 */

import type { JulesApi } from './client';
import { ApiError, qs, withToken } from './client';
import type {
  AutomationStatus,
  BulkPreviewRow,
  BulkResult,
  Case,
  CaseDetail,
  CaseKind,
  CaseListItem,
  CasePriority,
  CaseStatus,
  Coverage,
  DashboardData,
  Defect,
  ItemStatus,
  Page,
  Project,
  Proposal,
  Revision,
  RegistryRun,
  RunDetail,
  RunItem,
  RunItemCase,
  SectionNode,
  Selection,
  SkillRun,
  Source,
  SourceDetail,
  TestrailMapping,
  Block,
} from '../types';

/* ─────────────────────────── увімкнення режиму ───────────────────────── */

const LS_MOCK = 'julesMock';

export function mockEnabled(): boolean {
  let flag = false;
  try {
    flag = localStorage.getItem(LS_MOCK) === '1';
  } catch {
    /* localStorage недоступний */
  }
  try {
    const param = new URLSearchParams(window.location.search).get('mock');
    if (param === '1') {
      flag = true;
      try {
        localStorage.setItem(LS_MOCK, '1');
      } catch {
        /* нічого */
      }
    } else if (param === '0') {
      flag = false;
      try {
        localStorage.removeItem(LS_MOCK);
      } catch {
        /* нічого */
      }
    }
  } catch {
    /* немає window (не має статися в браузері) */
  }
  return flag;
}

/* ──────────────────────────────── дані ───────────────────────────────── */

const NOW = Date.now();
const iso = (minutesAgo: number) => new Date(NOW - minutesAgo * 60_000).toISOString();

const project: Project = {
  id: 'cyber',
  key: 'CYBER',
  name: 'Кабінет кіберзахисту',
  description: 'Фікстури для розробки інтерфейсу',
  baseUrl: 'https://app.example.com',
  confluenceSpace: 'CYBER',
  createdAt: iso(60 * 24 * 40),
  updatedAt: iso(30),
};

interface FlatSection {
  id: string;
  parentId: string | null;
  name: string;
  code: string;
  position: number;
}

const flatSections: FlatSection[] = [
  { id: 'sec-reg', parentId: null, name: 'Реєстр актів', code: 'REG', position: 0 },
  { id: 'sec-reg-list', parentId: 'sec-reg', name: 'Список і фільтри', code: 'REGL', position: 0 },
  { id: 'sec-reg-card', parentId: 'sec-reg', name: 'Картка акта', code: 'REGC', position: 1 },
  { id: 'sec-auth', parentId: null, name: 'Автентифікація', code: 'AUTH', position: 1 },
  { id: 'sec-rep', parentId: null, name: 'Звітність', code: 'REP', position: 2 },
];

function mkCase(
  id: string,
  sectionId: string,
  title: string,
  extra: Partial<Case> & { tags?: string[] } = {},
): Case {
  return {
    id,
    projectId: project.id,
    sectionId,
    title,
    kind: 'positive',
    priority: 'P2',
    status: 'approved',
    preconditions: 'Користувач авторизований, у реєстрі є щонайменше 3 акти.',
    checks: [
      'Відкрити розділ «Реєстр актів»',
      'Перевірити, що таблиця містить колонки «Номер», «Дата», «Статус»',
      'Перевірити, що пагінація показує загальну кількість',
    ],
    steps: [],
    tags: ['smoke'],
    owner: 'qa',
    automation: { status: 'manual' },
    testrail: {},
    version: 2,
    createdAt: iso(60 * 24 * 12),
    updatedAt: iso(120),
    createdBy: 'local',
    updatedBy: 'local',
    ...extra,
  };
}

let cases: Case[] = [
  mkCase('CYBER-REGL-001', 'sec-reg-list', 'Реєстр актів відкривається зі списком і пагінацією'),
  mkCase('CYBER-REGL-002', 'sec-reg-list', 'Фільтр за статусом акта звужує список', {
    priority: 'P1',
    tags: ['smoke', 'filters'],
    automation: { status: 'automated', scenarioPath: 'scenarios/registry-filter.yaml', lastAutoRunId: 'legacy-run-1', lastAutoStatus: 'passed', lastAutoAt: iso(180), flakeScore: 0.08 },
  }),
  mkCase('CYBER-REGL-003', 'sec-reg-list', 'Пошук за номером акта знаходить запис у будь-якому регістрі', {
    kind: 'neutral',
    tags: ['search'],
    automation: { status: 'candidate' },
  }),
  mkCase('CYBER-REGL-004', 'sec-reg-list', 'Порожній реєстр показує підказку, а не пусту таблицю', {
    kind: 'negative',
    priority: 'P3',
    status: 'in_review',
    tags: ['empty-state'],
  }),
  mkCase('CYBER-REGC-001', 'sec-reg-card', 'Картка акта показує всі обов’язкові поля', { priority: 'P1' }),
  mkCase('CYBER-REGC-002', 'sec-reg-card', 'Збереження картки без обов’язкового поля дає помилку', {
    kind: 'negative',
    automation: {
      status: 'quarantined',
      scenarioPath: 'scenarios/card-validation.yaml',
      quarantineReason: 'Нестабільний через анімацію тостів',
      flakeScore: 0.42,
      lastAutoStatus: 'failed',
      lastAutoAt: iso(400),
      lastAutoRunId: 'legacy-run-2',
    },
  }),
  mkCase('CYBER-AUTH-001', 'sec-auth', 'Вхід із правильними обліковими даними', {
    priority: 'P1',
    tags: ['smoke', 'auth'],
    automation: { status: 'automated', scenarioPath: 'scenarios/login.yaml', lastAutoStatus: 'passed', lastAutoAt: iso(60), flakeScore: 0.02, lastAutoRunId: 'legacy-run-3' },
  }),
  mkCase('CYBER-AUTH-002', 'sec-auth', 'Блокування після п’яти невдалих спроб входу', {
    kind: 'security',
    priority: 'P1',
    tags: ['auth', 'security'],
  }),
  mkCase('CYBER-AUTH-003', 'sec-auth', 'Форма входу доступна з клавіатури', {
    kind: 'a11y',
    priority: 'P3',
    status: 'draft',
    tags: ['a11y'],
  }),
  mkCase('CYBER-REP-001', 'sec-rep', 'Звіт за період формується у CSV', { tags: ['reports'] }),
  mkCase('CYBER-REP-002', 'sec-rep', 'Звіт за великий період не перевищує 10 с', {
    kind: 'performance',
    priority: 'P3',
    tags: ['reports', 'perf'],
  }),
  mkCase('CYBER-REP-003', 'sec-rep', 'Застарілий звіт за формою №2', { status: 'deprecated', priority: 'P4' }),
];

const source: Source = {
  id: 'src-1',
  projectId: project.id,
  kind: 'confluence',
  title: 'Вимоги до реєстру актів (v4)',
  url: 'https://wiki.example.com/spaces/CYBER/pages/12345',
  externalId: '12345',
  externalVersion: '4',
  contentHash: 'h-src-1',
  importedAt: iso(60 * 24 * 6),
  updatedAt: iso(60 * 5),
  blockCount: 5,
  gapCount: 2,
  // Лічильник змінених блоків, як його віддає сервер, а не прапорець.
  changed: 2,
};

const source2: Source = {
  id: 'src-2',
  projectId: project.id,
  kind: 'paste',
  title: 'Нотатки з наради про звітність',
  contentHash: 'h-src-2',
  importedAt: iso(60 * 24 * 2),
  updatedAt: iso(60 * 24 * 2),
  blockCount: 2,
  gapCount: 1,
  changed: 0,
};

const blocks: Block[] = [
  {
    id: 'blk-1',
    sourceId: 'src-1',
    position: 0,
    heading: '1. Список актів',
    text: 'Реєстр відображає акти у вигляді таблиці з колонками «Номер», «Дата», «Статус». Кількість записів на сторінці — 50.',
    hash: 'b1',
    changeState: 'same',
    anchor: 'spisok-aktiv',
  },
  {
    id: 'blk-2',
    sourceId: 'src-1',
    position: 1,
    heading: '2. Фільтрація',
    text: 'Користувач може фільтрувати акти за статусом, датою й відповідальним. Фільтри зберігаються в адресі сторінки.',
    hash: 'b2',
    changeState: 'changed',
  },
  {
    id: 'blk-3',
    sourceId: 'src-1',
    position: 2,
    heading: '3. Пошук',
    text: 'Пошук працює за номером акта незалежно від регістру літер.',
    hash: 'b3',
    changeState: 'same',
  },
  {
    id: 'blk-4',
    sourceId: 'src-1',
    position: 3,
    heading: '4. Експорт',
    text: 'Реєстр можна вигрузити у CSV із урахуванням поточних фільтрів.',
    hash: 'b4',
    changeState: 'new',
  },
  {
    id: 'blk-5',
    sourceId: 'src-1',
    position: 4,
    heading: '5. Права доступу',
    text: 'Оператор бачить лише акти свого підрозділу; адміністратор — усі.',
    hash: 'b5',
    changeState: 'same',
  },
  {
    id: 'blk-6',
    sourceId: 'src-2',
    position: 0,
    heading: 'Звіти',
    text: 'Звіт за період має формуватися не довше 10 секунд.',
    hash: 'b6',
    changeState: 'same',
  },
  {
    id: 'blk-7',
    sourceId: 'src-2',
    position: 1,
    heading: 'Формати',
    text: 'Підтримувані формати звіту: CSV і XLSX.',
    hash: 'b7',
    changeState: 'same',
  },
];

let coverageLinks: Coverage[] = [
  { id: 'cov-1', blockId: 'blk-1', caseId: 'CYBER-REGL-001', kind: 'quote', confirmed: true, note: '', createdAt: iso(5000) },
  { id: 'cov-2', blockId: 'blk-2', caseId: 'CYBER-REGL-002', kind: 'quote', confirmed: true, note: '', createdAt: iso(5000) },
  { id: 'cov-3', blockId: 'blk-3', caseId: 'CYBER-REGL-003', kind: 'quote', confirmed: false, note: '', createdAt: iso(5000) },
  { id: 'cov-4', blockId: 'blk-1', caseId: 'CYBER-REGL-004', kind: 'derived', confirmed: false, note: '', createdAt: iso(5000) },
  { id: 'cov-5', blockId: 'blk-6', caseId: 'CYBER-REP-002', kind: 'quote', confirmed: true, note: '', createdAt: iso(5000) },
];

let proposals: Proposal[] = [
  {
    id: 'prop-1',
    projectId: project.id,
    kind: 'case_create',
    state: 'pending',
    title: 'Експорт реєстру у CSV враховує активні фільтри',
    rationale:
      'Блок 4 вимог прямо описує вигрузку CSV із урахуванням фільтрів, а в реєстрі кейсів немає жодного кейса на експорт.',
    payload: {
      sectionId: 'sec-reg-list',
      title: 'Експорт реєстру у CSV враховує активні фільтри',
      kind: 'positive',
      priority: 'P2',
      preconditions: 'У реєстрі є акти щонайменше у двох статусах.',
      checks: [
        'Застосувати фільтр за статусом «Підписаний»',
        'Натиснути «Експорт у CSV»',
        'Перевірити, що у файлі лише акти зі статусом «Підписаний»',
      ],
      tags: ['export'],
    },
    diff: {
      title: { before: null, after: 'Експорт реєстру у CSV враховує активні фільтри' },
      checks: { before: null, after: ['Застосувати фільтр…', 'Натиснути «Експорт у CSV»', 'Перевірити вміст файлу'] },
    },
    origin: { skill: 'write-cases', skillRunId: 'sr-1', blockId: 'blk-4', sourceId: 'src-1' },
    coverageKind: 'quote',
    note: '',
    createdAt: iso(45),
    blockHeading: '4. Експорт',
    blockText: 'Реєстр можна вигрузити у CSV із урахуванням поточних фільтрів.',
  },
  {
    id: 'prop-2',
    projectId: project.id,
    kind: 'case_create',
    state: 'pending',
    title: 'Експорт при ста тисячах записів не валить сторінку',
    rationale:
      'У вимозі про це не сказано. Додано як домисел: великий обсяг — типова причина падіння вигрузок.',
    payload: {
      sectionId: 'sec-reg-list',
      title: 'Експорт при ста тисячах записів не валить сторінку',
      kind: 'performance',
      priority: 'P3',
      preconditions: 'У реєстрі понад 100 000 актів.',
      checks: ['Зняти фільтри', 'Натиснути «Експорт у CSV»', 'Перевірити, що сторінка залишається відповідною'],
      tags: ['export', 'perf'],
    },
    diff: { title: { before: null, after: 'Експорт при ста тисячах записів не валить сторінку' } },
    origin: { skill: 'write-cases', skillRunId: 'sr-1', blockId: 'blk-4', sourceId: 'src-1' },
    coverageKind: 'derived',
    note: '',
    createdAt: iso(45),
    blockHeading: '4. Експорт',
    blockText: 'Реєстр можна вигрузити у CSV із урахуванням поточних фільтрів.',
  },
  {
    id: 'prop-3',
    projectId: project.id,
    kind: 'case_update',
    state: 'pending',
    title: 'CYBER-REGL-002: фільтри зберігаються в адресі сторінки',
    rationale: 'Блок 2 вимог змінився після переімпорту: додано вимогу зберігати фільтри в URL.',
    payload: {
      caseId: 'CYBER-REGL-002',
      changes: {
        checks: [
          'Застосувати фільтр за статусом',
          'Перевірити, що список звузився',
          'Перевірити, що фільтр відображений в адресі сторінки',
          'Перезавантажити сторінку й перевірити, що фільтр зберігся',
        ],
      },
    },
    diff: {
      checks: {
        before: [
          'Застосувати фільтр за статусом',
          'Перевірити, що список звузився',
        ],
        after: [
          'Застосувати фільтр за статусом',
          'Перевірити, що список звузився',
          'Перевірити, що фільтр відображений в адресі сторінки',
          'Перезавантажити сторінку й перевірити, що фільтр зберігся',
        ],
      },
    },
    origin: { blockId: 'blk-2', sourceId: 'src-1', caseId: 'CYBER-REGL-002' },
    coverageKind: 'quote',
    note: '',
    createdAt: iso(30),
    blockHeading: '2. Фільтрація',
    blockText:
      'Користувач може фільтрувати акти за статусом, датою й відповідальним. Фільтри зберігаються в адресі сторінки.',
  },
  {
    id: 'prop-4',
    projectId: project.id,
    kind: 'locator_update',
    state: 'pending',
    title: 'Локатор кнопки «Експорт» у scenarios/registry-filter.yaml',
    rationale: 'Рушій самовиправився на кроці 4: селектор змінився після релізу.',
    payload: {
      caseId: 'CYBER-REGL-002',
      scenarioPath: 'scenarios/registry-filter.yaml',
      before: 'button[data-test=export]',
      after: 'button[data-testid=registry-export]',
    },
    diff: {
      locator: { before: 'button[data-test=export]', after: 'button[data-testid=registry-export]' },
    },
    origin: { runId: 'legacy-run-1', caseId: 'CYBER-REGL-002' },
    note: '',
    createdAt: iso(20),
  },
  {
    id: 'prop-5',
    projectId: project.id,
    kind: 'bulk_edit',
    state: 'pending',
    title: 'Замінити «вигрузка» на «експорт» у 6 кейсах',
    rationale: 'Термінологія у вимогах змінилася; у кейсах лишилася стара назва.',
    payload: {
      projectId: project.id,
      operation: { op: 'replace-text', find: 'вигрузка', replace: 'експорт', fields: ['title', 'checks'], regex: false, caseSensitive: false },
      dryRun: false,
    },
    diff: {
      'CYBER-REP-001.title': { before: 'Вигрузка за період формується у CSV', after: 'Експорт за період формується у CSV' },
    },
    origin: { skill: 'validate-coverage', skillRunId: 'sr-2' },
    note: '',
    createdAt: iso(10),
  },
];

let runs: RegistryRun[] = [
  {
    id: 'run-1',
    projectId: project.id,
    kind: 'mixed',
    title: 'Регрес реєстру перед релізом 4.2',
    env: { baseUrl: 'https://app.example.com', mode: 'regression', label: 'stage' },
    state: 'open',
    executor: 'local',
    startedAt: iso(90),
    summary: { total: 6, passed: 2, failed: 1, blocked: 0, skipped: 0, untested: 3 },
    note: '',
  },
  {
    id: 'run-2',
    projectId: project.id,
    kind: 'manual',
    title: 'Смоук автентифікації',
    env: { baseUrl: 'https://app.example.com', label: 'prod' },
    state: 'completed',
    executor: 'local',
    startedAt: iso(60 * 26),
    finishedAt: iso(60 * 25),
    summary: { total: 3, passed: 3, failed: 0, blocked: 0, skipped: 0, untested: 0 },
    note: 'Без зауважень',
  },
  {
    id: 'run-3',
    projectId: project.id,
    kind: 'auto',
    title: 'Нічний автопрогін',
    env: { baseUrl: 'https://app.example.com', mode: 'regression' },
    state: 'completed',
    executor: 'scheduler',
    startedAt: iso(60 * 10),
    finishedAt: iso(60 * 9),
    summary: { total: 2, passed: 1, failed: 1, blocked: 0, skipped: 0, untested: 0 },
    note: '',
  },
];

const runItemsByRun: Record<string, RunItem[]> = {
  'run-1': [
    mkItem('run-1', 'CYBER-REGL-001', 0, 'passed'),
    mkItem('run-1', 'CYBER-REGL-002', 1, 'failed', { autoRunId: 'legacy-run-1', comment: 'Фільтр не зберігається після перезавантаження' }),
    mkItem('run-1', 'CYBER-REGL-003', 2, 'passed'),
    mkItem('run-1', 'CYBER-REGC-001', 3, 'untested'),
    mkItem('run-1', 'CYBER-AUTH-001', 4, 'untested', { autoRunId: 'legacy-run-3' }),
    mkItem('run-1', 'CYBER-REP-001', 5, 'untested'),
  ],
  'run-2': [
    mkItem('run-2', 'CYBER-AUTH-001', 0, 'passed'),
    mkItem('run-2', 'CYBER-AUTH-002', 1, 'passed'),
    mkItem('run-2', 'CYBER-AUTH-003', 2, 'passed'),
  ],
  'run-3': [
    mkItem('run-3', 'CYBER-REGL-002', 0, 'passed', { autoRunId: 'legacy-run-1' }),
    mkItem('run-3', 'CYBER-REGC-002', 1, 'failed', { autoRunId: 'legacy-run-2' }),
  ],
};

function mkItem(
  runId: string,
  caseId: string,
  position: number,
  status: ItemStatus,
  extra: Partial<RunItem> = {},
): RunItem {
  return {
    id: `${runId}:${caseId}`,
    runId,
    caseId,
    position,
    status,
    comment: '',
    evidence: [],
    updatedAt: iso(80 - position),
    updatedBy: 'local',
    ...extra,
  };
}

const defects: Defect[] = [
  {
    id: 'def-1',
    projectId: project.id,
    title: 'Фільтр реєстру не зберігається в адресі сторінки',
    details: 'Після перезавантаження фільтр скидається.',
    severity: 'high',
    status: 'open',
    caseId: 'CYBER-REGL-002',
    dedupKey: 'd1',
    seenCount: 3,
    firstSeenAt: iso(60 * 40),
    lastSeenAt: iso(80),
  },
  {
    id: 'def-2',
    projectId: project.id,
    title: 'Валідація картки акта не показує повідомлення',
    details: '',
    severity: 'medium',
    status: 'triaged',
    caseId: 'CYBER-REGC-002',
    dedupKey: 'd2',
    seenCount: 1,
    firstSeenAt: iso(60 * 20),
    lastSeenAt: iso(60 * 20),
  },
];

let skillRuns: SkillRun[] = [
  {
    id: 'sr-1',
    projectId: project.id,
    skill: 'write-cases',
    state: 'done',
    input: { sectionId: 'sec-reg-list', blockIds: ['blk-4'] },
    model: 'qwen2.5-vl-7b',
    proposalCount: 2,
    promptTokens: 3140,
    completionTokens: 860,
    durationMs: 18_400,
    startedAt: iso(46),
    finishedAt: iso(45),
  },
  {
    id: 'sr-2',
    projectId: project.id,
    skill: 'validate-coverage',
    state: 'done',
    input: { sourceId: 'src-1' },
    model: 'qwen2.5-vl-7b',
    proposalCount: 1,
    promptTokens: 5020,
    completionTokens: 410,
    durationMs: 22_900,
    startedAt: iso(12),
    finishedAt: iso(10),
  },
  {
    id: 'sr-3',
    projectId: project.id,
    skill: 'format-export',
    state: 'failed',
    input: { target: 'api', mappingId: 'map-1' },
    proposalCount: 0,
    durationMs: 1200,
    error: 'TESTRAIL_API_KEY не заданий',
    startedAt: iso(300),
    finishedAt: iso(300),
  },
];

let mappings: TestrailMapping[] = [
  {
    id: 'map-1',
    projectId: project.id,
    name: 'Основний профіль',
    template: 'checklist',
    fields: { title: 'title', preconditions: 'custom_preconds', checks: 'custom_steps' },
    typeMap: { positive: 1, negative: 2, security: 3 },
    priorityMap: { P1: 4, P2: 3, P3: 2, P4: 1 },
    idField: 'custom_tc_id',
    delimiter: ',',
    createdAt: iso(60 * 24 * 30),
    updatedAt: iso(60 * 24 * 3),
  },
];

const selections: Selection[] = [
  {
    id: 'sel-1',
    projectId: project.id,
    name: 'Смоук',
    description: 'Кейси з тегом smoke',
    mode: 'filter',
    caseIds: [],
    filter: { tags: ['smoke'], includeSubsections: true },
    stopOnFailure: false,
    createdAt: iso(60 * 24 * 20),
    updatedAt: iso(60 * 24 * 20),
  },
];

const revisionsByCase: Record<string, Revision[]> = {};
let undoStack: Record<string, Array<{ caseId: string; field: string; before: unknown }>> = {};

/* ───────────────────────────── допоміжне ─────────────────────────────── */

function sectionPath(sectionId: string): string {
  const parts: string[] = [];
  let current = flatSections.find((s) => s.id === sectionId);
  let guard = 0;
  while (current && guard++ < 10) {
    parts.unshift(current.name);
    current = current.parentId ? flatSections.find((s) => s.id === current!.parentId) : undefined;
  }
  return parts.join(' / ');
}

function descendants(sectionId: string): string[] {
  const out = [sectionId];
  for (const s of flatSections) {
    if (s.parentId === sectionId) out.push(...descendants(s.id));
  }
  return out;
}

function toListItem(c: Case): CaseListItem {
  const links = coverageLinks.filter((l) => l.caseId === c.id);
  const lastItem = Object.values(runItemsByRun)
    .flat()
    .filter((i) => i.caseId === c.id && i.status !== 'untested')
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))[0];
  return {
    ...c,
    sectionPath: sectionPath(c.sectionId),
    coverage: {
      quote: links.filter((l) => l.kind === 'quote').length,
      derived: links.filter((l) => l.kind === 'derived').length,
    },
    lastResult: lastItem
      ? { status: lastItem.status, at: lastItem.updatedAt, runId: lastItem.runId }
      : undefined,
  };
}

function buildTree(): SectionNode[] {
  const nodeOf = (s: FlatSection): SectionNode => {
    const children = flatSections
      .filter((x) => x.parentId === s.id)
      .sort((a, b) => a.position - b.position)
      .map(nodeOf);
    const own = cases.filter((c) => c.sectionId === s.id).length;
    const deepIds = descendants(s.id);
    return {
      id: s.id,
      projectId: project.id,
      parentId: s.parentId,
      name: s.name,
      code: s.code,
      position: s.position,
      path: sectionPath(s.id),
      caseCount: own,
      caseCountDeep: cases.filter((c) => deepIds.includes(c.sectionId)).length,
      children,
      createdAt: iso(60 * 24 * 40),
      updatedAt: iso(60 * 24 * 40),
    };
  };
  return flatSections
    .filter((s) => s.parentId === null)
    .sort((a, b) => a.position - b.position)
    .map(nodeOf);
}

function delay<T>(value: T, ms = 180, signal?: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'));
      return;
    }
    const timer = setTimeout(() => resolve(value), ms);
    signal?.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new DOMException('Aborted', 'AbortError'));
      },
      { once: true },
    );
  });
}

function paged<T>(items: T[], page = 1, limit = 50): Page<T> {
  const from = (page - 1) * limit;
  return { items: items.slice(from, from + limit), total: items.length, page, limit };
}

function recalcSummary(runId: string): void {
  const items = runItemsByRun[runId] ?? [];
  const run = runs.find((r) => r.id === runId);
  if (!run) return;
  const count = (s: ItemStatus) => items.filter((i) => i.status === s).length;
  run.summary = {
    total: items.length,
    passed: count('passed'),
    failed: count('failed'),
    blocked: count('blocked'),
    skipped: count('skipped'),
    untested: count('untested'),
  };
}

function toRunItemCase(caseId: string): RunItemCase {
  const c = cases.find((x) => x.id === caseId);
  if (!c) {
    return {
      id: caseId,
      title: caseId,
      kind: 'positive',
      priority: 'P3',
      checks: [],
      preconditions: '',
      automation: { status: 'manual' },
      sectionPath: '',
    };
  }
  return {
    id: c.id,
    title: c.title,
    kind: c.kind,
    priority: c.priority,
    checks: c.checks,
    preconditions: c.preconditions,
    automation: c.automation,
    sectionPath: sectionPath(c.sectionId),
  };
}

function applyReplace(text: string, find: string, replace: string, regex: boolean, cs: boolean): { out: string; count: number } {
  if (!find) return { out: text, count: 0 };
  let re: RegExp;
  try {
    re = new RegExp(regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), cs ? 'g' : 'gi');
  } catch {
    return { out: text, count: 0 };
  }
  const matches = text.match(re);
  if (!matches) return { out: text, count: 0 };
  return { out: text.replace(re, replace), count: matches.length };
}

function caseFieldsFilter(query: {
  sectionId?: string;
  includeSubsections?: boolean;
  tag?: string[];
  kind?: CaseKind;
  priority?: CasePriority;
  status?: CaseStatus;
  automation?: AutomationStatus;
  q?: string;
}): Case[] {
  let out = [...cases];
  if (query.sectionId) {
    const ids = query.includeSubsections === false ? [query.sectionId] : descendants(query.sectionId);
    out = out.filter((c) => ids.includes(c.sectionId));
  }
  if (query.tag?.length) out = out.filter((c) => query.tag!.every((t) => c.tags.includes(t)));
  if (query.kind) out = out.filter((c) => c.kind === query.kind);
  if (query.priority) out = out.filter((c) => c.priority === query.priority);
  if (query.status) out = out.filter((c) => c.status === query.status);
  if (query.automation) out = out.filter((c) => c.automation.status === query.automation);
  if (query.q) {
    const needle = query.q.toLocaleLowerCase('uk');
    out = out.filter((c) =>
      [c.title, c.preconditions, ...c.checks, ...c.tags].join('\n').toLocaleLowerCase('uk').includes(needle),
    );
  }
  return out;
}

/* ─────────────────────────── власне клієнт ───────────────────────────── */

let counter = 100;
const nextId = (prefix: string) => `${prefix}-${++counter}`;

export const mockApi: JulesApi = {
  listProjects: (signal) => delay([project], 120, signal),
  getProject: (_id, signal) => delay(project, 120, signal),
  patchProject: (_id, patch, signal) => {
    Object.assign(project, patch, { updatedAt: new Date().toISOString() });
    return delay(project, 160, signal);
  },

  getDashboard: (_projectId, signal) => {
    const countBy = <K extends string>(keys: readonly K[], pick: (c: Case) => K): Record<K, number> => {
      const out = Object.fromEntries(keys.map((k) => [k, 0])) as Record<K, number>;
      for (const c of cases) out[pick(c)] += 1;
      return out;
    };
    const coveredBlocks = new Set(coverageLinks.map((l) => l.blockId)).size;
    const data: DashboardData = {
      project,
      cases: {
        total: cases.length,
        byStatus: countBy(['draft', 'in_review', 'approved', 'deprecated'] as const, (c) => c.status),
        byAutomation: countBy(
          ['manual', 'candidate', 'automated', 'quarantined'] as const,
          (c) => c.automation.status,
        ),
        byPriority: countBy(['P1', 'P2', 'P3', 'P4'] as const, (c) => c.priority),
      },
      coverage: {
        blocks: blocks.length,
        coveredBlocks,
        gaps: blocks.length - coveredBlocks,
        derivedShare: coverageLinks.length
          ? coverageLinks.filter((l) => l.kind === 'derived').length / coverageLinks.length
          : 0,
        casesWithSource: new Set(coverageLinks.map((l) => l.caseId)).size,
      },
      runs: {
        last7d: 3,
        last30d: 11,
        passRate7d: 0.78,
        open: runs.filter((r) => r.state === 'open').length,
        recent: runs.map((r) => ({
          id: r.id,
          title: r.title,
          kind: r.kind,
          state: r.state,
          startedAt: r.startedAt,
          summary: r.summary,
        })),
      },
      flaky: cases
        .filter((c) => (c.automation.flakeScore ?? 0) > 0)
        .sort((a, b) => (b.automation.flakeScore ?? 0) - (a.automation.flakeScore ?? 0))
        .map((c) => ({
          caseId: c.id,
          title: c.title,
          flakeScore: c.automation.flakeScore ?? 0,
          lastResult: toListItem(c).lastResult?.status,
        })),
      modules: flatSections
        .filter((s) => s.parentId === null)
        .map((s) => {
          const ids = descendants(s.id);
          const list = cases.filter((c) => ids.includes(c.sectionId));
          return {
            sectionId: s.id,
            name: s.name,
            cases: list.length,
            automated: list.filter((c) => c.automation.status === 'automated').length,
            passRate: list.length ? 0.6 + (s.position % 3) * 0.12 : null,
            gaps: s.position === 0 ? 2 : s.position,
          };
        }),
      pending: {
        proposals: proposals.filter((p) => p.state === 'pending').length,
        drift: 2,
        openDefects: defects.filter((d) => d.status === 'open').length,
      },
    };
    return delay(data, 220, signal);
  },

  listSections: (_projectId, signal) => delay(buildTree(), 150, signal),
  createSection: (input, signal) => {
    const s: FlatSection = {
      id: nextId('sec'),
      parentId: input.parentId ?? null,
      name: input.name,
      code: (input.code ?? input.name.slice(0, 4)).toUpperCase().replace(/[^A-Z0-9]/g, 'X'),
      position: flatSections.length,
    };
    flatSections.push(s);
    const node = buildTree()
      .flatMap((n) => [n, ...n.children])
      .find((n) => n.id === s.id)!;
    return delay(node, 180, signal);
  },

  listCases: (query, signal) => {
    let list = caseFieldsFilter(query).map(toListItem);
    const sort = query.sort ?? 'id';
    const desc = sort.startsWith('-');
    const key = desc ? sort.slice(1) : sort;
    const prioRank: Record<string, number> = { P1: 1, P2: 2, P3: 3, P4: 4 };
    list = list.sort((a, b) => {
      let cmp = 0;
      if (key === 'title') cmp = a.title.localeCompare(b.title, 'uk');
      else if (key === 'updatedAt') cmp = a.updatedAt.localeCompare(b.updatedAt);
      else if (key === 'priority') cmp = prioRank[a.priority] - prioRank[b.priority];
      else cmp = a.id.localeCompare(b.id);
      return desc ? -cmp : cmp;
    });
    return delay(paged(list, query.page ?? 1, query.limit ?? 50), 200, signal);
  },

  getCase: (id, signal) => {
    const c = cases.find((x) => x.id === id);
    if (!c) return Promise.reject(new ApiError('Кейс не знайдено', 404, `/cases/${id}`));
    return delay(toListItem(c) as CaseDetail, 160, signal);
  },

  patchCase: (id, patch, signal) => {
    const c = cases.find((x) => x.id === id);
    if (!c) return Promise.reject(new ApiError('Кейс не знайдено', 404, `/cases/${id}`));
    const before: Record<string, unknown> = {};
    for (const key of Object.keys(patch)) before[key] = (c as unknown as Record<string, unknown>)[key];
    Object.assign(c, patch, { version: c.version + 1, updatedAt: new Date().toISOString() });
    (revisionsByCase[id] ??= []).unshift({
      id: nextId('rev'),
      caseId: id,
      version: c.version,
      at: c.updatedAt,
      author: 'local',
      reason: 'правка вручну',
      patch: Object.fromEntries(
        Object.keys(patch).map((k) => [k, { before: before[k], after: (patch as Record<string, unknown>)[k] }]),
      ),
    });
    return delay(c, 200, signal);
  },

  getCaseHistory: (id, signal) => {
    const results = Object.values(runItemsByRun)
      .flat()
      .filter((i) => i.caseId === id)
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    return delay({ revisions: revisionsByCase[id] ?? [], results }, 180, signal);
  },

  setAutomation: (id, input, signal) => {
    const c = cases.find((x) => x.id === id);
    if (!c) return Promise.reject(new ApiError('Кейс не знайдено', 404, `/cases/${id}`));
    c.automation = { ...c.automation, ...input };
    c.updatedAt = new Date().toISOString();
    return delay(c, 200, signal);
  },

  bulk: (input, signal) => {
    const ids = input.caseIds?.length
      ? input.caseIds
      : caseFieldsFilter({
          sectionId: input.filter?.sectionIds?.[0],
          includeSubsections: input.filter?.includeSubsections,
          tag: input.filter?.tags,
          q: input.filter?.q,
        }).map((c) => c.id);
    const targets = cases.filter((c) => ids.includes(c.id));
    const preview: BulkPreviewRow[] = [];
    let occurrences = 0;
    const op = input.operation;
    const undo: Array<{ caseId: string; field: string; before: unknown }> = [];

    for (const c of targets) {
      if (op.op === 'replace-text') {
        for (const field of op.fields) {
          if (field === 'title' || field === 'preconditions') {
            const { out, count } = applyReplace(c[field], op.find, op.replace, op.regex, op.caseSensitive);
            if (count) {
              preview.push({ caseId: c.id, title: c.title, field, before: c[field], after: out, occurrences: count });
              occurrences += count;
              if (!input.dryRun) {
                undo.push({ caseId: c.id, field, before: c[field] });
                c[field] = out;
              }
            }
          } else if (field === 'checks') {
            const nextChecks = [...c.checks];
            let localCount = 0;
            nextChecks.forEach((line, i) => {
              const { out, count } = applyReplace(line, op.find, op.replace, op.regex, op.caseSensitive);
              nextChecks[i] = out;
              localCount += count;
            });
            if (localCount) {
              preview.push({
                caseId: c.id,
                title: c.title,
                field: 'checks',
                before: c.checks.join(' · '),
                after: nextChecks.join(' · '),
                occurrences: localCount,
              });
              occurrences += localCount;
              if (!input.dryRun) {
                undo.push({ caseId: c.id, field: 'checks', before: [...c.checks] });
                c.checks = nextChecks;
              }
            }
          }
        }
      } else if (op.op === 'set-field') {
        const field = op.field as 'kind' | 'priority' | 'status' | 'owner';
        const before = String(c[field] ?? '');
        if (before !== op.value) {
          preview.push({ caseId: c.id, title: c.title, field, before, after: op.value, occurrences: 1 });
          occurrences += 1;
          if (!input.dryRun) {
            undo.push({ caseId: c.id, field, before: c[field] });
            (c as unknown as Record<string, unknown>)[field] = op.value;
          }
        }
      } else if (op.op === 'add-tag' || op.op === 'remove-tag') {
        const before = [...c.tags];
        const after =
          op.op === 'add-tag'
            ? Array.from(new Set([...c.tags, ...op.tags]))
            : c.tags.filter((t) => !op.tags.includes(t));
        if (before.join(',') !== after.join(',')) {
          preview.push({
            caseId: c.id,
            title: c.title,
            field: 'tags',
            before: before.join(', '),
            after: after.join(', '),
            occurrences: 1,
          });
          occurrences += 1;
          if (!input.dryRun) {
            undo.push({ caseId: c.id, field: 'tags', before });
            c.tags = after;
          }
        }
      } else if (op.op === 'move') {
        if (c.sectionId !== op.sectionId) {
          preview.push({
            caseId: c.id,
            title: c.title,
            field: 'sectionId',
            before: sectionPath(c.sectionId),
            after: sectionPath(op.sectionId),
            occurrences: 1,
          });
          occurrences += 1;
          if (!input.dryRun) {
            undo.push({ caseId: c.id, field: 'sectionId', before: c.sectionId });
            c.sectionId = op.sectionId;
          }
        }
      } else if (op.op === 'set-automation') {
        preview.push({
          caseId: c.id,
          title: c.title,
          field: 'automation',
          before: c.automation.status,
          after: op.status,
          occurrences: 1,
        });
        occurrences += 1;
        if (!input.dryRun) {
          undo.push({ caseId: c.id, field: 'automation', before: { ...c.automation } });
          c.automation = { ...c.automation, status: op.status };
        }
      } else if (op.op === 'delete') {
        preview.push({
          caseId: c.id,
          title: c.title,
          field: 'status',
          before: c.status,
          after: op.hard ? '(видалено)' : 'deprecated',
          occurrences: 1,
        });
        occurrences += 1;
        if (!input.dryRun) {
          undo.push({ caseId: c.id, field: 'status', before: c.status });
          if (op.hard) cases = cases.filter((x) => x.id !== c.id);
          else c.status = 'deprecated';
        }
      }
    }

    const batchId = input.dryRun ? undefined : nextId('batch');
    if (batchId) undoStack[batchId] = undo;

    const result: BulkResult = {
      affected: new Set(preview.map((p) => p.caseId)).size,
      occurrences,
      preview: preview.slice(0, 200),
      applied: !input.dryRun,
      batchId,
    };
    return delay(result, 260, signal);
  },

  bulkUndo: (batchId, signal) => {
    const entries = undoStack[batchId];
    if (!entries) return Promise.reject(new ApiError('Пакет не знайдено', 404, '/cases/bulk/undo'));
    for (const entry of entries) {
      const c = cases.find((x) => x.id === entry.caseId);
      if (c) (c as unknown as Record<string, unknown>)[entry.field] = entry.before;
    }
    delete undoStack[batchId];
    return delay({ reverted: entries.length }, 200, signal);
  },

  listProposals: (query, signal) => {
    let list = proposals.filter((p) => (query.state ? p.state === query.state : true));
    if (query.kind) list = list.filter((p) => p.kind === query.kind);
    if (query.sourceId) list = list.filter((p) => p.origin.sourceId === query.sourceId);
    return delay(paged(list, query.page ?? 1, query.limit ?? 50), 200, signal);
  },

  approveProposals: (ids, signal) => {
    let created = 0;
    let updated = 0;
    for (const id of ids) {
      const p = proposals.find((x) => x.id === id);
      if (!p || p.state !== 'pending') continue;
      p.state = 'approved';
      p.decidedAt = new Date().toISOString();
      p.reviewer = 'local';
      if (p.kind === 'case_create') {
        const payload = p.payload as Record<string, unknown>;
        const sectionId = String(payload.sectionId ?? 'sec-reg-list');
        const code = flatSections.find((s) => s.id === sectionId)?.code ?? 'REG';
        const num = String(cases.filter((c) => c.sectionId === sectionId).length + 20).padStart(3, '0');
        cases.push(
          mkCase(`${project.key}-${code}-${num}`, sectionId, String(payload.title ?? p.title), {
            kind: (payload.kind as CaseKind) ?? 'positive',
            priority: (payload.priority as CasePriority) ?? 'P2',
            status: 'approved',
            preconditions: String(payload.preconditions ?? ''),
            checks: (payload.checks as string[]) ?? [],
            tags: (payload.tags as string[]) ?? [],
            version: 1,
          }),
        );
        created += 1;
      } else if (p.kind === 'case_update') {
        const payload = p.payload as { caseId?: string; changes?: Record<string, unknown> };
        const c = cases.find((x) => x.id === payload.caseId);
        if (c && payload.changes) {
          Object.assign(c, payload.changes, { version: c.version + 1, updatedAt: new Date().toISOString() });
          updated += 1;
        }
      } else {
        updated += 1;
      }
    }
    return delay({ approved: ids.length, created, updated, errors: [] }, 280, signal);
  },

  rejectProposals: (ids, note, signal) => {
    for (const id of ids) {
      const p = proposals.find((x) => x.id === id);
      if (!p) continue;
      p.state = 'rejected';
      p.note = note ?? '';
      p.decidedAt = new Date().toISOString();
      p.reviewer = 'local';
    }
    return delay({ rejected: ids.length }, 220, signal);
  },

  patchProposal: (id, patch, signal) => {
    const p = proposals.find((x) => x.id === id);
    if (!p) return Promise.reject(new ApiError('Пропозицію не знайдено', 404, `/proposals/${id}`));
    if (patch.payload !== undefined) {
      p.payload = patch.payload;
      const payload = patch.payload as { title?: string };
      if (payload?.title) p.title = payload.title;
    }
    if (patch.note !== undefined) p.note = patch.note;
    return delay(p, 200, signal);
  },

  deleteProposal: (id, signal) => {
    proposals = proposals.filter((p) => p.id !== id);
    return delay(undefined as void, 160, signal);
  },

  listSources: (_projectId, signal) => delay([source, source2], 160, signal),
  getSource: (id, signal) => {
    const s = id === 'src-2' ? source2 : source;
    const detail: SourceDetail = { ...s, blocks: blocks.filter((b) => b.sourceId === s.id) };
    return delay(detail, 180, signal);
  },
  importSource: (input, signal) => {
    const s: Source = {
      id: nextId('src'),
      projectId: project.id,
      kind: input.kind,
      title: input.title ?? input.url ?? 'Вставлений текст',
      url: input.url,
      contentHash: nextId('h'),
      importedAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      blockCount: 2,
      gapCount: 2,
      changed: 0,
    };
    const newBlocks: Block[] = (input.text ?? 'Блок один.\n\nБлок два.')
      .split(/\n\s*\n/)
      .filter(Boolean)
      .map((text, i) => ({
        id: nextId('blk'),
        sourceId: s.id,
        position: i,
        heading: `Блок ${i + 1}`,
        text: text.trim(),
        hash: nextId('b'),
        changeState: 'new' as const,
      }));
    blocks.push(...newBlocks);
    return delay({ source: s, blocks: newBlocks }, 400, signal);
  },
  refreshSource: (_id, signal) => delay({ changed: 1, added: 1, removed: 0, proposals: 2 }, 500, signal),
  deleteSource: (_id, signal) => delay(undefined as void, 200, signal),

  getCoverage: (query, signal) => {
    const relevant = blocks.filter((b) => (query.sourceId ? b.sourceId === query.sourceId : true));
    const rows = relevant.map((block) => {
      const links = coverageLinks.filter((l) => l.blockId === block.id);
      return {
        block,
        cases: links.map((l) => ({
          caseId: l.caseId,
          title: cases.find((c) => c.id === l.caseId)?.title ?? l.caseId,
          kind: l.kind,
          confirmed: l.confirmed,
        })),
        gap: links.length === 0,
      };
    });
    const covered = rows.filter((r) => !r.gap).length;
    return delay(
      {
        rows,
        stats: {
          blocks: rows.length,
          coveredBlocks: covered,
          gaps: rows.length - covered,
          derivedShare: coverageLinks.length
            ? coverageLinks.filter((l) => l.kind === 'derived').length / coverageLinks.length
            : 0,
        },
      },
      240,
      signal,
    );
  },
  linkCoverage: (input, signal) => {
    coverageLinks.push({
      id: nextId('cov'),
      blockId: input.blockId,
      caseId: input.caseId,
      kind: input.kind,
      confirmed: input.confirmed,
      note: '',
      createdAt: new Date().toISOString(),
    });
    return delay(undefined as void, 180, signal);
  },
  unlinkCoverage: (id, signal) => {
    coverageLinks = coverageLinks.filter((l) => l.id !== id);
    return delay(undefined as void, 160, signal);
  },

  writeCases: (input, signal) => {
    const run: SkillRun = {
      id: nextId('sr'),
      projectId: project.id,
      skill: 'write-cases',
      state: 'done',
      input,
      model: 'fixture-model',
      proposalCount: 2,
      promptTokens: 2100,
      completionTokens: 640,
      durationMs: 1500,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    skillRuns = [run, ...skillRuns];
    const generated: Proposal[] = [1, 2].map((n) => ({
      id: nextId('prop'),
      projectId: project.id,
      kind: 'case_create',
      state: 'pending',
      title: `Згенерований кейс ${n} за вибраними блоками`,
      rationale:
        n === 1 ? 'Прямо з тексту вибраного блоку вимог.' : 'Домисел: негативний сценарій, якого у вимозі немає.',
      payload: {
        sectionId: input.sectionId,
        title: `Згенерований кейс ${n} за вибраними блоками`,
        kind: n === 1 ? 'positive' : 'negative',
        priority: 'P2',
        checks: ['Крок перший', 'Крок другий', 'Очікуваний результат'],
        tags: ['ai'],
      },
      diff: { title: { before: null, after: `Згенерований кейс ${n}` } },
      origin: { skill: 'write-cases', skillRunId: run.id, blockId: input.blockIds?.[0], sourceId: 'src-1' },
      coverageKind: n === 1 ? 'quote' : 'derived',
      note: '',
      createdAt: new Date().toISOString(),
    }));
    proposals = [...generated, ...proposals];
    return delay({ skillRun: run, proposals: generated }, 900, signal);
  },

  validateCoverage: (input, signal) => {
    const run: SkillRun = {
      id: nextId('sr'),
      projectId: project.id,
      skill: 'validate-coverage',
      state: 'done',
      input,
      model: 'fixture-model',
      proposalCount: 0,
      promptTokens: 3300,
      completionTokens: 280,
      durationMs: 1700,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    };
    skillRuns = [run, ...skillRuns];
    return delay(
      {
        skillRun: run,
        report: {
          gaps: [
            { blockId: 'blk-4', heading: '4. Експорт', reason: 'Жодного кейса на вигрузку CSV' },
            { blockId: 'blk-5', heading: '5. Права доступу', reason: 'Немає кейсів на розмежування прав' },
          ],
          duplicates: [{ caseIds: ['CYBER-REGL-001', 'CYBER-REGL-004'], reason: 'Обидва перевіряють відкриття реєстру' }],
          untestable: [{ blockId: 'blk-5', reason: 'Формулювання без конкретних ролей' }],
          contradictions: [],
        },
        proposals: [],
      },
      900,
      signal,
    );
  },

  formatExport: (input, signal) =>
    delay(
      { skillRun: skillRuns[0], preview: { rows: input.caseIds?.length ?? 0 }, fileUrl: undefined },
      500,
      signal,
    ),

  listSkillRuns: (query, signal) => delay(paged(skillRuns, query.page ?? 1, query.limit ?? 50), 180, signal),

  listSelections: (_projectId, signal) => delay(selections, 150, signal),

  listRuns: (query, signal) => {
    let list = [...runs];
    if (query.kind) list = list.filter((r) => r.kind === query.kind);
    if (query.state) list = list.filter((r) => r.state === query.state);
    list.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return delay(paged(list, query.page ?? 1, query.limit ?? 50), 200, signal);
  },

  createRun: (input, signal) => {
    const id = nextId('run');
    const ids = input.caseIds?.length ? input.caseIds : cases.slice(0, 3).map((c) => c.id);
    const run: RegistryRun = {
      id,
      projectId: project.id,
      kind: input.kind,
      title: input.title ?? 'Новий прогін',
      selectionId: input.selectionId,
      env: input.env ?? {},
      state: 'open',
      executor: 'local',
      startedAt: new Date().toISOString(),
      summary: { total: ids.length, passed: 0, failed: 0, blocked: 0, skipped: 0, untested: ids.length },
      note: '',
    };
    runs = [run, ...runs];
    runItemsByRun[id] = ids.map((caseId, i) => mkItem(id, caseId, i, 'untested'));
    return delay(run, 300, signal);
  },

  getRun: (id, signal) => {
    const run = runs.find((r) => r.id === id);
    if (!run) return Promise.reject(new ApiError('Прогін не знайдено', 404, `/runs/${id}`));
    recalcSummary(id);
    const detail: RunDetail = {
      ...run,
      items: (runItemsByRun[id] ?? []).map((item) => ({ ...item, case: toRunItemCase(item.caseId) })),
    };
    return delay(detail, 220, signal);
  },

  patchRun: (id, patch, signal) => {
    const run = runs.find((r) => r.id === id);
    if (!run) return Promise.reject(new ApiError('Прогін не знайдено', 404, `/runs/${id}`));
    Object.assign(run, patch);
    if (patch.state === 'completed') run.finishedAt = new Date().toISOString();
    return delay(run, 220, signal);
  },

  setRunItem: (runId, caseId, input, signal) => {
    const items = runItemsByRun[runId] ?? [];
    const item = items.find((i) => i.caseId === caseId);
    if (!item) return Promise.reject(new ApiError('Кейса немає у прогоні', 404, `/runs/${runId}/items/${caseId}`));
    item.status = input.status;
    if (input.comment !== undefined) item.comment = input.comment;
    if (input.defect) item.defectId = nextId('def');
    item.updatedAt = new Date().toISOString();
    recalcSummary(runId);
    return delay(item, 180, signal);
  },

  startAuto: (runId, caseIds, signal) => {
    const items = runItemsByRun[runId] ?? [];
    const targets = items.filter(
      (i) =>
        (caseIds ? caseIds.includes(i.caseId) : true) &&
        cases.find((c) => c.id === i.caseId)?.automation.status === 'automated',
    );
    for (const item of targets) item.autoRunId ??= `legacy-run-${counter++}`;
    return delay({ queued: targets.length }, 400, signal);
  },

  rerunFailed: (runId, signal) => {
    const failed = (runItemsByRun[runId] ?? []).filter((i) => i.status === 'failed' || i.status === 'blocked');
    const id = nextId('run');
    const run: RegistryRun = {
      id,
      projectId: project.id,
      kind: 'mixed',
      title: `Повтор впалих (${runId})`,
      env: {},
      state: 'open',
      executor: 'local',
      startedAt: new Date().toISOString(),
      summary: { total: failed.length, passed: 0, failed: 0, blocked: 0, skipped: 0, untested: failed.length },
      note: '',
    };
    runs = [run, ...runs];
    runItemsByRun[id] = failed.map((f, i) => mkItem(id, f.caseId, i, 'untested'));
    return delay(run, 350, signal);
  },

  listDefects: (query, signal) => {
    let list = defects;
    if (query.status) list = list.filter((d) => d.status === query.status);
    if (query.caseId) list = list.filter((d) => d.caseId === query.caseId);
    return delay(paged(list, query.page ?? 1), 180, signal);
  },
  patchDefect: (id, patch, signal) => {
    const index = defects.findIndex((d) => d.id === id);
    if (index < 0) return Promise.reject(new Error(`Дефект «${id}» не знайдено`));
    defects[index] = { ...defects[index], ...patch } as Defect;
    return delay(defects[index], 160, signal);
  },

  listMappings: (_projectId, signal) => delay(mappings, 150, signal),
  createMapping: (input, signal) => {
    const m: TestrailMapping = {
      id: nextId('map'),
      projectId: project.id,
      name: input.name,
      template: input.template ?? 'checklist',
      fields: input.fields ?? {},
      typeMap: input.typeMap ?? {},
      priorityMap: input.priorityMap ?? {},
      idField: input.idField ?? 'custom_tc_id',
      delimiter: input.delimiter ?? ',',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    mappings = [...mappings, m];
    return delay(m, 220, signal);
  },
  patchMapping: (id, patch, signal) => {
    const m = mappings.find((x) => x.id === id);
    if (!m) return Promise.reject(new ApiError('Профіль не знайдено', 404, `/testrail/mappings/${id}`));
    Object.assign(m, patch, { updatedAt: new Date().toISOString() });
    return delay(m, 200, signal);
  },
  getDrift: (_projectId, signal) =>
    delay(
      [
        {
          caseId: 'CYBER-REGL-001',
          title: 'Реєстр актів відкривається зі списком і пагінацією',
          ours: 'Кількість записів на сторінці — 50',
          theirs: 'Кількість записів на сторінці — 25',
          fields: ['checks'],
        },
        {
          caseId: 'CYBER-AUTH-002',
          title: 'Блокування після п’яти невдалих спроб входу',
          ours: 'P1',
          theirs: 'P2',
          fields: ['priority'],
        },
      ],
      220,
      signal,
    ),
  exportUrl: (target, params) => withToken(`/api/registry/export/testrail.${target}${qs(params)}`),
  getIntegrationsHealth: async () => ({
    models: [
      { role: 'execution' as const, label: 'Виконання сценаріїв (Midscene)', configured: true, ok: true, baseUrl: 'http://localhost:1234/v1', model: 'qwen3-vl', modelAvailable: true, models: ['qwen3-vl'] },
      { role: 'planning' as const, label: 'Генерація кейсів (planner)', configured: true, ok: true, baseUrl: 'http://localhost:1234/v1', model: 'qwen3-vl', modelAvailable: true, models: ['qwen3-vl'] },
      { role: 'critic' as const, label: 'Перевірка згенерованого (critic)', configured: true, ok: false, baseUrl: 'http://localhost:8888/v1', model: 'qwen3-vl', error: 'ECONNREFUSED' },
    ],
    confluence: { configured: false },
    testrail: { configured: false },
    registry: { db: 'data/registry.db', node: '24.0.0' },
  }),

  /* ── старий світ рушія: логи вигадані, але форма справжня ── */
  legacyGetRun: (id, signal) =>
    delay(
      {
        id,
        status: 'passed',
        qaTargetUrl: 'https://app.example.com',
        qaScenarioPath: 'scenarios/registry-filter.yaml',
        qaMode: 'regression',
        scenarioName: 'Фільтр реєстру',
        startedAt: iso(180),
        finishedAt: iso(178),
        exitCode: 0,
        active: false,
        logs: [
          '[engine] запуск сценарію scenarios/registry-filter.yaml',
          '[engine] крок 1: відкрити https://app.example.com/registry — ok',
          '[engine] крок 2: застосувати фільтр «Підписаний» — ok',
          '[engine] крок 3: перевірити кількість рядків — ok',
          '[engine] сценарій пройдено за 14.2 с',
        ],
        stepResults: [
          { index: 0, kind: 'step', instruction: 'Відкрити реєстр', status: 'passed', attempts: 1, healed: false, handledBy: 'playwright', durationMs: 1200, modelCalls: 0 },
          { index: 1, kind: 'step', instruction: 'Застосувати фільтр', status: 'healed', attempts: 2, healed: true, handledBy: 'midscene', durationMs: 4300, modelCalls: 3 },
          { index: 2, kind: 'assertion', instruction: 'Рядків не більше 50', status: 'passed', attempts: 1, healed: false, handledBy: 'playwright', durationMs: 800, modelCalls: 1 },
          {
            index: 3,
            kind: 'assertion',
            instruction: 'Перелік наборів видно',
            status: 'failed',
            attempts: 2,
            healed: false,
            handledBy: 'midscene',
            durationMs: 9100,
            modelCalls: 2,
            errorClass: 'assertion',
            thought: 'На місці списку порожній блок',
          },
        ],
        evidence: {
          summary: { total: 4, passed: 2, failed: 1, healed: 1, skipped: 0, modelCalls: 6 },
          bugReports: [
            {
              id: 'bug-1',
              assertion: 'Перелік наборів видно',
              severity: 'medium',
              thought: 'На місці списку порожній блок',
              rootCauseHypothesis: 'Очікуваний стан UI не підтверджено.',
              confidence: 'unconfirmed',
              checkpointAfterStep: 2,
              contradictedBy: 'крок 3 «Клікнути назву набору» пройшов після цієї перевірки',
            },
          ],
        },
      },
      260,
      signal,
    ),
  legacyStreamUrl: (id) => `/api/runs/${encodeURIComponent(id)}/stream`,
  legacyListScenarios: (signal) =>
    delay(
      [
        { path: 'scenarios/registry-filter.yaml', name: 'Фільтр реєстру', goal: 'Перевірити фільтрацію' },
        { path: 'scenarios/login.yaml', name: 'Вхід у кабінет', goal: 'Перевірити автентифікацію' },
        { path: 'scenarios/card-validation.yaml', name: 'Валідація картки', goal: 'Перевірити обов’язкові поля' },
      ],
      150,
      signal,
    ),
  legacyGetSettings: (signal) =>
    delay(
      {
        qaTargetUrl: 'https://app.example.com',
        qaMode: 'regression' as const,
        qaScenarioPath: 'scenarios/registry-filter.yaml',
        debugCache: false,
        llmBaseUrl: 'http://127.0.0.1:1234/v1',
        llmModelName: 'fixture-model',
      },
      160,
      signal,
    ),
  legacySaveSettings: (settings, signal) => delay(settings, 220, signal),
  legacyCheckLlm: (signal) => delay({ ok: true, models: ['fixture-model'] }, 300, signal),
};
