# Cuatro Live Resolver

CLI pequeña y sin dependencias para obtener la URL HLS actual del directo de Cuatro, sin tener que dejar la web abierta en el navegador.

El script reproduce la misma cadena de servicios públicos que usa el reproductor web:

1. Lee la configuración actual del reproductor en directo desde `https://www.cuatro.com/en-directo/`.
2. Obtiene las ubicaciones de entrega de Caronte.
3. Recupera el valor GBX.
4. Solicita los tokens CDN a Cerbero.
5. Elige el mejor stream HLS sin DRM y, si quieres, lanza un reproductor externo.

## Uso

```bash
node ./cuatro-live.mjs --print
node ./cuatro-live.mjs --player vlc
node ./cuatro-live.mjs --player mpv
node ./cuatro-live.mjs --serve
node ./cuatro-live.mjs --quality 720 --player mpv
node ./cuatro-live.mjs --quality 1080 --player mpv
node ./cuatro-live.mjs --list
node ./cuatro-live.mjs --prefer fastly --player ffplay
node ./cuatro-live.mjs --lgs --print
```

Scripts de npm disponibles:

```bash
npm run resolve
npm run inspect
npm run list
npm run serve
npm run play:vlc
npm run play:mpv
npm run play:ffplay
```

Por defecto, el resolver prioriza streams HLS lineales en HD y sin lengua de signos. Si la playlist elegida no se puede verificar, prueba automáticamente otros candidatos de CDN y calidad.

Puedes usar `--quality best`, `--quality 720`, `--quality 576` o `--quality audio` para forzar la variante servida a través del proxy local. También existe `--quality 1080`, pero fallará de forma explícita si las playlists actuales no publican una variante 1080p.

`--list` muestra todos los candidatos de entrega verificados junto con las variantes anunciadas por su playlist maestra. También puedes usar `--platform <name>` para probar rutas alternativas de plataforma de Mediaset, por ejemplo:

```bash
node ./cuatro-live.mjs --platform ctv --list
```

`--player` y `--serve` usan un proxy local de playlists. Esto es necesario porque tanto la playlist maestra de Cuatro como las playlists internas de cada variante requieren el mismo sufijo de token CDN de corta duración. El proxy reescribe las URLs para que reproductores externos como VLC, mpv o ffplay no tengan que conocer los detalles internos del reproductor web.

El proxy refresca automáticamente los tokens de Cerbero/CDN antes de que caduquen cuando puede leer su expiración. Si no puede, los renueva periódicamente como medida de seguridad y también lo intenta de nuevo justo después de recibir respuestas `401/403` del servidor upstream.

Los manifiestos actuales de Fastly pueden incluir URLs de playlists hijas con tokens propios. En ese caso, el proxy elimina esos tokens de las URLs locales y guarda en el servidor el token upstream correspondiente, evitando que el reproductor conserve URLs hijas tokenizadas que puedan caducar.

Si la reproducción empieza a devolver EOF después de tener un proxy antiguo ejecutándose durante un buen rato, reinícialo usando la versión actual del script.

## Notas

* Las URLs tokenizadas tienen una duración corta.
* Las URLs de playlist devueltas directamente por la respuesta de entrega pueden devolver `403`; es normal hasta que se añade el sufijo de token de Cerbero.
* El script no evita DRM ni bloqueos geográficos. Si Cerbero rechaza la solicitud, el error se muestra por pantalla y el script se detiene.
