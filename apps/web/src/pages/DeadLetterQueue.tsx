import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { RotateCcw, CheckCheck, Trash2, Sparkles } from 'lucide-react';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/StatusBadge';
import { fmtDate, timeAgo } from '../components/ui/fmt';

interface DlqEntry {
  id: string;
  reason: string;
  failedAt: string;
  attempts: number;
  lastError?: string;
  lastErrorStack?: string;
  aiSummary?: string | null;
  isResolved: boolean;
  job: {
    id: string; type: string; status: string; attemptCount: number;
    maxAttempts: number; tags: string[]; timeoutMs: number | null;
  };
}

export default function DeadLetterQueue() {
  const { queueId } = useParams();
  const [entries, setEntries] = useState<DlqEntry[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = () =>
    api
      .get(`/queues/${queueId}/dlq?limit=50${showResolved ? '' : '&isResolved=false'}`)
      .then((r) => setEntries(r.data.data))
      .catch(() => undefined);

  useEffect(() => {
    load();
  }, [queueId, showResolved]);

  const retry = async (id: string) => {
    await api.post(`/queues/${queueId}/dlq/${id}/retry`);
    load();
  };
  const resolve = async (id: string) => {
    await api.post(`/queues/${queueId}/dlq/${id}/resolve`);
    load();
  };
  const remove = async (id: string) => {
    await api.delete(`/queues/${queueId}/dlq/${id}`);
    load();
  };

  return (
    <div className="space-y-5 max-w-6xl">
      <header className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-white">Dead Letter Queue</h1>
          <p className="text-sm text-slate-500 mt-1">Jobs that exhausted all retries — investigate, fix, requeue</p>
        </div>
        <label className="flex items-center gap-2 text-sm text-slate-400 cursor-pointer">
          <input type="checkbox" checked={showResolved} onChange={(e) => setShowResolved(e.target.checked)} />
          Show resolved
        </label>
      </header>

      <div className="space-y-3">
        {entries.map((e) => (
          <div key={e.id} className={`card !p-0 overflow-hidden ${e.isResolved ? 'opacity-60' : ''}`}>
            <button
              onClick={() => setExpanded(expanded === e.id ? null : e.id)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface-overlay/50 transition-colors text-left"
            >
              <div className="flex items-center gap-4 min-w-0">
                <StatusBadge status={e.job.status} />
                <div className="min-w-0">
                  <div className="font-mono text-sm text-white">{e.job.type} <span className="text-slate-600">{e.job.id.slice(0, 8)}…</span></div>
                  <div className="text-xs text-red-400/80 truncate max-w-lg">{e.lastError ?? e.reason}</div>
                </div>
              </div>
              <div className="text-right shrink-0 ml-4">
                <div className="text-xs text-slate-400 font-mono">{e.attempts}/{e.job.maxAttempts} attempts</div>
                <div className="text-xs text-slate-500">{timeAgo(e.failedAt)}</div>
              </div>
            </button>

            {expanded === e.id && (
              <div className="border-t border-surface-border px-5 py-4 space-y-4">
                {/* AI summary */}
                <div className="rounded-lg border border-purple-500/30 bg-purple-500/5 p-4">
                  <div className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-purple-300 mb-2">
                    <Sparkles className="w-3.5 h-3.5" /> AI Failure Analysis
                  </div>
                  {e.aiSummary ? (
                    <p className="text-sm text-slate-300 whitespace-pre-wrap">{e.aiSummary}</p>
                  ) : (
                    <p className="text-sm text-slate-500 italic">
                      No AI summary. Configure OPENROUTER_API_KEY to enable automatic failure analysis.
                    </p>
                  )}
                </div>

                {/* Stack */}
                {e.lastErrorStack && (
                  <pre className="text-xs text-slate-400 bg-black/40 rounded-lg p-3 overflow-auto max-h-40 whitespace-pre-wrap border border-surface-border">
                    {e.lastErrorStack}
                  </pre>
                )}

                {/* Meta */}
                <div className="grid grid-cols-3 gap-3 text-xs">
                  <div><span className="text-slate-500">Failed at:</span> <span className="text-slate-300">{fmtDate(e.failedAt)}</span></div>
                  <div><span className="text-slate-500">Reason:</span> <span className="text-slate-300">{e.reason}</span></div>
                  <Link to={`/jobs/${e.job.id}`} className="text-accent hover:underline">Full job detail →</Link>
                </div>

                {/* Actions */}
                {!e.isResolved && (
                  <div className="flex gap-2 pt-1">
                    <button onClick={() => retry(e.id)} className="btn-primary">
                      <RotateCcw className="w-4 h-4" /> Retry job
                    </button>
                    <button onClick={() => resolve(e.id)} className="btn-ghost border border-surface-border">
                      <CheckCheck className="w-4 h-4" /> Mark resolved
                    </button>
                    <button onClick={() => remove(e.id)} className="btn-danger ml-auto">
                      <Trash2 className="w-4 h-4" /> Delete
                    </button>
                  </div>
                )}
              </div>
            )}
          </div>
        ))}

        {entries.length === 0 && (
          <div className="card text-center py-12">
            <CheckCheck className="w-8 h-8 text-emerald-400 mx-auto mb-3" />
            <div className="text-white font-medium">No dead letters</div>
            <div className="text-sm text-slate-500 mt-1">All jobs are healthy — nothing stuck in the DLQ.</div>
          </div>
        )}
      </div>
    </div>
  );
}
