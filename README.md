# 📻 RADIO LIVE INTERACTIVA + SLOW MD STREAM BOT

Sistema dual para transmisiones en directo en **TikTok LIVE**, compatible con **OBS Studio** y **Meld Studio**. Incluye dos sistemas totalmente independientes en el mismo servidor:

1. **Overlay 1 (Reacción Musical Slow MD — Original)**:
   - Panel de Control: `http://localhost:3000/?view=panel`
   - Overlay Transparente OBS / Meld: `http://localhost:3000/?view=overlay`

2. **Overlay 2 (RADIO LIVE INTERACTIVA — Emisora Automatizada con 2 Voces)**:
   - Panel Administrativo de Cabina: `http://localhost:3000/radio`
   - Overlay Público de Radio (OBS / Meld Studio): `http://localhost:3000/radio-overlay`

---

## 🚀 Instalación y Ejecución

1. **Requisitos**: Node.js 18+ instalado.
2. **Instalar dependencias**:
   ```bash
   npm install
   ```
3. **Configurar variables de entorno (Opcional)**:
   Copia `.env.example` a `.env` si deseas preconfigurar `YOUTUBE_API_KEY` o `OBS_WS_URL`.
4. **Iniciar el servidor**:
   ```bash
   npm start
   ```

---

## 🏗️ Arquitectura Modular de RADIO LIVE INTERACTIVA

- **`radio-engine.js` (Backend & Motor Central)**:
  - **Conector TikTok LIVE (`tiktok-live-connector`)**: Procesa regalos, monedas, seguidores, likes y comentarios en tiempo real con deduplicación idempotente por `eventId` y cierre de rachas (`repeatEnd`). Si no hay conexión activa, opera explícitamente en **`MODO DE PRUEBAS`**.
  - **Sistema Acumulativo de Monedas por Usuario**: Registra cada regalo individualmente, acumula monedas por usuario (umbral inicial: `10` monedas, configurable `10–20` o personalizado) y conserva el excedente (`carryOverSurplus`) para futuras activaciones.
  - **Saludos Personalizados**: 5 estilos configurables (*Locutor urbano dominicano*, *Radio romántica*, *Radio humorística*, *Radio juvenil*, *Locutor profesional*) con plantillas aleatorias sin repetición inmediata y variables `{username}`, `{gift_name}`, `{gift_value}`, `{total_coins}`.
  - **Motor Central de Intervenciones**: Cola única con prioridades configurables (1 a 5), agrupación inteligente de saludos y **Parada de Emergencia** que devuelve el control inmediato al operador.
  - **Llamadas Ficticias a 2 Voces**: Diálogos dramatizados secuenciales entre **Voz A (Locutor Masculino Neural HD)** y **Voz B (Oyente Femenina Neural HD)** con variables `{username}`, `{song_title}`, `{artist_name}`, `{queue_position}`, `{songs_before}`, `{gift_threshold}`.
  - **Buscador de YouTube y Cola Musical**: Soporta **YouTube Data API v3**, búsqueda web directa y resolución **oEmbed** oficial. Peticiones por comentario mediante `Ponme: canción + artista` y subida de posiciones mediante regalos.
- **`radio-live.html` (Frontend: Overlay `/radio-overlay` + Panel `/radio`)**:
  - **Director de Audio**: Controla el reproductor oficial **YouTube IFrame Player API** y opcionalmente fuentes externas mediante **OBS WebSocket v5** (`ws://127.0.0.1:4455`), aplicando fundido gradual de bajada (*ducking*, ej. `80% -> 20%` en `500ms`) antes de cada locución/llamada y restaurando el volumen original (`800ms`) al finalizar.

---

## ⚠️ Limitaciones Documentadas y Consideraciones Técnicas

1. **YouTube Reproducción y Derechos de Autor**:
   - YouTube Data API permite buscar metadatos pero no extrae flujos de audio crudos. Por cumplimiento con los términos de servicio de YouTube, la reproducción se realiza mediante el **YouTube IFrame Player API** oficial. Si un vídeo tiene restringida su inserción por el propietario, el sistema detecta el código de error automáticamente y salta a la siguiente canción aprobada.
2. **Control de Audio en OBS / Ordenador Local**:
   - Una página web alojada en la nube no puede modificar el mezclador del sistema operativo directamente. El control automático de volumen (*ducking*) actúa directamente sobre el reproductor integrado y, si deseas atenuar una fuente independiente de OBS Studio en tu PC, puedes conectar el adaptador **OBS WebSocket v5** local (`ws://127.0.0.1:4455`) incluido en el panel.
3. **Eventos de TikTok LIVE**:
   - La recepción de eventos sin credenciales privadas utiliza `tiktok-live-connector` (Webcast público). Si TikTok aplica límites temporales de conexión por IP, puedes usar el modo espejo automático desde la conexión principal o el **Modo de Pruebas** incluido.
