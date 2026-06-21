import { NavLink, Outlet } from 'react-router-dom';
import { useLlm } from '../context/AppContext';

const NAV = [
  { to: '/', label: 'Огляд', icon: '◉' },
  { to: '/launch', label: 'Запуск тестів', icon: '▶' },
  { to: '/runs', label: 'Прогони', icon: '☰' },
  { to: '/scenarios', label: 'Сценарії', icon: '☷' },
  { to: '/suites', label: 'Набори', icon: '⊞' },
  { to: '/ai-lab', label: 'AI Лабораторія', icon: '✦' },
  { to: '/reports', label: 'Звіти', icon: '▤' },
  { to: '/settings', label: 'Налаштування', icon: '⚙' },
];

export default function AppShell() {
  const llm = useLlm();

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar-brand">
          <span className="brand-mark">J</span>
          <div>
            <strong>Jules AI QA</strong>
            <small>Autonomous QA Platform</small>
          </div>
        </div>

        <nav className="sidebar-nav">
          {NAV.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              end={item.to === '/'}
              className={({ isActive }) => `sidebar-link ${isActive ? 'active' : ''}`}
            >
              <span className="sidebar-icon">{item.icon}</span>
              {item.label}
            </NavLink>
          ))}
        </nav>

        <div className="sidebar-footer">
          <div className={`llm-pill ${llm.checking ? 'checking' : llm.ok ? 'ok' : 'err'}`}>
            <span className="llm-dot" />
            {llm.checking ? 'Перевірка AI…' : llm.ok ? 'AI підключено' : 'AI недоступно'}
          </div>
          {llm.ok && llm.models[0] && (
            <small className="llm-model">{llm.models[0]}</small>
          )}
        </div>
      </aside>

      <div className="main-area">
        <header className="topbar">
          <div className="topbar-title">
            <h1>QA Command Center</h1>
            <p>AI-кероване тестування, сценарії та звіти в одному місці</p>
          </div>
          <div className="topbar-actions">
            <NavLink to="/launch" className="btn btn-primary btn-sm">+ Новий прогін</NavLink>
            <NavLink to="/ai-lab" className="btn btn-ghost btn-sm">AI: написати тест</NavLink>
          </div>
        </header>
        <main className="page-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
