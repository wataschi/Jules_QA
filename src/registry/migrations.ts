/**
 * Міграції схеми реєстру.
 *
 * Правила:
 *  - міграції додаються тільки в кінець масиву, наявні не редагуються;
 *  - застосовані записуються в `_migrations`, тому `migrate()` ідемпотентний;
 *  - JSON-поля (`checks`, `steps`, `tags`, `automation`, `testrail`, `patch`,
 *    `payload`, `diff`, `origin`, `filter`, `env`, `evidence`) зберігаються як
 *    TEXT із JSON; серіалізацію робить сховище, не маршрут.
 */
import type { DatabaseSync } from 'node:sqlite';

export interface Migration {
  id: string;
  up: (db: DatabaseSync) => void;
}

const INIT_SQL = `
CREATE TABLE projects (
  id                  TEXT PRIMARY KEY,
  key                 TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL,
  description         TEXT NOT NULL DEFAULT '',
  base_url            TEXT,
  confluence_space    TEXT,
  testrail_project_id INTEGER,
  testrail_suite_id   INTEGER,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);

CREATE TABLE sections (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  parent_id           TEXT REFERENCES sections(id) ON DELETE CASCADE,
  name                TEXT NOT NULL,
  code                TEXT NOT NULL,
  position            INTEGER NOT NULL DEFAULT 0,
  testrail_section_id INTEGER,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL,
  UNIQUE (project_id, code)
);
CREATE INDEX idx_sections_project ON sections(project_id, parent_id, position);

-- Лічильник номерів кейсів у межах секції. Не зменшується: ID унікальні назавжди.
CREATE TABLE case_counters (
  section_id TEXT PRIMARY KEY,
  next       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE cases (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  section_id    TEXT NOT NULL REFERENCES sections(id) ON DELETE RESTRICT,
  title         TEXT NOT NULL,
  kind          TEXT NOT NULL DEFAULT 'positive',
  priority      TEXT NOT NULL DEFAULT 'P2',
  status        TEXT NOT NULL DEFAULT 'draft',
  preconditions TEXT NOT NULL DEFAULT '',
  checks        TEXT NOT NULL DEFAULT '[]',
  steps         TEXT NOT NULL DEFAULT '[]',
  tags          TEXT NOT NULL DEFAULT '[]',
  owner         TEXT,
  automation    TEXT NOT NULL DEFAULT '{"status":"manual"}',
  testrail      TEXT NOT NULL DEFAULT '{}',
  version       INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL,
  updated_at    TEXT NOT NULL,
  created_by    TEXT,
  updated_by    TEXT,
  -- Тіньова колонка пошуку: нормалізований (регістронезалежний для укр/рос)
  -- зліпок title + checks + preconditions + tags. Пише сховище.
  search_text   TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_cases_project ON cases(project_id, section_id);
CREATE INDEX idx_cases_status ON cases(project_id, status);
CREATE INDEX idx_cases_updated ON cases(project_id, updated_at DESC);
CREATE INDEX idx_cases_automation ON cases(project_id, json_extract(automation, '$.status'));

-- FTS5 із зовнішнім контентом: індексуємо лише нормалізований search_text.
CREATE VIRTUAL TABLE cases_fts USING fts5(
  search_text,
  content = 'cases',
  content_rowid = 'rowid'
);

CREATE TRIGGER cases_fts_ai AFTER INSERT ON cases BEGIN
  INSERT INTO cases_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;
CREATE TRIGGER cases_fts_ad AFTER DELETE ON cases BEGIN
  INSERT INTO cases_fts(cases_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
END;
CREATE TRIGGER cases_fts_au AFTER UPDATE ON cases BEGIN
  INSERT INTO cases_fts(cases_fts, rowid, search_text) VALUES ('delete', old.rowid, old.search_text);
  INSERT INTO cases_fts(rowid, search_text) VALUES (new.rowid, new.search_text);
END;

CREATE TABLE revisions (
  id       TEXT PRIMARY KEY,
  case_id  TEXT NOT NULL,
  version  INTEGER NOT NULL,
  at       TEXT NOT NULL,
  author   TEXT NOT NULL DEFAULT 'system',
  reason   TEXT NOT NULL DEFAULT '',
  patch    TEXT NOT NULL DEFAULT '{}',
  batch_id TEXT
);
CREATE INDEX idx_revisions_case ON revisions(case_id, version DESC);
CREATE INDEX idx_revisions_batch ON revisions(batch_id);

CREATE TABLE sources (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind             TEXT NOT NULL,
  title            TEXT NOT NULL,
  url              TEXT,
  external_id      TEXT,
  external_version TEXT,
  content_hash     TEXT NOT NULL,
  imported_at      TEXT NOT NULL,
  updated_at       TEXT NOT NULL
);
CREATE INDEX idx_sources_project ON sources(project_id);

CREATE TABLE blocks (
  id           TEXT PRIMARY KEY,
  source_id    TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
  position     INTEGER NOT NULL DEFAULT 0,
  heading      TEXT NOT NULL DEFAULT '',
  anchor       TEXT,
  text         TEXT NOT NULL,
  hash         TEXT NOT NULL,
  change_state TEXT NOT NULL DEFAULT 'new'
);
CREATE INDEX idx_blocks_source ON blocks(source_id, position);

-- Покриття не має FK на blocks/cases: після видалення джерела зв'язок лишається
-- «сиротою» (orphan), як вимагає контракт API.
CREATE TABLE coverage (
  id         TEXT PRIMARY KEY,
  block_id   TEXT NOT NULL,
  case_id    TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'quote',
  confirmed  INTEGER NOT NULL DEFAULT 0,
  note       TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  UNIQUE (block_id, case_id)
);
CREATE INDEX idx_coverage_case ON coverage(case_id);
CREATE INDEX idx_coverage_block ON coverage(block_id);

CREATE TABLE proposals (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind          TEXT NOT NULL,
  state         TEXT NOT NULL DEFAULT 'pending',
  title         TEXT NOT NULL,
  rationale     TEXT NOT NULL DEFAULT '',
  payload       TEXT,
  diff          TEXT NOT NULL DEFAULT '{}',
  origin        TEXT NOT NULL DEFAULT '{}',
  coverage_kind TEXT,
  reviewer      TEXT,
  note          TEXT NOT NULL DEFAULT '',
  created_at    TEXT NOT NULL,
  decided_at    TEXT,
  source_id     TEXT,
  block_id      TEXT
);
CREATE INDEX idx_proposals_project ON proposals(project_id, state, kind);
CREATE INDEX idx_proposals_source ON proposals(source_id);

CREATE TABLE selections (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT NOT NULL DEFAULT '',
  mode            TEXT NOT NULL DEFAULT 'filter',
  case_ids        TEXT NOT NULL DEFAULT '[]',
  filter          TEXT,
  stop_on_failure INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_selections_project ON selections(project_id);

CREATE TABLE registry_runs (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL DEFAULT 'manual',
  title        TEXT NOT NULL,
  selection_id TEXT,
  env          TEXT NOT NULL DEFAULT '{}',
  state        TEXT NOT NULL DEFAULT 'open',
  executor     TEXT,
  started_at   TEXT NOT NULL,
  finished_at  TEXT,
  note         TEXT NOT NULL DEFAULT ''
);
CREATE INDEX idx_runs_project ON registry_runs(project_id, started_at DESC);

CREATE TABLE run_items (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES registry_runs(id) ON DELETE CASCADE,
  case_id     TEXT NOT NULL,
  position    INTEGER NOT NULL DEFAULT 0,
  status      TEXT NOT NULL DEFAULT 'untested',
  comment     TEXT NOT NULL DEFAULT '',
  evidence    TEXT NOT NULL DEFAULT '[]',
  defect_id   TEXT,
  auto_run_id TEXT,
  duration_ms INTEGER,
  updated_at  TEXT NOT NULL,
  updated_by  TEXT,
  UNIQUE (run_id, case_id)
);
CREATE INDEX idx_run_items_case ON run_items(case_id, updated_at DESC);
CREATE INDEX idx_run_items_run ON run_items(run_id, position);

CREATE TABLE defects (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  title         TEXT NOT NULL,
  details       TEXT NOT NULL DEFAULT '',
  severity      TEXT NOT NULL DEFAULT 'medium',
  status        TEXT NOT NULL DEFAULT 'open',
  case_id       TEXT,
  run_item_id   TEXT,
  dedup_key     TEXT NOT NULL,
  seen_count    INTEGER NOT NULL DEFAULT 1,
  first_seen_at TEXT NOT NULL,
  last_seen_at  TEXT NOT NULL,
  external_key  TEXT,
  external_url  TEXT,
  UNIQUE (project_id, dedup_key)
);
CREATE INDEX idx_defects_project ON defects(project_id, status);

CREATE TABLE skill_runs (
  id                TEXT PRIMARY KEY,
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  skill             TEXT NOT NULL,
  state             TEXT NOT NULL DEFAULT 'running',
  input             TEXT,
  output            TEXT,
  model             TEXT,
  proposal_count    INTEGER NOT NULL DEFAULT 0,
  prompt_tokens     INTEGER,
  completion_tokens INTEGER,
  duration_ms       INTEGER,
  error             TEXT,
  started_at        TEXT NOT NULL,
  finished_at       TEXT
);
CREATE INDEX idx_skill_runs_project ON skill_runs(project_id, started_at DESC);

CREATE TABLE testrail_mappings (
  id           TEXT PRIMARY KEY,
  project_id   TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name         TEXT NOT NULL,
  template     TEXT NOT NULL DEFAULT 'checklist',
  fields       TEXT NOT NULL DEFAULT '{}',
  type_map     TEXT NOT NULL DEFAULT '{}',
  priority_map TEXT NOT NULL DEFAULT '{}',
  id_field     TEXT NOT NULL DEFAULT 'custom_tc_id',
  delimiter    TEXT NOT NULL DEFAULT ',',
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);
CREATE INDEX idx_mappings_project ON testrail_mappings(project_id);
`;

/**
 * Jules 2.0: входи (дерево Confluence, вкладення, кадри Figma), тести в коді й
 * результати CI за комітом, задачі для агентів, токени й люди, зовнішні задачі,
 * сповіщення. Див. docs/agent-driven-qa-plan.md, розділ 4.2.
 */
const V2_SQL = `
ALTER TABLE projects ADD COLUMN repo TEXT;
ALTER TABLE projects ADD COLUMN settings TEXT NOT NULL DEFAULT '{}';

ALTER TABLE sections ADD COLUMN paths TEXT NOT NULL DEFAULT '[]';
ALTER TABLE sections ADD COLUMN owners TEXT NOT NULL DEFAULT '[]';

ALTER TABLE sources ADD COLUMN parent_id TEXT;
ALTER TABLE sources ADD COLUMN depth INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN included INTEGER NOT NULL DEFAULT 1;
ALTER TABLE sources ADD COLUMN no_agents INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN space_key TEXT;
ALTER TABLE sources ADD COLUMN root_id TEXT;
ALTER TABLE sources ADD COLUMN section_id TEXT;
ALTER TABLE sources ADD COLUMN last_error TEXT;
ALTER TABLE sources ADD COLUMN checked_at TEXT;
CREATE INDEX idx_sources_parent ON sources(project_id, parent_id);

ALTER TABLE blocks ADD COLUMN node_id TEXT;
ALTER TABLE blocks ADD COLUMN route TEXT;
ALTER TABLE blocks ADD COLUMN meta TEXT NOT NULL DEFAULT '{}';

-- Картинки, схеми й знімки кадрів. Файл лежить у data/assets/<sha256>, тож
-- однакова картинка на кількох сторінках зберігається один раз, а погоджене
-- прочитання переноситься за хешем.
CREATE TABLE assets (
  id                  TEXT PRIMARY KEY,
  project_id          TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  source_id           TEXT,
  block_id            TEXT,
  kind                TEXT NOT NULL,
  name                TEXT NOT NULL,
  diagram_type        TEXT,
  media_type          TEXT,
  sha256              TEXT,
  size                INTEGER,
  origin_url          TEXT,
  extracted_text      TEXT NOT NULL DEFAULT '',
  reading             TEXT,
  reading_by          TEXT,
  reading_state       TEXT NOT NULL DEFAULT 'none',
  reading_decided_by  TEXT,
  error               TEXT,
  created_at          TEXT NOT NULL,
  updated_at          TEXT NOT NULL
);
CREATE INDEX idx_assets_block ON assets(block_id);
CREATE INDEX idx_assets_source ON assets(source_id);
CREATE INDEX idx_assets_hash ON assets(project_id, sha256);

-- Сторінка вимоги ↔ кадр Figma (посилання, знайдені в тексті сторінки).
CREATE TABLE block_links (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  from_block_id TEXT NOT NULL,
  to_block_id   TEXT,
  url           TEXT NOT NULL,
  file_key      TEXT,
  node_id       TEXT,
  created_at    TEXT NOT NULL,
  UNIQUE (from_block_id, url)
);
CREATE INDEX idx_block_links_to ON block_links(to_block_id);

CREATE TABLE tests (
  id             TEXT PRIMARY KEY,
  project_id     TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  test_key       TEXT NOT NULL,
  file           TEXT NOT NULL,
  name           TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  level          TEXT NOT NULL DEFAULT 'unit',
  framework      TEXT NOT NULL DEFAULT 'unknown',
  author         TEXT NOT NULL DEFAULT 'human',
  state          TEXT NOT NULL DEFAULT 'active',
  on_main        INTEGER NOT NULL DEFAULT 0,
  first_seen_sha TEXT,
  last_seen_sha  TEXT,
  first_seen_at  TEXT NOT NULL,
  last_seen_at   TEXT NOT NULL,
  UNIQUE (project_id, test_key)
);
CREATE INDEX idx_tests_file ON tests(project_id, file);

CREATE TABLE test_links (
  test_id TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  case_id TEXT NOT NULL,
  PRIMARY KEY (test_id, case_id)
);
CREATE INDEX idx_test_links_case ON test_links(case_id);

ALTER TABLE registry_runs ADD COLUMN sha TEXT;
ALTER TABLE registry_runs ADD COLUMN branch TEXT;
ALTER TABLE registry_runs ADD COLUMN pr_number INTEGER;
ALTER TABLE registry_runs ADD COLUMN source TEXT;
ALTER TABLE registry_runs ADD COLUMN event TEXT;
ALTER TABLE registry_runs ADD COLUMN run_url TEXT;
CREATE INDEX idx_runs_sha ON registry_runs(project_id, event, branch, started_at DESC);

CREATE TABLE test_results (
  id          TEXT PRIMARY KEY,
  run_id      TEXT NOT NULL REFERENCES registry_runs(id) ON DELETE CASCADE,
  test_id     TEXT NOT NULL REFERENCES tests(id) ON DELETE CASCADE,
  status      TEXT NOT NULL,
  duration_ms INTEGER,
  error       TEXT,
  retries     INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL,
  UNIQUE (run_id, test_id)
);
CREATE INDEX idx_test_results_test ON test_results(test_id, created_at DESC);

CREATE TABLE code_coverage (
  id               TEXT PRIMARY KEY,
  project_id       TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  run_id           TEXT,
  sha              TEXT NOT NULL,
  branch           TEXT,
  path             TEXT NOT NULL,
  lines_found      INTEGER,
  lines_hit        INTEGER,
  branches_found   INTEGER,
  branches_hit     INTEGER,
  mutants_total    INTEGER,
  mutants_killed   INTEGER,
  mutants_survived INTEGER,
  mutation_score   REAL,
  created_at       TEXT NOT NULL,
  UNIQUE (project_id, sha, path)
);

CREATE TABLE pull_requests (
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  number            INTEGER NOT NULL,
  state             TEXT NOT NULL DEFAULT 'opened',
  title             TEXT,
  url               TEXT,
  head_branch       TEXT,
  sha               TEXT,
  assertion_changes TEXT NOT NULL DEFAULT '[]',
  updated_at        TEXT NOT NULL,
  merged_at         TEXT,
  PRIMARY KEY (project_id, number)
);

CREATE TABLE push_checks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  sha             TEXT NOT NULL,
  branch          TEXT NOT NULL,
  via_pr          INTEGER NOT NULL,
  pr_numbers      TEXT NOT NULL DEFAULT '[]',
  author          TEXT,
  acknowledged_by TEXT,
  created_at      TEXT NOT NULL,
  UNIQUE (project_id, sha)
);

CREATE TABLE task_counters (
  project_id TEXT PRIMARY KEY,
  next       INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE tasks (
  id              TEXT PRIMARY KEY,
  project_id      TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind            TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'queued',
  title           TEXT NOT NULL,
  text            TEXT NOT NULL DEFAULT '',
  author          TEXT NOT NULL,
  author_kind     TEXT NOT NULL DEFAULT 'qa',
  anchor          TEXT NOT NULL DEFAULT '{}',
  section_id      TEXT,
  owners          TEXT NOT NULL DEFAULT '[]',
  priority        TEXT NOT NULL DEFAULT 'P2',
  parent_id       TEXT,
  dedup_key       TEXT,
  lease_holder    TEXT,
  lease_until     TEXT,
  attempts        INTEGER NOT NULL DEFAULT 0,
  branch          TEXT,
  pr_url          TEXT,
  pr_number       INTEGER,
  report          TEXT,
  qa_confirmed_by TEXT,
  qa_confirmed_at TEXT,
  merged_at       TEXT,
  queued_at       TEXT NOT NULL,
  done_at         TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);
CREATE INDEX idx_tasks_project ON tasks(project_id, state, kind);
CREATE INDEX idx_tasks_pr ON tasks(project_id, pr_number);
CREATE UNIQUE INDEX idx_tasks_dedup ON tasks(project_id, dedup_key)
  WHERE dedup_key IS NOT NULL AND state NOT IN ('done', 'rejected');

CREATE TABLE task_events (
  id          TEXT PRIMARY KEY,
  task_id     TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  at          TEXT NOT NULL,
  author      TEXT NOT NULL,
  author_kind TEXT NOT NULL,
  type        TEXT NOT NULL,
  text        TEXT NOT NULL DEFAULT '',
  data        TEXT NOT NULL DEFAULT '{}'
);
CREATE INDEX idx_task_events_task ON task_events(task_id, at);

CREATE TABLE agent_jobs (
  id          TEXT PRIMARY KEY,
  project_id  TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  task_id     TEXT NOT NULL,
  holder      TEXT NOT NULL,
  agent       TEXT,
  model       TEXT,
  given       TEXT NOT NULL DEFAULT '[]',
  branch      TEXT,
  pr_url      TEXT,
  outcome     TEXT,
  started_at  TEXT NOT NULL,
  finished_at TEXT
);
CREATE INDEX idx_agent_jobs_task ON agent_jobs(task_id, started_at DESC);

CREATE TABLE external_issues (
  id         TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  system     TEXT NOT NULL,
  kind       TEXT NOT NULL,
  key        TEXT NOT NULL,
  url        TEXT,
  ref        TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (project_id, system, kind, ref)
);

CREATE TABLE users (
  login        TEXT PRIMARY KEY,
  name         TEXT,
  role         TEXT NOT NULL DEFAULT 'dev',
  created_at   TEXT NOT NULL,
  last_seen_at TEXT NOT NULL
);

-- Машинні й персональні токени. Зберігається лише sha256 токена.
CREATE TABLE api_tokens (
  id           TEXT PRIMARY KEY,
  name         TEXT NOT NULL,
  token_hash   TEXT NOT NULL UNIQUE,
  role         TEXT NOT NULL,
  project_id   TEXT,
  owner        TEXT,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  last_used_at TEXT,
  revoked_at   TEXT
);

CREATE TABLE health_checks (
  target     TEXT PRIMARY KEY,
  ok         INTEGER NOT NULL,
  checked_at TEXT NOT NULL,
  since      TEXT NOT NULL,
  error      TEXT,
  details    TEXT NOT NULL DEFAULT '{}'
);

CREATE TABLE notifications (
  id         TEXT PRIMARY KEY,
  project_id TEXT,
  kind       TEXT NOT NULL,
  dedup_key  TEXT NOT NULL UNIQUE,
  payload    TEXT NOT NULL DEFAULT '{}',
  created_at TEXT NOT NULL,
  sent_at    TEXT,
  error      TEXT
);
`;

export const migrations: Migration[] = [
  {
    id: '001_init',
    up: (db) => {
      db.exec(INIT_SQL);
    },
  },
  {
    id: '002_agent_driven_qa',
    up: (db) => {
      db.exec(V2_SQL);
    },
  },
  {
    // Повтори сповіщень: пауза між спробами, ліміт спроб і причина пропуску
    // (вимкнений проєкт, вичерпані спроби) — щоб невідправне не блокувало чергу.
    id: '003_notifications_retry',
    up: (db) => {
      db.exec(`
ALTER TABLE notifications ADD COLUMN attempts INTEGER NOT NULL DEFAULT 0;
ALTER TABLE notifications ADD COLUMN next_try_at TEXT;
ALTER TABLE notifications ADD COLUMN skipped_reason TEXT;
CREATE INDEX idx_notifications_pending ON notifications(sent_at, next_try_at, created_at);
`);
    },
  },
];

/** Проганяє всі незастосовані міграції. Безпечно викликати багато разів. */
export function migrate(db: DatabaseSync): void {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  const applied = new Set(
    (db.prepare('SELECT id FROM _migrations').all() as Array<{ id: string }>).map((r) => r.id),
  );

  for (const migration of migrations) {
    if (applied.has(migration.id)) continue;
    db.exec('BEGIN IMMEDIATE');
    try {
      migration.up(db);
      db.prepare('INSERT INTO _migrations (id, applied_at) VALUES (?, ?)').run(
        migration.id,
        new Date().toISOString(),
      );
      db.exec('COMMIT');
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        /* вже відкотилося */
      }
      const reason = error instanceof Error ? error.message : String(error);
      throw new Error(`Міграція «${migration.id}» не застосувалася: ${reason}`);
    }
  }
}

/** Список застосованих міграцій — для діагностики й скрипта міграції. */
export function appliedMigrations(db: DatabaseSync): Array<{ id: string; applied_at: string }> {
  db.exec('CREATE TABLE IF NOT EXISTS _migrations (id TEXT PRIMARY KEY, applied_at TEXT NOT NULL)');
  return db.prepare('SELECT id, applied_at FROM _migrations ORDER BY id').all() as Array<{
    id: string;
    applied_at: string;
  }>;
}
