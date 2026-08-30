'use strict';

const loginView = document.getElementById('loginView');
const pttView = document.getElementById('pttView');
const loginForm = document.getElementById('loginForm');
const passwordInput = document.getElementById('password');
const loginMessage = document.getElementById('loginMessage');
const pttButton = document.getElementById('pttButton');
const statusText = document.getElementById('statusText');
const statusDot = document.getElementById('statusDot');
const peerText = document.getElementById('peerText');
const remoteAudio = document.getElementById('remoteAudio');

let ws = null;
let pc = null;
let localStream = null;
let localTrack = null;
let token = null;
let channelState = 'busy';
let peerPresent = false;
let pressActive = false;
let hasGrant = false;
let iceServers = [{ urls: 'stun:stun.l.google.com:19302' }];

function wsSend(payload) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(payload));
}

function setState(state) {
  channelState = state;
  pttButton.classList.remove('free', 'transmitting', 'busy');
  pttButton.classList.add(state);

  if (state === 'free') {
    statusText.textContent = 'CANAL LIBRE';
    statusDot.style.background = '#29c568';
    pttButton.disabled = !peerPresent;
  } else if (state === 'transmitting') {
    statusText.textContent = 'TRANSMITIENDO';
    statusDot.style.background = '#e33e3e';
    pttButton.disabled = false;
  } else {
    statusText.textContent = peerPresent ? 'CANAL OCUPADO' : 'ESPERANDO USUARIO';
    statusDot.style.background = '#666d74';
    pttButton.disabled = true;
  }
}

async function prepareMicrophone() {
  if (localStream) return;
  localStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      channelCount: 1
    },
    video: false
  });
  localTrack = localStream.getAudioTracks()[0];
  localTrack.enabled = false;
}

async function createPeerConnection() {
  if (pc) pc.close();
  pc = new RTCPeerConnection({ iceServers });

  if (localTrack) pc.addTrack(localTrack, localStream);

  pc.onicecandidate = (event) => {
    if (event.candidate) wsSend({ type: 'signal', data: { candidate: event.candidate } });
  };

  pc.ontrack = async (event) => {
    remoteAudio.srcObject = event.streams[0];
    try { await remoteAudio.play(); } catch {}
  };

  pc.onconnectionstatechange = () => {
    if (!pc) return;
    const state = pc.connectionState;
    if (state === 'connected') peerText.textContent = 'Audio conectado';
    else if (state === 'failed') peerText.textContent = 'No se pudo establecer audio. Revisa TURN/red.';
    else if (state === 'disconnected') peerText.textContent = 'Conexión de audio interrumpida';
  };
}

async function handlePeerReady(initiator) {
  peerPresent = true;
  peerText.textContent = 'Conectando audio...';
  await prepareMicrophone();
  await createPeerConnection();

  if (initiator) {
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    wsSend({ type: 'signal', data: { description: pc.localDescription } });
  }
}

async function handleSignal(data) {
  if (!pc) {
    await prepareMicrophone();
    await createPeerConnection();
  }

  if (data.description) {
    await pc.setRemoteDescription(data.description);
    if (data.description.type === 'offer') {
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      wsSend({ type: 'signal', data: { description: pc.localDescription } });
    }
  } else if (data.candidate) {
    try { await pc.addIceCandidate(data.candidate); } catch {}
  }
}

function connectWebSocket() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${protocol}//${location.host}/ws?token=${encodeURIComponent(token)}`);

  ws.onopen = () => {
    peerText.textContent = 'Esperando al segundo usuario...';
  };

  ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    try {
      if (msg.type === 'peer-ready') await handlePeerReady(msg.initiator);
      if (msg.type === 'peer-waiting') {
        peerPresent = false;
        hasGrant = false;
        if (localTrack) localTrack.enabled = false;
        if (pc) { pc.close(); pc = null; }
        peerText.textContent = 'Esperando al segundo usuario...';
        setState('busy');
      }
      if (msg.type === 'signal') await handleSignal(msg.data);
      if (msg.type === 'channel-state') {
        peerPresent = msg.peers >= 2;
        setState(msg.state);
      }
      if (msg.type === 'ptt-granted') {
        hasGrant = true;
        if (pressActive && localTrack) localTrack.enabled = true;
      }
      if (msg.type === 'ptt-denied') {
        hasGrant = false;
        if (localTrack) localTrack.enabled = false;
      }
    } catch (err) {
      console.error(err);
      peerText.textContent = 'Error de conexión de audio';
    }
  };

  ws.onclose = () => {
    hasGrant = false;
    peerPresent = false;
    if (localTrack) localTrack.enabled = false;
    setState('busy');
    peerText.textContent = 'Desconectado del servidor';
  };
}

async function startPress(event) {
  event.preventDefault();
  if (!peerPresent || channelState !== 'free' || pressActive) return;
  pressActive = true;
  hasGrant = false;
  try { pttButton.setPointerCapture(event.pointerId); } catch {}
  wsSend({ type: 'ptt-down' });
}

function stopPress(event) {
  if (event) event.preventDefault();
  if (!pressActive) return;
  pressActive = false;
  if (localTrack) localTrack.enabled = false;
  if (hasGrant) wsSend({ type: 'ptt-up' });
  hasGrant = false;
}

pttButton.addEventListener('pointerdown', startPress);
pttButton.addEventListener('pointerup', stopPress);
pttButton.addEventListener('pointercancel', stopPress);
pttButton.addEventListener('lostpointercapture', stopPress);
window.addEventListener('blur', () => stopPress());
document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopPress();
});

loginForm.addEventListener('submit', async (event) => {
  event.preventDefault();
  loginMessage.textContent = '';
  const password = passwordInput.value;
  if (!password) return;

  try {
    const [loginResponse, configResponse] = await Promise.all([
      fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password })
      }),
      fetch('/api/config')
    ]);

    const loginData = await loginResponse.json();
    if (!loginResponse.ok) throw new Error(loginData.error || 'No se pudo iniciar sesión.');

    if (configResponse.ok) {
      const config = await configResponse.json();
      if (Array.isArray(config.iceServers)) iceServers = config.iceServers;
    }

    token = loginData.token;
    passwordInput.value = '';
    loginView.classList.add('hidden');
    pttView.classList.remove('hidden');
    setState('busy');

    try {
      await prepareMicrophone();
    } catch {
      peerText.textContent = 'Debes permitir acceso al micrófono.';
    }

    connectWebSocket();
  } catch (err) {
    loginMessage.textContent = err.message || 'Error de conexión.';
  }
});
