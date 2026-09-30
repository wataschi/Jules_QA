/** Дерево секцій із лічильниками кейсів. Вибір секції — у query-параметрі. */

import { useState } from 'react';
import { S } from '../../strings';
import type { SectionNode } from '../../types';

export default function SectionTree({
  tree,
  activeId,
  totalCases,
  onPick,
}: {
  tree: SectionNode[];
  activeId: string;
  totalCases: number;
  onPick: (sectionId: string) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());

  const toggle = (id: string) =>
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const renderNode = (node: SectionNode, depth: number) => {
    const hasChildren = node.children.length > 0;
    const isCollapsed = collapsed.has(node.id);
    return (
      <div key={node.id}>
        <div className="tree-row" style={{ paddingLeft: depth * 12 }}>
          {hasChildren ? (
            <button
              type="button"
              className="tree-toggle"
              onClick={() => toggle(node.id)}
              aria-expanded={!isCollapsed}
              aria-label={isCollapsed ? S.common.expand : S.common.collapse}
            >
              <span aria-hidden="true">{isCollapsed ? '▸' : '▾'}</span>
            </button>
          ) : (
            <span className="tree-toggle" aria-hidden="true" />
          )}
          <button
            type="button"
            className={`tree-btn${activeId === node.id ? ' active' : ''}`}
            onClick={() => onPick(node.id)}
            aria-current={activeId === node.id ? 'true' : undefined}
            title={node.path}
          >
            <span className="tree-name">{node.name}</span>
            <span className="tree-count">{node.caseCountDeep}</span>
          </button>
        </div>
        {hasChildren && !isCollapsed && node.children.map((child) => renderNode(child, depth + 1))}
      </div>
    );
  };

  return (
    <div className="tree">
      <div className="tree-row">
        <span className="tree-toggle" aria-hidden="true" />
        <button
          type="button"
          className={`tree-btn${activeId === '' ? ' active' : ''}`}
          onClick={() => onPick('')}
          aria-current={activeId === '' ? 'true' : undefined}
        >
          <span className="tree-name">{S.cases.treeAll}</span>
          <span className="tree-count">{totalCases}</span>
        </button>
      </div>
      {tree.map((node) => renderNode(node, 0))}
    </div>
  );
}
