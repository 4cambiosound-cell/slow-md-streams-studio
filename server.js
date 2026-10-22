const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const { WebSocketServer, WebSocket } = require('ws');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');
const { MsEdgeTTS, OUTPUT_FORMAT } = require('msedge-tts');

const PORT = process.env.PORT || 3000;
const CONFIG_FILE = path.join(__dirname, 'bot-config.json');

// Pack de Voces Neuronales Realistas (Microsoft Azure / Edge Neural HD) - Cero voces robóticas de TikTok
const NATURAL_NEURAL_VOICES = [
  { id: 'es-CO-GonzaloNeural', name: '🇨🇴 Gonzalo (Colombia - Masculina Natural)', gender: 'M' },
  { id: 'es-CO-SalomeNeural', name: '🇨🇴 Salomé (Colombia - Femenina Natural)', gender: 'F' },
  { id: 'es-DO-EmilioNeural', name: '🇩🇴 Emilio (Rep. Dominicana - Masculina Urbana)', gender: 'M' },
  { id: 'es-DO-RamonaNeural', name: '🇩🇴 Ramona (Rep. Dominicana - Femenina Caribeña)', gender: 'F' },
  { id: 'es-PR-VictorNeural', name: '🇵🇷 Víctor (Puerto Rico - Masculina Natural)', gender: 'M' },
  { id: 'es-PR-KarinaNeural', name: '🇵🇷 Karina (Puerto Rico - Femenina Natural)', gender: 'F' },
  { id: 'es-MX-JorgeNeural', name: '🇲🇽 Jorge (México - Masculina Locutor)', gender: 'M' },
  { id: 'es-MX-DaliaNeural', name: '🇲🇽 Dalia (México - Femenina Cálida)', gender: 'F' },
  { id: 'es-AR-TomasNeural', name: '🇦🇷 Tomás (Argentina - Masculina Natural)', gender: 'M' },
  { id: 'es-AR-ElenaNeural', name: '🇦🇷 Elena (Argentina - Femenina Natural)', gender: 'F' },
  { id: 'es-VE-SebastianNeural', name: '🇻🇪 Sebastián (Venezuela - Masculina Natural)', gender: 'M' },
  { id: 'es-VE-PaolaNeural', name: '🇻🇪 Paola (Venezuela - Femenina Natural)', gender: 'F' },
  { id: 'es-US-AlonsoNeural', name: '🇺🇸 Alonso (Latino USA - Masculina Estudio)', gender: 'M' },
  { id: 'es-US-PalomaNeural', name: '🇺🇸 Paloma (Latino USA - Femenina Estudio)', gender: 'F' },
  { id: 'es-ES-AlvaroNeural', name: '🇪🇸 Álvaro (España - Masculina Narrador)', gender: 'M' },
  { id: 'es-ES-ElviraNeural', name: '🇪🇸 Elvira (España - Femenina Natural)', gender: 'F' }
];

// Cargar configuración guardada
const PLAYLIST_FILE = path.join(__dirname, 'certified-playlist.json');

let botConfig = {
  lastUsername: '',
  requireFollowerToRequest: true,
  queueLocked: false,
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
    voiceURI: 'es-CO-GonzaloNeural',
    voiceName: '🇨🇴 Gonzalo (Colombia - Masculina Natural)',
    voiceLang: 'es-CO',
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
      rules: { ...botConfig.rules, ...(loaded.rules || {}) },
      tts: { ...botConfig.tts, ...(loaded.tts || {}), tiktokVoice: false }
    };
    // Si tenía una voz robótica antigua o de TikTok, migrar automáticamente a voz neuronal realista
    if (!botConfig.tts.voiceURI || !botConfig.tts.voiceURI.endsWith('Neural')) {
      botConfig.tts.voiceURI = 'es-CO-GonzaloNeural';
      botConfig.tts.voiceName = '🇨🇴 Gonzalo (Colombia - Masculina Natural)';
    }
  }
} catch (e) {
  console.error('[Config] Error leyendo bot-config.json:', e.message);
}

// Cargar "La Playlist" de Artistas Certificados (>=98%)
let certifiedPlaylist = [];
try {
  if (fs.existsSync(PLAYLIST_FILE)) {
    certifiedPlaylist = JSON.parse(fs.readFileSync(PLAYLIST_FILE, 'utf8'));
    if (!Array.isArray(certifiedPlaylist)) certifiedPlaylist = [];
  }
} catch (e) {
  certifiedPlaylist = [];
}

function saveCertifiedPlaylist() {
  try {
    fs.writeFileSync(PLAYLIST_FILE, JSON.stringify(certifiedPlaylist, null, 2), 'utf8');
  } catch (e) {
    console.error('[Playlist] Error guardando certified-playlist.json:', e.message);
  }
}

// ESTADO GLOBAL DE ENCUESTA / JURADO (25s)
let votingState = {
  active: false,
  song: null,
  voters: new Map(), // userKey -> score
  duration: 25,
  startedAt: 0,
  timer: null
};

// Parser robusto de calificaciones del 1 al 10 en diversos formatos:
// "Le doy 2", "Un 7", "10/10", "8.9", "8,5", "9 de 10", "10", "Doy un 9", "Nota 8"
function parseScore(comment) {
  if (!comment) return null;
  // Convertir comas decimales a punto (ej: 8,5 -> 8.5)
  let t = comment.trim().toLowerCase().replace(/(\d+),(\d+)/g, '$1.$2');

  // 1. Caso fracciones: "10/10", "8.5/10", "9 de 10", "10 de 10"
  const fractionMatch = t.match(/\b([1-9](?:\.[0-9]+)?|10)\s*(?:\/|\s+de\s+)\s*10\b/i);
  if (fractionMatch) {
    const num = parseFloat(fractionMatch[1]);
    if (num >= 1 && num <= 10) return num;
  }

  // 2. Caso prefijos: "le doy 10", "le doy un 8.5", "le pongo 9", "doy 8", "nota: 10", "un 7", "para mi un 9"
  const prefixMatch = t.match(/(?:doy|pongo|califico|nota|calificaci[oó]n|puntos?|le\s+doy|un)\s+(?:un\s+)?([1-9](?:\.[0-9]+)?|10)\b/i);
  if (prefixMatch) {
    const num = parseFloat(prefixMatch[1]);
    if (num >= 1 && num <= 10) return num;
  }

  // 3. Caso número directo solo: "10", "8", "9.5", "7"
  const directMatch = t.match(/^\s*([1-9](?:\.[0-9]+)?|10)\s*$/);
  if (directMatch) {
    const num = parseFloat(directMatch[1]);
    if (num >= 1 && num <= 10) return num;
  }

  // 4. En comentarios cortos (<= 25 caracteres), buscar número entre 1 y 10
  if (t.length <= 25) {
    const shortMatch = t.match(/\b([1-9](?:\.[0-9]+)?|10)\b/);
    if (shortMatch) {
      const num = parseFloat(shortMatch[1]);
      if (num >= 1 && num <= 10) return num;
    }
  }

  return null;
}

// #6 Limpiar nombre de usuario para lectura TTS (sin signos, símbolos, guiones bajos ni emojis, solo letras)
function limpiarNombreParaVoz(nombre) {
  if (!nombre) return 'Usuario';
  const limpio = String(nombre)
    .replace(/https?:\/\/\S+/gi, ' ')
    .replace(/[@_.\-+*/\\|#$%&()[\]{}<>=~^`"'!¡?¿,:;0-9]/g, ' ')
    .replace(/[^\p{L}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return limpio || 'Usuario';
}

// #4 Detector de links para no leerlos nunca en voz alta
function contieneLink(texto) {
  if (!texto) return false;
  return /(?:https?:\/\/|www\.|\b(?:youtube\.com|youtu\.be|spotify\.com|spotify\.link|bandlab\.com)\b)/i.test(String(texto));
}

function startVoting(duration = 120, songOverride = null) {
  const song = songOverride || queueState.queue[0] || { title: 'Canción en Turno', user: 'Artista' };
  votingState.active = true;
  votingState.song = song;
  votingState.voters.clear();
  votingState.duration = duration;
  votingState.startedAt = Date.now();

  clearTimeout(votingState.timer);
  votingState.timer = setTimeout(() => {
    finishVoting();
  }, duration * 1000);

  const mins = Math.floor(duration / 60);
  const durText = mins >= 1 ? `${mins} minuto${mins > 1 ? 's' : ''}` : `${duration} segundos`;
  const cleanArtist = limpiarNombreParaVoz(song.user);
  const cleanTitle = contieneLink(song.title) ? `el tema de ${cleanArtist}` : limpiarNombreParaVoz(song.title);
  const voiceMsg = `¡Inicia la votación para ${cleanTitle}! ¿Cuánto le damos del 1 al 10? Tienen ${durText} para calificar. Se requieren mínimo 10 votos.`;
  broadcast({
    type: 'VOTING_STARTED',
    song: song,
    duration: duration,
    voiceAnnouncement: voiceMsg
  });
  addLog(`⚖️ ¡Inició votación para "${song.title}" (${duration}s, mín. 10 votos)!`, 'queue');
}

function cancelVoting() {
  if (!votingState.active) return;
  votingState.active = false;
  clearTimeout(votingState.timer);
  broadcast({ type: 'VOTING_CANCELLED' });
  addLog(`❌ Votación cancelada.`, 'warn');
}

function finishVoting() {
  if (!votingState.active) return;
  votingState.active = false;
  clearTimeout(votingState.timer);

  const song = votingState.song || { title: 'Canción', user: 'Artista' };
  const totalVotes = votingState.voters.size;
  let sum = 0;
  for (const val of votingState.voters.values()) sum += val;
  const avg = totalVotes > 0 ? Number((sum / totalVotes).toFixed(1)) : 0;
  const pct = totalVotes > 0 ? Math.round((avg / 10) * 100) : 0;

  const cleanArtist = limpiarNombreParaVoz(song.user);
  const cleanTitle = contieneLink(song.title) ? `la canción de ${cleanArtist}` : `la canción ${limpiarNombreParaVoz(song.title)}`;

  // #7 Si la encuesta no llega a 10 votaciones se cancela la encuesta
  if (totalVotes < 10) {
    const cancelMsg = `La encuesta para ${cleanTitle} fue cancelada porque solo recibió ${totalVotes} votos y se requieren mínimo 10 votaciones.`;
    broadcast({
      type: 'VOTING_FINISHED',
      song: song,
      avg: avg,
      average: avg,
      pct: pct,
      percentage: pct,
      totalVotes: totalVotes,
      votes: totalVotes,
      approved: false,
      certified: false,
      cancelledByMinVotes: true,
      minVotesRequired: 10,
      voiceAnnouncement: cancelMsg,
      certifiedPlaylist: certifiedPlaylist
    });
    addLog(`⚠️ Encuesta cancelada para "${song.title}": solo alcanzó ${totalVotes}/10 votos mínimos.`, 'warn');
    return;
  }

  // #7 Los temas que saquen de 95 a 100 entran a La Playlist
  const approved = pct >= 95;

  let voiceMsg = '';
  if (approved) {
    voiceMsg = `¡${cleanTitle} obtuvo ${pct} por ciento y entra a nuestra lista de artistas certificados! ¡Excelente trabajo!`;
    const certItem = {
      id: 'cert_' + Date.now(),
      title: song.title,
      songUrl: song.songUrl || '',
      user: song.user,
      score: avg,
      average: avg,
      percentage: pct,
      totalVotes: totalVotes,
      votes: totalVotes,
      certifiedAt: new Date().toLocaleDateString('es-ES', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' })
    };
    certifiedPlaylist.unshift(certItem);
    saveCertifiedPlaylist();
  } else {
    voiceMsg = `${cleanTitle} obtuvo ${pct} por ciento y no califica para entrar a nuestra lista. ¡Siga trabajando en pulir su talento!`;
  }

  broadcast({
    type: 'VOTING_FINISHED',
    song: song,
    avg: avg,
    average: avg,
    pct: pct,
    percentage: pct,
    totalVotes: totalVotes,
    votes: totalVotes,
    approved: approved,
    certified: approved,
    cancelledByMinVotes: false,
    voiceAnnouncement: voiceMsg,
    certifiedPlaylist: certifiedPlaylist
  });

  addLog(`🏁 Votación finalizada para "${song.title}": ${pct}% (${avg}/10) con ${totalVotes} votos. ${approved ? '⭐ CERTIFICADA (95-100%)' : '❌ NO CALIFICA (<95%)'}`, 'queue');
}

function saveConfig() {
  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(botConfig, null, 2), 'utf8');
  } catch (e) {
    console.error('[Config] Error guardando bot-config.json:', e.message);
  }
}

// Seguidores conocidos en memoria durante el stream y timestamp de conexión
const knownFollowers = new Set();
// #3 Usuarios que enviaron "Quiéreme" en el Live actual (solo a ellos se les leen los comentarios)
const quieremeUsers = new Set();
// #1 Likes globales del Live actual y meta de desbloqueo de lista
let globalStreamLikes = 0;
let connectedAt = 0;

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
  } else if (reqUrl === '/api/voices') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=UTF-8', 'Access-Control-Allow-Origin': '*' });
    res.end(JSON.stringify({ voices: NATURAL_NEURAL_VOICES, currentVoice: botConfig.tts?.voiceURI || 'es-CO-GonzaloNeural' }));
    return;
  } else if (reqUrl === '/api/tts') {
    let text = (params.get('q') || params.get('text') || '').slice(0, 350);
    // Filtrar todos los emojis y símbolos para que NUNCA se lean en voz alta
    text = text
      .replace(/https?:\/\/\S+/gi, '')
      .replace(/[\u{1F600}-\u{1F64F}\u{1F300}-\u{1F5FF}\u{1F680}-\u{1F6FF}\u{1F700}-\u{1F77F}\u{1F780}-\u{1F7FF}\u{1F800}-\u{1F8FF}\u{1F900}-\u{1F9FF}\u{1FA00}-\u{1FA6F}\u{1FA70}-\u{1FAFF}\u{2600}-\u{26FF}\u{2700}-\u{27BF}\u{2300}-\u{23FF}\u{2B50}\u{200D}\u{FE0F}]/gu, '')
      .replace(/\p{Extended_Pictographic}/gu, '')
      .replace(/\s+/g, ' ')
      .trim();

    if (!text) {
      res.writeHead(204, { 'Access-Control-Allow-Origin': '*' });
      res.end();
      return;
    }

    // Determinar la voz neuronal seleccionada (por parámetro o por configuración global del bot)
    let requestedVoice = (params.get('voice') || botConfig.tts?.voiceURI || 'es-CO-GonzaloNeural').trim();
    const isValidNeural = NATURAL_NEURAL_VOICES.some(v => v.id === requestedVoice) || /^[a-z]{2}-[A-Z]{2}-[A-Za-z]+Neural$/.test(requestedVoice);
    if (!isValidNeural) {
      requestedVoice = 'es-CO-GonzaloNeural';
    }

    // Escapar caracteres XML para el SSML de Microsoft Neural TTS
    const xmlSafeText = text
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&apos;');

    (async () => {
      let ttsInstance = null;
      try {
        ttsInstance = new MsEdgeTTS({ connectionTimeoutMs: 7000, synthesisTimeoutMs: 12000 });
        await ttsInstance.setMetadata(requestedVoice, OUTPUT_FORMAT.AUDIO_24KHZ_96KBITRATE_MONO_MP3);
        const { audioStream } = ttsInstance.toStream(xmlSafeText);
        const chunks = [];
        await new Promise((resolve, reject) => {
          audioStream.on('data', (chunk) => chunks.push(Buffer.from(chunk)));
          audioStream.on('end', resolve);
          audioStream.on('close', resolve);
          audioStream.on('error', reject);
        });
        try { ttsInstance.close(); } catch (e) {}

        const audioBuffer = Buffer.concat(chunks);
        if (audioBuffer.length > 0) {
          res.writeHead(200, {
            'Content-Type': 'audio/mpeg',
            'Content-Length': audioBuffer.length,
            'Cache-Control': 'no-cache',
            'Access-Control-Allow-Origin': '*'
          });
          res.end(audioBuffer);
          return;
        }
        throw new Error('Buffer de audio vacío');
      } catch (err) {
        try { if (ttsInstance) ttsInstance.close(); } catch (e) {}
        // Respaldo de emergencia en caso de corte de red hacia Azure
        const ttsUrl = `https://translate.google.com/translate_tts?ie=UTF-8&tl=es&client=tw-ob&q=${encodeURIComponent(text)}`;
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
        }).on('error', () => {
          res.writeHead(500, { 'Content-Type': 'text/plain' });
          res.end('Error TTS');
        });
      }
    })();
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

// RASTREO DE LA SECUENCIA DE 3 PASOS:
// 1. Seguirme
// 2. Compartir el Live
// 3. Enviar Corazón con los Dedos
const userSteps = new Map();

function getUserStepData(userKey, name, handle, avatarUrl) {
  let data = userSteps.get(userKey);
  if (!data) {
    data = {
      followed: false,
      shared: false,
      giftedHeart: false,
      likesGiven: 0,
      name: name || userKey,
      handle: handle || '',
      avatarUrl: avatarUrl || ''
    };
    userSteps.set(userKey, data);
  }
  if (name) data.name = name;
  if (handle) data.handle = handle;
  if (avatarUrl) data.avatarUrl = avatarUrl;
  return data;
}

function verificarCompletitudPasos(userKey, extraInfo = {}) {
  const data = userSteps.get(userKey);
  if (!data) return false;

  // Si la lista está bloqueada (por comando 0 o meta de likes), no entra todavía
  if (botConfig.queueLocked) return false;

  const userIsFollower = Boolean(
    data.followed ||
    knownFollowers.has(userKey) ||
    (data.handle && knownFollowers.has(normalizarUserKey(data.handle)))
  );

  // #2 Opción gratuita: 5,000 likes reemplazan el Corazón con los dedos
  const totalUserLikes = Math.max(data.likesGiven || 0, serverUserLikes.get(userKey) || 0);
  const hasStep3 = Boolean(data.giftedHeart || totalUserLikes >= 5000);

  const isComplete = userIsFollower && data.shared && hasStep3;
  if (isComplete) {
    // Verificar si ya tiene disco o canción en la cola
    const idx = queueState.queue.findIndex(s => {
      const k = normalizarUserKey(s.user);
      const kh = s.handle ? normalizarUserKey(s.handle) : '';
      return k === userKey || (kh && kh === userKey);
    });

    if (idx === -1) {
      const viaCorazon = Boolean(data.giftedHeart);
      const metodoPaso3 = viaCorazon ? 'Corazón con los dedos' : '5,000 Likes Gratis';
      const nuevoDisco = {
        id: 'disk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        title: 'Esperando link de canción...',
        songUrl: '',
        platform: '',
        user: data.name,
        handle: data.handle || '',
        avatarUrl: data.avatarUrl || extraInfo.avatarUrl || '',
        gift: metodoPaso3,
        status: 'unlocked',
        priority: 'normal',
        vip150: false,
        overtakenCount: 0,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      queueState.queue.push(nuevoDisco);
      saveQueueData();

      const announcement = `¡${data.name} entró a la lista (${metodoPaso3})! Pega el link de YouTube, Spotify o BandLab en el chat.`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        newSong: nuevoDisco,
        newSongDesc: `${metodoPaso3} • Pega tu link de YouTube, Spotify o BandLab`,
        sound: 'normal',
        eventType: 'new_song',
        skipVoice: true,
        announcement: announcement
      });
      addLog(`⭐ ${data.name} completó los 3 pasos (${metodoPaso3}) -> Disco añadido a la lista`, 'queue');
      return true;
    }
  }
  return false;
}

// Al desbloquearse la lista, verificar si usuarios ya habían completado sus pasos
function procesarPasosPendientesAlDesbloquear() {
  for (const userKey of userSteps.keys()) {
    verificarCompletitudPasos(userKey);
  }
}

// #4 Detector de links de YouTube, Spotify o BandLab
function detectarLinkCancion(text) {
  if (!text) return null;
  const match = String(text).match(/(?:https?:\/\/)?(?:www\.|m\.|music\.|open\.)?(youtube\.com\/\S+|youtu\.be\/\S+|spotify\.com\/\S+|spotify\.link\/\S+|bandlab\.com\/\S+)/i);
  if (!match) return null;

  let rawUrl = match[0].replace(/[.,;!?)"'\]]+$/, '');
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = 'https://' + rawUrl;
  }

  const lower = rawUrl.toLowerCase();
  let platform = 'youtube';
  let label = 'YouTube';
  if (lower.includes('spotify.')) {
    platform = 'spotify';
    label = 'Spotify';
  } else if (lower.includes('bandlab.')) {
    platform = 'bandlab';
    label = 'BandLab';
  }

  return {
    url: rawUrl,
    platform,
    label
  };
}

// Resolver título real desde oEmbed (YouTube/Spotify) sin bloquear y sin hablar en TTS
function resolverTituloDeLink(songObj, url, label) {
  try {
    const oembedUrl = `https://noembed.com/embed?url=${encodeURIComponent(url)}`;
    https.get(oembedUrl, (res) => {
      let body = '';
      res.on('data', chunk => { body += chunk; });
      res.on('end', () => {
        try {
          const json = JSON.parse(body);
          if (json && json.title && typeof json.title === 'string') {
            const cleanTitle = json.title.trim();
            if (cleanTitle) {
              songObj.title = `🔗 ${cleanTitle}`;
              saveQueueData();
              broadcast({
                type: 'QUEUE_UPDATE',
                queue: queueState.queue,
                history: queueState.history,
                skipVoice: true
              });
            }
          }
        } catch (e) {}
      });
    }).on('error', () => {});
  } catch (e) {}
}

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

// #8 Calcular posición objetivo respetando el blindaje VIP de regalos de 150+ monedas
function calcularTargetConBlindaje(fromIdx, stepsUp) {
  let minAllowedIdx = 0;
  for (let i = 0; i < fromIdx; i++) {
    if (queueState.queue[i] && queueState.queue[i].vip150) {
      minAllowedIdx = i + 1;
    }
  }
  const desiredIdx = Math.max(0, fromIdx - stepsUp);
  return Math.max(minAllowedIdx, desiredIdx);
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

function processServerChat(comment, userChatName, userHandle = '', userId = '', isFollower = false, isModerator = false) {
  const text = (comment || '').trim();

  // STREAMER & MODERATOR AUTHORIZATION CHECK
  const cleanHandle = (userHandle || '').toLowerCase().replace(/^@/, '');
  const cleanName = (userChatName || '').toLowerCase().replace(/^@/, '');
  const configUser = (botConfig.lastUsername || '').toLowerCase().replace(/^@/, '');

  const isStreamer = Boolean(
    (cleanHandle && (cleanHandle === configUser || cleanHandle === 'slowmdoficial')) ||
    (cleanName && (cleanName === configUser || cleanName === 'slowmdoficial'))
  );
  const isAuthorized = isStreamer || isModerator;

  // COMANDOS DE CONTROL DESDE EL STREAMER / MODERADORES:
  if (isAuthorized) {
    // 1. (...) -> Explicación de cómo agregar canción a la lista
    if (text === '...' || text === '…' || /^\.{3,}$/.test(text)) {
      const voiceMsg = "Para entrar a la lista debes seguirme, compartir el live y enviar un corazón con los dedos o llegar a 5000 likes. Luego pega el link de tu canción de YouTube, Spotify o BandLab.";
      const bannerMsg = "1. Seguirme • 2. Compartir • 3. Corazón con los dedos o 5,000 Likes • 4. Pegar Link";
      broadcast({
        type: 'HOW_TO_ADD_HELP',
        user: userChatName,
        bannerText: bannerMsg,
        voiceText: voiceMsg
      });
      addLog(`💡 Streamer solicitó explicación con (...)`, 'chat');
      return true;
    }

    // 2. #1 Fórmula (0-#) -> Bloquear lista hasta llegar a cierta cantidad de likes (ej. 0-50000)
    const lockGoalMatch = text.match(/^0\s*-\s*(\d+)$/);
    if (lockGoalMatch) {
      const targetLikes = parseInt(lockGoalMatch[1], 10);
      botConfig.queueLocked = true;
      botConfig.lockTargetLikes = targetLikes;
      saveConfig();
      const announcement = `🔒 Lista bloqueada hasta llegar a ${targetLikes.toLocaleString()} likes en el Live.`;
      broadcast({
        type: 'QUEUE_LOCK_UPDATE',
        locked: true,
        lockTargetLikes: targetLikes,
        currentLikes: globalStreamLikes,
        skipVoice: true,
        announcement: announcement
      });
      addLog(`🔒 Streamer bloqueó la lista hasta alcanzar ${targetLikes.toLocaleString()} likes (0-${targetLikes})`, 'queue');
      return true;
    }

    // 3. (0) -> Bloquear lista de canciones indefinidamente
    if (text === '0') {
      botConfig.queueLocked = true;
      botConfig.lockTargetLikes = null;
      saveConfig();
      const announcement = "🔒 La lista de canciones ha sido bloqueada temporalmente.";
      broadcast({
        type: 'QUEUE_LOCK_UPDATE',
        locked: true,
        lockTargetLikes: null,
        currentLikes: globalStreamLikes,
        skipVoice: true,
        announcement: announcement
      });
      addLog(`🔒 Streamer bloqueó la lista de canciones (0)`, 'queue');
      return true;
    }

    // 4. (G o g) -> Reabrir lista de canciones
    if (text.toLowerCase() === 'g') {
      botConfig.queueLocked = false;
      botConfig.lockTargetLikes = null;
      saveConfig();
      const announcement = "🔓 ¡La lista de canciones ha sido reabierta! Ya pueden entrar y pegar sus links.";
      broadcast({
        type: 'QUEUE_LOCK_UPDATE',
        locked: false,
        lockTargetLikes: null,
        currentLikes: globalStreamLikes,
        skipVoice: true,
        announcement: announcement
      });
      addLog(`🔓 Streamer reabrió la lista de canciones (G)`, 'queue');
      procesarPasosPendientesAlDesbloquear();
      return true;
    }

    // 5. (borra a X) -> Eliminar la canción de un usuario específico
    const borraMatch = text.match(/^borra\s+a\s+(.+)$/i);
    if (borraMatch) {
      const target = borraMatch[1].trim().replace(/^@/, '');
      const targetKey = normalizarUserKey(target);
      const idx = queueState.queue.findIndex(s => {
        return normalizarUserKey(s.user) === targetKey ||
               (s.handle && normalizarUserKey(s.handle) === targetKey) ||
               s.user.toLowerCase().includes(target.toLowerCase());
      });
      if (idx !== -1) {
        const removed = queueState.queue.splice(idx, 1)[0];
        saveQueueData();
        const announcement = `Se eliminó el disco de ${removed.user} de la lista.`;
        broadcast({
          type: 'QUEUE_UPDATE',
          queue: queueState.queue,
          history: queueState.history,
          skipVoice: true,
          announcement: announcement
        });
        addLog(`🗑️ Streamer eliminó "${removed.title}" de @${removed.user}`, 'queue');
      } else {
        addLog(`⚠️ No se encontró la canción de "${target}" para eliminar`, 'queue');
      }
      return true;
    }

    // 6. Comando "calificar" o "encuesta" para iniciar votación
    if (text.toLowerCase() === 'calificar' || text.toLowerCase() === 'encuesta') {
      startVoting(120);
      return true;
    }
  }

  // Detección de preguntas de cómo agregar canción a la lista (usuarios generales)
  const ayudaRegex = /(?:c[oó]mo|como)\s+(?:agrego|entro|pongo|hago|a[nñ]ado|pido|meter|subir|estar|anotar)\b.*(?:canci[oó]n|cancion|lista|cola|tema|musica)/i;
  const ayudaCortaRegex = /^(?:c[oó]mo|como)\s+(?:entro|estar|entrar)\s+(?:a\s+)?(?:la\s+)?(?:lista|cola)\??$/i;
  const ayudaPedirRegex = /^(?:c[oó]mo|como)\s+(?:pido|pedir|agregar|poner)\s+(?:una\s+)?(?:canci[oó]n|cancion|tema)\??$/i;

  if (ayudaRegex.test(text) || ayudaCortaRegex.test(text) || ayudaPedirRegex.test(text)) {
    const chatUser = (userChatName || 'Usuario').trim();
    const bannerMsg = "1. Seguirme • 2. Compartir • 3. Corazón con los dedos o 5,000 Likes • 4. Pegar Link (YouTube/Spotify/BandLab)";
    broadcast({
      type: 'HOW_TO_ADD_HELP',
      user: chatUser,
      bannerText: bannerMsg,
      skipVoice: true,
      voiceText: ''
    });
    addLog(`💡 ${chatUser} preguntó cómo agregar canción -> Aviso visual en pantalla`, 'chat');
    return true;
  }

  // Regla 4: Alguien comenta "Lista" en el chat -> Mostrar lista destacando su posición
  if (/^lista\b/i.test(text)) {
    const chatUser = (userChatName || 'Usuario').trim();
    const chatKey = normalizarUserKey(chatUser);
    const chatHandleKey = userHandle ? normalizarUserKey(userHandle) : '';

    const userIdx = queueState.queue.findIndex(s => {
      const k = normalizarUserKey(s.user);
      const kh = s.handle ? normalizarUserKey(s.handle) : '';
      return (k && (k === chatKey || (chatHandleKey && k === chatHandleKey))) ||
             (kh && (kh === chatKey || (chatHandleKey && kh === chatHandleKey)));
    });

    const userPosition = userIdx !== -1 ? userIdx + 1 : null;

    broadcast({
      type: 'SHOW_LIST',
      queue: queueState.queue,
      requestedBy: chatUser,
      userPosition: userPosition
    });
    addLog(`📋 ${chatUser} comentó "Lista" -> Mostrando lista (Posición: ${userPosition ? '#' + userPosition : 'No en lista'})`, 'chat');
    return true;
  }

  // #4 DETECCIÓN DE LINK DE CANCIÓN (YOUTUBE, SPOTIFY O BANDLAB)
  const linkInfo = detectarLinkCancion(text);
  if (!linkInfo) return false;

  const chatName = (userChatName || 'Usuario').trim();
  if (userHandle || userId) {
    registrarAliasServidor(chatName, userHandle, chatName, userId);
  }

  const userKey = normalizarUserKey(chatName);
  const handleKey = userHandle ? normalizarUserKey(userHandle) : '';

  // VALIDACIÓN 1: ¿LA LISTA ESTÁ BLOQUEADA?
  if (botConfig.queueLocked) {
    const metaTxt = botConfig.lockTargetLikes ? ` hasta llegar a ${botConfig.lockTargetLikes.toLocaleString()} likes` : '';
    const aviso = `🔒 Lista cerrada${metaTxt}.`;
    broadcast({
      type: 'CHAT_WARNING',
      user: chatName,
      skipVoice: true,
      message: aviso,
      bannerText: aviso
    });
    addLog(`🔒 ${chatName} envió link de ${linkInfo.label} pero la lista está bloqueada`, 'chat');
    return true;
  }

  // VALIDACIÓN 2: ¿SE REQUIERE SEGUIR AL CANAL?
  const userIsFollower = Boolean(
    isFollower ||
    knownFollowers.has(userKey) ||
    (handleKey && knownFollowers.has(handleKey)) ||
    isAuthorized
  );

  if (botConfig.requireFollowerToRequest !== false && !userIsFollower) {
    const cleanPrimerNombre = limpiarNombreParaVoz(chatName).split(' ')[0] || 'Usuario';
    const aviso = `${chatName} está intentando entrar a la lista sin seguirte 🚨`;
    broadcast({
      type: 'NOT_FOLLOWER_WARNING',
      user: chatName,
      primerNombre: cleanPrimerNombre,
      sound: 'siren',
      skipVoice: true,
      message: aviso
    });
    addLog(`🚨 ${chatName} envió link sin seguirte 🚨`, 'chat');
    return true;
  }

  // BUSCAR SI EL USUARIO YA TIENE SU DISCO EN LA LISTA
  const idx = queueState.queue.findIndex(s => {
    const k = normalizarUserKey(s.user);
    const kh = s.handle ? normalizarUserKey(s.handle) : '';
    return (k && (k === userKey || (handleKey && k === handleKey))) ||
           (kh && (kh === userKey || (handleKey && kh === handleKey)));
  });

  if (idx !== -1) {
    // YA TIENE DISCO EN LA COLA: Asignar el link a su disco (SIN LEER EN VOZ ALTA)
    const s = queueState.queue[idx];
    s.songUrl = linkInfo.url;
    s.platform = linkInfo.platform;
    s.title = `🔗 ${linkInfo.label} • @${s.user}`;
    s.status = 'unlocked';
    saveQueueData();

    const announcement = `🔗 ¡@${chatName} vinculó su canción de ${linkInfo.label} en el Puesto #${idx + 1}!`;
    broadcast({
      type: 'QUEUE_UPDATE',
      queue: queueState.queue,
      history: queueState.history,
      sound: 'normal',
      eventType: 'update_song',
      songTitle: s.title,
      songUser: s.user,
      skipVoice: true,
      announcement: announcement
    });
    addLog(`🔗 ${chatName} asignó link de ${linkInfo.label} (${linkInfo.url}) en posición #${idx + 1}`, 'chat');

    // Obtener título real de la canción en segundo plano (sin voz)
    resolverTituloDeLink(s, linkInfo.url, linkInfo.label);
    return true;
  } else {
    // NO TIENE DISCO EN LA LISTA: Mostrar aviso visual (sin voz)
    getUserStepData(userKey, chatName, userHandle);
    const bannerMsg = `Para entrar: 1. Seguirme • 2. Compartir • 3. Corazón con los dedos o 5,000 Likes`;
    broadcast({
      type: 'CHAT_WARNING',
      user: chatName,
      skipVoice: true,
      message: bannerMsg,
      bannerText: bannerMsg
    });
    addLog(`⚠️ ${chatName} envió link de ${linkInfo.label} pero aún no está en la lista.`, 'chat');
    return true;
  }
}

function processServerLike(userIdentifier, count, extraInfo = {}) {
  if (extraInfo.displayId || extraInfo.nickname || extraInfo.userId) {
    registrarAliasServidor(userIdentifier, extraInfo.displayId, extraInfo.nickname, extraInfo.userId);
  }
  const userKey = normalizarUserKey(userIdentifier);
  const total = (serverUserLikes.get(userKey) || 0) + count;
  serverUserLikes.set(userKey, total);

  // #2 Registrar likes acumulados del usuario para la opción gratuita de 5,000 likes
  const stepData = getUserStepData(userKey, userIdentifier, extraInfo.handle, extraInfo.avatarUrl);
  stepData.likesGiven = total;
  if (total >= 5000) {
    verificarCompletitudPasos(userKey, extraInfo);
  }

  const idx = queueState.queue.findIndex(s => {
    const k = normalizarUserKey(s.user);
    const kh = s.handle ? normalizarUserKey(s.handle) : '';
    return k === userKey || (kh && kh === userKey);
  });
  if (idx !== -1) {
    const s = queueState.queue[idx];
    s.likes = total;
    saveQueueData();
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
    saveQueueData();
  }
}

function processServerGift(userIdentifier, giftName, repeatCount, diamondCount, comment, extraInfo = {}) {
  if (extraInfo.displayId || extraInfo.nickname || extraInfo.userId) {
    registrarAliasServidor(userIdentifier, extraInfo.displayId, extraInfo.nickname, extraInfo.userId);
  }
  const userKey = normalizarUserKey(userIdentifier);
  const r = (giftName || '').toLowerCase();
  const totalCoins = (Number(diamondCount) || 1) * (Number(repeatCount) || 1);

  // DETECCIÓN DE REGALOS ESPECIALES
  const isCorazonDedos = (r.includes('coraz') && (r.includes('dedo') || r.includes('finger'))) || r.includes('finger heart');
  const isQuiereme = r.includes('quiéreme') || r.includes('quiereme') || r.includes('love me') || r.includes('love you') || r.includes('cuddle');

  if (comment) {
    processServerChat(comment, userIdentifier, extraInfo.handle || extraInfo.displayId, extraInfo.userId);
  }

  // 1. CASO REGALO: CORAZÓN CON LOS DEDOS (PASO 3 DE ENTRADA A LA LISTA)
  if (isCorazonDedos) {
    const stepData = getUserStepData(userKey, userIdentifier, extraInfo.handle, extraInfo.avatarUrl);
    stepData.giftedHeart = true;

    broadcast({
      type: 'EPIC_GIFT_ANIMATION',
      giftType: 'corazon_dedos',
      user: userIdentifier,
      avatarUrl: extraInfo.avatarUrl || ''
    });

    const completado = verificarCompletitudPasos(userKey, extraInfo);
    if (!completado && !botConfig.queueLocked) {
      const userIsFollower = Boolean(
        stepData.followed ||
        knownFollowers.has(userKey) ||
        (extraInfo.handle && knownFollowers.has(normalizarUserKey(extraInfo.handle)))
      );
      let faltantes = [];
      if (!userIsFollower) faltantes.push('seguirme');
      if (!stepData.shared) faltantes.push('compartir el live');

      if (faltantes.length > 0) {
        const txtFaltantes = faltantes.join(' y ');
        broadcast({
          type: 'CHAT_WARNING',
          user: userIdentifier,
          skipVoice: true,
          message: `¡Corazón recibido! Te falta: ${txtFaltantes}`,
          bannerText: `¡Corazón recibido! Te falta: ${txtFaltantes}`
        });
        addLog(`🫰 ${userIdentifier} envió Corazón con los dedos. Pasos pendientes: ${txtFaltantes}`, 'gift');
      }
    }
  }

  // 2. #3 CASO REGALO: QUIÉREME (ACTIVA LECTURA DE COMENTARIOS DEL USUARIO EN EL LIVE + ANIMACIÓN ÉPICA)
  if (isQuiereme) {
    quieremeUsers.add(userKey);
    if (extraInfo.handle) quieremeUsers.add(normalizarUserKey(extraInfo.handle));
    if (extraInfo.displayId) quieremeUsers.add(normalizarUserKey(extraInfo.displayId));

    broadcast({
      type: 'EPIC_GIFT_ANIMATION',
      giftType: 'quiereme',
      user: userIdentifier,
      avatarUrl: extraInfo.avatarUrl || ''
    });
    addLog(`💖 ${userIdentifier} envió Quiéreme -> Lectura de comentarios por voz activada durante todo el Live`, 'gift');
  }

  // 3. #8 SUBIDA DE POSICIONES SEGÚN VALOR EN MONEDAS DEL REGALO
  // - 15 a 29 monedas: sube 1 posición
  // - 30 a 149 monedas: sube 2 posiciones
  // - 150+ monedas: se pone de #1 blindado (entra directo si no estaba y solo otro de 150+ lo pasa)
  let idx = queueState.queue.findIndex(s => {
    const k = normalizarUserKey(s.user);
    const kh = s.handle ? normalizarUserKey(s.handle) : '';
    return k === userKey || (kh && kh === userKey);
  });

  if (totalCoins >= 150) {
    if (idx === -1) {
      // Entra directo al #1 blindado aunque no estuviera en la lista
      const nuevoVip = {
        id: 'vip150_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        title: 'Esperando link de canción...',
        songUrl: '',
        platform: '',
        user: userIdentifier,
        handle: extraInfo.handle || '',
        avatarUrl: extraInfo.avatarUrl || '',
        gift: `${giftName} (${totalCoins} monedas)`,
        status: 'unlocked',
        priority: 'vip',
        vip150: true,
        overtakenCount: 0,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      queueState.queue.unshift(nuevoVip);
      saveQueueData();
      const announcement = `👑 ¡@${userIdentifier} entró directo al PUESTO #1 BLINDADO con ${giftName} (${totalCoins} monedas)!`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        sound: 'top1',
        eventType: 'hands_top1',
        songTitle: nuevoVip.title,
        songUser: nuevoVip.user,
        newPosition: 1,
        skipVoice: true,
        announcement: announcement
      });
      addLog(`👑 ¡${userIdentifier} entró directo al PUESTO #1 BLINDADO con ${giftName} (${totalCoins} monedas)!`, 'gift');
    } else {
      const s = queueState.queue[idx];
      s.status = 'unlocked';
      s.priority = 'vip';
      s.vip150 = true;
      s.gift = `${giftName} (${totalCoins} monedas)`;
      moverCancionConRebase(idx, 0);
      saveQueueData();
      const announcement = `👑 ¡@${s.user} subió al PUESTO #1 BLINDADO con ${giftName} (${totalCoins} monedas)!`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        sound: 'top1',
        eventType: 'hands_top1',
        songTitle: s.title,
        songUser: s.user,
        newPosition: 1,
        skipVoice: true,
        announcement: announcement
      });
      addLog(`👑 ¡${s.user} subió al PUESTO #1 BLINDADO con ${giftName} (${totalCoins} monedas)!`, 'gift');
    }
    return;
  }

  if (idx !== -1 && totalCoins >= 30 && totalCoins <= 149) {
    const s = queueState.queue[idx];
    s.gift = `${giftName} (${totalCoins} monedas)`;
    const targetPos = calcularTargetConBlindaje(idx, 2);
    moverCancionConRebase(idx, targetPos);
    const newPos = targetPos + 1;
    saveQueueData();
    const announcement = `🚀 ¡@${s.user} subió 2 posiciones al Puesto #${newPos} con ${giftName} (${totalCoins} monedas)!`;
    broadcast({
      type: 'QUEUE_UPDATE',
      queue: queueState.queue,
      history: queueState.history,
      sound: 'top1',
      eventType: 'move_up',
      songTitle: s.title,
      songUser: s.user,
      newPosition: newPos,
      skipVoice: true,
      announcement: announcement
    });
    addLog(`🚀 ¡${s.user} subió 2 posiciones al Puesto #${newPos} con ${giftName} (${totalCoins} monedas)!`, 'gift');
    return;
  }

  if (idx !== -1 && totalCoins >= 15 && totalCoins <= 29) {
    const s = queueState.queue[idx];
    s.gift = `${giftName} (${totalCoins} monedas)`;
    const targetPos = calcularTargetConBlindaje(idx, 1);
    moverCancionConRebase(idx, targetPos);
    const newPos = targetPos + 1;
    saveQueueData();
    const announcement = `⬆️ ¡@${s.user} subió 1 posición al Puesto #${newPos} con ${giftName} (${totalCoins} monedas)!`;
    broadcast({
      type: 'QUEUE_UPDATE',
      queue: queueState.queue,
      history: queueState.history,
      sound: 'subir',
      eventType: 'move_up',
      songTitle: s.title,
      songUser: s.user,
      newPosition: newPos,
      skipVoice: true,
      announcement: announcement
    });
    addLog(`⬆️ ¡${s.user} subió 1 posición al Puesto #${newPos} con ${giftName} (${totalCoins} monedas)!`, 'gift');
    return;
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
      processInitialData: false, // NO procesar historial antiguo antes de conectar
      enableExtendedGiftInfo: false,
      fetchRoomInfoOnConnect: false
    });

    const state = await tiktokConnection.connect();
    connectedAt = Date.now();
    updateStatus('connected', { username, roomId: state.roomId, error: null });
    addLog(`¡Conectado exitosamente al Live de @${username}! (Room ID: ${state.roomId})`, 'success');

    // #3 Al iniciar/conectar al Live se restablece la lectura de comentarios (solo quienes envíen Quiéreme)
    quieremeUsers.clear();
    addLog(`🔄 Lectura de comentarios restablecida: solo se leerán mensajes de quienes envíen un "Quiéreme".`, 'info');

    // #1 Al conectar la lista al Live, si no ha llegado a 4000 likes, se bloquea hasta llegar a 4000 likes
    const initialRoomLikes = Number(state?.roomInfo?.likeCount || state?.roomInfo?.stats?.likeCount || 0) || 0;
    globalStreamLikes = initialRoomLikes;
    let globalLiveLikes = initialRoomLikes;
    let lastLikesMilestone = Math.floor(globalLiveLikes / 10000) * 10000;

    if (globalStreamLikes < 4000) {
      botConfig.queueLocked = true;
      botConfig.lockTargetLikes = 4000;
      saveConfig();
      const msgLock = `¡La lista está bloqueada hasta llegar a 4,000 likes en el Live!`;
      broadcast({
        type: 'QUEUE_LOCK_UPDATE',
        locked: true,
        lockTargetLikes: 4000,
        currentLikes: globalStreamLikes,
        announcement: msgLock
      });
      addLog(`🔒 Lista bloqueada automáticamente al conectar (Likes actuales: ${globalStreamLikes} / Meta: 4,000 likes).`, 'queue');
    }

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
      // Ignorar eventos antiguos enviados por TikTok antes de conectar
      if (data.createTime && (data.createTime * 1000 < connectedAt - 2000)) return;

      const info = extractUserInfo(data);
      const comment = (data.content || data.comment || '').trim();
      if (!comment) return;

      const userKey = normalizarUserKey(info.chatName);

      // SI LA ENCUESTA / VOTACIÓN DEL JURADO ESTÁ ACTIVA:
      if (votingState.active) {
        const score = parseScore(comment);
        if (score !== null) {
          if (!votingState.voters.has(userKey)) {
            votingState.voters.set(userKey, score);
            const totalVotes = votingState.voters.size;
            let sum = 0;
            for (const val of votingState.voters.values()) sum += val;
            const avg = Number((sum / totalVotes).toFixed(1));
            const pct = Math.round((avg / 10) * 100);

            const nombreLimpio = limpiarNombreParaVoz(info.chatName);
            const primerNombre = nombreLimpio.split(/\s+/)[0] || nombreLimpio;

            broadcast({
              type: 'VOTE_CAST',
              user: info.chatName,
              primerNombre: primerNombre,
              score: score,
              totalVotes: totalVotes,
              votes: totalVotes,
              currentAvg: avg,
              average: avg,
              avg: avg,
              currentPct: pct,
              percentage: pct,
              pct: pct,
              voiceAnnouncement: `${primerNombre} le da un ${score}`
            });
            addLog(`🗳️ ${primerNombre} calificó con ${score} (Promedio: ${avg}/10 - ${pct}%)`, 'chat');
          }
        }
        // Mientras la encuesta esté activa, no leer comentarios generales en TTS
        return;
      }

      if (esComentarioSpam(userKey, comment)) {
        addLog(`🚫 Comentario silenciado por spam (>2 repetidos en 10s): "${comment}" (@${info.chatName})`, 'chat');
        return;
      }

      addLog(`💬 ${info.chatName} (${info.handle}): ${comment}`, 'chat');
      const isModerator = Boolean(
        data.isModerator ||
        data.user?.isModerator ||
        data.userBadgeList?.some(b => b.badgeSceneType === 1 || b.type === 'moderator')
      );

      const wasAction = processServerChat(comment, info.chatName, info.handle, info.userId, info.isFollower, isModerator);
      if (!wasAction) {
        // #3 Solo se leen en voz alta los comentarios de quienes hayan enviado un "Quiéreme" en este Live
        // #4 Nunca se leen links en voz alta
        const hasSentQuiereme = Boolean(
          quieremeUsers.has(userKey) ||
          (info.handle && quieremeUsers.has(normalizarUserKey(info.handle))) ||
          (info.displayId && quieremeUsers.has(normalizarUserKey(info.displayId)))
        );
        const canReadTTS = hasSentQuiereme && !contieneLink(comment);
        const cleanUser = limpiarNombreParaVoz(info.chatName);

        broadcast({
          type: 'CHAT',
          user: info.chatName,
          cleanUser: cleanUser,
          displayId: info.displayId,
          handle: info.handle,
          nickname: info.nickname,
          userId: info.userId,
          avatarUrl: info.avatarUrl,
          comment,
          readTTS: canReadTTS,
          isFollower: info.isFollower,
          timestamp: Date.now()
        });
      }
    });

    // Escuchar cuando alguien sigue el canal en vivo
    tiktokConnection.on(WebcastEvent.FOLLOW, (data) => {
      if (data.createTime && (data.createTime * 1000 < connectedAt - 2000)) return;

      const info = extractUserInfo(data);
      const userKey = normalizarUserKey(info.chatName);
      knownFollowers.add(userKey);
      knownFollowers.add(normalizarUserKey(info.handle));
      if (info.displayId) knownFollowers.add(normalizarUserKey(info.displayId));

      const stepData = getUserStepData(userKey, info.chatName, info.handle, info.avatarUrl);
      stepData.followed = true;
      verificarCompletitudPasos(userKey, { avatarUrl: info.avatarUrl });

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
        skipVoice: true,
        timestamp: Date.now()
      });
    });

    // Escuchar Regalos
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
      if (data.createTime && (data.createTime * 1000 < connectedAt - 2000)) return;
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
        userId: info.userId,
        avatarUrl: info.avatarUrl
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
        skipVoice: true,
        timestamp: Date.now()
      });
    });

    // Escuchar cuando los espectadores comparten el Live
    const handleShareEvent = (data) => {
      if (data.createTime && (data.createTime * 1000 < connectedAt - 2000)) return;

      const info = extractUserInfo(data);
      const userKey = normalizarUserKey(info.chatName);

      processServerShare(info.chatName, {
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId
      });

      const stepData = getUserStepData(userKey, info.chatName, info.handle, info.avatarUrl);
      stepData.shared = true;
      verificarCompletitudPasos(userKey, { avatarUrl: info.avatarUrl });

      addLog(`🔄 ${info.chatName} compartió el En Vivo`, 'share');
      const primerNombre = limpiarNombreParaVoz(info.chatName).split(/\s+/)[0] || info.chatName;
      const announcement = `${info.chatName} compartió el Live`;
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
        skipVoice: true,
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
      if (data.createTime && (data.createTime * 1000 < connectedAt - 2000)) return;
      const info = extractUserInfo(data);
      const count = Number(data.count) || Number(data.likeCount) || 1;
      const total = data.total || null;

      // Actualizar contador global de likes del Live
      if (total && Number(total) > globalStreamLikes) {
        globalStreamLikes = Number(total);
      } else {
        globalStreamLikes += count;
      }
      globalLiveLikes = globalStreamLikes;

      // #1 Verificar si se alcanzó la meta de likes para desbloquear la lista automáticamente
      if (botConfig.queueLocked && botConfig.lockTargetLikes && globalStreamLikes >= botConfig.lockTargetLikes) {
        const metaAlcanzada = botConfig.lockTargetLikes;
        botConfig.queueLocked = false;
        botConfig.lockTargetLikes = null;
        saveConfig();
        const msgUnlock = `¡Meta de ${metaAlcanzada.toLocaleString()} likes alcanzada! La lista de canciones se ha desbloqueado.`;
        broadcast({
          type: 'QUEUE_LOCK_UPDATE',
          locked: false,
          lockTargetLikes: null,
          currentLikes: globalStreamLikes,
          announcement: msgUnlock
        });
        addLog(`🔓 ¡Meta de ${metaAlcanzada.toLocaleString()} likes alcanzada! Lista desbloqueada automáticamente.`, 'queue');
        procesarPasosPendientesAlDesbloquear();
      }

      // Rastrear hitos acumulativos de 10,000 likes
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

      addLog(`❤️ ${info.chatName} dio ${count} likes ${total ? `(Total Live: ${total})` : `(Acumulado: ${globalStreamLikes})`}`, 'like');
      processServerLike(info.chatName, count, {
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId,
        avatarUrl: info.avatarUrl
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
        total: globalStreamLikes,
        lockTargetLikes: botConfig.lockTargetLikes || null,
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
  let initAvg = 0;
  let initPct = 0;
  if (votingState.active && votingState.voters.size > 0) {
    let sum = 0;
    for (const val of votingState.voters.values()) sum += val;
    initAvg = Number((sum / votingState.voters.size).toFixed(1));
    initPct = Math.round((initAvg / 10) * 100);
  }

  ws.send(JSON.stringify({ type: 'RECENT_LOGS', logs: recentLogs }));
  ws.send(JSON.stringify({
    type: 'EXTRA_CONFIG',
    queueLocked: botConfig.queueLocked,
    lockTargetLikes: botConfig.lockTargetLikes || null,
    currentLikes: globalStreamLikes,
    requireFollowerToRequest: botConfig.requireFollowerToRequest,
    certifiedPlaylist: certifiedPlaylist,
    votingState: {
      active: votingState.active,
      song: votingState.song,
      duration: votingState.duration,
      startedAt: votingState.startedAt,
      totalVotes: votingState.voters.size,
      votes: votingState.voters.size,
      average: initAvg,
      avg: initAvg,
      currentAvg: initAvg,
      percentage: initPct,
      pct: initPct,
      currentPct: initPct
    }
  }));

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
      } else if (payload.action === 'startVoting') {
        startVoting(payload.duration || 120, payload.song);
      } else if (payload.action === 'finishVoting' || payload.action === 'stopVoting') {
        finishVoting();
      } else if (payload.action === 'cancelVoting') {
        cancelVoting();
      } else if (payload.action === 'testEpicGift') {
        const giftType = payload.giftType || 'corazon_dedos';
        const testUser = payload.user || 'Usuario VIP';
        broadcast({
          type: 'EPIC_GIFT_ANIMATION',
          giftType: giftType,
          user: testUser,
          avatarUrl: ''
        });
      } else if (payload.action === 'testChat') {
        const testUser = payload.user || 'Carlos';
        const testComment = payload.comment || 'Le doy 10';
        addLog(`💬 [Prueba] ${testUser}: "${testComment}"`, 'chat');
        
        // Si la votación está activa, procesar el voto en el servidor
        if (votingState.active) {
          const score = parseScore(testComment);
          if (score !== null) {
            const userKey = normalizarUserKey(testUser);
            // Si es prueba desde el panel, permitir acumular votos usando sufijo si ya votó
            const voteKey = votingState.voters.has(userKey) ? `${userKey}_${Date.now()}` : userKey;
            votingState.voters.set(voteKey, score);
            const totalVotes = votingState.voters.size;
            let sum = 0;
            for (const val of votingState.voters.values()) sum += val;
            const avg = Number((sum / totalVotes).toFixed(1));
            const pct = Math.round((avg / 10) * 100);

            const nombreLimpio = limpiarNombreParaVoz(testUser);
            const primerNombre = nombreLimpio.split(/\s+/)[0] || nombreLimpio;

            broadcast({
              type: 'VOTE_CAST',
              user: testUser,
              primerNombre: primerNombre,
              score: score,
              totalVotes: totalVotes,
              votes: totalVotes,
              currentAvg: avg,
              average: avg,
              avg: avg,
              currentPct: pct,
              percentage: pct,
              pct: pct,
              voiceAnnouncement: `${primerNombre} le da un ${score}`
            });
            addLog(`🗳️ [Prueba] ${primerNombre} calificó con ${score} (Promedio: ${avg}/10 - ${pct}%)`, 'chat');
            return;
          }
        }

        const wasAction = processServerChat(testComment, testUser, testUser, 'test_' + Date.now(), true, true);
        if (!wasAction) {
          const userKey = normalizarUserKey(testUser);
          const canReadTTS = quieremeUsers.has(userKey) && !contieneLink(testComment);
          broadcast({
            type: 'CHAT',
            user: testUser,
            cleanUser: limpiarNombreParaVoz(testUser),
            handle: '@' + testUser,
            comment: testComment,
            readTTS: canReadTTS,
            isFollower: true,
            timestamp: Date.now()
          });
        }
      } else if (payload.action === 'testGift') {
        const giftName = payload.giftName || 'Corazón con los dedos';
        const testUser = payload.user || 'Maria';
        const diamondCount = Number(payload.diamondCount) || 1;
        processServerGift(testUser, giftName, 1, diamondCount, '', {
          displayId: testUser,
          handle: testUser,
          nickname: testUser,
          userId: 'test_' + Date.now(),
          avatarUrl: 'https://api.dicebear.com/7.x/identicon/svg?seed=' + encodeURIComponent(testUser)
        });
      } else if (payload.action === 'getPlaylist') {
        ws.send(JSON.stringify({ type: 'PLAYLIST_UPDATE', playlist: certifiedPlaylist }));
      } else if (payload.action === 'deleteFromPlaylist') {
        certifiedPlaylist = certifiedPlaylist.filter(p => p.id !== payload.id);
        saveCertifiedPlaylist();
        broadcast({ type: 'PLAYLIST_UPDATE', playlist: certifiedPlaylist });
      } else if (payload.action === 'toggleQueueLock') {
        botConfig.queueLocked = payload.locked !== undefined ? Boolean(payload.locked) : !botConfig.queueLocked;
        if (!botConfig.queueLocked) {
          botConfig.lockTargetLikes = null;
        } else if (payload.lockTargetLikes) {
          botConfig.lockTargetLikes = Number(payload.lockTargetLikes) || null;
        }
        saveConfig();
        const msg = botConfig.queueLocked
          ? (botConfig.lockTargetLikes
              ? `¡La lista de canciones ha sido bloqueada hasta llegar a ${botConfig.lockTargetLikes.toLocaleString()} likes!`
              : "¡La lista de canciones ha sido bloqueada! No se aceptan más peticiones por el momento.")
          : "¡La lista de canciones ha sido reabierta! Ya pueden entrar completando los 3 pasos.";
        broadcast({
          type: 'QUEUE_LOCK_UPDATE',
          locked: botConfig.queueLocked,
          lockTargetLikes: botConfig.lockTargetLikes,
          currentLikes: globalStreamLikes,
          announcement: msg
        });
        addLog(botConfig.queueLocked ? "🔒 Lista bloqueada manualmente desde el panel" : "🔓 Lista desbloqueada manualmente desde el panel", 'queue');
        if (!botConfig.queueLocked) {
          procesarPasosPendientesAlDesbloquear();
        }
      } else if (payload.action === 'toggleRequireFollower') {
        botConfig.requireFollowerToRequest = payload.required !== undefined ? Boolean(payload.required) : !botConfig.requireFollowerToRequest;
        saveConfig();
        broadcast({
          type: 'EXTRA_CONFIG',
          queueLocked: botConfig.queueLocked,
          lockTargetLikes: botConfig.lockTargetLikes || null,
          currentLikes: globalStreamLikes,
          requireFollowerToRequest: botConfig.requireFollowerToRequest,
          certifiedPlaylist: certifiedPlaylist
        });
        addLog(`⚙️ Requisito de seguidor obligatorio: ${botConfig.requireFollowerToRequest ? 'ACTIVADO' : 'DESACTIVADO'}`, 'info');
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
