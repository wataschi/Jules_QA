/**
 * Дефекти — останній крок циклу, який доти не мав екрана.
 *
 * Дефекти вже створювалися (вручну під час прогону і автоматично з вердиктів
 * рушія), дедуплікувалися і рахувалися на «Огляді», але побачити їх було ніде:
 * лічильник вів на список прогонів, а в елементі прогону стояв лише голий
 * ідентифікатор. Тут вони зібрані в одному місці з розбором: змінити статус і
 * серйозність, перейти в кейс, побачити, скільки разів дефект повторювався.
 */

import { useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Async } from '../components/states';
import { Chip, Pager, PageHead, SelectField } from '../components/ui';
import { useApp, useToast } from '../context/AppContext';
import { messageOf, useResource } from '../hooks/useAsync';
import { useQueryParams } from '../hooks/useQueryParams';
import { S, defectSeverityLabel, defectStatusLabel } from '../strings';
import type { Defect, DefectSeverity, DefectStatus } from '../types';
import { DEFECT_SEVERITIES, DEFECT_STATUSES } from '../types';
import { formatAgo, formatDateTime } from '../utils/format';

const LIMIT = 25;

type Tone = 'neutral' | 'good' | 'warn' | 'bad';

const severityTone: Record<DefectSeverity, Tone> = {
  low: 'neutral',
  medium: 'warn',
  high: 'bad',
  critical: 'bad',
};

const statusTone: Record<DefectStatus, Tone> = {
  open: 'bad',
  triaged: 'warn',
  fixed: 'good',
  wontfix: 'neutral',
  duplicate: 'neutral',
};

export default function DefectsPage() {
  const { projectId } = useApp();
  const params = useQueryParams();
  const toast = useToast();

  const status = params.get('status');
  // Прихід із прогону: «у цього кейса є дефект» → показуємо саме його.
  const caseId = params.get('case');
  const page = params.getNum('page', 1);
  const [busyId, setBusyId] = useState<string | null>(null);

  const listState = useResource(
    (signal) =>
      api.listDefects(
        { projectId, status: status || undefined, caseId: caseId || undefined, page, limit: LIMIT },
        signal,
      ),
    [projectId, status, caseId, page],
    { enabled: Boolean(projectId), pollMs: 30_000 },
  );

  async function patch(defect: Defect, change: Partial<Defect>): Promise<void> {
    setBusyId(defect.id);
    try {
      await api.patchDefect(defect.id, change);
      toast({ text: S.defects.savedToast, tone: 'good' });
      listState.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusyId(null);
    }
  }

  return (
    <>
      <PageHead title={S.defects.title} sub={S.defects.sub} />

      <section className="card">
        <div className="filters">
          <SelectField
            label={S.defects.filterStatus}
            value={status}
            onChange={(next) => params.set({ status: next || null, page: null })}
            options={DEFECT_STATUSES.map((value) => ({ value, label: defectStatusLabel[value] }))}
            allLabel={S.common.all}
          />
          {caseId && (
            <button
              type="button"
              className="btn btn-sm btn-ghost"
              onClick={() => params.set({ case: null, page: null })}
            >
              {S.defects.caseFilter(caseId)} ✕
            </button>
          )}
        </div>

        <Async
          state={listState}
          skeletonRows={6}
          empty={{
            title: S.empty.defects,
            hint: S.empty.defectsHint,
            action: (
              <Link className="btn btn-sm" to="/runs">
                {S.nav.runs} →
              </Link>
            ),
          }}
        >
          {(data) => (
            <>
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col">{S.defects.colTitle}</th>
                      <th scope="col">{S.defects.colSeverity}</th>
                      <th scope="col">{S.defects.colStatus}</th>
                      <th scope="col">{S.defects.colCase}</th>
                      <th scope="col">{S.defects.colSeen}</th>
                      <th scope="col">{S.defects.colLastSeen}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.items.map((defect) => (
                      <DefectRow
                        key={defect.id}
                        defect={defect}
                        busy={busyId === defect.id}
                        onPatch={(change) => void patch(defect, change)}
                      />
                    ))}
                  </tbody>
                </table>
              </div>
              <Pager
                page={data.page || page}
                limit={data.limit || LIMIT}
                total={data.total}
                onPage={(next) => params.set({ page: next === 1 ? null : next })}
              />
            </>
          )}
        </Async>
      </section>
    </>
  );
}

function DefectRow({
  defect,
  busy,
  onPatch,
}: {
  defect: Defect;
  busy: boolean;
  onPatch: (change: Partial<Defect>) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <tr className={open ? 'row-open' : undefined}>
        <td>
          <button
            type="button"
            className="link-btn"
            aria-expanded={open}
            onClick={() => setOpen((value) => !value)}
          >
            {defect.title}
          </button>
        </td>
        <td>
          <Chip tone={severityTone[defect.severity]}>{defectSeverityLabel[defect.severity]}</Chip>
        </td>
        <td>
          <Chip tone={statusTone[defect.status]}>{defectStatusLabel[defect.status]}</Chip>
        </td>
        <td className="cell-id">
          {defect.caseId ? (
            <Link to={`/cases?case=${encodeURIComponent(defect.caseId)}`}>{defect.caseId}</Link>
          ) : (
            S.common.none
          )}
        </td>
        <td className="cell-num">
          {/* Скільки прогонів поспіль бачили те саме: одиниця — ще не система. */}
          <span title={S.defects.seenHint}>{defect.seenCount}</span>
        </td>
        <td className="nowrap text-xs muted" title={formatDateTime(defect.lastSeenAt)}>
          {formatAgo(defect.lastSeenAt)}
        </td>
      </tr>
      {open && (
        <tr className="row-detail">
          <td colSpan={6}>
            <div className="defect-detail">
              <div className="defect-body">
                <h3 className="muted text-xs">{S.defects.details}</h3>
                <p className="pre-wrap text-sm">{defect.details || S.defects.noDetails}</p>
                <p className="muted text-xs">
                  {S.defects.firstSeen}: {formatDateTime(defect.firstSeenAt)}
                  {defect.externalKey ? ` · ${S.defects.external}: ${defect.externalKey}` : ''}
                </p>
              </div>
              <div className="defect-actions">
                <SelectField
                  label={S.defects.colStatus}
                  value={defect.status}
                  disabled={busy}
                  onChange={(next) => onPatch({ status: next as DefectStatus })}
                  options={DEFECT_STATUSES.map((value) => ({ value, label: defectStatusLabel[value] }))}
                />
                <SelectField
                  label={S.defects.colSeverity}
                  value={defect.severity}
                  disabled={busy}
                  onChange={(next) => onPatch({ severity: next as DefectSeverity })}
                  options={DEFECT_SEVERITIES.map((value) => ({ value, label: defectSeverityLabel[value] }))}
                />
              </div>
            </div>
          </td>
        </tr>
      )}
    </>
  );
}
