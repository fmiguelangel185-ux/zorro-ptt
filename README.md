# ZORRO PTT

PTT web half-duplex para dos usuarios. El servidor Node.js maneja login, WebSocket y bloqueo del canal; WebRTC transporta el audio entre navegadores.

## Archivos

- `server.js`: servidor Express + WebSocket y arbitraje del canal.
- `public/index.html`: interfaz.
- `public/style.css`: diseño móvil centrado.
- `public/app.js`: WebRTC, micrófono y PTT.
- `render.yaml`: configuración opcional de Render Blueprint.

## Ejecutar localmente

1. Instala Node.js 20 o superior.
2. Abre una terminal en esta carpeta.
3. Instala dependencias:
   `npm install`
4. Define una contraseña y ejecuta:
   - macOS/Linux: `PTT_PASSWORD="tu-clave" npm start`
   - Windows PowerShell: `$env:PTT_PASSWORD="tu-clave"; npm start`
5. Abre `http://localhost:10000`.

Nota: el micrófono del navegador requiere un contexto seguro (HTTPS) salvo en localhost. En Render tendrás HTTPS.

## Subir a Render

1. Sube esta carpeta a un repositorio de GitHub.
2. En Render crea un **Web Service**, no un Static Site.
3. Conecta el repositorio.
4. Build Command: `npm install`
5. Start Command: `npm start`
6. En Environment agrega `PTT_PASSWORD` con la contraseña que quieras usar.
7. Despliega.
8. En Settings > Custom Domains agrega `zorro-ptt.com` y sigue los registros DNS que Render te indique.

También puedes usar el `render.yaml` como Blueprint.

## TURN (recomendado para máxima compatibilidad)

El proyecto ya usa servidores STUN públicos. Para conexiones en redes móviles, CGNAT, Wi-Fi corporativo o NAT restrictivo, añade un servicio TURN y configura en Render:

- `TURN_URL` (puede contener varias URLs separadas por coma, por ejemplo `turn:...:3478,turns:...:5349`)
- `TURN_USERNAME`
- `TURN_CREDENTIAL`

Si no configuras TURN, el sistema seguirá intentando conectar con STUN, pero algunas combinaciones de redes pueden impedir el audio P2P.

## Comportamiento

- Máximo 2 conexiones simultáneas.
- Verde: canal libre.
- Rojo: tú estás transmitiendo.
- Gris: el otro transmite o todavía no hay segundo usuario.
- El micrófono se habilita solamente después de que el servidor concede el PTT y mientras mantienes pulsado.
- Al soltar, salir de la pestaña o perder foco, se libera el PTT.
