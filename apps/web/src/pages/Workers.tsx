import { useEffect, useState } from 'react';
import { Cpu, MemoryStick, Activity } from 'lucide-react';
import { api } from '../api/client';
import { StatusBadge } from '../components/ui/StatusBadge';
import { timeAgo } from '../components/ui/fmt';

interface Worker {
  id: string;
  hostname: string;
  pid: number;
  version?: string;
  status: string;
  concurrency: number;
  shardKey: string | null;
  queue: { id: string; name: string } | null;
  jobsRunning: number;
  lastHeartbeat: string;
}

export default function Workers() {
  const [workers, setWorkers] = useState<Worker[]>([]);

  useEffect(() => {
    const load = () => api.get('/workers').then((r) => setWorkers(r.data.data)).catch(() => undefined);
    load();
    const t = setInterval(load, 5000); // live-ish refresh; WS pulses update too
    return () => clearInterval(t);
  }, []);

  return (
    <div className="space-y-6 max-w-6xl">
      <header>
        <h1 className="text-2xl font-semibold text-white">Workers</h1>
        <p className="text-sm text-slate-500 mt-1">Live fleet status — heartbeats every 10s</p>
      </header>

      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {workers.map((w) => (
          <div key={w.id} className="card space-y-3">
            <div className="flex items-start justify-between">
              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <Cpu className="w-4 h-4 text-accent" />
                  <span className="font-mono font-medium text-white truncate">{w.hostname}</span>
                </div>
                <div className="text-xs text-slate-500 mt-0.5 font-mono">pid {w.pid}{w.version ? ` · v${w.version}` : ''}</div>
              </div>
              <StatusBadge status={w.status} />
            </div>

            <div className="grid grid-cols-3 gap-2 text-center">
              <Mini icon={<Activity className="w-3 h-3" />} label="running" value={w.jobsRunning} />
              <Mini icon={<Cpu className="w-3 h-3" />} label="concurrency" value={w.concurrency} />
              <Mini icon={<MemoryStick className="w-3 h-3" />} label="shard" value={w.shardKey ?? '—'} />
            </div>

            <div className="flex items-center justify-between text-xs border-t border-surface-border pt-3">
              <span className="text-slate-500">{w.queue ? w.queue.name : 'all eligible queues'}</span>
              <span className={freshHeartbeat(w.lastHeartbeat) ? 'text-emerald-400' : 'text-red-400'}>
                ♥ {timeAgo(w.lastHeartbeat)}
              </span>
            </div>
          </div>
        ))}
        {workers.length === 0 && (
          <div className="card md:col-span-2 xl:col-span-3 text-sm text-slate-500">
            No workers registered. Run <code className="text-accent font-mono">pnpm dev:worker</code> in another terminal.
          </div>
        )}
      </div>
    </div>
  );
}

function freshHeartbeat(hb: string): boolean {
  return Date.now() - new Date(hb).getTime() < 60_000;
}

function Mini({ icon, label, value }: { icon: React.ReactNode; label: string; value: React.ReactNode }) {
  return (
    <div className="bg-surface rounded-lg py-2">
      <div className="font-mono text-sm text-white flex items-center justify-center gap-1">
        {icon} {value}
      </div>
      <div className="text-[10px] uppercase tracking-wider text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}
