/**
 * Дрібні будівельні блоки інтерфейсу: чипи статусів (колір + іконка-точка,
 * не лише колір), поля з обов'язковим `<label htmlFor>`, пагінація, прогрес.
 */

import { useId, type ChangeEvent, type ReactNode } from 'react';
import {
  S,
  automationStatusLabel,
  automationStatusShort,
  caseKindLabel,
  caseKindShort,
  casePriorityLabel,
  caseStatusLabel,
  coverageKindLabel,
  itemStatusLabel,
  proposalStateLabel,
  runStateLabel,
} from '../strings';
import type {
  AutomationStatus,
  CaseKind,
  CasePriority,
  CaseStatus,
  CoverageKind,
  ItemStatus,
  ProposalState,
  RunState,
} from '../types';

type Tone = 'neutral' | 'good' | 'warn' | 'bad' | 'accent';

export function Chip({
  tone = 'neutral',
  children,
  mono = false,
  title,
}: {
  tone?: Tone;
  children: ReactNode;
  mono?: boolean;
  title?: string;
}) {
  return (
    <span className={`chip ${tone === 'neutral' ? '' : tone}${mono ? ' mono' : ''}`} title={title}>
      <span className="chip-dot" aria-hidden="true" />
      {children}
    </span>
  );
}

const caseStatusTone: Record<CaseStatus, Tone> = {
  draft: 'neutral',
  in_review: 'warn',
  approved: 'good',
  deprecated: 'bad',
};
export const CaseStatusChip = ({ status }: { status: CaseStatus }) => (
  <Chip tone={caseStatusTone[status]}>{caseStatusLabel[status]}</Chip>
);

const automationTone: Record<AutomationStatus, Tone> = {
  manual: 'neutral',
  candidate: 'accent',
  automated: 'good',
  quarantined: 'warn',
};
export const AutomationChip = ({
  status,
  reason,
  short,
}: {
  status: AutomationStatus;
  reason?: string;
  /** Коротка форма для таблиць; повний підпис лишається у title. */
  short?: boolean;
}) => (
  <Chip tone={automationTone[status]} title={reason ?? (short ? automationStatusLabel[status] : undefined)}>
    {short ? automationStatusShort[status] : automationStatusLabel[status]}
  </Chip>
);

const itemStatusTone: Record<ItemStatus, Tone> = {
  untested: 'neutral',
  passed: 'good',
  failed: 'bad',
  blocked: 'warn',
  skipped: 'neutral',
};
export const ItemStatusChip = ({ status }: { status: ItemStatus }) => (
  <Chip tone={itemStatusTone[status]}>{itemStatusLabel[status]}</Chip>
);

const runStateTone: Record<RunState, Tone> = {
  open: 'accent',
  completed: 'good',
  cancelled: 'neutral',
};
export const RunStateChip = ({ state }: { state: RunState }) => (
  <Chip tone={runStateTone[state]}>{runStateLabel[state]}</Chip>
);

const priorityTone: Record<CasePriority, Tone> = {
  P1: 'bad',
  P2: 'warn',
  P3: 'neutral',
  P4: 'neutral',
};
export const PriorityChip = ({ priority }: { priority: CasePriority }) => (
  <Chip tone={priorityTone[priority]} mono title={casePriorityLabel[priority]}>
    {priority}
  </Chip>
);

export const KindChip = ({ kind, short }: { kind: CaseKind; short?: boolean }) => (
  <Chip
    tone={kind === 'negative' || kind === 'security' ? 'warn' : 'neutral'}
    title={short ? caseKindLabel[kind] : undefined}
  >
    {short ? caseKindShort[kind] : caseKindLabel[kind]}
  </Chip>
);

export const CoverageKindChip = ({ kind }: { kind: CoverageKind }) => (
  <Chip tone={kind === 'quote' ? 'accent' : 'warn'}>{coverageKindLabel[kind]}</Chip>
);

const proposalStateTone: Record<ProposalState, Tone> = {
  pending: 'accent',
  approved: 'good',
  rejected: 'neutral',
};
export const ProposalStateChip = ({ state }: { state: ProposalState }) => (
  <Chip tone={proposalStateTone[state]}>{proposalStateLabel[state]}</Chip>
);

/* ───────────────────────────────── поля ──────────────────────────────── */

export function Field({
  label,
  hint,
  className = '',
  children,
}: {
  label: string;
  hint?: string;
  className?: string;
  children: (id: string) => ReactNode;
}) {
  const id = useId();
  return (
    <div className={`field ${className}`}>
      <label htmlFor={id}>{label}</label>
      {children(id)}
      {hint && <span className="field-hint">{hint}</span>}
    </div>
  );
}

export function TextField({
  label,
  value,
  onChange,
  placeholder,
  hint,
  type = 'text',
  mono = false,
  className = '',
  disabled = false,
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hint?: string;
  type?: 'text' | 'search' | 'url' | 'password' | 'number';
  mono?: boolean;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint} className={className}>
      {(id) => (
        <input
          id={id}
          type={type}
          className={mono ? 'input-mono' : undefined}
          value={value}
          placeholder={placeholder}
          disabled={disabled}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

export function TextArea({
  label,
  value,
  onChange,
  placeholder,
  hint,
  rows = 4,
  className = '',
}: {
  label: string;
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  hint?: string;
  rows?: number;
  className?: string;
}) {
  return (
    <Field label={label} hint={hint} className={className}>
      {(id) => (
        <textarea
          id={id}
          rows={rows}
          value={value}
          placeholder={placeholder}
          onChange={(e) => onChange(e.target.value)}
        />
      )}
    </Field>
  );
}

export interface Option {
  value: string;
  label: string;
}

export function SelectField({
  label,
  value,
  options,
  onChange,
  allLabel,
  hint,
  className = '',
  disabled = false,
}: {
  label: string;
  value: string;
  options: Option[];
  onChange: (next: string) => void;
  /** Якщо задано — з'являється порожній варіант «усі». */
  allLabel?: string;
  hint?: string;
  className?: string;
  disabled?: boolean;
}) {
  return (
    <Field label={label} hint={hint} className={className}>
      {(id) => (
        <select id={id} value={value} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
          {allLabel !== undefined && <option value="">{allLabel}</option>}
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}

export function CheckField({
  label,
  checked,
  onChange,
  disabled = false,
}: {
  label: string;
  checked: boolean;
  onChange: (next: boolean) => void;
  disabled?: boolean;
}) {
  const id = useId();
  return (
    <div className="check-row">
      <input
        id={id}
        type="checkbox"
        checked={checked}
        disabled={disabled}
        onChange={(e) => onChange(e.target.checked)}
      />
      <label htmlFor={id}>{label}</label>
    </div>
  );
}

/* ───────────────────────────── інші дрібниці ─────────────────────────── */

export function Kpi({
  label,
  value,
  note,
}: {
  label: string;
  value: ReactNode;
  note?: ReactNode;
}) {
  return (
    <div className="kpi">
      <span className="kpi-label">{label}</span>
      <span className="kpi-value">{value}</span>
      {note && <span className="kpi-note">{note}</span>}
    </div>
  );
}

export function BarRow({
  label,
  value,
  max,
  tone,
}: {
  label: string;
  value: number;
  max: number;
  tone?: 'good' | 'warn' | 'bad';
}) {
  const pct = max > 0 ? Math.round((value / max) * 100) : 0;
  return (
    <div className="bar-row">
      <span className="truncate">{label}</span>
      <span className="bar-track">
        <span className={`bar-fill${tone ? ` ${tone}` : ''}`} style={{ width: `${pct}%` }} />
      </span>
      <span className="bar-num">{value}</span>
    </div>
  );
}

export function SummaryBar({
  summary,
}: {
  summary: { total: number; passed: number; failed: number; blocked: number; skipped: number };
}) {
  const total = Math.max(summary.total, 1);
  const w = (n: number) => `${(n / total) * 100}%`;
  return (
    <div
      className="progress"
      role="img"
      aria-label={`${itemStatusLabel.passed}: ${summary.passed}, ${itemStatusLabel.failed}: ${summary.failed}, ${itemStatusLabel.blocked}: ${summary.blocked}, ${itemStatusLabel.skipped}: ${summary.skipped}`}
    >
      <span className="p-passed" style={{ width: w(summary.passed) }} />
      <span className="p-failed" style={{ width: w(summary.failed) }} />
      <span className="p-blocked" style={{ width: w(summary.blocked) }} />
      <span className="p-skipped" style={{ width: w(summary.skipped) }} />
    </div>
  );
}

export function Pager({
  page,
  limit,
  total,
  onPage,
}: {
  page: number;
  limit: number;
  total: number;
  onPage: (next: number) => void;
}) {
  const pages = Math.max(1, Math.ceil(total / Math.max(limit, 1)));
  const from = total === 0 ? 0 : (page - 1) * limit + 1;
  const to = Math.min(page * limit, total);
  return (
    <div className="pager">
      <span>
        {from}–{to} {S.common.of} {total}
      </span>
      <span className="spacer" />
      <button type="button" className="btn btn-sm" disabled={page <= 1} onClick={() => onPage(page - 1)}>
        ← {S.common.prev}
      </button>
      <span className="mono text-xs">
        {S.common.page} {page} / {pages}
      </span>
      <button type="button" className="btn btn-sm" disabled={page >= pages} onClick={() => onPage(page + 1)}>
        {S.common.next} →
      </button>
    </div>
  );
}

export function PageHead({
  title,
  sub,
  actions,
}: {
  title: string;
  sub?: string;
  actions?: ReactNode;
}) {
  return (
    <div className="page-head">
      <div>
        <h1>{title}</h1>
        {sub && <p className="page-head-sub">{sub}</p>}
      </div>
      {actions && <div className="page-head-actions">{actions}</div>}
    </div>
  );
}

export function Mono({ children }: { children: ReactNode }) {
  return <span className="mono">{children}</span>;
}

/**
 * Вкладки одного екрана. Активна вкладка живе в адресі, тож на потрібний
 * розділ можна дати посилання, а «назад» у браузері повертає туди ж.
 */
export function Tabs({
  tabs,
  active,
  onPick,
  label,
}: {
  tabs: Array<{ value: string; label: string }>;
  active: string;
  onPick: (value: string) => void;
  label: string;
}) {
  return (
    <div className="tabs" role="tablist" aria-label={label}>
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={tab.value === active}
          className={`tab${tab.value === active ? ' active' : ''}`}
          onClick={() => onPick(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}
