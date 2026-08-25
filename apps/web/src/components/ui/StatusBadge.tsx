import clsx from 'clsx';

const STYLES: Record<string, string> = {
  PENDING: 'bg-slate-500/15 text-slate-300 border border-slate-500/30',
  SCHEDULED: 'bg-sky-500/15 text-sky-300 border border-sky-500/30',
  CLAIMED: 'bg-indigo-500/15 text-indigo-300 border border-indigo-500/30',
  RUNNING: 'bg-yellow-500/15 text-yellow-300 border border-yellow-500/30',
  COMPLETED: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
  FAILED: 'bg-orange-500/15 text-orange-300 border border-orange-500/30',
  RETRYING: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
  CANCELLED: 'bg-zinc-500/15 text-zinc-400 border border-zinc-500/30',
  DEAD: 'bg-red-500/15 text-red-300 border border-red-500/30',
  ACTIVE: 'bg-emerald-500/15 text-emerald-300 border border-emerald-500/30',
  IDLE: 'bg-sky-500/15 text-sky-300 border border-sky-500/30',
  DRAINING: 'bg-amber-500/15 text-amber-300 border border-amber-500/30',
};

export function StatusBadge({ status, className }: { status: string; className?: string }) {
  return (
    <span className={clsx('badge', STYLES[status] ?? 'bg-slate-700/40 text-slate-300', className)}>
      <span
        className={clsx(
          'w-1.5 h-1.5 rounded-full',
          status === 'RUNNING' && 'animate-pulse bg-yellow-400',
          status === 'COMPLETED' || status === 'ACTIVE' ? 'bg-emerald-400' : 'bg-current',
        )}
      />
      {status}
    </span>
  );
}
