import { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Layers, Cpu, Zap, ShieldAlert, ArrowRight, Activity } from 'lucide-react';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/StatusBadge';
import { fmtDate, fmtDuration, pct, timeAgo } from '../components/ui/fmt';

interface QueueRow {
  id: string;
  name: string;
  isPaused: boolean;
  stats: {
    depth: number;
    running: number;
    throughputPerMin: number;
    failureRate: number;
  };
}
interface WorkerRow {
  id: string;
  hostname: string;
  status: string;
  lastHeartbeat: string;
}

export default function Dashboard() {
  const [queues, setQueues] = useState<QueueRow[]>([]);
  const [workers, setWorkers] = useState<WorkerRow[]>([]);
  const [metrics, setMetrics] = useState<any>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    Promise.all([
      api.get('/orgs'),
      api.get('/workers').catch(() => ({ data: { data: [] } })),
    ])
      .then(async ([orgsRes, workersRes]) => {
        setWorkers(workersRes.data.data ?? []);
        const orgs = orgsRes.data.data ?? [];
        if (!orgs[0]) return;
        const projects = (await api.get(`/orgs/${orgs[0].slug}/projects`)).data.data ?? [];
        if (!projects[0]) return;
        const [queuesRes, metricsRes] = await Promise.all([
          api.get(`/projects/${projects[0].id}/queues?limit=50`),
          api.get(`/projects/${projects[0].id}/metrics?granularity=hour`).catch(() => ({ data: { data: null } })),
        ]);
        setQueues(queuesRes.data.data ?? []);
        setMetrics(metricsRes.data.data);
      })
      .finally(() => setLoading(false));
  }, []);

  if (loading) return <Skeleton />;

  const activeWorkers = workers.filter((w) => w.status === 'ACTIVE' || w.status === 'IDLE').length;
  const totalDepth = queues.reduce((a, q) => a + q.stats.depth, 0);
  const jobsPerMin = queues.reduce((a, q) => a + q.stats.throughputPerMin, 0);
  const avgFailure =
    queues.length > 0
      ? queues.reduce((a, q) => a + q.stats.failureRate, 0) / queues.filter((q) => q.stats.failureRate > 0).length || 0
      : 0;
  const health = avgFailure < 0.02 ? 'Healthy' : avgFailure < 0.1 ? 'Degraded' : 'Critical';

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold text-white">Dashboard</h1>
        <p className="text-sm text-slate-500 mt-1">System overview across all queues and workers</p>
      </header>

      {/* Stat cards */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard icon={<Layers className="w-4 h-4" />} label="Queue depth" value={totalDepth} sub="pending + scheduled" />
        <StatCard icon={<Zap className="w-4 h-4" />} label="Throughput" value={`${jobsPerMin}/min`} sub="completed last minute" />
        <StatCard icon={<Cpu className="w-4 h-4" />} label="Active workers" value={activeWorkers} sub={`of ${workers.length} registered`} />
        <StatCard
          icon={<ShieldAlert className="w-4 h-4" />}
          label="Failure rate"
          value={pct(avgFailure)}
          sub={health}
          tone={health === 'Healthy' ? 'good' : health === 'Degraded' ? 'warn' : 'bad'}
        />
      </div>

      {/* Queues table */}
      <section className="card !p-0 overflow-hidden">
        <div className="flex items-center justify-between px-5 py-4 border-b border-surface-border">
          <h2 className="font-medium text-white flex items-center gap-2">
            <Activity className="w-4 h-4 text-accent" /> Top queues by activity
          </h2>
        </div>
        <table className="w-full">
          <thead>
            <tr className="border-b border-surface-border">
              <th className="th">Queue</th>
              <th className="th">State</th>
              <th className="th">Depth</th>
              <th className="th">Running</th>
              <th className="th">Per min</th>
              <th className="th">Failure rate</th>
            </tr>
          </thead>
          <tbody>
            {[...queues]
              .sort((a, b) => b.stats.depth - a.stats.depth)
              .slice(0, 8)
              .map((q) => (
                <tr key={q.id} className="border-b border-surface-border/50 hover:bg-surface-overlay/50 transition-colors">
                  <td className="td font-medium text-white">{q.name}</td>
                  <td className="td"><StatusBadge status={q.isPaused ? 'CANCELLED' : 'ACTIVE'} /></td>
                  <td className="td font-mono">{q.stats.depth}</td>
                  <td className="td font-mono">{q.stats.running}</td>
                  <td className="td font-mono">{q.stats.throughputPerMin}</td>
                  <td className="td font-mono">{pct(q.stats.failureRate)}</td>
                </tr>
              ))}
            {queues.length === 0 && (
              <tr><td colSpan={6} className="td text-center py-8 text-slate-500">No queues yet — create one to get started.</td></tr>
            )}
          </tbody>
        </table>
      </section>

      {/* Workers strip */}
      <section>
        <h2 className="font-medium text-white mb-3">Worker fleet</h2>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {workers.slice(0, 6).map((w) => (
            <div key={w.id} className="card flex items-center justify-between !py-3.5">
              <div className="min-w-0">
                <div className="text-sm text-white truncate font-mono">{w.hostname}</div>
                <div className="text-xs text-slate-500">{timeAgo(w.lastHeartbeat)}</div>
              </div>
              <StatusBadge status={w.status} />
            </div>
          ))}
          {workers.length === 0 && (
            <div className="card text-sm text-slate-500 sm:col-span-2 lg:col-span-3">
              No workers registered. Start one with <code className="text-accent font-mono">pnpm dev:worker</code>.
            </div>
          )}
        </div>
      </section>

      {metrics && (
        <section className="card">
          <h2 className="font-medium text-white mb-3">Last 24h totals</h2>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-4 text-sm">
            <Metric label="Completed" value={metrics.totals.completed} tone="text-emerald-400" />
            <Metric label="Failed" value={metrics.totals.failed + metrics.totals.dead} tone="text-red-400" />
            <Metric label="Running now" value={metrics.totals.running} tone="text-yellow-300" />
            <Metric label="Avg duration" value={fmtDuration(metrics.totals.avgDurationMs)} />
          </div>
          <Link to={`/projects/${metrics.queueDepths?.[0]?.id ? '' : ''}`} className="hidden" />
          <ArrowRight className="hidden" />
        </section>
      )}
    </div>
  );
}

function StatCard({ icon, label, value, sub, tone }: { icon: React.ReactNode; label: string; value: React.ReactNode; sub?: string; tone?: string }) {
  return (
    <div className="card">
      <div className="flex items-center gap-2 text-slate-500 text-xs uppercase tracking-wider font-semibold">
        {icon} {label}
      </div>
      <div className="mt-2 text-2xl font-semibold text-white font-mono">{value}</div>
      {sub && (
        <div className={`mt-1 text-xs ${tone === 'good' ? 'text-emerald-400' : tone === 'warn' ? 'text-amber-400' : tone === 'bad' ? 'text-red-400' : 'text-slate-500'}`}>
          {sub}
        </div>
      )}
    </div>
  );
}

function Metric({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div>
      <div className="text-slate-500 text-xs uppercase tracking-wider">{label}</div>
      <div className={`mt-1 font-mono text-lg ${tone ?? 'text-white'}`}>{value}</div>
    </div>
  );
}

function Skeleton() {
  return (
    <div className="space-y-6 animate-pulse max-w-6xl">
      <div className="h-8 w-48 bg-surface-overlay rounded-lg" />
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        {[...Array(4)].map((_, i) => <div key={i} className="h-28 bg-surface-raised border border-surface-border rounded-xl" />)}
      </div>
      <div className="h-64 bg-surface-raised border border-surface-border rounded-xl" />
    </div>
  );
}
