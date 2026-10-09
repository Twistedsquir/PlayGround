// Direct phone-to-phone transport over WebRTC data channels.
// NO server: the two phones swap invitation codes by hand (message them,
// AirDrop them, read them aloud — codes are static text, so exchanging them
// can happen at different times). The actual connection needs both phones
// online with the app open at the same moment.
//
// Limits, stated plainly:
// - No store-and-forward: unlike cloud sync, nothing waits for the other
//   phone. Both must be present to sync.
// - Uses a free public STUN helper (Google's) so the phones can find a
//   network path to each other. Same home Wi-Fi almost always works;
//   strict office/hotel networks may block it, and there is no paid TURN
//   relay fallback in this version.

export type PeerRole = 'host' | 'join';
export type PeerState = 'idle' | 'waiting' | 'connecting' | 'open' | 'closed' | 'failed';

const STUN = 'stun:stun.l.google.com:19302';
const CHANNEL = 'fm-sync';

function encode(o: unknown): string {
  return btoa(unescape(encodeURIComponent(JSON.stringify(o))));
}

function decode<T>(s: string): T {
  return JSON.parse(decodeURIComponent(escape(atob(s.trim())))) as T;
}

function waitGathering(pc: RTCPeerConnection): Promise<void> {
  if (pc.iceGatheringState === 'complete') return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Finding a network path took too long. Same Wi-Fi works best — try again.')), 20000);
    pc.addEventListener('icegatheringstatechange', function h() {
      if (pc.iceGatheringState === 'complete') {
        clearTimeout(timer);
        pc.removeEventListener('icegatheringstatechange', h);
        resolve();
      }
    });
  });
}

export interface PeerLink {
  role: PeerRole;
  state: PeerState;
  send: (msg: unknown) => void;
  close: () => void;
  onState: (s: PeerState) => void;
  onMessage: (m: never) => void;
}

function makeLink(pc: RTCPeerConnection, role: PeerRole): PeerLink {
  let channel: RTCDataChannel | null = null;
  const link: PeerLink = {
    role,
    state: 'connecting',
    send: (msg) => channel?.send(JSON.stringify(msg)),
    close: () => {
      try { channel?.close(); } catch { /* ignore */ }
      pc.close();
      link.state = 'closed';
      link.onState('closed');
    },
    onState: () => {},
    onMessage: () => {},
  };
  const setState = (s: PeerState) => {
    link.state = s;
    link.onState(s);
  };
  const attach = (ch: RTCDataChannel) => {
    channel = ch;
    ch.onopen = () => setState('open');
    ch.onclose = () => setState('closed');
    ch.onmessage = (e) => {
      try {
        link.onMessage(JSON.parse(e.data as string) as never);
      } catch { /* ignore garbled frames */ }
    };
  };
  if (role === 'host') {
    attach(pc.createDataChannel(CHANNEL, { ordered: true }));
  } else {
    pc.ondatachannel = (e) => attach(e.channel);
  }
  pc.onconnectionstatechange = () => {
    if (pc.connectionState === 'failed') setState('failed');
    if (pc.connectionState === 'disconnected') setState('connecting');
    if (pc.connectionState === 'connected' && link.state !== 'open') {
      // channel open event follows shortly; don't fake it
    }
  };
  return link;
}

function newPc(): RTCPeerConnection {
  return new RTCPeerConnection({ iceServers: [{ urls: STUN }] });
}

// Host step 1: create an invitation code. Send it to the other phone.
export async function hostCreateOffer(): Promise<{ code: string; link: PeerLink; pc: RTCPeerConnection }> {
  const pc = newPc();
  const link = makeLink(pc, 'host');
  const offer = await pc.createOffer();
  await pc.setLocalDescription(offer);
  await waitGathering(pc);
  return { code: encode({ sdp: pc.localDescription }), link, pc };
}

// Host step 2: paste the joiner's reply code to finish connecting.
export async function hostAcceptAnswer(pc: RTCPeerConnection, answerCode: string): Promise<void> {
  const { sdp } = decode<{ sdp: RTCSessionDescriptionInit }>(answerCode);
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
}

// Joiner: paste the host's invitation code, get back a reply code for the host.
export async function joinAcceptOffer(offerCode: string): Promise<{ code: string; link: PeerLink; pc: RTCPeerConnection }> {
  const { sdp } = decode<{ sdp: RTCSessionDescriptionInit }>(offerCode);
  const pc = newPc();
  const link = makeLink(pc, 'join');
  await pc.setRemoteDescription(new RTCSessionDescription(sdp));
  const answer = await pc.createAnswer();
  await pc.setLocalDescription(answer);
  await waitGathering(pc);
  return { code: encode({ sdp: pc.localDescription }), link, pc };
}
