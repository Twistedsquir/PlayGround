/* ReceiptSplit live household sharing.
   Serverless real-time sync over WebRTC data channels (PeerJS cloud — free,
   no accounts or API keys). One person hosts a room, the other joins with a
   6-letter code or invite link. Edits merge with last-write-wins + tombstones
   (see app.js op layer) so simultaneous edits converge on both sides. */
(function(){
"use strict";
const $ = s => document.querySelector(s);
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const PEER_PREFIX = 'receiptsplit-v1-';
const HEARTBEAT_MS = 10000, PEER_TIMEOUT_MS = 32000;

function randomCode(n){
  n = n || 6;
  let s = '';
  const buf = new Uint32Array(n);
  (window.crypto || {}).getRandomValues ? crypto.getRandomValues(buf) : buf.map(()=>Math.floor(Math.random()*4294967296));
  for(let i=0;i<n;i++) s += CODE_ALPHABET[buf[i] % CODE_ALPHABET.length];
  return s;
}
function randomSuffix(){ return Math.random().toString(36).slice(2,10); }
function money(n){ return (isFinite(n)?n:0).toLocaleString('en-US',{style:'currency',currency:'USD'}); }
function toast(msg){
  const wrap = $('#toasts'); if(!wrap) return;
  const el = document.createElement('div'); el.className = 'toast'; el.textContent = msg;
  wrap.appendChild(el); setTimeout(()=>el.remove(), 3200);
}

/* ---------------- transport-agnostic sync node (unit-testable) ---------------- */
function createNode(pid, hooks){
  const node = {
    pid, isHost: false, code: null,
    livePeers: new Map(), // peerPid -> {name, lastSeen}
    send: null,           // transport sets: (peerPid, msg) => void
    alive: false,          // at least one open channel
    presenceTimer: null,

    setLive(on){
      this.alive = on;
      hooks.onStatus && hooks.onStatus(this.status());
    },
    status(){
      const names = [{pid: this.pid, name: hooks.getName() + ' (you)'}];
      this.livePeers.forEach((p, id)=>names.push({pid:id, name:p.name}));
      return {alive: this.alive, isHost: this.isHost, code: this.code, peers: names};
    },
    touch(peerPid, name){
      const p = this.livePeers.get(peerPid) || {};
      if(name) p.name = name;
      p.lastSeen = Date.now();
      this.livePeers.set(peerPid, p);
    },
    prune(){
      const now = Date.now();
      let dropped = false;
      this.livePeers.forEach((p, id)=>{ if(now - (p.lastSeen||0) > PEER_TIMEOUT_MS){ this.livePeers.delete(id); dropped = true; } });
      if(dropped && this.isHost) this.broadcastPresence();
      hooks.onStatus && hooks.onStatus(this.status());
    },
    broadcastPresence(){
      if(!this.send) return;
      const peers = [];
      this.livePeers.forEach((p, id)=>peers.push({pid:id, name:p.name}));
      peers.unshift({pid:this.pid, name:hooks.getName()});
      this.livePeers.forEach((p, id)=>{ try{ this.send(id, {kind:'presence', peers}); }catch(e){} });
      hooks.onStatus && hooks.onStatus(this.status());
    },
    broadcastOp(op){
      if(!this.send || !this.alive) return;
      const msg = {kind:'op', op, from:this.pid, name:hooks.getName()};
      if(this.isHost) this.livePeers.forEach((p, id)=>{ try{ this.send(id, msg); }catch(e){} });
      else if(this.hostPid){ try{ this.send(this.hostPid, msg); }catch(e){} }
    },
    hostPid: null,

    receive(fromPid, msg){
      if(!msg || !msg.kind) return;
      switch(msg.kind){
        case 'hello': { // guest knocks (host side)
          if(!this.isHost) return;
          if(msg.snap && hooks.applySnapshot(msg.snap)) hooks.rerender();
          this.touch(fromPid, msg.name || 'Partner');
          this.setLive(true);
          try{ this.send(fromPid, {kind:'welcome', snap:hooks.snapshot(), peers:this.presenceList()}); }catch(e){}
          this.broadcastPresence();
          toast('🔗 ' + (msg.name || 'Partner') + ' joined — budgets now sync live.');
          break;
        }
        case 'welcome': { // host answers (guest side)
          if(msg.snap && hooks.applySnapshot(msg.snap)){ hooks.rerender(); toast('✅ Synced with household — you are up to date.'); }
          else toast('✅ Connected — budgets now sync live.');
          hooks.onWelcome && hooks.onWelcome();
          this.setLive(true);
          if(Array.isArray(msg.peers)) hooks.onPeers && hooks.onPeers(msg.peers);
          hooks.onStatus && hooks.onStatus(this.status());
          break;
        }
        case 'op': {
          const op = msg.op;
          if(!op || op.pid === this.pid) break; // ignore own echo
          const changed = hooks.applyOp(op);
          if(changed){
            hooks.rerender();
            if(op.t === 'receipt-add' && op.receipt) toast('🔄 ' + (msg.name || 'Partner') + ' added ' + (op.receipt.store||'a receipt') + ' ' + money(op.receipt.total));
            else if(op.t === 'receipt-del') toast('🔄 ' + (msg.name || 'Partner') + ' deleted a receipt.');
            else if(op.t === 'reset') toast('🔄 ' + (msg.name || 'Partner') + ' cleared the household budget.');
          }
          if(this.isHost) this.livePeers.forEach((p, id)=>{ if(id !== fromPid){ try{ this.send(id, {kind:'op', op, from:this.pid, name:msg.name}); }catch(e){} } });
          break;
        }
        case 'presence': {
          if(Array.isArray(msg.peers)) hooks.onPeers && hooks.onPeers(msg.peers);
          hooks.onStatus && hooks.onStatus(this.status());
          break;
        }
        case 'hb': {
          if(this.isHost) this.touch(fromPid, msg.name);
          break;
        }
        case 'bye': {
          this.livePeers.delete(fromPid);
          if(this.isHost) this.broadcastPresence();
          hooks.onStatus && hooks.onStatus(this.status());
          break;
        }
      }
    },
    presenceList(){
      const out = [{pid:this.pid, name:hooks.getName()}];
      this.livePeers.forEach((p, id)=>out.push({pid:id, name:p.name}));
      return out;
    },
    heartbeat(){
      if(!this.send || !this.alive || this.isHost) return;
      try{ this.send(this.hostPid, {kind:'hb', name:hooks.getName()}); }catch(e){}
    },
    peerGone(peerPid){
      this.livePeers.delete(peerPid);
      if(this.livePeers.size === 0) this.setLive(false);
      if(this.isHost) this.broadcastPresence();
      hooks.onStatus && hooks.onStatus(this.status());
    },
  };
  return node;
}

/* ---------------- PeerJS transport ---------------- */
let peerJsPromise = null;
function ensurePeerJs(){
  if(window.Peer) return Promise.resolve(window.Peer);
  if(peerJsPromise) return peerJsPromise;
  peerJsPromise = new Promise((res, rej)=>{
    const s = document.createElement('script');
    s.src = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.4/dist/peerjs.min.js';
    s.async = true;
    s.onload = ()=> window.Peer ? res(window.Peer) : rej(new Error('PeerJS failed to initialise'));
    s.onerror = ()=>rej(new Error('Could not load sync engine (needs internet). The app still works offline on this device.'));
    document.head.appendChild(s);
  });
  return peerJsPromise;
}
function hostPeerId(code){ return PEER_PREFIX + code + '-host'; }

const Share = {
  node: null, peer: null, conns: new Map(), timers: [],
  get active(){ return !!this.node; },
  get connected(){ return !!(this.node && this.node.alive); },
};

function myName(){ return (localStorage.getItem('receiptsplit.name') || '').trim() || 'Partner'; }
function setMyName(n){ localStorage.setItem('receiptsplit.name', (n||'').trim().slice(0,24)); }
/* Persistent room session: lets the app auto-rejoin its household room on
   launch, so edits made while this device was offline/closed sync over as
   soon as both sides are online again. Cleared only by manually leaving. */
const ROOM_LS = 'receiptsplit.room';
function saveRoom(code, role){ try{ localStorage.setItem(ROOM_LS, JSON.stringify({code, role})); }catch(e){} }
function loadRoom(){ try{ const r = JSON.parse(localStorage.getItem(ROOM_LS)); if(r && r.code && (r.role==='host'||r.role==='guest')) return r; }catch(e){} return null; }
function clearRoom(){ try{ localStorage.removeItem(ROOM_LS); }catch(e){} }

function makeHooks(){
  return {
    getName: myName,
    snapshot: ()=> window.RS.snapshot(),
    applyOp: (op)=> window.RS.remoteOp(op),
    applySnapshot: (snap)=> window.RS.remoteOp({t:'snapshot', snap}),
    rerender: ()=> window.RS.renderAll(),
    toast,
    onPeers: renderPeers,
    onStatus: renderShareStatus,
    onWelcome: ()=>{ if(Share.node && Share.node.code) saveRoom(Share.node.code, 'guest'); },
  };
}

function wireConn(node, conn, peerPid){
  node.touch(peerPid);
  conn.on('data', (msg)=>node.receive(peerPid, msg));
  conn.on('close', ()=>{ Share.conns.delete(peerPid); node.peerGone(peerPid); });
  conn.on('error', ()=>{});
  conn.on('open', ()=>{
    Share.conns.set(peerPid, conn);
    if(!node.isHost){
      // guest announces itself once the channel is usable
      try{ conn.send({kind:'hello', snap:window.RS.snapshot(), name:myName(), pid:node.pid}); }catch(e){}
    }
  });
  // inbound conns may already be open
  if(conn.open && !node.isHost){
    Share.conns.set(peerPid, conn);
    try{ conn.send({kind:'hello', snap:window.RS.snapshot(), name:myName(), pid:node.pid}); }catch(e){}
  }
  if(conn.open) Share.conns.set(peerPid, conn);
}

async function createRoom(fixedCode){
  const code = (fixedCode && /^[A-Z0-9]{4,8}$/.test(fixedCode)) ? fixedCode : randomCode();
  setStatus('Starting room…');
  try{
    await ensurePeerJs();
  }catch(e){ setStatus(e.message); toast('⚠ ' + e.message); return; }
  leaveRoom(true);
  const node = createNode('host-' + randomSuffix(), makeHooks());
  node.isHost = true; node.code = code;
  node.send = (peerPid, msg)=>{ const c = Share.conns.get(peerPid); if(c && c.open) c.send(msg); else throw new Error('closed'); };
  Share.node = node;
  const peer = new Peer(hostPeerId(code), {debug: 0});
  Share.peer = peer;
  peer.on('open', ()=>{
    showRoomView(code, true);
    saveRoom(code, 'host'); // recreate this same room on next launch
    Share.hostRetries = 0;
    setStatus('Room ' + code + ' open — waiting for your partner…');
    renderShareStatus(node.status());
  });
  peer.on('connection', (conn)=>wireConn(node, conn, conn.peer));
  peer.on('error', (err)=>{
    if(err && err.type === 'unavailable-id'){
      // Fast reload can collide with our own still-registered host id:
      // retry the SAME code so guests never get stranded on a dead room.
      Share.hostRetries = (Share.hostRetries || 0) + 1;
      if(fixedCode && Share.hostRetries < 5){ setStatus('Reopening room ' + code + '…'); setTimeout(()=>createRoom(fixedCode), 2500); }
      else { Share.hostRetries = 0; setStatus('Code collision — retrying…'); setTimeout(()=>createRoom(), 800); }
    }
    else { setStatus('Connection issue: ' + ((err && err.type) || 'unknown') + ' — still works on this device.'); }
  });
  peer.on('disconnected', ()=>{ try{ peer.reconnect(); }catch(e){} });
  Share.timers.push(setInterval(()=>node.prune(), 15000));
}

async function joinRoom(code){
  code = String(code||'').toUpperCase().replace(/[^A-Z0-9]/g,'');
  if(code.length < 4){ setStatus('Enter the 6-letter room code.'); return; }
  setStatus('Joining room ' + code + '…');
  try{
    await ensurePeerJs();
  }catch(e){ setStatus(e.message); toast('⚠ ' + e.message); return; }
  leaveRoom(true);
  const node = createNode('guest-' + randomSuffix(), makeHooks());
  node.isHost = false; node.code = code;
  node.hostPid = hostPeerId(code);
  node.send = (peerPid, msg)=>{ const c = Share.conns.get(peerPid); if(c && c.open) c.send(msg); else throw new Error('closed'); };
  Share.node = node;
  const peer = new Peer(PEER_PREFIX + 'g-' + randomSuffix());
  Share.peer = peer;
  const attempt = ()=>{
    const conn = peer.connect(node.hostPid, {reliable: true});
    Share.conns.set(node.hostPid, conn);
    wireConn(node, conn, node.hostPid);
    conn.on('error', ()=>{});
    let opened = false;
    conn.on('open', ()=>{ opened = true; showRoomView(code, false); setStatus('Connected — syncing…'); });
    setTimeout(()=>{
      if(!opened && !node.alive && Share.peer === peer){
        setStatus('Still trying to reach room ' + code + ' — is the host’s app open?');
      }
    }, 8000);
  };
  peer.on('open', attempt);
  peer.on('error', (err)=>{
    if(err && err.type === 'peer-unreachable') setStatus('Couldn’t reach room ' + code + '. Check the code and that the host is online.');
    else if(err && err.type === 'unavailable-id'){ Share.peer = new Peer(PEER_PREFIX + 'g-' + randomSuffix()); Share.peer.on('open', attempt); }
    else setStatus('Connection issue: ' + ((err && err.type) || 'unknown'));
  });
  Share.timers.push(setInterval(()=>node.heartbeat(), HEARTBEAT_MS));
  Share.timers.push(setInterval(()=>node.prune(), 15000));
  // reconnect loop while the room view is open
  Share.timers.push(setInterval(()=>{
    if(!Share.node || Share.node.isHost) return;
    const c = Share.conns.get(node.hostPid);
    if((!c || !c.open) && !document.hidden){
      try{
        const nc = Share.peer.connect(node.hostPid, {reliable:true});
        Share.conns.set(node.hostPid, nc);
        wireConn(node, nc, node.hostPid);
      }catch(e){}
    }
  }, 12000));
  showRoomView(code, false);
}

function leaveRoom(silent){
  Share.timers.forEach(clearInterval); Share.timers = [];
  if(Share.node && !silent){
    Share.conns.forEach((c)=>{ try{ c.send({kind:'bye'}); }catch(e){} });
  }
  Share.conns.forEach((c)=>{ try{ c.close(); }catch(e){} });
  Share.conns.clear();
  if(Share.peer){ try{ Share.peer.destroy(); }catch(e){} }
  Share.peer = null; Share.node = null;
  if(!silent){ showSetupView(); renderShareStatus({alive:false, peers:[]}); clearRoom(); }
}

/* ---------------- UI ---------------- */
function setStatus(t){ const el = $('#shareStatus'); if(el) el.textContent = t; }
function inviteLink(code){ return location.origin + location.pathname + '?room=' + code; }

function showRoomView(code, isHost){
  $('#shareSetup').classList.add('hidden');
  $('#shareRoom').classList.remove('hidden');
  $('#roomCode').textContent = code;
  $('#roomLink').value = inviteLink(code);
  $('#hostBadge').textContent = isHost ? 'You are hosting' : 'You joined';
  renderPeers([]);
}
function showSetupView(){
  $('#shareRoom').classList.add('hidden');
  $('#shareSetup').classList.remove('hidden');
  setStatus('');
}
function renderPeers(peers){
  const box = $('#peerList'); if(!box) return;
  box.innerHTML = '';
  (peers||[]).forEach(p=>{
    const chip = document.createElement('span'); chip.className = 'peer-chip';
    const initial = String(p.name||'?').trim().charAt(0).toUpperCase() || '?';
    chip.innerHTML = '<span class="peer-avatar">' + initial + '</span>' + String(p.name||'Partner').replace(/[<>&"]/g,'');
    box.appendChild(chip);
  });
}
function renderShareStatus(st){
  const dot = $('#shareDot'), label = $('#shareLabel');
  if(!dot || !label) return;
  const n = (st.peers || []).length;
  if(st.alive && n > 1){
    dot.className = 'dot live';
    label.textContent = 'Live · ' + n;
    const statusEl = $('#shareStatus');
    if(statusEl && /waiting|connecting|syncing/i.test(statusEl.textContent || '')) statusEl.textContent = 'Live ✓ — changes on either side appear on both, instantly.';
  } else if(Share.node){
    dot.className = 'dot waiting';
    label.textContent = 'Share…';
  } else {
    dot.className = 'dot';
    label.textContent = 'Share';
  }
  if(st.peers && st.peers.length) renderPeers(st.peers);
}

function bindShareUI(){
  $('#shareBtn').addEventListener('click', ()=>{
    $('#shareModal').classList.remove('hidden');
    $('#nameInput').value = localStorage.getItem('receiptsplit.name') || '';
  });
  $('#shareClose').addEventListener('click', ()=>$('#shareModal').classList.add('hidden'));
  $('#shareModal').addEventListener('click', (e)=>{ if(e.target.id === 'shareModal') $('#shareModal').classList.add('hidden'); });
  $('#createBtn').addEventListener('click', ()=>{ setMyName($('#nameInput').value); createRoom(); });
  $('#joinBtn').addEventListener('click', ()=>{ setMyName($('#nameInput').value); joinRoom($('#joinCode').value); });
  $('#joinCode').addEventListener('keydown', (e)=>{ if(e.key === 'Enter'){ setMyName($('#nameInput').value); joinRoom($('#joinCode').value); } });
  $('#copyLinkBtn').addEventListener('click', async ()=>{
    const v = $('#roomLink').value;
    try{ await navigator.clipboard.writeText(v); toast('Invite link copied — send it to your partner 📋'); }
    catch(e){ $('#roomLink').select(); document.execCommand('copy'); toast('Link selected — copy it manually 📋'); }
  });
  $('#leaveBtn').addEventListener('click', ()=>{ leaveRoom(); toast('Left the shared room. This device keeps its own copy.'); });
  // broadcast local ops to the partner
  window.addEventListener('rs-local', (e)=>{ if(Share.node && Share.connected) Share.node.broadcastOp(e.detail); });
  // Free our peer id on unload so a fast reload can reclaim the same room
  // code instead of colliding with its own ghost registration.
  window.addEventListener('beforeunload', ()=>{ try{ Share.peer && Share.peer.destroy(); }catch(e){} });
  // prefill from invite link
  try{
    const room = new URLSearchParams(location.search).get('room');
    if(room){
      $('#joinCode').value = room.toUpperCase();
      $('#shareModal').classList.remove('hidden');
      setStatus('Enter your name and hit Join to enter room ' + room.toUpperCase() + '.');
    }
  }catch(e){}
  // auto-rejoin the household room from the previous session (if we never
  // left it): missed edits sync over on both sides as soon as we're online.
  try{
    const saved = loadRoom();
    const invited = new URLSearchParams(location.search).get('room');
    if(saved && !invited){
      if(saved.role === 'host'){ setMyName(myName()); createRoom(saved.code); }
      else { setMyName(myName()); joinRoom(saved.code); }
      toast('🔄 Rejoining shared room ' + saved.code + '…');
    }
  }catch(e){}
}

if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindShareUI);
else bindShareUI();

// exposed for automated tests
window.__sync = {createNode, randomCode, Share};
})();
