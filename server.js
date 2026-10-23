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
  requireFollowerToRequest: false,
  queueLocked: false,
  freeLikesReq: 5000,
  rules: {
    likesReq: 5000,
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
    audioOutput: 'both',
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
      requireFollowerToRequest: false, // Ya no es necesario seguir al canal para entrar o agregar canción
      freeLikesReq: Math.max(1, Number(loaded.freeLikesReq || loaded.rules?.likesReq || 5000)),
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

function getFreeLikesReq() {
  return Math.max(1, Number(botConfig.freeLikesReq || botConfig.rules?.likesReq || 5000));
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

  if (reqUrl === '/' || reqUrl === '/index.html' || reqUrl === '/cola-slow-md.html' || reqUrl === '/panel' || reqUrl === '/studio-panel' || reqUrl === '/dashboard' || reqUrl === '/studio') {
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
      // Fallback a index.html si no existe
      const fallback = path.join(__dirname, 'index.html');
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
// IDs de canciones ya escuchadas o eliminadas para evitar que clientes antiguos las reinyecten por syncQueue
const deletedSongIds = new Set();
try {
  if (fs.existsSync(QUEUE_FILE)) {
    queueState = JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf8'));
    if (!Array.isArray(queueState.queue)) queueState.queue = [];
    if (!Array.isArray(queueState.history)) queueState.history = [];
    // Limpiar entradas antiguas de sesiones pasadas
    queueState.queue = queueState.queue.filter(s => s && !String(s.id || '').startsWith('song_1791') && !String(s.id || '').startsWith('disk_17926'));
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

// RASTREO DE PASOS Y TAPTAP DE ENTRADA A LA LISTA
const userSteps = new Map();

function getUserStepData(userKey, name, handle, avatarUrl) {
  let data = userSteps.get(userKey);
  if (!data) {
    data = {
      followed: false,
      shared: false,
      giftedHeart: false,
      likesGiven: 0,
      readyForUnlockLog: false,
      pendingSongTitle: '',
      pendingSongUrl: '',
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

// Limpiar progreso de un usuario cuando su canción es escuchada o eliminada de la lista
function limpiarProgresoUsuarioDeCancion(song) {
  if (!song) return;
  if (song.id) deletedSongIds.add(song.id);
  const keysToReset = new Set();
  if (song.user) keysToReset.add(normalizarUserKey(song.user));
  if (song.handle) keysToReset.add(normalizarUserKey(song.handle));

  for (const [k, st] of userSteps.entries()) {
    const stNameKey = st.name ? normalizarUserKey(st.name) : '';
    const stHandleKey = st.handle ? normalizarUserKey(st.handle) : '';
    if (keysToReset.has(k) || (stNameKey && keysToReset.has(stNameKey)) || (stHandleKey && keysToReset.has(stHandleKey))) {
      keysToReset.add(k);
    }
  }

  for (const k of keysToReset) {
    if (!k) continue;
    serverUserLikes.set(k, 0);
    const st = userSteps.get(k);
    if (st) {
      st.giftedHeart = false;
      st.likesGiven = 0;
      st.readyForUnlockLog = false;
      st.pendingSongTitle = '';
      st.pendingSongUrl = '';
    }
  }
}

// Reiniciar la lista de temas ya escuchados y los contadores de TapTap al bloquear la lista hasta un nuevo objetivo (0-X)
function reiniciarParaBloqueo(archivarColaActual = true) {
  if (archivarColaActual && Array.isArray(queueState.queue) && queueState.queue.length > 0) {
    for (const s of queueState.queue) {
      if (s && s.id) deletedSongIds.add(s.id);
      queueState.history.unshift({
        ...s,
        reactedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      });
    }
    if (queueState.history.length > 50) {
      queueState.history = queueState.history.slice(0, 50);
    }
    queueState.queue = [];
    saveQueueData();
    broadcast({
      type: 'QUEUE_UPDATE',
      queue: queueState.queue,
      history: queueState.history,
      skipVoice: true
    });
  }

  // Reiniciar contadores de TapTap y regalos de entrada para que al llegar al objetivo SOLO entren quienes dieron suficientes TapTap para desbloquear la lista
  serverUserLikes.clear();
  for (const st of userSteps.values()) {
    st.likesGiven = 0;
    st.giftedHeart = false;
    st.readyForUnlockLog = false;
    st.pendingSongTitle = '';
    st.pendingSongUrl = '';
  }
}

function registrarUsuarioQuiereme(userIdentifier, extraInfo = {}) {
  const keys = [
    normalizarUserKey(userIdentifier),
    extraInfo.handle ? normalizarUserKey(extraInfo.handle) : '',
    extraInfo.displayId ? normalizarUserKey(extraInfo.displayId) : '',
    extraInfo.nickname ? normalizarUserKey(extraInfo.nickname) : '',
    extraInfo.userId ? `id:${String(extraInfo.userId).trim()}` : ''
  ].filter(Boolean);

  for (const k of keys) {
    quieremeUsers.add(k);
  }
}

function usuarioTieneQuiereme(userIdentifier, extraInfo = {}) {
  const keys = [
    normalizarUserKey(userIdentifier),
    extraInfo.handle ? normalizarUserKey(extraInfo.handle) : '',
    extraInfo.displayId ? normalizarUserKey(extraInfo.displayId) : '',
    extraInfo.nickname ? normalizarUserKey(extraInfo.nickname) : '',
    extraInfo.userId ? `id:${String(extraInfo.userId).trim()}` : ''
  ].filter(Boolean);

  return keys.some(k => quieremeUsers.has(k));
}

function verificarCompletitudPasos(userKey, extraInfo = {}) {
  const data = userSteps.get(userKey);
  if (!data) return false;

  // Si la lista está bloqueada (por comando 0 o meta de likes), no entra todavía
  if (botConfig.queueLocked) return false;

  // Entrada a la lista sin requisito de seguir: basta con enviar Corazón con los dedos o llegar a los Likes Gratis configurados (D-X)
  const freeLikesNeeded = getFreeLikesReq();
  const totalUserLikes = Math.max(data.likesGiven || 0, serverUserLikes.get(userKey) || 0);
  const hasEntryQualification = Boolean(data.giftedHeart || totalUserLikes >= freeLikesNeeded);

  if (hasEntryQualification) {
    const viaCorazon = Boolean(data.giftedHeart);
    const metodoEntrada = viaCorazon ? 'Corazón con los dedos' : `${freeLikesNeeded.toLocaleString()} Likes Gratis`;

    // Verificar si ya tiene disco o canción en la cola
    const idx = queueState.queue.findIndex(s => {
      const k = normalizarUserKey(s.user);
      const kh = s.handle ? normalizarUserKey(s.handle) : '';
      return k === userKey || (kh && kh === userKey);
    });

    if (idx === -1) {
      const songTitleUsed = data.pendingSongTitle || '';
      const songUrlUsed = data.pendingSongUrl || '';
      const linkMeta = (!songTitleUsed && songUrlUsed) ? detectarLinkCancion(songUrlUsed) : null;
      const initialTitle = songTitleUsed || (linkMeta ? `Canción de @${data.name} (${linkMeta.label})` : 'Esperando Escucha, (Canción + Artista) o link...');
      const initialUrl = songUrlUsed || '';
      const initialPlatform = songTitleUsed ? 'youtube' : (linkMeta ? linkMeta.platform : '');

      // Consumir inmediatamente la calificación y canción pendiente para que NUNCA se duplique ni reaparezca tras ser escuchada
      data.giftedHeart = false;
      data.likesGiven = 0;
      data.readyForUnlockLog = false;
      data.pendingSongTitle = '';
      data.pendingSongUrl = '';
      serverUserLikes.set(userKey, 0);
      if (data.handle) {
        serverUserLikes.set(normalizarUserKey(data.handle), 0);
      }

      const nuevoDisco = {
        id: 'disk_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        title: initialTitle,
        songUrl: initialUrl,
        songPlatform: initialPlatform,
        platform: initialPlatform,
        user: data.name,
        handle: data.handle || '',
        avatarUrl: data.avatarUrl || extraInfo.avatarUrl || '',
        gift: metodoEntrada,
        status: 'unlocked',
        priority: 'normal',
        vip150: false,
        overtakenCount: 0,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      queueState.queue.push(nuevoDisco);
      saveQueueData();

      if (linkMeta && !songTitleUsed) {
        resolverTituloDeLink(nuevoDisco, linkMeta.url, linkMeta.label, false);
      }

      const announcement = songTitleUsed
        ? `¡${data.name} entró a la lista con "${songTitleUsed}" (${metodoEntrada})!`
        : `¡${data.name} entró a la lista (${metodoEntrada})! Comenta Escucha + Canción, (Canción + Artista) o pega tu link.`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        newSong: nuevoDisco,
        newSongDesc: songTitleUsed
          ? `${metodoEntrada} • "${songTitleUsed}"`
          : `${metodoEntrada} • Comenta Escucha + Canción, (Canción + Artista) o tu link`,
        sound: 'normal',
        eventType: 'new_song',
        skipVoice: true,
        announcement: announcement
      });
      addLog(`⭐ ${data.name} entró a la lista (${metodoEntrada}) -> Disco añadido (${initialTitle})`, 'queue');
      return true;
    } else if (queueState.queue[idx].status === 'locked') {
      // Si tenía un tema bloqueado en la lista, desbloquearlo gratis o con Corazón con los dedos
      const s = queueState.queue[idx];
      s.status = 'unlocked';
      s.gift = metodoEntrada;
      data.giftedHeart = false;
      data.likesGiven = 0;
      data.readyForUnlockLog = false;
      serverUserLikes.set(userKey, 0);
      saveQueueData();

      const announcement = `🔓 ¡@${s.user} desbloqueó su canción con ${metodoEntrada}!`;
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        songTitle: s.title,
        songUser: s.user,
        sound: 'unlock',
        eventType: 'unlock',
        skipVoice: true,
        announcement: announcement
      });
      addLog(`🔓 ${s.user} desbloqueó su canción en la lista (${metodoEntrada})`, 'queue');
      return true;
    }
  }
  return false;
}

// Al desbloquearse la lista, verificar si usuarios dieron suficientes TapTap o Corazón con los dedos para desbloquear la lista
function procesarPasosPendientesAlDesbloquear() {
  for (const userKey of userSteps.keys()) {
    verificarCompletitudPasos(userKey);
  }
}

// #4 Detector de links de YouTube, Spotify, BandLab, SoundCloud, Apple Music o enlaces generales
function detectarLinkCancion(text) {
  if (!text) return null;
  const match = String(text).match(/(?:https?:\/\/)?(?:www\.|m\.|music\.|open\.|on\.)?(youtube\.com\/\S+|youtu\.be\/\S+|spotify\.com\/\S+|spotify\.link\/\S+|bandlab\.com\/\S+|soundcloud\.com\/\S+|music\.apple\.com\/\S+)/i) ||
                String(text).match(/https?:\/\/\S+/i);
  if (!match) return null;

  let rawUrl = match[0].replace(/[.,;!?)"'\]]+$/, '');
  if (!/^https?:\/\//i.test(rawUrl)) {
    rawUrl = 'https://' + rawUrl;
  }

  const lower = rawUrl.toLowerCase();
  let platform = 'link';
  let label = 'Enlace';
  if (lower.includes('youtube.') || lower.includes('youtu.be')) {
    platform = 'youtube';
    label = 'YouTube';
  } else if (lower.includes('spotify.')) {
    platform = 'spotify';
    label = 'Spotify';
  } else if (lower.includes('bandlab.')) {
    platform = 'bandlab';
    label = 'BandLab';
  } else if (lower.includes('soundcloud.')) {
    platform = 'soundcloud';
    label = 'SoundCloud';
  } else if (lower.includes('apple.com')) {
    platform = 'apple';
    label = 'Apple Music';
  }

  return {
    url: rawUrl,
    platform,
    label,
    isLink: true
  };
}

// Alternativa 1 cuando TikTok bloquea los links: (Nombre de la canción + Nombre del artista) entre paréntesis
function detectarCancionEnParentesis(text) {
  if (!text) return null;
  const str = String(text).trim();
  if (contieneLink(str)) return null;

  // Soportar múltiples paréntesis seguidos ej: "(Canción)(Artista)" o "(Canción) (Artista"
  const multiMatches = [...str.matchAll(/[（(]([^)）]{1,100})[)）]/g)].map(m => m[1].trim()).filter(Boolean);
  let rawInside = '';

  if (multiMatches.length >= 2) {
    rawInside = multiMatches.join(' - ');
  } else if (multiMatches.length === 1) {
    rawInside = multiMatches[0];
    // Si después del primer paréntesis cerrado abrieron otro sin cerrar: ej. "(carlito h) (aro baby"
    const afterFirst = str.slice(str.indexOf(multiMatches[0]) + multiMatches[0].length);
    const trailingOpen = afterFirst.match(/[)）]\s*[（(]\s*(.{2,60})$/);
    if (trailingOpen && trailingOpen[1].trim()) {
      rawInside = `${rawInside} - ${trailingOpen[1].trim()}`;
    }
  } else {
    // Soportar caso donde el usuario abrió paréntesis al escribir su canción en móvil pero olvidó cerrarlo: ej. "( no tienen valor + NeutroCH"
    const unclosedMatch = str.match(/^(?:@\S+\s+)?[（(]\s*([^)）]{3,120})$/);
    if (unclosedMatch) {
      rawInside = unclosedMatch[1].trim();
    }
  }

  if (!rawInside) return null;

  // Si escribieron "(Escucha Canción + Artista)" dentro del paréntesis, limpiar el prefijo "Escucha"
  rawInside = rawInside.replace(/^[!¡/]?\s*escucha(?:\s*[:+\-]\s*|\s+)/i, '').trim();

  // Ignorar comandos reservados del streamer o números sueltos
  if (/^(?:\.{2,}|0|g|calificar|encuesta|lista)$/i.test(rawInside)) return null;
  if (/^(?:0|d)\s*-\s*\d+$/i.test(rawInside)) return null;
  if (/^borra\s+a\s+/i.test(rawInside)) return null;
  if (/^\d+(?:[.,]\d+)?(?:\s*\/\s*10)?$/.test(rawInside)) return null;

  // Formatear separador "+" como " - " para mostrar "Canción - Artista" limpio
  const cleanTitle = rawInside
    .replace(/\s*\+\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();

  // Asegurar que contenga al menos 2 letras
  if (!/\p{L}{2,}/u.test(cleanTitle)) return null;

  return {
    title: cleanTitle,
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanTitle)}`,
    platform: 'youtube',
    label: 'YouTube',
    isParenthesesSong: true
  };
}

// Alternativa 2: Comando clásico "Escucha + Canción + Artista" (ej: "Escucha Monaco + Bad Bunny", "Escucha: Canción - Artista")
function detectarComandoEscucha(text) {
  if (!text) return null;
  const cleanText = String(text).trim();
  if (contieneLink(cleanText)) return null;

  const match = cleanText.match(/^(?:@\S+\s+)?[!¡/]?\s*escucha(?:\s*[:+\-]\s*|\s+)(.+)$/i);
  if (!match) return null;

  let rawSong = match[1]
    .replace(/^[(\[«"']+|[)\]»"']+$/g, '')
    .replace(/^[+:\-\s]+/, '')
    .trim();

  if (!rawSong || rawSong.length < 2 || rawSong.length > 120) return null;

  // Ignorar frases conversacionales que empiezan por "escucha" pero no son nombres de canciones
  if (/^(?:mi\s+(?:m[uú]sica|tema|canci[oó]n|arte|disco|track)|uno\s+m[ií]o|una\s+m[ií]a|algo\s+diferente|eso|esto|bien|por\s*favor|porfa|bro|hermano|manito|mi\s+bro|klk|activo)\s*[.!?🙏🔥❤️]*$/i.test(rawSong)) {
    return null;
  }

  // Ignorar comandos reservados o calificaciones numéricas
  if (/^(?:\.{2,}|0|g|calificar|encuesta|lista)$/i.test(rawSong)) return null;
  if (/^(?:0|d)\s*-\s*\d+$/i.test(rawSong)) return null;
  if (/^borra\s+a\s+/i.test(rawSong)) return null;
  if (/^\d+(?:[.,]\d+)?(?:\s*\/\s*10)?$/.test(rawSong)) return null;

  const cleanTitle = rawSong
    .replace(/\s*\+\s*/g, ' - ')
    .replace(/\s+/g, ' ')
    .trim();

  if (!/\p{L}{2,}/u.test(cleanTitle)) return null;

  return {
    title: cleanTitle,
    url: `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanTitle)}`,
    platform: 'youtube',
    label: 'YouTube',
    isEscuchaCommand: true
  };
}

// Decodificar entidades HTML en títulos extraídos de metadatos
function decodificarEntidadesHTML(str) {
  if (!str) return '';
  return String(str)
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;|&#x0*27;/gi, "'")
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/\s+/g, ' ')
    .trim();
}

// Limpiar título y autor para que en el Overlay se vea un nombre de canción profesional y nunca un link
function limpiarTituloMetadatos(rawTitle, rawAuthor = '') {
  let title = decodificarEntidadesHTML(rawTitle || '');
  let author = decodificarEntidadesHTML(rawAuthor || '');

  if (!title || contieneLink(title)) return '';

  // Limpiar sufijos de plataformas comunes
  title = title
    .replace(/\s*[-|•]\s*YouTube\s*$/i, '')
    .replace(/\s*\|\s*Spotify\s*$/i, '')
    .replace(/\s*\|\s*BandLab\s*$/i, '')
    .replace(/\s*[-|•]\s*SoundCloud\s*$/i, '')
    .replace(/\s+on\s+BandLab\s*$/i, '')
    .replace(/^Stream\s+/i, '')
    .replace(/\s+by\s+([^|]+)$/i, ' - $1')
    .replace(/\s*-\s*song and lyrics by\s+/i, ' - ')
    .replace(/\s*-\s*song by\s+/i, ' - ')
    .replace(/\s*-\s*Single by\s+/i, ' - ')
    .replace(/\s*-\s*EP by\s+/i, ' - ')
    .replace(/\s*-\s*Album by\s+/i, ' - ')
    .replace(/^🔗\s*/, '')
    .trim();

  // Limpiar canal autogenerado de YouTube ("Artista - Topic")
  author = author.replace(/\s*-\s*Topic\s*$/i, '').trim();

  // Ignorar títulos genéricos vacíos de login/home
  if (/^(YouTube|Spotify|BandLab|SoundCloud|Sign in|Log in|Home|Before you continue)$/i.test(title)) {
    return '';
  }

  // Si tenemos autor y el título aún no lo incluye, agregarlo de forma estética
  if (author && !/^(YouTube|Spotify|BandLab|SoundCloud)$/i.test(author)) {
    const lowerTitle = title.toLowerCase();
    const lowerAuthor = author.toLowerCase();
    if (!lowerTitle.includes(lowerAuthor) && !lowerTitle.includes(' - ')) {
      title = `${title} - ${author}`;
    }
  }

  return title.trim();
}

// Petición HTTP/HTTPS simple con soporte de redirecciones para leer JSON o HTML (<head>)
function fetchUrlContent(targetUrl, maxRedirects = 4, timeoutMs = 4500) {
  return new Promise((resolve, reject) => {
    let settled = false;
    const done = (err, data) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(data);
    };

    const timer = setTimeout(() => done(new Error('Timeout')), timeoutMs);

    function requestStep(currentUrl, redirectsLeft) {
      let parsed;
      try {
        parsed = new URL(currentUrl);
      } catch (e) {
        clearTimeout(timer);
        return done(e);
      }
      const client = parsed.protocol === 'http:' ? http : https;
      const req = client.get(currentUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/json,application/xhtml+xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
        }
      }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          res.resume();
          if (redirectsLeft <= 0) {
            clearTimeout(timer);
            return done(new Error('Too many redirects'));
          }
          const nextUrl = new URL(res.headers.location, currentUrl).toString();
          return requestStep(nextUrl, redirectsLeft - 1);
        }

        let body = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          body += chunk;
          // Basta con los primeros 90KB (contiene todo el <head> y metadatos og:title)
          if (body.length > 90000 || body.includes('</head>')) {
            req.destroy();
            clearTimeout(timer);
            done(null, body);
          }
        });
        res.on('end', () => {
          clearTimeout(timer);
          done(null, body);
        });
        res.on('error', (err) => {
          clearTimeout(timer);
          done(err);
        });
      });

      req.on('error', (err) => {
        clearTimeout(timer);
        done(err);
      });
    }

    requestStep(targetUrl, maxRedirects);
  });
}

// Extraer el nombre real de la canción y artista desde oEmbed (YouTube/Spotify/SoundCloud) o etiquetas OpenGraph (BandLab/enlaces acortados)
async function obtenerMetadatosDeLink(url, label = 'Enlace') {
  const lower = String(url).toLowerCase();

  // 1. Intentar endpoints oficiales oEmbed primero (muy rápidos y precisos)
  const oembedEndpoints = [];
  if (lower.includes('youtube.com') || lower.includes('youtu.be')) {
    oembedEndpoints.push(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
  } else if (lower.includes('open.spotify.com')) {
    oembedEndpoints.push(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
  } else if (lower.includes('soundcloud.com')) {
    oembedEndpoints.push(`https://soundcloud.com/oembed?url=${encodeURIComponent(url)}&format=json`);
  }
  oembedEndpoints.push(`https://noembed.com/embed?url=${encodeURIComponent(url)}`);

  for (const endpoint of oembedEndpoints) {
    try {
      const raw = await fetchUrlContent(endpoint, 3, 3500);
      const json = JSON.parse(raw);
      if (json && json.title) {
        const clean = limpiarTituloMetadatos(json.title, json.author_name || '');
        if (clean) return clean;
      }
    } catch (e) {}
  }

  // 2. Fallback: Leer directamente el HTML / OpenGraph (<meta property="og:title">, twitter:title, <title>)
  try {
    const html = await fetchUrlContent(url, 5, 4500);
    if (html) {
      const ogTitleMatch = html.match(/<meta[^>]+(?:property|name)=["'](?:og:title|twitter:title)["'][^>]+content=["']([^"']+)["']/i) ||
                           html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:title|twitter:title)["']/i);
      const ogDescMatch = html.match(/<meta[^>]+(?:property|name)=["'](?:og:description|description)["'][^>]+content=["']([^"']+)["']/i) ||
                          html.match(/<meta[^>]+content=["']([^"']+)["'][^>]+(?:property|name)=["'](?:og:description|description)["']/i);
      const titleTagMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);

      const rawTitle = ogTitleMatch ? ogTitleMatch[1] : (titleTagMatch ? titleTagMatch[1] : '');
      let rawAuthor = '';

      if (ogDescMatch && ogDescMatch[1]) {
        const desc = decodificarEntidadesHTML(ogDescMatch[1]);
        // En Spotify og:description suele ser "Artista · Canción · Song · 2024" o "Listen to X on Spotify. Artista · Song"
        const parts = desc.split('·').map(p => p.trim()).filter(Boolean);
        if (parts.length >= 2 && !parts[0].toLowerCase().includes('listen to')) {
          rawAuthor = parts[0];
        }
      }

      const clean = limpiarTituloMetadatos(rawTitle, rawAuthor);
      if (clean) return clean;
    }
  } catch (e) {}

  return '';
}

// Resolver título real desde metadatos sin mostrar el link en el Overlay y sin hablar en TTS
async function resolverTituloDeLink(songObj, url, label, announceUpdate = false) {
  try {
    const cleanTitle = await obtenerMetadatosDeLink(url, label);
    if (cleanTitle) {
      songObj.title = cleanTitle;
    } else if (!songObj.title || contieneLink(songObj.title)) {
      songObj.title = `Tema de @${songObj.user || 'Artista'} (${label})`;
    }
    saveQueueData();
    broadcast({
      type: 'QUEUE_UPDATE',
      queue: queueState.queue,
      history: queueState.history,
      eventType: announceUpdate ? 'update_song' : undefined,
      songTitle: songObj.title,
      songUser: songObj.user,
      skipVoice: true,
      announcement: announceUpdate ? `🎵 ¡@${songObj.user} vinculó "${songObj.title}"!` : undefined
    });
    if (cleanTitle) {
      addLog(`🎵 Metadatos leídos para @${songObj.user}: "${songObj.title}" (${label})`, 'queue');
    }
  } catch (e) {
    saveQueueData();
    broadcast({
      type: 'QUEUE_UPDATE',
      queue: queueState.queue,
      history: queueState.history,
      skipVoice: true
    });
  }
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
      const freeLikes = getFreeLikesReq();
      const voiceMsg = `Para entrar a la lista envía un corazón con los dedos o llega a ${freeLikes} likes para agregar tu canción gratis. Luego escribe Escucha más el nombre de la canción más el artista, ponlo entre paréntesis, o pega tu link en el chat.`;
      const bannerMsg = `1. Corazón con los dedos 🫰 o ${freeLikes.toLocaleString()} Likes • 2. Escribe Escucha + Canción + Artista, (Canción + Artista) o pega tu Link`;
      broadcast({
        type: 'HOW_TO_ADD_HELP',
        user: userChatName,
        bannerText: bannerMsg,
        voiceText: voiceMsg
      });
      addLog(`💡 Streamer solicitó explicación con (...)`, 'chat');
      return true;
    }

    // 2. Comando (D-X) -> Definir el número de likes necesarios para agregar/desbloquear canción gratis (ej. D-1000)
    const freeLikesMatch = text.match(/^\(?d\s*-\s*(\d+)\)?$/i);
    if (freeLikesMatch) {
      const targetFreeLikes = Math.max(1, parseInt(freeLikesMatch[1], 10));
      botConfig.freeLikesReq = targetFreeLikes;
      if (botConfig.rules) botConfig.rules.likesReq = targetFreeLikes;
      saveConfig();
      const announcement = `🎁 ¡Canción gratis activada con ${targetFreeLikes.toLocaleString()} likes! (D-${targetFreeLikes})`;
      broadcast({
        type: 'FREE_LIKES_UPDATE',
        freeLikesReq: targetFreeLikes,
        skipVoice: false,
        announcement: announcement
      });
      addLog(`🎁 Streamer configuró ${targetFreeLikes.toLocaleString()} likes para agregar canción gratis (D-${targetFreeLikes})`, 'queue');
      procesarPasosPendientesAlDesbloquear();
      return true;
    }

    // 3. #1 Fórmula (0-#) -> Bloquear lista hasta llegar a cierta cantidad de likes (ej. 0-50000)
    const lockGoalMatch = text.match(/^\(?0\s*-\s*(\d+)\)?$/);
    if (lockGoalMatch) {
      const targetLikes = parseInt(lockGoalMatch[1], 10);
      botConfig.queueLocked = true;
      botConfig.lockTargetLikes = targetLikes;
      // Archivar los temas ya escuchados y reiniciar contadores de TapTap para que solo entren los que den suficientes TapTap para desbloquear la lista
      reiniciarParaBloqueo(true);
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
      addLog(`🔒 Streamer bloqueó la lista hasta alcanzar ${targetLikes.toLocaleString()} likes (0-${targetLikes}) — Temas anteriores limpiados y contadores de TapTap reiniciados`, 'queue');
      return true;
    }

    // 4. (0) -> Bloquear lista de canciones indefinidamente
    if (text === '0' || text === '(0)') {
      botConfig.queueLocked = true;
      botConfig.lockTargetLikes = null;
      reiniciarParaBloqueo(true);
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
      addLog(`🔒 Streamer bloqueó la lista de canciones (0) — Temas anteriores limpiados y contadores de TapTap reiniciados`, 'queue');
      return true;
    }

    // 5. (G o g) -> Reabrir lista de canciones
    if (text.toLowerCase() === 'g' || text.toLowerCase() === '(g)') {
      botConfig.queueLocked = false;
      botConfig.lockTargetLikes = null;
      saveConfig();
      const announcement = "🔓 ¡La lista de canciones ha sido reabierta! Ya pueden entrar y agregar sus canciones.";
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

    // 6. (borra a X) -> Eliminar la canción de un usuario específico
    const borraMatch = text.match(/^\(?borra\s+a\s+([^)]+)\)?$/i);
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
        limpiarProgresoUsuarioDeCancion(removed);
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

    // 7. Comando "calificar" o "encuesta" para iniciar votación
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
    const freeLikes = getFreeLikesReq();
    const bannerMsg = `1. Corazón con los dedos 🫰 o ${freeLikes.toLocaleString()} Likes • 2. Escribe Escucha + Canción + Artista, (Canción + Artista) o pega tu Link`;
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

  // #4 DETECCIÓN DE LINK DE CANCIÓN, (CANCIÓN + ARTISTA) ENTRE PARÉNTESIS O COMANDO ESCUCHA + CANCIÓN + ARTISTA - SIN REQUISITO DE SEGUIR
  const linkInfo = detectarLinkCancion(text);
  const parenInfo = !linkInfo ? detectarCancionEnParentesis(text) : null;
  const escuchaInfo = (!linkInfo && !parenInfo) ? detectarComandoEscucha(text) : null;
  const textSongInfo = parenInfo || escuchaInfo;
  if (!linkInfo && !textSongInfo) return false;

  const chatName = (userChatName || 'Usuario').trim();
  if (userHandle || userId) {
    registrarAliasServidor(chatName, userHandle, chatName, userId);
  }

  const userKey = normalizarUserKey(chatName);
  const handleKey = userHandle ? normalizarUserKey(userHandle) : '';

  // Si la lista no está bloqueada, verificar si el usuario ya completó Corazón con los dedos o Likes Gratis antes de buscar su disco
  if (!botConfig.queueLocked) {
    verificarCompletitudPasos(userKey);
  }

  // BUSCAR SI EL USUARIO YA TIENE SU DISCO EN LA LISTA (sin exigir que sea seguidor)
  const idx = queueState.queue.findIndex(s => {
    const k = normalizarUserKey(s.user);
    const kh = s.handle ? normalizarUserKey(s.handle) : '';
    return (k && (k === userKey || (handleKey && k === handleKey))) ||
           (kh && (kh === userKey || (handleKey && kh === handleKey)));
  });

  if (idx !== -1) {
    const s = queueState.queue[idx];
    const stepData = getUserStepData(userKey, chatName, userHandle);
    stepData.pendingSongTitle = null;
    stepData.pendingSongUrl = null;
    if (linkInfo) {
      // ASIGNAR LINK Y EXTRAER METADATOS REALES (SIN MOSTRAR LA URL EN EL OVERLAY)
      s.songUrl = linkInfo.url;
      s.songPlatform = linkInfo.platform;
      s.platform = linkInfo.platform;
      s.title = `Canción de @${s.user} (${linkInfo.label})`;
      s.status = 'unlocked';
      saveQueueData();

      addLog(`🔗 ${chatName} asignó link de ${linkInfo.label} (${linkInfo.url}) en posición #${idx + 1}`, 'chat');
      resolverTituloDeLink(s, linkInfo.url, linkInfo.label, true);
    } else if (textSongInfo) {
      // ASIGNAR (CANCIÓN + ARTISTA) ENTRE PARÉNTESIS O COMANDO ESCUCHA + CANCIÓN + ARTISTA
      s.title = textSongInfo.title;
      if (!s.songUrl) {
        s.songUrl = textSongInfo.url;
        s.songPlatform = 'youtube';
        s.platform = 'youtube';
      }
      s.status = 'unlocked';
      saveQueueData();

      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        eventType: 'update_song',
        songTitle: s.title,
        songUser: s.user,
        skipVoice: true,
        announcement: `🎵 ¡@${s.user} agregó "${s.title}"!`
      });
      addLog(`🎵 ${chatName} asignó su canción (${escuchaInfo ? 'Escucha' : 'Paréntesis'}): "${s.title}" en posición #${idx + 1}`, 'chat');
    }
    return true;
  } else {
    // Si aún no tiene su disco en la lista, guardar el título/link pendiente para cuando envíe el Corazón con los dedos o llegue a los Likes Gratis
    const stepData = getUserStepData(userKey, chatName, userHandle);
    if (textSongInfo) {
      stepData.pendingSongTitle = textSongInfo.title;
      stepData.pendingSongUrl = textSongInfo.url;
    } else if (linkInfo) {
      stepData.pendingSongUrl = linkInfo.url;
      obtenerMetadatosDeLink(linkInfo.url, linkInfo.label).then(cleanTitle => {
        if (cleanTitle) stepData.pendingSongTitle = cleanTitle;
      }).catch(() => {});
    }

    // Si es el propio streamer/moderador comentando (Canción + Artista) o Escucha + Canción + Artista, agregarlo directo a la lista
    if (isAuthorized && textSongInfo) {
      stepData.pendingSongTitle = null;
      stepData.pendingSongUrl = null;
      const nuevoManual = {
        id: 'admin_' + Date.now() + '_' + Math.random().toString(36).substr(2, 5),
        title: textSongInfo.title,
        songUrl: textSongInfo.url,
        songPlatform: 'youtube',
        platform: 'youtube',
        user: chatName,
        handle: userHandle || '',
        gift: 'Admin',
        status: 'unlocked',
        priority: 'normal',
        vip150: false,
        overtakenCount: 0,
        timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
      };
      queueState.queue.push(nuevoManual);
      saveQueueData();
      broadcast({
        type: 'QUEUE_UPDATE',
        queue: queueState.queue,
        history: queueState.history,
        newSong: nuevoManual,
        newSongDesc: `Agregada por @${chatName}`,
        eventType: 'new_song',
        skipVoice: true,
        announcement: `🎵 ¡Se agregó "${textSongInfo.title}" a la lista!`
      });
      addLog(`🎵 Admin @${chatName} agregó "${textSongInfo.title}" (${escuchaInfo ? 'Escucha' : 'Paréntesis'})`, 'queue');
      return true;
    }

    // Si la lista está bloqueada, confirmar que su canción quedó guardada y que dé TapTap para desbloquear la lista
    if (botConfig.queueLocked) {
      const metaTxt = botConfig.lockTargetLikes ? ` hasta llegar a ${botConfig.lockTargetLikes.toLocaleString()} likes` : '';
      const freeLikes = getFreeLikesReq();
      const aviso = textSongInfo
        ? `🔒 "${textSongInfo.title}" guardada • Da ${freeLikes.toLocaleString()} TapTap o envía Corazón con los dedos 🫰 mientras llegamos a la meta${metaTxt}`
        : `🔒 Lista cerrada${metaTxt} • Da ${freeLikes.toLocaleString()} TapTap o envía Corazón con los dedos 🫰 para entrar al desbloquear`;
      broadcast({
        type: 'CHAT_WARNING',
        user: chatName,
        skipVoice: true,
        message: aviso,
        bannerText: aviso
      });
      addLog(`🔒 ${chatName} envió ${textSongInfo ? `"${textSongInfo.title}"` : `link`} con la lista bloqueada (guardada como pendiente para cuando desbloquee con TapTap o Corazón con los dedos)`, 'chat');
      return true;
    }

    const freeLikes = getFreeLikesReq();
    const bannerMsg = textSongInfo
      ? `"${textSongInfo.title}" guardado • Envía Corazón con los dedos 🫰 o da ${freeLikes.toLocaleString()} Likes para subirlo a la lista`
      : `Para entrar a la lista: Envía Corazón con los dedos 🫰 o da ${freeLikes.toLocaleString()} Likes Gratis ❤️`;
    broadcast({
      type: 'CHAT_WARNING',
      user: chatName,
      skipVoice: true,
      message: bannerMsg,
      bannerText: bannerMsg
    });
    addLog(`⚠️ ${chatName} envió ${textSongInfo ? `"${textSongInfo.title}" (${escuchaInfo ? 'Escucha' : 'Paréntesis'})` : `link de ${linkInfo.label}`} (guardado como pendiente hasta que envíe Corazón con los dedos o ${freeLikes} likes).`, 'chat');
    return true;
  }
}

function processServerLike(userIdentifier, count, extraInfo = {}) {
  if (extraInfo.displayId || extraInfo.nickname || extraInfo.userId) {
    registrarAliasServidor(userIdentifier, extraInfo.displayId, extraInfo.nickname, extraInfo.userId);
  }
  const userKey = normalizarUserKey(userIdentifier);

  // Verificar si el usuario ya tiene un disco activo en la cola actual
  const idx = queueState.queue.findIndex(s => {
    const k = normalizarUserKey(s.user);
    const kh = s.handle ? normalizarUserKey(s.handle) : '';
    return k === userKey || (kh && kh === userKey);
  });

  if (idx !== -1) {
    // Si ya está en la lista, solo sumar likes a su disco actual y NO acumular para crear otro disco al desbloquear
    const s = queueState.queue[idx];
    s.likes = (s.likes || 0) + count;
    saveQueueData();
    return;
  }

  const total = (serverUserLikes.get(userKey) || 0) + count;
  serverUserLikes.set(userKey, total);

  // #2 Registrar likes acumulados del usuario para la opción gratuita (editable desde el panel o comando D-X)
  const stepData = getUserStepData(userKey, userIdentifier, extraInfo.handle, extraInfo.avatarUrl);
  stepData.likesGiven = total;
  const freeLikesNeeded = getFreeLikesReq();
  if (total >= freeLikesNeeded) {
    if (!botConfig.queueLocked) {
      verificarCompletitudPasos(userKey, extraInfo);
    } else if (!stepData.readyForUnlockLog) {
      stepData.readyForUnlockLog = true;
      addLog(`⏳ @${userIdentifier} completó ${total.toLocaleString()} TapTap durante el bloqueo — entrará automáticamente al desbloquearse la lista.`, 'queue');
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
    saveQueueData();
  }
}

const recentSpecialGiftAnim = new Map();

function processServerGift(userIdentifier, giftName, repeatCount, diamondCount, comment, extraInfo = {}) {
  if (extraInfo.displayId || extraInfo.nickname || extraInfo.userId) {
    registrarAliasServidor(userIdentifier, extraInfo.displayId, extraInfo.nickname, extraInfo.userId);
  }
  const userKey = normalizarUserKey(userIdentifier);
  const rawGiftText = [
    giftName,
    extraInfo.allGiftText
  ].filter(Boolean).join(' ').toLowerCase();
  const giftIdNum = Number(extraInfo.giftId) || 0;
  const totalCoins = (Number(diamondCount) || 1) * (Number(repeatCount) || 1);

  // DETECCIÓN ULTRA-ROBUSTA DE REGALOS ESPECIALES (EN ESPAÑOL, INGLÉS Y POR GIFT ID DE TIKTOK)
  const isCorazonDedos =
    giftIdNum === 5487 ||
    (rawGiftText.includes('coraz') && (rawGiftText.includes('dedo') || rawGiftText.includes('finger'))) ||
    rawGiftText.includes('finger heart') ||
    rawGiftText.includes('corazón dedos') ||
    rawGiftText.includes('corazon dedos');

  const isQuiereme =
    giftIdNum === 7934 ||
    giftIdNum === 6093 ||
    giftIdNum === 5879 ||
    rawGiftText.includes('quiéreme') ||
    rawGiftText.includes('quiereme') ||
    rawGiftText.includes('heart me') ||
    rawGiftText.includes('heartme') ||
    rawGiftText.includes('team heart') ||
    rawGiftText.includes('corazón de equipo') ||
    rawGiftText.includes('corazon de equipo') ||
    rawGiftText.includes('corazón del equipo') ||
    rawGiftText.includes('corazon del equipo') ||
    rawGiftText.includes('love me') ||
    rawGiftText.includes('love you') ||
    rawGiftText.includes('cuddle');

  if (comment && !extraInfo.isPendingStreak) {
    processServerChat(comment, userIdentifier, extraInfo.handle || extraInfo.displayId, extraInfo.userId);
  }

  // 1. CASO REGALO: CORAZÓN CON LOS DEDOS -> AGREGA DIRECTO A LA LISTA SIN NECESIDAD DE SEGUIR NI COMPARTIR
  if (isCorazonDedos) {
    const stepData = getUserStepData(userKey, userIdentifier, extraInfo.handle, extraInfo.avatarUrl);
    stepData.giftedHeart = true;

    const animKey = `corazon_${userKey}`;
    const now = Date.now();
    if (!recentSpecialGiftAnim.has(animKey) || (now - recentSpecialGiftAnim.get(animKey)) > 3500) {
      recentSpecialGiftAnim.set(animKey, now);
      broadcast({
        type: 'EPIC_GIFT_ANIMATION',
        giftType: 'corazon_dedos',
        user: userIdentifier,
        avatarUrl: extraInfo.avatarUrl || ''
      });
    }

    verificarCompletitudPasos(userKey, extraInfo);
  }

  // 2. #3 CASO REGALO: QUIÉREME -> ACTIVA INMEDIATAMENTE LA LECTURA DE COMENTARIOS DEL USUARIO EN EL LIVE + ANIMACIÓN ÉPICA
  if (isQuiereme) {
    registrarUsuarioQuiereme(userIdentifier, extraInfo);

    const animKey = `quiereme_${userKey}`;
    const now = Date.now();
    if (!recentSpecialGiftAnim.has(animKey) || (now - recentSpecialGiftAnim.get(animKey)) > 3500) {
      recentSpecialGiftAnim.set(animKey, now);
      broadcast({
        type: 'EPIC_GIFT_ANIMATION',
        giftType: 'quiereme',
        user: userIdentifier,
        avatarUrl: extraInfo.avatarUrl || ''
      });
      addLog(`💖 ${userIdentifier} envió Quiéreme -> Lectura de comentarios por voz activada durante todo el Live`, 'gift');
    }
  }

  // Si es una racha en curso (streak tipo 1 que aún no ha finalizado), esperar al cierre de la racha para calcular las monedas totales
  if (extraInfo.isPendingStreak) {
    return;
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

let lastConnectedRoomId = null;

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

    // #3 Al iniciar un nuevo Live se restablece la lectura de comentarios; si es reconexión al mismo Live, se conserva quienes ya enviaron Quiéreme
    const currentRoomIdStr = String(state.roomId || '');
    if (!lastConnectedRoomId || currentRoomIdStr !== lastConnectedRoomId) {
      quieremeUsers.clear();
      lastConnectedRoomId = currentRoomIdStr;
      addLog(`🔄 Lectura de comentarios restablecida para el nuevo Live: solo se leerán mensajes de quienes envíen un "Quiéreme".`, 'info');
    } else {
      addLog(`🔄 Reconectado al mismo Live (Room ${currentRoomIdStr}): se mantienen activos los usuarios que ya enviaron "Quiéreme".`, 'info');
    }

    // #1 Al conectar la lista al Live, si no ha llegado a 4000 likes, se bloquea hasta llegar a 4000 likes
    const initialRoomLikes = Number(state?.roomInfo?.likeCount || state?.roomInfo?.stats?.likeCount || 0) || 0;
    globalStreamLikes = initialRoomLikes;
    let globalLiveLikes = initialRoomLikes;
    let lastLikesMilestone = Math.floor(globalLiveLikes / 10000) * 10000;

    if (globalStreamLikes < 4000) {
      botConfig.queueLocked = true;
      botConfig.lockTargetLikes = 4000;
      reiniciarParaBloqueo(true);
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
      let displayId = (u.displayId || u.uniqueId || data.uniqueId || '').replace(/^@/, '').trim();
      let nickname = (u.nickname || data.nickname || '').replace(/^@/, '').trim();
      let userId = String(u.id || u.idStr || data.userId || '').trim();

      if ((!displayId || !nickname) && data.common?.displayText?.pieces) {
        for (const piece of data.common.displayText.pieces) {
          if (piece.userValue) {
            displayId = displayId || (piece.userValue.displayId || piece.userValue.uniqueId || '').replace(/^@/, '').trim();
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
        const hasSentQuiereme = usuarioTieneQuiereme(info.chatName, info);
        const canReadTTS = hasSentQuiereme && !contieneLink(comment);
        const cleanUser = limpiarNombreParaVoz(info.chatName);

        if (canReadTTS) {
          addLog(`🔊 Leyendo en voz alta a ${info.chatName} (Quiéreme activo): "${comment}"`, 'chat');
        }

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

    // Escuchar Regalos (Importante: en protobuf v3 repeatEnd es 0 para regalos sin racha como "Quiéreme", por lo que NO se debe descartar)
    tiktokConnection.on(WebcastEvent.GIFT, (data) => {
      if (data.createTime && (data.createTime * 1000 < connectedAt - 2000)) return;

      const info = extractUserInfo(data);
      const giftType = Number(data.giftDetails?.giftType ?? data.gift?.giftType ?? data.giftType ?? 0);
      const isPendingStreak = (giftType === 1 && !data.repeatEnd);
      const giftId = Number(data.giftId || data.gift?.id || data.giftDetails?.id || 0);
      const giftName = data.extendedGiftInfo?.name || data.giftDetails?.giftName || data.gift?.name || data.giftName || data.describe || 'Regalo';
      const allGiftText = [
        data.extendedGiftInfo?.name,
        data.giftDetails?.giftName,
        data.gift?.name,
        data.giftName,
        data.describe,
        data.common?.displayText?.defaultPattern
      ].filter(Boolean).join(' ');

      const repeatCount = Number(data.repeatCount) || Number(data.comboCount) || 1;
      const diamondCount = Number(data.diamondCount ?? data.giftDetails?.diamondCount ?? data.gift?.diamondCount ?? data.extendedGiftInfo?.diamond_count) || 1;
      const comment = (data.content || data.comment || '').trim();

      if (!isPendingStreak) {
        addLog(`🎁 ${info.chatName} envió ${giftName} x${repeatCount} ${comment ? `("${comment}")` : ''}`, 'gift');
      }

      processServerGift(info.chatName, giftName, repeatCount, diamondCount, comment, {
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId,
        avatarUrl: info.avatarUrl,
        giftId: giftId,
        allGiftText: allGiftText,
        isPendingStreak: isPendingStreak
      });

      if (!isPendingStreak) {
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
      }
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

      // Primero registrar los likes individuales del usuario para que si este TapTap alcanza la meta global, su disco ya entre en el desbloqueo
      addLog(`❤️ ${info.chatName} dio ${count} likes ${total ? `(Total Live: ${total})` : `(Acumulado: ${globalStreamLikes})`}`, 'like');
      processServerLike(info.chatName, count, {
        displayId: info.displayId,
        handle: info.handle,
        nickname: info.nickname,
        userId: info.userId,
        avatarUrl: info.avatarUrl
      });

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
    freeLikesReq: getFreeLikesReq(),
    requireFollowerToRequest: false,
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
        const newLikesReq = Math.max(1, Number(payload.rules?.likesReq) || getFreeLikesReq());
        botConfig.freeLikesReq = newLikesReq;
        botConfig.rules = {
          likesReq: newLikesReq,
          sharesReq: Number(payload.rules?.sharesReq) || 10,
          rosesReq: Number(payload.rules?.rosesReq) || 5,
          giftCategories: payload.rules?.giftCategories || botConfig.rules.giftCategories,
          vipMinDiamonds: Number(payload.rules?.vipMinDiamonds) || 100
        };
        saveConfig();
        broadcast({ type: 'RULES_UPDATE', rules: botConfig.rules });
        broadcast({ type: 'FREE_LIKES_UPDATE', freeLikesReq: newLikesReq, skipVoice: true });
        addLog(`⚙️ Reglas de regalos y desbloqueo actualizadas (Likes Gratis: ${newLikesReq.toLocaleString()}).`, 'info');
        procesarPasosPendientesAlDesbloquear();
      } else if (payload.action === 'updateFreeLikesReq') {
        const newLikesReq = Math.max(1, parseInt(payload.freeLikesReq, 10) || 5000);
        botConfig.freeLikesReq = newLikesReq;
        if (botConfig.rules) botConfig.rules.likesReq = newLikesReq;
        saveConfig();
        const announcement = `🎁 ¡Canción gratis activada con ${newLikesReq.toLocaleString()} likes! (D-${newLikesReq})`;
        broadcast({
          type: 'FREE_LIKES_UPDATE',
          freeLikesReq: newLikesReq,
          skipVoice: false,
          announcement: announcement
        });
        addLog(`🎁 Meta de likes para canción gratis actualizada desde el panel: ${newLikesReq.toLocaleString()} likes (D-${newLikesReq})`, 'queue');
        procesarPasosPendientesAlDesbloquear();
      } else if (payload.action === 'getQueue') {
        ws.send(JSON.stringify({ type: 'QUEUE_UPDATE', queue: queueState.queue, history: queueState.history }));
      } else if (payload.action === 'deleteSong') {
        const songId = payload.songId;
        const idx = queueState.queue.findIndex(s => s && s.id === songId);
        if (idx !== -1) {
          const removed = queueState.queue.splice(idx, 1)[0];
          limpiarProgresoUsuarioDeCancion(removed);
          queueState.history.unshift({ ...removed, playedAt: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) });
          if (queueState.history.length > 50) queueState.history = queueState.history.slice(0, 50);
          saveQueueData();
          broadcast({
            type: 'QUEUE_UPDATE',
            queue: queueState.queue,
            history: queueState.history,
            skipVoice: true
          });
          addLog(`✅ Canción atendida/eliminada de la lista: "${removed.title}" (@${removed.user})`, 'queue');
        }
      } else if (payload.action === 'clearQueue') {
        reiniciarParaBloqueo(true);
        addLog(`🧹 Cola de canciones vaciada y contadores de TapTap reiniciados.`, 'queue');
      } else if (payload.action === 'syncQueue') {
        if (Array.isArray(payload.queue)) {
          // Detectar canciones que estaban en el servidor pero fueron quitadas en la nueva cola y limpiar su progreso
          const incomingIds = new Set(payload.queue.map(s => s && s.id).filter(Boolean));
          for (const prevSong of queueState.queue) {
            if (prevSong && prevSong.id && !incomingIds.has(prevSong.id)) {
              limpiarProgresoUsuarioDeCancion(prevSong);
            }
          }
          // Filtrar canciones ya eliminadas o de sesiones antiguas para que ninguna pestaña vieja las reviva
          queueState.queue = payload.queue.filter(item => {
            if (!item || !item.id) return false;
            if (deletedSongIds.has(item.id)) return false;
            if (String(item.id).startsWith('song_1791') || String(item.id).startsWith('disk_17926')) return false;
            return true;
          });
          verificarEliminacionServidor(queueState.queue);
          // Si alguna canción agregada manualmente tiene un link como título, extraer su URL y resolver sus metadatos reales
          for (const item of queueState.queue) {
            if (item && item.title && contieneLink(item.title)) {
              const lInfo = detectarLinkCancion(item.title);
              if (lInfo) {
                item.songUrl = lInfo.url;
                item.songPlatform = lInfo.platform;
                item.platform = lInfo.platform;
                item.title = `Canción de @${item.user || 'Artista'} (${lInfo.label})`;
                resolverTituloDeLink(item, lInfo.url, lInfo.label, false);
              }
            }
          }
        }
        if (Array.isArray(payload.history)) queueState.history = payload.history;
        saveQueueData();

        // Reenviar inmediatamente la cola a todas las ventanas abiertas (Meld Studio / OBS)
        const updateMsg = JSON.stringify({
          type: 'QUEUE_UPDATE',
          queue: queueState.queue,
          history: queueState.history,
          skipVoice: true
        });
        for (const client of wss.clients) {
          if (client.readyState === WebSocket.OPEN) {
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
          // En pruebas de chat desde el simulador, asegurar que el usuario de prueba tenga lectura de voz activa (Quiéreme)
          registrarUsuarioQuiereme(testUser, { handle: testUser, displayId: testUser });
          const canReadTTS = !contieneLink(testComment);
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
        } else {
          if (payload.lockTargetLikes) {
            botConfig.lockTargetLikes = Number(payload.lockTargetLikes) || null;
          }
          // Al bloquear la lista desde el panel, archivar temas escuchados y reiniciar contadores de TapTap
          reiniciarParaBloqueo(true);
        }
        saveConfig();
        const msg = botConfig.queueLocked
          ? (botConfig.lockTargetLikes
              ? `¡La lista de canciones ha sido bloqueada hasta llegar a ${botConfig.lockTargetLikes.toLocaleString()} likes!`
              : "¡La lista de canciones ha sido bloqueada! No se aceptan más peticiones por el momento.")
          : "¡La lista de canciones ha sido reabierta! Ya pueden entrar con Corazón con los dedos o Likes Gratis.";
        broadcast({
          type: 'QUEUE_LOCK_UPDATE',
          locked: botConfig.queueLocked,
          lockTargetLikes: botConfig.lockTargetLikes,
          currentLikes: globalStreamLikes,
          announcement: msg
        });
        addLog(botConfig.queueLocked ? "🔒 Lista bloqueada manualmente desde el panel (temas anteriores limpiados)" : "🔓 Lista desbloqueada manualmente desde el panel", 'queue');
        if (!botConfig.queueLocked) {
          procesarPasosPendientesAlDesbloquear();
        }
      } else if (payload.action === 'toggleRequireFollower') {
        botConfig.requireFollowerToRequest = false;
        saveConfig();
        broadcast({
          type: 'EXTRA_CONFIG',
          queueLocked: botConfig.queueLocked,
          lockTargetLikes: botConfig.lockTargetLikes || null,
          currentLikes: globalStreamLikes,
          freeLikesReq: getFreeLikesReq(),
          requireFollowerToRequest: false,
          certifiedPlaylist: certifiedPlaylist
        });
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
