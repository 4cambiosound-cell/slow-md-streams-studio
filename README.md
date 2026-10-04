# ⚡ Slow MD Stream Studio

Suite multiversal de widgets y bots interactivos para transmisiones en vivo de **TikTok Live**, compatible con **Meld Studio**, **OBS Studio** y cualquier software de streaming.

---

## 🚀 Widgets Incluidos

### 1. 🎵 Cola de Canciones Interactiva (`/cola-slow-md.html`)
- **Overlay Transparente**: Diseñado para colocarse sobre tu stream sin tapar el juego o tu cámara. Letras blancas en mayúsculas estilo minimalista.
- **Detección Flexible en Chat**: `Escucha [canción]`, `(canción)` o `cancion - artista`.
- **Desbloqueo por Metas**: 1000 Likes ❤️, 10 Compartidos 🔄 o 5 Rosas 🌹.
- **Prioridad VIP**: Donadores de Rosquillas 🍩 o Sombreros 🎩 suben directamente a los primeros puestos.
- **Nombres de Chat Reales**: Muestra el nickname con el que el usuario escribe en vivo.

### 2. ⏳ Próximos Widgets en Desarrollo
- 🎡 **Ruleta de Retos**: Gira con regalos y aplica castigos/retos en pantalla.
- 🎯 **Barra de Metas**: Progreso en vivo de likes y rosas para motivar a la comunidad.
- 💥 **Alertas Especiales**: Notificaciones sonoras y animadas en vivo.
- 👑 **Podio de Top Donadores**: Reconocimiento a los mayores contribuyentes del stream.

---

## 🌐 URLs de Uso (En Local o en la Nube)

| Vista | URL Local | URL en Render (Nube) | Uso |
| :--- | :--- | :--- | :--- |
| **Studio Hub Central** | `http://localhost:3000/` | `https://tu-app.onrender.com/` | Panel maestro para cambiar entre widgets |
| **Panel de Control Cola** | `http://localhost:3000/?view=panel` | `https://tu-app.onrender.com/?view=panel` | Para que el streamer gestione canciones |
| **Overlay para OBS / Meld** | `http://localhost:3000/?view=overlay` | `https://tu-app.onrender.com/?view=overlay` | **Fuente de Navegador en tu programa de stream** |

---

## ☁️ Despliegue en Render (Gratuito y Permanente)

1. Sube este repositorio a tu cuenta de **GitHub**.
2. En [Render.com](https://render.com), crea un **New Web Service**.
3. Selecciona tu repositorio de GitHub.
4. Ajustes:
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: `Free`
5. ¡Listo! Copia tu enlace de Render y ponlo directamente en Meld Studio u OBS.
