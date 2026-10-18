/**
 * Блок вимоги: заголовок, текст, стан змін, вкладення і пов’язані кадри
 * Figma поруч. Для джерела Figma блок — це кадр із полем маршруту.
 */
import { useState } from 'react';
import { api } from '../../api';
import { Chip, TextField } from '../../components/ui';
import { useToast } from '../../context/AppContext';
import { messageOf } from '../../hooks/useAsync';
import type { Asset, RequirementView } from '../../types';
import { AssetCard } from './AssetCard';
import { assetModel } from './model';
import { SI } from './strings';

export type RequestTarget = { blockId: string; label: string; title?: string };

export function ChangeChip({ state }: { state: RequirementView['changeState'] }) {
  if (state === 'changed') return <Chip tone="warn" title={SI.changeHint.changed}>{SI.change.changed}</Chip>;
  if (state === 'new') return <Chip tone="accent" title={SI.changeHint.new}>{SI.change.new}</Chip>;
  if (state === 'removed') return <Chip tone="bad">{SI.change.removed}</Chip>;
  return null;
}

export function BlockCard({
  block,
  frames,
  framesLoading,
  assets,
  onDecided,
  onRequest,
}: {
  block: RequirementView;
  /** Пов’язані кадри Figma (block.screens), уже завантажені. */
  frames: RequirementView[];
  framesLoading: boolean;
  assets: Map<string, Asset>;
  onDecided: (asset: Asset) => void;
  onRequest: (target: RequestTarget) => void;
}) {
  if (block.sourceKind === 'figma') {
    return <FrameCard frame={block} assets={assets} onDecided={onDecided} onRequest={onRequest} withRoute />;
  }

  const blockAssets = block.assets
    .map((view) => assetModel(view, assets.get(view.id)))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const hasFrames = block.screens.length > 0;

  return (
    <article
      className={`blk card change-${block.changeState}${hasFrames ? ' with-frames' : ''}`}
      data-testid={`block-${block.blockId}`}
      aria-labelledby={`h-${block.blockId}`}
    >
      <header className="card-head blk-head">
        <h3 id={`h-${block.blockId}`}>{block.heading || SI.view.noBlocks}</h3>
        <ChangeChip state={block.changeState} />
        {block.withheld && <Chip tone="warn">{SI.view.withheld}</Chip>}
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onRequest({ blockId: block.blockId, label: block.heading })}
        >
          {SI.block.request}
        </button>
      </header>
      <div className="blk-body">
        <div className="col blk-main">
          {block.text && <p className="pre-wrap blk-text">{block.text}</p>}
          {blockAssets.length > 0 && (
            <div className="col">
              <h4 className="blk-sub">{SI.block.assets}</h4>
              {blockAssets.map((asset) => (
                <AssetCard key={asset.id} asset={asset} onDecided={onDecided} />
              ))}
            </div>
          )}
        </div>
        {hasFrames && (
          <aside className="col blk-frames" aria-label={SI.block.frames}>
            <h4 className="blk-sub">{SI.block.frames}</h4>
            {framesLoading && frames.length === 0 && <p className="muted text-sm">{SI.block.framesLoading}</p>}
            {frames.map((frame) => (
              <FrameCard key={frame.blockId} frame={frame} assets={assets} onDecided={onDecided} onRequest={onRequest} compact />
            ))}
          </aside>
        )}
      </div>
    </article>
  );
}

function FrameCard({
  frame,
  assets,
  onDecided,
  onRequest,
  withRoute = false,
  compact = false,
}: {
  frame: RequirementView;
  assets: Map<string, Asset>;
  onDecided: (asset: Asset) => void;
  onRequest: (target: RequestTarget) => void;
  withRoute?: boolean;
  compact?: boolean;
}) {
  const frameAssets = frame.assets
    .map((view) => assetModel(view, assets.get(view.id)))
    .filter((item): item is NonNullable<typeof item> => item !== null);
  const shot = frameAssets.find((asset) => asset.kind === 'frame');
  const others = frameAssets.filter((asset) => asset !== shot);
  const title = frame.heading.split(' / ').pop() || frame.heading;

  return (
    <article
      className={`frame${compact ? ' compact' : ' card'} change-${frame.changeState}`}
      data-testid={`frame-${frame.blockId}`}
      aria-label={SI.block.frameLabel(title)}
    >
      <header className={compact ? 'frame-head' : 'card-head frame-head'}>
        {compact ? <h5 className="frame-title">{title}</h5> : <h3 className="frame-title">{frame.heading}</h3>}
        <ChangeChip state={frame.changeState} />
        {frame.nodeId && <span className="mono text-xs muted">{frame.nodeId}</span>}
        <span className="spacer" />
        <button
          type="button"
          className="btn btn-sm"
          onClick={() => onRequest({ blockId: frame.blockId, label: SI.block.frameLabel(title) })}
        >
          {SI.block.request}
        </button>
      </header>
      <div className={compact ? 'frame-body' : 'frame-body card-body'}>
        {shot?.imageUrl && (
          <div className="asset-image frame-shot">
            <img src={shot.imageUrl} alt={SI.block.frameLabel(title)} loading="lazy" />
          </div>
        )}
        <div className="col frame-texts">
          <span className="asset-label">{SI.block.texts}</span>
          <p className="pre-wrap blk-text">{frame.text || shot?.text}</p>
          {frame.route && !withRoute && (
            <span className="text-xs muted">
              {SI.block.route}: <span className="mono">{frame.route}</span>
            </span>
          )}
          {withRoute && <RouteField blockId={frame.blockId} initial={frame.route ?? ''} />}
        </div>
        {others.map((asset) => (
          <AssetCard key={asset.id} asset={asset} onDecided={onDecided} />
        ))}
      </div>
    </article>
  );
}

function RouteField({ blockId, initial }: { blockId: string; initial: string }) {
  const toast = useToast();
  const [value, setValue] = useState(initial);
  const [saved, setSaved] = useState(initial);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setBusy(true);
    try {
      const next = value.trim();
      await api.setBlockRoute(blockId, next || null);
      setSaved(next);
      toast({ text: SI.block.routeSaved, tone: 'good' });
    } catch (error) {
      toast({ text: messageOf(error), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      className="route-form"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <TextField label={SI.block.route} hint={SI.block.routeHint} value={value} onChange={setValue} placeholder="/acts/new" mono />
      <button type="submit" className="btn btn-sm" disabled={busy || value.trim() === saved}>
        {SI.block.routeSave}
      </button>
    </form>
  );
}
