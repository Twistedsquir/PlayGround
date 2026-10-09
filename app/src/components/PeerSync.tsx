// Direct sync over a WebRTC data channel — no accounts, no cloud.
// One phone hosts (creates an invitation code), the other joins with it,
// then both swap snapshots. Works when both phones are online together;
// nothing waits in the middle for anyone.
import { useEffect, useRef, useState } from 'react';
import { hostAcceptAnswer, hostCreateOffer, joinAcceptOffer, type PeerLink } from '../lib/peer';
import { applyDump, buildDump, type Dump } from '../lib/peerSync';

// Data-channel messages have size limits (photos!), so big snapshots travel
// in 48 KB pieces and are reassembled on arrival.
const PIECE = 48 * 1024;

function sendBig(link: PeerLink, msg: unknown): void {
  const s = JSON.stringify(msg);
  if (s.length <= PIECE) {
    link.send({ t: 'one', data: msg });
    return;
  }
  const id = Math.random().toString(36).slice(2);
  const n = Math.ceil(s.length / PIECE);
  for (let i = 0; i < n; i++) {
    link.send({ t: 'piece', id, i, n, data: s.slice(i * PIECE, (i + 1) * PIECE) });
  }
}

export default function PeerSync({ onChanged }: { onChanged: () => void }) {
  const [mode, setMode] = useState<'host' | 'join'>('host');
  const [myCode, setMyCode] = useState('');
  const [theirCode, setTheirCode] = useState('');
  const [state, setState] = useState('idle');
  const [report, setReport] = useState('');
  const [busy, setBusy] = useState(false);
  const linkRef = useRef<PeerLink | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const stats = useRef({ applied: 0, already: 0, conflicts: 0 });
  const sentDone = useRef(false);
  const gotDone = useRef(false);
  const pieces = useRef(new Map<string, { n: number; parts: string[] }>());
  const stateRef = useRef(state);
  stateRef.current = state;

  const finish = () => {
    setReport(
      `Direct sync complete: ${stats.current.applied} records updated, ` +
      `${stats.current.already} already matched` +
      (stats.current.conflicts
        ? `, ${stats.current.conflicts} need your pick below (nothing overwritten).`
        : '. No conflicts.'),
    );
    onChanged();
  };

  const maybeFinish = () => {
    if (sentDone.current && gotDone.current) finish();
  };

  const sendDump = async () => {
    const link = linkRef.current;
    if (!link) return;
    sentDone.current = false;
    gotDone.current = false;
    stats.current = { applied: 0, already: 0, conflicts: 0 };
    const dump = await buildDump();
    for (const [table, rows] of Object.entries(dump)) {
      sendBig(link, { t: 'dump', table, rows });
    }
    link.send({ t: 'one', data: { t: 'dump-done' } });
    sentDone.current = true;
    maybeFinish();
  };

  const onMsg = async (m: { t: string; data?: unknown; id?: string; i?: number; n?: number }) => {
    if (m.t === 'piece') {
      const e = pieces.current.get(m.id as string) ?? { n: m.n as number, parts: [] };
      e.parts[m.i as number] = m.data as string;
      pieces.current.set(m.id as string, e);
      if (e.parts.filter(Boolean).length === e.n) {
        pieces.current.delete(m.id as string);
        await onMsg({ t: 'one', data: JSON.parse(e.parts.join('')) });
      }
      return;
    }
    const d = m.data as { t: string; table?: string; rows?: Dump[string] };
    if (d.t === 'dump' && d.table && d.rows) {
      const r = await applyDump({ [d.table]: d.rows });
      stats.current.applied += r.applied;
      stats.current.already += r.already;
      stats.current.conflicts += r.conflicts;
      setReport(`Receiving… ${stats.current.applied} updated so far.`);
    } else if (d.t === 'dump-done') {
      gotDone.current = true;
      maybeFinish();
    }
  };

  const hook = (link: PeerLink) => {
    linkRef.current = link;
    link.onState = (s) => {
      setState(s);
      if (s === 'open') void sendDump();
      if (s === 'failed') setReport('Could not reach the other phone. Same Wi-Fi on both, then try again. Strict office/hotel networks can block direct connections.');
    };
    link.onMessage = (m) => { void onMsg(m as never); };
  };

  const disconnect = () => {
    linkRef.current?.close();
    pcRef.current?.close();
    linkRef.current = null;
    pcRef.current = null;
    setState('idle');
    setMyCode('');
    setTheirCode('');
  };

  useEffect(() => () => disconnect(), []); // eslint-disable-line react-hooks/exhaustive-deps

  const doHost = async () => {
    setBusy(true);
    setReport('');
    try {
      const { code, link, pc } = await hostCreateOffer();
      pcRef.current = pc;
      hook(link);
      setMyCode(code);
      setState('waiting');
      setReport('Invitation ready — send it to the other phone, then paste their reply below.');
    } catch (e) {
      setReport(e instanceof Error ? e.message : 'Could not start.');
    } finally {
      setBusy(false);
    }
  };

  const doJoin = async () => {
    if (!theirCode.trim()) {
      setReport('Paste their invitation code first.');
      return;
    }
    setBusy(true);
    setReport('');
    try {
      const { code, link, pc } = await joinAcceptOffer(theirCode);
      pcRef.current = pc;
      hook(link);
      setMyCode(code);
      setState('connecting');
      setReport('Reply ready — send it back, then keep this screen open. Connecting…');
    } catch {
      setReport('That code did not scan. Copy the whole invitation text exactly.');
    } finally {
      setBusy(false);
    }
  };

  const doAnswer = async () => {
    if (!theirCode.trim() || !pcRef.current) {
      setReport('Paste their reply code first.');
      return;
    }
    try {
      await hostAcceptAnswer(pcRef.current, theirCode);
      setState('connecting');
      setReport('Reply accepted — connecting… keep both phones awake.');
    } catch {
      setReport('That reply did not scan. Copy the whole reply text exactly.');
    }
  };

  const copy = async (s: string) => {
    try {
      await navigator.clipboard.writeText(s);
      setReport('Copied — send it to the other phone (message, AirDrop, …).');
    } catch {
      setReport('Copy failed — long-press the text and copy it by hand.');
    }
  };

  return (
    <article className="card">
      <h2>📡 Direct sync (no cloud)</h2>
      <p className="muted tiny">
        Both phones online + this screen open on both. Codes are plain text — swap them any
        time, but the connection itself needs you together. Nothing is overwritten silently;
        disagreements land in the conflict inbox below.
      </p>
      <div className="row gap pad">
        <button className={mode === 'host' ? 'btn primary' : 'btn'} onClick={() => setMode('host')}>This phone shares</button>
        <button className={mode === 'join' ? 'btn primary' : 'btn'} onClick={() => setMode('join')}>Connect to theirs</button>
        {(state !== 'idle') && <button className="btn" onClick={disconnect}>Disconnect</button>}
      </div>
      <p className="muted tiny" role="status">Status: {state}{state === 'open' ? ' — connected' : ''}</p>

      {mode === 'host' && (
        <div className="card form">
          <button className="btn primary" disabled={busy || !!myCode} onClick={doHost}>
            {busy ? '…' : '1. Create invitation'}
          </button>
          {myCode && (
            <>
              <label>Invitation — send this to the other phone
                <textarea className="input code" rows={4} readOnly value={myCode} onFocus={(e) => e.target.select()} />
              </label>
              <button className="btn" onClick={() => copy(myCode)}>Copy invitation</button>
              <label>Their reply — paste here, then connect
                <textarea className="input code" rows={4} value={theirCode} onChange={(e) => setTheirCode(e.target.value)} placeholder="Paste their reply…" />
              </label>
              <button className="btn primary" onClick={doAnswer}>2. Connect</button>
            </>
          )}
        </div>
      )}

      {mode === 'join' && (
        <div className="card form">
          <label>Their invitation — paste here
            <textarea className="input code" rows={4} value={theirCode} onChange={(e) => setTheirCode(e.target.value)} placeholder="Paste their invitation…" />
          </label>
          <button className="btn primary" disabled={busy || !!myCode} onClick={doJoin}>
            {busy ? '…' : '1. Create reply'}
          </button>
          {myCode && (
            <>
              <label>Reply — send this back to them
                <textarea className="input code" rows={4} readOnly value={myCode} onFocus={(e) => e.target.select()} />
              </label>
              <button className="btn" onClick={() => copy(myCode)}>Copy reply</button>
              <p className="muted tiny">Now keep this screen open — it connects on its own and syncs.</p>
            </>
          )}
        </div>
      )}

      {state === 'open' && (
        <button className="btn primary big" onClick={() => { setReport('Syncing…'); void sendDump(); }}>⟳ Sync again</button>
      )}
      {report && <p className="muted" role="status">{report}</p>}
    </article>
  );
}
