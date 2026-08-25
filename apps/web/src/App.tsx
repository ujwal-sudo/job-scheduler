import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import { useAuthStore } from './store/auth';
import { setUnauthorizedHandler } from './api/client';
import { Layout } from './components/layout/Layout';
import Login from './pages/Login';
import Dashboard from './pages/Dashboard';
import Queues from './pages/Queues';
import QueueDetail from './pages/QueueDetail';
import Jobs from './pages/Jobs';
import JobDetail from './pages/JobDetail';
import Workers from './pages/Workers';
import Schedules from './pages/Schedules';
import DeadLetterQueue from './pages/DeadLetterQueue';
import Metrics from './pages/Metrics';

function Protected({ children }: { children: React.ReactNode }) {
  const { accessToken, tryRefresh } = useAuthStore();
  const [checked, setChecked] = useState(false);

  useEffect(() => {
    (async () => {
      if (!accessToken) await tryRefresh();
      setChecked(true);
    })();
  }, []);

  if (!checked) {
    return (
      <div className="min-h-screen grid place-items-center bg-surface">
        <div className="animate-pulse text-slate-500">Loading…</div>
      </div>
    );
  }
  return accessToken ? <>{children}</> : <Navigate to="/login" replace />;
}

export default function App() {
  useEffect(() => {
    setUnauthorizedHandler(() => window.location.assign('/login'));
  }, []);

  return (
    <BrowserRouter>
      <Routes>
        <Route path="/login" element={<Login />} />
        <Route
          element={
            <Protected>
              <Layout />
            </Protected>
          }
        >
          <Route path="/" element={<Dashboard />} />
          <Route path="/projects/:projectId/queues" element={<Queues />} />
          <Route path="/queues/:queueId" element={<QueueDetail />} />
          <Route path="/queues/:queueId/jobs" element={<Jobs />} />
          <Route path="/queues/:queueId/schedules" element={<Schedules />} />
          <Route path="/queues/:queueId/dlq" element={<DeadLetterQueue />} />
          <Route path="/jobs/:jobId" element={<JobDetail />} />
          <Route path="/workers" element={<Workers />} />
          <Route path="/projects/:projectId/metrics" element={<Metrics />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}
