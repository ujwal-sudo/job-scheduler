import { useCallback, useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { RotateCcw, Ban } from 'lucide-react';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/StatusBadge';
import { fmtDate } from '../components/ui/fmt';

const STATUSES = ['PENDING', 'SCHEDULED', 'RUNNING', 'COMPLETED', 'RETRYING', 'FAILED', 'DEAD', 'CANCELLED'] as const;

interface JobRow {
  id: string;
  type: string;
  status: string;
  priority: number;
  attemptCount: number;
  maxAttempts: number;
  createdAt: string;
  completedAt: string | null;
}

export default function Jobs() {
  const { queueId } = useParams();
  const navigate = useNavigate();
  const [jobs, setJobs] = useState<JobRow[]>([]);
  const [meta, setMeta] = useState({ page: 1, totalPages: 1, total: 0 });
  const [statusFilter, setStatusFilter] = useState<string[]>([]);
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [selected, setSelected] = useState<Set<string>>(new Set());

  const load = useCallback(() => {
    const params = new URLSearchParams({ page: String(page), limit: '20' });
    if (statusFilter.length) params.set('status', statusFilter.join(','));
    api
      .get(`/queues/${queueId}/jobs?${params}`)
      .then((r) => {
        setJobs(r.data.data);
        setMeta(r.data.meta);
      })
      .finally(() => setLoading(false));
  }, [queueId, page, statusFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const toggleStatus = (s: string) =>
    setStatusFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));

  const bulkRetry = async () => {
    for (const id of selected) {
      await api.post(`/queues/${queueId}/jobs/${id}/retry`).catch(() => undefined);
    }
    setSelected(new Set());
    load();
  };

  const bulkCancel = async () => {
    for (const id of selected) {
      await api.delete(`/queues/${queueId}/jobs/${id}`).catch(() => undefined);
    }
    setSelected(new Set());
    load();
  };

  const toggleSelect = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  return (
    <div className="space-y-4 max-w-7xl">
      <header className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-white">Job Explorer</h1>
        <Link to={`/queues/${queueId}`} className="btn-ghost border border-surface-border">← Queue</Link>
      </header>

      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        {STATUSES.map((s) => (
          <button
            key={s}
            onClick={() => toggleStatus(s)}
            className={`transition-opacity ${statusFilter.length && !statusFilter.includes(s) ? 'opacity-35' : ''}`}
          >
            <StatusBadge status={s} />
          </button>
        ))}
        <span className="flex-1" />
        {selected.size > 0 && (
          <>
            <span className="text-xs text-slate-500">{selected.size} selected</span>
            <button onClick={bulkRetry} className="btn-primary"><RotateCcw className="w-3.5 h-3.5" /> Retry</button>
            <button onClick={bulkCancel} className="btn-danger"><Ban className="w-3.5 h-3.5" /> Cancel</button>
          </>
        )}
      </div>

      {/* Table */}
      <div className="card !p-0 overflow-x-auto">
        <table className="w-full min-w-[860px]">
          <thead>
            <tr className="border-b border-surface-border">
              <th className="th w-10">
                <input
                  type="checkbox"
                  aria-label="select all"
                  checked={selected.size > 0 && selected.size === jobs.length}
                  onChange={(e) => setSelected(e.target.checked ? new Set(jobs.map((j) => j.id)) : new Set())}
                />
              </th>
              <th className="th">ID</th>
              <th className="th">Type</th>
              <th className="th">Status</th>
              <th className="th">Priority</th>
              <th className="th">Attempt</th>
              <th className="th">Created</th>
              <th className="th">Completed</th>
            </tr>
          </thead>
          <tbody>
            {jobs.map((j) => (
              <tr key={j.id} className="border-b border-surface-border/50 hover:bg-surface-overlay/50 cursor-pointer transition-colors" onClick={() => navigate(`/jobs/${j.id}`)}>
                <td className="td" onClick={(e) => e.stopPropagation()}>
                  <input type="checkbox" aria-label={`select ${j.id}`} checked={selected.has(j.id)} onChange={() => toggleSelect(j.id)} />
                </td>
                <td className="td font-mono text-xs text-slate-400">{j.id.slice(0, 8)}…</td>
                <td className="td font-medium text-white">{j.type}</td>
                <td className="td"><StatusBadge status={j.status} /></td>
                <td className="td font-mono">{j.priority}</td>
                <td className="td font-mono">{j.attemptCount}/{j.maxAttempts}</td>
                <td className="td text-slate-400">{fmtDate(j.createdAt)}</td>
                <td className="td text-slate-400">{fmtDate(j.completedAt)}</td>
              </tr>
            ))}
            {!loading && jobs.length === 0 && (
              <tr><td colSpan={8} className="td text-center py-10 text-slate-500">No jobs match the current filters.</td></tr>
            )}
            {loading && (
              <tr><td colSpan={8} className="td text-center py-10 animate-pulse text-slate-600">Loading…</td></tr>
            )}
          </tbody>
        </table>
      </div>

      {/* Pagination */}
      <div className="flex items-center justify-between text-sm text-slate-400">
        <span>{meta.total} jobs · page {meta.page} of {meta.totalPages}</span>
        <div className="flex gap-2">
          <button disabled={page <= 1} onClick={() => setPage((p) => p - 1)} className="btn-ghost border border-surface-border">Prev</button>
          <button disabled={page >= meta.totalPages} onClick={() => setPage((p) => p + 1)} className="btn-ghost border border-surface-border">Next</button>
        </div>
      </div>
    </div>
  );
}
