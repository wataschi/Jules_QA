/** «Чекають прочитання»: картинки, з яких текст без моделі не дістати. */
import { Link, useLocation } from 'react-router-dom';
import { Async } from '../../components/states';
import type { AsyncState } from '../../hooks/useAsync';
import type { Asset } from '../../types';
import { AssetCard } from './AssetCard';
import { assetModel } from './model';
import { SI } from './strings';

const PENDING = new Set<Asset['readingState']>(['proposed', 'needed']);

export function pendingReadings(assets: Asset[] | undefined): Asset[] {
  return (assets ?? [])
    .filter((asset) => PENDING.has(asset.readingState))
    // Спершу ті, де вже є текст агента: їх можна погодити просто зараз.
    .sort((a, b) => Number(b.readingState === 'proposed') - Number(a.readingState === 'proposed') || b.updatedAt.localeCompare(a.updatedAt));
}

export function ReadingsList({
  state,
  sourceTitles,
  onDecided,
}: {
  state: AsyncState<Asset[]>;
  sourceTitles: Map<string, string>;
  onDecided: (asset: Asset) => void;
}) {
  const location = useLocation();
  const search = new URLSearchParams(location.search);
  search.delete('tab');
  const query = search.toString();

  return (
    <section className="card" aria-labelledby="readings-title">
      <div className="card-head">
        <h2 id="readings-title">{SI.readings.title}</h2>
      </div>
      <div className="card-body">
        <p className="muted text-sm">{SI.readings.hint}</p>
        <Async
          state={{ ...state, data: state.data ? pendingReadings(state.data) : undefined }}
          empty={{ title: SI.readings.empty, hint: SI.readings.emptyHint }}
        >
          {(items) => (
            <div className="readings-grid">
              {items.map((asset) => {
                const model = assetModel(undefined, asset);
                if (!model) return null;
                const title = asset.sourceId ? sourceTitles.get(asset.sourceId) ?? asset.sourceId : undefined;
                return (
                  <AssetCard
                    key={asset.id}
                    asset={model}
                    onDecided={onDecided}
                    extra={
                      asset.sourceId && (
                        <p className="text-xs muted">
                          {SI.asset.source}:{' '}
                          <Link to={{ pathname: `/inputs/${encodeURIComponent(asset.sourceId)}`, search: query ? `?${query}` : '' }}>
                            {title}
                          </Link>
                        </p>
                      )
                    }
                  />
                );
              })}
            </div>
          )}
        </Async>
      </div>
    </section>
  );
}
