/**
 * Вкладка «Модулі»: для кожної секції — glob-и шляхів коду і власники.
 * За шляхами Jules відносить тести й зміни до модуля, за власниками —
 * маршрутизує задачі агентам. Порожні власники — беремо з CODEOWNERS репо.
 *
 * Поля `paths` / `owners` сервер віддає разом із секцією (`src/registry/types.ts`),
 * у фронтовому типі `Section` їх поки немає — читаємо обережно.
 */

import { useEffect, useMemo, useState } from 'react';
import { api } from '../../api';
import { Async } from '../../components/states';
import { Chip } from '../../components/ui';
import { useApp, useToast } from '../../context/AppContext';
import { messageOf, useAsync } from '../../hooks/useAsync';
import type { SectionNode } from '../../types';
import { linesToArray, parseTags } from '../../utils/format';
import { SS } from './strings';

interface ModuleRow {
  id: string;
  name: string;
  path: string;
  depth: number;
  paths: string[];
  owners: string[];
}

type WithCode = SectionNode & { paths?: string[]; owners?: string[] };

function flatten(nodes: SectionNode[], depth = 0, out: ModuleRow[] = []): ModuleRow[] {
  for (const node of nodes) {
    const extra = node as WithCode;
    out.push({
      id: node.id,
      name: node.name,
      path: node.path,
      depth,
      paths: Array.isArray(extra.paths) ? extra.paths : [],
      owners: Array.isArray(extra.owners) ? extra.owners : [],
    });
    flatten(node.children ?? [], depth + 1, out);
  }
  return out;
}

export function ModulesTab() {
  const { projectId } = useApp();
  const state = useAsync((signal) => api.listSections(projectId, signal), [projectId], Boolean(projectId));
  /** Збережене в цій вкладці: показуємо одразу, не чекаючи перезавантаження дерева. */
  const [savedRows, setSavedRows] = useState<Record<string, Pick<ModuleRow, 'paths' | 'owners'>>>({});
  const rows = useMemo(
    () => (state.data ? flatten(state.data).map((row) => ({ ...row, ...(savedRows[row.id] ?? {}) })) : undefined),
    [state.data, savedRows],
  );

  return (
    <section className="card">
      <div className="card-head">
        <h2>{SS.modules}</h2>
        <span className="muted text-xs">{SS.modulesSub}</span>
      </div>
      <div className="card-body">
        <p className="muted text-sm">{SS.modulesHint}</p>
      </div>
      <Async
        state={{ ...state, data: rows }}
        skeletonRows={5}
        empty={{ title: SS.modulesEmpty, hint: SS.modulesEmptyHint }}
      >
        {(items) => (
          <ul className="module-list">
            {items.map((row) => (
              <ModuleEditor
                key={row.id}
                row={row}
                onSaved={(next) => setSavedRows((current) => ({ ...current, [row.id]: next }))}
              />
            ))}
          </ul>
        )}
      </Async>
    </section>
  );
}

function ModuleEditor({ row, onSaved }: { row: ModuleRow; onSaved: (next: Pick<ModuleRow, 'paths' | 'owners'>) => void }) {
  const toast = useToast();
  const [paths, setPaths] = useState(row.paths.join('\n'));
  const [owners, setOwners] = useState(row.owners.join(', '));
  const [busy, setBusy] = useState(false);

  // Залежність — рядки, а не масиви: інакше збереження сусіднього модуля
  // скидало б незбережені правки в цьому.
  const savedPaths = row.paths.join('\n');
  const savedOwners = row.owners.join(', ');
  useEffect(() => {
    setPaths(savedPaths);
    setOwners(savedOwners);
  }, [savedPaths, savedOwners]);

  const nextPaths = linesToArray(paths);
  const nextOwners = parseTags(owners);
  const dirty = nextPaths.join('\n') !== row.paths.join('\n') || nextOwners.join(',') !== row.owners.join(',');

  async function save() {
    setBusy(true);
    try {
      await api.patchSection(row.id, { paths: nextPaths, owners: nextOwners });
      onSaved({ paths: nextPaths, owners: nextOwners });
      toast({ text: SS.moduleSaved(row.name), tone: 'good' });
    } catch (cause) {
      toast({ text: messageOf(cause), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  }

  const pathsId = `mod-paths-${row.id}`;
  const ownersId = `mod-owners-${row.id}`;

  return (
    <li className="module-item" style={{ ['--depth' as string]: row.depth }}>
      <div className="module-name">
        <strong>{row.name}</strong>
        {row.depth > 0 && <span className="muted text-xs truncate">{row.path}</span>}
        <span className="row-wrap">
          {row.paths.length === 0 ? (
            <Chip tone="warn">{SS.noPaths}</Chip>
          ) : (
            <Chip tone="neutral" mono>
              {row.paths.length}
            </Chip>
          )}
          {row.owners.length === 0 && <Chip tone="neutral">{SS.fromCodeowners}</Chip>}
        </span>
      </div>
      <div className="field">
        <label htmlFor={pathsId} className="module-label">
          {SS.paths}
        </label>
        <textarea
          id={pathsId}
          className="input-mono"
          rows={Math.min(5, Math.max(2, nextPaths.length + 1))}
          value={paths}
          placeholder={SS.pathsPlaceholder}
          aria-label={SS.pathsFor(row.name)}
          onChange={(event) => setPaths(event.target.value)}
        />
      </div>
      <div className="field">
        <label htmlFor={ownersId} className="module-label">
          {SS.owners}
        </label>
        <input
          id={ownersId}
          type="text"
          className="input-mono"
          value={owners}
          placeholder={SS.ownersPlaceholder}
          aria-label={SS.ownersFor(row.name)}
          onChange={(event) => setOwners(event.target.value)}
        />
      </div>
      <div className="module-actions">
        <button
          type="button"
          className="btn btn-sm btn-primary"
          disabled={busy || !dirty}
          onClick={save}
          aria-label={SS.moduleSaveLabel(row.name)}
        >
          {SS.moduleSave}
        </button>
      </div>
    </li>
  );
}
