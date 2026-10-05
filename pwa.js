/* PWA install wiring: service-worker registration + Add-to-Home-Screen prompt.
   Android/Chrome: captures beforeinstallprompt and shows an Install button.
   iPhone/iPad: no install prompt exists — shows one-tap "how to install"
   guidance (Share → Add to Home Screen) instead. Safe no-op everywhere else. */
(function(){
"use strict";
const $ = s => document.querySelector(s);
let deferredPrompt = null;

function isIos(){
  return /iphone|ipad|ipod/i.test(navigator.userAgent) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
}
function isStandalone(){
  return (window.matchMedia && window.matchMedia('(display-mode: standalone)').matches) ||
    window.navigator.standalone === true;
}

function ensureInstallButton(){
  if($('#installBtn')) return $('#installBtn');
  const tabs = document.querySelector('.tabs');
  if(!tabs) return null;
  const b = document.createElement('button');
  b.id = 'installBtn';
  b.type = 'button';
  b.className = 'install-btn hidden';
  b.textContent = '⬇ Install app';
  b.addEventListener('click', installNow);
  tabs.after(b);
  return b;
}

async function installNow(){
  const btn = $('#installBtn');
  if(deferredPrompt){
    try{
      deferredPrompt.prompt();
      const choice = await deferredPrompt.userChoice;
      if(choice && choice.outcome === 'accepted' && btn) btn.classList.add('hidden');
    }catch(e){}
    deferredPrompt = null;
    return;
  }
  if(isIos()){
    alert('To put ReceiptSplit on your home screen:\n\n1. Tap the Share button in Safari (the square with an arrow).\n2. Scroll down and tap “Add to Home Screen”.\n3. Tap “Add”. It will open full-screen like a real app.');
  }
}

function updateInstallUI(){
  const btn = ensureInstallButton();
  if(!btn) return;
  if(isStandalone()){ btn.classList.add('hidden'); return; }
  if(deferredPrompt || isIos()) btn.classList.remove('hidden');
  else btn.classList.add('hidden');
  if(isIos()) btn.textContent = '⬇ Add to Home Screen';
}

if('serviceWorker' in navigator){
  window.addEventListener('load', ()=>{
    //file:// previews have no service workers — skip quietly.
    if(!/^https?:$/.test(location.protocol)) return;
    navigator.serviceWorker.register('./sw.js').catch(()=>{});
  });
}
window.addEventListener('beforeinstallprompt', (e)=>{
  e.preventDefault();
  deferredPrompt = e;
  updateInstallUI();
});
window.addEventListener('appinstalled', ()=>{
  deferredPrompt = null;
  updateInstallUI();
  try{ localStorage.setItem('receiptsplit.installed', '1'); }catch(e){}
});
if(document.readyState === 'loading') document.addEventListener('DOMContentLoaded', updateInstallUI);
else updateInstallUI();
window.__pwa = {installNow, isStandalone, isIos};
})();
