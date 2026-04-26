/**
 * AnimeHub — Video Resolver Proxy
 * Node.js / Express
 *
 * Endpoints:
 *   GET  /              → health check (para el cron-job de Render)
 *   GET  /resolve?url=  → resolver principal (devuelve JSON con sources o HTML)
 *   GET  /player?url=   → página HTML con reproductor listo para poner en iframe
 *   GET  /proxy?url=    → proxy directo de stream (para evitar CORS en .m3u8)
 */

const express      = require('express');
const cors         = require('cors');
const rateLimit    = require('express-rate-limit');
const NodeCache    = require('node-cache');
const axios        = require('axios');
const cheerio      = require('cheerio');
const { URL }      = require('url');

const app   = express();
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 }); // 1h TTL

// ─────────────────────────────────────────────────────────
//  CONFIG
// ─────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;

// User-agents rotativos — evita detección como bot
const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
];
const randUA = () => USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];

// Headers base que simulan un navegador real
const browserHeaders = (referer = 'https://www3.animeflv.net/') => ({
  'User-Agent':      randUA(),
  'Accept':          'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
  'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8',
  'Accept-Encoding': 'gzip, deflate, br',
  'Referer':         referer,
  'DNT':             '1',
  'Connection':      'keep-alive',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':  'document',
  'Sec-Fetch-Mode':  'navigate',
  'Sec-Fetch-Site':  'cross-site',
});

// Axios instance con timeout y headers
const http = axios.create({
  timeout: 18000,
  maxRedirects: 5,
  validateStatus: s => s < 500,
});

// ─────────────────────────────────────────────────────────
//  MIDDLEWARE
// ─────────────────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());

// Rate limiting — protege el servidor en Render (free tier)
app.use('/resolve', rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true }));
app.use('/player',  rateLimit({ windowMs: 60_000, max: 60, standardHeaders: true }));
app.use('/proxy',   rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true }));

// ─────────────────────────────────────────────────────────
//  HEALTH CHECK
// ─────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({
    ok:      true,
    service: 'AnimeHub Resolver v1',
    cache:   cache.getStats(),
    time:    new Date().toISOString(),
    methods: ['direct_extract', 'referer_proxy', 'iframe_wrapper'],
  });
});

// ─────────────────────────────────────────────────────────
//  HELPERS — extracción de URLs de video
// ─────────────────────────────────────────────────────────

/** Busca .m3u8 y .mp4 en texto HTML/JS con regex */
function extractFromText(text) {
  const sources = [];
  const seen    = new Set();

  // m3u8
  const m3u8 = [...text.matchAll(/https?:\/\/[^\s"'<>]+\.m3u8[^\s"'<>]*/g)];
  for (const m of m3u8) {
    if (!seen.has(m[0])) { seen.add(m[0]); sources.push({ url: m[0], type: 'hls', quality: 'auto' }); }
  }
  // mp4
  const mp4 = [...text.matchAll(/https?:\/\/[^\s"'<>]+\.mp4[^\s"'<>]*/g)];
  for (const m of mp4) {
    if (!seen.has(m[0])) { seen.add(m[0]); sources.push({ url: m[0], type: 'mp4', quality: 'auto' }); }
  }
  // JWPlayer / Video.js sources array
  const jwMatch = text.match(/sources\s*:\s*(\[[\s\S]*?\])/);
  if (jwMatch) {
    try {
      const arr = JSON.parse(jwMatch[1]);
      for (const s of arr) {
        const u = s.file || s.src || s.url || '';
        if (u && !seen.has(u)) {
          seen.add(u);
          sources.push({ url: u, type: u.includes('.m3u8') ? 'hls' : 'mp4', quality: s.label || s.quality || 'auto' });
        }
      }
    } catch (_) {}
  }
  // setup({ file: "..." })
  const fileMatch = text.match(/['"](https?:\/\/[^'"]+\.(m3u8|mp4)[^'"]*)['"]/g);
  if (fileMatch) {
    for (const m of fileMatch) {
      const u = m.replace(/['"]/g, '');
      if (!seen.has(u)) {
        seen.add(u);
        sources.push({ url: u, type: u.includes('.m3u8') ? 'hls' : 'mp4', quality: 'auto' });
      }
    }
  }
  return sources;
}

/** Decodifica Base64 si la cadena no es una URL */
function tryDecodeB64(raw) {
  if (!raw || raw.startsWith('http')) return raw;
  try {
    const decoded = Buffer.from(raw + '==', 'base64').toString('utf-8');
    if (decoded.startsWith('http')) return decoded;
  } catch (_) {}
  return raw;
}

// ─────────────────────────────────────────────────────────
//  HANDLERS POR PROVEEDOR
//  Cada handler recibe la URL y devuelve [{url, type, quality}]
//  o null si falla.
// ─────────────────────────────────────────────────────────

const handlers = {};

/** Fembed / Filemoon — POST a /api/source/{id} */
handlers.fembed = async (url) => {
  const html = await fetchPage(url);
  const fromHtml = extractFromText(html);
  if (fromHtml.length) return fromHtml;

  const vid = url.split('/').pop().split('?')[0];
  const host = new URL(url).hostname;
  try {
    const { data } = await http.post(
      `https://${host}/api/source/${vid}`,
      new URLSearchParams({ r: '', d: host }).toString(),
      { headers: { ...browserHeaders(url), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (data.success && Array.isArray(data.data)) {
      return data.data.map(s => ({
        url:     s.file,
        type:    s.file.includes('.mp4') ? 'mp4' : 'hls',
        quality: s.label || 'auto',
      }));
    }
  } catch (_) {}
  return null;
};

/** StreamWish / WishEmbed — busca m3u8 en HTML + decodifica atob si necesario */
handlers.streamwish = async (url) => {
  const html = await fetchPage(url);
  const direct = extractFromText(html);
  if (direct.length) return direct;

  // Buscar cadenas atob() y decodificarlas
  const atobMatches = [...html.matchAll(/atob\(['"]([A-Za-z0-9+/=]{20,})['"]\)/g)];
  for (const m of atobMatches) {
    try {
      const decoded = Buffer.from(m[1], 'base64').toString('utf-8');
      const sources = extractFromText(decoded);
      if (sources.length) return sources;
    } catch (_) {}
  }
  return null;
};

/** StreamTape — reconstruye URL desde fragmentos JS */
handlers.streamtape = async (url) => {
  const html = await fetchPage(url);

  // Patrón clásico StreamTape
  const innerMatch = html.match(/innerHTML\s*=\s*['"](https?:\/\/[^'"]+)['"]/);
  if (innerMatch) return [{ url: innerMatch[1], type: 'mp4', quality: 'auto' }];

  // Patrón 2: concatenación de dos strings
  const part1 = html.match(/['"]\/\/[^'"]+['"]\s*\+\s*['"]/);
  const part2 = html.match(/\+\s*['"]([^'"]+)['"]/);
  if (part1 && part2) {
    const base = part1[0].replace(/['"]/g, '').replace(/\+\s*$/, '').trim();
    const url2 = 'https:' + base + part2[1];
    return [{ url: url2, type: 'mp4', quality: 'auto' }];
  }

  return extractFromText(html) || null;
};

/** Okru (ok.ru) — extrae de metadata JSON */
handlers.okru = async (url) => {
  // ok.ru usa una API pública para obtener el metadata del video
  const videoId = url.match(/\/video\/(\d+)/)?.[1];
  if (!videoId) return null;

  try {
    const { data } = await http.get(
      `https://ok.ru/api/v1/tv/startupVideo?tid=${videoId}&mobile=false`,
      { headers: browserHeaders(url) }
    );
    const html = await fetchPage(`https://ok.ru/videoembed/${videoId}`);
    const sources = extractFromText(html);
    if (sources.length) return sources;

    // Intentar desde la página principal del video
    const mainHtml = await fetchPage(url);
    return extractFromText(mainHtml) || null;
  } catch (_) {}
  return null;
};

/** Mega.nz — no se puede scrapear directamente (cifrado client-side) */
handlers.mega = async (url) => {
  // Mega usa cifrado AES en el cliente, imposible extraer sin JS real.
  // Devolvemos null para que caiga al método 3 (iframe wrapper).
  return null;
};

/** Vidoza — extrae source de la página */
handlers.vidoza = async (url) => {
  const html = await fetchPage(url);
  // Vidoza pone el mp4 en un tag <source src="...">
  const $ = cheerio.load(html);
  const src = $('source').attr('src') || $('video').attr('src');
  if (src) return [{ url: src, type: 'mp4', quality: 'auto' }];
  return extractFromText(html) || null;
};

/** Handler genérico — intenta regex en el HTML */
handlers.generic = async (url) => {
  const html = await fetchPage(url);
  return extractFromText(html) || null;
};

/** Detecta qué handler usar según la URL */
function detectHandler(url) {
  const u = url.toLowerCase();
  if (/fembed|filemoon|fplayer|moon\.cm/.test(u)) return handlers.fembed;
  if (/streamwish|swdyu|wishembed|swish/.test(u))  return handlers.streamwish;
  if (/streamtape|stape/.test(u))                  return handlers.streamtape;
  if (/ok\.ru|okru/.test(u))                       return handlers.okru;
  if (/mega\.nz/.test(u))                          return handlers.mega;
  if (/vidoza/.test(u))                            return handlers.vidoza;
  return handlers.generic;
}

/** Fetch de una página con headers de navegador */
async function fetchPage(url, extraHeaders = {}) {
  const referer = (() => {
    try { return new URL(url).origin + '/'; } catch { return 'https://www3.animeflv.net/'; }
  })();
  const { data } = await http.get(url, {
    headers: { ...browserHeaders(referer), ...extraHeaders },
    responseType: 'text',
  });
  return data || '';
}

// ─────────────────────────────────────────────────────────
//  MÉTODO 1 — Scraper de enlace directo
// ─────────────────────────────────────────────────────────
async function method1_directExtract(url) {
  const handler = detectHandler(url);
  const sources = await handler(url);
  if (sources && sources.length > 0) {
    return { method: 'direct', sources };
  }
  return null;
}

// ─────────────────────────────────────────────────────────
//  MÉTODO 2 — Proxy de Referer
//  Sirve la página del proveedor pero inyectando el Referer
//  correcto para que no bloquee la carga.
// ─────────────────────────────────────────────────────────
async function method2_refererProxy(url) {
  // Para este método devolvemos una URL especial /proxy-page?url=...
  // que el frontend cargará en el iframe. La ruta /proxy-page
  // sirve la página del proveedor con los headers correctos.
  return {
    method:   'referer_proxy',
    proxyUrl: `/proxy-page?url=${encodeURIComponent(url)}`,
    original: url,
  };
}

// ─────────────────────────────────────────────────────────
//  MÉTODO 3 — Iframe wrapper con anti-popups
// ─────────────────────────────────────────────────────────
function method3_iframeWrapper(url) {
  return {
    method:  'iframe_wrapper',
    iframeUrl: url,
    // Devolver la URL del endpoint /player que sirve el HTML con anti-popup
    playerUrl: `/player?url=${encodeURIComponent(url)}`,
  };
}

// ─────────────────────────────────────────────────────────
//  ENDPOINT /resolve — Orquestador principal
// ─────────────────────────────────────────────────────────
app.get('/resolve', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta el parámetro ?url=' });

  // Validar que sea una URL
  try { new URL(url); } catch {
    return res.status(400).json({ error: 'URL inválida' });
  }

  // Revisar caché
  const cacheKey = `resolve:${url}`;
  const cached = cache.get(cacheKey);
  if (cached) return res.json({ ...cached, cached: true });

  const result = { url };

  // ── Método 1: extracción directa ──────────────────────
  try {
    const m1 = await method1_directExtract(url);
    if (m1) {
      const payload = { ...m1, url, cached: false };
      cache.set(cacheKey, payload);
      return res.json(payload);
    }
  } catch (e) {
    console.warn('[M1] Error:', e.message);
  }

  // ── Método 2: proxy de referer ────────────────────────
  try {
    const m2 = await method2_refererProxy(url);
    const payload = { ...m2, url, cached: false };
    cache.set(cacheKey, payload, 1800); // 30 min para proxy
    return res.json(payload);
  } catch (e) {
    console.warn('[M2] Error:', e.message);
  }

  // ── Método 3: iframe wrapper (siempre funciona) ────────
  const m3 = method3_iframeWrapper(url);
  return res.json({ ...m3, url, cached: false });
});

// ─────────────────────────────────────────────────────────
//  ENDPOINT /player — HTML del reproductor con anti-popup
//  El frontend lo puede cargar en un iframe:
//  <iframe src="https://TU-API.onrender.com/player?url=...">
// ─────────────────────────────────────────────────────────
app.get('/player', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Falta ?url=');

  // Intentar extraer fuentes directas primero
  let sources = null;
  try {
    const m1 = await method1_directExtract(url);
    if (m1) sources = m1.sources;
  } catch (_) {}

  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  // Importante: NO poner X-Frame-Options para que el frontend pueda
  // meter este /player en un iframe
  res.setHeader('X-Frame-Options', 'ALLOWALL');
  res.setHeader('Content-Security-Policy', "frame-ancestors *");

  if (sources && sources.length > 0) {
    // ── Reproductor nativo con Video.js ──
    res.send(buildNativePlayerHTML(sources));
  } else {
    // ── Iframe del proveedor con anti-popup ──
    res.send(buildIframeWrapperHTML(url));
  }
});

// ─────────────────────────────────────────────────────────
//  ENDPOINT /proxy-page — Sirve la página del proveedor
//  con los headers correctos para evitar bloqueos
// ─────────────────────────────────────────────────────────
app.get('/proxy-page', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Falta ?url=');

  try {
    const referer = (() => {
      try { return new URL(url).origin + '/'; } catch { return 'https://www3.animeflv.net/'; }
    })();

    const response = await http.get(url, {
      headers: {
        ...browserHeaders(referer),
        'Sec-Fetch-Dest': 'iframe',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'cross-site',
      },
      responseType: 'text',
    });

    // Inyectar script anti-popup en el HTML devuelto
    let html = response.data || '';
    html = injectAntiPopup(html);

    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('X-Frame-Options', 'ALLOWALL');
    res.setHeader('Content-Security-Policy', "frame-ancestors *");
    res.send(html);
  } catch (e) {
    // Si el proxy falla, redirigir al wrapper de iframe
    res.redirect(`/player?url=${encodeURIComponent(url)}`);
  }
});

// ─────────────────────────────────────────────────────────
//  ENDPOINT /proxy — Proxy de stream (para .m3u8 con CORS)
//  El frontend puede usarlo para cargar el stream en HLS.js
// ─────────────────────────────────────────────────────────
app.get('/proxy', async (req, res) => {
  const { url, referer: customReferer } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta ?url=' });

  try {
    const referer = customReferer || (() => {
      try { return new URL(url).origin + '/'; } catch { return 'https://www3.animeflv.net/'; }
    })();

    const upstream = await http.get(url, {
      headers: browserHeaders(referer),
      responseType: 'stream',
    });

    // Pasar headers del upstream (Content-Type, etc.)
    const ct = upstream.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Si es un .m3u8, reescribir las URLs relativas para que pasen por el proxy
    if (ct.includes('mpegurl') || url.includes('.m3u8')) {
      let m3u8Text = '';
      upstream.data.on('data', chunk => { m3u8Text += chunk.toString(); });
      upstream.data.on('end', () => {
        const base = url.substring(0, url.lastIndexOf('/') + 1);
        const rewritten = m3u8Text.replace(/^(?!#)([^\n]+\.ts[^\n]*)/gm, (match) => {
          if (match.startsWith('http')) return match;
          return base + match;
        });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewritten);
      });
    } else {
      upstream.data.pipe(res);
    }
  } catch (e) {
    res.status(502).json({ error: 'Proxy error', detail: e.message });
  }
});

// ─────────────────────────────────────────────────────────
//  HTML BUILDERS
// ─────────────────────────────────────────────────────────

/** HTML con Video.js cargando fuentes directas */
function buildNativePlayerHTML(sources) {
  const sourceTags = sources.map(s => {
    const type = s.type === 'hls'
      ? 'application/x-mpegURL'
      : 'video/mp4';
    return `<source src="${escapeHtml(s.url)}" type="${type}" label="${escapeHtml(s.quality || 'Auto')}">`;
  }).join('\n    ');

  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Player</title>
<link href="https://cdnjs.cloudflare.com/ajax/libs/video.js/8.10.0/video-js.min.css" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/video.js/8.10.0/video.min.js"></script>
<script src="https://cdnjs.cloudflare.com/ajax/libs/videojs-contrib-hls/5.15.0/videojs-contrib-hls.min.js"></script>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:100%;height:100%;background:#000;overflow:hidden}
  #player{width:100%;height:100%;position:absolute;inset:0}
  .video-js,.vjs-tech{width:100%!important;height:100%!important}
  .vjs-big-play-button{top:50%!important;left:50%!important;transform:translate(-50%,-50%)}
</style>
</head>
<body>
${ANTI_POPUP_INLINE}
<video id="player" class="video-js vjs-default-skin" controls playsinline preload="auto">
  ${sourceTags}
</video>
<script>
  const player = videojs('player', {
    fluid: false,
    fill:  true,
    html5: {
      vhs: { overrideNative: true },
      nativeVideoTracks: false,
    },
  });
  player.ready(function(){
    player.play().catch(()=>{});
  });
</script>
</body>
</html>`;
}

/** HTML wrapper con iframe del proveedor + anti-popup */
function buildIframeWrapperHTML(iframeUrl) {
  return `<!DOCTYPE html>
<html lang="es">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Player</title>
<style>
  *{margin:0;padding:0;box-sizing:border-box}
  html,body{width:100%;height:100%;background:#000;overflow:hidden}
  iframe{
    position:absolute;inset:0;
    width:100%;height:100%;
    border:none;
  }
  /* Escudo anti-popup: intercepta el primer clic */
  #shield{
    position:fixed;inset:0;z-index:9999;
    background:transparent;cursor:default;
    pointer-events:all;
  }
</style>
</head>
<body>
${ANTI_POPUP_INLINE}
<div id="shield"></div>
<iframe
  src="${escapeHtml(iframeUrl)}"
  allow="autoplay; fullscreen; encrypted-media; picture-in-picture"
  allowfullscreen
  referrerpolicy="no-referrer-when-downgrade"
  sandbox="allow-forms allow-scripts allow-same-origin allow-presentation allow-pointer-lock"
></iframe>
<script>
  // Shield: absorbe el primer clic (que normalmente abriría un popup)
  let clicks = 0;
  const shield = document.getElementById('shield');
  shield.addEventListener('click', (e) => {
    clicks++;
    if (clicks >= 2) {
      // A partir del 2do clic, quitar el escudo para que el usuario
      // pueda interactuar con el player
      shield.style.pointerEvents = 'none';
    }
    e.stopPropagation();
    e.preventDefault();
  });

  // Bloquear popups que intente abrir el iframe via postMessage
  window.addEventListener('message', (e) => {
    // No propagar mensajes que intenten redirigir
    if (e.data && typeof e.data === 'string' && e.data.includes('http')) {
      e.stopImmediatePropagation();
    }
  });
</script>
</body>
</html>`;
}

/** Inyecta el script anti-popup en un HTML existente */
function injectAntiPopup(html) {
  const injection = `<script>${ANTI_POPUP_SCRIPT}<\/script>`;
  if (html.includes('</head>')) {
    return html.replace('</head>', injection + '</head>');
  }
  return injection + html;
}

// ─────────────────────────────────────────────────────────
//  ANTI-POPUP SCRIPT
//  Sobreescribe window.open, alert, confirm, prompt
//  y bloquea redirecciones via location
// ─────────────────────────────────────────────────────────
const ANTI_POPUP_SCRIPT = `
(function() {
  'use strict';
  // Bloquear apertura de popups/nuevas ventanas
  const noop = () => null;
  window.open    = noop;
  window.alert   = noop;
  window.confirm = () => false;
  window.prompt  = () => null;

  // Bloquear redirecciones via location en iframes
  if (window !== window.top) {
    const _desc = Object.getOwnPropertyDescriptor(window, 'location');
    if (_desc && _desc.configurable) {
      Object.defineProperty(window, 'location', {
        set: noop,
        get: () => _desc.get.call(window),
        configurable: false,
      });
    }
  }

  // Interceptar clicks en enlaces que abran _blank
  document.addEventListener('click', function(e) {
    const a = e.target.closest('a[target="_blank"], a[target="_top"]');
    if (a) {
      e.preventDefault();
      e.stopPropagation();
      return false;
    }
  }, true);

  // Bloquear document.write (usado por algunos ads)
  const _write = document.write.bind(document);
  document.write = function(s) {
    if (s && (s.includes('window.open') || s.includes('pop'))) return;
    _write(s);
  };
})();
`;

const ANTI_POPUP_INLINE = `<script>${ANTI_POPUP_SCRIPT}<\/script>`;

// ─────────────────────────────────────────────────────────
//  HELPER
// ─────────────────────────────────────────────────────────
function escapeHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// ─────────────────────────────────────────────────────────
//  START
// ─────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AnimeHub Resolver listening on port ${PORT}`);
  console.log(`Health: http://localhost:${PORT}/`);
  console.log(`Resolve: http://localhost:${PORT}/resolve?url=https://...`);
  console.log(`Player:  http://localhost:${PORT}/player?url=https://...`);
});
