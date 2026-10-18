/**
 * Дерево джерел: сторінки Confluence за батьками й файли Figma. На кожному
 * вузлі — галочка «брати», перемикач «не віддавати агентам», модуль,
 * лічильники блоків і прогалин, час і помилка останньої перевірки.
 */
import { useState } from 'react';
import type { SourceNode } from '../../types';
import { formatAgo, formatDateTime } from '../../utils/format';
import { SI } from './strings';

export type SourceFlags = { included?: boolean; noAgents?: boolean };

export function SourceTree({
  nodes,
  selectedId,
  onSelect,
  onFlags,
  sections,
  label = SI.tree.title,
}: {
  nodes: SourceNode[];
  selectedId?: string;
  onSelect?: (node: SourceNode) => void;
  onFlags: (node: SourceNode, flags: SourceFlags) => void;
  sections: Map<string, string>;
  label?: string;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderList = (list: SourceNode[], level: number) => (
    <ul className={level === 0 ? 'src-tree' : 'src-tree-children'} aria-label={level === 0 ? label : undefined}>
      {list.map((node) => {
        const hasChildren = node.children?.length > 0;
        const open = !collapsed.has(node.id);
        return (
          <li key={node.id}>
            <SourceRow
              node={node}
              selected={node.id === selectedId}
              hasChildren={hasChildren}
              open={open}
              onToggle={() => toggle(node.id)}
              onSelect={onSelect}
              onFlags={onFlags}
              sectionName={node.sectionId ? sections.get(node.sectionId) ?? node.sectionId : undefined}
            />
            {hasChildren && open && renderList(node.children, level + 1)}
          </li>
        );
      })}
    </ul>
  );

  return renderList(nodes, 0);
}

function SourceRow({
  node,
  selected,
  hasChildren,
  open,
  onToggle,
  onSelect,
  onFlags,
  sectionName,
}: {
  node: SourceNode;
  selected: boolean;
  hasChildren: boolean;
  open: boolean;
  onToggle: () => void;
  onSelect?: (node: SourceNode) => void;
  onFlags: (node: SourceNode, flags: SourceFlags) => void;
  sectionName?: string;
}) {
  const glyph = node.kind === 'figma' ? '◇' : '▤';
  const title = (
    <>
      <span className="src-kind" aria-hidden="true" title={SI.kind[node.kind]}>
        {glyph}
      </span>
      <span className="src-title">{node.title}</span>
    </>
  );

  return (
    <div
      className={`src-row${selected ? ' active' : ''}${node.included ? '' : ' excluded'}`}
      data-testid={`source-${node.id}`}
    >
      <div className="src-line">
        {hasChildren ? (
          <button
            type="button"
            className="tree-toggle"
            aria-expanded={open}
            aria-label={open ? SI.tree.collapse(node.title) : SI.tree.expand(node.title)}
            onClick={onToggle}
          >
            <span aria-hidden="true">{open ? '▾' : '▸'}</span>
          </button>
        ) : (
          <span className="tree-toggle" aria-hidden="true" />
        )}
        <input
          type="checkbox"
          checked={node.included}
          aria-label={SI.tree.include(node.title)}
          onChange={(event) => onFlags(node, { included: event.target.checked })}
        />
        {onSelect ? (
          <button
            type="button"
            className="src-name"
            aria-current={selected ? 'page' : undefined}
            onClick={() => onSelect(node)}
          >
            {title}
          </button>
        ) : (
          <span className="src-name static">{title}</span>
        )}
      </div>

      <div className="src-meta">
        {sectionName ? (
          <span className="src-module" title={SI.view.module}>
            {sectionName}
          </span>
        ) : (
          node.kind === 'confluence' && <span className="muted">{SI.tree.noModule}</span>
        )}
        {!node.included && <span className="src-excluded">{SI.tree.excluded}</span>}
        <span>{SI.tree.blocks(node.blockCount)}</span>
        {node.gaps > 0 && (
          <span className="src-gaps" title={SI.tree.gapsHint}>
            {SI.tree.gaps(node.gaps)}
          </span>
        )}
        <span className="muted" title={node.checkedAt ? formatDateTime(node.checkedAt) : undefined}>
          {node.checkedAt ? `${SI.tree.checked} ${formatAgo(node.checkedAt)}` : SI.tree.notChecked}
        </span>
        <span className="spacer" />
        <button
          type="button"
          role="switch"
          aria-checked={node.noAgents}
          aria-label={SI.tree.noAgentsFor(node.title)}
          className={`src-switch${node.noAgents ? ' on' : ''}`}
          onClick={() => onFlags(node, { noAgents: !node.noAgents })}
        >
          <span className="src-switch-track" aria-hidden="true">
            <span className="src-switch-thumb" />
          </span>
          <span className="src-switch-label">{SI.tree.noAgents}</span>
        </button>
      </div>

      {node.lastError && (
        <p className="src-error" role="note">
          {node.lastError}
        </p>
      )}
    </div>
  );
}
