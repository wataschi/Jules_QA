/**
 * «Попросити тест»: QA формулює намір, прив'язаний до кейса, блоку вимоги,
 * кадру, модуля чи файлу. Задача йде в чергу агентів розробників.
 */
import { useState } from 'react';
import { api } from '../api';
import { useToast } from '../context/AppContext';
import { messageOf } from '../hooks/useAsync';
import { S } from '../strings';
import { S2 } from '../strings-v2';
import type { CasePriority, Task, TaskAnchor, TaskKind } from '../types';
import { Dialog } from './Dialog';
import { SelectField, TextArea, TextField } from './ui';

const KINDS: TaskKind[] = ['add_test', 'change_test', 'remove_test', 'question'];

export function RequestTaskDialog({
  projectId,
  anchor,
  anchorLabel,
  defaultKind = 'add_test',
  defaultTitle = '',
  onClose,
  onCreated,
}: {
  projectId: string;
  anchor: TaskAnchor;
  /** Людський опис прив'язки: «Кейс CYBER-REG-014», «Кадр Створення акта». */
  anchorLabel: string;
  defaultKind?: TaskKind;
  defaultTitle?: string;
  onClose: () => void;
  onCreated?: (task: Task) => void;
}) {
  const toast = useToast();
  const [kind, setKind] = useState<TaskKind>(defaultKind);
  const [title, setTitle] = useState(defaultTitle);
  const [text, setText] = useState('');
  const [priority, setPriority] = useState<CasePriority>('P2');
  const [busy, setBusy] = useState(false);

  const submit = async () => {
    if (!title.trim() || busy) return;
    setBusy(true);
    try {
      const task = await api.createTask({ projectId, kind, title: title.trim(), text: text.trim(), anchor, priority });
      toast({ text: S2.request.sent, tone: 'good' });
      onCreated?.(task);
      onClose();
    } catch (error) {
      toast({ text: messageOf(error), tone: 'bad' });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      title={S2.request.title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className="btn" onClick={onClose}>
            {S.common.cancel}
          </button>
          <button type="button" className="btn btn-primary" disabled={!title.trim() || busy} onClick={submit}>
            {S2.request.send}
          </button>
        </>
      }
    >
      <p className="muted" data-testid="request-anchor">
        {S2.request.anchor}: {anchorLabel}
      </p>
      <SelectField
        label={S2.request.kind}
        value={kind}
        options={KINDS.map((value) => ({ value, label: S2.taskKind[value] }))}
        onChange={(value) => setKind(value as TaskKind)}
      />
      <TextField label={S2.request.what} value={title} onChange={setTitle} hint={S2.request.whatHint} />
      <TextArea label={S2.request.details} value={text} onChange={setText} hint={S2.request.detailsHint} rows={4} />
      <SelectField
        label={S2.request.priority}
        value={priority}
        options={(['P1', 'P2', 'P3', 'P4'] as CasePriority[]).map((value) => ({ value, label: value }))}
        onChange={(value) => setPriority(value as CasePriority)}
      />
    </Dialog>
  );
}
