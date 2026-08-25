import { useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { RotateCcw, ChevronDown, ChevronRight, Clock, CheckCircle2, XCircle } from 'lucide-react';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/StatusBadge';
import { fmtDate, fmtDuration, timeAgo } from '../components/ui/fmt';

const TIMELINE: Array<{ key: string; label: string; field: string }> = [
  { key: 'PENDING', label: 'Created', field: 'createdAt' },
  { key: 'CLAIMED', label: 'Claimed', field: 'claimedAt' },
  { key: 'RUNNING', label: 'Started', field: 'startedAt' },
  { key: 'COMPLETED', label: 'Finished', field: 'completedAt' },
];

export default function JobDetail() {
  const { jobId } = useParams();
  const [job, setJob] = useState<any>(null);
  const [openExec, setOpenExec] = useState<string | null>(null);
  const [logs, setLogs] = useState<any[]>([]);

  const load = () =>
    api.get(`/jobs/${jobId}`).then((r) => setJob(r.data.data)).catch(() => undefined);

  useEffect(() => {
    load();
  }, [jobId]);

  const openLogs = async (execId: string) => {
    if (openExec === execId) return setOpenExec(null);
    setOpenExec(execId);
    setLogs(job?.executions?.find((e: any) => e.id === execId)?.logs ?? []);
  };

  if (!job) return <div className="animate-pulse text-slate-500">Loading…</div>;

  const timelineIdx = (() => {
    if (['COMPLETED'].includes(job.status)) return TIMELINE.length;
    if (['RUNNING', 'FAILED', 'RETRYING', 'DEAD'].includes(job.status)) return 3;
    if (job.status === 'CLAIMED') return 2;
    return 1;
  })();

  return (
    <div className="space-y-6 max-w-5xl">
      <header className="flex items-start justify-between gap-4">
        <div>
          <div className="flex items-center gap-3">
            <h1 className="text-xl font-mono text-white">{job.id.slice(0, 12)}…</h1>
            <StatusBadge status={job.status} />
          </div>
          <p className="text-sm text-slate-500 mt-1">
            type <span className="text-slate-300 font-mono">{job.type}</span> · priority {job.priority} · attempt{' '}
            {job.attemptCount}/{job.maxAttempts}
          </p>
        </div>
        <div className="flex gap-2">
          <Link to={`/queues/${job.queueId}/jobs`} className="btn-ghost border border-surface-border">← Jobs</Link>
          {['FAILED', 'DEAD', 'CANCELLED', 'RETRYING'].includes(job.status) && (
            <button
              className="btn-primary"
              onClick={async () => {
                await api.post(`/queues/${job.queueId}/jobs/${jobId}/retry`);
                load();
              }}
            >
              <RotateCcw className="w-4 h-4" /> Retry
            </button>
          )}
        </div>
      </header>

      {/* Timeline */}
      <section className="card">
        <div className="flex items-center justify-between mb-6">
          {TIMELINE.map((t, i) => {
            const done = i < timelineIdx;
            const current = i === timelineIdx - 1 && !['COMPLETED'].includes(job.status);
            const Icon = done ? CheckCircle2 : current ? Clock : XCircle;
            return (
              <div key={t.key} className="flex-1 flex items-center relative last:flex-none">
                <div className="flex items-center gap-2">
                  <Icon className={`w-5 h-5 ${done ? 'text-emerald-400' : current ? 'text-yellow-300 animate-pulse' : 'text-slate-600'}`} />
                  <div>
                    <div className={`text-xs font-medium ${done || current ? 'text-white' : 'text-slate-500'}`}>{t.label}</div>
                    <div className="text-[11px] text-slate-500 font-mono">{fmtDate(job[t.field])}</div>
                  </div>
                </div>
                {i < TIMELINE.length - 1 && (
                  <div className={`flex-1 h-px mx-3 ${i < timelineIdx - 1 ? 'bg-emerald-500/50' : 'bg-surface-border'}`} />
                )}
              </div>
            );
          })}
        </div>

        {/* Payload + metadata */}
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Block title="Payload" body={<pre className="text-xs text-slate-300 overflow-auto max-h-48">{JSON.stringify(job.payload, null, 2)}</pre>} />
          {job.metadata != null && (
            <Block title="Metadata" body={<pre className="text-xs text-slate-300 overflow-auto max-h-48">{JSON.stringify(job.metadata, null, 2)}</pre>} />
          )}
        </div>

        {job.tags.length > 0 && (
          <div className="mt-4 flex gap-1.5">
            {job.tags.map((t: string) => (
              <span key={t} className="badge bg-accent/10 text-accent border border-accent/20">{t}</span>
            ))}
          </div>
        )}

        {job.dependsOn?.length > 0 && (
          <div className="mt-4 text-sm text-slate-400">
            Depends on:{' '}
            {job.dependsOn.map((d: any, i: number) => (
              <span key={d.dependencyJob.id}>
                {i > 0 && ', '}
                <span className="font-mono text-xs">{d.dependencyJob.id.slice(0, 8)}</span>{' '}
                <StatusBadge status={d.dependencyJob.status} />
              </span>
            ))}
          </div>
        )}

        {job.dlqEntry && (
          <div className="mt-4 rounded-lg border border-red-500/30 bg-red-500/5 p-4">
            <div className="text-sm font-medium text-red-300">Dead-lettered · {job.dlqEntry.reason}</div>
            {job.dlqEntry.aiSummary && (
              <div className="mt-2 text-sm text-slate-300 whitespace-pre-wrap">{job.dlqEntry.aiSummary}</div>
            )}
          </div>
        )}
      </section>

      {/* Execution history */}
      <section className="space-y-2">
        <h2 className="font-medium text-white">Execution history ({job.executions.length})</h2>
        {job.executions.map((e: any) => (
          <div key={e.id} className="card !p-0 overflow-hidden">
            <button
              onClick={() => openLogs(e.id)}
              className="w-full flex items-center justify-between px-5 py-4 hover:bg-surface-overlay/60 transition-colors"
            >
              <span className="flex items-center gap-3">
                {openExec === e.id ? <ChevronDown className="w-4 h-4 text-slate-500" /> : <ChevronRight className="w-4 h-4 text-slate-500" />}
                <span className="text-sm text-white">Attempt #{e.attemptNumber}</span>
                <StatusBadge status={e.status === 'TIMEOUT' ? 'FAILED' : e.status} />
              </span>
              <span className="text-xs text-slate-500 font-mono">
                {fmtDuration(e.durationMs)} · {timeAgo(e.completedAt ?? e.startedAt)}
              </span>
            </button>
            {openExec === e.id && (
              <div className="border-t border-surface-border px-5 py-4 space-y-3">
                {e.error && (
                  <div>
                    <div className="text-xs uppercase tracking-wider text-red-400 mb-1">Error</div>
                    <pre className="text-xs text-red-300 bg-red-500/5 rounded-lg p-3 overflow-auto whitespace-pre-wrap">{e.error}</pre>
                  </div>
                )}
                <div>
                  <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">Logs</div>
                  {logs.length > 0 ? (
                    <div className="bg-black/40 rounded-lg p-3 font-mono text-xs space-y-1 max-h-64 overflow-auto">
                      {logs.map((l: any) => (
                        <div key={l.id} className={
                          l.level === 'ERROR' ? 'text-red-400' : l.level === 'WARN' ? 'text-amber-300' : l.level === 'DEBUG' ? 'text-slate-500' : 'text-slate-300'
                        }>
                          <span className="text-slate-600">{new Date(l.timestamp).toLocaleTimeString()} </span>
                          [{l.level}] {l.message}
                        </div>
                      ))}
                    </div>
                  ) : (
                    <div className="text-sm text-slate-500 italic">No logs recorded for this attempt.</div>
                  )}
                </div>
              </div>
            )}
          </div>
        ))}
        {job.executions.length === 0 && (
          <div className="card text-sm text-slate-500">No executions yet — the job has not been claimed by a worker.</div>
        )}
      </section>
    </div>
  );
}

function Block({ title, body }: { title: string; body: React.ReactNode }) {
  return (
    <div>
      <div className="text-xs uppercase tracking-wider text-slate-500 mb-2">{title}</div>
      <div className="bg-black/40 rounded-lg p-3 border border-surface-border">{body}</div>
    </div>
  );
}
