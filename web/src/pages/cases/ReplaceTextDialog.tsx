/**
 * Масова заміна тексту.
 *
 * Порядок роботи жорсткий: «Порахувати» (dryRun) → таблиця diff «було → стало»
 * з кількістю входжень → «Застосувати» → тост із кнопкою «Відкотити»
 * (`POST /cases/bulk/undo` з `batchId`).
 */

import { useState } from 'react';
import { api } from '../../api';
import { Dialog } from '../../components/Dialog';
import { CheckField, TextField } from '../../components/ui';
import { useToast } from '../../context/AppContext';
import { messageOf } from '../../hooks/useAsync';
import { S, bulkFieldLabel } from '../../strings';
import type { BulkResult, BulkTextField, CaseFilter } from '../../types';
import { BULK_TEXT_FIELDS } from '../../types';

export default function ReplaceTextDialog({
  projectId,
  caseIds,
  filter,
  onClose,
  onApplied,
}: {
  projectId: string;
  /** Якщо порожньо — діємо за фільтром. */
  caseIds: string[];
  filter?: CaseFilter;
  onClose: () => void;
  onApplied: () => void;
}) {
  const toast = useToast();
  const [find, setFind] = useState('');
  const [replace, setReplace] = useState('');
  const [fields, setFields] = useState<BulkTextField[]>(['title', 'checks']);
  const [regex, setRegex] = useState(false);
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [reason, setReason] = useState('');
  const [preview, setPreview] = useState<BulkResult | null>(null);
  const [busy, setBusy] = useState<'count' | 'apply' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const scoped = caseIds.length > 0;

  const buildRequest = (dryRun: boolean) => ({
    projectId,
    caseIds: scoped ? caseIds : undefined,
    filter: scoped ? undefined : filter,
    operation: {
      op: 'replace-text' as const,
      find,
      replace,
      fields,
      regex,
      caseSensitive,
    },
    dryRun,
    reason: reason || `масова заміна «${find}» → «${replace}»`,
  });

  async function count() {
    setBusy('count');
    setError(null);
    try {
      const result = await api.bulk(buildRequest(true));
      setPreview(result);
    } catch (cause) {
      setError(messageOf(cause));
      setPreview(null);
    } finally {
      setBusy(null);
    }
  }

  async function apply() {
    setBusy('apply');
    setError(null);
    try {
      const result = await api.bulk(buildRequest(false));
      const batchId = result.batchId;
      toast({
        text: S.replace.appliedToast(result.affected),
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
                  .catch((cause) => toast({ text: `${S.replace.undoFailed}: ${messageOf(cause)}`, tone: 'bad' }));
              },
            }
          : undefined,
      });
      onApplied();
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(null);
    }
  }

  const toggleField = (field: BulkTextField, on: boolean) =>
    setFields((current) => {
      const next = on ? [...current, field] : current.filter((item) => item !== field);
      setPreview(null);
      return next;
    });

  const canCount = find.trim().length > 0 && fields.length > 0 && busy === null;
  const canApply = Boolean(preview && preview.occurrences > 0) && busy === null;

  return (
    <Dialog
      title={S.replace.title}
      onClose={onClose}
      size="lg"
      footer={
        <>
          <span className="muted text-xs" style={{ marginRight: 'auto' }}>
            {scoped ? S.replace.scopeSelected(caseIds.length) : S.replace.scopeFilter}
          </span>
          <button type="button" className="btn" onClick={onClose}>
            {S.common.cancel}
          </button>
          <button type="button" className="btn" onClick={count} disabled={!canCount}>
            {busy === 'count' ? S.replace.counting : S.replace.count}
          </button>
          <button type="button" className="btn btn-primary" onClick={apply} disabled={!canApply}>
            {busy === 'apply' ? S.replace.applying : S.replace.applyBtn}
          </button>
        </>
      }
    >
      <div className="grid grid-2">
        <TextField
          label={S.replace.find}
          value={find}
          onChange={(next) => {
            setFind(next);
            setPreview(null);
          }}
          mono
        />
        <TextField
          label={S.replace.replace}
          value={replace}
          onChange={(next) => {
            setReplace(next);
            setPreview(null);
          }}
          mono
        />
      </div>

      <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
        <legend className="field-hint">{S.replace.fields}</legend>
        <div className="row-wrap">
          {BULK_TEXT_FIELDS.map((field) => (
            <CheckField
              key={field}
              label={bulkFieldLabel[field]}
              checked={fields.includes(field)}
              onChange={(on) => toggleField(field, on)}
            />
          ))}
        </div>
      </fieldset>

      <div className="row-wrap">
        <CheckField
          label={S.replace.regex}
          checked={regex}
          onChange={(on) => {
            setRegex(on);
            setPreview(null);
          }}
        />
        <CheckField
          label={S.replace.caseSensitive}
          checked={caseSensitive}
          onChange={(on) => {
            setCaseSensitive(on);
            setPreview(null);
          }}
        />
      </div>

      <TextField
        label={S.replace.reasonLabel}
        value={reason}
        onChange={setReason}
        placeholder={S.replace.reasonPlaceholder}
      />

      {error && <div className="alert bad">{error}</div>}

      {preview === null ? (
        <p className="muted text-sm">{S.replace.needCount}</p>
      ) : preview.occurrences === 0 ? (
        <div className="alert warn">{S.replace.noMatches}</div>
      ) : (
        <>
          <div className="row">
            <h3>{S.replace.previewTitle}</h3>
            <span className="spacer" />
            <span className="chip accent mono">{S.replace.summary(preview.affected, preview.occurrences)}</span>
          </div>
          <div className="table-wrap" style={{ maxHeight: 320, overflowY: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{S.replace.colCase}</th>
                  <th scope="col">{S.replace.colField}</th>
                  <th scope="col">{S.replace.colBefore}</th>
                  <th scope="col">{S.replace.colAfter}</th>
                  <th scope="col">{S.replace.colCount}</th>
                </tr>
              </thead>
              <tbody>
                {preview.preview.map((row, index) => (
                  <tr key={`${row.caseId}-${row.field}-${index}`}>
                    <td className="cell-id">{row.caseId}</td>
                    <td className="text-xs">{bulkFieldLabel[row.field as BulkTextField] ?? row.field}</td>
                    <td className="text-xs" style={{ whiteSpace: 'normal' }}>
                      <span className="diff-cell diff-before" style={{ display: 'block' }}>
                        {row.before}
                      </span>
                    </td>
                    <td className="text-xs" style={{ whiteSpace: 'normal' }}>
                      <span className="diff-cell diff-after" style={{ display: 'block' }}>
                        {row.after}
                      </span>
                    </td>
                    <td className="cell-num mono">{row.occurrences}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </Dialog>
  );
}
