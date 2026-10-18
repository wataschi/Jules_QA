/**
 * «Входи»: звідки агенти беруть вимоги. Зліва — дерево сторінок Confluence і
 * файлів Figma з галочками «брати» і «не віддавати агентам», справа — вміст
 * вибраного джерела по блоках із картинками, схемами й пов’язаними кадрами.
 * Окрема вкладка збирає картинки, прочитання яких чекає рішення QA.
 */
import { useCallback, useMemo, useState } from 'react';
import { Link, useLocation, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { Dialog } from '../components/Dialog';
import { Async, Empty } from '../components/states';
import { PageHead, Tabs } from '../components/ui';
import { useApp, useToast } from '../context/AppContext';
import { messageOf, useAsync, useResource } from '../hooks/useAsync';
import { useQueryParams } from '../hooks/useQueryParams';
import { S2 } from '../strings-v2';
import type { Asset, SourceNode } from '../types';
import { ConfluenceForm, FigmaForm, ModulesForm } from './inputs/InputForms';
import { ErrorNote, SyncSummary } from './inputs/Notes';
import { ReadingsList, pendingReadings } from './inputs/ReadingsList';
import { SourcePanel } from './inputs/SourcePanel';
import { SourceTree, type SourceFlags } from './inputs/SourceTree';
import { confluenceRoots, flattenSources, patchNode, sectionNames, syncTotals, type SyncTotals } from './inputs/model';
import { SI } from './inputs/strings';
import '../styles/inputs.css';

type DialogKind = 'confluence' | 'figma' | 'modules' | null;

export default function InputsPage() {
  const { projectId } = useApp();
  const toast = useToast();
  const params = useQueryParams();
  const navigate = useNavigate();
  const location = useLocation();
  const { sourceId = '' } = useParams();
  const tab = params.get('tab') === 'readings' ? 'readings' : 'sources';

  const treeState = useResource((signal) => api.getSourceTree(projectId, signal), [projectId], { enabled: Boolean(projectId) });
  const sectionsState = useAsync((signal) => api.listSections(projectId, signal), [projectId], Boolean(projectId));
  const assetsState = useResource((signal) => api.listAssets(projectId, undefined, signal), [projectId], {
    enabled: Boolean(projectId),
    pollMs: 60_000,
  });

  const [dialog, setDialog] = useState<DialogKind>(null);
  const [syncing, setSyncing] = useState(false);
  const [totals, setTotals] = useState<SyncTotals | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  const sections = useMemo(() => sectionNames(sectionsState.data), [sectionsState.data]);
  const assets = useMemo(() => new Map((assetsState.data ?? []).map((asset) => [asset.id, asset])), [assetsState.data]);
  const flat = useMemo(() => flattenSources(treeState.data ?? []), [treeState.data]);
  const sourceTitles = useMemo(() => new Map(flat.map((node) => [node.id, node.title])), [flat]);
  const roots = useMemo(() => confluenceRoots(treeState.data ?? []), [treeState.data]);
  const pendingCount = pendingReadings(assetsState.data).length;
  const selected = flat.find((node) => node.id === sourceId);
  const selectedRootId = selected ? (selected.rootId ?? selected.id) : undefined;

  const reloadTree = treeState.reload;
  const reloadAssets = assetsState.reload;
  const reloadSections = sectionsState.reload;

  const goTo = useCallback(
    (id: string | null) => {
      const search = new URLSearchParams(location.search);
      search.delete('tab');
      const query = search.toString();
      navigate({ pathname: id ? `/inputs/${encodeURIComponent(id)}` : '/inputs', search: query ? `?${query}` : '' });
    },
    [location.search, navigate],
  );

  const setFlags = async (node: SourceNode, flags: SourceFlags) => {
    const before = treeState.data;
    if (before) treeState.setData(patchNode(before, node.id, flags));
    try {
      await api.patchSourceFlags(node.id, flags);
    } catch (error) {
      if (before) treeState.setData(before);
      toast({ text: messageOf(error), tone: 'bad' });
    }
  };

  const onDecided = (updated: Asset) => {
    const list = assetsState.data;
    if (list) assetsState.setData(list.map((item) => (item.id === updated.id ? { ...item, ...updated } : item)));
    else reloadAssets();
  };

  const syncAll = async () => {
    setSyncing(true);
    setSyncError(null);
    setTotals(null);
    try {
      const result = await api.syncInputs(projectId);
      setTotals(syncTotals(result.results, result.errors));
      reloadTree();
      reloadAssets();
    } catch (error) {
      setSyncError(messageOf(error));
    } finally {
      setSyncing(false);
    }
  };

  const search = location.search;

  return (
    <>
      <PageHead
        title={S2.nav.inputs}
        sub={SI.sub}
        actions={
          <Link className="btn btn-ghost" to={{ pathname: '/setup', search }}>
            {SI.wizardLink} →
          </Link>
        }
      />

      <div className="inputs-toolbar" role="toolbar" aria-label={S2.nav.inputs}>
        <button type="button" className="btn btn-primary" disabled={syncing || !projectId} onClick={syncAll}>
          {syncing ? SI.actions.syncing : SI.actions.syncAll}
        </button>
        <button type="button" className="btn" onClick={() => setDialog('confluence')}>
          + {SI.actions.addConfluence}
        </button>
        <button type="button" className="btn" onClick={() => setDialog('figma')}>
          + {SI.actions.addFigma}
        </button>
        <button type="button" className="btn" disabled={roots.length === 0} onClick={() => setDialog('modules')}>
          {SI.actions.modules}
        </button>
      </div>

      {syncError && <ErrorNote message={syncError} />}
      {totals && <SyncSummary totals={totals} onClose={() => setTotals(null)} />}

      <div className="card inputs-tabs-card">
        <Tabs
          label={SI.tabs.label}
          active={tab}
          onPick={(value) => params.set({ tab: value === 'readings' ? 'readings' : null })}
          tabs={[
            { value: 'sources', label: SI.tabs.sources },
            { value: 'readings', label: pendingCount ? `${SI.tabs.readings} · ${pendingCount}` : SI.tabs.readings },
          ]}
        />
      </div>

      {tab === 'readings' ? (
        <ReadingsList state={assetsState} sourceTitles={sourceTitles} onDecided={onDecided} />
      ) : (
        <div className={`inputs-layout${sourceId ? ' has-selection' : ''}`}>
          <section className="card inputs-tree-col" aria-labelledby="inputs-tree-title">
            <div className="card-head">
              <h2 id="inputs-tree-title">{SI.tree.title}</h2>
              {treeState.refreshing && <span className="muted text-xs">{SI.actions.syncing}</span>}
            </div>
            <p className="inputs-tree-hint">{SI.tree.hint}</p>
            <Async
              state={treeState}
              empty={{
                title: SI.tree.empty,
                hint: SI.tree.emptyHint,
                action: (
                  <Link className="btn btn-sm" to={{ pathname: '/setup', search }}>
                    {SI.wizardLink}
                  </Link>
                ),
              }}
            >
              {(nodes) => (
                <SourceTree
                  nodes={nodes}
                  selectedId={sourceId}
                  onSelect={(node) => goTo(node.id)}
                  onFlags={setFlags}
                  sections={sections}
                />
              )}
            </Async>
          </section>

          {sourceId ? (
            <SourcePanel
              key={sourceId}
              projectId={projectId}
              sourceId={sourceId}
              assets={assets}
              sections={sections}
              onDecided={onDecided}
              onSourceChanged={() => {
                reloadTree();
                reloadAssets();
              }}
              onBack={() => goTo(null)}
            />
          ) : (
            <section className="card inputs-placeholder">
              <Empty title={SI.view.pick} hint={SI.view.pickHint} glyph="▤" />
            </section>
          )}
        </div>
      )}

      {dialog === 'confluence' && (
        <Dialog title={SI.addConfluence.title} onClose={() => setDialog(null)} size="lg">
          <p className="muted">{SI.addConfluence.why}</p>
          <ConfluenceForm
            projectId={projectId}
            onLoaded={({ root, sources, truncated }) => {
              reloadTree();
              toast({ text: SI.addConfluence.loaded(flattenSources(sources).length), tone: 'good' });
              if (!truncated) setDialog(null);
              if (root) goTo(root.id);
            }}
          />
        </Dialog>
      )}

      {dialog === 'figma' && (
        <Dialog title={SI.addFigma.title} onClose={() => setDialog(null)} size="lg">
          <p className="muted">{SI.addFigma.why}</p>
          <FigmaForm
            projectId={projectId}
            onImported={(result) => {
              reloadTree();
              reloadAssets();
              toast({ text: SI.addFigma.imported(result), tone: 'good' });
              setDialog(null);
              goTo(result.sourceId);
            }}
          />
        </Dialog>
      )}

      {dialog === 'modules' && (
        <Dialog title={SI.modules.title} onClose={() => setDialog(null)}>
          <p className="muted">{SI.modules.why}</p>
          <ModulesForm
            projectId={projectId}
            roots={roots}
            initialRootId={selectedRootId}
            onDone={() => {
              reloadTree();
              reloadSections();
            }}
          />
        </Dialog>
      )}
    </>
  );
}
