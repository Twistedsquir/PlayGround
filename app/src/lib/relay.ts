// Rendezvous relay: swap handshake notes through free public signaling
// servers (the same ones the Yjs project runs for everyone). No account,
// nothing stored: the server only shouts each note to whoever is listening
// on the same short-code topic RIGHT NOW, then forgets it.
//
// Privacy, stated plainly: the relay sees connection-setup notes (which
// contain network addresses, like a caller-ID) and chosen display names.
// It NEVER sees household data — recipes, plans, groceries only travel the
// direct encrypted phone-to-phone channel built afterwards.
//
// Protocol (y-webrtc bin/server.js): connect websocket, send
// {"type":"subscribe","topics":[topic]}, send {"type":"publish","topic":...}
// to broadcast. The server echoes our own notes back, so every note carries
// a random id and sender, and we ignore our own + duplicates.
import { nowIso } from './types';

export const RELAY_URLS = [
  'wss://y-webrtc-eu.fly.dev',
  'wss://signaling.yjs.dev',
];

export interface RelayNote {
  mid: string;
  from: string;
  kind: 'hello' | 'offer' | 'answer' | 'presence';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  [k: string]: any;
}

export interface RelayHandle {
  send: (kind: RelayNote['kind'], extra?: Record<string, unknown>) => void;
  close: () => void;
  liveCount: () => number;
}

export function deviceId(): string {
  let id = localStorage.getItem('fm.deviceId');
  if (!id) {
    id = Math.random().toString(36).slice(2) + Date.now().toString(36);
    localStorage.setItem('fm.deviceId', id);
  }
  return id;
}

// 6-letter codes without lookalikes (no 0/O, 1/I/L). ~1B combinations.
export const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

export function newPairCode(): string {
  return Array.from({ length: 6 }, () => CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)]).join('');
}

export function normalizeCode(s: string): string {
  // 0/O are misreads of Q (the only round letter in the alphabet).
  // 1/I/L never appear in real codes — drop them so a typo reads short
  // and the user rechecks instead of joining the wrong room.
  return s.trim().toUpperCase()
    .replace(/0/g, 'Q').replace(/O/g, 'Q')
    .replace(/[^A-Z2-9]/g, '');
}

export function roomTopic(code: string): string {
  return `family-meals-v1-${normalizeCode(code)}`;
}

export function openRelay(topic: string, onNote: (n: RelayNote) => void): RelayHandle {
  const me = deviceId();
  const seen = new Set<string>();
  const sockets = new Set<WebSocket>();
  let closed = false;

  const handle: RelayHandle = {
    send: (kind, extra) => {
      const note: RelayNote = { mid: Math.random().toString(36).slice(2), from: me, kind, at: nowIso(), ...extra };
      const wire = JSON.stringify({ type: 'publish', topic, ...note });
      sockets.forEach((ws) => {
        if (ws.readyState === WebSocket.OPEN) {
          try { ws.send(wire); } catch { /* drop, other relays carry it */ }
        }
      });
    },
    close: () => {
      closed = true;
      sockets.forEach((ws) => { try { ws.close(); } catch { /* ignore */ } });
      sockets.clear();
    },
    liveCount: () => [...sockets].filter((ws) => ws.readyState === WebSocket.OPEN).length,
  };

  for (const url of RELAY_URLS) {
    try {
      const ws = new WebSocket(url);
      ws.onopen = () => {
        if (closed) {
          try { ws.close(); } catch { /* ignore */ }
          return;
        }
        sockets.add(ws);
        ws.send(JSON.stringify({ type: 'subscribe', topics: [topic] }));
      };
      ws.onmessage = (e) => {
        let m: Record<string, unknown>;
        try {
          m = JSON.parse(e.data as string) as Record<string, unknown>;
        } catch {
          return;
        }
        if (m.type === 'ping') {
          try { ws.send(JSON.stringify({ type: 'pong' })); } catch { /* ignore */ }
          return;
        }
        if (m.type !== 'publish' || typeof m.mid !== 'string') return;
        if (m.from === me || seen.has(m.mid as string)) return;
        seen.add(m.mid as string);
        if (seen.size > 500) {
          // forget oldest bulk (dedupe window only needs recent notes)
          const first = seen.values().next().value as string;
          seen.delete(first);
        }
        onNote(m as unknown as RelayNote);
      };
      ws.onerror = () => { sockets.delete(ws); };
      ws.onclose = () => { sockets.delete(ws); };
    } catch { /* offline now — other relays or manual fallback cover it */ }
  }
  return handle;
}
