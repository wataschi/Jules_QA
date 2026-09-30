/**
 * Каркас: бокова навігація (до 900 px — висувна шухляда з кнопкою-гамбургером),
 * шапка з вибором проєкту, перемикачем теми й довідкою по клавішах.
 */

import { useCallback, useEffect, useState } from 'react';
import { NavLink, Outlet, useLocation } from 'react-router-dom';
import { api, isMock } from '../api';
import { useApp } from '../context/AppContext';
import { usePolling } from '../hooks/useAsync';
import { useKeyMap } from '../hooks/useKeyboard';
import { S } from '../strings';
import KeyboardHelp from './KeyboardHelp';
import { Empty, ErrorState, Loading } from './states';
import Toasts from './Toasts';

/**
 * Навігація згрупована за етапами роботи, а не плоским списком: людина одразу
 * бачить, що «Реєстр → Погодження → Прогони» — це один цикл, а не три
 * незалежні екрани. Підказка `hint` пояснює призначення розділу на наведення.
 */
const NAV_GROUPS = [
  {
    label: S.nav.groupOverview,
    items: [{ to: '/', label: S.nav.dashboard, glyph: '▣', end: true, hint: S.nav.hintDashboard }],
  },
  {
    label: S.nav.groupCycle,
    items: [
      { to: '/cases', label: S.nav.cases, glyph: '▤', end: false, hint: S.nav.hintCases },
      { to: '/proposals', label: S.nav.proposals, glyph: '✓', end: false, badge: true, hint: S.nav.hintProposals },
      { to: '/runs', label: S.nav.runs, glyph: '▶', end: false, hint: S.nav.hintRuns },
      { to: '/defects', label: S.nav.defects, glyph: '⚠', end: false, hint: S.nav.hintDefects },
    ],
  },
  {
    label: S.nav.groupAnalysis,
    items: [{ to: '/coverage', label: S.nav.coverage, glyph: '◈', end: false, hint: S.nav.hintCoverage }],
  },
  {
    label: S.nav.groupSystem,
    items: [{ to: '/settings', label: S.nav.settings, glyph: '⚙', end: false, hint: S.nav.hintSettings }],
  },
] as const;

export default function AppShell() {
  const {
    projectId,
    projects,
    project,
    setProjectId,
    theme,
    toggleTheme,
    projectsLoading,
    projectsError,
    reloadProjects,
  } = useApp();
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [pending, setPending] = useState(0);
  const location = useLocation();

  // Шухляда закривається при переході — інакше лишається поверх нового екрана.
  useEffect(() => setDrawerOpen(false), [location.pathname]);

  // Лічильник черги апрувів. Помилку глушимо: бекенд може бути ще не готовий.
  usePolling(
    async (signal) => {
      if (!projectId) return;
      try {
        const page = await api.listProposals({ projectId, state: 'pending', limit: 1 }, signal);
        setPending(page.total);
      } catch {
        setPending(0);
      }
    },
    30_000,
    { enabled: Boolean(projectId), immediate: true },
  );

  const closeAll = useCallback(() => {
    setHelpOpen(false);
    setDrawerOpen(false);
  }, []);

  useKeyMap({
    '?': () => setHelpOpen(true),
    Escape: closeAll,
  });

  const themeLabel = theme === 'dark' ? S.common.themeLight : S.common.themeDark;

  return (
    <div className="shell">
      {drawerOpen && (
        <button type="button" className="scrim" aria-label={S.nav.close} onClick={() => setDrawerOpen(false)} />
      )}

      <aside
        id="main-nav"
        className={`shell-nav${drawerOpen ? ' open' : ''}`}
        aria-label={S.nav.aria}
      >
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            J
          </span>
          <div>
            <div className="brand-name">{S.app.name}</div>
            <div className="brand-sub">{S.app.sub}</div>
          </div>
        </div>

        <nav className="nav-list">
          {NAV_GROUPS.map((group) => (
            <div className="nav-group" key={group.label}>
              <span className="nav-group-label">{group.label}</span>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  title={item.hint}
                  className={({ isActive }) => `nav-link${isActive ? ' active' : ''}`}
                >
                  <span className="nav-glyph" aria-hidden="true">
                    {item.glyph}
                  </span>
                  {item.label}
                  {'badge' in item && item.badge && pending > 0 && (
                    <span className="nav-count" aria-label={`${S.dashboard.proposalsPending}: ${pending}`}>
                      {pending}
                    </span>
                  )}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="nav-foot">
          {isMock && <span className="mock-banner">{S.common.mockMode}</span>}
          <span>{S.keys.hintOpen}</span>
        </div>
      </aside>

      <div className="shell-main">
        <header className="shell-header">
          <button
            type="button"
            className="btn btn-ghost btn-icon burger"
            aria-label={S.nav.open}
            aria-expanded={drawerOpen}
            aria-controls="main-nav"
            onClick={() => setDrawerOpen((open) => !open)}
          >
            <span aria-hidden="true">☰</span>
          </button>

          {/*
            Перемикач показуємо лише тоді, коли є з чого вибирати. З одним
            проєктом випадний список — мертвий елемент керування: виглядає
            інтерактивним, але жодної дії за ним немає. Тоді це просто підпис,
            хто ми зараз, і місце в шапці лишається під справжні дії.
          */}
          {projects.length > 1 ? (
            <div className="field" style={{ maxWidth: 260 }}>
              <label htmlFor="project-picker" className="visually-hidden">
                {S.common.project}
              </label>
              <select
                id="project-picker"
                value={projectId}
                onChange={(event) => setProjectId(event.target.value)}
              >
                {projects.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span className="header-project" title={S.common.project}>
              {project?.name ?? S.common.loading}
            </span>
          )}

          {project?.key && <span className="chip mono accent">{project.key}</span>}

          <span className="spacer" />

          <button
            type="button"
            className="btn btn-ghost btn-sm"
            onClick={() => setHelpOpen(true)}
            aria-label={S.common.keyboardHelp}
            title={S.common.keyboardHelp}
          >
            <span aria-hidden="true">⌨</span>
          </button>
          <button type="button" className="btn btn-sm" onClick={toggleTheme} aria-label={themeLabel} title={themeLabel}>
            <span aria-hidden="true">{theme === 'dark' ? '☀' : '☾'}</span>
          </button>
        </header>

        <main className="shell-content">
          {/*
            Без проєкту жоден екран не має сенсу: якщо `/api/registry/projects`
            відповів помилкою (бекенд ще пишеться) — показуємо ErrorState із
            «Спробувати ще», а не вічні скелетони на кожній сторінці.
          */}
          {projectsLoading && projects.length === 0 ? (
            <Loading rows={6} />
          ) : projectsError && projects.length === 0 ? (
            <ErrorState message={projectsError} onRetry={reloadProjects} />
          ) : projects.length === 0 ? (
            <Empty title={S.settings.projectSection} hint={S.empty.treeHint} />
          ) : (
            <Outlet />
          )}
        </main>
      </div>

      {helpOpen && <KeyboardHelp onClose={() => setHelpOpen(false)} />}
      <Toasts />
    </div>
  );
}
