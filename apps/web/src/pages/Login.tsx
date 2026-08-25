import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { TerminalSquare, Loader2, AlertCircle } from 'lucide-react';
import axios from 'axios';
import { useAuthStore } from '../store/auth';

export default function Login() {
  const navigate = useNavigate();
  const setAuth = useAuthStore((s) => s.setAuth);
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const res = await axios.post('/api/v1/auth/login', { email, password });
      setAuth(res.data.data);
      navigate('/');
    } catch (err) {
      const msg =
        axios.isAxiosError(err)
          ? err.response?.data?.error?.message ?? 'Login failed'
          : 'Login failed';
      setError(msg);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="min-h-screen grid place-items-center bg-surface px-4">
      <div className="w-full max-w-sm">
        <div className="flex items-center gap-3 mb-8 justify-center">
          <div className="w-10 h-10 rounded-xl bg-accent/15 grid place-items-center">
            <TerminalSquare className="w-6 h-6 text-accent" />
          </div>
          <h1 className="text-xl font-semibold text-white">JobScheduler</h1>
        </div>

        <form onSubmit={submit} className="card space-y-4">
          <div>
            <label htmlFor="email" className="block text-sm text-slate-400 mb-1.5">Email</label>
            <input
              id="email"
              type="email"
              required
              autoComplete="email"
              className="input"
              placeholder="you@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
          </div>
          <div>
            <label htmlFor="password" className="block text-sm text-slate-400 mb-1.5">Password</label>
            <input
              id="password"
              type="password"
              required
              autoComplete="current-password"
              className="input"
              placeholder="••••••••"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
          </div>

          {error && (
            <div className="flex items-center gap-2 text-sm text-red-400 bg-red-500/10 border border-red-500/30 rounded-lg px-3 py-2">
              <AlertCircle className="w-4 h-4 shrink-0" />
              {error}
            </div>
          )}

          <button type="submit" disabled={busy} className="btn-primary w-full justify-center !py-2.5">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />}
            Sign in
          </button>

          <p className="text-xs text-center text-slate-500">
            Demo: demo@jobscheduler.dev / demo1234
          </p>
        </form>
      </div>
    </div>
  );
}
