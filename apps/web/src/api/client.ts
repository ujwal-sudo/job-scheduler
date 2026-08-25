import axios from 'axios';
import { useAuthStore } from '../store/auth';

export const api = axios.create({ baseURL: '/api/v1' });

api.interceptors.request.use((config) => {
  const token = useAuthStore.getState().accessToken;
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

let onUnauthorized: (() => void) | null = null;
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

api.interceptors.response.use(
  (res) => res,
  async (error) => {
    const original = error.config;
    if (error.response?.status === 401 && !original._retried) {
      original._retried = true;
      const refreshed = await useAuthStore.getState().tryRefresh();
      if (refreshed) return api(original);
      onUnauthorized?.();
      useAuthStore.getState().logout();
    }
    return Promise.reject(error);
  },
);

/** Extract the standard envelope data or throw a readable error. */
export async function unwrap<T>(p: Promise<{ data: { data: T; meta?: unknown } }>): Promise<T> {
  const res = await p;
  return res.data.data;
}
