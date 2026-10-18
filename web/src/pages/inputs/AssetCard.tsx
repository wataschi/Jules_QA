/**
 * Вкладення блоку: картинка, схема з витягнутим текстом або кадр. Для
 * прочитання, що чекає рішення, — текст агента і три дії QA.
 */
import { useState, type ReactNode } from 'react';
import { api } from '../../api';
import { Chip, TextArea } from '../../components/ui';
import { useToast } from '../../context/AppContext';
import { messageOf } from '../../hooks/useAsync';
import { S } from '../../strings';
import { S2 } from '../../strings-v2';
import type { Asset, ReadingState } from '../../types';
import type { AssetModel } from './model';
import { SI } from './strings';

const readingTone: Record<ReadingState, 'neutral' | 'good' | 'warn' | 'bad' | 'accent'> = {
  none: 'neutral',
  needed: 'warn',
  proposed: 'accent',
  approved: 'good',
  rejected: 'bad',
};

export function ReadingChip({ state }: { state: ReadingState }) {
  return <Chip tone={readingTone[state]}>{S2.readingState[state]}</Chip>;
}

export function AssetCard({
  asset,
  onDecided,
  extra,
}: {
  asset: AssetModel;
  onDecided: (asset: Asset) => void;
  /** Додаткові рядки під заголовком: джерело, посилання. */
  extra?: ReactNode;
}) {
  const showReading = asset.kind !== 'frame' && asset.readingState !== 'none';
  return (
    <article className="asset" data-testid={`asset-${asset.id}`} aria-label={SI.asset.image(asset.name)}>
      <header className="asset-head">
        <span className="asset-name">{asset.name}</span>
        <Chip>{SI.asset.kind[asset.kind]}</Chip>
        {asset.diagramType && <Chip mono>{asset.diagramType}</Chip>}
        {showReading && <ReadingChip state={asset.readingState} />}
      </header>
      {extra}

      {asset.imageUrl && (
        <div className="asset-image">
          <img src={asset.imageUrl} alt={SI.asset.image(asset.name)} loading="lazy" />
        </div>
      )}

      {asset.kind === 'diagram' && asset.text && (
        <div className="col asset-section">
          <span className="asset-label">{SI.asset.extracted}</span>
          <pre className="asset-pre">{asset.text}</pre>
        </div>
      )}

      {asset.error && (
        <p className="src-error" role="note">
          {SI.asset.error}: {asset.error}
        </p>
      )}

      {asset.readingState === 'needed' && <p className="muted text-sm">{SI.asset.needed}</p>}

      {asset.readingState === 'proposed' && <ReadingDecision asset={asset} onDecided={onDecided} />}

      {asset.readingState === 'approved' && asset.reading && (
        <div className="col asset-section">
          <span className="asset-label">{SI.asset.readingApproved}</span>
          <p className="pre-wrap asset-reading">{asset.reading}</p>
        </div>
      )}
    </article>
  );
}

function ReadingDecision({ asset, onDecided }: { asset: AssetModel; onDecided: (asset: Asset) => void }) {
  const toast = useToast();
  const [mode, setMode] = useState<'view' | 'edit' | 'reject'>('view');
  const [text, setText] = useState(asset.reading ?? '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);

  const decide = async (approve: boolean, reading?: string, rejectNote?: string) => {
    setBusy(true);
    try {
      const updated = await api.decideReading(asset.id, approve, reading, rejectNote);
      toast({ text: approve ? SI.asset.approved : SI.asset.rejected, tone: approve ? 'good' : 'info' });
      onDecided(updated);
    } catch (error) {
      toast({ text: messageOf(error), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="col asset-section reading-box">
      <span className="asset-label">
        {SI.asset.reading}
        {asset.readingBy && (
          <span className="muted">
            {' '}
            · {SI.asset.readingBy}: {asset.readingBy}
          </span>
        )}
      </span>

      {mode === 'edit' ? (
        <TextArea label={SI.asset.editLabel} value={text} onChange={setText} rows={5} />
      ) : (
        <p className="pre-wrap asset-reading">{asset.reading || S.common.none}</p>
      )}

      {mode === 'reject' && (
        <TextArea label={SI.asset.rejectNote} hint={SI.asset.rejectNoteHint} value={note} onChange={setNote} rows={3} />
      )}

      <div className="row-wrap">
        {mode === 'view' && (
          <>
            <button type="button" className="btn btn-primary btn-sm" disabled={busy} onClick={() => decide(true)}>
              {SI.asset.approve}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setMode('edit')}>
              {SI.asset.approveEdit}
            </button>
            <button type="button" className="btn btn-danger btn-sm" disabled={busy} onClick={() => setMode('reject')}>
              {SI.asset.reject}
            </button>
          </>
        )}
        {mode === 'edit' && (
          <>
            <button
              type="button"
              className="btn btn-primary btn-sm"
              disabled={busy || !text.trim()}
              onClick={() => decide(true, text.trim())}
            >
              {SI.asset.saveApprove}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setMode('view')}>
              {S.common.cancel}
            </button>
          </>
        )}
        {mode === 'reject' && (
          <>
            <button
              type="button"
              className="btn btn-danger btn-sm"
              disabled={busy}
              onClick={() => decide(false, undefined, note.trim() || undefined)}
            >
              {SI.asset.rejectConfirm}
            </button>
            <button type="button" className="btn btn-sm" disabled={busy} onClick={() => setMode('view')}>
              {S.common.cancel}
            </button>
          </>
        )}
      </div>
    </div>
  );
}
