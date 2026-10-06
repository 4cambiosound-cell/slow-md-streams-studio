const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'bot-config.json');

// Cargar configuración guardada
let botConfig = {
  lastUsername: '',
  rules: {
    likesReq: 1000,
    sharesReq: 10,
    rosesReq: 5,
    giftCategories: {
      reaccionInmediata: ['león', 'universo', 'cohete'],
      primerPuesto: ['sombrero', 'donut', 'bigote'],
      subirPosicion: ['dedo', 'corazón', 'pesas'],
      desbloquear: ['rosa', 'perfume', 'microfono']
    },
    mediumGifts: 'dedo, corazon, corazón',
    vipGifts: 'sombrero, bigote, donut, rosquilla',
    vipMinDiamonds: 30
  },
  tts: {
    voiceURI: 'google_hd_es',
    voiceName: 'Google Español (HD)',
    voiceLang: 'es',
    volume: 1.0,
    rate: 1.0,
    pitch: 1.0,
    audioOutput: 'overlay',
    tiktokVoice: false,
    followersOnly: false,
    antiSpam: true
  }
};
try {
  if (fs.existsSync(CONFIG_FILE)) {
    const loaded = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
    botConfig = {
      ...botConfig,
      ...loaded,
      rules: { ...botConfig.rules, ...(loaded.rules || {}) }
    };
  }
} catch (e) {
  console.error('[Config] Error leyendo bot-config.json:', e.message);
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('[Config] Error guardando bot-config.json:', e.message);
  }
}

// Estado de conexión TikTok
let tiktokConnection = null;
let currentStatus = {
  status: 'disconnected', // 'disconnected' | 'connecting' | 'connected' | 'error'
  username: botConfig.lastUsername || '',
  roomId: null,
  error: null
};

// Historial reciente de eventos (para cuando un cliente se conecta nuevo)
const recentLogs = [];
function addLog(text, level = 'info') {
  const item = { text, level, time: new Date().toLocaleTimeString() };
  recentLogs.push(item);
  if (recentLogs.length > 50) recentLogs.shift();
  broadcast({ type: 'LOG', ...item });
  console.log(`[${level.toUpperCase()}] ${text}`);
}

// Servidor HTTP para la web y assets
const mimeTypes = {
  '.html': 'text/html; charset=UTF-8',
  '.js': 'application/javascript; charset=UTF-8',
  '.css': 'text/css; charset=UTF-8',
  '.json': 'application/json',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp'
};

const server = http.createServer((req, res) => {
  // Soporte CORS para overlays en OBS, Meld Studio o ventanas externas
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const [pathname, queryString] = req.url.split('?');
  const params = new URLSearchParams(queryString || '');
  let reqUrl = pathname;

  if (reqUrl === '/' || reqUrl === '/index.html') {
    // Si la URL pide explícitamente vista overlay o panel, servir cola-slow-md.html
    if (params.get('view') === 'overlay' || params.get('view') === 'panel') {
      reqUrl = '/cola-slow-md.html';
    } else {
      // Por defecto, cargar el panel multiversal Slow MD Stream Studio
      reqUrl = '/dashboard.html';
    }
  } else if (reqUrl === '/dashboard' || reqUrl === '/studio') {
    reqUrl = '/dashboard.html';
  } else if (reqUrl.startsWith('/widgets/cola-canciones')) {
    reqUrl = '/cola-slow-md.html';
  } else if (reqUrl.startsWith('/widgets/comentarios-tts')) {
    reqUrl = '/comentarios-tts.html';
  } else if (reqUrl === '/api/tts') {
    const text = (params.get('q') || params.get('text') || '').slice(0, 350);
    const lang = params.get('tl') || params.get('lang') || 'es';
    if (!text) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Falta el texto');
      return;
    }
    const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=${encodeURIComponent(lang)}&client=tw-ob&q=${encodeURIComponent(text)}`;
    https.get(ttsUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Referer': 'https://translate.google.com/'
      }
    }, (ttsRes) => {
      res.writeHead(ttsRes.statusCode, {
        'Content-Type': 'audio/mpeg',
        'Access-Control-Allow-Origin': '*'
      });
      ttsRes.pipe(res);
    }).on('error', (err) => {
      res.writeHead(500, { 'Content-Type': 'text/plain' });
      res.end('Error TTS');
    });
    return;
  }

  const filePath = path.join(__dirname, decodeURIComponent(reqUrl));

  // Seguridad: evitar directory traversal
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('Acceso denegado');
    return;
  }

  fs.stat(filePath, (err, stats) => {
    if (err || !stats.isFile()) {
      // Fallback a cola-slow-md.html si no existe
      const fallback = path.join(__dirname, 'cola-slow-md.html');
      fs.readFile(fallback, (err2, data) => {
        if (err2) {
          res.writeHead(404, { 'Content-Type': 'text/plain; charset=UTF-8' });
          res.end('Archivo no encontrado');
        } else {
          res.writeHead(200, { 'Content-Type': 'text/html; charset=UTF-8' });
          res.end(data);
        }
      });
      return;
    }

    const ext = path.extname(filePath).toLowerCase();
    const contentType = mimeTypes[ext] || 'application/octet-stream';

    // Evitar caché para los datos sincronizados
    if (reqUrl.includes('queue-data.json') || reqUrl.includes('bot-config.json')) {
      res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    }

    fs.readFile(filePath, (errFile, content) => {
      if (errFile) {
        res.writeHead(500, { 'Content-Type': 'text/plain' });
        res.end('Error interno del servidor');
      } else {
        res.writeHead(200, { 'Content-Type': contentType });
        res.end(content);
      }
    });
  });
});

// Servidor WebSocket
const wss = new WebSocketServer({ server });

function broadcast(data) {
  const msg = JSON.stringify(data);
  for (const client of wss.clients) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(msg);
    }
  }
}

function updateStatus(newStatus, extras = {}) {
  currentStatus = { ...currentStatus, status: newStatus, ...extras };
  broadcast({ type: 'STATUS', ...currentStatus });
}

// Estado maestro de la cola sincronizada en tiempo real
const QUEUE_FILE = path.join(__dirname, 'queue-data.json');
let queueState = { queue: [], history: [] };
try {
  if (fs.existsSync(QUEUE_FILE)) {
    queueState = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (!Array.isArray(queueState.queue)) queueState.queue = [];
    if (!Array.isArray(queueState.history)) queueState.history = [];
  }
} catch (e) {
  console.error('[Queue] Error leyendo queue-data.json:', e.message);
}

function saveQueueData() {
  try {
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queueState, null, 2), 'utf8');
  } catch (e) {
    console.error('[Queue] Error guardando queue-data.json:', e.message);
  }
}

// Memoria de usuario para acumular likes, shares y regalos
const serverUserLikes = new Map();
const serverUserShares = new Map();
const serverUserRoses = new Map();
const serverAliasMap = new Map();

function normalizarUserKey(u) {
  if (!u) return '';
  const clean = String(u).toLowerCase().replace(/^@/, '').trim();
  if (serverAliasMap.has(clean)) {
    return serverAliasMap.get(clean);
  }
  return clean;
}

function registrarAliasServidor(chatName, displayId, nickname, userId) {
  const posibles = [chatName, displayId, nickname, userId]
    .filter(Boolean)
    .map(s => String(s).toLowerCase().replace(/^@/, '').trim())
    .filter(s => s.length > 0);

  if (posibles.length === 0) return '';

  let canonical = null;
  for (const p of posibles) {
    if (serverAliasMap.has(p)) {
      canonical = serverAliasMap.get(p);
      break;
    }
  }

  if (!canonical) {
    canonical = posibles[0];
  }

  for (const p of posibles) {
    serverAliasMap.set(p, canonical);
  }

  return canonical;
}

function processServerChat(comment, userChatName, userHandle = '', userId = '') {
  const text = (comment || '').trim();
  let cancionDetectada = '';

  const escuchaMatch = text.match(/^\s*(?:[!/]?escucha(?:te)?|puedes\s+escuchar)\s*:?\s+(.+)$/i);
  if (escuchaMatch && escuchaMatch[1].trim().length > 1) {
    cancionDetectada = escuchaMatch[1].trim();
  }

  if (!cancionDetectada) {
    const parenMatch = text.match(/^\s*\((.+?)\)\s*$/);
    if (parenMatch && parenMatch[1].trim().length > 1) {
      cancionDetectada = parenMatch[1].trim();
    }
  }

  if (!cancionDetectada && text.includes(' - ') && text.length > 3 && !text.includes('?')) {
    cancionDetectada = text;
  }

  if (!cancionDetectada) return false;

  cancionDetectada = cancionDetectada.replace(/^["'(\[]+|["')\]]+$/g, '').trim();
  if (!cancionDetectada || cancionDetectada.length < 2) return false;

  const chatName = (userChatName || 'Usuario').trim();
  if (userHandle || userId) {
    registrarAliasServidor(chatName, userHandle, chatName, userId);
  }

  const userKey = normalizarUserKey(chatName);
  const handleKey = userHandle ? normalizarUserKey(userHandle) : '';
  const likesActuales = serverUserLikes.get(userKey) || (handleKey ? serverUserLikes.get(handleKey) : 0) || 0;
  const sharesActuales = serverUserShares.get(userKey) || (handleKey ? serverUserShares.get(handleKey) : 0) || 0;
  const rosesActuales = serverUserRoses.get(userKey) || (handleKey ? serverUserRoses.get(handleKey) : 0) || 0;

  // Buscar si ya tiene canción en la cola
  const idx = queueState.queue.findIndex(s => {
    const k = normalizarUserKey(s.user);
    const kh = s.handle ? normalizarUserKey(s.handle) : '';
    return (k && (k === userKey || (handleKey && k === handleKey))) ||
           (kh && (kh === userKey || (handleKey && kh === handleKey)));
  });

  if (idx !== -1) {
    if (queueState.queue[idx].status === 'locked') {
      queueState.queue[idx].title = cancionDetectada;
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history });
      addLog(`📝 ${chatName} actualizó el nombre de su canción pendiente a "${cancionDetectada}"`, 'chat');
    }
    return true;
  }

  const likesReq = Number(botConfig.rules?.likesReq) || 1000;
  const sharesReq = Number(botConfig.rules?.sharesReq) || 10;
  const rosesReq = Number(botConfig.rules?.rosesReq) || 5;

  const yaCumple = (likesActuales >= likesReq || sharesActuales >= sharesReq || rosesActuales >= rosesReq);
  const status = yaCumple ? 'unlocked' : 'locked';

  const nuevaCancion = {
    id: 'song_' + Date.now() + '_' + Math.random().toString(36).substr(2, 6),
    title: cancionDetectada,
    user: chatName, // Nombre que tiene en el chat de TikTok
    handle: userHandle || '',
    gift: null,
    priority: 'normal',
    status: status,
    likes: likesActuales,
    shares: sharesActuales,
    roses: rosesActuales,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  queueState.queue.push(nuevaCancion);
  saveQueueData();
  broadcast({
    type: 'QUEUE_UPDATE',
    queue: queueState.queue,
    history: queueState.history,
    sound: status === 'unlocked' ? 'normal' : null
  });
  addLog(`🎵 Canción agregada [${status === 'locked' ? '🔒 BLOQUEADA' : '🔓 LISTA'}]: "${cancionDetectada}" (${chatName})`, 'chat');
  return true;
}

function processServerLike(userIdentifier, count, extraInfo = {}) {
  if (extraInfo.displayId || extraInfo.nickname || extraInfo.userId) {
    registrarAliasServidor(userIdentifier, extraInfo.displayId, extraInfo.nickname, extraInfo.userId);
  }
  const userKey = normalizarUserKey(userIdentifier);
  const total = (serverUserLikes.get(userKey) || 0) + count;
  serverUserLikes.set(userKey, total);

  const idx = queueState.queue.findIndex(s => {
    const k = normalizarUserKey(s.user);
    const kh = s.handle ? normalizarUserKey(s.handle) : '';
    return k === userKey || (kh && kh === userKey);
  });
  if (idx !== -1) {
    const s = queueState.queue[idx];
    s.likes = total;
    const likesReq = Number(botConfig.rules?.likesReq) || 1000;
    if (s.status === 'locked' && s.likes >= likesReq) {
      s.status = 'unlocked';
      s.unlockedReason = `${likesReq} Likes ❤️`;
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history, sound: 'normal' });
      addLog(`🔓 ¡${s.user} desbloqueó su canción "${s.title}" con ${likesReq} likes!`, 'like');
    } else {
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history });
    }
  }
}

function processServerShare(userIdentifier, extraInfo = {}) {
  if (extraInfo.displayId || extraInfo.nickname || extraInfo.userId) {
    registrarAliasServidor(userIdentifier, extraInfo.displayId, extraInfo.nickname, extraInfo.userId);
  }
  const userKey = normalizarUserKey(userIdentifier);
  const total = (serverUserShares.get(userKey) || 0) + 1;
  serverUserShares.set(userKey, total);

  const idx = queueState.queue.findIndex(s => {
    const k = normalizarUserKey(s.user);
    const kh = s.handle ? normalizarUserKey(s.handle) : '';
    return k === userKey || (kh && kh === userKey);
  });
  if (idx !== -1) {
    const s = queueState.queue[idx];
    s.shares = total;
    const sharesReq = Number(botConfig.rules?.sharesReq) || 10;
    if (s.status === 'locked' && s.shares >= sharesReq) {
      s.status = 'unlocked';
      s.unlockedReason = `${sharesReq} Compartidos 🔄`;
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history, sound: 'normal' });
      addLog(`🔓 ¡${s.user} desbloqueó su canción "${s.title}" con ${sharesReq} compartidos!`, 'share');
    } else {
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history });
    }
  }
}

function processServerGift(userIdentifier, giftName, repeatCount, diamondCount, comment, extraInfo = {}) {
  if (extraInfo.displayId || extraInfo.nickname || extraInfo.userId) {
    registrarAliasServidor(userIdentifier, extraInfo.displayId, extraInfo.nickname, extraInfo.userId);
  }
  const userKey = normalizarUserKey(userIdentifier);
  const r = (giftName || '').toLowerCase();
  const isRosa = r.includes('rosa') || r.includes('rose');
  const totalRoses = (serverUserRoses.get(userKey) || 0) + (isRosa ? repeatCount : 0);
  if (isRosa) serverUserRoses.set(userKey, totalRoses);

  const cats = botConfig.rules?.giftCategories || {};
  const reaccionKeywords = (cats.reaccionInmediata || ['león', 'universo', 'cohete']).map(k => k.toLowerCase().trim()).filter(Boolean);
  const top1Keywords = (cats.primerPuesto || ['sombrero', 'donut', 'bigote']).map(k => k.toLowerCase().trim()).filter(Boolean);
  const subirKeywords = (cats.subirPosicion || ['dedo', 'corazón', 'pesas']).map(k => k.toLowerCase().trim()).filter(Boolean);
  const desbloquearKeywords = (cats.desbloquear || ['rosa', 'perfume', 'microfono']).map(k => k.toLowerCase().trim()).filter(Boolean);

  const vipKeywords = String(botConfig.rules?.vipGifts || 'sombrero, bigote, donut, rosquilla')
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const mediumKeywords = String(botConfig.rules?.mediumGifts || 'dedo, corazon, corazón')
    .toLowerCase().split(',').map(s => s.trim()).filter(Boolean);
  const vipMinDiamonds = Number(botConfig.rules?.vipMinDiamonds) || 30;
  const rosesReq = Number(botConfig.rules?.rosesReq) || 5;

  const isReaccion = reaccionKeywords.some(kw => r.includes(kw));
  const isTop1 = top1Keywords.some(kw => r.includes(kw)) || vipKeywords.some(kw => r.includes(kw)) || diamondCount >= vipMinDiamonds;
  const isSubir = subirKeywords.some(kw => r.includes(kw)) || mediumKeywords.some(kw => r.includes(kw));
  const isDesbloquear = desbloquearKeywords.some(kw => r.includes(kw)) || s_roses_check(totalRoses, rosesReq, isRosa);

  function s_roses_check(roses, req, rosa) { return rosa && roses >= req; }

  if (comment) {
    processServerChat(comment, userIdentifier, extraInfo.handle || extraInfo.displayId, extraInfo.userId);
  }

  const idx = queueState.queue.findIndex(s => {
    const k = normalizarUserKey(s.user);
    const kh = s.handle ? normalizarUserKey(s.handle) : '';
    return k === userKey || (kh && kh === userKey);
  });

  if (idx !== -1) {
    const s = queueState.queue[idx];
    s.roses = totalRoses;
    s.gift = giftName + (repeatCount > 1 ? ` x${repeatCount}` : '');

    if (isReaccion) {
      s.status = 'unlocked';
      s.priority = 'vip';
      s.unlockedReason = `Reacción Inmediata: ${giftName}`;
      queueState.queue.splice(idx, 1);
      queueState.queue.unshift(s);
      verificarEliminacionServidor(queueState.queue);
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history, sound: 'top1', eventType: 'hands_top1', songTitle: s.title });
      addLog(`⚡ ¡${s.user} activó Reacción Inmediata para "${s.title}" con ${giftName}!`, 'gift');
    } else if (isTop1) {
      s.status = 'unlocked';
      s.priority = 'vip';
      s.unlockedReason = `1er Puesto VIP: ${giftName}`;
      queueState.queue.splice(idx, 1);
      let targetPos = 0;
      if (queueState.queue.length > 0 && queueState.queue[0].status === 'unlocked' && queueState.queue[0].id !== s.id) {
        targetPos = 1;
      }
      queueState.queue.splice(targetPos, 0, s);
      verificarEliminacionServidor(queueState.queue);
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history, sound: 'top1', eventType: 'hands_top1', songTitle: s.title });
      addLog(`👑 ¡${s.user} catapultó "${s.title}" al 1er Puesto con ${giftName}!`, 'gift');
    } else if (isSubir) {
      if (s.priority !== 'vip') s.priority = 'medium';
      if (idx > 0) {
        queueState.queue.splice(idx, 1);
        queueState.queue.splice(idx - 1, 0, s);
      }
      verificarEliminacionServidor(queueState.queue);
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history, sound: 'subir', eventType: 'move_up', songTitle: s.title });
      addLog(`🚀 ¡${s.user} subió una posición con "${s.title}" gracias a ${giftName}!`, 'gift');
    } else if (isDesbloquear || diamondCount >= 5) {
      s.status = 'unlocked';
      s.unlockedReason = `Regalo: ${giftName}`;
      verificarEliminacionServidor(queueState.queue);
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history, sound: 'normal', eventType: 'unlock', songTitle: s.title });
      addLog(`🔓 ¡${s.user} desbloqueó su canción "${s.title}" con ${giftName}!`, 'gift');
    } else {
      verificarEliminacionServidor(queueState.queue);
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history });
    }
  }
}

// Verificar eliminación de canciones bloqueadas que avanzan de puesto 4 a puesto 2 sin apoyo
function verificarEliminacionServidor(queue) {
  if (!Array.isArray(queue)) return false;
  let huboEliminacion = false;
  for (let i = 0; i < queue.length; i++) {
    const s = queue[i];
    if ((i === 3 || i === 2) && s.status === 'locked') {
      if (!s.historyAt4th) {
        s.historyAt4th = {
          pos: i + 1,
          likes: s.likes || 0,
          shares: s.shares || 0,
          roses: s.roses || 0
        };
      }
    }
    if (i === 1 && s.status === 'locked' && s.historyAt4th && s.historyAt4th.pos >= 3) {
      const currentLikes = s.likes || 0;
      const currentShares = s.shares || 0;
      const currentRoses = s.roses || 0;
      const subio = (currentLikes > s.historyAt4th.likes) ||
                    (currentShares > s.historyAt4th.shares) ||
                    (currentRoses > s.historyAt4th.roses);
      if (!subio) {
        const removed = queue.splice(i, 1)[0];
        huboEliminacion = true;
        addLog(`❌ Canción "${removed.title}" de ${removed.user} eliminada al pasar a 2do lugar sin aumentar likes ni regalos.`, 'warning');
        broadcast({
          type: 'SONG_ELIMINATED',
          song: removed,
          reason: 'Avanzó al 2do lugar sin aumento de likes, compartidos ni regalos'
        });
        i--;
      }
    }
  }
  return huboEliminacion;
}

// Función de conexión a TikTok Live
async function connectToTikTok(rawUsername) {
  const username = (rawUsername || '').replace(/^@/, '').trim();
  if (!username) {
    updateStatus('error', { error: 'Debes ingresar un nombre de usuario de TikTok válido' });
    return;
  }

  // Desconectar si ya había una activa
  if (tiktokConnection) {
    try {
      tiktokConnection.disconnect();
    } catch (e) {}
    tiktokConnection = null;
  }

  botConfig.lastUsername = username;
  saveConfig();

  updateStatus('connecting', { username, error: null, roomId: null });
  addLog(`Conectando al En Vivo de TikTok de: @${username}...`, 'info');

  try {
    tiktokConnection = new TikTokLiveConnection(username, {
      processInitialData: true,
      enableExtendedGiftInfo: false,
      fetchRoomInfoOnConnect: false
    });

    const state = await tiktokConnection.connect();
    updateStatus('connected', { username, roomId: state.roomId, error: null });
    addLog(`¡Conectado exitosamente al Live de @${username}! (Room ID: ${state.roomId})`, 'success');

// Seguidores conocidos en memoria durante el stream
const knownFollowers = new Set();
let globalLiveLikes = 0;
let lastLikesMilestone = 0;

    const extractUserInfo = (data) => {
      const u = data.user || {};
      let displayId = (u.displayId || data.uniqueId || '').replace(/^@/, '').trim();
      let nickname = (u.nickname || data.nickname || '').replace(/^@/, '').trim();
      let userId = String(u.id || u.idStr || data.userId || '').trim();

      if ((!displayId || !nickname) && data.common?.displayText?.pieces) {
        for (const piece of data.common.displayText.pieces) {
          if (piece.userValue) {
            displayId = displayId || (piece.userValue.displayId || '').replace(/^@/, '').trim();
            nickname = nickname || (piece.userValue.nickname || '').replace(/^@/, '').trim();
            userId = userId || String(piece.userValue.id || '').trim();
          }
        }
      }

      // Priorizar el nombre que tiene la persona en el chat (nickname)
      const chatName = nickname || displayId || (userId ? `user_${userId}` : 'Usuario');
      const userHandle = displayId ? (displayId.startsWith('@') ? displayId : '@' + displayId) : (chatName.startsWith('@') ? chatName : '@' + chatName);

      registrarAliasServidor(chatName, displayId, nickname, userId);

      const isFollower = Boolean(
        u.followInfo?.followStatus === 1 ||
        u.followInfo?.followStatus === 2 ||
        u.followRole === 1 ||
        u.followRole === 2 ||
        data.followInfo?.followStatus === 1 ||
        data.followInfo?.followStatus === 2 ||
        data.isFollower === true ||
        knownFollowers.has(normalizarUserKey(chatName)) ||
        knownFollowers.has(normalizarUserKey(userHandle)) ||
        (displayId && knownFollowers.has(normalizarUserKey(displayId)))
      );

      if (isFollower) {
        knownFollowers.add(normalizarUserKey(chatName));
        knownFollowers.add(normalizarUserKey(userHandle));
        if (displayId) knownFollowers.add(normalizarUserKey(displayId));
      }

      let avatarUrl = u.profilePictureUrl || u.avatarThumb?.urlList?.[0] || u.avatarMedium?.urlList?.[0] || data.profilePictureUrl || '';
      if (!avatarUrl) {
        avatarUrl = `https://api.dicebear.com/7.x/identicon/svg?seed=${encodeURIComponent(chatName)}`;
      }

      return {
        user: chatName,          // Nombre visible en el chat
        chatName: chatName,
        displayId: displayId ? '@' + displayId : '',
        handle: userHandle,
        nickname: nickname || '',
        userId: userId || '',
        avatarUrl,
        isFollower
      };
    };

    // Escuchar Comentarios
    tiktokConnection.on(WebcastEvent.CHAT, (data) => {
      const info = extractUserInfo(data);
      const comment = (data.content || data.comment || '').trim();
      if (!comment) return;

      addLog(`💬 ${info.chatName} (${info.handle}): ${comment}`, 'chat');
      processServerChat(comment, info.chatName, info.handle, info.userId);
      broadcast({
        type: 'CHAT',
        user: info.chatName,
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId,
        avatarUrl: info.avatarUrl,
        comment,
        isFollower: info.isFollower,
        timestamp: Date.now()
      });
    });

    // Escuchar cuando alguien sigue el canal en vivo
    tiktokConnection.on(WebcastEvent.FOLLOW, (data) => {
      const info = extractUserInfo(data);
      knownFollowers.add(normalizarUserKey(info.chatName));
      knownFollowers.add(normalizarUserKey(info.handle));
      if (info.displayId) knownFollowers.add(normalizarUserKey(info.displayId));
      addLog(`➕ ${info.chatName} comenzó a seguirte`, 'follow');
      broadcast({
        type: 'FOLLOW',
        user: info.chatName,
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId,
        avatarUrl: info.avatarUrl,
        timestamp: Date.now()
      });
    });

    // Escuchar Regalos
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
      if (data.repeatEnd === 0) return;

      const info = extractUserInfo(data);
      const giftName = data.gift?.name || data.giftName || data.giftDetails?.giftName || data.describe || 'Regalo';
      const repeatCount = Number(data.repeatCount) || Number(data.comboCount) || 1;
      const diamondCount = Number(data.diamondCount) || Number(data.gift?.diamondCount) || 1;
      const comment = (data.content || data.comment || '').trim();

      addLog(`🎁 ${info.chatName} envió ${giftName} x${repeatCount} ${comment ? `("${comment}")` : ''}`, 'gift');
      processServerGift(info.chatName, giftName, repeatCount, diamondCount, comment, {
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId
      });
      broadcast({
        type: 'GIFT',
        user: info.chatName,
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId,
        avatarUrl: info.avatarUrl,
        giftName,
        repeatCount,
        diamondCount,
        comment,
        timestamp: Date.now()
      });
    });

    // Escuchar cuando los espectadores comparten el Live
    const handleShareEvent = (data) => {
      const info = extractUserInfo(data);
      addLog(`🔄 ${info.chatName} compartió el En Vivo`, 'share');
      processServerShare(info.chatName, {
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId
      });
      broadcast({
        type: 'SHARE',
        user: info.chatName,
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId,
        avatarUrl: info.avatarUrl,
        timestamp: Date.now()
      });
    };

    tiktokConnection.on(WebcastEvent.SHARE, handleShareEvent);
    tiktokConnection.on(WebcastEvent.SOCIAL, (data) => {
      const actionStr = String(data.action || '').toLowerCase();
      const keyStr = String(data.common?.displayText?.key || '').toLowerCase();
      const patternStr = String(data.common?.displayText?.defaultPattern || '').toLowerCase();
      const isShare = actionStr === '3' || actionStr === '4' || actionStr.includes('share') || keyStr.includes('share') || patternStr.includes('compart') || Boolean(data.shareTarget) || Boolean(data.shareType) || (data.shareCount && data.shareCount > 0);
      if (isShare) {
        handleShareEvent(data);
      }
    });

    // Escuchar Likes (toques a la pantalla)
    tiktokConnection.on(WebcastEvent.LIKE, (data) => {
      const info = extractUserInfo(data);
      const count = Number(data.count) || Number(data.likeCount) || 1;
      const total = data.total || null;

      // Rastrear hitos acumulativos de 10,000 likes
      globalLiveLikes += count;
      const currentMilestone = Math.floor(globalLiveLikes / 10000) * 10000;
      if (currentMilestone >= 10000 && currentMilestone > lastLikesMilestone) {
        lastLikesMilestone = currentMilestone;
        addLog(`🎉 ¡HITO ALCANZADO! ${currentMilestone.toLocaleString()} likes acumulados`, 'success');
        broadcast({
          type: 'LIKES_MILESTONE',
          milestone: currentMilestone,
          totalLikes: globalLiveLikes,
          timestamp: Date.now()
        });
      }

      addLog(`❤️ ${info.chatName} dio ${count} likes ${total ? `(Total Live: ${total})` : ''}`, 'like');
      processServerLike(info.chatName, count, {
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId
      });
      broadcast({
        type: 'LIKE',
        user: info.chatName,
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId,
        avatarUrl: info.avatarUrl,
        count,
        total,
        timestamp: Date.now()
      });
    });

    // Fin de transmisión
    tiktokConnection.on(WebcastEvent.STREAM_END, () => {
      addLog(`La transmisión en vivo de @${username} ha finalizado.`, 'warn');
      updateStatus('disconnected', { error: 'El En Vivo ha finalizado' });
      tiktokConnection = null;
    });

    // Errores de conexión
    tiktokConnection.on('error', (err) => {
      const errMsg = err?.message || 'Error en flujo de TikTok Live';
      addLog(`Error TikTok Live: ${errMsg}`, 'error');
    });

    tiktokConnection.on('disconnected', () => {
      addLog(`Desconectado de @${username}`, 'warn');
      updateStatus('disconnected', {});
      tiktokConnection = null;
    });

  } catch (err) {
    const errorMsg = err?.message || 'No se pudo conectar al En Vivo de TikTok';
    addLog(`Aún no estás en vivo o esperando inicio de @${username}... Reintentando en 10s...`, 'warn');
    updateStatus('connecting', { error: 'Esperando a que inicies el En Vivo en TikTok...' });
    tiktokConnection = null;

    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      if (!tiktokConnection && currentStatus.status !== 'connected' && currentStatus.status !== 'disconnected_manual') {
        connectToTikTok(username);
      }
    }, 10000);
  }
}

let retryTimer = null;

function disconnectTikTok() {
  clearTimeout(retryTimer);
  if (tiktokConnection) {
    try {
      tiktokConnection.disconnect();
    } catch (e) {}
    tiktokConnection = null;
  }
  addLog('Conexión con TikTok pausada manualmente por el streamer.', 'info');
  updateStatus('disconnected_manual', { error: null });
}

// Manejador de conexiones WebSocket
wss.on('connection', (ws) => {
  // Enviar estado actual, cola de canciones, reglas y logs iniciales al nuevo cliente
  ws.send(JSON.stringify({ type: 'STATUS', ...currentStatus }));
  ws.send(JSON.stringify({ type: 'RULES_UPDATE', rules: botConfig.rules }));
  ws.send(JSON.stringify({ type: 'TTS_CONFIG_UPDATE', config: botConfig.tts }));
  ws.send(JSON.stringify({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history }));
  ws.send(JSON.stringify({ type: 'RECENT_LOGS', logs: recentLogs }));

  ws.on('message', (message) => {
    try {
      const payload = JSON.parse(message.toString());
      if (payload.action === 'connect') {
        connectToTikTok(payload.username);
      } else if (payload.action === 'disconnect') {
        disconnectTikTok();
      } else if (payload.action === 'getStatus') {
        ws.send(JSON.stringify({ type: 'STATUS', ...currentStatus }));
      } else if (payload.action === 'getTTSConfig') {
        ws.send(JSON.stringify({ type: 'TTS_CONFIG_UPDATE', config: botConfig.tts }));
      } else if (payload.action === 'updateTTSConfig') {
        botConfig.tts = {
          ...botConfig.tts,
          ...(payload.config || {})
        };
        saveConfig();
        broadcast({ type: 'TTS_CONFIG_UPDATE', config: botConfig.tts });
        addLog(`🎙️ Voz de TTS actualizada: ${botConfig.tts.voiceName || botConfig.tts.voiceURI}`, 'info');
      } else if (payload.action === 'getRules') {
        ws.send(JSON.stringify({ type: 'RULES_UPDATE', rules: botConfig.rules }));
      } else if (payload.action === 'updateRules') {
        botConfig.rules = {
          likesReq: Number(payload.rules?.likesReq) || 1000,
          sharesReq: Number(payload.rules?.sharesReq) || 10,
          rosesReq: Number(payload.rules?.rosesReq) || 5,
          giftCategories: payload.rules?.giftCategories || botConfig.rules.giftCategories,
          mediumGifts: String(payload.rules?.mediumGifts || 'dedo, corazon, corazón').trim(),
          vipGifts: String(payload.rules?.vipGifts || 'sombrero, bigote, donut, rosquilla').trim(),
          vipMinDiamonds: Number(payload.rules?.vipMinDiamonds) || 30
        };
        saveConfig();
        broadcast({ type: 'RULES_UPDATE', rules: botConfig.rules });
        addLog(`⚙️ Reglas de regalos y desbloqueo actualizadas.`, 'info');
      } else if (payload.action === 'getQueue') {
        ws.send(JSON.stringify({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history }));
      } else if (payload.action === 'syncQueue') {
        if (Array.isArray(payload.queue)) {
          queueState.queue = payload.queue;
          verificarEliminacionServidor(queueState.queue);
        }
        if (Array.isArray(payload.history)) queueState.history = payload.history;
        saveQueueData();

        // Reenviar inmediatamente la cola a todas las ventanas abiertas (Meld Studio / OBS)
        const updateMsg = JSON.stringify({
          type: 'QUEUE_UPDATE',
          queue: queueState.queue,
          history: queueState.history
        });
        for (const client of wss.clients) {
          if (client !== ws && client.readyState === WebSocket.OPEN) {
            client.send(updateMsg);
          }
        }
      }
    } catch (e) {
      console.error('Error procesando mensaje WS:', e);
    }
  });
});

server.listen(PORT, () => {
  console.log('====================================================');
  console.log(`🚀 SLOW MD - SERVIDOR DE TIKTOK LIVE INICIADO`);
  console.log(`📡 URL Panel Streamer: http://localhost:${PORT}/?view=panel`);
  console.log(`📺 URL Overlay Meld / OBS: http://localhost:${PORT}/?view=overlay`);
  console.log('====================================================');

  // Si había un usuario configurado previamente, intentar reconectar automáticamente
  if (botConfig.lastUsername) {
    console.log(`Reconectando automáticamente a @${botConfig.lastUsername}...`);
    connectToTikTok(botConfig.lastUsername);
  }
});
