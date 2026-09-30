/**
 * Панель масових дій над вибраними кейсами та діалоги під кожну з них.
 * Усе, що змінює дані, спирається на `POST /cases/bulk` з `dryRun=false`
 * і показує тост із «Відкотити», якщо сервер повернув `batchId`.
 */

import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { Dialog } from '../../components/Dialog';
import { SelectField, TextField } from '../../components/ui';
import { useToast } from '../../context/AppContext';
import { messageOf, useAsync } from '../../hooks/useAsync';
import {
  S,
  automationStatusLabel,
  caseKindLabel,
  casePriorityLabel,
  caseStatusLabel,
} from '../../strings';
import type { AutomationStatus, BulkOp, CaseKind, CasePriority, CaseStatus, SectionNode } from '../../types';
import { AUTOMATION_STATUSES, CASE_KINDS, CASE_PRIORITIES, CASE_STATUSES } from '../../types';
import { parseTags } from '../../utils/format';

export type BulkDialogKind =
  | null
  | 'replace'
  | 'priority'
  | 'kind'
  | 'status'
  | 'tag'
  | 'move'
  | 'automation'
  | 'run'
  | 'export';

export function flattenSections(tree: SectionNode[], depth = 0): Array<{ value: string; label: string }> {
  return tree.flatMap((node) => [
    { value: node.id, label: `${'— '.repeat(depth)}${node.name}` },
    ...flattenSections(node.children, depth + 1),
  ]);
}

export function BulkBar({
  count,
  offPageCount = 0,
  onOpen,
  onClear,
}: {
  count: number;
  /** Скільки з вибраного не видно на поточній сторінці. */
  offPageCount?: number;
  onOpen: (kind: BulkDialogKind) => void;
  onClear: () => void;
}) {
  return (
    <div className="bulkbar" role="region" aria-label={S.cases.bulkTitle}>
      <strong>
        {S.common.selected}: {count}
      </strong>
      {offPageCount > 0 && <span className="muted text-xs">{S.cases.bulkOffPage(offPageCount)}</span>}
      {/* Наступний крок циклу — головна дія, тож вона перша й виділена. */}
      <button type="button" className="btn btn-sm btn-primary" onClick={() => onOpen('run')}>
        {S.cases.bulkCreateRun}
      </button>
      <span className="bulkbar-sep" aria-hidden="true" />
      <button type="button" className="btn btn-sm" onClick={() => onOpen('replace')}>
        {S.cases.bulkReplace}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => onOpen('priority')}>
        {S.cases.bulkPriority}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => onOpen('kind')}>
        {S.cases.bulkKind}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => onOpen('status')}>
        {S.cases.bulkStatus}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => onOpen('tag')}>
        {S.cases.bulkAddTag}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => onOpen('move')}>
        {S.cases.bulkMove}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => onOpen('automation')}>
        {S.cases.bulkAutomation}
      </button>
      <button type="button" className="btn btn-sm" onClick={() => onOpen('export')}>
        {S.cases.bulkExport}
      </button>
      <span className="spacer" />
      <button type="button" className="btn btn-sm btn-ghost" onClick={onClear}>
        {S.cases.bulkClear}
      </button>
    </div>
  );
}

/* ─────────────────── прості операції через /cases/bulk ───────────────── */

export function SimpleBulkDialog({
  kind,
  projectId,
  caseIds,
  sections,
  onClose,
  onApplied,
}: {
  kind: Exclude<BulkDialogKind, null | 'replace' | 'run' | 'export'>;
  projectId: string;
  caseIds: string[];
  sections: SectionNode[];
  onClose: () => void;
  onApplied: () => void;
}) {
  const toast = useToast();
  const flat = flattenSections(sections);
  const [value, setValue] = useState(() => {
    if (kind === 'priority') return 'P2';
    if (kind === 'kind') return 'positive';
    if (kind === 'status') return 'approved';
    if (kind === 'automation') return 'candidate';
    if (kind === 'move') return flat[0]?.value ?? '';
    return '';
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const titles: Record<typeof kind, string> = {
    priority: S.cases.bulkPriority,
    kind: S.cases.bulkKind,
    status: S.cases.bulkStatus,
    tag: S.cases.bulkAddTag,
    move: S.cases.bulkMove,
    automation: S.cases.bulkAutomation,
  };

  function operation(): BulkOp | null {
    if (kind === 'priority') return { op: 'set-field', field: 'priority', value };
    if (kind === 'kind') return { op: 'set-field', field: 'kind', value };
    if (kind === 'status') return { op: 'set-field', field: 'status', value };
    if (kind === 'automation') return { op: 'set-automation', status: value as AutomationStatus };
    if (kind === 'move') return value ? { op: 'move', sectionId: value } : null;
    if (kind === 'tag') {
      const tags = parseTags(value);
      return tags.length ? { op: 'add-tag', tags } : null;
    }
    return null;
  }

  async function apply() {
    const op = operation();
    if (!op) return;
    setBusy(true);
    setError(null);
    try {
      const result = await api.bulk({
        projectId,
        caseIds,
        operation: op,
        dryRun: false,
        reason: `масова дія: ${titles[kind]}`,
      });
      const batchId = result.batchId;
      toast({
        text: `${titles[kind]}: ${result.affected}`,
        tone: 'good',
        action: batchId
          ? {
              label: S.common.undo,
              run: () => {
                api
                  .bulkUndo(batchId)
                  .then(() => {
                    toast({ text: S.replace.undoneToast, tone: 'good' });
                    onApplied();
                  })
                  .catch((cause) => toast({ text: messageOf(cause), tone: 'bad' }));
              },
            }
          : undefined,
      });
      onApplied();
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={titles[kind]}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {S.common.cancel}
          </button>
          <button type="button" className="btn btn-primary" onClick={apply} disabled={busy || !value.trim()}>
            {S.common.apply}
          </button>
        </>
      }
    >
      <p className="muted text-sm">{S.replace.scopeSelected(caseIds.length)}</p>

      {kind === 'priority' && (
        <SelectField
          label={S.cases.colPriority}
          value={value}
          onChange={setValue}
          options={CASE_PRIORITIES.map((p: CasePriority) => ({ value: p, label: casePriorityLabel[p] }))}
        />
      )}
      {kind === 'kind' && (
        <SelectField
          label={S.cases.colKind}
          value={value}
          onChange={setValue}
          options={CASE_KINDS.map((k: CaseKind) => ({ value: k, label: caseKindLabel[k] }))}
        />
      )}
      {kind === 'status' && (
        <SelectField
          label={S.cases.colStatus}
          value={value}
          onChange={setValue}
          options={CASE_STATUSES.map((s: CaseStatus) => ({ value: s, label: caseStatusLabel[s] }))}
        />
      )}
      {kind === 'automation' && (
        <SelectField
          label={S.cases.colAutomation}
          value={value}
          onChange={setValue}
          options={AUTOMATION_STATUSES.map((a: AutomationStatus) => ({
            value: a,
            label: automationStatusLabel[a],
          }))}
        />
      )}
      {kind === 'move' && (
        <SelectField label={S.cases.colSection} value={value} onChange={setValue} options={flat} />
      )}
      {kind === 'tag' && (
        <TextField label={S.cases.filterTags} value={value} onChange={setValue} placeholder="smoke, regression" mono />
      )}

      {error && <div className="alert bad">{error}</div>}
    </Dialog>
  );
}

/* ───────────────────────── створення прогону ─────────────────────────── */

export function CreateRunDialog({
  projectId,
  caseIds,
  onClose,
}: {
  projectId: string;
  caseIds: string[];
  onClose: () => void;
}) {
  const toast = useToast();
  const navigate = useNavigate();
  const [title, setTitle] = useState('');
  const [kind, setKind] = useState('mixed');
  // Порожнє поле = кожен кейс іде на власну ціль. Заповнене закріплює
  // середовище для всього прогону, тож підставляти сюди щось «за
  // замовчуванням» не можна: це тихо перенаправило б увесь прогін.
  const [baseUrl, setBaseUrl] = useState('');
  const [label, setLabel] = useState('');
  const [mode, setMode] = useState('regression');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const run = await api.createRun({
        projectId,
        kind: kind as 'manual' | 'auto' | 'mixed',
        title: title || undefined,
        caseIds,
        env: {
          baseUrl: baseUrl || undefined,
          mode: mode === '' ? undefined : (mode as 'warm-up' | 'regression'),
          label: label || undefined,
        },
      });
      toast({ text: S.runs.createdToast, tone: 'good' });
      navigate(`/runs/${encodeURIComponent(run.id)}`);
    } catch (cause) {
      setError(messageOf(cause));
      setBusy(false);
    }
  }

  return (
    <Dialog
      title={S.runs.createTitle}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {S.common.cancel}
          </button>
          <button type="button" className="btn btn-primary" onClick={create} disabled={busy || caseIds.length === 0}>
            {S.runs.create}
          </button>
        </>
      }
    >
      <p className="muted text-sm">{S.replace.scopeSelected(caseIds.length)}</p>
      <TextField
        label={S.runs.runTitle}
        value={title}
        onChange={setTitle}
        placeholder={S.runs.runTitlePlaceholder}
      />
      <SelectField
        label={S.runs.runKind}
        value={kind}
        onChange={setKind}
        options={[
          { value: 'manual', label: 'ручний' },
          { value: 'auto', label: 'автоматичний' },
          { value: 'mixed', label: 'змішаний' },
        ]}
      />
      <TextField
        label={S.runs.baseUrl}
        hint={S.runs.baseUrlHint}
        value={baseUrl}
        onChange={setBaseUrl}
        type="url"
        mono
      />
      <SelectField
        label={S.runs.engineMode}
        value={mode}
        onChange={setMode}
        allLabel={S.common.none}
        options={[
          { value: 'warm-up', label: S.settings.modeWarmUp },
          { value: 'regression', label: S.settings.modeRegression },
        ]}
      />
      <TextField label={S.runs.envLabel} value={label} onChange={setLabel} />
      {error && <div className="alert bad">{error}</div>}
    </Dialog>
  );
}

/* ─────────────────────────────── експорт ─────────────────────────────── */

export function ExportDialog({
  projectId,
  caseIds,
  onClose,
}: {
  projectId: string;
  caseIds: string[];
  onClose: () => void;
}) {
  const mappings = useAsync((signal) => api.listMappings(projectId, signal), [projectId], Boolean(projectId));
  const [mappingId, setMappingId] = useState('');
  const [target, setTarget] = useState<'csv' | 'xml'>('csv');
  const options = (mappings.data ?? []).map((item) => ({ value: item.id, label: item.name }));
  const effectiveMapping = mappingId || options[0]?.value || '';

  const url = api.exportUrl(target, { projectId, mappingId: effectiveMapping, caseId: caseIds });

  return (
    <Dialog
      title={S.cases.bulkExport}
      onClose={onClose}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {S.common.cancel}
          </button>
          <a
            className={`btn btn-primary${effectiveMapping ? '' : ' disabled'}`}
            href={url}
            aria-disabled={effectiveMapping ? undefined : 'true'}
            onClick={(event) => {
              if (!effectiveMapping) event.preventDefault();
            }}
          >
            {S.common.export}
          </a>
        </>
      }
    >
      <p className="muted text-sm">{S.replace.scopeSelected(caseIds.length)}</p>
      {mappings.error ? (
        <div className="alert warn">
          {mappings.error} — {S.empty.mappingsHint}
        </div>
      ) : (
        <SelectField
          label={S.settings.mappings}
          value={effectiveMapping}
          onChange={setMappingId}
          options={options}
          hint={options.length === 0 ? S.empty.mappings : undefined}
        />
      )}
      <SelectField
        label={S.common.export}
        value={target}
        onChange={(next) => setTarget(next as 'csv' | 'xml')}
        options={[
          { value: 'csv', label: 'CSV' },
          { value: 'xml', label: 'XML' },
        ]}
      />
      <p className="muted text-xs mono" style={{ overflowWrap: 'anywhere' }}>
        {url}
      </p>
    </Dialog>
  );
}
