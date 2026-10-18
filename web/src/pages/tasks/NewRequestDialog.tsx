/**
 * «Новий запит» з переліку задач: тут немає кейса чи кадру, до якого
 * прив'язати запит, тож спершу пропонуємо вибрати модуль (anchor.sectionId),
 * а далі — звичайний діалог «Запит агенту».
 */
import { useCallback, useMemo, useRef, useState } from 'react';
import { api } from '../../api';
import { Dialog } from '../../components/Dialog';
import { RequestTaskDialog } from '../../components/RequestTaskDialog';
import { SelectField } from '../../components/ui';
import { Loading } from '../../components/states';
import { useAsync } from '../../hooks/useAsync';
import { S } from '../../strings';
import type { SectionNode, Task } from '../../types';
import { T } from './strings';

export interface ModuleOption {
  id: string;
  label: string;
  name: string;
}

export function flattenSections(nodes: SectionNode[], depth = 0, out: ModuleOption[] = []): ModuleOption[] {
  for (const node of nodes) {
    out.push({ id: node.id, name: node.name, label: `${' '.repeat(depth)}${node.name}` });
    if (node.children?.length) flattenSections(node.children, depth + 1, out);
  }
  return out;
}

export function NewRequestDialog({
  projectId,
  defaultSectionId = '',
  onClose,
  onCreated,
}: {
  projectId: string;
  defaultSectionId?: string;
  onClose: () => void;
  onCreated: (task: Task) => void;
}) {
  const sections = useAsync((signal) => api.listSections(projectId, signal), [projectId], Boolean(projectId));
  const options = useMemo(() => flattenSections(sections.data ?? []), [sections.data]);
  const [sectionId, setSectionId] = useState(defaultSectionId);
  const [step, setStep] = useState<'module' | 'request'>('module');

  // Стабільне закриття: діалог переводить фокус при кожній зміні onClose,
  // а сторінка під ним перемальовується від опитування.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  const close = useCallback(() => onCloseRef.current(), []);
  const picked = options.find((option) => option.id === sectionId);

  if (step === 'request') {
    return (
      <RequestTaskDialog
        projectId={projectId}
        anchor={sectionId ? { sectionId } : {}}
        anchorLabel={picked ? T.pick.anchorModule(picked.name) : T.pick.anchorNone}
        onClose={close}
        onCreated={onCreated}
      />
    );
  }

  return (
    <Dialog
      title={T.pick.title}
      onClose={close}
      size="sm"
      footer={
        <>
          <button type="button" className="btn" onClick={close}>
            {S.common.cancel}
          </button>
          <button type="button" className="btn btn-primary" onClick={() => setStep('request')}>
            {T.pick.next} →
          </button>
        </>
      }
    >
      {sections.loading && !sections.data ? (
        <Loading rows={2} />
      ) : (
        <>
          {sections.error && (
            <p className="alert warn" role="status">
              {T.pick.loadError}
            </p>
          )}
          <SelectField
            label={T.pick.module}
            value={sectionId}
            onChange={setSectionId}
            allLabel={T.pick.noModule}
            options={options.map((option) => ({ value: option.id, label: option.label }))}
            hint={T.pick.moduleHint}
          />
        </>
      )}
    </Dialog>
  );
}
