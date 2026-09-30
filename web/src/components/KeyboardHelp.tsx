/** Довідка по клавішах — відкривається по `?` з будь-якого екрана. */

import { Dialog } from './Dialog';
import { S } from '../strings';

const ROWS: Array<[string, string]> = [
  ['/', S.keys.slash],
  ['j / k', S.keys.jk],
  ['Space', S.keys.space],
  ['Enter', S.keys.enter],
  ['1 2 3 4', S.keys.digits],
  ['Esc', S.keys.esc],
  ['?', S.keys.question],
];

export default function KeyboardHelp({ onClose }: { onClose: () => void }) {
  return (
    <Dialog title={S.keys.title} onClose={onClose} size="sm">
      <table className="keys-table">
        <tbody>
          {ROWS.map(([keys, description]) => (
            <tr key={keys}>
              <td>
                {keys.split(' ').map((key) => (
                  <kbd key={key} style={{ marginRight: 4 }}>
                    {key}
                  </kbd>
                ))}
              </td>
              <td>{description}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </Dialog>
  );
}
