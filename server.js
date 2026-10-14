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
      desbloquear: ['rosa', 'corazón con los dedos', 'tik tok'],
      subirPosicion: ['rosa x10', 'corazón dedos x2', 'mención x2'],
      puesto3: ['sombrero y bigote'],
      puesto2: ['gafas de sol'],
      puesto1: ['money gun']
    },
    vipMinDiamonds: 100
  },
  layout: {
    queue: { x: 5, y: 12, width: 90, height: 32, visible: true },
    nowPlaying: { x: 5, y: 45, width: 90, height: 10, visible: true },
    tts: { x: 5, y: 64, width: 90, height: 18, visible: true },
    alerts: { x: 5, y: 20, width: 90, height: 40, visible: true }
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

  if (reqUrl === '/' || reqUrl === '/index.html' || reqUrl === '/panel' || reqUrl === '/studio-panel' || reqUrl === '/dashboard' || reqUrl === '/studio') {
    reqUrl = '/index.html';
  } else if (reqUrl === '/overlay' || reqUrl === '/studio-overlay') {
    reqUrl = '/index.html';
  } else if (reqUrl.startsWith('/widgets/cola-canciones')) {
    reqUrl = '/index.html';
  } else if (reqUrl.startsWith('/widgets/comentarios-tts')) {
    reqUrl = '/index.html';
  } else if (reqUrl.startsWith('/widgets/studio-unificado')) {
    reqUrl = '/index.html';
  } else if (reqUrl === '/api/tts') {
    let text = (params.get('q') || params.get('text') || '').slice(0, 350);
    // Filtrar todos los emojis y símbolos para que NUNCA se lean en voz alta
    text = text
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{200D}\u{FE0F}]/gu, '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }
    const lang = params.get('tl') || params.get('lang') || 'es';
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

// REGLAS 2 Y 3: Reubicar canción y contar rebases sobre canciones bloqueadas
function moverCancionConRebase(fromIdx, targetIdx) {
  if (fromIdx === targetIdx || fromIdx < 0 || fromIdx >= queueState.queue.length) return fromIdx;
  const song = queueState.queue[fromIdx];
  queueState.queue.splice(fromIdx, 1);
  queueState.queue.splice(targetIdx, 0, song);

  // Si la canción subió (targetIdx < fromIdx), pasó por encima de las que quedaron entre targetIdx + 1 y fromIdx
  if (targetIdx < fromIdx) {
    const eliminadas = [];
    for (let i = targetIdx + 1; i <= fromIdx; i++) {
      const s = queueState.queue[i];
      if (s && s.status === 'locked') {
        s.overtakenCount = (s.overtakenCount || 0) + 1;
        if (s.overtakenCount >= 4) {
          eliminadas.push(s);
        }
      }
    }
    if (eliminadas.length > 0) {
      queueState.queue = queueState.queue.filter(s => !eliminadas.includes(s));
      for (const e of eliminadas) {
        addLog(`❌ "${e.title}" (@${e.user}) fue eliminada automáticamente tras ser rebasada por 4 canciones`, 'queue');
      }
    }
  }
  return targetIdx;
}

// Encuentra la posición inmediatamente tras la última canción desbloqueada
function encontrarPosicionDesbloqueada(excluirId = null) {
  let lastUnlockedIdx = -1;
  for (let i = 0; i < queueState.queue.length; i++) {
    if (queueState.queue[i].status === 'unlocked' && queueState.queue[i].id !== excluirId) {
      lastUnlockedIdx = i;
    }
  }
  return lastUnlockedIdx + 1;
}

// FILTRO DE SPAM: Filtra comentarios que se repitan más de 2 veces en menos de 10 segundos
const userRecentComments = new Map();
function esComentarioSpam(userKey, comment) {
  const now = Date.now();
  const cleanComment = (comment || '').trim().toLowerCase();
  if (!cleanComment) return false;

  let history = userRecentComments.get(userKey) || [];
  history = history.filter(item => (now - item.time) <= 10000);

  const repetidos = history.filter(item => item.text === cleanComment).length;
  history.push({ text: cleanComment, time: now });
  userRecentComments.set(userKey, history);

  return repetidos >= 2;
}

function processServerChat(comment, userChatName, userHandle = '', userId = '') {
  const text = (comment || '').trim();

  // Detección de preguntas de cómo agregar canción a la lista
  const ayudaRegex = /(?:c[oó]mo|como)\s+(?:agrego|entro|pongo|hago|a[nñ]ado|pido|meter|subir|estar|anotar)\b.*(?:canci[oó]n|cancion|lista|cola|tema|musica)/i;
  const ayudaCortaRegex = /^(?:c[oó]mo|como)\s+(?:entro|estar|entrar)\s+(?:a\s+)?(?:la\s+)?(?:lista|cola)\??$/i;
  const ayudaPedirRegex = /^(?:c[oó]mo|como)\s+(?:pido|pedir|agregar|poner)\s+(?:una\s+)?(?:canci[oó]n|cancion|tema)\??$/i;

  if (ayudaRegex.test(text) || ayudaCortaRegex.test(text) || ayudaPedirRegex.test(text)) {
    const chatUser = (userChatName || 'Usuario').trim();
    const voiceMsg = "Para agregar una canción a la lista debes poner la palabra escucha más el nombre de la canción más el nombre del artista y se agrega automáticamente a la lista.";
    const bannerMsg = "Comenta: Escucha [Canción] - [Artista]";
    broadcast({
      type: 'HOW_TO_ADD_HELP',
      user: chatUser,
      bannerText: bannerMsg,
      voiceText: voiceMsg
    });
    addLog(`💡 ${chatUser} preguntó cómo agregar canción -> Bot respondió con instrucciones`, 'chat');
    return true;
  }

  // Regla 4: Alguien comenta "Lista" en el chat
  if (/^lista\b/i.test(text)) {
    const chatUser = (userChatName || 'Usuario').trim();
    broadcast({
      type: 'SHOW_LIST',
      queue: queueState.queue,
      requestedBy: chatUser
    });
    addLog(`📋 ${chatUser} comentó "Lista" -> Mostrando lista completa en el overlay`, 'chat');
    return true;
  }

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

  // REGLA 1: Quien ya tenga 1 canción en la lista no podrá agregar otra hasta que salga
  const idx = queueState.queue.findIndex(s => {
    const k = normalizarUserKey(s.user);
    const kh = s.handle ? normalizarUserKey(s.handle) : '';
    return (k && (k === userKey || (handleKey && k === handleKey))) ||
           (kh && (kh === userKey || (handleKey && kh === handleKey)));
  });

  if (idx !== -1) {
    const yaTiene = queueState.queue[idx];
    const aviso = `${chatName}, ya tienes una canción en la lista`;
    broadcast({
      type: 'CHAT_WARNING',
      user: chatName,
      message: aviso,
      existingSong: yaTiene.title
    });
    addLog(`⚠️ ${chatName} intentó agregar otra canción pero ya tiene "${yaTiene.title}" en lista`, 'chat');
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
    overtakenCount: 0,
    timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
  };

  // REGLAS 2 Y 3: Si entra desbloqueada sube por encima de las bloqueadas
  if (status === 'unlocked') {
    const targetIdx = encontrarPosicionDesbloqueada();
    queueState.queue.splice(targetIdx, 0, nuevaCancion);
    const eliminadas = [];
    for (let i = targetIdx + 1; i < queueState.queue.length; i++) {
      const s = queueState.queue[i];
      if (s && s.status === 'locked') {
        s.overtakenCount = (s.overtakenCount || 0) + 1;
        if (s.overtakenCount >= 4) eliminadas.push(s);
      }
    }
    if (eliminadas.length > 0) {
      queueState.queue = queueState.queue.filter(s => !eliminadas.includes(s));
      for (const e of eliminadas) {
        addLog(`❌ Canción eliminada [4 canciones le pasaron por encima]: "${e.title}" de @${e.user}`, 'queue');
      }
    }
  } else {
    nuevaCancion.overtakenCount = 0;
    queueState.queue.push(nuevaCancion);
  }

  saveQueueData();
  const announcement = status === 'unlocked'
    ? `¡${chatName} agregó y desbloqueó "${cancionDetectada}"!`
    : `¡${chatName} agregó "${cancionDetectada}" a la lista!`;
  broadcast({
    type: 'QUEUE_UPDATE',
    queue: queueState.queue,
    history: queueState.history,
    sound: status === 'unlocked' ? 'normal' : null,
    newSong: nuevaCancion,
    eventType: 'new_song',
    announcement: announcement
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
      s.unlockedReason = `${likesReq} Tap Tap`;
      const targetPos = encontrarPosicionDesbloqueada(s.id);
      moverCancionConRebase(idx, targetPos);
      saveQueueData();
      const announcement = `¡${s.user} desbloqueó su canción con ${likesReq} tap tap!`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        sound: 'normal',
        eventType: 'unlock',
        songTitle: s.title,
        songUser: s.user,
        unlockReason: `${likesReq} tap tap`,
        announcement: announcement
      });
      addLog(`🔓 ¡${s.user} desbloqueó su canción "${s.title}" con ${likesReq} tap tap!`, 'like');
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
      s.unlockedReason = `${sharesReq} Veces Compartido`;
      const targetPos = encontrarPosicionDesbloqueada(s.id);
      moverCancionConRebase(idx, targetPos);
      saveQueueData();
      const announcement = `¡${s.user} desbloqueó su canción con ${sharesReq} veces compartido!`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        sound: 'normal',
        eventType: 'unlock',
        songTitle: s.title,
        songUser: s.user,
        unlockReason: `${sharesReq} veces compartido`,
        announcement: announcement
      });
      addLog(`🔓 ¡${s.user} desbloqueó su canción "${s.title}" con ${sharesReq} veces compartido!`, 'share');
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
  const puesto1Keywords = (cats.puesto1 || ['money gun', 'moneygun']).map(k => k.toLowerCase().trim()).filter(Boolean);
  const puesto2Keywords = (cats.puesto2 || ['gafas', 'lentes']).map(k => k.toLowerCase().trim()).filter(Boolean);
  const puesto3Keywords = (cats.puesto3 || ['sombrero', 'bigote']).map(k => k.toLowerCase().trim()).filter(Boolean);
  const subirKeywords = (cats.subirPosicion || ['rosa x10', 'corazón dedos x2', 'mención x2', 'mencion', 'dedo x2']).map(k => k.toLowerCase().trim()).filter(Boolean);
  const desbloquearKeywords = (cats.desbloquear || ['rosa', 'corazón con los dedos', 'dedo', 'tik tok']).map(k => k.toLowerCase().trim()).filter(Boolean);

  const vipMinDiamonds = Number(botConfig.rules?.vipMinDiamonds) || 100;
  const rosesReq = Number(botConfig.rules?.rosesReq) || 5;

  const isPuesto1 = puesto1Keywords.some(kw => r.includes(kw)) || r.includes('money gun') || diamondCount >= vipMinDiamonds;
  const isPuesto2 = puesto2Keywords.some(kw => r.includes(kw)) || r.includes('gafas') || r.includes('lentes');
  const isPuesto3 = puesto3Keywords.some(kw => r.includes(kw)) || r.includes('sombrero') || r.includes('bigote');
  const isSubir = subirKeywords.some(kw => r.includes(kw)) || (isRosa && (repeatCount >= 10 || totalRoses >= 10)) || r.includes('x10') || r.includes('x2');
  const isDesbloquear = desbloquearKeywords.some(kw => r.includes(kw)) || (isRosa && totalRoses >= rosesReq) || diamondCount >= 5;

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

    // 1. Desbloquea y pasa a Puesto #1 (Money Gun o VIP alto)
    if (isPuesto1) {
      s.status = 'unlocked';
      s.priority = 'vip';
      s.unlockedReason = `Puesto #1: ${giftName}`;
      moverCancionConRebase(idx, 0);
      saveQueueData();
      const announcement = `¡${s.user} desbloqueó su canción y subió al puesto VIP con ${giftName}!`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        sound: 'top1',
        eventType: 'hands_top1',
        songTitle: s.title,
        songUser: s.user,
        newPosition: 1,
        announcement: announcement
      });
      addLog(`🥇 ¡${s.user} catapultó "${s.title}" al PUESTO #1 con ${giftName}!`, 'gift');
    // 2. Desbloquea y pasa a Puesto #2 (Gafas de sol)
    } else if (isPuesto2) {
      s.status = 'unlocked';
      s.priority = 'vip';
      s.unlockedReason = `Puesto #2: ${giftName}`;
      const targetPos = Math.min(1, Math.max(0, queueState.queue.length - 1));
      moverCancionConRebase(idx, targetPos);
      saveQueueData();
      const announcement = `¡${s.user} desbloqueó su canción y subió a la posición 2 con ${giftName}!`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        sound: 'top1',
        eventType: 'move_up',
        songTitle: s.title,
        songUser: s.user,
        newPosition: 2,
        announcement: announcement
      });
      addLog(`🥈 ¡${s.user} pasó "${s.title}" al PUESTO #2 con ${giftName}!`, 'gift');
    // 3. Desbloquea y pasa a Puesto #3 (Sombrero y bigote)
    } else if (isPuesto3) {
      s.status = 'unlocked';
      s.priority = 'vip';
      s.unlockedReason = `Puesto #3: ${giftName}`;
      const targetPos = Math.min(2, Math.max(0, queueState.queue.length - 1));
      moverCancionConRebase(idx, targetPos);
      saveQueueData();
      const announcement = `¡${s.user} desbloqueó su canción y subió a la posición 3 con ${giftName}!`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        sound: 'top1',
        eventType: 'move_up',
        songTitle: s.title,
        songUser: s.user,
        newPosition: 3,
        announcement: announcement
      });
      addLog(`🥉 ¡${s.user} pasó "${s.title}" al PUESTO #3 con ${giftName}!`, 'gift');
    // 4. Subir 1 posición (Rosa x10, Corazón dedos x2, Mención x2)
    } else if (isSubir) {
      if (s.priority !== 'vip') s.priority = 'medium';
      const targetPos = Math.max(0, idx - 1);
      moverCancionConRebase(idx, targetPos);
      const newPos = targetPos + 1;
      saveQueueData();
      const announcement = `¡${s.user} subió su canción a la posición ${newPos} con ${giftName}!`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        sound: 'subir',
        eventType: 'move_up',
        songTitle: s.title,
        songUser: s.user,
        newPosition: newPos,
        announcement: announcement
      });
      addLog(`🚀 ¡${s.user} subió a la posición #${newPos} con "${s.title}" gracias a ${giftName}!`, 'gift');
    // 5. Desbloquear canción (Rosa x5, Corazón con los dedos x1, etc.)
    } else if (isDesbloquear) {
      s.status = 'unlocked';
      s.unlockedReason = `Desbloqueo: ${giftName}`;
      const targetPos = encontrarPosicionDesbloqueada(s.id);
      moverCancionConRebase(idx, targetPos);
      saveQueueData();
      const giftLabel = isRosa && totalRoses > 1 ? `${totalRoses} rosas` : giftName;
      const announcement = `¡${s.user} desbloqueó su canción con ${giftLabel}!`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        sound: 'normal',
        eventType: 'unlock',
        songTitle: s.title,
        songUser: s.user,
        announcement: announcement
      });
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

      const userKey = normalizarUserKey(info.chatName);
      if (esComentarioSpam(userKey, comment)) {
        addLog(`🚫 Comentario silenciado por spam (>2 repetidos en 10s): "${comment}" (@${info.chatName})`, 'chat');
        return;
      }

      addLog(`💬 ${info.chatName} (${info.handle}): ${comment}`, 'chat');
      const wasAction = processServerChat(comment, info.chatName, info.handle, info.userId);
      if (!wasAction) {
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
      }
    });

    // Escuchar cuando alguien sigue el canal en vivo
    tiktokConnection.on(WebcastEvent.FOLLOW, (data) => {
      const info = extractUserInfo(data);
      knownFollowers.add(normalizarUserKey(info.chatName));
      knownFollowers.add(normalizarUserKey(info.handle));
      if (info.displayId) knownFollowers.add(normalizarUserKey(info.displayId));
      addLog(`➕ ${info.chatName} comenzó a seguirte`, 'follow');
      const announcement = `${info.chatName} se sumó a la comunidad`;
      broadcast({
        type: 'FOLLOW',
        user: info.chatName,
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId,
        avatarUrl: info.avatarUrl,
        announcement: announcement,
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
      const primerNombre = (info.chatName || 'Alguien').trim().split(/[\s_.-]+/)[0] || info.chatName;
      const announcement = `${primerNombre} mandó este live a su crush`;
      broadcast({
        type: 'SHARE',
        user: info.chatName,
        primerNombre: primerNombre,
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId,
        avatarUrl: info.avatarUrl,
        announcement: announcement,
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
  // Enviar estado actual, cola de canciones, reglas, layout y logs iniciales al nuevo cliente
  ws.send(JSON.stringify({ type: 'STATUS', ...currentStatus }));
  ws.send(JSON.stringify({ type: 'RULES_UPDATE', rules: botConfig.rules }));
  ws.send(JSON.stringify({ type: 'TTS_CONFIG_UPDATE', config: botConfig.tts }));
  ws.send(JSON.stringify({ type: 'LAYOUT_UPDATE', layout: botConfig.layout }));
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
      } else if (payload.action === 'getLayout') {
        ws.send(JSON.stringify({ type: 'LAYOUT_UPDATE', layout: botConfig.layout }));
      } else if (payload.action === 'updateLayout') {
        botConfig.layout = {
          ...botConfig.layout,
          ...(payload.layout || {})
        };
        saveConfig();
        broadcast({ type: 'LAYOUT_UPDATE', layout: botConfig.layout });
        addLog(`📱 Diseño y posiciones de overlay actualizadas.`, 'info');
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
          vipMinDiamonds: Number(payload.rules?.vipMinDiamonds) || 100
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
