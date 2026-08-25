import { NavLink, useNavigate } from 'react-router-dom';
import { useEffect, useState } from 'react';
import {
  LayoutDashboard, Layers, Cpu, CalendarClock, AlertOctagon,
  BarChart3, LogOut, TerminalSquare, ChevronDown, FolderKanban,
} from 'lucide-react';
import { useAuthStore } from '../../store/auth';
import { api } from '../../api/client';

interface Org {
  id: string;
  name: string;
  slug: string;
  myRole: string;
}
interface Project {
  id: string;
  name: string;
}

export default function Sidebar() {
  const { user, logout } = useAuthStore();
  const navigate = useNavigate();
  const [orgs, setOrgs] = useState<Org[]>([]);
  const [org, setOrg] = useState<Org | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [project, setProject] = useState<Project | null>(null);
  const [orgOpen, setOrgOpen] = useState(false);

  useEffect(() => {
    api.get('/orgs').then((r) => {
      const list = r.data.data ?? [];
      setOrgs(list);
      if (list[0]) setOrg(list[0]);
    }).catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!org) return;
    api.get(`/orgs/${org.slug}/projects`).then((r) => {
      const list = r.data.data ?? [];
      setProjects(list);
      if (list[0]) setProject(list[0]);
    }).catch(() => undefined);
  }, [org]);

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  return (
    <aside className="w-64 shrink-0 border-r border-surface-border bg-surface-raised flex flex-col sticky top-0 h-screen">
      {/* Brand */}
      <div className="flex items-center gap-2.5 px-5 h-16 border-b border-surface-border">
        <div className="w-8 h-8 rounded-lg bg-accent/15 grid place-items-center">
          <TerminalSquare className="w-5 h-5 text-accent" />
        </div>
        <div>
          <div className="font-semibold text-white leading-tight">JobScheduler</div>
          <div className="text-[11px] text-slate-500">distributed platform</div>
        </div>
      </div>

      {/* Org / project selector */}
      <div className="px-4 py-4 space-y-2 relative">
        <button
          onClick={() => setOrgOpen((v) => !v)}
          className="w-full flex items-center justify-between px-3 py-2 rounded-lg hover:bg-surface-overlay text-left"
        >
          <span className="flex items-center gap-2 min-w-0">
            <FolderKanban className="w-4 h-4 text-slate-500 shrink-0" />
            <span className="truncate text-sm text-slate-200">{org?.name ?? 'No organization'}</span>
          </span>
          <ChevronDown className={`w-4 h-4 text-slate-500 transition-transform ${orgOpen ? 'rotate-180' : ''}`} />
        </button>
        {orgOpen && (
          <div className="absolute z-20 left-4 right-4 mt-1 card !p-2 shadow-xl">
            {orgs.map((o) => (
              <button
                key={o.id}
                onClick={() => { setOrg(o); setOrgOpen(false); }}
                className="w-full text-left px-3 py-2 rounded-md text-sm hover:bg-surface-overlay"
              >
                {o.name}
                <span className="ml-2 text-[10px] uppercase text-slate-500">{o.myRole}</span>
              </button>
            ))}
            {orgs.length === 0 && <div className="px-3 py-2 text-sm text-slate-500">No orgs yet</div>}
          </div>
        )}
        {project && (
          <NavLink
            to={`/projects/${project.id}/queues`}
            className="block pl-10 pr-3 py-1.5 text-xs text-slate-400 hover:text-white truncate"
          >
            {project.name}
          </NavLink>
        )}
      </div>

      {/* Navigation */}
      <nav className="flex-1 overflow-y-auto px-3 pb-4 space-y-1">
        <SideLink to="/" icon={<LayoutDashboard className="w-4 h-4" />} label="Dashboard" end />
        {project && (
          <SideLink to={`/projects/${project.id}/queues`} icon={<Layers className="w-4 h-4" />} label="Queues" />
        )}
        <SideLink to="/workers" icon={<Cpu className="w-4 h-4" />} label="Workers" />
        {project && (
          <>
            <SideLink to={project ? `/projects/${project.id}/metrics` : '/'} icon={<BarChart3 className="w-4 h-4" />} label="Metrics" />
          </>
        )}
        <div className="pt-4 pb-1 px-3 text-[11px] font-semibold uppercase tracking-wider text-slate-600">
          Reliability
        </div>
        <SideLink to={project ? `/queues/${project.id}/schedules` : '/'} icon={<CalendarClock className="w-4 h-4" />} label="Schedules" disabled={!project} />
        <SideLink to={project ? `/queues/${project.id}/dlq` : '/'} icon={<AlertOctagon className="w-4 h-4" />} label="Dead Letters" disabled={!project} />
      </nav>

      {/* User footer */}
      <div className="border-t border-surface-border p-4 flex items-center justify-between">
        <div className="min-w-0">
          <div className="text-sm text-slate-200 truncate">{user?.name}</div>
          <div className="text-xs text-slate-500 truncate">{user?.email}</div>
        </div>
        <button onClick={handleLogout} className="btn-ghost !px-2" title="Sign out">
          <LogOut className="w-4 h-4" />
        </button>
      </div>
    </aside>
  );
}

function SideLink({
  to, icon, label, end, disabled,
}: {
  to: string; icon: React.ReactNode; label: string; end?: boolean; disabled?: boolean;
}) {
  if (disabled) {
    return (
      <span className="flex items-center gap-3 px-3 py-2 rounded-lg text-sm text-slate-600 cursor-not-allowed">
        {icon} {label}
      </span>
    );
  }
  return (
    <NavLink
      to={to}
      end={end}
      className={({ isActive }) =>
        `flex items-center gap-3 px-3 py-2 rounded-lg text-sm transition-colors ${
          isActive ? 'bg-accent-soft text-accent' : 'text-slate-400 hover:bg-surface-overlay hover:text-white'
        }`
      }
    >
      {icon} {label}
    </NavLink>
  );
}
