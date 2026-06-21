import { createContext, useContext, useEffect, useState, type ReactNode } from 'react';
import { api } from '../api';

interface LlmState {
  ok: boolean | null;
  models: string[];
  checking: boolean;
  refresh: () => void;
}

const LlmContext = createContext<LlmState>({
  ok: null,
  models: [],
  checking: true,
  refresh: () => undefined,
});

export function AppProvider({ children }: { children: ReactNode }) {
  const [ok, setOk] = useState<boolean | null>(null);
  const [models, setModels] = useState<string[]>([]);
  const [checking, setChecking] = useState(true);

  async function refresh() {
    setChecking(true);
    try {
      const r = await api.checkLlm();
      setOk(r.ok);
      setModels(r.models ?? []);
    } catch {
      setOk(false);
      setModels([]);
    } finally {
      setChecking(false);
    }
  }

  useEffect(() => {
    refresh();
    const id = setInterval(refresh, 60_000);
    return () => clearInterval(id);
  }, []);

  return (
    <LlmContext.Provider value={{ ok, models, checking, refresh }}>
      {children}
    </LlmContext.Provider>
  );
}

export function useLlm() {
  return useContext(LlmContext);
}
