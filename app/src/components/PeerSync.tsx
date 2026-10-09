// Direct sync, simplified: share a 6-letter code, join with it, watch the
// "both online" light, done. No accounts, no cloud.
//
// How it works (plain words): both phones tune into the same short-code
// "radio channel" on a free public relay just long enough to swap
// connection notes automatically. Household data itself travels only over
// the direct encrypted phone-to-phone link built afterwards — never the relay.
import { useEffect, useRef, useState } from 'react';
import { acceptRemotePeer, createAnswerPeer, createOfferPeer, hostAcceptAnswer, hostCreateOffer, joinAcceptOffer, type PeerLink } from '../lib/peer';
import { applyDump, buildDump, type Dump } from '../lib/peerSync';
import { deviceId, newPairCode, normalizeCode, openRelay, roomTopic, type RelayHandle, type RelayNote } from '../lib/relay';

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

interface Presence {
  name: string;
  at: number;
}

function myName(): string {
  return localStorage.getItem('fm.deviceName') ?? '';
}

export default function PeerSync({ onChanged }: { onChanged: () => void }) {
  const [name, setName] = useState(myName());
  const [mode, setMode] = useState<'share' | 'join'>('share');
  const [code, setCode] = useState('');
  const [joinInput, setJoinInput] = useState('');
  const [phase, setPhase] = useState<'idle' | 'waiting' | 'connected'>('idle');
  const [peers, setPeers] = useState<Record<string, Presence>>({});
  const [relayLive, setRelayLive] = useState(false);
  const [report, setReport] = useState('');
  const [busy, setBusy] = useState(false);
  const [manualMine, setManualMine] = useState('');
  const [manualTheirs, setManualTheirs] = useState('');

  const relayRef = useRef<RelayHandle | null>(null);
  const linkRef = useRef<PeerLink | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const offerRef = useRef<RTCSessionDescriptionInit | null>(null);
  const answerRef = useRef<RTCSessionDescriptionInit | null>(null);
  const roleRef = useRef<'share' | 'join'>('share');
  const connectedRef = useRef(false);
  const doneRef = useRef(false);
  const stats = useRef({ applied: 0, already: 0, conflicts: 0 });
  const sentDone = useRef(false);
  const gotDone = useRef(false);
  const pieces = useRef(new Map<string, { n: number; parts: string[] }>());
  const timer = useRef<number | null>(null);

  const saveName = (v: string) => {
    setName(v);
    localStorage.setItem('fm.deviceName', v);
  };

  const stop = () => {
    if (timer.current) window.clearInterval(timer.current);
    timer.current = null;
    relayRef.current?.close();
    relayRef.current = null;
    linkRef.current?.close();
    linkRef.current = null;
    try { pcRef.current?.close(); } catch { /* ignore */ }
    pcRef.current = null;
    offerRef.current = null;
    answerRef.current = null;
    connectedRef.current = false;
    doneRef.current = false;
    sentDone.current = false;
    gotDone.current = false;
    setPhase('idle');
    setPeers({});
    setRelayLive(false);
  };

  useEffect(() => () => {
    if (timer.current) window.clearInterval(timer.current);
    relayRef.current?.close();
    linkRef.current?.close();
    try { pcRef.current?.close(); } catch { /* ignore */ }
  }, []);

  const touchPeer = (id: string, peerName: string) => {
    setPeers((p) => ({ ...p, [id]: { name: peerName || 'Partner', at: Date.now() } }));
  };

  // ---- snapshot swap (same as before) ----

  const finish = () => {
    setReport(
      `Synced: ${stats.current.applied} updated, ${stats.current.already} already matched` +
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
      setReport(`Syncing… ${stats.current.applied} updated so far.`);
    } else if (d.t === 'dump-done') {
      gotDone.current = true;
      maybeFinish();
    }
  };

  const hookLink = (link: PeerLink) => {
    linkRef.current = link;
    link.onState = (s) => {
      if (s === 'open') {
        connectedRef.current = true;
        setPhase('connected');
        setReport('Connected — syncing…');
        void sendDump();
      }
      if (s === 'failed') setReport('Could not reach the other phone directly. Same Wi-Fi on both works best — or use manual codes below.');
      if (s === 'closed' && !doneRef.current) setReport('Connection closed.');
    };
    link.onMessage = (m) => { void onMsg(m as never); };
  };

  const finishHandshake = () => {
    if (doneRef.current) return;
    doneRef.current = true;
  };

  // ---- automatic pairing over the relay ----

  const onRelayNote = async (role: 'share' | 'join', n: RelayNote) => {
    if (n.kind === 'presence') {
      touchPeer(n.from, String(n.name ?? 'Partner'));
      return;
    }
    if (doneRef.current) return;
    try {
      if (role === 'share' && n.kind === 'hello' && offerRef.current && pcRef.current) {
        // joiner arrived late or retrying — resend our offer to them
        relayRef.current?.send('offer', { sdp: offerRef.current, to: n.from });
      } else if (role === 'share' && n.kind === 'answer' && pcRef.current) {
        if (n.to && n.to !== deviceId()) return; // answer meant for someone else
        await acceptRemotePeer(pcRef.current, n.sdp as RTCSessionDescriptionInit);
        finishHandshake();
      } else if (role === 'join' && n.kind === 'offer' && !doneRef.current) {
        if (n.to && n.to !== deviceId()) return; // offer meant for someone else
        const { sdp, link, pc } = await createAnswerPeer(n.sdp as RTCSessionDescriptionInit);
        pcRef.current = pc;
        hookLink(link);
        answerRef.current = sdp;
        relayRef.current?.send('answer', { sdp, to: n.from });
        finishHandshake();
      }
    } catch {
      setReport('Handshake hiccup — leave this open, it retries on its own. Otherwise try manual codes below.');
    }
  };

  const startPresence = (role: 'share' | 'join') => {
    roleRef.current = role;
    if (timer.current) window.clearInterval(timer.current);
    const beat = () => {
      // Retries: handshake notes are fire-and-forget over the relay, so
      // repeat the latest one until the direct link is actually open.
      if (!connectedRef.current) {
        if (role === 'join' && answerRef.current) {
          relayRef.current?.send('answer', { sdp: answerRef.current });
        } else if (role === 'join') {
          relayRef.current?.send('hello', {});
        }
      }
      relayRef.current?.send('presence', { name: name.trim() || 'Partner' });
      setRelayLive((relayRef.current?.liveCount() ?? 0) > 0);
      setPeers((p) => {
        const now = Date.now();
        const kept: Record<string, Presence> = {};
        for (const [id, v] of Object.entries(p)) {
          if (now - v.at < 45000) kept[id] = v;
        }
        return kept;
      });
    };
    beat();
    timer.current = window.setInterval(beat, 8000);
    // give up loudly if nobody shows
    window.setTimeout(() => {
      if (!connectedRef.current) {
        setReport('Still waiting — check the code matches on both phones, both have internet, and this screen is open on both. Manual codes below are the fallback.');
      }
    }, 75000);
  };

  const share = async () => {
    stop();
    setBusy(true);
    setReport('');
    try {
      const c = newPairCode();
      setCode(c);
      const relay = openRelay(roomTopic(c), (n) => void onRelayNote('share', n));
      relayRef.current = relay;
      const { sdp, link, pc } = await createOfferPeer();
      pcRef.current = pc;
      hookLink(link);
      offerRef.current = sdp;
      startPresence('share');
      relay.send('offer', { sdp });
      relay.send('hello', { sharer: true });
      setPhase('waiting');
      setReport('Code ready — tell it to the other phone, then keep this open.');
    } catch (e) {
      setReport(e instanceof Error ? e.message : 'Could not start sharing.');
      stop();
    } finally {
      setBusy(false);
    }
  };

  const join = async () => {
    const c = normalizeCode(joinInput);
    if (c.length < 4) {
      setReport('Type the 6-letter code first.');
      return;
    }
    stop();
    setBusy(true);
    setReport('');
    try {
      setCode(c);
      const relay = openRelay(roomTopic(c), (n) => void onRelayNote('join', n));
      relayRef.current = relay;
      startPresence('join');
      relay.send('hello', {});
      setPhase('waiting');
      setReport(`Joining ${c}… keep this open. It connects on its own.`);
    } catch (e) {
      setReport(e instanceof Error ? e.message : 'Could not join.');
      stop();
    } finally {
      setBusy(false);
    }
  };

  // ---- manual fallback (giant codes, no relay) ----

  const manualHost = async () => {
    try {
      const { code: c, link, pc } = await hostCreateOffer();
      pcRef.current = pc;
      linkRef.current = link;
      hookLink(link);
      setManualMine(c);
      setReport('Manual invitation ready — send it over, then paste their reply below and press Connect.');
    } catch (e) {
      setReport(e instanceof Error ? e.message : 'Could not start.');
    }
  };

  const manualJoin = async () => {
    try {
      const { code: c, link, pc } = await joinAcceptOffer(manualTheirs);
      pcRef.current = pc;
      linkRef.current = link;
      hookLink(link);
      setManualMine(c);
      setPhase('connected');
      setReport('Reply ready — send it back, then keep this open. It connects on its own.');
    } catch {
      setReport('That code did not scan. Copy the whole text exactly.');
    }
  };

  const manualConnect = async () => {
    try {
      if (!pcRef.current) return;
      await hostAcceptAnswer(pcRef.current, manualTheirs);
      setReport('Reply accepted — connecting… keep both phones awake.');
    } catch {
      setReport('That reply did not scan. Copy the whole text exactly.');
    }
  };

  const copy = async (s: string) => {
    try {
      await navigator.clipboard.writeText(s);
      setReport('Copied.');
    } catch {
      setReport('Copy failed — long-press the text and copy by hand.');
    }
  };

  const partnerIds = Object.keys(peers);
  const partnerOnline = partnerIds.length > 0;
  const lastSync = localStorage.getItem('fm.lastSync');

  return (
    <article className="card">
      <h2>📡 Direct sync (no cloud)</h2>

      <label>Your name (your partner sees this)
        <input className="input" value={name} onChange={(e) => saveName(e.target.value)} placeholder="e.g. Alex" maxLength={30} />
      </label>

      <div className="presence" role="status" aria-label="Who is online">
        <div className="prow"><span className="dot on" /> You{name.trim() ? ` (${name.trim()})` : ''} — here</div>
        {partnerOnline ? (
          peers && Object.entries(peers).map(([id, p]) => (
            <div className="prow" key={id}>
              <span className="dot on" /> {p.name} — online
              <small className="muted"> · seen {Math.max(0, Math.round((Date.now() - p.at) / 1000))}s ago</small>
            </div>
          ))
        ) : (
          <div className="prow"><span className="dot off" /> Partner — not here yet</div>
        )}
        <div className="prow tiny muted">
          {phase === 'connected' ? '🟢 Synced channel open' : relayLive ? 'Relay reachable — waiting for partner' : 'Relay not reached yet'}
          {lastSync ? ` · Last synced ${new Date(lastSync).toLocaleString()}` : ' · Never synced'}
        </div>
      </div>

      <div className="row gap pad">
        <button className={mode === 'share' ? 'btn primary' : 'btn'} onClick={() => setMode('share')}>Share a code</button>
        <button className={mode === 'join' ? 'btn primary' : 'btn'} onClick={() => setMode('join')}>Enter a code</button>
        {phase !== 'idle' && <button className="btn" onClick={() => { stop(); setReport('Stopped.'); setCode(''); }}>Stop</button>}
      </div>

      {mode === 'share' && (
        <div className="card form">
          {phase === 'idle' ? (
            <button className="btn primary big" disabled={busy} onClick={share}>{busy ? '…' : '1. Show my code'}</button>
          ) : (
            <>
              <p className="codetitle">Tell them this code:</p>
              <p className="bigcode" aria-label={`Pairing code ${code}`}>{code.split('').join(' ')}</p>
              <button className="btn" onClick={() => copy(code)}>Copy code</button>
              <p className="muted tiny">They enter it on their phone → you connect automatically. Keep this open.</p>
            </>
          )}
        </div>
      )}

      {mode === 'join' && (
        <div className="card form">
          {phase === 'idle' ? (
            <>
              <label>Their code<input className="input biginput" value={joinInput} onChange={(e) => setJoinInput(e.target.value.toUpperCase())} placeholder="ABCDEF" maxLength={8} autoCapitalize="characters" autoComplete="off" /></label>
              <button className="btn primary big" disabled={busy} onClick={join}>{busy ? '…' : 'Join'}</button>
            </>
          ) : (
            <p className="muted">Joining <b>{code}</b>… keep this open. It connects on its own.</p>
          )}
        </div>
      )}

      {phase === 'connected' && (
        <button className="btn primary big" onClick={() => { setReport('Syncing…'); void sendDump(); }}>⟳ Sync again</button>
      )}
      {report && <p className="muted" role="status">{report}</p>}

      <details className="pad">
        <summary className="muted">Having trouble? Manual codes (no relay)</summary>
        <div className="card form">
          <div className="row gap wrap">
            <button className="btn" onClick={manualHost}>Create manual invitation</button>
            <button className="btn" onClick={manualJoin}>Make reply from paste</button>
            <button className="btn primary" onClick={manualConnect}>Connect (host)</button>
          </div>
          {manualMine && (
            <label>Your manual code<textarea className="input code" rows={3} readOnly value={manualMine} onFocus={(e) => e.target.select()} /></label>
          )}
          <label>Their manual code (paste)<textarea className="input code" rows={3} value={manualTheirs} onChange={(e) => setManualTheirs(e.target.value)} /></label>
        </div>
      </details>
    </article>
  );
}
