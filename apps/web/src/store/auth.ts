import { create } from 'zustand';

interface User {
  id: string;
  email: string;
  name: string;
}

interface AuthState {
  accessToken: string | null;
  refreshToken: string | null;
  user: User | null;
  setAuth: (t: { accessToken: string; refreshToken: string; user: User }) => void;
  tryRefresh: () => Promise<boolean>;
  logout: () => void;
}

function loadStored(): Pick<AuthState, 'accessToken' | 'refreshToken' | 'user'> {
  try {
    const raw = localStorage.getItem('js-auth');
    if (raw) return JSON.parse(raw);
  } catch {
    /* ignore */
  }
  return { accessToken: null, refreshToken: null, user: null };
}

export const useAuthStore = create<AuthState>((set, get) => ({
  ...loadStored(),

  setAuth: ({ accessToken, refreshToken, user }) => {
    const payload = { accessToken, refreshToken, user };
    localStorage.setItem('js-auth', JSON.stringify(payload));
    set(payload);
  },

  tryRefresh: async () => {
    const rt = get().refreshToken;
    if (!rt) return false;
    try {
      const res = await fetch('/api/v1/auth/refresh', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) return false;
      const body = await res.json();
      get().setAuth(body.data);
      return true;
    } catch {
      return false;
    }
  },

  logout: () => {
    localStorage.removeItem('js-auth');
    set({ accessToken: null, refreshToken: null, user: null });
  },
}));
