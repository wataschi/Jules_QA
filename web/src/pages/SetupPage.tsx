/**
 * Майстер нового проєкту: Confluence → Figma → модулі → репозиторій і Jira → CI.
 * Поточний крок і вибраний корінь дерева живуть в адресі, тож на крок можна
 * повернутися кнопкою «назад» браузера або переслати посилання.
 */
import { useMemo } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { api } from '../api';
import { PageHead } from '../components/ui';
import { useApp } from '../context/AppContext';
import { useAsync } from '../hooks/useAsync';
import { useQueryParams } from '../hooks/useQueryParams';
import { CiStep, ConfluenceStep, FigmaStep, ModulesStep, RepoStep } from './inputs/SetupSteps';
import { SW } from './inputs/strings';
import '../styles/inputs.css';

const LAST = SW.steps.length;

export default function SetupPage() {
  const { projectId } = useApp();
  const params = useQueryParams();
  const location = useLocation();
  const navigate = useNavigate();
  const step = Math.min(Math.max(params.getNum('step', 1), 1), LAST);
  const rootId = params.get('root');

  const health = useAsync((signal) => api.getHealth(signal), []);
  const configured = health.data?.configured;

  // Корінь приходить після запиту: читаємо адресу заново, щоб не затерти крок, обраний за цей час.
  const setRoot = (id: string) => {
    const next = new URLSearchParams(window.location.search);
    next.set('root', id);
    navigate({ search: `?${next.toString()}` }, { replace: true });
  };

  const go = (next: number) => {
    params.set({ step: next === 1 ? null : next });
    window.scrollTo?.({ top: 0 });
  };

  const inputsSearch = useMemo(() => {
    const search = new URLSearchParams(location.search);
    search.delete('step');
    search.delete('root');
    const query = search.toString();
    return query ? `?${query}` : '';
  }, [location.search]);

  const current = SW.steps[step - 1];

  return (
    <>
      <PageHead title={SW.title} sub={SW.sub} />

      <nav aria-label={SW.stepsLabel}>
        <ol className="wizard-steps">
          {SW.steps.map((item, index) => {
            const n = index + 1;
            const state = n === step ? 'current' : n < step ? 'done' : 'todo';
            return (
              <li key={item.title} className={`wizard-step ${state}`}>
                <button type="button" aria-current={n === step ? 'step' : undefined} onClick={() => go(n)}>
                  <span className="wizard-num" aria-hidden="true">
                    {n < step ? '✓' : n}
                  </span>
                  <span className="wizard-label">
                    <span className="visually-hidden">{SW.step(n)}: </span>
                    {item.title}
                  </span>
                </button>
              </li>
            );
          })}
        </ol>
      </nav>

      <section className="card wizard-card" aria-labelledby="wizard-step-title">
        <div className="card-head">
          <span className="wizard-num big" aria-hidden="true">
            {step}
          </span>
          <h2 id="wizard-step-title">{current.title}</h2>
        </div>
        <div className="card-body">
          <p className="wizard-why">{current.why}</p>
          {step === 1 && (
            <ConfluenceStep
              projectId={projectId}
              configured={configured?.confluence}
              rootId={rootId}
              onRoot={setRoot}
            />
          )}
          {step === 2 && <FigmaStep projectId={projectId} configured={configured?.figma} />}
          {step === 3 && <ModulesStep projectId={projectId} rootId={rootId} />}
          {step === 4 && <RepoStep projectId={projectId} />}
          {step === 5 && <CiStep projectId={projectId} />}
        </div>
        <div className="wizard-foot">
          {step > 1 && (
            <button type="button" className="btn" onClick={() => go(step - 1)}>
              ← {SW.back}
            </button>
          )}
          <span className="spacer" />
          {step < LAST ? (
            <button type="button" className="btn btn-primary" onClick={() => go(step + 1)}>
              {SW.next} →
            </button>
          ) : (
            <Link className="btn btn-primary" to={{ pathname: '/inputs', search: inputsSearch }}>
              {SW.toInputs} →
            </Link>
          )}
        </div>
      </section>
    </>
  );
}
