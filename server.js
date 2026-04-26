/**
 * AnimeHub — Video Resolver Proxy v2
 * 
 * El problema que resuelve:
 * Los proveedores de video (StreamWish, StreamTape, etc.) bloquean ser
 * embebidos en iframes de otros dominios usando X-Frame-Options o CSP.
 * Este servidor actúa como intermediario: descarga el contenido en el
 * servidor (donde no hay restricciones de iframe), lo modifica y lo sirve
 * desde su propio dominio — así el iframe carga desde Render, no del proveedor.
 *
 * Endpoints:
 *   GET /                           health check / cron ping
 *   GET /resolve?url=               intenta extraer m3u8/mp4 directo (JSON)
 *   GET /player?url=                página HTML completa con el video listo
 *   GET /proxy-resource?url=&ref=   proxy de recursos (JS, CSS, imágenes)
 *   GET /stream?url=&ref=           proxy de streams (m3u8, mp4, ts)
 */

'use strict';

const express   = require('express');
const cors      = require('cors');
const rateLimit = require('express-rate-limit');
const NodeCache = require('node-cache');
const axios     = require('axios');
const cheerio   = require('cheerio');
const { URL }   = require('url');

const app   = express();
const cache = new NodeCache({ stdTTL: 3600, checkperiod: 600 });
const PORT  = process.env.PORT || 3000;

// ─── User-Agents ────────────────────────────────────────────
const UAS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:126.0) Gecko/20100101 Firefox/126.0',
];
const randUA = () => UAS[Math.floor(Math.random() * UAS.length)];

const mkHeaders = (referer) => ({
  'User-Agent':                randUA(),
  'Accept':                    'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
  'Accept-Language':           'es-ES,es;q=0.9,en;q=0.8',
  'Accept-Encoding':           'gzip, deflate, br',
  'Referer':                   referer || 'https://www3.animeflv.net/',
  'DNT':                       '1',
  'Upgrade-Insecure-Requests': '1',
  'Sec-Fetch-Dest':            'iframe',
  'Sec-Fetch-Mode':            'navigate',
  'Sec-Fetch-Site':            'cross-site',
});

const http = axios.create({ timeout: 20000, maxRedirects: 6, validateStatus: s => s < 500 });

// ─── Middleware ──────────────────────────────────────────────
app.use(cors({ origin: '*' }));
app.use(express.json());
app.set('trust proxy', 1);

const limiter = rateLimit({ windowMs: 60_000, max: 120, standardHeaders: true, legacyHeaders: false });
app.use('/resolve', limiter);
app.use('/player',  limiter);

// ─── Helpers ─────────────────────────────────────────────────

function esc(str) {
  return String(str || '').replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
}

function tryB64(s) {
  if (!s || s.startsWith('http')) return s;
  try {
    const d = Buffer.from(s.trim() + '==', 'base64').toString('utf-8');
    if (d.startsWith('http')) return d;
  } catch (_) {}
  return s;
}

/** Extrae URLs de video directas (m3u8, mp4) de un texto HTML/JS */
function extractSources(text) {
  const seen = new Set();
  const out  = [];

  const add = (url, type, quality) => {
    // Limpiar la URL de comillas escapadas
    url = url.replace(/\\+/g, '').replace(/["']/g, '').split(' ')[0];
    if (!url.startsWith('http') || seen.has(url)) return;
    seen.add(url);
    out.push({ url, type, quality: quality || 'auto' });
  };

  // m3u8
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\]+\.m3u8[^\s"'<>\\]*/g))
    add(m[0], 'hls', 'auto');

  // mp4
  for (const m of text.matchAll(/https?:\/\/[^\s"'<>\\]+\.mp4[^\s"'<>\\]*/g))
    add(m[0], 'mp4', 'auto');

  // JWPlayer / setup({ sources: [...] })
  const jwm = text.match(/sources\s*:\s*(\[[\s\S]*?\])/);
  if (jwm) {
    try {
      for (const s of JSON.parse(jwm[1])) {
        const u = s.file || s.src || s.url || '';
        if (u) add(u, u.includes('.m3u8') ? 'hls' : 'mp4', s.label || s.quality || 'auto');
      }
    } catch (_) {}
  }

  // file: "https://..."  or  file:"https://..."
  for (const m of text.matchAll(/["']file["']\s*:\s*["']([^"']+)["']/g))
    add(m[1], m[1].includes('.m3u8') ? 'hls' : 'mp4', 'auto');

  return out;
}

async function fetchText(url, referer) {
  const { data } = await http.get(url, { headers: mkHeaders(referer || url), responseType: 'text' });
  return data || '';
}

// ─── Extractores por proveedor ────────────────────────────────

async function extractFembed(url) {
  const html = await fetchText(url);
  const direct = extractSources(html);
  if (direct.length) return direct;
  // API POST
  try {
    const id   = url.split('/').pop().split('?')[0];
    const host = new URL(url).hostname;
    const { data } = await http.post(
      `https://${host}/api/source/${id}`,
      `r=&d=${host}`,
      { headers: { ...mkHeaders(url), 'Content-Type': 'application/x-www-form-urlencoded' } }
    );
    if (data.success && data.data?.length)
      return data.data.map(s => ({ url: s.file, type: s.file.includes('.mp4') ? 'mp4' : 'hls', quality: s.label || 'auto' }));
  } catch (_) {}
  return [];
}

async function extractStreamwish(url) {
  const html = await fetchText(url);
  const direct = extractSources(html);
  if (direct.length) return direct;
  // Intentar atob
  for (const m of html.matchAll(/atob\(["']([A-Za-z0-9+/=]{20,})["']\)/g)) {
    try {
      const dec = Buffer.from(m[1], 'base64').toString('utf-8');
      const s2  = extractSources(dec);
      if (s2.length) return s2;
    } catch (_) {}
  }
  return [];
}

async function extractStreamtape(url) {
  const html = await fetchText(url);
  const inner = html.match(/innerHTML\s*=\s*["'](https?:\/\/[^"']+)["']/);
  if (inner) return [{ url: inner[1], type: 'mp4', quality: 'auto' }];
  const direct = extractSources(html);
  return direct;
}

async function extractGeneric(url) {
  const html = await fetchText(url);
  const direct = extractSources(html);
  if (direct.length) return direct;
  // Intentar atob
  for (const m of html.matchAll(/atob\(["']([A-Za-z0-9+/=]{20,})["']\)/g)) {
    try {
      const dec = Buffer.from(m[1], 'base64').toString('utf-8');
      const s2  = extractSources(dec);
      if (s2.length) return s2;
    } catch (_) {}
  }
  return [];
}

function pickExtractor(url) {
  const u = url.toLowerCase();
  if (/fembed|filemoon|moon\.cm|fplayer/.test(u)) return extractFembed;
  if (/streamwish|swdyu|wishembed|swish/.test(u))  return extractStreamwish;
  if (/streamtape|stape\.to/.test(u))              return extractStreamtape;
  return extractGeneric;
}

// ─── Anti-popup script ───────────────────────────────────────
const ANTI_POPUP = `(function(){
  'use strict';
  const noop = () => null;
  try { window.open    = noop; } catch(_){}
  try { window.alert   = noop; } catch(_){}
  try { window.confirm = () => false; } catch(_){}
  try { window.prompt  = () => null;  } catch(_){}
  document.addEventListener('click', e => {
    const a = e.target.closest('a[target]');
    if (a && (a.target === '_blank' || a.target === '_top' || a.target === '_parent')) {
      e.preventDefault(); e.stopPropagation();
    }
  }, true);
})();`;

// ─── HTML del reproductor nativo (Video.js) ──────────────────
function buildNativePlayer(sources) {
  const srcs = sources.map(s =>
    `<source src="/stream?url=${encodeURIComponent(s.url)}&ref=${encodeURIComponent(s.url)}" type="${s.type === 'hls' ? 'application/x-mpegURL' : 'video/mp4'}" label="${esc(s.quality)}">`
  ).join('\n    ');

  return `<!DOCTYPE html><html lang="es"><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Player</title>
<link href="https://cdnjs.cloudflare.com/ajax/libs/video.js/8.10.0/video-js.min.css" rel="stylesheet">
<script src="https://cdnjs.cloudflare.com/ajax/libs/video.js/8.10.0/video.min.js"></script>
<style>
*{margin:0;padding:0;box-sizing:border-box}
html,body{width:100%;height:100%;background:#000;overflow:hidden}
.video-js{width:100vw!important;height:100vh!important}
.vjs-big-play-button{top:50%!important;left:50%!important;transform:translate(-50%,-50%)}
</style></head><body>
<script>${ANTI_POPUP}</script>
<video id="v" class="video-js vjs-default-skin" controls playsinline preload="auto">
  ${srcs}
</video>
<script>
videojs('v',{fluid:false,fill:true,html5:{vhs:{overrideNative:true},nativeVideoTracks:false}}).ready(function(){
  this.play().catch(()=>{});
});
</script>
</body></html>`;
}

// ─────────────────────────────────────────────────────────────
//  PROXY COMPLETO DE PÁGINA
//  Descarga la página del proveedor en el servidor,
//  elimina X-Frame-Options / CSP, reescribe URLs relativas,
//  inyecta anti-popup y la sirve desde nuestro dominio.
//  Así el iframe del frontend carga desde Render (sin bloqueo).
// ─────────────────────────────────────────────────────────────
async function buildProxiedPage(targetUrl) {
  const referer = (() => { try { return new URL(targetUrl).origin + '/'; } catch { return 'https://www3.animeflv.net/'; } })();
  const html = await fetchText(targetUrl, referer);

  // Base URL para reescribir URLs relativas
  const base = new URL(targetUrl);

  // Reescribir recursos (src, href) para que pasen por /proxy-resource
  const $ = cheerio.load(html);

  // Eliminar etiquetas que bloquean embeds
  $('meta[http-equiv="X-Frame-Options"]').remove();
  $('meta[http-equiv="Content-Security-Policy"]').remove();

  // Reescribir <script src="...">
  $('script[src]').each((_, el) => {
    const src = $(el).attr('src');
    if (!src) return;
    try {
      const abs = new URL(src, base).href;
      $(el).attr('src', `/proxy-resource?url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(targetUrl)}`);
    } catch (_) {}
  });

  // Reescribir <link href="..."> (CSS)
  $('link[rel="stylesheet"][href]').each((_, el) => {
    const href = $(el).attr('href');
    if (!href) return;
    try {
      const abs = new URL(href, base).href;
      $(el).attr('href', `/proxy-resource?url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(targetUrl)}`);
    } catch (_) {}
  });

  // Inyectar anti-popup al inicio de <head>
  $('head').prepend(`<script>${ANTI_POPUP}</script>`);

  // Inyectar base href para que URLs relativas no reescritas funcionen
  $('head').prepend(`<base href="${targetUrl}">`);

  return $.html();
}

// ══════════════════════════════════════════════════════════════
//  ENDPOINTS
// ══════════════════════════════════════════════════════════════

// ── Health check ─────────────────────────────────────────────
app.get('/', (_, res) => res.json({
  ok: true, service: 'AnimeHub Resolver v2',
  cache: cache.getStats(), time: new Date().toISOString(),
}));

// ── /resolve — intenta extraer m3u8/mp4 directo ──────────────
app.get('/resolve', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta ?url=' });
  try { new URL(url); } catch { return res.status(400).json({ error: 'URL inválida' }); }

  const ck = `resolve:${url}`;
  const hit = cache.get(ck);
  if (hit) return res.json({ ...hit, cached: true });

  try {
    const extractor = pickExtractor(url);
    const sources   = await extractor(url);
    if (sources.length) {
      const result = { method: 'direct', sources, url };
      cache.set(ck, result);
      return res.json({ ...result, cached: false });
    }
  } catch (e) { console.warn('[resolve] extractor error:', e.message); }

  // Si no hay fuentes directas → decir al cliente que use /player (proxy de página)
  const result = { method: 'proxy_page', playerUrl: `/player?url=${encodeURIComponent(url)}`, url };
  cache.set(ck, result, 1800);
  return res.json({ ...result, cached: false });
});

// ── /player — devuelve HTML listo con el video ────────────────
app.get('/player', async (req, res) => {
  const { url } = req.query;
  if (!url) return res.status(400).send('Falta ?url=');

  // Cabeceras que permiten embeber este /player en cualquier iframe
  res.setHeader('X-Frame-Options',        'ALLOWALL');
  res.setHeader('Content-Security-Policy','frame-ancestors *');
  res.setHeader('Content-Type',           'text/html; charset=utf-8');

  // Caché de 1h
  const ck  = `player:${url}`;
  const hit = cache.get(ck);
  if (hit) return res.send(hit);

  // Paso 1: intentar extraer fuentes directas → Video.js nativo (sin ads)
  try {
    const extractor = pickExtractor(url);
    const sources   = await extractor(url);
    if (sources.length) {
      const html = buildNativePlayer(sources);
      cache.set(ck, html);
      return res.send(html);
    }
  } catch (e) { console.warn('[player] extractor failed:', e.message); }

  // Paso 2: proxy completo de la página del proveedor
  try {
    const proxied = await buildProxiedPage(url);
    cache.set(ck, proxied, 1800);
    return res.send(proxied);
  } catch (e) {
    console.warn('[player] proxy page failed:', e.message);
  }

  // Paso 3: iframe wrapper minimal con anti-popup (último recurso)
  const fallback = `<!DOCTYPE html><html><head>
<meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{margin:0;padding:0}html,body{width:100%;height:100%;background:#000;overflow:hidden}
iframe{position:absolute;inset:0;width:100%;height:100%;border:none}
#sh{position:fixed;inset:0;z-index:9999;cursor:default}</style>
</head><body>
<script>${ANTI_POPUP}</script>
<div id="sh"></div>
<iframe src="${esc(url)}" allow="autoplay;fullscreen;encrypted-media" allowfullscreen
  sandbox="allow-forms allow-scripts allow-same-origin allow-presentation allow-pointer-lock"
  referrerpolicy="no-referrer-when-downgrade"></iframe>
<script>
let n=0;document.getElementById('sh').onclick=function(e){
  if(++n>=2)this.style.pointerEvents='none';
  e.preventDefault();e.stopPropagation();
};
</script>
</body></html>`;
  res.send(fallback);
});

// ── /proxy-resource — proxy de JS/CSS del proveedor ──────────
app.get('/proxy-resource', async (req, res) => {
  const { url, ref } = req.query;
  if (!url) return res.status(400).send('Falta ?url=');
  try {
    const upstream = await http.get(url, {
      headers: mkHeaders(ref || url),
      responseType: 'arraybuffer',
    });
    const ct = upstream.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');
    // Si es JS, inyectar anti-popup al inicio
    if (ct.includes('javascript')) {
      const js = Buffer.from(upstream.data).toString('utf-8');
      return res.send(`(${ANTI_POPUP});\n` + js);
    }
    res.send(Buffer.from(upstream.data));
  } catch (e) {
    res.status(502).send('proxy error: ' + e.message);
  }
});

// ── /stream — proxy de streams m3u8/mp4/ts ───────────────────
app.get('/stream', async (req, res) => {
  const { url, ref } = req.query;
  if (!url) return res.status(400).json({ error: 'Falta ?url=' });

  try {
    const upstream = await http.get(url, {
      headers: mkHeaders(ref || url),
      responseType: 'stream',
    });

    const ct = upstream.headers['content-type'] || 'application/octet-stream';
    res.setHeader('Content-Type', ct);
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cache-Control', 'public, max-age=3600');

    // Si es .m3u8 → reescribir URLs de segmentos para que también pasen por /stream
    if (ct.includes('mpegurl') || url.includes('.m3u8')) {
      let text = '';
      upstream.data.on('data', c => text += c.toString());
      upstream.data.on('end', () => {
        const baseUrl = url.substring(0, url.lastIndexOf('/') + 1);
        const rewritten = text.replace(/^(?!#)([^\n\r]+)/gm, seg => {
          if (seg.trim() === '') return seg;
          const abs = seg.startsWith('http') ? seg : baseUrl + seg;
          return `/stream?url=${encodeURIComponent(abs)}&ref=${encodeURIComponent(url)}`;
        });
        res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
        res.send(rewritten);
      });
    } else {
      upstream.data.pipe(res);
    }
  } catch (e) {
    res.status(502).json({ error: 'stream proxy error', detail: e.message });
  }
});

// ── Start ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`AnimeHub Resolver v2 listening on :${PORT}`);
});
