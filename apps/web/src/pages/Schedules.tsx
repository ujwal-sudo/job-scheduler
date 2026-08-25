import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { Play, Plus, PowerOff, Power, RefreshCw } from 'lucide-react';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/StatusBadge';
import { fmtDate } from '../components/ui/fmt';

interface Schedule {
  id: string;
  name: string;
  cronExpression: string;
  jobType: string;
  timezone: string;
  isActive: boolean;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastJobId: string | null;
}

export default function Schedules() {
  const { queueId } = useParams();
  const [schedules, setSchedules] = useState<Schedule[]>([]);
  const [showCreate, setShowCreate] = useState(false);
  const [form, setForm] = useState({
    name: '', cronExpression: '*/5 * * * *', jobType: 'report',
    payload: '{}', jobPriority: 5, timezone: 'UTC',
  });
  const [error, setError] = useState<string | null>(null);

  const load = () => api.get(`/queues/${queueId}/schedules`).then((r) => setSchedules(r.data.data)).catch(() => undefined);

  useEffect(() => {
    load();
    const t = setInterval(load, 10_000);
    return () => clearInterval(t);
  }, [queueId]);

  const create = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      await api.post(`/queues/${queueId}/schedules`, {
        name: form.name,
        cronExpression: form.cronExpression,
        jobType: form.jobType,
        jobPayload: JSON.parse(form.payload || '{}'),
        jobPriority: Number(form.jobPriority),
        timezone: form.timezone,
      });
      setShowCreate(false);
      load();
    } catch (err: any) {
      setError(err.response?.data?.error?.message ?? 'Invalid schedule');
    }
  };

  const toggle = async (s: Schedule) => {
    await api.patch(`/queues/${queueId}/schedules/${s.id}`, { isActive: !s.isActive });
    load();
  };

  const triggerNow = async (s: Schedule) => {
    await api.post(`/queues/${queueId}/schedules/${s.id}/trigger`);
    load();
  };

  return (
    <div className="space-y-5 max-w-5xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Schedules</h1>
          <p className="text-sm text-slate-500 mt-1">Cron-driven recurring jobs</p>
        </div>
        <button onClick={() => setShowCreate((v) => !v)} className="btn-primary">
          <Plus className="w-4 h-4" /> New schedule
        </button>
      </header>

      {showCreate && (
        <form onSubmit={create} className="card space-y-3">
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <L label="Name"><input required className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></L>
            <L label="Cron expression"><input required className="input font-mono" value={form.cronExpression} onChange={(e) => setForm({ ...form, cronExpression: e.target.value })} placeholder="*/5 * * * *" /></L>
            <L label="Job type"><input required className="input font-mono" value={form.jobType} onChange={(e) => setForm({ ...form, jobType: e.target.value })} /></L>
            <L label="Timezone"><input className="input" value={form.timezone} onChange={(e) => setForm({ ...form, timezone: e.target.value })} /></L>
          </div>
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-3 items-end">
            <L label="Payload (JSON)" className="lg:col-span-3">
              <textarea rows={2} className="input font-mono text-xs" value={form.payload} onChange={(e) => setForm({ ...form, payload: e.target.value })} />
            </L>
            <button type="submit" className="btn-primary justify-center">Create schedule</button>
          </div>
          {error && <div className="text-sm text-red-400">{error}</div>}
        </form>
      )}

      <div className="card !p-0 overflow-x-auto">
        <table className="w-full min-w-[760px]">
          <thead>
            <tr className="border-b border-surface-border">
              <th className="th">Name</th>
              <th className="th">Cron</th>
              <th className="th">Job type</th>
              <th className="th">State</th>
              <th className="th">Last run</th>
              <th className="th">Next run</th>
              <th className="th"></th>
            </tr>
          </thead>
          <tbody>
            {schedules.map((s) => (
              <tr key={s.id} className="border-b border-surface-border/50 hover:bg-surface-overlay/40">
                <td className="td font-medium text-white">{s.name}</td>
                <td className="td font-mono text-xs">{s.cronExpression}<span className="ml-2 text-slate-600">{s.timezone}</span></td>
                <td className="td font-mono text-xs">{s.jobType}</td>
                <td className="td">
                  {s.isActive ? <StatusBadge status="ACTIVE" /> : <StatusBadge status="CANCELLED" />}
                </td>
                <td className="td text-slate-400 text-xs">{fmtDate(s.lastRunAt)}</td>
                <td className="td text-slate-300 text-xs">{s.isActive ? countdown(s.nextRunAt) : '—'}</td>
                <td className="td">
                  <span className="flex gap-1 justify-end">
                    <button onClick={() => triggerNow(s)} title="Trigger now" className="btn-ghost !px-2"><Play className="w-4 h-4" /></button>
                    <button onClick={() => toggle(s)} title={s.isActive ? 'Deactivate' : 'Activate'} className="btn-ghost !px-2">
                      {s.isActive ? <PowerOff className="w-4 h-4" /> : <Power className="w-4 h-4" />}
                    </button>
                  </span>
                </td>
              </tr>
            ))}
            {schedules.length === 0 && (
              <tr><td colSpan={7} className="td text-center py-10 text-slate-500">No schedules yet.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <p className="text-xs text-slate-600 flex items-center gap-1.5">
        <RefreshCw className="w-3 h-3" /> Auto-refreshes every 10s
      </p>
    </div>
  );
}

function countdown(next?: string | null): string {
  if (!next) return '—';
  const diff = new Date(next).getTime() - Date.now();
  if (diff <= 0) return 'due now';
  const s = Math.floor(diff / 1000);
  if (s < 60) return `in ${s}s`;
  const m = Math.floor(s / 60);
  return `in ${m}m ${s % 60}s`;
}

function L({ label, children, className }: { label: string; children: React.ReactNode; className?: string }) {
  return (
    <label className={`block text-xs text-slate-500 ${className ?? ''}`}>
      {label}
      <div className="mt-1">{children}</div>
    </label>
  );
}
