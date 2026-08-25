import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid } from 'recharts';
import { PauseCircle, PlayCircle, Settings2 } from 'lucide-react';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/StatusBadge';
import { pct, timeAgo, fmtDuration } from '../components/ui/fmt';

export default function QueueDetail() {
  const { queueId } = useParams();
  const navigate = useNavigate();
  const [queue, setQueue] = useState<any>(null);
  const [statsData, setStatsData] = useState<any>(null);
  const [tab, setTab] = useState<'overview' | 'config'>('overview');

  const load = useCallback(() => {
    api
      .get(`/queues/${queueId}`)
      .then((r) => setQueue(r.data.data))
      .catch(() => undefined);
    api
      .get(`/queues/${queueId}/stats`)
      .then((r) => setStatsData(r.data.data))
      .catch(() => undefined);
  }, [queueId]);

  useEffect(() => {
    load();
  }, [load]);

  if (!queue) return <div className="animate-pulse text-slate-500">Loading…</div>;
  const s = queue.stats;

  return (
    <div className="space-y-6 max-w-6xl">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-2xl font-semibold text-white">{queue.name}</h1>
            <StatusBadge status={queue.isPaused ? 'CANCELLED' : 'ACTIVE'} />
          </div>
          {queue.description && <p className="text-sm text-slate-500 mt-1">{queue.description}</p>}
        </div>
        <div className="flex items-center gap-2">
          <button
            className={queue.isPaused ? 'btn-primary' : 'btn-danger'}
            onClick={async () => {
              await api.post(`/projects/${queue.project.id}/queues/${queueId}/${queue.isPaused ? 'resume' : 'pause'}`);
              load();
            }}
          >
            {queue.isPaused ? <PlayCircle className="w-4 h-4" /> : <PauseCircle className="w-4 h-4" />}
            {queue.isPaused ? 'Resume' : 'Pause'}
          </button>
        </div>
      </header>

      {/* Tabs */}
      <div className="flex gap-1 border-b border-surface-border">
        {(['overview', 'config'] as const).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={`px-4 py-2 text-sm capitalize border-b-2 -mb-px transition-colors ${
              tab === t ? 'border-accent text-white' : 'border-transparent text-slate-500 hover:text-slate-300'
            }`}
          >
            {t === 'config' && <Settings2 className="w-3.5 h-3.5 inline mr-1.5 -mt-0.5" />}
            {t}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <>
          <div className="grid grid-cols-3 lg:grid-cols-6 gap-3">
            {[
              ['depth', s.depth], ['pending', s.pending], ['running', s.running],
              ['completed', s.completed], ['failed', s.failed], ['dead', s.dead],
            ].map(([label, v]) => (
              <div key={String(label)} className="card !p-4 text-center">
                <div className={`font-mono text-xl ${label === 'dead' || label === 'failed' ? 'text-red-400' : label === 'running' ? 'text-yellow-300' : label === 'completed' ? 'text-emerald-400' : 'text-white'}`}>
                  {v}
                </div>
                <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-1">{label}</div>
              </div>
            ))}
          </div>

          <section className="card">
            <h2 className="font-medium text-white mb-4">Throughput (per hour)</h2>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={statsData?.timeline ?? []}>
                <CartesianGrid stroke="#232c38" strokeDasharray="3 3" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fill: '#64748b', fontSize: 11 }} tickFormatter={(v: string) => new Date(v).getHours() + ':00'} stroke="#232c38" />
                <YAxis tick={{ fill: '#64748b', fontSize: 11 }} stroke="#232c38" allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#11161d', border: '1px solid #232c38', borderRadius: 8, color: '#e2e8f0' }} labelStyle={{ color: '#94a3b8' }} />
                <Line type="monotone" dataKey="completed" stroke="#34d399" strokeWidth={2} dot={false} name="Completed" />
                <Line type="monotone" dataKey="failed" stroke="#f87171" strokeWidth={2} dot={false} name="Failed" />
              </LineChart>
            </ResponsiveContainer>
          </section>

          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 text-sm">
            <InfoRow label="Failure rate" value={pct(s.failureRate)} />
            <InfoRow label="Avg duration" value={fmtDuration(s.avgDurationMs)} />
            <InfoRow label="Concurrency limit" value={String(queue.concurrencyLimit)} />
            <InfoRow label="Rate limit /min" value={queue.rateLimitPerMin == null ? '∞' : String(queue.rateLimitPerMin)} />
          </div>
        </>
      )}

      {tab === 'config' && (
        <section className="card max-w-xl space-y-3 text-sm">
          <InfoRow label="Slug" value={queue.slug} mono />
          <InfoRow label="Priority weight" value={String(queue.priority)} />
          <InfoRow label="Shard key" value={queue.shardKey ?? 'unsharded'} mono />
          <InfoRow label="Retry policy" value={queue.retryPolicy?.name ?? 'default backoff'} />
          {queue.retryPolicy && (
            <div className="bg-surface rounded-lg p-3 font-mono text-xs text-slate-400 space-y-1">
              <div>strategy: <span className="text-accent">{queue.retryPolicy.strategy}</span></div>
              <div>maxAttempts: {queue.retryPolicy.maxAttempts}, initialDelay: {queue.retryPolicy.initialDelayMs}ms</div>
              <div>multiplier: ×{queue.retryPolicy.multiplier}, cap: {queue.retryPolicy.maxDelayMs}ms</div>
            </div>
          )}
          <div className="pt-2 flex gap-2">
            <Link to={`/queues/${queueId}/jobs`} className="btn-primary">Browse jobs</Link>
            <Link to={`/queues/${queueId}/schedules`} className="btn-ghost border-surface-border">Schedules</Link>
            <Link to={`/queues/${queueId}/dlq`} className="btn-ghost border-surface-border">Dead letters</Link>
          </div>
        </section>
      )}
    </div>
  );
}

function InfoRow({ label, value, mono }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="card !p-4 flex items-center justify-between">
      <span className="text-slate-500">{label}</span>
      <span className={`${mono ? 'font-mono' : ''} text-white`}>{value}</span>
    </div>
  );
}
