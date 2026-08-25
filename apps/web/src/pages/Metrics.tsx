import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { api } from '../api/client';
import {
  LineChart, Line, BarChart, Bar, PieChart, Pie, Cell,
  XAxis, YAxis, Tooltip, Legend, ResponsiveContainer, CartesianGrid,
} from 'recharts';

const COLORS: Record<string, string> = {
  COMPLETED: '#34d399',
  FAILED: '#fb923c',
  DEAD: '#f87171',
  PENDING: '#94a3b8',
  SCHEDULED: '#38bdf8',
  RUNNING: '#fbbf24',
  RETRYING: '#f59e0b',
  CANCELLED: '#71717a',
};

export default function Metrics() {
  const { projectId } = useParams();
  const [data, setData] = useState<any>(null);
  const [granularity, setGranularity] = useState<'hour' | 'day'>('hour');

  useEffect(() => {
    api.get(`/projects/${projectId}/metrics?granularity=${granularity}`)
      .then((r) => setData(r.data.data))
      .catch(() => undefined);
  }, [projectId, granularity]);

  if (!data) return <div className="animate-pulse text-slate-500">Loading metrics…</div>;

  const statusPie = Object.entries(data.totals as Record<string, number>)
    .filter(([k]) => k in COLORS && !k.includes('Rate') && !k.startsWith('avg'))
    .map(([name, value]) => ({ name, value }));

  return (
    <div className="space-y-6 max-w-6xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Metrics</h1>
          <p className="text-sm text-slate-500 mt-1">Throughput, reliability and depth — computed from live job data</p>
        </div>
        <div className="flex gap-1 bg-surface-raised border border-surface-border rounded-lg p-1">
          {(['hour', 'day'] as const).map((g) => (
            <button
              key={g}
              onClick={() => setGranularity(g)}
              className={`px-3 py-1 rounded-md text-sm capitalize ${granularity === g ? 'bg-accent text-white' : 'text-slate-400 hover:text-white'}`}
            >
              {g === 'hour' ? '24h / hour' : '7d / day'}
            </button>
          ))}
        </div>
      </header>

      {/* Totals strip */}
      <div className="grid grid-cols-2 lg:grid-cols-5 gap-3">
        <Tile label="Completed" value={data.totals.completed} tone="text-emerald-400" />
        <Tile label="Failed" value={data.totals.failed} tone="text-orange-400" />
        <Tile label="Dead" value={data.totals.dead} tone="text-red-400" />
        <Tile label="In flight" value={data.totals.pending + data.totals.scheduled + data.totals.running} tone="text-sky-300" />
        <Tile label="Avg duration" value={data.totals.avgDurationMs != null ? `${data.totals.avgDurationMs}ms` : '—'} />
      </div>

      {/* Throughput */}
      <section className="card">
        <h2 className="font-medium text-white mb-4">Throughput — completed vs failed</h2>
        <ResponsiveContainer width="100%" height={260}>
          <LineChart data={data.timeline}>
            <CartesianGrid stroke="#232c38" strokeDasharray="3 3" vertical={false} />
            <XAxis
              dataKey="bucket"
              tick={{ fill: '#64748b', fontSize: 11 }}
              stroke="#232c38"
              tickFormatter={(v: string) =>
                granularity === 'hour'
                  ? new Date(v).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' })
                  : new Date(v).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
              }
            />
            <YAxis tick={{ fill: '#64748b', fontSize: 11 }} stroke="#232c38" allowDecimals={false} />
            <Tooltip contentStyle={{ background: '#11161d', border: '1px solid #232c38', borderRadius: 8 }} labelStyle={{ color: '#94a3b8' }} />
            <Legend wrapperStyle={{ fontSize: 12 }} />
            <Line type="monotone" dataKey="completed" stroke="#34d399" strokeWidth={2} dot={false} name="Completed" />
            <Line type="monotone" dataKey="failed" stroke="#f87171" strokeWidth={2} dot={false} name="Failed" />
          </LineChart>
        </ResponsiveContainer>
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* Queue depth */}
        <section className="card">
          <h2 className="font-medium text-white mb-4">Queue depth snapshot</h2>
          <ResponsiveContainer width="100%" height={240}>
            <BarChart data={data.queueDepths ?? []} layout="vertical">
              <CartesianGrid stroke="#232c38" strokeDasharray="3 3" horizontal={false} />
              <XAxis type="number" tick={{ fill: '#64748b', fontSize: 11 }} stroke="#232c38" allowDecimals={false} />
              <YAxis type="category" dataKey="name" width={120} tick={{ fill: '#94a3b8', fontSize: 11 }} stroke="#232c38" />
              <Tooltip cursor={{ fill: 'rgba(255,255,255,0.04)' }} contentStyle={{ background: '#11161d', border: '1px solid #232c38', borderRadius: 8 }} />
              <Bar dataKey="depth" fill="#3b82f6" radius={[0, 4, 4, 0]} barSize={18} />
            </BarChart>
          </ResponsiveContainer>
        </section>

        {/* Status distribution */}
        <section className="card">
          <h2 className="font-medium text-white mb-4">Job status distribution</h2>
          <ResponsiveContainer width="100%" height={240}>
            <PieChart>
              <Pie
                data={statusPie.filter((s) => s.value > 0)}
                dataKey="value"
                nameKey="name"
                innerRadius={55}
                outerRadius={90}
                paddingAngle={2}
              >
                {statusPie.filter((s) => s.value > 0).map((s) => (
                  <Cell key={s.name} fill={COLORS[s.name]} stroke="#0b0f14" />
                ))}
              </Pie>
              <Tooltip contentStyle={{ background: '#11161d', border: '1px solid #232c38', borderRadius: 8 }} />
              <Legend wrapperStyle={{ fontSize: 11 }} />
            </PieChart>
          </ResponsiveContainer>
        </section>
      </div>

      {/* Worker health */}
      <section className="card">
        <h2 className="font-medium text-white mb-3">Worker fleet health</h2>
        <div className="flex flex-wrap gap-2">
          {(data.workerHealth ?? []).map((w: { status: string; count: number }) => (
            <span key={w.status} className="badge border" style={{ color: COLORS[w.status] ?? '#94a3b8', borderColor: `${COLORS[w.status] ?? '#94a3b8'}44`, background: `${COLORS[w.status] ?? '#94a3b8'}15` }}>
              {w.status}: {w.count}
            </span>
          ))}
          {(!data.workerHealth || data.workerHealth.length === 0) && (
            <span className="text-sm text-slate-500">No workers registered.</span>
          )}
        </div>
      </section>
    </div>
  );
}

function Tile({ label, value, tone }: { label: string; value: React.ReactNode; tone?: string }) {
  return (
    <div className="card !p-4">
      <div className="text-[10px] uppercase tracking-wider text-slate-500 font-semibold">{label}</div>
      <div className={`mt-1.5 font-mono text-xl ${tone ?? 'text-white'}`}>{value}</div>
    </div>
  );
}
