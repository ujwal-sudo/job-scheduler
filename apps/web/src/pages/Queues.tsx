import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Plus, PauseCircle, PlayCircle, Gauge } from 'lucide-react';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/StatusBadge';
import { pct, fmtDuration } from '../components/ui/fmt';

interface Queue {
  id: string;
  name: string;
  slug: string;
  description?: string;
  priority: number;
  concurrencyLimit: number;
  rateLimitPerMin: number | null;
  isPaused: boolean;
  shardKey: string | null;
  stats: {
    depth: number; pending: number; running: number; completed: number; failed: number; dead: number;
    throughputPerMin: number; failureRate: number; avgDurationMs: number | null;
  };
}

export default function Queues() {
  const { projectId } = useParams();
  const [queues, setQueues] = useState<Queue[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({ name: '', priority: 5, concurrencyLimit: 10, rateLimitPerMin: '', shardKey: '' });

  const load = () =>
    api
      .get(`/projects/${projectId}/queues?limit=100`)
      .then((r) => setQueues(r.data.data))
      .finally(() => setLoading(false));

  useEffect(() => {
    load();
  }, [projectId]);

  const togglePause = async (q: Queue) => {
    await api.post(`/projects/${projectId}/queues/${q.id}/${q.isPaused ? 'resume' : 'pause'}`);
    load();
  };

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    await api.post(`/projects/${projectId}/queues`, {
      name: form.name,
      priority: Number(form.priority),
      concurrencyLimit: Number(form.concurrencyLimit),
      rateLimitPerMin: form.rateLimitPerMin ? Number(form.rateLimitPerMin) : null,
      shardKey: form.shardKey || null,
    });
    setShowCreate(false);
    setForm({ name: '', priority: 5, concurrencyLimit: 10, rateLimitPerMin: '', shardKey: '' });
    load();
  };

  if (loading) return <div className="animate-pulse text-slate-500">Loading queues…</div>;

  return (
    <div className="space-y-6 max-w-6xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Queues</h1>
          <p className="text-sm text-slate-500 mt-1">Job pipelines with live depth and health</p>
        </div>
        <button onClick={() => setShowCreate((v) => !v)} className="btn-primary">
          <Plus className="w-4 h-4" /> New queue
        </button>
      </header>

      {showCreate && (
        <form onSubmit={create} className="card grid grid-cols-2 lg:grid-cols-5 gap-3 items-end">
          <label className="col-span-2 lg:col-span-1 block text-xs text-slate-500">
            Name
            <input required className="input mt-1" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="emails" />
          </label>
          <label className="block text-xs text-slate-500">
            Priority (1–10)
            <input type="number" min={1} max={10} className="input mt-1" value={form.priority} onChange={(e) => setForm({ ...form, priority: +e.target.value })} />
          </label>
          <label className="block text-xs text-slate-500">
            Concurrency
            <input type="number" min={1} className="input mt-1" value={form.concurrencyLimit} onChange={(e) => setForm({ ...form, concurrencyLimit: +e.target.value })} />
          </label>
          <label className="block text-xs text-slate-500">
            Rate limit/min
            <input type="number" min={1} className="input mt-1" placeholder="∞" value={form.rateLimitPerMin} onChange={(e) => setForm({ ...form, rateLimitPerMin: e.target.value })} />
          </label>
          <button type="submit" className="btn-primary justify-center">Create</button>
        </form>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {queues.map((q) => (
          <div key={q.id} className="card space-y-4 hover:border-accent/40 transition-colors">
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0">
                <Link to={`/queues/${q.id}`} className="font-medium text-white hover:text-accent transition-colors">
                  {q.name}
                </Link>
                {q.description && <p className="text-xs text-slate-500 mt-0.5 truncate">{q.description}</p>}
              </div>
              <StatusBadge status={q.isPaused ? 'CANCELLED' : 'ACTIVE'} />
            </div>

            <div className="grid grid-cols-4 gap-2 text-center">
              <Cell label="depth" value={q.stats.depth} />
              <Cell label="running" value={q.stats.running} />
              <Cell label="/min" value={q.stats.throughputPerMin} />
              <Cell label="fail" value={pct(q.stats.failureRate)} tone={q.stats.failureRate > 0.05 ? 'text-red-400' : 'text-emerald-400'} />
            </div>

            <div className="flex items-center justify-between text-xs text-slate-500 border-t border-surface-border pt-3">
              <span className="flex items-center gap-3 font-mono">
                <span title="concurrency"><Gauge className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />{q.concurrencyLimit}</span>
                <span>{fmtDuration(q.stats.avgDurationMs)}</span>
                {q.shardKey && <span className="badge bg-purple-500/15 text-purple-300">{q.shardKey}</span>}
              </span>
              <span className="flex items-center gap-1">
                <button onClick={() => togglePause(q)} className={`btn-ghost !px-2 ${q.isPaused ? 'text-emerald-400' : ''}`}>
                  {q.isPaused ? <PlayCircle className="w-4 h-4" /> : <PauseCircle className="w-4 h-4" />}
                  {q.isPaused ? 'Resume' : 'Pause'}
                </button>
                <Link to={`/queues/${q.id}/jobs`} className="btn-ghost !px-2">Jobs</Link>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Cell({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="bg-surface rounded-lg py-2">
      <div className={`font-mono text-lg ${tone ?? 'text-white'}`}>{value}</div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500">{label}</div>
    </div>
  );
}
