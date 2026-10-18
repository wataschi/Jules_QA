/** Дрібниці екранів «Задачі»: чип стану, вік задачі, набори станів. */
import { Chip } from '../../components/ui';
import { S2, TASK_STATE_TONE } from '../../strings-v2';
import type { TaskKind, TaskState } from '../../types';

export const ACTIVE_STATES: TaskState[] = ['queued', 'claimed', 'needs_info', 'review', 'failed'];
export const ALL_STATES: TaskState[] = ['new', 'queued', 'claimed', 'needs_info', 'review', 'failed', 'done', 'rejected'];
export const ALL_KINDS = Object.keys(S2.taskKind) as TaskKind[];

/** Задачі, що віддають результат через PR (решта закривається погодженням QA). */
export const PR_KINDS: ReadonlySet<TaskKind> = new Set(['add_test', 'change_test', 'remove_test', 'stabilize']);

export const DEFAULT_STALE_HOURS = 24;

export function isOpenState(state: TaskState): boolean {
  return state !== 'done' && state !== 'rejected';
}

export function TaskStateChip({ state }: { state: TaskState }) {
  const tone = TASK_STATE_TONE[state];
  return <Chip tone={tone === 'info' ? 'accent' : (tone ?? 'neutral')}>{S2.taskState[state]}</Chip>;
}

/** «щойно», «40 хв», «3 год», «2 дн». */
export function formatWait(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return '—';
  const minutes = Math.round(hours * 60);
  if (minutes < 1) return 'щойно';
  if (minutes < 60) return `${minutes} хв`;
  if (hours < 24) return `${Math.round(hours)} год`;
  return `${Math.floor(hours / 24)} дн`;
}

export function parseStates(raw: string): TaskState[] | 'all' {
  if (raw === 'all') return 'all';
  const list = raw
    .split(',')
    .map((item) => item.trim())
    .filter((item): item is TaskState => (ALL_STATES as string[]).includes(item));
  return list.length ? list : ACTIVE_STATES;
}
