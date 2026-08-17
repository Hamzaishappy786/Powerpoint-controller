import { useEffect, useRef, useState, useCallback } from 'react';

export type WSStatus = 'connecting' | 'connected' | 'disconnected';

export type ViewMode = 'normal' | 'sorter' | 'reading' | 'show' | 'other' | 'none';

/** ok = a deck is open and controllable. The others mean nothing to drive yet. */
export type PPTStatus = 'ok' | 'nopresentation' | 'nopowerpoint';

export interface SlideState {
  status: PPTStatus;
  /** File name of the live presentation, e.g. "intro.pptx". */
  name: string;
  current: number;
  total: number | string;
  mode: ViewMode;
  laser: boolean;
  /** Live cursor position on the PC, normalised 0..1. The laser sits here. */
  pointer: { x: number; y: number };
}

export function useWebSocket(url: string | null) {
  const ws = useRef<WebSocket | null>(null);
  const [status, setStatus] = useState<WSStatus>('disconnected');
  const [slide, setSlide] = useState<SlideState>({
    status: 'nopowerpoint', name: '',
    current: 0, total: '?', mode: 'other', laser: false,
    pointer: { x: 0.5, y: 0.5 },
  });
  const reconnectTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useCallback((target: string) => {
    if (ws.current) {
      ws.current.onclose = null;
      ws.current.close();
    }

    setStatus('connecting');
    const socket = new WebSocket(target.replace('http', 'ws'));
    ws.current = socket;

    socket.onopen = () => setStatus('connected');

    socket.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'state') {
          setSlide({
            status: data.status ?? 'ok',
            name: data.name ?? '',
            current: data.current,
            total: data.total,
            mode: data.mode ?? 'other',
            laser: !!data.laser,
            pointer: data.pointer ?? { x: 0.5, y: 0.5 },
          });
        }
      } catch {}
    };

    socket.onclose = () => {
      setStatus('disconnected');
      reconnectTimer.current = setTimeout(() => connect(target), 3000);
    };

    socket.onerror = () => socket.close();
  }, []);

  useEffect(() => {
    if (!url) return;
    connect(url);
    return () => {
      if (reconnectTimer.current) clearTimeout(reconnectTimer.current);
      if (ws.current) {
        ws.current.onclose = null;
        ws.current.close();
      }
    };
  }, [url, connect]);

  const send = useCallback((action: string, extra?: Record<string, unknown>) => {
    if (ws.current?.readyState === WebSocket.OPEN) {
      ws.current.send(JSON.stringify({ action, ...extra }));
    }
  }, []);

  return { status, slide, send };
}
