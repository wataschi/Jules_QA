/** Права колонка «Входів»: вміст одного джерела по блоках. */
import { useMemo, useState } from 'react';
import { api } from '../../api';
import { RequestTaskDialog } from '../../components/RequestTaskDialog';
import { Async, Empty } from '../../components/states';
import { Chip } from '../../components/ui';
import { useToast } from '../../context/AppContext';
import { messageOf, useAsync, useResource } from '../../hooks/useAsync';
import type { Asset, RequirementView, SourceNode } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';
import { BlockCard, type RequestTarget } from './BlockCard';
import { ErrorNote } from './Notes';
import { explainError } from './model';
import { SI } from './strings';

export function SourcePanel({
  projectId,
  sourceId,
  assets,
  sections,
  onDecided,
  onSourceChanged,
  onBack,
}: {
  projectId: string;
  sourceId: string;
  assets: Map<string, Asset>;
  sections: Map<string, string>;
  onDecided: (asset: Asset) => void;
  /** Після оновлення сторінки: перечитати дерево й вкладення. */
  onSourceChanged: () => void;
  onBack: () => void;
}) {
  const toast = useToast();
  const viewState = useResource((signal) => api.getSourceView(sourceId, signal), [sourceId], { enabled: Boolean(sourceId) });
  const [request, setRequest] = useState<RequestTarget | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);

  const screenIds = useMemo(() => {
    const ids = new Set<string>();
    for (const block of viewState.data?.blocks ?? []) for (const id of block.screens) ids.add(id);
    return [...ids].sort();
  }, [viewState.data]);
  const screensKey = screenIds.join(',');
  const framesState = useAsync((signal) => api.getRequirements(screenIds, signal), [screensKey], screenIds.length > 0);
  const frames = useMemo(() => {
    const map = new Map<string, RequirementView>();
    for (const frame of framesState.data ?? []) map.set(frame.blockId, frame);
    return map;
  }, [framesState.data]);

  const sync = async () => {
    setSyncing(true);
    setSyncError(null);
    try {
      const result = await api.syncSource(sourceId);
      toast({ text: `${SI.view.synced}. ${SI.sync.oneResult(result)}`, tone: result.assetErrors.length ? 'warn' : 'good' });
      viewState.reload();
      framesState.reload();
      onSourceChanged();
    } catch (error) {
      const message = messageOf(error);
      setSyncError(message);
      toast({ text: explainError(message).text, tone: 'bad' });
      onSourceChanged();
    } finally {
      setSyncing(false);
    }
  };

  return (
    <section className="inputs-panel" aria-label={viewState.data?.source.title ?? SI.view.pick}>
      <button type="button" className="btn btn-ghost btn-sm only-narrow inputs-back" onClick={onBack}>
        {SI.actions.back}
      </button>
      <Async state={viewState} skeletonRows={8}>
        {({ source, blocks }) => (
          <div className="col">
            <SourceHead source={source} sections={sections} syncing={syncing} onSync={sync} />
            {syncError && <ErrorNote message={syncError} />}
            {!syncError && source.lastError && (
              <div className="alert bad" role="note">
                <span>
                  <b>{SI.view.lastError}:</b> {explainError(source.lastError).text}
                </span>
              </div>
            )}
            {!source.included && <div className="alert warn">{SI.view.excluded}</div>}
            {blocks.length === 0 ? (
              <div className="card">
                <Empty title={SI.view.noBlocks} hint={SI.view.noBlocksHint} />
              </div>
            ) : (
              blocks.map((block) => (
                <BlockCard
                  key={block.blockId}
                  block={block}
                  frames={block.screens.map((id) => frames.get(id)).filter((item): item is RequirementView => Boolean(item))}
                  framesLoading={framesState.loading}
                  assets={assets}
                  onDecided={onDecided}
                  onRequest={setRequest}
                />
              ))
            )}
          </div>
        )}
      </Async>
      {request && (
        <RequestTaskDialog
          projectId={projectId}
          anchor={{ blockId: request.blockId }}
          anchorLabel={request.label}
          onClose={() => setRequest(null)}
        />
      )}
    </section>
  );
}

function SourceHead({
  source,
  sections,
  syncing,
  onSync,
}: {
  source: SourceNode;
  sections: Map<string, string>;
  syncing: boolean;
  onSync: () => void;
}) {
  const moduleName = source.sectionId ? sections.get(source.sectionId) ?? source.sectionId : undefined;
  return (
    <div className="card">
      <div className="card-head source-head">
        <h2 className="source-title">{source.title}</h2>
        <Chip>{SI.kind[source.kind]}</Chip>
        {source.noAgents && <Chip tone="warn">{SI.view.withheld}</Chip>}
        <span className="spacer" />
        {source.url && (
          <a className="btn btn-sm" href={source.url} target="_blank" rel="noreferrer noopener">
            {SI.actions.openOriginal} ↗
          </a>
        )}
        {source.externalId && (
          <button type="button" className="btn btn-sm btn-primary" disabled={syncing} onClick={onSync}>
            {syncing ? SI.actions.syncing : SI.actions.syncSource}
          </button>
        )}
      </div>
      <dl className="kv source-kv">
        <dt>{SI.view.module}</dt>
        <dd>{moduleName ?? SI.tree.noModule}</dd>
        <dt>{SI.view.checked}</dt>
        <dd title={formatDateTime(source.checkedAt)}>
          {source.checkedAt ? formatAgo(source.checkedAt) : SI.tree.notChecked}
        </dd>
        <dt>{SI.view.blocks}</dt>
        <dd>
          {source.blockCount}
          {source.gaps > 0 && <span className="src-gaps"> · {SI.tree.gaps(source.gaps)}</span>}
        </dd>
        {source.externalVersion && (
          <>
            <dt>{SI.view.version}</dt>
            <dd className="mono">{source.externalVersion}</dd>
          </>
        )}
      </dl>
    </div>
  );
}
