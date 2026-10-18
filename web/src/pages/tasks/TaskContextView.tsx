/**
 * Контекст задачі — те саме, що отримує агент: кейс із перевірками, блоки
 * вимог із картинками, кадри макета поруч, наявні тести кейса. Для
 * `read_asset` — сама картинка і її поточне прочитання.
 */
import { Link } from 'react-router-dom';
import { api } from '../../api';
import { CaseStatusChip, Chip, PriorityChip } from '../../components/ui';
import { S2 } from '../../strings-v2';
import type { AssetView, CodeTest, RequirementView, TaskContext } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';
import { T } from './strings';

function assetSrc(asset: AssetView): string | undefined {
  return asset.fileUrl ? api.assetFileUrl(asset.id) : undefined;
}

function AssetFigure({ asset, large = false }: { asset: AssetView; large?: boolean }) {
  const src = assetSrc(asset);
  return (
    <figure className={`tasks-asset${large ? ' large' : ''}`}>
      {src ? (
        <a href={src} target="_blank" rel="noreferrer" className="tasks-asset-link">
          <img src={src} alt={asset.name} loading="lazy" />
        </a>
      ) : (
        <div className="tasks-asset-missing text-xs muted">{asset.name}</div>
      )}
      <figcaption className="text-xs">
        <span className="truncate" title={asset.name}>
          {asset.name}
        </span>
        <span className="muted">{S2.readingState[asset.readingState]}</span>
      </figcaption>
    </figure>
  );
}

function RequirementBlock({ view }: { view: RequirementView }) {
  const change = T.context.changed[view.changeState];
  return (
    <article className={`tasks-req${view.sourceKind === 'figma' ? ' frame' : ''}`}>
      <header className="tasks-req-head">
        <h4>{view.heading || view.sourceTitle}</h4>
        {change && <Chip tone={view.changeState === 'removed' ? 'bad' : 'warn'}>{change}</Chip>}
      </header>
      <p className="text-xs muted">
        {T.context.source}:{' '}
        {view.url ? (
          <a href={view.url} target="_blank" rel="noreferrer">
            {view.sourceTitle} ↗
          </a>
        ) : (
          view.sourceTitle
        )}
        {view.route && (
          <>
            {' · '}
            {T.context.route}: <span className="mono">{view.route}</span>
          </>
        )}
      </p>
      {view.withheld ? (
        <p className="alert warn text-xs">{T.context.withheld}</p>
      ) : (
        view.text && <p className="pre-wrap text-sm tasks-req-text">{view.text}</p>
      )}
      {view.assets.length > 0 && (
        <div className="tasks-assets">
          {view.assets.map((asset) => (
            <AssetFigure key={asset.id} asset={asset} />
          ))}
        </div>
      )}
    </article>
  );
}

function TestsList({ tests }: { tests: CodeTest[] }) {
  if (!tests.length) return <p className="muted text-sm">{T.context.noTests}</p>;
  return (
    <ul className="tasks-tests">
      {tests.map((test) => {
        const result = test.lastResult;
        return (
          <li key={test.id}>
            <span className="row-wrap">
              <span className="text-sm">{test.name}</span>
              {result ? (
                <span title={`${T.context.lastResult}: ${formatDateTime(result.at)}${result.sha ? ` @ ${result.sha.slice(0, 7)}` : ''}`}>
                  <Chip tone={result.status === 'passed' ? 'good' : result.status === 'failed' ? 'bad' : 'neutral'}>
                    {T.context.result[result.status] ?? result.status} · {formatAgo(result.at)}
                  </Chip>
                </span>
              ) : (
                <span className="text-xs muted">{T.context.noResult}</span>
              )}
            </span>
            <span className="mono text-xs muted">
              {test.file} · {test.level}
            </span>
          </li>
        );
      })}
    </ul>
  );
}

export function TaskContextView({ context }: { context: TaskContext }) {
  const { module, case: kase, requirements, screens, asset, tests } = context;
  const nothing = !module && !kase && !requirements.length && !screens.length && !asset;

  return (
    <section className="card" aria-labelledby="task-context-title">
      <div className="card-head">
        <h2 id="task-context-title">{T.context.title}</h2>
      </div>
      <div className="card-body">
        {nothing && <p className="muted text-sm">{T.context.empty}</p>}

        {asset && (
          <div className="tasks-ctx-block">
            <h3 className="tasks-label">{T.context.asset}</h3>
            <div className="tasks-reading">
              <AssetFigure asset={asset} large />
              <div>
                <h4 className="text-xs muted">{T.context.currentReading}</h4>
                {asset.text ? <p className="pre-wrap text-sm">{asset.text}</p> : <p className="muted text-sm">{T.context.noReading}</p>}
              </div>
            </div>
          </div>
        )}

        {kase && (
          <div className="tasks-ctx-block">
            <h3 className="tasks-label">{T.context.case}</h3>
            <div className="row-wrap">
              <Link className="mono text-sm" to={`/cases?case=${encodeURIComponent(kase.id)}`}>
                {kase.id}
              </Link>
              <PriorityChip priority={kase.priority} />
              <CaseStatusChip status={kase.status} />
            </div>
            <p className="text-sm">{kase.title}</p>
            {kase.preconditions && (
              <p className="text-xs">
                <span className="muted">{T.context.preconditions}: </span>
                {kase.preconditions}
              </p>
            )}
            {kase.checks.length > 0 && (
              <>
                <h4 className="text-xs muted">{T.context.checks}</h4>
                <ol className="tasks-case-checks text-sm">
                  {kase.checks.map((check, index) => (
                    <li key={index}>{check}</li>
                  ))}
                </ol>
              </>
            )}
            <Link className="btn btn-sm btn-ghost tasks-self-start" to={`/cases?case=${encodeURIComponent(kase.id)}`}>
              {T.context.openCase} →
            </Link>
          </div>
        )}

        {(requirements.length > 0 || screens.length > 0) && (
          <div className={`tasks-req-grid${requirements.length && screens.length ? ' two' : ''}`}>
            {requirements.length > 0 && (
              <div className="tasks-ctx-block">
                <h3 className="tasks-label">{T.context.requirements}</h3>
                {requirements.map((view) => (
                  <RequirementBlock key={view.blockId} view={view} />
                ))}
              </div>
            )}
            {screens.length > 0 && (
              <div className="tasks-ctx-block">
                <h3 className="tasks-label">{T.context.screens}</h3>
                {screens.map((view) => (
                  <RequirementBlock key={view.blockId} view={view} />
                ))}
              </div>
            )}
          </div>
        )}

        {kase && (
          <div className="tasks-ctx-block">
            <h3 className="tasks-label">{T.context.tests}</h3>
            <TestsList tests={tests} />
          </div>
        )}

        {module && (
          <div className="tasks-ctx-block">
            <h3 className="tasks-label">{T.context.module}</h3>
            <p className="text-sm">{module.path || module.name}</p>
            {module.paths.length > 0 && (
              <p className="text-xs">
                <span className="muted">{T.context.paths}: </span>
                {module.paths.map((path) => (
                  <code key={path} className="tasks-code">
                    {path}
                  </code>
                ))}
              </p>
            )}
          </div>
        )}
      </div>
    </section>
  );
}
