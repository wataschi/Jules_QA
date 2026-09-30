/**
 * Покриття вимог: джерела (імпорт Confluence за URL або вставлений текст),
 * матриця «блок вимоги → кейси» з підсвіткою прогалин, запуск скілів
 * «Згенерувати кейси» і «Перевірити покриття», індикатор «змінилось у джерелі».
 */

import { useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { api } from '../api';
import { Dialog } from '../components/Dialog';
import { Async, Empty, ErrorState, Loading } from '../components/states';
import {
  CheckField,
  Chip,
  CoverageKindChip,
  PageHead,
  SelectField,
  TextArea,
  TextField,
} from '../components/ui';
import { useApp, useToast } from '../context/AppContext';
import { messageOf, useAsync } from '../hooks/useAsync';
import { useQueryParams } from '../hooks/useQueryParams';
import { S, sourceKindLabel } from '../strings';
import type { BlockChangeState, SourceKind, ValidateCoverageResult } from '../types';
import { flattenSections } from './cases/BulkActions';
import { formatAgo, formatDateTime, formatPercent } from '../utils/format';

const CHANGE_LABEL: Record<BlockChangeState, string> = {
  new: S.coverage.blockChangeNew,
  changed: S.coverage.blockChangeChanged,
  removed: S.coverage.blockChangeRemoved,
  same: S.coverage.blockChangeSame,
};

const CHANGE_TONE: Record<BlockChangeState, 'neutral' | 'accent' | 'warn' | 'bad'> = {
  new: 'accent',
  changed: 'warn',
  removed: 'bad',
  same: 'neutral',
};

export default function CoveragePage() {
  const { projectId } = useApp();
  const toast = useToast();
  const params = useQueryParams();

  const sourceId = params.get('source');
  const [importing, setImporting] = useState(false);
  const [selectedBlocks, setSelectedBlocks] = useState<Set<string>>(new Set());
  const [skillBusy, setSkillBusy] = useState<'write' | 'validate' | null>(null);
  const [report, setReport] = useState<ValidateCoverageResult['report'] | null>(null);
  const [targetSection, setTargetSection] = useState('');
  const [maxPerBlock, setMaxPerBlock] = useState('4');
  const [includeDerived, setIncludeDerived] = useState(true);

  const sourcesState = useAsync((signal) => api.listSources(projectId, signal), [projectId], Boolean(projectId));
  const sectionsState = useAsync((signal) => api.listSections(projectId, signal), [projectId], Boolean(projectId));
  const coverageState = useAsync(
    (signal) => api.getCoverage({ projectId, sourceId: sourceId || undefined }, signal),
    [projectId, sourceId],
    Boolean(projectId),
  );

  const sections = useMemo(() => flattenSections(sectionsState.data ?? []), [sectionsState.data]);
  const effectiveSection = targetSection || sections[0]?.value || '';

  /*
   * Вибрані вимоги належать конкретному документу. Без цього скидання можна
   * було вибрати блоки в одному джерелі, перемкнутись на інше — і згенерувати
   * кейси для того, чого на екрані вже не видно.
   */
  useEffect(() => setSelectedBlocks(new Set()), [sourceId]);

  function toggleBlock(id: string) {
    setSelectedBlocks((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function refresh(id: string) {
    try {
      const result = await api.refreshSource(id);
      toast({
        text: S.coverage.refreshedToast(result.changed, result.added, result.removed),
        tone: result.changed || result.added || result.removed ? 'warn' : 'good',
      });
      sourcesState.reload();
      coverageState.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    }
  }

  async function writeCases() {
    if (!effectiveSection) {
      toast({ text: S.coverage.needSection, tone: 'warn' });
      return;
    }
    // Сервер без blockIds не має з чого генерувати й тихо повертає нуль
    // пропозицій — раніше це виглядало як «модель нічого не придумала».
    if (selectedBlocks.size === 0) {
      toast({ text: S.coverage.needBlocks, tone: 'warn' });
      return;
    }
    setSkillBusy('write');
    try {
      const result = await api.writeCases({
        projectId,
        sectionId: effectiveSection,
        blockIds: selectedBlocks.size ? Array.from(selectedBlocks) : undefined,
        style: { maxPerBlock: Number(maxPerBlock) || undefined, includeDerived },
      });
      toast({ text: S.coverage.writeCasesToast(result.proposals.length), tone: 'good' });
      setSelectedBlocks(new Set());
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setSkillBusy(null);
    }
  }

  async function validate() {
    setSkillBusy('validate');
    try {
      const result = await api.validateCoverage({
        projectId,
        sourceId: sourceId || undefined,
        blockIds: selectedBlocks.size ? Array.from(selectedBlocks) : undefined,
      });
      setReport(result.report);
      toast({
        text: S.coverage.validateToast(result.report.gaps.length, result.report.duplicates.length),
        tone: result.report.gaps.length ? 'warn' : 'good',
      });
      coverageState.reload();
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setSkillBusy(null);
    }
  }

  return (
    <>
      <PageHead
        title={S.coverage.title}
        sub={S.coverage.sub}
        actions={
          <button type="button" className="btn btn-primary btn-sm" onClick={() => setImporting(true)}>
            {S.coverage.import}
          </button>
        }
      />

      {/* ── джерела вимог ── */}
      <section className="card">
        <div className="card-head">
          <h2>{S.coverage.sources}</h2>
        </div>
        {sourcesState.loading && sourcesState.data === undefined ? (
          <Loading rows={3} />
        ) : sourcesState.error && sourcesState.data === undefined ? (
          <ErrorState message={sourcesState.error} status={sourcesState.status} onRetry={sourcesState.reload} />
        ) : (sourcesState.data ?? []).length === 0 ? (
          <Empty
            title={S.empty.sources}
            hint={S.empty.sourcesHint}
            action={
              <button type="button" className="btn btn-sm" onClick={() => setImporting(true)}>
                {S.coverage.import}
              </button>
            }
          />
        ) : (
          <div className="table-wrap">
            <table className="tbl">
              <thead>
                <tr>
                  <th scope="col">{S.coverage.importTitleField}</th>
                  <th scope="col">{S.coverage.importKind}</th>
                  <th scope="col">{S.coverage.colBlock}</th>
                  <th scope="col">{S.coverage.gap}</th>
                  <th scope="col">{S.cases.updated}</th>
                  <th scope="col" />
                </tr>
              </thead>
              <tbody>
                {(sourcesState.data ?? []).map((item) => (
                  <tr key={item.id} className={sourceId === item.id ? 'selected' : ''}>
                    <td>
                      <button
                        type="button"
                        className="btn btn-ghost btn-sm"
                        onClick={() => params.set({ source: sourceId === item.id ? null : item.id })}
                      >
                        {item.title}
                      </button>
                      {/* Саме `> 0`, а не істинність: інакше React виводить «0» поруч із назвою. */}
                      {(item.changed ?? 0) > 0 && <Chip tone="warn">{S.coverage.changedBadge}</Chip>}
                    </td>
                    <td>{sourceKindLabel[item.kind]}</td>
                    <td className="cell-num mono">{item.blockCount ?? S.common.none}</td>
                    <td className="cell-num mono">{item.gapCount ?? S.common.none}</td>
                    <td className="nowrap text-xs muted" title={formatDateTime(item.updatedAt)}>
                      {formatAgo(item.updatedAt)}
                    </td>
                    <td className="nowrap">
                      {item.url && (
                        <a href={item.url} target="_blank" rel="noreferrer noopener" className="text-xs">
                          {S.common.openLink}
                        </a>
                      )}
                      <button type="button" className="btn btn-sm btn-ghost" onClick={() => void refresh(item.id)}>
                        {S.coverage.refresh}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {/* ── скіли ── */}
      <section className="card">
        <div className="card-head">
          <h2>{S.coverage.writeCases}</h2>
          <span className="spacer" />
          <span className="muted text-xs">
            {selectedBlocks.size > 0 ? S.coverage.selectedBlocks(selectedBlocks.size) : S.coverage.needBlocks}
          </span>
        </div>
        <div className="card-body">
          <div className="grid grid-2">
            <SelectField
              label={S.coverage.targetSection}
              value={effectiveSection}
              onChange={setTargetSection}
              options={sections}
              hint={sections.length === 0 ? S.empty.treeHint : undefined}
            />
            <TextField
              label={S.coverage.maxPerBlock}
              value={maxPerBlock}
              onChange={setMaxPerBlock}
              type="number"
            />
          </div>
          <CheckField label={S.coverage.includeDerived} checked={includeDerived} onChange={setIncludeDerived} />
          <div className="row-wrap">
            <button
              type="button"
              className="btn btn-primary btn-sm"
              onClick={writeCases}
              disabled={skillBusy !== null || selectedBlocks.size === 0}
              title={selectedBlocks.size === 0 ? S.coverage.needBlocks : undefined}
            >
              {skillBusy === 'write'
                ? S.coverage.writeCasesRunning
                : selectedBlocks.size > 0
                  ? S.coverage.writeCasesFor(selectedBlocks.size)
                  : S.coverage.writeCases}
            </button>
            <button type="button" className="btn btn-sm" onClick={validate} disabled={skillBusy !== null}>
              {skillBusy === 'validate' ? S.coverage.validateRunning : S.coverage.validate}
            </button>
            <Link className="btn btn-sm btn-ghost" to="/proposals">
              {S.dashboard.goProposals} →
            </Link>
          </div>
        </div>
      </section>

      {report && <ValidationReport report={report} onClose={() => setReport(null)} />}

      {/* ── матриця ── */}
      <section className="card">
        <div className="card-head">
          <h2>{S.coverage.matrix}</h2>
          <span className="spacer" />
          {coverageState.data && (
            <span className="muted text-xs">
              {S.coverage.statsLine(
                coverageState.data.stats.blocks,
                coverageState.data.stats.coveredBlocks,
                coverageState.data.stats.gaps,
              )}
              {' · '}
              {S.dashboard.derivedShare}: {formatPercent(coverageState.data.stats.derivedShare)}
            </span>
          )}
        </div>
        <Async
          state={coverageState}
          skeletonRows={6}
          empty={{ title: S.empty.coverage, hint: S.empty.coverageHint }}
        >
          {(data) =>
            data.rows.length === 0 ? (
              <Empty title={S.empty.coverage} hint={S.empty.coverageHint} />
            ) : (
              <div className="table-wrap">
                <table className="tbl">
                  <thead>
                    <tr>
                      <th scope="col" className="col-check">
                        <span className="visually-hidden">{S.coverage.selectBlocks}</span>
                      </th>
                      <th scope="col">{S.coverage.colBlock}</th>
                      <th scope="col">{S.coverage.colCases}</th>
                      <th scope="col">{S.coverage.colState}</th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.rows.map((row) => (
                      <tr key={row.block.id} className={`matrix-row${row.gap ? ' gap' : ''}`}>
                        <td className="col-check">
                          <input
                            type="checkbox"
                            checked={selectedBlocks.has(row.block.id)}
                            onChange={() => toggleBlock(row.block.id)}
                            aria-label={`${S.coverage.selectBlocks}: ${row.block.heading || row.block.id}`}
                          />
                        </td>
                        <td>
                          <div className="matrix-block">
                            {row.block.heading && <strong>{row.block.heading}</strong>}
                            <p className="text-sm">{row.block.text}</p>
                            {row.block.anchor && <span className="mono text-xs muted">#{row.block.anchor}</span>}
                          </div>
                        </td>
                        <td>
                          {row.cases.length === 0 ? (
                            <span className="muted text-xs">{S.common.none}</span>
                          ) : (
                            <div className="matrix-cases">
                              {row.cases.map((item) => (
                                <Link
                                  key={item.caseId}
                                  className="tag"
                                  to={`/cases?case=${encodeURIComponent(item.caseId)}`}
                                  title={item.title}
                                >
                                  {item.caseId}
                                  {item.kind === 'derived' ? ' ◇' : ''}
                                  {item.confirmed ? ' ✓' : ''}
                                </Link>
                              ))}
                            </div>
                          )}
                        </td>
                        <td className="nowrap">
                          {row.gap ? <Chip tone="warn">{S.coverage.gap}</Chip> : <Chip tone="good">{S.coverage.covered}</Chip>}
                          <Chip tone={CHANGE_TONE[row.block.changeState]}>{CHANGE_LABEL[row.block.changeState]}</Chip>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="card-body" style={{ paddingTop: 'var(--sp-2)' }}>
                  <div className="row-wrap text-xs muted">
                    <CoverageKindChip kind="quote" /> — {S.cases.requirementQuote}
                    <CoverageKindChip kind="derived" /> — {S.cases.requirementDerived} (◇)
                  </div>
                </div>
              </div>
            )
          }
        </Async>
      </section>

      {importing && (
        <ImportDialog
          projectId={projectId}
          onClose={() => setImporting(false)}
          onImported={() => {
            sourcesState.reload();
            coverageState.reload();
          }}
        />
      )}
    </>
  );
}

/* ─────────────────────────── звіт перевірки ──────────────────────────── */

function ValidationReport({
  report,
  onClose,
}: {
  report: ValidateCoverageResult['report'];
  onClose: () => void;
}) {
  return (
    <section className="card">
      <div className="card-head">
        <h2>{S.coverage.report}</h2>
        <span className="spacer" />
        <button type="button" className="btn btn-ghost btn-sm" onClick={onClose}>
          {S.common.dismiss}
        </button>
      </div>
      <div className="card-body grid grid-2">
        <ReportList title={S.coverage.reportGaps} items={report.gaps.map((g) => `${g.heading ?? g.blockId}: ${g.reason ?? ''}`)} tone="warn" />
        <ReportList
          title={S.coverage.reportDuplicates}
          items={report.duplicates.map((d) => `${d.caseIds.join(', ')}: ${d.reason ?? ''}`)}
          tone="warn"
        />
        <ReportList
          title={S.coverage.reportUntestable}
          items={report.untestable.map((u) => `${u.blockId}: ${u.reason ?? ''}`)}
          tone="neutral"
        />
        <ReportList
          title={S.coverage.reportContradictions}
          items={report.contradictions.map((c) => `${(c.blockIds ?? []).join(', ')}: ${c.reason ?? ''}`)}
          tone="bad"
        />
      </div>
    </section>
  );
}

function ReportList({
  title,
  items,
  tone,
}: {
  title: string;
  items: string[];
  tone: 'neutral' | 'warn' | 'bad';
}) {
  return (
    <div>
      <div className="row">
        <h3 className="muted text-xs">{title}</h3>
        <Chip tone={items.length ? tone : 'good'} mono>
          {items.length}
        </Chip>
      </div>
      {items.length === 0 ? (
        <p className="muted text-sm">{S.common.none}</p>
      ) : (
        <ul className="text-sm">
          {items.map((item, index) => (
            <li key={index}>{item}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/* ───────────────────────────── імпорт джерела ────────────────────────── */

function ImportDialog({
  projectId,
  onClose,
  onImported,
}: {
  projectId: string;
  onClose: () => void;
  onImported: () => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<SourceKind>('confluence');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const result = await api.importSource({
        projectId,
        kind,
        url: kind === 'confluence' ? url : undefined,
        text: kind === 'paste' ? text : undefined,
        title: title || undefined,
      });
      toast({ text: S.coverage.importedToast(result.blocks.length), tone: 'good' });
      onImported();
      onClose();
    } catch (cause) {
      setError(messageOf(cause));
    } finally {
      setBusy(false);
    }
  }

  const canSubmit = kind === 'confluence' ? url.trim().length > 0 : text.trim().length > 0;

  return (
    <Dialog
      title={S.coverage.importTitle}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {S.common.cancel}
          </button>
          <button type="button" className="btn btn-primary" onClick={submit} disabled={busy || !canSubmit}>
            {S.coverage.importSubmit}
          </button>
        </>
      }
    >
      <SelectField
        label={S.coverage.importKind}
        value={kind}
        onChange={(next) => setKind(next as SourceKind)}
        options={[
          { value: 'confluence', label: sourceKindLabel.confluence },
          { value: 'paste', label: sourceKindLabel.paste },
        ]}
      />
      {kind === 'confluence' ? (
        <TextField
          label={S.coverage.importUrl}
          value={url}
          onChange={setUrl}
          type="url"
          mono
          placeholder={S.coverage.importUrlPlaceholder}
          hint={S.settings.intConfluenceHint}
        />
      ) : (
        <TextArea
          label={S.coverage.importText}
          value={text}
          onChange={setText}
          rows={10}
          placeholder={S.coverage.importTextPlaceholder}
        />
      )}
      <TextField label={S.coverage.importTitleField} value={title} onChange={setTitle} />
      {error && <div className="alert bad">{error}</div>}
    </Dialog>
  );
}
