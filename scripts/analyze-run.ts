/**
 * Розбір прогону реєстру: що сталося з кожним кейсом і чому.
 *
 *   npm run registry:analyze -- <runId>
 *   npm run registry:analyze            # останній прогін проєкту jules
 *
 * Зводить дані з двох світів: елементи прогону реєстру (статус по кейсу)
 * і прогони рушія (`data/runs/<uuid>.json`) з покроковими результатами,
 * самолікуванням, кількістю викликів моделі та знайденими дефектами.
 */
import fs from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const { DatabaseSync } = require('node:sqlite') as typeof import('node:sqlite');

const DB_PATH = process.env.REGISTRY_DB ?? path.join(process.cwd(), 'data', 'registry.db');
const RUNS_DIR = path.join(process.cwd(), 'data', 'runs');

interface EngineStep {
  index: number;
  kind: 'step' | 'assertion';
  instruction: string;
  status: 'passed' | 'failed' | 'healed' | 'skipped';
  attempts: number;
  healed: boolean;
  handledBy: string;
  durationMs: number;
  modelCalls?: number;
  error?: string;
  errorClass?: string;
  thought?: string;
}

interface EngineRun {
  id: string;
  status: string;
  qaTargetUrl: string;
  qaMode: string;
  scenarioName?: string;
  startedAt: string;
  finishedAt?: string;
  errorSummary?: string;
  stepResults?: EngineStep[];
  evidence?: {
    summary?: { total: number; passed: number; failed: number; healed: number; skipped?: number; modelCalls?: number };
    bugReports?: Array<{
      assertion: string;
      severity: string;
      thought?: string;
      rootCauseHypothesis?: string;
      confidence?: 'confirmed' | 'unconfirmed';
      contradictedBy?: string;
    }>;
  };
  reportPaths?: { aggregate?: string; midscene?: string[]; videos?: string[] };
}

const seconds = (ms?: number): string => (ms === undefined ? '—' : `${(ms / 1000).toFixed(1)} с`);
const pad = (value: string | number, width: number): string => String(value).padEnd(width);

async function loadEngineRun(id: string): Promise<EngineRun | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(RUNS_DIR, `${id}.json`), 'utf8')) as EngineRun;
  } catch {
    return null;
  }
}

async function main(): Promise<void> {
  const db = new DatabaseSync(DB_PATH);
  const runId =
    process.argv[2] ??
    (db.prepare("SELECT id FROM registry_runs ORDER BY started_at DESC LIMIT 1").get() as { id?: string })?.id;
  if (!runId) {
    console.error('Прогонів у реєстрі немає.');
    process.exit(1);
  }

  const run = db.prepare('SELECT * FROM registry_runs WHERE id = ?').get(runId) as
    | { id: string; title: string; kind: string; state: string; started_at: string; finished_at?: string; env: string }
    | undefined;
  if (!run) {
    console.error(`Прогін «${runId}» не знайдено.`);
    process.exit(1);
  }

  const items = db
    .prepare(
      `SELECT ri.case_id, ri.status, ri.auto_run_id, ri.duration_ms, ri.comment,
              c.title, s.name AS section
         FROM run_items ri
         JOIN cases c ON c.id = ri.case_id
         JOIN sections s ON s.id = c.section_id
        WHERE ri.run_id = ? ORDER BY ri.position`,
    )
    .all(runId) as Array<{
    case_id: string;
    status: string;
    auto_run_id?: string;
    duration_ms?: number;
    comment?: string;
    title: string;
    section: string;
  }>;

  const env = JSON.parse(run.env || '{}') as { baseUrl?: string; mode?: string };
  console.log(`\n${run.title}`);
  console.log(
    `${run.kind} · ${run.state} · режим ${env.mode ?? '—'} · старт ${new Date(run.started_at).toLocaleString('uk-UA')}`,
  );
  console.log('─'.repeat(100));

  let totalSteps = 0;
  let totalHealed = 0;
  let totalModelCalls = 0;
  let totalDuration = 0;
  const failures: Array<{ caseId: string; kind: string; detail: string; thought?: string }> = [];
  const slowest: Array<{ caseId: string; instruction: string; ms: number }> = [];

  for (const item of items) {
    const engine = item.auto_run_id ? await loadEngineRun(item.auto_run_id) : null;
    const steps = engine?.stepResults ?? [];
    const summary = engine?.evidence?.summary;
    const modelCalls = steps.reduce((sum, step) => sum + (step.modelCalls ?? 0), 0);
    const duration =
      item.duration_ms ??
      (engine?.finishedAt && engine.startedAt
        ? Date.parse(engine.finishedAt) - Date.parse(engine.startedAt)
        : undefined);

    totalSteps += steps.length;
    totalHealed += steps.filter((step) => step.healed).length;
    totalModelCalls += modelCalls;
    totalDuration += duration ?? 0;

    const mark =
      { passed: '✓', healed: '✓', failed: '✕', blocked: '■', skipped: '–', untested: '·' }[item.status] ?? '?';
    console.log(
      `\n${mark} ${pad(item.case_id, 18)} ${pad(item.section, 22)} ${item.status.toUpperCase()}  ${seconds(duration)}`,
    );
    console.log(`  ${item.title.slice(0, 92)}`);
    if (engine) {
      console.log(
        `  ціль: ${engine.qaTargetUrl} · кроків: ${steps.length}` +
          (summary ? ` (пройдено ${summary.passed}, впало ${summary.failed}, полікувано ${summary.healed}` : '') +
          (summary?.skipped !== undefined ? `, пропущено ${summary.skipped}` : '') +
          (summary ? ')' : '') +
          ` · викликів моделі: ${modelCalls || '—'}`,
      );
    }

    for (const step of steps) {
      if (step.durationMs > 0) slowest.push({ caseId: item.case_id, instruction: step.instruction, ms: step.durationMs });
      if (step.status === 'failed') {
        // Провалена перевірка часто не має `error` — причина лежить у `thought`.
        const detail =
          step.error?.split('\n')[0]?.slice(0, 160) ??
          step.thought?.split('\n')[0]?.slice(0, 160) ??
          'без деталей';
        failures.push({
          caseId: item.case_id,
          kind: step.errorClass ?? step.kind,
          detail,
          ...(step.thought ? { thought: step.thought } : {}),
        });
        console.log(`    ✕ ${step.kind === 'assertion' ? 'перевірка' : 'крок'}: ${step.instruction.slice(0, 80)}`);
        console.log(`      ${detail}`);
      } else if (step.healed) {
        console.log(`    ~ самолікування (${step.attempts} спроби): ${step.instruction.slice(0, 70)}`);
      }
    }

    for (const bug of engine?.evidence?.bugReports ?? []) {
      const unconfirmed = bug.confidence === 'unconfirmed';
      console.log(
        `    ${unconfirmed ? '?' : '!'} дефект (${bug.severity}${unconfirmed ? ', непідтверджений' : ''}): ${bug.assertion.slice(0, 80)}`,
      );
      if (bug.thought) console.log(`      модель: ${bug.thought.slice(0, 140)}`);
      if (bug.contradictedBy) console.log(`      суперечить: ${bug.contradictedBy.slice(0, 140)}`);
      if (bug.rootCauseHypothesis) console.log(`      гіпотеза: ${bug.rootCauseHypothesis.slice(0, 140)}`);
    }
    if (engine?.errorSummary) console.log(`    підсумок рушія: ${engine.errorSummary.slice(0, 120)}`);
    if (item.comment) console.log(`    коментар: ${item.comment.slice(0, 120)}`);
  }

  // `healed` — це пройдений кейс, якому знадобилося самолікування; не рахувати
  // його ніде означало показувати 2+3 там, де кейсів шість.
  const passed = items.filter((item) => item.status === 'passed' || item.status === 'healed').length;
  const healedItems = items.filter((item) => item.status === 'healed').length;
  const failed = items.filter((item) => item.status === 'failed').length;
  const blocked = items.filter((item) => item.status === 'blocked').length;

  console.log(`\n${'─'.repeat(100)}`);
  console.log(
    `Разом: ${items.length} кейсів · пройдено ${passed}` +
      (healedItems > 0 ? ` (з них полікованих ${healedItems})` : '') +
      ` · впало ${failed}` +
      (blocked > 0 ? ` · заблоковано ${blocked}` : '') +
      ` · ` +
      `кроків ${totalSteps} · самолікувань ${totalHealed} · викликів моделі ${totalModelCalls} · ` +
      `час ${(totalDuration / 60000).toFixed(1)} хв`,
  );

  slowest.sort((a, b) => b.ms - a.ms);
  if (slowest.length > 0) {
    console.log('\nНайповільніші кроки:');
    for (const step of slowest.slice(0, 5)) {
      console.log(`  ${seconds(step.ms).padStart(8)}  ${step.caseId}  ${step.instruction.slice(0, 70)}`);
    }
  }

  if (failures.length > 0) {
    console.log('\nПадіння за типом:');
    const byKind = new Map<string, number>();
    for (const failure of failures) byKind.set(failure.kind, (byKind.get(failure.kind) ?? 0) + 1);
    for (const [kind, n] of byKind) console.log(`  ${pad(kind, 14)} ${n}`);
  }
}

main().catch((error) => {
  console.error('Аналіз впав:', error instanceof Error ? error.message : error);
  process.exit(1);
});
