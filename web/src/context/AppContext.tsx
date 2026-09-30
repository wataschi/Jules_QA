/**
 * Глобальний контекст: проєкт, тема, тости, ім'я користувача.
 * Жодного опитування тут немає — лише те, що потрібно всьому застосунку.
 */

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { api, getUserName, setUserName as persistUserName } from '../api';
import { useAsync } from '../hooks/useAsync';
import type { Project } from '../types';

/* ────────────────────────────────── тема ─────────────────────────────── */

export type ThemeChoice = 'light' | 'dark' | 'system';
const LS_THEME = 'julesTheme';

function readTheme(): ThemeChoice {
  try {
    const raw = localStorage.getItem(LS_THEME);
    if (raw === 'light' || raw === 'dark') return raw;
  } catch {
    /* localStorage заблокований — лишаємо системну тему */
  }
  return 'system';
}

function applyTheme(choice: ThemeChoice): void {
  const root = document.documentElement;
  if (choice === 'system') delete root.dataset.theme;
  else root.dataset.theme = choice;
  try {
    if (choice === 'system') localStorage.removeItem(LS_THEME);
    else localStorage.setItem(LS_THEME, choice);
  } catch {
    /* вибір не переживе перезавантаження — не критично */
  }
}

/* ────────────────────────────────── тости ────────────────────────────── */

export type ToastTone = 'info' | 'good' | 'warn' | 'bad';

export interface Toast {
  id: number;
  text: string;
  tone: ToastTone;
  action?: { label: string; run: () => void };
}

export interface ToastInput {
  text: string;
  tone?: ToastTone;
  action?: { label: string; run: () => void };
  /** мс; 0 — не прибирати автоматично */
  timeout?: number;
}

/* ─────────────────────────────── контекст ───────────────────────────── */

interface AppValue {
  projectId: string;
  project: Project | undefined;
  projects: Project[];
  projectsLoading: boolean;
  projectsError: string | null;
  reloadProjects: () => void;
  setProjectId: (id: string) => void;

  userName: string;
  setUserName: (name: string) => void;

  theme: ThemeChoice;
  setTheme: (choice: ThemeChoice) => void;
  /** Що показує перемикач: наступна тема. */
  toggleTheme: () => void;

  toasts: Toast[];
  toast: (input: ToastInput | string) => void;
  dismissToast: (id: number) => void;
}

const AppContext = createContext<AppValue | null>(null);

const LS_PROJECT = 'julesProjectId';

function readProjectId(): string {
  // Проєкт з адреси важливіший за збережений: переслане посилання має
  // відкривати саме той проєкт, який мав на увазі автор посилання.
  try {
    const fromUrl = new URLSearchParams(window.location.search).get('projectId');
    if (fromUrl) return fromUrl;
  } catch {
    /* нічого */
  }
  try {
    return localStorage.getItem(LS_PROJECT) ?? '';
  } catch {
    return '';
  }
}

let toastSeq = 0;

export function AppProvider({ children }: { children: ReactNode }) {
  const [projectId, setProjectIdState] = useState(readProjectId);
  const [userName, setUserNameState] = useState(getUserName);
  const [theme, setThemeState] = useState<ThemeChoice>(readTheme);
  const [toasts, setToasts] = useState<Toast[]>([]);

  const location = useLocation();
  const navigate = useNavigate();

  const projectsState = useAsync((signal) => api.listProjects(signal), []);
  const projects = projectsState.data ?? [];

  // Адреса → стан: відкрили посилання з іншим проєктом — перемикаємось на нього.
  useEffect(() => {
    const fromUrl = new URLSearchParams(location.search).get('projectId');
    if (!fromUrl || fromUrl === projectId) return;
    setProjectIdState(fromUrl);
    try {
      localStorage.setItem(LS_PROJECT, fromUrl);
    } catch {
      /* нічого */
    }
  }, [location.search, projectId]);

  // Стан → адреса: тримаємо projectId в URL, щоб будь-яке посилання можна було переслати.
  useEffect(() => {
    if (!projectId) return;
    const params = new URLSearchParams(location.search);
    if (params.get('projectId') === projectId) return;
    params.set('projectId', projectId);
    navigate({ pathname: location.pathname, search: params.toString() }, { replace: true });
  }, [projectId, location.pathname, location.search, navigate]);

  // Якщо проєкт не вибраний або зник — беремо перший зі списку.
  useEffect(() => {
    if (!projects.length) return;
    if (projectId && projects.some((p) => p.id === projectId)) return;
    const first = projects[0].id;
    setProjectIdState(first);
    try {
      localStorage.setItem(LS_PROJECT, first);
    } catch {
      /* нічого */
    }
  }, [projects, projectId]);

  const setProjectId = useCallback((id: string) => {
    setProjectIdState(id);
    try {
      localStorage.setItem(LS_PROJECT, id);
    } catch {
      /* нічого */
    }
  }, []);

  const setUserName = useCallback((name: string) => {
    setUserNameState(name);
    persistUserName(name);
  }, []);

  const setTheme = useCallback((choice: ThemeChoice) => {
    setThemeState(choice);
    applyTheme(choice);
  }, []);

  const toggleTheme = useCallback(() => {
    setThemeState((current) => {
      const prefersDark =
        typeof window !== 'undefined' &&
        typeof window.matchMedia === 'function' &&
        window.matchMedia('(prefers-color-scheme: dark)').matches;
      const effective = current === 'system' ? (prefersDark ? 'dark' : 'light') : current;
      const next: ThemeChoice = effective === 'dark' ? 'light' : 'dark';
      applyTheme(next);
      return next;
    });
  }, []);

  const dismissToast = useCallback((id: number) => {
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const toast = useCallback(
    (input: ToastInput | string) => {
      const normalized: ToastInput = typeof input === 'string' ? { text: input } : input;
      const id = ++toastSeq;
      const item: Toast = {
        id,
        text: normalized.text,
        tone: normalized.tone ?? 'info',
        action: normalized.action,
      };
      setToasts((list) => [...list.slice(-3), item]);
      const timeout = normalized.timeout ?? (normalized.action ? 12_000 : 5_000);
      if (timeout > 0) {
        window.setTimeout(() => dismissToast(id), timeout);
      }
    },
    [dismissToast],
  );

  const value = useMemo<AppValue>(
    () => ({
      projectId,
      project: projects.find((p) => p.id === projectId),
      projects,
      projectsLoading: projectsState.loading,
      projectsError: projectsState.error,
      reloadProjects: projectsState.reload,
      setProjectId,
      userName,
      setUserName,
      theme,
      setTheme,
      toggleTheme,
      toasts,
      toast,
      dismissToast,
    }),
    [
      projectId,
      projects,
      projectsState.loading,
      projectsState.error,
      projectsState.reload,
      setProjectId,
      userName,
      setUserName,
      theme,
      setTheme,
      toggleTheme,
      toasts,
      toast,
      dismissToast,
    ],
  );

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp має викликатися всередині <AppProvider>');
  return value;
}

/** Зручний доступ лише до тостів. */
export function useToast(): (input: ToastInput | string) => void {
  return useApp().toast;
}
