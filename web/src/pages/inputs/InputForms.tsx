/**
 * Форми прийому входів, спільні для «Входів» і майстра нового проєкту:
 * посилання Confluence → дерево, посилання Figma → кадри, корінь → модулі.
 */
import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { api } from '../../api';
import { SelectField, TextField } from '../../components/ui';
import { messageOf } from '../../hooks/useAsync';
import type { SourceNode, SyncResult } from '../../types';
import { ErrorNote } from './Notes';
import { flattenSources } from './model';
import { SI, SW } from './strings';

type Failure = { message: string; status?: number | null };

function failureOf(error: unknown): Failure {
  const status = typeof error === 'object' && error && 'status' in error ? Number((error as { status: unknown }).status) : null;
  return { message: messageOf(error), status };
}

/* ───────────────────────────── Confluence ───────────────────────────── */

export function ConfluenceForm({
  projectId,
  onLoaded,
  autoFocus = false,
}: {
  projectId: string;
  onLoaded: (result: { sources: SourceNode[]; truncated: boolean; root?: SourceNode }) => void;
  autoFocus?: boolean;
}) {
  const [ref, setRef] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<{ count: number; truncated: boolean } | null>(null);

  const submit = async () => {
    if (!ref.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const result = await api.loadConfluenceTree(projectId, ref.trim());
      const flat = flattenSources(result.sources);
      // Корінь — вузол найменшої глибини серед завантажених.
      const root = flat.reduce<SourceNode | undefined>((best, node) => (!best || node.depth < best.depth ? node : best), undefined);
      setDone({ count: flat.length, truncated: result.truncated });
      onLoaded({ ...result, root });
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="inputs-form-row">
        <TextField
          label={SI.addConfluence.link}
          hint={SI.addConfluence.linkHint}
          value={ref}
          onChange={setRef}
          type="url"
          className="grow"
        />
        <button type="submit" className="btn btn-primary" disabled={!ref.trim() || busy} autoFocus={autoFocus}>
          {busy ? SI.addConfluence.loading : SI.addConfluence.load}
        </button>
      </div>
      {failure && <ErrorNote message={failure.message} status={failure.status} />}
      {done && (
        <div className="alert good" role="status">
          {SI.addConfluence.loaded(done.count)}
        </div>
      )}
      {done?.truncated && <div className="alert warn">{SI.addConfluence.truncated}</div>}
    </form>
  );
}

/* ──────────────────────────────── Figma ─────────────────────────────── */

export function FigmaForm({ projectId, onImported }: { projectId: string; onImported: (result: SyncResult) => void }) {
  const [url, setUrl] = useState('');
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [done, setDone] = useState<SyncResult | null>(null);

  const submit = async () => {
    if (!url.trim() || busy) return;
    setBusy(true);
    setFailure(null);
    setDone(null);
    try {
      const result = await api.importFigma(projectId, url.trim());
      setDone(result);
      onImported(result);
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <div className="inputs-form-row">
        <TextField label={SI.addFigma.link} hint={SI.addFigma.linkHint} value={url} onChange={setUrl} type="url" className="grow" />
        <button type="submit" className="btn btn-primary" disabled={!url.trim() || busy}>
          {busy ? SI.addFigma.importing : SI.addFigma.import}
        </button>
      </div>
      {failure && <ErrorNote message={failure.message} status={failure.status} />}
      {done && (
        <div className="alert good" role="status">
          {SI.addFigma.imported(done)}
        </div>
      )}
    </form>
  );
}

/** Кілька посилань Figma одразу — для майстра. */
export function FigmaMultiForm({ projectId, onImported }: { projectId: string; onImported: () => void }) {
  const [urls, setUrls] = useState<string[]>(['']);
  const [busy, setBusy] = useState(false);
  const [results, setResults] = useState<Array<{ url: string; result?: SyncResult; failure?: Failure }>>([]);

  const filled = urls.map((item) => item.trim()).filter(Boolean);

  const submit = async () => {
    if (!filled.length || busy) return;
    setBusy(true);
    const next: typeof results = [];
    for (const url of filled) {
      try {
        next.push({ url, result: await api.importFigma(projectId, url) });
      } catch (error) {
        next.push({ url, failure: failureOf(error) });
      }
      setResults([...next]);
    }
    setBusy(false);
    onImported();
  };

  return (
    <form
      className="col"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      {urls.map((value, index) => (
        <div className="inputs-form-row" key={index}>
          <TextField
            label={SW.figma.link(index + 1)}
            hint={index === 0 ? SI.addFigma.linkHint : undefined}
            value={value}
            type="url"
            className="grow"
            onChange={(next) => setUrls((list) => list.map((item, i) => (i === index ? next : item)))}
          />
          {urls.length > 1 && (
            <button
              type="button"
              className="btn btn-ghost btn-icon"
              aria-label={SW.figma.removeLink(index + 1)}
              onClick={() => setUrls((list) => list.filter((_, i) => i !== index))}
            >
              <span aria-hidden="true">✕</span>
            </button>
          )}
        </div>
      ))}
      <div className="row-wrap">
        <button type="button" className="btn btn-sm" onClick={() => setUrls((list) => [...list, ''])}>
          + {SW.figma.addLink}
        </button>
        <span className="spacer" />
        <button type="submit" className="btn btn-primary" disabled={!filled.length || busy}>
          {busy ? SI.addFigma.importing : SW.figma.importAll}
        </button>
      </div>
      {results.length > 0 && (
        <ul className="plain-list col">
          {results.map((item, index) => (
            <li key={`${item.url}-${index}`}>
              {item.result ? (
                <div className="alert good" role="status">
                  <span>
                    <b>{item.result.title}</b> — {SI.addFigma.imported(item.result)}
                  </span>
                </div>
              ) : (
                item.failure && <ErrorNote message={`${item.url}: ${item.failure.message}`} status={item.failure.status} />
              )}
            </li>
          ))}
        </ul>
      )}
    </form>
  );
}

/* ─────────────────────────────── модулі ─────────────────────────────── */

type ModulesResult = Awaited<ReturnType<typeof api.modulesFromTree>>;

export function ModulesForm({
  projectId,
  roots,
  initialRootId,
  onDone,
}: {
  projectId: string;
  roots: SourceNode[];
  initialRootId?: string;
  onDone?: (result: ModulesResult) => void;
}) {
  const location = useLocation();
  const [rootId, setRootId] = useState(() =>
    initialRootId && roots.some((root) => root.id === initialRootId) ? initialRootId : roots[0]?.id ?? '',
  );
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<Failure | null>(null);
  const [result, setResult] = useState<ModulesResult | null>(null);

  if (roots.length === 0) return <p className="muted">{SI.modules.noRoots}</p>;

  const root = roots.find((item) => item.id === rootId) ?? roots[0];
  const preview = (root?.children ?? []).filter((child) => child.included);

  const submit = async () => {
    if (!root || busy) return;
    setBusy(true);
    setFailure(null);
    try {
      const next = await api.modulesFromTree(projectId, root.id);
      setResult(next);
      onDone?.(next);
    } catch (error) {
      setFailure(failureOf(error));
    } finally {
      setBusy(false);
    }
  };

  const planCount = result?.sections.filter((section) => section.planTask).length ?? 0;

  return (
    <div className="col">
      {roots.length > 1 && (
        <SelectField
          label={SI.modules.root}
          value={root?.id ?? ''}
          options={roots.map((item) => ({ value: item.id, label: item.title }))}
          onChange={(value) => {
            setRootId(value);
            setResult(null);
          }}
        />
      )}
      {roots.length === 1 && root && (
        <p className="text-sm">
          {SI.modules.root}: <b>{root.title}</b>
        </p>
      )}
      <div className="col modules-preview">
        <span className="asset-label">{SI.modules.preview}</span>
        {preview.length ? (
          <ul className="modules-list">
            {preview.map((child) => (
              <li key={child.id}>{child.title}</li>
            ))}
          </ul>
        ) : (
          <p className="muted text-sm">{SI.modules.previewEmpty}</p>
        )}
      </div>
      <div className="row-wrap">
        <button type="button" className="btn btn-primary" disabled={busy || preview.length === 0} onClick={submit}>
          {busy ? SI.modules.creating : SI.modules.create}
        </button>
      </div>
      {failure && <ErrorNote message={failure.message} status={failure.status} />}
      {result && (
        <div className="alert good col modules-result" role="status" data-testid="modules-result">
          <b>
            {SI.modules.result}. {SI.modules.summary(result.sections.length, planCount)}
          </b>
          <ul className="plain-list">
            {result.sections.map((section) => (
              <li key={section.id}>
                <b>{section.name}</b> — {section.created ? SI.modules.created : SI.modules.existed};{' '}
                {section.planTask ? (
                  <>
                    {SI.modules.planTask}{' '}
                    <Link to={{ pathname: `/tasks/${encodeURIComponent(section.planTask)}`, search: location.search }} className="mono">
                      {section.planTask}
                    </Link>
                  </>
                ) : (
                  SI.modules.planExists
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
