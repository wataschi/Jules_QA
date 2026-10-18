/**
 * Мінімальний показ markdown тижневого звіту: заголовки, списки, таблиці,
 * абзаци, **жирний** і `код`. Без innerHTML — лише React-елементи, тож текст
 * зі звіту ніколи не стає розміткою.
 */

import type { ReactNode } from 'react';

function inline(text: string): ReactNode[] {
  const parts = text.split(/(\*\*[^*]+\*\*|`[^`]+`)/g).filter(Boolean);
  return parts.map((part, index) => {
    if (part.startsWith('**') && part.endsWith('**')) return <strong key={index}>{part.slice(2, -2)}</strong>;
    if (part.startsWith('`') && part.endsWith('`')) return <code key={index} className="mono">{part.slice(1, -1)}</code>;
    return part;
  });
}

const cells = (line: string) =>
  line
    .trim()
    .replace(/^\|/, '')
    .replace(/\|$/, '')
    .split('|')
    .map((cell) => cell.trim());

export function Markdown({ source }: { source: string }) {
  const lines = source.replace(/\r\n/g, '\n').split('\n');
  const out: ReactNode[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed) {
      i += 1;
      continue;
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(trimmed);
    if (heading) {
      const Tag = heading[1].length <= 2 ? 'h3' : 'h4';
      out.push(<Tag key={i}>{inline(heading[2])}</Tag>);
      i += 1;
      continue;
    }
    if (/^[-*]\s+/.test(trimmed)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(lines[i].trim().replace(/^[-*]\s+/, ''));
        i += 1;
      }
      out.push(
        <ul key={i}>
          {items.map((item, index) => (
            <li key={index}>{inline(item)}</li>
          ))}
        </ul>,
      );
      continue;
    }
    if (trimmed.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith('|')) {
        const row = lines[i].trim();
        if (!/^\|?[\s:|-]+\|?$/.test(row)) rows.push(cells(row));
        i += 1;
      }
      const [head, ...body] = rows;
      out.push(
        <div className="table-wrap" key={i}>
          <table className="tbl tbl-narrow">
            {head && (
              <thead>
                <tr>
                  {head.map((cell, index) => (
                    <th scope="col" key={index}>
                      {inline(cell)}
                    </th>
                  ))}
                </tr>
              </thead>
            )}
            <tbody>
              {body.map((row, rowIndex) => (
                <tr key={rowIndex}>
                  {row.map((cell, index) => (
                    <td key={index}>{inline(cell)}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }
    const paragraph: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|[-*]\s|\|)/.test(lines[i].trim())) {
      paragraph.push(lines[i].trim());
      i += 1;
    }
    out.push(<p key={i}>{inline(paragraph.join(' '))}</p>);
  }
  return <div className="md">{out}</div>;
}
