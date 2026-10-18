/**
 * `jules-qa case reserve --section <code> --title "…" [--kind] [--priority] [--check …] [--preconditions]`
 * — ID для нового кейса, коли агент додає тест без задачі. Jules створює чернетку кейса
 * через чергу погоджень; у stdout — лише ID, щоб його можна було підставити в назву тесту.
 */
import { loadConfig, requireProject } from '../config.js';
import { eprintln, println, type CliContext } from '../context.js';
import { flagList, flagString, hubFor, UsageError, type CommandHandler } from './common.js';

const KINDS = ['positive', 'negative', 'neutral', 'security', 'a11y', 'performance'];
const PRIORITIES = ['P1', 'P2', 'P3', 'P4'];

export interface ReserveResponse {
  caseId: string;
  proposalId?: string | number;
}

export const caseCommand: CommandHandler = async (ctx: CliContext, args) => {
  const sub = args.positionals[0];
  if (sub !== 'reserve') throw new UsageError('Підкоманда: jules-qa case reserve --section <code> --title "…"');
  const section = flagString(args, 'section')?.trim();
  const title = flagString(args, 'title')?.trim();
  if (!section) throw new UsageError('Вкажіть секцію: --section <код або id>, наприклад --section ACT');
  if (!title) throw new UsageError('Вкажіть заголовок кейса: --title "Акт без суми не зберігається"');
  const kind = flagString(args, 'kind');
  if (kind && !KINDS.includes(kind)) throw new UsageError(`--kind має бути одним із: ${KINDS.join(', ')}`);
  const priority = flagString(args, 'priority')?.toUpperCase();
  if (priority && !PRIORITIES.includes(priority)) throw new UsageError(`--priority має бути одним із: ${PRIORITIES.join(', ')}`);

  const config = loadConfig({ cwd: ctx.cwd, env: ctx.env });
  const checks = flagList(args, 'check');
  const body = {
    projectId: requireProject(config),
    section,
    title,
    ...(kind ? { kind } : {}),
    ...(priority ? { priority } : {}),
    ...(checks.length ? { checks } : {}),
    ...(flagString(args, 'preconditions') ? { preconditions: flagString(args, 'preconditions') } : {}),
  };
  const response = await hubFor(ctx, config).postJson<ReserveResponse>('/cases/reserve', body);
  println(ctx, response.caseId);
  eprintln(ctx, `Чернетка кейса ${response.caseId} чекає погодження QA. Додайте ID на початок назви тесту.`);
  return 0;
};
