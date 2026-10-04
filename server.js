const http = require('http');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'bot-config.json');

// Cargar configuración guardada
let botConfig = { lastUsername: '' };
try {
  if (fs.existsSync(CONFIG_FILE)) {
    botConfig = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
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

  let reqUrl = req.url.split('?')[0];
  if (reqUrl === '/' || reqUrl === '/index.html') {
    reqUrl = '/cola-slow-md.html';
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

  const yaCumple = (likesActuales >= 1000 || sharesActuales >= 10 || rosesActuales >= 5);
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
    if (s.status === 'locked' && s.likes >= 1000) {
      s.status = 'unlocked';
      s.unlockedReason = '1000 Likes ❤️';
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history, sound: 'normal' });
      addLog(`🔓 ¡${s.user} desbloqueó su canción "${s.title}" con 1000 likes!`, 'like');
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
    if (s.status === 'locked' && s.shares >= 10) {
      s.status = 'unlocked';
      s.unlockedReason = '10 Compartidos 🔄';
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history, sound: 'normal' });
      addLog(`🔓 ¡${s.user} desbloqueó su canción "${s.title}" con 10 compartidos!`, 'share');
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

  const isVip = r.includes('sombrero') || r.includes('bigote') || r.includes('donut') || r.includes('rosquilla') || diamondCount >= 30;
  const isMedium = r.includes('dedo') || r.includes('corazon') || r.includes('corazón');

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
    if (isVip) s.priority = 'vip';

    const desbloquear = (isVip || isMedium || s.roses >= 5 || diamondCount >= 5);
    if (desbloquear && s.status === 'locked') {
      s.status = 'unlocked';
      s.unlockedReason = `Regalo: ${giftName}`;
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history, sound: 'vip' });
      addLog(`👑 ¡${s.user} desbloqueó su canción "${s.title}" con ${giftName}!`, 'gift');
    } else {
      saveQueueData();
      broadcast({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history });
    }
  }
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

      return {
        user: chatName,          // Nombre visible en el chat
        chatName: chatName,
        displayId: displayId ? '@' + displayId : '',
        handle: userHandle,
        nickname: nickname || '',
        userId: userId || '',
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
  // Enviar estado actual, cola de canciones y logs iniciales al nuevo cliente
  ws.send(JSON.stringify({ type: 'STATUS', ...currentStatus }));
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
      } else if (payload.action === 'getQueue') {
        ws.send(JSON.stringify({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history }));
      } else if (payload.action === 'syncQueue') {
        if (Array.isArray(payload.queue)) queueState.queue = payload.queue;
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
