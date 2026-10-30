/**
 * ============================================================================
 * PROYECTO: RADIO LIVE INTERACTIVA — BACKEND & MOTOR DE EVENTOS / AUDIO / COLA
 * ============================================================================
 * Arquitectura modular completamente independiente del Overlay 1 (index.html).
 * Incluye:
 * - Conector independiente de TikTok LIVE con detección de duplicados y Modo de Pruebas.
 * - Acumulador de monedas por usuario con umbral configurable, manejo de excedente e idempotencia.
 * - Generador de saludos personalizados con 5 estilos de locución y plantillas dinámicas.
 * - Motor central de intervenciones con cola de prioridades (1 a 5), agrupación y parada de emergencia.
 * - Sistema de llamadas ficticias dramatizadas a 2 voces (Locutor Masculino + Oyente Femenina).
 * - Buscador de canciones en YouTube (YouTube Data API v3 + Buscador directo + oEmbed).
 * - Cola musical persistente con estados, validación, historial y adelanto por regalos.
 * - Programador automático de mensajes de emisora y registro de estadísticas.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const { TikTokLiveConnection, WebcastEvent } = require('tiktok-live-connector');

const RADIO_DATA_FILE = path.join(__dirname, 'radio-data.json');

// Estilos de locución predefinidos y sus plantillas por defecto
const DEFAULT_GREETING_TEMPLATES = {
  urbano_dominicano: [
    "¡Atención, mi gente! Tenemos un saludo especial para {username}, que acaba de apoyarnos con {total_coins} monedas en nuestra emisora. ¡Gracias por ese {gift_name}, mi amor! Ponte cómodo que la música sigue encendida.",
    "¡Oye pero qué flow! Dímelo {username}, gracias de corazón por enviar {gift_name} y sumar {total_coins} monedas en cabina. ¡Esta emisora está activa gracias a ti, bendiciones!",
    "¡Súbele el volumen a la radio! Reportándose en sintonía {username} con {total_coins} monedas de apoyo. ¡Gracias por ese {gift_name}, aquí seguimos soltando los mejores temas en vivo!",
    "¡Fuego en la cabina! Un saludo bien duro para {username} que se hizo sentir con {gift_name} llegando a {total_coins} monedas. ¡Quédate ahí que viene buena música!"
  ],
  romantica: [
    "Queremos hacer una pausa muy especial en nuestra transmisión para saludar con mucho cariño a {username}, quien nos acompaña y nos apoya con {total_coins} monedas. Gracias por ese hermoso detalle de {gift_name}, sigue disfrutando de la mejor música.",
    "Un abrazo lleno de buena energía para {username}. Gracias por iluminar nuestra cabina con tu {gift_name} y alcanzar {total_coins} monedas. Esta siguiente melodía también suena para ti.",
    "En esta noche de buena música, enviamos un saludo muy afectuoso para {username}. Gracias por tu apoyo de {total_coins} monedas a nuestra emisora."
  ],
  humoristica: [
    "¡Paren las rotativas y suelten el micrófono! {username} acaba de romper el cochinito con {gift_name} sumando {total_coins} monedas. ¡Así sí da gusto trabajar en esta cabina, muchas gracias!",
    "¡Atención control maestro! Confirmado: {username} es oficialmente VIP de la emisora tras llegar a {total_coins} monedas con su {gift_name}. ¡Pónganle aire acondicionado exclusivo en primera fila!",
    "¡Ay mamá! {username} llegó tirando la casa por la ventana con {gift_name} y {total_coins} monedas acumuladas. ¡Gracias por mantener vivo al locutor!"
  ],
  juvenil: [
    "¡Ey, qué buena vibra! Un saludo gigante para {username} que acaba de sumar {total_coins} monedas con {gift_name}. ¡Gracias por apoyar el stream, seguimos con más música!",
    "¡Tremendo apoyo de {username} en el chat! Gracias por ese {gift_name} y tus {total_coins} monedas, eres parte clave de nuestra comunidad musical.",
    "¡Shoutout especial para {username}! Llegó a {total_coins} monedas enviando {gift_name}. ¡La energía está al cien en la radio!"
  ],
  profesional: [
    "Hacemos una breve mención en nuestra programación en directo para agradecer a {username} por su aporte de {total_coins} monedas mediante {gift_name}. Muchas gracias por su sintonía.",
    "Agradecemos cordialmente la participación de {username}, quien ha alcanzado {total_coins} monedas de apoyo en nuestra emisora interactiva. Continuamos con nuestra selección musical.",
    "Saludos en directo para {username}. Gracias por respaldar esta transmisión con {gift_name} y un total de {total_coins} monedas."
  ]
};

// Plantillas de llamadas ficticias dramatizadas a dos voces (F = Voz Femenina, M = Locutor Masculino)
const DEFAULT_CALL_TEMPLATES = [
  {
    id: 'call_tpl_1',
    name: 'Llamada Clásica de Petición Urbana',
    lines: [
      { speaker: 'F', text: '¡Hola, buenas, cariño! ¿Me escuchan en la cabina?' },
      { speaker: 'M', text: '¡Fuerte y claro, mi amor! Estás al aire en Radio Live Interactiva. ¿Qué tenemos para hoy?' },
      { speaker: 'F', text: 'Llamo de parte de {username}, que está en sintonía y quiere que pongas su tema titulado {song_title}, del artista {artist_name}.' },
      { speaker: 'M', text: '¡Eso va directo para la lista, mi gente! Está en la posición número {queue_position} y tenemos {songs_before} canciones antes de esa. ¡Vamos a ver quién se anima con {gift_threshold} monedas para adelantarla!' }
    ]
  },
  {
    id: 'call_tpl_2',
    name: 'Llamada Emocionada desde el Live',
    lines: [
      { speaker: 'F', text: '¡Aló, cabina! ¡Qué emoción que entró la llamada!' },
      { speaker: 'M', text: '¡Dímelo, corazón! Estás en vivo para toda la audiencia de TikTok. ¿De parte de quién nos llamas?' },
      { speaker: 'F', text: 'Te llamo de parte de {username}. Me pidió que por favor no deje de sonar {song_title} de {artist_name}.' },
      { speaker: 'M', text: '¡Complacido en el acto! Ya quedó anotada en el puesto {queue_position}, con {songs_before} temas por delante. ¡Recuerden que enviando {gift_threshold} monedas pueden subir su canción en la fila!' }
    ]
  },
  {
    id: 'call_tpl_3',
    name: 'Llamada VIP de Cabina',
    lines: [
      { speaker: 'F', text: '¡Buenas noches, locutor! Reportando sintonía total en la emisora.' },
      { speaker: 'M', text: '¡Esa es la actitud, mi reina! Cuéntame, ¿qué canción vamos a programar ahora mismo?' },
      { speaker: 'F', text: 'Aquí {username} está pidiendo a gritos el tema {song_title}, interpretado por {artist_name}.' },
      { speaker: 'M', text: '¡Fuego con ese tema! Ya entró en la posición {queue_position} de la cola y tiene {songs_before} canciones antes. ¡No se muevan que la radio está encendida!' }
    ]
  }
];

const DEFAULT_SCHEDULED_MESSAGES = [
  {
    id: 'sched_1',
    text: 'Estás escuchando Radio Live Interactiva. Recuerda que puedes pedir tu canción escribiendo en el chat: Ponme dos puntos, el nombre de la canción más el artista.',
    enabled: true
  },
  {
    id: 'sched_2',
    text: '¡Apoya nuestra emisora en vivo! Al acumular {gift_threshold} monedas en regalos, nuestro locutor te enviará un saludo especial en directo.',
    enabled: true
  },
  {
    id: 'sched_3',
    text: '¿Quieres que tu canción suene más rápido? Envía regalos en el Live para adelantar posiciones en la lista de reproducción.',
    enabled: true
  }
];

function createDefaultRadioData() {
  return {
    config: {
      stationName: 'RADIO LIVE INTERACTIVA 105.9 FM',
      stationSlogan: 'La Emisora Oficial del Live • Música & Cabina en Vivo',
      tiktokUsername: '',
      mirrorMainTikTokConnection: true,
      youtubeApiKey: process.env.YOUTUBE_API_KEY || '',
      obsWebSocket: {
        enabled: false,
        url: process.env.OBS_WS_URL || 'ws://127.0.0.1:4455',
        password: process.env.OBS_WS_PASSWORD || '',
        musicInputName: 'Música Radio'
      },
      // Reglas de Regalos y Monedas (Sección 6)
      coins: {
        greetingThreshold: 10,       // Umbral configurable (10-20 monedas o personalizado)
        carryOverSurplus: true,      // Conservar excedente para siguientes activaciones
        allowMultipleActivations: false
      },
      // Configuración de Saludos (Sección 7)
      greetings: {
        enabled: true,
        style: 'urbano_dominicano',
        groupGreetings: true,        // Agrupar varios saludos breves si se acumulan
        groupThresholdCount: 3,
        followerGreetingEnabled: true,
        likesMilestoneStep: 10000,
        templates: DEFAULT_GREETING_TEMPLATES
      },
      // Director de Audio y Ducking (Sección 8)
      audio: {
        normalMusicVolume: 80,       // Volumen habitual de la música (%)
        duckMusicVolume: 20,         // Volumen durante la voz (%)
        fadeInMs: 500,               // Duración del fundido de bajada (ms)
        fadeOutMs: 800,              // Duración del fundido de subida (ms)
        ttsVolume: 100,              // Volumen de la voz TTS (%)
        ttsRate: 1.0,
        minSecondsBetweenGreetings: 4,
        emergencyStopActive: false
      },
      // Voces Neuronales HD (Sección 13 - Dos voces diferenciables)
      voices: {
        maleAnnouncerVoice: 'es-DO-EmilioNeural',
        maleAnnouncerLabel: '🇩🇴 Emilio (Locutor Urbano Dominicano)',
        femaleCallerVoice: 'es-DO-RamonaNeural',
        femaleCallerLabel: '🇩🇴 Ramona (Oyente Femenina Natural)'
      },
      // Llamadas Ficticias a 2 Voces (Sección 13)
      calls: {
        enabled: true,
        probabilityPct: 100,         // % de peticiones que disparan llamada dramatizada
        triggerOnSongRequest: true,
        templates: DEFAULT_CALL_TEMPLATES
      },
      // Peticiones Musicales por Comentarios (Sección 12)
      requests: {
        commandPrefix: 'Ponme:',
        requireCoins: false,
        coinsCost: 0,
        maxPerUser: 3,
        cooldownSeconds: 20,
        allowDuplicates: false,
        requireAdminApproval: false,
        maxPendingQueue: 30,
        blockedUsers: []
      },
      // Adelantar Canciones con Regalos (Sección 14)
      advance: {
        enabled: true,
        coinsThreshold: 20,          // Monedas para adelantar canción
        positionsPerThreshold: 1,    // Posiciones que avanza por cada umbral
        maxPositionsAdvance: 5,      // Máximo de posiciones que puede avanzar de golpe
        allowOvertakeFirst: true,    // Si puede ponerse en el #1 de las pendientes
        ambiguousPolicy: 'oldest'    // 'oldest' (adelanta su primera canción pendiente) | 'review' (solicita aclaración / revisión)
      },
      // Mensajes Programados (Sección 11 / 9)
      scheduled: {
        enabled: true,
        intervalMinutes: 8,
        messages: DEFAULT_SCHEDULED_MESSAGES
      },
      // Prioridades configurables del Motor de Intervenciones (Sección 9)
      priorities: {
        manualAdmin: 1,
        fictionalCall: 2,
        giftGreeting: 3,
        songAnnouncement: 3,
        followerGreeting: 4,
        likesMilestone: 5,
        scheduledMessage: 5
      },
      // Visibilidad modular de componentes del Overlay (Sección 4)
      overlayComponents: {
        header: true,
        currentSong: true,
        upcomingQueue: true,
        audienceActivity: true,
        interventions: true,
        calls: true,
        radioState: true,
        equalizer: true,
        transparentBg: true
      }
    },
    queue: [],
    currentSong: null,
    history: [],
    users: {},
    giftHistory: [],
    activityFeed: [],
    stats: {
      totalCoinsReceived: 0,
      totalGiftsReceived: 0,
      totalGreetingsPlayed: 0,
      totalCallsPlayed: 0,
      totalSongsRequested: 0,
      totalSongsPlayed: 0,
      totalFollowersDetected: 0,
      totalLikesReceived: 0
    }
  };
}

class RadioInteractiveEngine {
  constructor(options = {}) {
    this.broadcastRadio = options.broadcastRadio || (() => {});
    this.voicesCatalog = options.voicesCatalog || [];

    this.data = createDefaultRadioData();
    this.loadData();

    // Estado en vivo de la emisora
    this.connectionState = {
      status: 'test_mode', // 'connected' | 'connecting' | 'reconnecting' | 'disconnected' | 'test_mode'
      isRealConnection: false,
      modeLabel: 'MODO DE PRUEBAS',
      username: this.data.config.tiktokUsername || '',
      roomId: null,
      lastError: null,
      connectedAt: null,
      disconnectionsCount: 0
    };

    this.radioState = 'IDLE'; // 'PLAYING' | 'DUCKING' | 'ANNOUNCER_SPEAKING' | 'CALL_IN_PROGRESS' | 'PAUSED' | 'RECONNECTING' | 'IDLE'
    this.queuePaused = false;
    this.tiktokConn = null;
    this.reconnectTimer = null;

    // Deduplicación idempotente de eventos de TikTok
    this.processedEventIds = new Set();
    this.userRequestCooldowns = new Map();
    this.lastGreetingTemplateIdx = -1;
    this.lastCallTemplateIdx = -1;

    // Cola central de intervenciones por prioridad
    this.interventionsQueue = [];
    this.activeIntervention = null;
    this.interventionWatchdog = null;
    this.lastInterventionEndedAt = 0;

    // Estado de reproducción en tiempo real reportado por el reproductor
    this.playbackProgress = {
      videoId: null,
      currentTime: 0,
      duration: 0,
      isPlaying: false,
      volume: this.data.config.audio.normalMusicVolume
    };

    // Temporizador de mensajes programados
    this.scheduledIdx = 0;
    this.scheduledTimer = null;
    this.startScheduledMessagesTimer();
  }

  loadData() {
    try {
      if (fs.existsSync(RADIO_DATA_FILE)) {
        const raw = JSON.parse(fs.readFileSync(RADIO_DATA_FILE, 'utf8'));
        const def = createDefaultRadioData();
        this.data = {
          ...def,
          ...raw,
          config: {
            ...def.config,
            ...(raw.config || {}),
            obsWebSocket: { ...def.config.obsWebSocket, ...(raw.config?.obsWebSocket || {}) },
            coins: { ...def.config.coins, ...(raw.config?.coins || {}) },
            greetings: {
              ...def.config.greetings,
              ...(raw.config?.greetings || {}),
              templates: { ...def.config.greetings.templates, ...(raw.config?.greetings?.templates || {}) }
            },
            audio: { ...def.config.audio, ...(raw.config?.audio || {}), emergencyStopActive: false },
            voices: { ...def.config.voices, ...(raw.config?.voices || {}) },
            calls: {
              ...def.config.calls,
              ...(raw.config?.calls || {}),
              templates: Array.isArray(raw.config?.calls?.templates) && raw.config.calls.templates.length > 0
                ? raw.config.calls.templates
                : def.config.calls.templates
            },
            requests: { ...def.config.requests, ...(raw.config?.requests || {}) },
            advance: { ...def.config.advance, ...(raw.config?.advance || {}) },
            scheduled: {
              ...def.config.scheduled,
              ...(raw.config?.scheduled || {}),
              messages: Array.isArray(raw.config?.scheduled?.messages) && raw.config.scheduled.messages.length > 0
                ? raw.config.scheduled.messages
                : def.config.scheduled.messages
            },
            priorities: { ...def.config.priorities, ...(raw.config?.priorities || {}) },
            overlayComponents: { ...def.config.overlayComponents, ...(raw.config?.overlayComponents || {}) }
          },
          queue: Array.isArray(raw.queue) ? raw.queue : [],
          currentSong: raw.currentSong || null,
          history: Array.isArray(raw.history) ? raw.history.slice(0, 80) : [],
          users: raw.users && typeof raw.users === 'object' ? raw.users : {},
          giftHistory: Array.isArray(raw.giftHistory) ? raw.giftHistory.slice(0, 150) : [],
          activityFeed: Array.isArray(raw.activityFeed) ? raw.activityFeed.slice(0, 60) : [],
          stats: { ...def.stats, ...(raw.stats || {}) }
        };
        this.recalcularPosicionesCola();
      }
    } catch (err) {
      console.error('[RadioEngine] Error cargando radio-data.json:', err.message);
    }
  }

  saveData() {
    if (this._saveTimeout) return;
    this._saveTimeout = setTimeout(() => {
      this._saveTimeout = null;
      try {
        const tmpFile = `${RADIO_DATA_FILE}.tmp`;
        fs.writeFileSync(tmpFile, JSON.stringify(this.data, null, 2), 'utf8');
        try {
          fs.renameSync(tmpFile, RADIO_DATA_FILE);
        } catch (renameErr) {
          // Si rename falla por bloqueo de Windows, fallback con copy
          fs.copyFileSync(tmpFile, RADIO_DATA_FILE);
          try { fs.unlinkSync(tmpFile); } catch (_) {}
        }
      } catch (err) {
        console.error('[RadioEngine] Error guardando radio-data.json:', err.message);
      }
    }, 1000);
  }

  normalizeUserKey(str) {
    if (!str) return 'anonimo';
    return String(str).toLowerCase().replace(/^@/, '').trim() || 'anonimo';
  }

  cleanNameForSpeech(rawName) {
    if (!rawName) return 'un oyente especial';
    let s = String(rawName)
      .replace(/^@+/, '')
      .replace(/[_\-.]+/g, ' ')
      .replace(/[^\p{L}\s]/gu, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    return s || 'un oyente especial';
  }

  addActivity(type, title, subtitle = '', meta = {}) {
    const entry = {
      id: 'act_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type, // 'gift' | 'greeting' | 'song' | 'call' | 'follow' | 'advance' | 'system' | 'error'
      title,
      subtitle,
      meta,
      timestamp: new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }),
      createdAt: Date.now()
    };
    this.data.activityFeed.unshift(entry);
    if (this.data.activityFeed.length > 60) {
      this.data.activityFeed = this.data.activityFeed.slice(0, 60);
    }
    this.saveData();
    this.broadcastRadio({ type: 'RADIO_ACTIVITY', entry, stats: this.data.stats });
    return entry;
  }

  getFullState() {
    return {
      config: this.data.config,
      connectionState: this.connectionState,
      radioState: this.radioState,
      queuePaused: this.queuePaused,
      currentSong: this.data.currentSong,
      queue: this.data.queue,
      history: this.data.history.slice(0, 30),
      users: this.getTopUsersList(),
      giftHistory: this.data.giftHistory.slice(0, 40),
      activityFeed: this.data.activityFeed.slice(0, 30),
      interventionsQueue: this.interventionsQueue,
      activeIntervention: this.activeIntervention,
      playbackProgress: this.playbackProgress,
      stats: this.data.stats,
      voicesCatalog: this.voicesCatalog
    };
  }

  getTopUsersList() {
    return Object.values(this.data.users || {})
      .sort((a, b) => (b.totalHistoricalCoins || 0) - (a.totalHistoricalCoins || 0))
      .slice(0, 100);
  }

  broadcastStateUpdate(extra = {}) {
    this.broadcastRadio({
      type: 'RADIO_STATE_SYNC',
      state: this.getFullState(),
      ...extra
    });
  }

  setRadioState(newState) {
    this.radioState = newState;
    this.broadcastRadio({
      type: 'RADIO_STATUS_BADGE',
      radioState: this.radioState,
      activeIntervention: this.activeIntervention
    });
  }

  // ==========================================================================
  // 5. INTEGRACIÓN CON TIKTOK LIVE (INDEPENDIENTE + ESPEJO + MODO DE PRUEBAS)
  // ==========================================================================
  async connectTikTok(rawUsername) {
    const username = String(rawUsername || this.data.config.tiktokUsername || '').replace(/^@/, '').trim();
    if (!username) {
      this.setConnectionStatus('test_mode', {
        isRealConnection: false,
        modeLabel: 'MODO DE PRUEBAS',
        lastError: 'Ingresa un usuario de TikTok válido para conectar en vivo.'
      });
      return;
    }

    this.disconnectTikTok(false);
    this.data.config.tiktokUsername = username;
    this.saveData();

    this.setConnectionStatus('connecting', {
      username,
      isRealConnection: false,
      modeLabel: 'CONECTANDO A TIKTOK LIVE...',
      lastError: null
    });
    this.addActivity('system', `Conectando a TikTok LIVE (@${username})...`, 'Iniciando conector independiente');

    try {
      this.tiktokConn = new TikTokLiveConnection(username, {
        processInitialData: false,
        enableExtendedGiftInfo: false,
        fetchRoomInfoOnConnect: false
      });

      const state = await this.tiktokConn.connect();
      const connectedAt = Date.now();

      this.setConnectionStatus('connected', {
        username,
        roomId: String(state.roomId || ''),
        isRealConnection: true,
        modeLabel: 'CONECTADO EN VIVO',
        connectedAt,
        lastError: null
      });
      this.addActivity('system', `¡Conectado a TikTok LIVE de @${username}!`, `Room ID: ${state.roomId}`);

      const extractUser = (data) => {
        const u = data.user || {};
        const uniqueId = (u.uniqueId || u.displayId || data.uniqueId || '').replace(/^@/, '').trim();
        const nickname = (u.nickname || data.nickname || uniqueId || 'Oyente').trim();
        const userId = String(u.id || u.idStr || data.userId || uniqueId || nickname).trim();
        const avatarUrl = u.profilePictureUrl || u.avatarThumb?.urlList?.[0] || '';
        return { userId, uniqueId, nickname, avatarUrl };
      };

      this.tiktokConn.on(WebcastEvent.GIFT, (data) => {
        if (data.createTime && data.createTime * 1000 < connectedAt - 2000) return;
        const giftType = Number(data.giftDetails?.giftType ?? data.gift?.giftType ?? data.giftType ?? 0);
        const isPendingStreak = (giftType === 1 && !data.repeatEnd);
        if (isPendingStreak) return; // Esperar al cierre de la racha para procesar el total exacto sin duplicar

        const u = extractUser(data);
        const giftId = Number(data.giftId || data.gift?.id || 0);
        const giftName = data.extendedGiftInfo?.name || data.giftDetails?.giftName || data.gift?.name || data.giftName || data.describe || 'Regalo';
        const repeatCount = Math.max(1, Number(data.repeatCount || data.comboCount || 1));
        const unitCoins = Math.max(1, Number(data.diamondCount ?? data.giftDetails?.diamondCount ?? data.gift?.diamondCount ?? data.extendedGiftInfo?.diamond_count ?? 1));
        const msgId = String(data.common?.msgId || `${u.userId}_${giftId}_${repeatCount}_${Math.floor(Date.now() / 1500)}`);

        this.handleGiftEvent({
          eventId: msgId,
          userId: u.userId,
          username: u.nickname,
          handle: u.uniqueId,
          avatarUrl: u.avatarUrl,
          giftName,
          repeatCount,
          unitCoins,
          totalCoins: unitCoins * repeatCount,
          platform: 'TikTok LIVE',
          isSimulated: false
        });
      });

      this.tiktokConn.on(WebcastEvent.CHAT, (data) => {
        if (data.createTime && data.createTime * 1000 < connectedAt - 2000) return;
        const u = extractUser(data);
        const comment = String(data.content || data.comment || '').trim();
        if (!comment) return;
        const msgId = String(data.common?.msgId || `chat_${u.userId}_${Date.now()}`);
        this.handleChatEvent({
          eventId: msgId,
          userId: u.userId,
          username: u.nickname,
          handle: u.uniqueId,
          avatarUrl: u.avatarUrl,
          comment,
          platform: 'TikTok LIVE',
          isSimulated: false
        });
      });

      this.tiktokConn.on(WebcastEvent.FOLLOW, (data) => {
        if (data.createTime && data.createTime * 1000 < connectedAt - 2000) return;
        const u = extractUser(data);
        const msgId = String(data.common?.msgId || `follow_${u.userId}`);
        this.handleFollowEvent({
          eventId: msgId,
          userId: u.userId,
          username: u.nickname,
          handle: u.uniqueId,
          avatarUrl: u.avatarUrl,
          platform: 'TikTok LIVE'
        });
      });

      this.tiktokConn.on(WebcastEvent.LIKE, (data) => {
        if (data.createTime && data.createTime * 1000 < connectedAt - 2000) return;
        const u = extractUser(data);
        const count = Math.max(1, Number(data.count || data.likeCount || 1));
        this.handleLikeEvent({
          userId: u.userId,
          username: u.nickname,
          count,
          totalLikes: Number(data.total || 0)
        });
      });

      this.tiktokConn.on(WebcastEvent.STREAM_END, () => {
        this.addActivity('system', `El En Vivo de @${username} ha finalizado`, 'Pasando a Modo de Pruebas');
        this.setConnectionStatus('test_mode', {
          isRealConnection: false,
          modeLabel: 'MODO DE PRUEBAS (LIVE FINALIZADO)',
          lastError: 'La transmisión en vivo finalizó.'
        });
      });

      this.tiktokConn.on('disconnected', () => {
        this.connectionState.disconnectionsCount++;
        this.addActivity('error', `Desconexión detectada de @${username}`, 'Intentando reconexión en 10s...');
        this.setConnectionStatus('reconnecting', {
          isRealConnection: false,
          modeLabel: 'RECONECTANDO...',
          lastError: 'Conexión interrumpida, reintentando...'
        });
        this.scheduleReconnect(username);
      });

      this.tiktokConn.on('error', (err) => {
        this.addActivity('error', 'Aviso del conector TikTok', err?.message || 'Error de flujo');
      });

    } catch (err) {
      this.setConnectionStatus('test_mode', {
        username,
        isRealConnection: false,
        modeLabel: 'MODO DE PRUEBAS (SIN CONEXIÓN REAL)',
        lastError: `No se pudo conectar a @${username}: ${err?.message || 'Verifica que esté en vivo'}`
      });
      this.addActivity('error', `No se pudo conectar a @${username} (Activo en MODO DE PRUEBAS)`, err?.message || 'Reintentando en 15s');
      this.scheduleReconnect(username, 15000);
    }
  }

  scheduleReconnect(username, delayMs = 10000) {
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      if (this.connectionState.status === 'reconnecting' && username) {
        this.connectTikTok(username);
      }
    }, delayMs);
  }

  disconnectTikTok(resetToTestMode = true) {
    clearTimeout(this.reconnectTimer);
    if (this.tiktokConn) {
      try { this.tiktokConn.disconnect(); } catch (e) {}
      this.tiktokConn = null;
    }
    if (resetToTestMode) {
      this.setConnectionStatus('test_mode', {
        isRealConnection: false,
        modeLabel: 'MODO DE PRUEBAS',
        roomId: null,
        lastError: null
      });
      this.addActivity('system', 'Modo de Pruebas Activo', 'Conexión en directo desconectada manualmente');
    }
  }

  setConnectionStatus(status, extras = {}) {
    this.connectionState = {
      ...this.connectionState,
      status,
      ...extras
    };
    this.broadcastRadio({
      type: 'RADIO_CONNECTION_STATUS',
      connectionState: this.connectionState
    });
  }

  // Espejo opcional desde la conexión principal del servidor para evitar doble bloqueo de IP en TikTok
  onMainServerTikTokEvent(eventType, payload) {
    if (!this.data.config.mirrorMainTikTokConnection) return;
    if (this.tiktokConn && this.connectionState.isRealConnection) return; // Ya tiene su propia conexión dedicada activa

    if (eventType === 'STATUS') {
      if (payload.status === 'connected') {
        this.setConnectionStatus('connected', {
          username: payload.username,
          roomId: payload.roomId,
          isRealConnection: true,
          modeLabel: `CONECTADO EN VIVO (@${payload.username})`,
          lastError: null
        });
      } else if (payload.status !== 'connected' && this.connectionState.isRealConnection) {
        this.setConnectionStatus('test_mode', {
          isRealConnection: false,
          modeLabel: 'MODO DE PRUEBAS'
        });
      }
      return;
    }

    if (eventType === 'GIFT') {
      this.handleGiftEvent({
        eventId: payload.eventId || `mirror_gift_${payload.userId || payload.user}_${payload.giftName}_${payload.repeatCount}_${Math.floor(Date.now() / 1500)}`,
        userId: payload.userId || payload.handle || payload.user,
        username: payload.user,
        handle: payload.handle || '',
        avatarUrl: payload.avatarUrl || '',
        giftName: payload.giftName || 'Regalo',
        repeatCount: Number(payload.repeatCount) || 1,
        unitCoins: Number(payload.diamondCount) || 1,
        totalCoins: (Number(payload.diamondCount) || 1) * (Number(payload.repeatCount) || 1),
        platform: 'TikTok LIVE',
        isSimulated: false
      });
    } else if (eventType === 'CHAT') {
      this.handleChatEvent({
        eventId: payload.eventId || `mirror_chat_${payload.user}_${Date.now()}`,
        userId: payload.userId || payload.handle || payload.user,
        username: payload.user,
        handle: payload.handle || '',
        avatarUrl: payload.avatarUrl || '',
        comment: payload.comment,
        platform: 'TikTok LIVE',
        isSimulated: false
      });
    } else if (eventType === 'FOLLOW') {
      this.handleFollowEvent({
        eventId: `mirror_follow_${payload.user}_${Math.floor(Date.now() / 10000)}`,
        userId: payload.userId || payload.user,
        username: payload.user,
        handle: payload.handle || '',
        avatarUrl: payload.avatarUrl || '',
        platform: 'TikTok LIVE'
      });
    } else if (eventType === 'LIKE') {
      this.handleLikeEvent({
        userId: payload.userId || payload.user,
        username: payload.user,
        count: Number(payload.count) || 1,
        totalLikes: Number(payload.total) || 0
      });
    }
  }

  // ==========================================================================
  // 6. SISTEMA DE REGALOS Y CONTADOR ACUMULATIVO DE MONEDAS POR USUARIO
  // ==========================================================================
  handleGiftEvent(giftEvent) {
    const eventId = String(giftEvent.eventId || '');
    if (eventId && this.processedEventIds.has(eventId)) {
      return { duplicate: true };
    }
    if (eventId) {
      this.processedEventIds.add(eventId);
      if (this.processedEventIds.size > 2000) {
        const first = this.processedEventIds.values().next().value;
        this.processedEventIds.delete(first);
      }
    }

    const rawCoins = Number(giftEvent.totalCoins);
    if (!Number.isFinite(rawCoins) || rawCoins <= 0) {
      this.addActivity('error', `Regalo sin valor de monedas válido (${giftEvent.giftName})`, `Usuario: ${giftEvent.username || 'Anónimo'}`);
      return { invalidCoins: true };
    }

    const userKey = this.normalizeUserKey(giftEvent.userId || giftEvent.handle || giftEvent.username);
    const displayName = (giftEvent.username || 'Oyente').trim();

    if (!this.data.users[userKey]) {
      this.data.users[userKey] = {
        userKey,
        userId: giftEvent.userId || userKey,
        username: displayName,
        handle: giftEvent.handle || '',
        avatarUrl: giftEvent.avatarUrl || '',
        accumulatedCoinsForGreeting: 0,
        accumulatedCoinsForAdvance: 0,
        totalHistoricalCoins: 0,
        giftsCount: 0,
        greetingsTriggered: 0,
        lastGiftAt: null
      };
    }

    const userRecord = this.data.users[userKey];
    userRecord.username = displayName || userRecord.username;
    if (giftEvent.handle) userRecord.handle = giftEvent.handle;
    if (giftEvent.avatarUrl) userRecord.avatarUrl = giftEvent.avatarUrl;

    userRecord.accumulatedCoinsForGreeting += rawCoins;
    userRecord.accumulatedCoinsForAdvance = (userRecord.accumulatedCoinsForAdvance || 0) + rawCoins;
    userRecord.totalHistoricalCoins += rawCoins;
    userRecord.giftsCount += 1;
    userRecord.lastGiftAt = new Date().toISOString();

    this.data.stats.totalCoinsReceived += rawCoins;
    this.data.stats.totalGiftsReceived += 1;

    const giftLog = {
      eventId: eventId || 'gift_' + Date.now(),
      userId: userRecord.userId,
      username: userRecord.username,
      giftName: giftEvent.giftName || 'Regalo',
      repeatCount: Number(giftEvent.repeatCount) || 1,
      unitCoins: Number(giftEvent.unitCoins) || rawCoins,
      totalCoins: rawCoins,
      userAccumulatedBalance: userRecord.accumulatedCoinsForGreeting,
      userHistoricalTotal: userRecord.totalHistoricalCoins,
      timestamp: new Date().toISOString(),
      platform: giftEvent.platform || 'TikTok LIVE',
      isSimulated: Boolean(giftEvent.isSimulated)
    };

    this.data.giftHistory.unshift(giftLog);
    if (this.data.giftHistory.length > 150) {
      this.data.giftHistory = this.data.giftHistory.slice(0, 150);
    }

    const threshold = Math.max(1, Number(this.data.config.coins.greetingThreshold) || 10);

    this.addActivity(
      'gift',
      `🎁 ${userRecord.username} envió ${giftLog.giftName} (+${rawCoins} monedas)`,
      `Acumulado saludo: ${userRecord.accumulatedCoinsForGreeting}/${threshold} monedas • Histórico: ${userRecord.totalHistoricalCoins}`,
      giftLog
    );

    // 1. Verificar si el regalo activa el adelanto de canción en la cola (Sección 14)
    this.evaluarAdelantoPorRegalo(userRecord, giftLog);

    // 2. Verificar si el usuario alcanzó el umbral para saludo personalizado (Sección 6 y 7)
    if (this.data.config.greetings.enabled && userRecord.accumulatedCoinsForGreeting >= threshold) {
      const triggeredBalance = userRecord.accumulatedCoinsForGreeting;
      const carryOver = Boolean(this.data.config.coins.carryOverSurplus);

      if (carryOver) {
        // Conserva el excedente después de descontar el umbral de esta activación (ej: 25 monedas con umbral 10 -> conserva 15 monedas)
        userRecord.accumulatedCoinsForGreeting = Math.max(0, triggeredBalance - threshold);
      } else {
        // Reinicia el contador a 0 tras la activación
        userRecord.accumulatedCoinsForGreeting = 0;
      }

      userRecord.greetingsTriggered += 1;
      this.programarSaludoPorRegalo(userRecord, giftLog, triggeredBalance);
    }

    this.saveData();
    this.broadcastStateUpdate();
    return { success: true, userRecord, giftLog };
  }

  // ==========================================================================
  // 7. SISTEMA DE SALUDOS AUTOMÁTICOS Y PLANTILLAS
  // ==========================================================================
  generarTextoSaludo(userRecord, giftLog, triggeredCoins) {
    const style = this.data.config.greetings.style || 'urbano_dominicano';
    const templatesList = this.data.config.greetings.templates?.[style] || DEFAULT_GREETING_TEMPLATES.urbano_dominicano;
    const list = Array.isArray(templatesList) && templatesList.length > 0
      ? templatesList
      : DEFAULT_GREETING_TEMPLATES.urbano_dominicano;

    let idx = Math.floor(Math.random() * list.length);
    if (list.length > 1 && idx === this.lastGreetingTemplateIdx) {
      idx = (idx + 1) % list.length;
    }
    this.lastGreetingTemplateIdx = idx;

    const cleanUsername = this.cleanNameForSpeech(userRecord?.username);
    const giftName = giftLog?.giftName || 'su regalo';
    const giftValue = String(giftLog?.totalCoins || triggeredCoins || 10);
    const totalCoins = String(triggeredCoins || userRecord?.totalHistoricalCoins || 10);

    return list[idx]
      .replace(/\{username\}/gi, cleanUsername)
      .replace(/\{gift_name\}/gi, giftName)
      .replace(/\{gift_value\}/gi, giftValue)
      .replace(/\{total_coins\}/gi, totalCoins);
  }

  programarSaludoPorRegalo(userRecord, giftLog, triggeredCoins) {
    const text = this.generarTextoSaludo(userRecord, giftLog, triggeredCoins);
    const priority = Number(this.data.config.priorities.giftGreeting) || 3;

    // Verificar si se puede agrupar con otros saludos pendientes en la cola
    if (this.data.config.greetings.groupGreetings) {
      const pendingGreetings = this.interventionsQueue.filter(i => i.type === 'gift_greeting' && i.status === 'queued');
      const minGroup = Math.max(2, Number(this.data.config.greetings.groupThresholdCount) || 3);
      if (pendingGreetings.length >= minGroup - 1) {
        const names = [
          ...pendingGreetings.map(g => g.cleanUsername || this.cleanNameForSpeech(g.username)),
          this.cleanNameForSpeech(userRecord.username)
        ];
        const uniqueNames = [...new Set(names)];
        // Remover los individuales y reemplazar por saludo grupal
        this.interventionsQueue = this.interventionsQueue.filter(i => !(i.type === 'gift_greeting' && i.status === 'queued'));
        const listaNombres = uniqueNames.length > 1
          ? uniqueNames.slice(0, -1).join(', ') + ' y ' + uniqueNames[uniqueNames.length - 1]
          : uniqueNames[0];
        const groupText = `¡Atención mi gente en sintonía! Queremos enviar un saludo especial en cabina y agradecer a ${listaNombres} por apoyar nuestra emisora con sus regalos. ¡La radio sigue encendida para ustedes!`;

        this.enqueueIntervention({
          type: 'gift_greeting',
          priority,
          title: `🎙️ Saludo Grupal VIP (${uniqueNames.length} oyentes)`,
          username: uniqueNames.join(', '),
          cleanUsername: listaNombres,
          text: groupText,
          voice: this.data.config.voices.maleAnnouncerVoice
        });
        return;
      }
    }

    this.enqueueIntervention({
      type: 'gift_greeting',
      priority,
      title: `🎙️ Saludo por Regalo para @${userRecord.username}`,
      username: userRecord.username,
      cleanUsername: this.cleanNameForSpeech(userRecord.username),
      giftName: giftLog.giftName,
      coins: triggeredCoins,
      text,
      voice: this.data.config.voices.maleAnnouncerVoice
    });
  }

  handleFollowEvent(followInfo) {
    const eventId = String(followInfo.eventId || '');
    if (eventId && this.processedEventIds.has(eventId)) return;
    if (eventId) this.processedEventIds.add(eventId);

    this.data.stats.totalFollowersDetected += 1;
    const cleanName = this.cleanNameForSpeech(followInfo.username);
    this.addActivity('follow', `🌟 Nuevo seguidor: @${followInfo.username}`, 'Se unió a la audiencia de la emisora');

    if (this.data.config.greetings.enabled && this.data.config.greetings.followerGreetingEnabled) {
      const priority = Number(this.data.config.priorities.followerGreeting) || 4;
      this.enqueueIntervention({
        type: 'follower_greeting',
        priority,
        title: `🌟 Bienvenida a @${followInfo.username}`,
        username: followInfo.username,
        cleanUsername: cleanName,
        text: `¡Bienvenido a la sintonía, ${cleanName}! Gracias por seguir nuestra emisora en vivo.`,
        voice: this.data.config.voices.maleAnnouncerVoice
      });
    }
  }

  handleLikeEvent(likeInfo) {
    const count = Number(likeInfo.count) || 1;
    const prevTotal = this.data.stats.totalLikesReceived || 0;
    const newTotal = likeInfo.totalLikes && likeInfo.totalLikes > prevTotal + count
      ? likeInfo.totalLikes
      : prevTotal + count;
    this.data.stats.totalLikesReceived = newTotal;

    const step = Math.max(1000, Number(this.data.config.greetings.likesMilestoneStep) || 10000);
    if (Math.floor(newTotal / step) > Math.floor(prevTotal / step)) {
      const milestone = Math.floor(newTotal / step) * step;
      this.addActivity('system', `❤️ ¡Meta de ${milestone.toLocaleString()} Likes alcanzada!`, 'Agradecimiento en cabina programado');
      this.enqueueIntervention({
        type: 'likes_milestone',
        priority: Number(this.data.config.priorities.likesMilestone) || 5,
        title: `❤️ ¡${milestone.toLocaleString()} Likes en la Emisora!`,
        username: 'Comunidad',
        text: `¡Oye eso mi gente! Acabamos de superar los ${milestone} likes en la transmisión. ¡Gracias a todos por romper la pantalla con ese apoyo!`,
        voice: this.data.config.voices.maleAnnouncerVoice
      });
    }
  }

  // ==========================================================================
  // 9. MOTOR CENTRAL DE INTERVENCIONES (PRIORIDADES + CERO SOLAPAMIENTO)
  // ==========================================================================
  enqueueIntervention(item) {
    if (this.data.config.audio.emergencyStopActive) {
      return null;
    }

    const intervention = {
      id: 'int_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      type: item.type || 'admin_message',
      priority: Number(item.priority) || 3,
      title: item.title || 'Intervención de Cabina',
      username: item.username || 'Audiencia',
      cleanUsername: item.cleanUsername || this.cleanNameForSpeech(item.username || 'Audiencia'),
      text: item.text || '',
      voice: item.voice || this.data.config.voices.maleAnnouncerVoice,
      isCall: Boolean(item.isCall),
      callLines: Array.isArray(item.callLines) ? item.callLines : null,
      songMeta: item.songMeta || null,
      estimatedDurationSec: item.estimatedDurationSec || Math.max(4, Math.ceil((item.text || '').length / 14)),
      createdAt: new Date().toISOString(),
      status: 'queued'
    };

    this.interventionsQueue.push(intervention);
    // Ordenar por prioridad ascendente (1 = más urgente) y luego por orden de llegada
    this.interventionsQueue.sort((a, b) => {
      if (a.priority !== b.priority) return a.priority - b.priority;
      return new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime();
    });

    this.broadcastStateUpdate();
    this.processNextIntervention();
    return intervention;
  }

  processNextIntervention() {
    if (this.data.config.audio.emergencyStopActive) return;
    if (this.activeIntervention) return; // Nunca permitir que dos intervenciones o voces suenen al mismo tiempo
    if (this.interventionsQueue.length === 0) return;

    const minGapMs = Math.max(0, (Number(this.data.config.audio.minSecondsBetweenGreetings) || 3) * 1000);
    const elapsedSinceLast = Date.now() - this.lastInterventionEndedAt;
    const nextItem = this.interventionsQueue[0];

    // Las intervenciones manuales urgentes (Prioridad 1) no esperan enfriamiento
    if (nextItem.priority > 1 && elapsedSinceLast < minGapMs) {
      setTimeout(() => this.processNextIntervention(), minGapMs - elapsedSinceLast + 100);
      return;
    }

    this.activeIntervention = this.interventionsQueue.shift();
    this.activeIntervention.status = 'playing';
    this.activeIntervention.startedAt = Date.now();

    if (this.activeIntervention.isCall) {
      this.data.stats.totalCallsPlayed += 1;
      this.setRadioState('CALL_IN_PROGRESS');
      this.addActivity(
        'call',
        `📞 Llamada en Vivo: @${this.activeIntervention.username}`,
        this.activeIntervention.title
      );
    } else {
      if (this.activeIntervention.type === 'gift_greeting') {
        this.data.stats.totalGreetingsPlayed += 1;
      }
      this.setRadioState('ANNOUNCER_SPEAKING');
      this.addActivity(
        'greeting',
        this.activeIntervention.title,
        this.activeIntervention.text
      );
    }

    this.saveData();

    // Enviar orden al Director de Audio del cliente (Overlay / Panel) para:
    // 1. Atenuar música (Ducking) -> 2. Reproducir voz/diálogo -> 3. Notificar finalización -> 4. Restaurar volumen
    this.broadcastRadio({
      type: 'RADIO_PLAY_INTERVENTION',
      intervention: this.activeIntervention,
      audioConfig: this.data.config.audio,
      voicesConfig: this.data.config.voices,
      obsConfig: this.data.config.obsWebSocket
    });

    // Watchdog de seguridad por si el navegador se recarga a mitad de locución
    clearTimeout(this.interventionWatchdog);
    const timeoutMs = (this.activeIntervention.isCall ? 45000 : 28000);
    this.interventionWatchdog = setTimeout(() => {
      if (this.activeIntervention) {
        this.completeActiveIntervention(this.activeIntervention.id);
      }
    }, timeoutMs);
  }

  completeActiveIntervention(interventionId) {
    if (!this.activeIntervention) return;
    if (interventionId && this.activeIntervention.id !== interventionId) return;

    clearTimeout(this.interventionWatchdog);
    const finished = this.activeIntervention;
    this.activeIntervention = null;
    this.lastInterventionEndedAt = Date.now();

    this.setRadioState(this.data.currentSong ? 'PLAYING' : 'IDLE');
    this.broadcastRadio({
      type: 'RADIO_INTERVENTION_COMPLETED',
      interventionId: finished.id,
      radioState: this.radioState
    });
    this.broadcastStateUpdate();

    setTimeout(() => this.processNextIntervention(), 500);
  }

  triggerEmergencyStop() {
    clearTimeout(this.interventionWatchdog);
    this.data.config.audio.emergencyStopActive = true;
    this.interventionsQueue = [];
    this.activeIntervention = null;
    this.setRadioState(this.data.currentSong ? 'PLAYING' : 'IDLE');
    this.addActivity('error', '🚨 PARADA DE EMERGENCIA ACTIVADA', 'Intervenciones detenidas y control devuelto al operador.');
    this.broadcastRadio({
      type: 'RADIO_EMERGENCY_STOP',
      audioConfig: this.data.config.audio
    });
    this.broadcastStateUpdate();
  }

  resumeFromEmergencyStop() {
    this.data.config.audio.emergencyStopActive = false;
    this.addActivity('system', '✅ Motor de Intervenciones Reanudado', 'Las locuciones automáticas están nuevamente activas.');
    this.broadcastStateUpdate();
    this.processNextIntervention();
  }

  // ==========================================================================
  // 13. LLAMADAS FICTICIAS DRAMATIZADAS CON DOS VOCES (MASCULINA + FEMENINA)
  // ==========================================================================
  programarLlamadaFicticia({ username, songTitle, artistName, queuePosition, songsBefore, templateId, force = false }) {
    if (!force && !this.data.config.calls.enabled) return null;

    const prob = Number(this.data.config.calls.probabilityPct ?? 100);
    if (!force && Math.random() * 100 > prob) return null;

    const templates = this.data.config.calls.templates || DEFAULT_CALL_TEMPLATES;
    let chosenTemplate = templateId ? templates.find(t => t.id === templateId) : null;
    if (!chosenTemplate) {
      let idx = Math.floor(Math.random() * templates.length);
      if (templates.length > 1 && idx === this.lastCallTemplateIdx) {
        idx = (idx + 1) % templates.length;
      }
      this.lastCallTemplateIdx = idx;
      chosenTemplate = templates[idx] || DEFAULT_CALL_TEMPLATES[0];
    }

    const cleanUser = this.cleanNameForSpeech(username);
    const cleanSong = String(songTitle || 'su canción favorita').trim();
    const cleanArtist = String(artistName || 'su artista').trim();
    const posStr = String(queuePosition || 1);
    const beforeCount = Math.max(0, Number(songsBefore ?? (queuePosition ? queuePosition - 1 : 0)));
    const beforeStr = beforeCount === 0
      ? 'ninguna canción'
      : (beforeCount === 1 ? 'una canción' : `${beforeCount} canciones`);
    const advThreshold = String(this.data.config.advance.coinsThreshold || 20);

    const replaceVars = (txt) => String(txt || '')
      .replace(/\{username\}/gi, cleanUser)
      .replace(/\{song_title\}/gi, cleanSong)
      .replace(/\{artist_name\}/gi, cleanArtist)
      .replace(/\{queue_position\}/gi, posStr)
      .replace(/\{songs_before\}/gi, beforeStr)
      .replace(/\{gift_threshold\}/gi, advThreshold);

    const callLines = (chosenTemplate.lines || []).map((line, i) => ({
      index: i,
      speaker: line.speaker === 'F' ? 'F' : 'M',
      speakerLabel: line.speaker === 'F' ? 'Oyente en Línea' : 'Locutor en Cabina',
      voice: line.speaker === 'F'
        ? this.data.config.voices.femaleCallerVoice
        : this.data.config.voices.maleAnnouncerVoice,
      text: replaceVars(line.text)
    }));

    return this.enqueueIntervention({
      type: 'fictional_call',
      isCall: true,
      priority: Number(this.data.config.priorities.fictionalCall) || 2,
      title: `📞 Llamada al Aire: Petición de @${username}`,
      username: username || 'Oyente',
      cleanUsername: cleanUser,
      songMeta: { title: cleanSong, artist: cleanArtist, position: queuePosition, songsBefore: beforeCount },
      callLines,
      text: callLines.map(l => `${l.speaker === 'F' ? 'Oyente' : 'Locutor'}: ${l.text}`).join(' | '),
      estimatedDurationSec: callLines.length * 6 + 3
    });
  }

  // ==========================================================================
  // 10. BUSCADOR DE YOUTUBE (API OFICIAL + BUSCADOR DIRECTO + OEMBED)
  // ==========================================================================
  extraerVideoIdDeUrl(input) {
    if (!input) return null;
    const str = String(input).trim();
    if (/^[a-zA-Z0-9_-]{11}$/.test(str)) return str;
    const m = str.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/embed\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/i);
    return m ? m[1] : null;
  }

  fetchUrlText(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
          'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8'
        },
        timeout: 7000
      }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          return this.fetchUrlText(res.headers.location).then(resolve).catch(reject);
        }
        let body = '';
        res.on('data', chunk => {
          body += chunk.toString('utf8');
          if (body.length > 650000) res.destroy();
        });
        res.on('end', () => resolve(body));
      });
      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('Timeout consultando YouTube'));
      });
    });
  }

  async searchYouTube(query, expectedTitle = '', expectedArtist = '') {
    const cleanQuery = String(query || `${expectedTitle} ${expectedArtist}`).trim();
    if (!cleanQuery) return [];

    // 1. Si es un enlace directo o ID de YouTube, resolver por oEmbed oficial
    const directVideoId = this.extraerVideoIdDeUrl(cleanQuery);
    if (directVideoId) {
      try {
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(`https://www.youtube.com/watch?v=${directVideoId}`)}&format=json`;
        const rawJson = await this.fetchUrlText(oembedUrl);
        const info = JSON.parse(rawJson);
        return [{
          videoId: directVideoId,
          title: info.title || expectedTitle || 'Canción de YouTube',
          artist: info.author_name || expectedArtist || 'Canal Oficial',
          channelTitle: info.author_name || 'YouTube',
          url: `https://www.youtube.com/watch?v=${directVideoId}`,
          thumbnail: info.thumbnail_url || `https://i.ytimg.com/vi/${directVideoId}/hqdefault.jpg`,
          matchScore: 100,
          source: 'direct_oembed'
        }];
      } catch (e) {
        return [{
          videoId: directVideoId,
          title: expectedTitle || `Video YouTube (${directVideoId})`,
          artist: expectedArtist || 'YouTube',
          channelTitle: 'YouTube',
          url: `https://www.youtube.com/watch?v=${directVideoId}`,
          thumbnail: `https://i.ytimg.com/vi/${directVideoId}/hqdefault.jpg`,
          matchScore: 95,
          source: 'direct_id'
        }];
      }
    }

    const apiKey = (this.data.config.youtubeApiKey || process.env.YOUTUBE_API_KEY || '').trim();

    // 2. Si hay YouTube Data API v3 Key configurada, usar el endpoint oficial
    if (apiKey) {
      try {
        const apiUrl = `https://www.googleapis.com/youtube/v3/search?part=snippet&type=video&videoEmbeddable=true&maxResults=6&q=${encodeURIComponent(cleanQuery)}&key=${encodeURIComponent(apiKey)}`;
        const raw = await this.fetchUrlText(apiUrl);
        const parsed = JSON.parse(raw);
        if (Array.isArray(parsed.items) && parsed.items.length > 0) {
          return parsed.items.map(item => {
            const vid = item.id?.videoId;
            const title = item.snippet?.title || cleanQuery;
            const channelTitle = item.snippet?.channelTitle || expectedArtist || 'YouTube';
            return {
              videoId: vid,
              title,
              artist: expectedArtist || channelTitle,
              channelTitle,
              url: `https://www.youtube.com/watch?v=${vid}`,
              thumbnail: item.snippet?.thumbnails?.high?.url || item.snippet?.thumbnails?.default?.url || `https://i.ytimg.com/vi/${vid}/hqdefault.jpg`,
              matchScore: this.calcularCoincidenciaCancion(title, channelTitle, expectedTitle, expectedArtist),
              source: 'youtube_data_api_v3'
            };
          }).sort((a, b) => b.matchScore - a.matchScore);
        }
      } catch (apiErr) {
        console.warn('[RadioEngine] Error en YouTube Data API v3, usando buscador alternativo:', apiErr.message);
      }
    }

    // 3. Adaptador de búsqueda directa en YouTube (sin requerir API key) extrayendo ytInitialData
    try {
      const searchUrl = `https://www.youtube.com/results?search_query=${encodeURIComponent(cleanQuery)}&hl=es`;
      const html = await this.fetchUrlText(searchUrl);
      const results = [];
      const regex = /"videoRenderer":\{"videoId":"([a-zA-Z0-9_-]{11})".*?"title":\{"runs":\[\{"text":"([^"]+)"\}\].*?"ownerText":\{"runs":\[\{"text":"([^"]+)"/g;
      let match;
      const seen = new Set();
      while ((match = regex.exec(html)) !== null && results.length < 6) {
        const videoId = match[1];
        if (seen.has(videoId)) continue;
        seen.add(videoId);
        const title = match[2].replace(/\\u0026/g, '&').replace(/\\"/g, '"');
        const channelTitle = match[3].replace(/\\u0026/g, '&');
        results.push({
          videoId,
          title,
          artist: expectedArtist || channelTitle,
          channelTitle,
          url: `https://www.youtube.com/watch?v=${videoId}`,
          thumbnail: `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`,
          matchScore: this.calcularCoincidenciaCancion(title, channelTitle, expectedTitle, expectedArtist),
          source: 'youtube_web_search'
        });
      }

      if (results.length > 0) {
        return results.sort((a, b) => b.matchScore - a.matchScore);
      }
    } catch (scrapeErr) {
      console.warn('[RadioEngine] Error en búsqueda web de YouTube:', scrapeErr.message);
    }

    return [];
  }

  calcularCoincidenciaCancion(videoTitle, channelTitle, expectedTitle, expectedArtist) {
    const hay = `${videoTitle} ${channelTitle}`.toLowerCase();
    let score = 60;
    if (expectedTitle) {
      const words = expectedTitle.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const matched = words.filter(w => hay.includes(w)).length;
      if (words.length > 0) score += Math.round((matched / words.length) * 25);
    }
    if (expectedArtist) {
      const artWords = expectedArtist.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const matchedArt = artWords.filter(w => hay.includes(w)).length;
      if (artWords.length > 0) score += Math.round((matchedArt / artWords.length) * 15);
    }
    return Math.min(100, score);
  }

  // ==========================================================================
  // 11 & 12. COLA MUSICAL Y PETICIONES POR COMENTARIOS ("Ponme: canción + artista")
  // ==========================================================================
  parsearComandoPonme(comment) {
    if (!comment) return null;
    const text = String(comment).trim();

    // Formato principal: "Ponme: canción + artista" (también acepta "Ponme canción + artista" o separador " - ")
    const match = text.match(/^ponme\s*[:\-]?\s*(.+)$/i);
    if (!match) return null;

    const payload = match[1].trim();
    let songTitle = '';
    let artistName = '';

    if (payload.includes('+')) {
      const parts = payload.split('+').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        songTitle = parts[0];
        artistName = parts.slice(1).join(' ');
      }
    } else if (payload.includes(' - ')) {
      const parts = payload.split(' - ').map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        songTitle = parts[0];
        artistName = parts.slice(1).join(' ');
      }
    } else if (/\s+de\s+/i.test(payload)) {
      const parts = payload.split(/\s+de\s+/i).map(p => p.trim()).filter(Boolean);
      if (parts.length >= 2) {
        songTitle = parts[0];
        artistName = parts.slice(1).join(' ');
      }
    }

    if (!songTitle || !artistName) {
      return { incomplete: true, raw: payload };
    }

    return {
      incomplete: false,
      songTitle,
      artistName
    };
  }

  async handleChatEvent(chatEvent) {
    const comment = String(chatEvent.comment || '').trim();
    if (!comment) return;

    const parsed = this.parsearComandoPonme(comment);
    if (!parsed) return; // Comentario normal que no es comando de petición

    const username = (chatEvent.username || 'Oyente').trim();
    const userKey = this.normalizeUserKey(chatEvent.userId || chatEvent.handle || username);

    if (parsed.incomplete) {
      this.addActivity('error', `Formato incompleto de @${username}: "${comment}"`, 'Usa el formato: Ponme: Canción + Artista');
      return { error: 'Formato incompleto. Usa: Ponme: Canción + Artista' };
    }

    return await this.addSongRequest({
      songTitle: parsed.songTitle,
      artistName: parsed.artistName,
      requestedBy: username,
      userKey,
      method: 'comment_ponme'
    });
  }

  async addSongRequest({ songTitle, artistName, directUrl = '', requestedBy = 'Administrador', userKey = 'admin', method = 'manual_admin', skipRules = false }) {
    const reqCfg = this.data.config.requests;
    const cleanUserKey = this.normalizeUserKey(userKey || requestedBy);

    if (!skipRules) {
      // 1. Verificar usuarios bloqueados
      const blocked = (reqCfg.blockedUsers || []).map(u => this.normalizeUserKey(u));
      if (blocked.includes(cleanUserKey) || blocked.includes(this.normalizeUserKey(requestedBy))) {
        this.addActivity('error', `Petición rechazada: @${requestedBy} está en la lista de bloqueados`, `${songTitle} - ${artistName}`);
        return { rejected: true, reason: 'Usuario bloqueado' };
      }

      // 2. Verificar límite de solicitudes pendientes en la cola
      const pendingCount = this.data.queue.filter(s => ['Pendiente', 'Validando', 'Aprobada'].includes(s.status)).length;
      if (pendingCount >= (Number(reqCfg.maxPendingQueue) || 30)) {
        this.addActivity('error', `Cola llena (${pendingCount} pendientes)`, `No se pudo añadir petición de @${requestedBy}`);
        return { rejected: true, reason: 'Límite de solicitudes pendientes alcanzado' };
      }

      // 3. Verificar máximo de peticiones activas por usuario
      const userActiveCount = this.data.queue.filter(s => this.normalizeUserKey(s.requestedBy) === this.normalizeUserKey(requestedBy)).length;
      if (userActiveCount >= (Number(reqCfg.maxPerUser) || 3)) {
        this.addActivity('error', `Límite por usuario alcanzado (@${requestedBy})`, `Ya tiene ${userActiveCount} canciones en cola`);
        return { rejected: true, reason: 'Máximo de peticiones por usuario alcanzado' };
      }

      // 4. Verificar tiempo de espera (cooldown) entre peticiones
      const cooldownMs = (Number(reqCfg.cooldownSeconds) || 20) * 1000;
      const lastReqAt = this.userRequestCooldowns.get(cleanUserKey) || 0;
      if (Date.now() - lastReqAt < cooldownMs) {
        const waitSec = Math.ceil((cooldownMs - (Date.now() - lastReqAt)) / 1000);
        this.addActivity('error', `Petición muy rápida de @${requestedBy}`, `Debe esperar ${waitSec}s`);
        return { rejected: true, reason: `Espera ${waitSec}s antes de pedir otra canción` };
      }

      // 5. Verificar si requiere monedas previas
      if (reqCfg.requireCoins && Number(reqCfg.coinsCost) > 0) {
        const uRec = this.data.users[cleanUserKey];
        const totalCoins = uRec ? uRec.totalHistoricalCoins : 0;
        if (totalCoins < Number(reqCfg.coinsCost)) {
          this.addActivity('error', `@${requestedBy} requiere ${reqCfg.coinsCost} monedas para pedir canción`, `Tiene ${totalCoins} monedas`);
          return { rejected: true, reason: `Requiere ${reqCfg.coinsCost} monedas de apoyo` };
        }
      }

      this.userRequestCooldowns.set(cleanUserKey, Date.now());
    }

    this.data.stats.totalSongsRequested += 1;

    // Buscar coincidencias en YouTube
    const query = directUrl || `${songTitle} ${artistName}`;
    const candidates = await this.searchYouTube(query, songTitle, artistName);
    const best = candidates[0] || null;

    if (!best) {
      this.addActivity('error', `Sin resultados en YouTube para "${songTitle} + ${artistName}"`, `Solicitada por @${requestedBy}`);
      return { rejected: true, reason: 'No se encontraron vídeos compatibles en YouTube' };
    }

    // Verificar duplicados si no están permitidos
    if (!skipRules && !reqCfg.allowDuplicates) {
      const isDup = this.data.queue.some(s => s.videoId === best.videoId) ||
                    (this.data.currentSong && this.data.currentSong.videoId === best.videoId);
      if (isDup) {
        this.addActivity('error', `Canción duplicada omitida: "${best.title}"`, `Solicitada por @${requestedBy}`);
        return { rejected: true, reason: 'La canción ya está en la cola de reproducción' };
      }
    }

    const needsReview = Boolean(reqCfg.requireAdminApproval && !skipRules) || (best.matchScore < 65 && !skipRules);
    const initialStatus = needsReview ? 'Pendiente' : 'Aprobada';

    const songItem = {
      id: 'song_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6),
      title: songTitle || best.title,
      youtubeTitle: best.title,
      artist: artistName || best.artist,
      channel: best.channelTitle || 'YouTube',
      url: best.url,
      videoId: best.videoId,
      thumbnail: best.thumbnail,
      requestedBy,
      userKey: cleanUserKey,
      requestedAt: new Date().toISOString(),
      position: this.data.queue.length + 1,
      songsBefore: this.data.queue.length,
      status: initialStatus, // 'Pendiente' | 'Validando' | 'Aprobada' | 'Reproduciendo' | 'Completada' | 'Rechazada' | 'Error' | 'Cancelada'
      method,
      matchScore: best.matchScore,
      candidates: candidates.slice(0, 4)
    };

    this.data.queue.push(songItem);
    this.recalcularPosicionesCola();
    this.saveData();

    this.addActivity(
      'song',
      `🎵 Petición añadida (#${songItem.position}): "${songItem.title}" - ${songItem.artist}`,
      `Por @${requestedBy} • Estado: ${songItem.status} • Antes en fila: ${songItem.songsBefore}`
    );

    // Si las llamadas ficticias están activas para peticiones por comentario, programar la llamada a 2 voces
    if (method === 'comment_ponme' && this.data.config.calls.enabled && this.data.config.calls.triggerOnSongRequest) {
      this.programarLlamadaFicticia({
        username: requestedBy,
        songTitle: songItem.title,
        artistName: songItem.artist,
        queuePosition: songItem.position,
        songsBefore: songItem.songsBefore
      });
    }

    // Si no hay canción sonando actualmente y la cola no está pausada, iniciar reproducción automática
    if (!this.data.currentSong && !this.queuePaused && songItem.status === 'Aprobada') {
      this.playNextInQueue();
    } else {
      this.broadcastStateUpdate();
    }

    return { success: true, songItem };
  }

  recalcularPosicionesCola() {
    this.data.queue.forEach((item, index) => {
      item.position = index + 1;
      item.songsBefore = index;
    });
  }

  // ==========================================================================
  // 14. SISTEMA PARA ADELANTAR CANCIONES MEDIANTE REGALOS
  // ==========================================================================
  evaluarAdelantoPorRegalo(userRecord, giftLog) {
    const advCfg = this.data.config.advance;
    if (!advCfg || !advCfg.enabled) return;

    const threshold = Math.max(1, Number(advCfg.coinsThreshold) || 20);
    if ((userRecord.accumulatedCoinsForAdvance || 0) < threshold) return;

    // Buscar canciones pendientes/aprobadas de este usuario en la cola
    const userSongsIndices = [];
    this.data.queue.forEach((s, idx) => {
      if (
        this.normalizeUserKey(s.requestedBy) === userRecord.userKey ||
        s.userKey === userRecord.userKey
      ) {
        userSongsIndices.push(idx);
      }
    });

    if (userSongsIndices.length === 0) return;

    // Si tiene varias peticiones y la política es revisión administrativa, registrar aviso sin mover ambiguamente
    if (userSongsIndices.length > 1 && advCfg.ambiguousPolicy === 'review') {
      this.addActivity(
        'advance',
        `⚠️ @${userRecord.username} tiene ${userSongsIndices.length} canciones en cola y envió ${giftLog.totalCoins} monedas`,
        'Pendiente de confirmación en el panel para elegir cuál canción adelantar.'
      );
      return;
    }

    // Seleccionar la petición elegible que aún pueda subir posiciones
    const minAllowedIdx = advCfg.allowOvertakeFirst ? 0 : 1;
    const targetCurrentIdx = userSongsIndices.find(i => i > minAllowedIdx);
    if (targetCurrentIdx === undefined) return;

    const stepsEarned = Math.floor(userRecord.accumulatedCoinsForAdvance / threshold) * (Number(advCfg.positionsPerThreshold) || 1);
    const stepsToMove = Math.min(stepsEarned, Number(advCfg.maxPositionsAdvance) || 5);
    if (stepsToMove <= 0) return;

    userRecord.accumulatedCoinsForAdvance = userRecord.accumulatedCoinsForAdvance % threshold;

    const newIdx = Math.max(minAllowedIdx, targetCurrentIdx - stepsToMove);
    if (newIdx === targetCurrentIdx) return;

    const [movedSong] = this.data.queue.splice(targetCurrentIdx, 1);
    this.data.queue.splice(newIdx, 0, movedSong);
    this.recalcularPosicionesCola();
    this.saveData();

    const oldPos = targetCurrentIdx + 1;
    const newPos = newIdx + 1;

    this.addActivity(
      'advance',
      `🚀 ¡@${userRecord.username} adelantó "${movedSong.title}" del puesto #${oldPos} al #${newPos}!`,
      `Impulsado con ${giftLog.giftName} (${giftLog.totalCoins} monedas)`
    );

    this.enqueueIntervention({
      type: 'song_announcement',
      priority: Number(this.data.config.priorities.songAnnouncement) || 3,
      title: `🚀 Subida en la Lista: @${userRecord.username}`,
      username: userRecord.username,
      text: `¡Movimiento en la lista musical! Gracias a su apoyo, el tema ${movedSong.title} pedido por ${this.cleanNameForSpeech(userRecord.username)} sube hasta la posición número ${newPos} de la cola.`,
      voice: this.data.config.voices.maleAnnouncerVoice
    });
  }

  // ==========================================================================
  // CONTROL DE REPRODUCCIÓN DE LA COLA MUSICAL
  // ==========================================================================
  playNextInQueue() {
    if (this.queuePaused) return null;

    // Archivar canción actual si existía
    if (this.data.currentSong) {
      this.data.currentSong.status = 'Completada';
      this.data.currentSong.completedAt = new Date().toISOString();
      this.data.history.unshift(this.data.currentSong);
      if (this.data.history.length > 80) this.data.history = this.data.history.slice(0, 80);
      this.data.stats.totalSongsPlayed += 1;
      this.data.currentSong = null;
    }

    const nextIdx = this.data.queue.findIndex(s => s.status === 'Aprobada');
    if (nextIdx === -1) {
      this.recalcularPosicionesCola();
      this.saveData();
      if (!this.activeIntervention) this.setRadioState('IDLE');
      this.broadcastStateUpdate();
      return null;
    }

    const [nextSong] = this.data.queue.splice(nextIdx, 1);
    nextSong.status = 'Reproduciendo';
    nextSong.startedAt = new Date().toISOString();
    this.data.currentSong = nextSong;
    this.recalcularPosicionesCola();
    this.saveData();

    if (!this.activeIntervention) {
      this.setRadioState('PLAYING');
    }

    this.addActivity(
      'song',
      `▶ Reproduciendo ahora: "${nextSong.title}" - ${nextSong.artist}`,
      `Solicitada por @${nextSong.requestedBy}`
    );

    this.broadcastRadio({
      type: 'RADIO_LOAD_SONG',
      song: nextSong,
      audioConfig: this.data.config.audio
    });
    this.broadcastStateUpdate();
    return nextSong;
  }

  handleSongError(songId, reason = 'Vídeo restringido para inserción') {
    if (this.data.currentSong && (!songId || this.data.currentSong.id === songId)) {
      const failed = this.data.currentSong;
      failed.status = 'Error';
      failed.errorReason = reason;
      this.data.history.unshift(failed);
      this.data.currentSong = null;
      this.addActivity('error', `⚠️ Error reproduciendo "${failed.title}": ${reason}`, 'Saltando automáticamente a la siguiente canción aprobada');
      this.saveData();
      return this.playNextInQueue();
    }
    return null;
  }

  reorderQueue(songId, direction) {
    const idx = this.data.queue.findIndex(s => s.id === songId);
    if (idx === -1) return false;
    const targetIdx = idx + (direction === 'up' ? -1 : 1);
    if (targetIdx < 0 || targetIdx >= this.data.queue.length) return false;
    const [item] = this.data.queue.splice(idx, 1);
    this.data.queue.splice(targetIdx, 0, item);
    this.recalcularPosicionesCola();
    this.saveData();
    this.broadcastStateUpdate();
    return true;
  }

  updateSongStatus(songId, newStatus, candidateIdx = null) {
    const song = this.data.queue.find(s => s.id === songId);
    if (!song) return false;

    if (candidateIdx !== null && song.candidates && song.candidates[candidateIdx]) {
      const chosen = song.candidates[candidateIdx];
      song.youtubeTitle = chosen.title;
      song.videoId = chosen.videoId;
      song.url = chosen.url;
      song.thumbnail = chosen.thumbnail;
      song.channel = chosen.channelTitle;
    }

    if (newStatus === 'Rechazada' || newStatus === 'Cancelada') {
      this.data.queue = this.data.queue.filter(s => s.id !== songId);
      song.status = newStatus;
      this.data.history.unshift(song);
    } else {
      song.status = newStatus;
    }

    this.recalcularPosicionesCola();
    this.saveData();

    if (!this.data.currentSong && !this.queuePaused && newStatus === 'Aprobada') {
      this.playNextInQueue();
    } else {
      this.broadcastStateUpdate();
    }
    return true;
  }

  // ==========================================================================
  // PROGRAMADOR DE MENSAJES AUTOMÁTICOS DE LA EMISORA
  // ==========================================================================
  startScheduledMessagesTimer() {
    clearInterval(this.scheduledTimer);
    const intervalMin = Math.max(2, Number(this.data.config.scheduled?.intervalMinutes) || 8);
    this.scheduledTimer = setInterval(() => {
      if (!this.data.config.scheduled?.enabled) return;
      if (this.data.config.audio.emergencyStopActive) return;
      if (this.interventionsQueue.length > 0 || this.activeIntervention) return;

      const enabledMsgs = (this.data.config.scheduled.messages || []).filter(m => m && m.enabled && m.text);
      if (enabledMsgs.length === 0) return;

      const msgObj = enabledMsgs[this.scheduledIdx % enabledMsgs.length];
      this.scheduledIdx++;
      const threshold = String(this.data.config.coins.greetingThreshold || 10);
      const finalText = String(msgObj.text).replace(/\{gift_threshold\}/gi, threshold);

      this.enqueueIntervention({
        type: 'scheduled_message',
        priority: Number(this.data.config.priorities.scheduledMessage) || 5,
        title: '📻 Mensaje Programado de la Emisora',
        username: 'Cabina',
        text: finalText,
        voice: this.data.config.voices.maleAnnouncerVoice
      });
    }, intervalMin * 60 * 1000);
  }

  updateConfig(partialConfig) {
    if (!partialConfig || typeof partialConfig !== 'object') return;
    const c = this.data.config;
    this.data.config = {
      ...c,
      ...partialConfig,
      obsWebSocket: { ...c.obsWebSocket, ...(partialConfig.obsWebSocket || {}) },
      coins: { ...c.coins, ...(partialConfig.coins || {}) },
      greetings: {
        ...c.greetings,
        ...(partialConfig.greetings || {}),
        templates: { ...c.greetings.templates, ...(partialConfig.greetings?.templates || {}) }
      },
      audio: { ...c.audio, ...(partialConfig.audio || {}) },
      voices: { ...c.voices, ...(partialConfig.voices || {}) },
      calls: { ...c.calls, ...(partialConfig.calls || {}) },
      requests: { ...c.requests, ...(partialConfig.requests || {}) },
      advance: { ...c.advance, ...(partialConfig.advance || {}) },
      scheduled: { ...c.scheduled, ...(partialConfig.scheduled || {}) },
      priorities: { ...c.priorities, ...(partialConfig.priorities || {}) },
      overlayComponents: { ...c.overlayComponents, ...(partialConfig.overlayComponents || {}) }
    };
    this.saveData();
    this.startScheduledMessagesTimer();
    this.broadcastStateUpdate();
  }
}

module.exports = {
  RadioInteractiveEngine,
  DEFAULT_GREETING_TEMPLATES,
  DEFAULT_CALL_TEMPLATES
};
