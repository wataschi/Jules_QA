import { Navigate, Route, Routes, useParams } from 'react-router-dom';
import AppShell from './components/AppShell';
import OverviewPage from './pages/OverviewPage';
import LaunchPage from './pages/LaunchPage';
import RunsPage from './pages/RunsPage';
import RunDetailPage from './pages/RunDetailPage';
import ScenariosPage from './pages/ScenariosPage';
import ScenarioEditPage from './pages/ScenarioEditPage';
import SuitesPage from './pages/SuitesPage';
import SuiteEditPage from './pages/SuiteEditPage';
import AiLabPage from './pages/AiLabPage';
import ReportsPage from './pages/ReportsPage';
import SettingsPage from './pages/SettingsPage';

function SuiteLaunchRedirect() {
  const { id } = useParams();
  return <Navigate to={id ? `/launch?suite=${encodeURIComponent(id)}` : '/launch'} replace />;
}

export default function App() {
  return (
    <Routes>
      <Route element={<AppShell />}>
        <Route path="/" element={<OverviewPage />} />
        <Route path="/launch" element={<LaunchPage />} />
        <Route path="/runs" element={<RunsPage />} />
        <Route path="/runs/:id" element={<RunDetailPage />} />
        <Route path="/scenarios" element={<ScenariosPage />} />
        <Route path="/scenarios/:filename" element={<ScenarioEditPage />} />
        <Route path="/suites" element={<SuitesPage />} />
        <Route path="/suites/new" element={<SuiteEditPage />} />
        <Route path="/suites/:id" element={<SuiteEditPage />} />
        <Route path="/ai-lab" element={<AiLabPage />} />
        <Route path="/reports" element={<ReportsPage />} />
        <Route path="/settings" element={<SettingsPage />} />
        <Route path="/suites/:id/run" element={<SuiteLaunchRedirect />} />
      </Route>
    </Routes>
  );
}
