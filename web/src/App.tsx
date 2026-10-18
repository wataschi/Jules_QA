import { Navigate, Route, Routes } from 'react-router-dom';
import AppShell from './components/AppShell';
import CasesPage from './pages/CasesPage';
import CoveragePage from './pages/CoveragePage';
import DashboardPage from './pages/DashboardPage';
import DefectsPage from './pages/DefectsPage';
import NotFoundPage from './pages/NotFoundPage';
import ProposalsPage from './pages/ProposalsPage';
import RunDetailPage from './pages/RunDetailPage';
import RunsPage from './pages/RunsPage';
import SettingsPage from './pages/SettingsPage';
import TasksPage from './pages/TasksPage';
import TaskDetailPage from './pages/TaskDetailPage';
import InputsPage from './pages/InputsPage';
import SetupPage from './pages/SetupPage';

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route index element={<DashboardPage />} />
        <Route path="inputs" element={<InputsPage />} />
        <Route path="inputs/:sourceId" element={<InputsPage />} />
        <Route path="setup" element={<SetupPage />} />
        <Route path="cases" element={<CasesPage />} />
        <Route path="tasks" element={<TasksPage />} />
        <Route path="tasks/:id" element={<TaskDetailPage />} />
        <Route path="proposals" element={<ProposalsPage />} />
        <Route path="runs" element={<RunsPage />} />
        <Route path="runs/:id" element={<RunDetailPage />} />
        <Route path="defects" element={<DefectsPage />} />
        <Route path="coverage" element={<CoveragePage />} />
        <Route path="settings" element={<SettingsPage />} />

        {/* Старі адреси дашборда → найближчий новий екран. */}
        <Route path="overview" element={<Navigate to="/" replace />} />
        <Route path="launch" element={<Navigate to="/cases" replace />} />
        <Route path="scenarios/*" element={<Navigate to="/cases" replace />} />
        <Route path="suites/*" element={<Navigate to="/cases" replace />} />
        <Route path="ai-lab" element={<Navigate to="/proposals" replace />} />
        <Route path="reports" element={<Navigate to="/runs" replace />} />

        <Route path="*" element={<NotFoundPage />} />
      </Route>
    </Routes>
  );
}
