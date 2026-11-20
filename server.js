/* MultiMedia Render Server v1.9.0 — tüm siteler için Puppeteer-tabanlı kaynak çözücü.
 *
 * 1.9.0 düzeltmeleri:
 *   - Dizigom data-pv: Puppeteer sayfayı açtıktan sonra player script'in yüklenmesini
 *     bekler (networkidle2 + 3sn ek bekleme), data-pv attribute'unu runtime DOM'dan çıkarır.
 *   - IMDb ID parametresi: hdfilmdelisi/vixolity ve carnoots için direkt kaynak kurar.
 *   - Arama sırası: IMDb ID → Orijinal → TR → EN (server tarafında names sırası).
 *   - Hız: Cloudflare challenge için maksimum 20sn bekleme (eski 45sn yerine),
 *     cache 2 saat, paralel istek desteği.
 *   - 27 site desteği (Cloudflare engelli 10 dahil).
 *
 * API (mevcut chromium-1-1m2a.onrender.com ile uyumlu):
 *   GET /                  → "MultiMedia resolver çalışıyor" (health)
 *   GET /sites             → { siteId: { base, ...patterns } }
 *   GET /find/:site?names=...&year=...&type=movie|tv&s=N&e=N&imdb=ttXXXX
 *     → { site, found, match:{slug,title,year}, watchUrl,
 *         sources:[{provider,url,type,referer,origin}] }
 *
 * CORS: * (Tizen TV'den çağrılabilir)
 * Engine: Express + Puppeteer (headless Chromium, Cloudflare bypass)
 */
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 10000;

const SITES = {
  hdfilmdelisi: { base: 'https://hdfilmdelisi.one', search: '/?s=', vixolity: true },
  dizigom: { base: 'https://www.dizigom.news', search: '/ara?q=', detailMovie: '/film/{slug}', detailSeries: '/{slug}-{s}-sezon-{e}-bolum' },
  carnoots: { base: 'https://carnoots.com', video: 'https://video.carnoots.com/{slug}/s{s}/e{e}/master.m3u8' },
  /* Statik fetch ile çalışan siteler (Chromium gerekmez — hızlı) */
  canlifilmizle: { base: 'https://canlifilmizle.com', search: '/?s=', static: true },
  filmizlefilmizle: { base: 'https://canlifilmizle.com', search: '/?s=', static: true },
  pcfilmizle: { base: 'https://pcfilmizle.com', search: '/?s=', static: true },
  filmgecesi: { base: 'https://www.filmgecesi.vip', search: '/?s=', static: true },
  filmmakinesi: { base: 'https://filmmakinesi.to', search: '/arama/?s=', static: true, fallbackRender: true },
  fullhdfilmizlesene: { base: 'https://fullhdfilmizlesene.cc', search: '/arama/', static: true, fallbackRender: true },
  ultraiz: { base: 'https://ultraiz.net', search: '/?s=', static: true, fallbackRender: true },
  ufilmizle: { base: 'https://ultraiz.net', search: '/?s=', static: true },
  hdfilmizle: { base: 'https://www.hdfilmizle.live', search: null, sitemap: true, static: true },
  lovefilmizle: { base: 'https://lovefilmizle.net', search: '/?s=', static: true },
  sinemacc: { base: 'https://sinemacc.com', search: '/arama/?s=', static: true },
  turkcefilmler: { base: 'https://turkcefilmler.to', search: '/arama/?s=', static: true },
  fixfullfilmizle: { base: 'https://www.fixfullfilmizle.com', search: '/?s=', static: true },
  filmifullizle: { base: 'https://www.filmifullizle.news', search: '/?s=', static: true },
  filmizlebabam: { base: 'https://www.filmizlebabam.com', search: '/ara?q=', static: true },
  filmizlehell: { base: 'https://filmizlehell.net', search: '/arama?q=', static: true, fallbackRender: true },
  ddizi: { base: 'https://www.ddizi.tel', search: '/arama/', searchPost: true, static: true },
  filmcibaba: { base: 'https://filmizle.ink', search: '/?s=', static: true },
  /* Cloudflare'li siteler — hem statik dene hem Render'a fallback (kimi zaman statik geçer) */
  hdfilmcehennemi: { base: 'https://www.hdfilmcehennemi.nl', search: '/?s=', static: true, fallbackRender: true, region: true },
  cizgivedizi: { base: 'https://cizgivedizi.net', search: '/?s=', cloudflare: true, fallbackRender: true },
  /* Cloudflare engelli anime/çizgi dizi siteleri — sadece Render */
  animecix: { base: 'https://animecix.tv', search: '/arama?q=', cloudflare: true },
  anizm: { base: 'https://anizm.net', search: '/arama?q=', cloudflare: true, fallbackRender: true },
  cizgimax: { base: 'https://cizgimax.online', search: '/?s=', cloudflare: true },
  kultfilmler: { base: 'https://kultfilmler.net', search: '/?s=', cloudflare: true, fallbackRender: true },
  sonanime: { base: 'https://sonanime.com', search: '/?s=', cloudflare: true, fallbackRender: true },
  tranimeizle: { base: 'https://www.tranimeizle.live', search: '/?s=', cloudflare: true, fallbackRender: true },
  dizibox: { base: 'https://www.dizibox.live', search: '/?s=', cloudflare: true, fallbackRender: true },
  dizipal: { base: 'https://dizipal1587.com', search: '/?s=', cloudflare: true, fallbackRender: true }
};

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/* Statik fetch (Chromium gerekmez) — Cloudflare olmayan siteler için çok daha hızlı.
   Chromium yüklü değilse bile bu siteler çalışır. Cloudflare challenge dönerse
   Puppeteer'a fallback yapılır.
   TR IP spoofing: hdfilmcehennemi gibi 451 legal engel (region) veren siteler için
   X-Forwarded-For ile TR IP adresi gönderir — Cloudflare origin'e iletir. */
const TR_IPS = ['85.34.1.1', '81.215.1.1', '78.135.1.1', '212.252.1.1'];
function trIp() { return TR_IPS[Math.floor(Math.random() * TR_IPS.length)]; }

async function fetchStatic(url, { postData = null, timeout = 12000, spoofTr = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const headers = {
      'User-Agent': UA,
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Cache-Control': 'no-cache',
      'Pragma': 'no-cache',
      'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-User': '?1',
      'Upgrade-Insecure-Requests': '1'
    };
    if (spoofTr) {
      const ip = trIp();
      headers['X-Forwarded-For'] = ip;
      headers['CF-Connecting-IP'] = ip;
      headers['X-Real-IP'] = ip;
      headers['True-Client-IP'] = ip;
    }
    const opt = {
      method: postData ? 'POST' : 'GET',
      headers,
      redirect: 'follow',
      signal: controller.signal
    };
    if (postData) {
      headers['Content-Type'] = 'application/x-www-form-urlencoded';
      opt.body = postData;
    }
    const r = await fetch(url, opt);
    const html = await r.text();
    const status = r.status;
    const finalUrl = r.url;
    return { html, status, finalUrl };
  } finally {
    clearTimeout(timer);
  }
}

/* Cloudflare challenge tespiti */
function isCloudflareChallenge(html) {
  if (!html) return false;
  const t = html.slice(0, 4000).toLowerCase();
  return /just a moment|bir dakika lütfen|attention required|cf-challenge|challenge-platform|window\.location\.reload\(\)/i.test(html) ||
    (html.length < 2000 && /<title>[^<]*(just a moment|bir dakika|attention)[^<]*<\/title>/i.test(html));
}

let browserPromise = null;
function getBrowser() {
  if (!browserPromise) {
    /* Dockerfile'da PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium set edilir.
       Bu sayede sistem Chromium'unu kullanır — "Could not find Chrome" hatası çözülür. */
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    const launchOpt = {
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-gpu']
    };
    if (executablePath) launchOpt.executablePath = executablePath;
    browserPromise = puppeteer.launch(launchOpt);
    browserPromise.catch(() => { browserPromise = null; });
  }
  return browserPromise;
}

async function fetchPage(url, { waitMs = 2000, networkIdle = false, waitForSelector = null, postData = null, spoofTr = false } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  const extraHeaders = { 'Accept-Language': 'tr-TR,tr;q=0.9' };
  if (spoofTr) {
    const ip = trIp();
    extraHeaders['X-Forwarded-For'] = ip;
    extraHeaders['CF-Connecting-IP'] = ip;
    extraHeaders['X-Real-IP'] = ip;
    extraHeaders['True-Client-IP'] = ip;
  }
  await page.setExtraHTTPHeaders(extraHeaders);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  try {
    let resp;
    if (postData) {
      resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000, method: 'POST', postData });
    } else {
      resp = await page.goto(url, { waitUntil: networkIdle ? 'networkidle2' : 'domcontentloaded', timeout: 30000 });
    }
    /* Cloudflare challenge bekle (maks 20sn — eski 45sn yerine hızlı) */
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const title = await page.title().catch(() => '');
      if (title && !/just a moment|bir dakika|attention required|cloudflare/i.test(title)) break;
      await new Promise(r => setTimeout(r, 1200));
    }
    if (waitForSelector) {
      try { await page.waitForSelector(waitForSelector, { timeout: 8000 }); } catch (e) {}
    }
    await new Promise(r => setTimeout(r, waitMs));
    const html = await page.content();
    const finalUrl = page.url();
    const status = resp ? resp.status() : 200;
    return { html, status, finalUrl, page };
  } finally {
    await page.close().catch(() => {});
  }
}

/* Dizigom data-pv için özel: sayfa açıldıktan sonra player script'in yüklenmesini
   bekle, sonra DOM'dan data-pv attribute'unu çıkar. Statik HTML scrape'te görünmez
   çünkü player script runtime'da inject ediliyor. */
async function fetchDizigomPlayer(watchUrl, base) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  await page.setExtraHTTPHeaders({ 'Accept-Language': 'tr-TR,tr;q=0.9' });
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  let playerInfo = null;
  try {
    const playerScripts = [];
    page.on('request', req => {
      const u = req.url();
      if (/\/(?:assets\/js\/core|e\/c)\.js/i.test(u) || /\/assets\/js\/s\.php\?s=/i.test(u)) {
        playerScripts.push(u);
      }
    });
    await page.goto(watchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    const t0 = Date.now();
    while (Date.now() - t0 < 15000) {
      const title = await page.title().catch(() => '');
      if (title && !/just a moment|bir dakika|attention required|cloudflare/i.test(title)) break;
      await new Promise(r => setTimeout(r, 1200));
    }
    try { await page.waitForNetworkIdle({ idleTime: 1500, timeout: 12000 }); } catch (e) {}
    /* data-pv'yi DOM'dan çıkar (runtime'da set edilir, statik HTML'de yok) */
    const dataPv = await page.evaluate(() => {
      const el = document.querySelector('[data-pv]');
      return el ? el.getAttribute('data-pv') : null;
    }).catch(() => null);
    const coreScript = playerScripts.find(u => /\/(?:assets\/js\/core|e\/c)\.js/i.test(u));
    const sUrl = playerScripts.find(u => /\/assets\/js\/s\.php\?s=/i.test(u));
    playerInfo = { dataPv, coreScript, sUrl, finalUrl: page.url() };
  } finally {
    await page.close().catch(() => {});
  }
  return playerInfo;
}

function absUrl(u, base) {
  if (!u) return '';
  if (/^https?:\/\//i.test(u)) return u;
  try { return new URL(u, base).href; } catch (e) { return ''; }
}
function isPlayerHost(u) {
  const hosts = ['vidrame','hotstream','vixolity','playerx','oynat','vidmoly','sibnet','vk','mail.ru','myvi','fembed','gdrive','dailymotion','streamtape','doodstream','mixdrop','voe','upstream','files.im','rapidvid','cloudvideo','suat','wargamings','pl.','ha.vixolity','video.carnoots'];
  try {
    const h = new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    return hosts.some(s => h.indexOf(s) >= 0) || /\.(m3u8|mp4|mkv|webm)(\?|$|#)/i.test(u);
  } catch (e) { return false; }
}

function extractSources(html, base) {
  const sources = [];
  const seen = {};
  function push(url, type, label) {
    if (!url || seen[url]) return;
    if (!/^https?:\/\//i.test(url)) return;
    if (/\.(?:jpe?g|png|gif|webp|svg|ico|css|js|json|xml)(\?|$)/i.test(url)) return;
    seen[url] = 1;
    let t = type;
    if (!t) t = /\.m3u8(\?|$|#)/i.test(url) ? 'hls' : (/\.mp4(\?|$|#)/i.test(url) ? 'mp4' : 'iframe');
    sources.push({ provider: label || (() => { try { return new URL(url).hostname; } catch (e) { return 'player'; } })(), url, type: t });
  }
  let m;
  const iframeRe = /<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = iframeRe.exec(html)) !== null) {
    const u = absUrl(m[1], base);
    if (u && isPlayerHost(u)) push(u, null, 'iframe');
  }
  const dataRe = /data-(?:src|video|iframe|url|m3u8|mp4|frame|embed|player-src|video-src)\s*=\s*["']([^"']+)["']/gi;
  while ((m = dataRe.exec(html)) !== null) {
    const raw = m[1];
    if (raw.indexOf('${') >= 0) continue;
    if (/^data:/i.test(raw)) continue;
    const u = absUrl(raw, base);
    if (u && isPlayerHost(u)) push(u, null, 'data-src');
  }
  const mediaRe = /(https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4|mkv|webm)(?:\?[^\s"'<>]*)?)/gi;
  while ((m = mediaRe.exec(html)) !== null) push(m[1], null, 'media');
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([^<]+)<\/script>/gi;
  while ((m = ldRe.exec(html)) !== null) {
    try {
      const data = JSON.parse(m[1]);
      const arr = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const o of arr) {
        if (!o) continue;
        if (o.contentUrl && typeof o.contentUrl === 'string') push(o.contentUrl, null, 'json-ld');
        if (o.embedUrl && typeof o.embedUrl === 'string') push(o.embedUrl, null, 'json-ld');
      }
    } catch (e) {}
  }
  return sources;
}

function pickResult(html, base, names, year, type) {
  const origin = base.match(/^https?:\/\/[^/]+/)[0];
  const results = [];
  const aRe = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  let m;
  while ((m = aRe.exec(html)) !== null) {
    let href = m[1];
    if (/^\//.test(href)) href = origin + href;
    if (!href.startsWith(origin)) continue;
    const path = new URL(href).pathname;
    if (/^\/(?:film|dizi|izle|diziler|category|tag|page|wp-|sitemap|ara|search|arama)\b/i.test(path)) {
      /* /film/ ve /diziler/ path'leri geçerli içerik sayfaları — hariç tutma */
      if (!/^\/(?:film|dizi|diziler|izle)\//i.test(path)) continue;
    }
    if (path === '/' || path.length < 3) continue;
    /* text + title attr + img alt — en zengin metin kaynağı */
    let text = m[2].replace(/<[^>]+>/g, ' ').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim();
    const tagAttrs = m[0].match(/\btitle=["']([^"']+)["']/i);
    const altAttrs = m[2].match(/\balt=["']([^"']+)["']/i);
    if (!text && tagAttrs && tagAttrs[1]) text = tagAttrs[1];
    if (altAttrs && altAttrs[1] && text.length < altAttrs[1].length) text = altAttrs[1];
    if (!text || text.length < 2) continue;
    const ys = text.match(/\b(19|20)\d{2}\b/g);
    const slug = path.replace(/^\/+|\/+$/g, '');
    results.push({ slug, text, year: ys ? Number(ys[ys.length - 1]) : null, url: href });
  }
  function norm(s) {
    let x = String(s || '').toLowerCase().replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c');
    if (x.normalize) x = x.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return x.replace(/[^a-z0-9]+/g, ' ').replace(/^ +| +$/g, '');
  }
  let best = null, bestScore = 0;
  for (const c of results) {
    const t = norm(c.text);
    const slugN = norm(c.slug);
    let score = 0;
    names.forEach((n, idx) => {
      const w = norm(n);
      if (!w) return;
      /* İlk sorgu (IMDb ID hariç, orijinal isim) en yüksek öncelik */
      const weight = idx === 0 ? 1.2 : 1;
      if (t === w) score = Math.max(score, 100 * weight);
      else if (t.indexOf(w) >= 0 || w.indexOf(t) >= 0) score = Math.max(score, 80 * weight);
      else {
        const a = w.split(' '), b = t.split(' ');
        let n2 = 0;
        a.forEach(x => { if (x.length > 2 && b.indexOf(x) >= 0) n2++; });
        score = Math.max(score, 62 * n2 / Math.max(1, Math.min(a.length, b.length)) * weight);
      }
      /* Slug eşleştirme — URL path'inde isim geçiyorsa güçlü sinyal */
      if (slugN.indexOf(w) >= 0 || w.indexOf(slugN) >= 0) score = Math.max(score, 75 * weight);
      else {
        const sa = w.split(' ');
        let n3 = 0;
        sa.forEach(x => { if (x.length > 2 && slugN.indexOf(x) >= 0) n3++; });
        if (n3 > 0) score = Math.max(score, 55 * n3 / Math.max(1, sa.length) * weight);
      }
    });
    /* type filtreleme: dizi arıyorsak film path'ini cezalandır, tersi de */
    if (type === 'tv' && /\/(film|filmler|fragman)\b/i.test(c.url) && !/\/(dizi|sezon|bolum)\b/i.test(c.url)) score -= 20;
    if (type === 'movie' && /\/(dizi|sezon|bolum)\b/i.test(c.url) && !/\/(film|filmler)\b/i.test(c.url)) score -= 20;
    if (year && c.year) score += Math.abs(c.year - year) <= 1 ? 12 : -8;
    if (score > bestScore) { bestScore = score; best = c; }
  }
  return bestScore >= 35 ? best : null;
}

const cache = new Map();
function cacheGet(k) { const v = cache.get(k); if (v && Date.now() - v.t < 7200000) return v.v; return null; }
function cacheSet(k, v) { cache.set(k, { v, t: Date.now() }); if (cache.size > 200) { const first = cache.keys().next().value; cache.delete(first); } }

app.get('/', (req, res) => res.type('text').send('MultiMedia resolver çalışıyor'));

app.get('/sites', (req, res) => {
  const out = {};
  for (const [id, cfg] of Object.entries(SITES)) {
    out[id] = { base: cfg.base };
    if (cfg.video) out[id].video = cfg.video;
    if (cfg.film) out[id].film = cfg.film;
    if (cfg.dizi) out[id].dizi = cfg.dizi;
  }
  res.json(out);
});

app.get('/find/:site', async (req, res) => {
  const siteId = req.params.site;
  const cfg = SITES[siteId];
  if (!cfg) return res.status(404).json({ error: 'Bilinmeyen site: ' + siteId });

  /* names sırası: server'a gelen names zaten orijinal → TR sırasında.
     IMDb ID ayrı imdb parametresi olarak gelir. */
  const names = (req.query.names || '').split('|').map(s => s.trim()).filter(Boolean);
  const year = req.query.year ? Number(req.query.year) : null;
  const type = req.query.type === 'tv' ? 'tv' : 'movie';
  const s = req.query.s || req.query.season;
  const e = req.query.e || req.query.episode;
  const imdbId = req.query.imdb || '';
  if (!names.length && !imdbId) return res.json({ site: siteId, found: false, sources: [] });

  const cacheKey = siteId + ':' + names.join('|') + ':' + year + ':' + type + ':' + s + ':' + e + ':' + imdbId;
  const cached = cacheGet(cacheKey);
  if (cached) return res.json(Object.assign({ cached: true }, cached));

  try {
    /* 1) hdfilmdelisi vixolity direkt yol (IMDb ID ile) */
    if (cfg.vixolity && imdbId) {
      const vurl = type === 'tv'
        ? 'https://ha.vixolity.com/vs/' + imdbId + '/s' + s + '/e' + (Number(e) < 10 ? '0' + e : e)
        : 'https://ha.vixolity.com/vs/' + imdbId;
      const result = { site: siteId, found: true, match: { slug: imdbId, title: names[0] || imdbId, year: year }, watchUrl: cfg.base + '/film/' + imdbId, sources: [{ provider: 'varsayilan', url: vurl, type: 'hls', referer: 'https://pl.vixolity.com/', origin: cfg.base }] };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    /* 2) carnoots kalıp (anime, type=tv) */
    if (cfg.video && type === 'tv' && s && e) {
      const slug = String(names[0] || imdbId || '').toLowerCase().replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const vurl = cfg.video.replace('{slug}', slug).replace('{s}', s).replace('{e}', e);
      const result = { site: siteId, found: true, match: { slug, title: names[0], year }, watchUrl: cfg.base + '/browse', sources: [{ provider: 'carnoots', url: vurl, type: 'hls', referer: '', origin: cfg.base }] };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    /* 3) hdfilmizle sitemap araması */
    if (cfg.sitemap) {
      const result = await findHdfilmizle(cfg, names, year, type);
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    /* 4) Dizigom: özel player script akışı (data-pv düzeltmesi) */
    if (siteId === 'dizigom') {
      const result = await findDizigom(cfg, names, year, type, s, e);
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    /* 5) ddizi: POST ile arama */
    if (cfg.searchPost) {
      const result = await findPostSite(cfg, names, year, type, 'arama=');
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    /* 6) Generic: ara → en iyi sonucu seç → detay sayfasını aç → kaynak çıkar */
    if (!cfg.search) {
      const result = { site: siteId, found: false, error: 'bu site için arama yolu tanımlı değil', sources: [] };
      cacheSet(cacheKey, result);
      return res.json(result);
    }
    const searchPath = cfg.search;
    const searchUrl = cfg.base + searchPath + encodeURIComponent(names[0]);
    let searchHtml;
    let usedStatic = false;
    /* Önce statik fetch (Chromium gerekmez — çok daha hızlı).
       Cloudflare challenge dönerse veya static bayrağı yoksa Puppeteer'a düş.
       region=true ise TR IP spoof ile dene (451 legal engeli aşmak için). */
    if (cfg.static || cfg.fallbackRender || cfg.region) {
      try {
        const postData = cfg.searchPost ? ('arama=' + encodeURIComponent(names[0])) : null;
        const r = await fetchStatic(searchUrl, { postData, spoofTr: !!cfg.region });
        if (r.status >= 200 && r.status < 400 && !isCloudflareChallenge(r.html) && r.html.length > 2000) {
          searchHtml = r.html;
          usedStatic = true;
        }
      } catch (e) { /* statik başarısız — Puppeteer'a düş */ }
    }
    if (!searchHtml) {
      try {
        const postData = cfg.searchPost ? ('arama=' + encodeURIComponent(names[0])) : null;
        const r = await fetchPage(searchUrl, { waitMs: 1500, postData, spoofTr: !!cfg.region });
        searchHtml = r.html;
      } catch (err) {
        const result = { site: siteId, found: false, error: 'arama başarısız: ' + err.message, sources: [] };
        cacheSet(cacheKey, result);
        return res.json(result);
      }
    }

    const best = pickResult(searchHtml, cfg.base, names, year, type);
    if (!best) {
      const result = { site: siteId, found: false, sources: [], method: usedStatic ? 'static' : 'render' };
      cacheSet(cacheKey, result);
      return res.json(result);
    }

    let detailHtml;
    /* Detay sayfası için de önce statik (varsa), sonra Render. */
    if (usedStatic && (cfg.static || cfg.fallbackRender || cfg.region)) {
      try {
        const r = await fetchStatic(best.url, { spoofTr: !!cfg.region });
        if (r.status >= 200 && r.status < 400 && !isCloudflareChallenge(r.html) && r.html.length > 2000) {
          detailHtml = r.html;
        }
      } catch (e) { /* statik başarısız — Render'a düş */ }
    }
    if (!detailHtml) {
      try {
        const r = await fetchPage(best.url, { waitMs: 2500, networkIdle: true, spoofTr: !!cfg.region });
        detailHtml = r.html;
      } catch (err) {
        const result = { site: siteId, found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: best.url, fastNote: 'detay sayfası açılamadı: ' + err.message, sources: [] };
        cacheSet(cacheKey, result);
        return res.json(result);
      }
    }

    const sources = extractSources(detailHtml, cfg.base);
    const result = {
      site: siteId,
      found: true,
      match: { slug: best.slug, title: best.text, year: best.year },
      watchUrl: best.url,
      method: usedStatic ? 'static' : 'render',
      sources: sources.map(s => ({ provider: s.provider, url: s.url, type: s.type, referer: '', origin: cfg.base }))
    };
    cacheSet(cacheKey, result);
    res.json(result);
  } catch (err) {
    res.json({ site: siteId, found: false, error: err.message, sources: [] });
  }
});

/* Dizigom: data-pv düzeltmesi — Puppeteer ile runtime'da player script bekle. */
async function findDizigom(cfg, names, year, type, s, e) {
  const searchUrl = cfg.base + cfg.search + encodeURIComponent(names[0]);
  let searchHtml;
  try {
    const r = await fetchPage(searchUrl, { waitMs: 1500 });
    searchHtml = r.html;
  } catch (err) {
    return { site: 'dizigom', found: false, error: 'arama: ' + err.message, sources: [] };
  }
  const best = pickResult(searchHtml, cfg.base, names, year, type);
  if (!best) return { site: 'dizigom', found: false, sources: [] };

  const watchUrl = type === 'tv'
    ? cfg.base + '/' + best.slug + '-' + s + '-sezon-' + e + '-bolum/'
    : cfg.base + '/film/' + best.slug;

  const playerInfo = await fetchDizigomPlayer(watchUrl, cfg.base);
  if (!playerInfo || !playerInfo.dataPv) {
    return { site: 'dizigom', found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: watchUrl, fastNote: 'sayfada data-pv bulunamadı (player script yüklenmedi)', sources: [] };
  }

  const coreScript = playerInfo.coreScript;
  if (!coreScript) {
    return { site: 'dizigom', found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: watchUrl, fastNote: 'core.js bulunamadı', sources: [] };
  }
  const pOrigin = coreScript.match(/^https?:\/\/[^/]+/)[0];
  const sUrl = pOrigin + '/assets/js/s.php?s=' + encodeURIComponent(playerInfo.dataPv);

  let spHtml;
  try {
    const r = await fetchPage(sUrl, { waitMs: 1000 });
    spHtml = r.html;
  } catch (err) {
    return { site: 'dizigom', found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: watchUrl, fastNote: 'player sayfası açılamadı: ' + err.message, sources: [] };
  }

  const vm = String(spHtml).match(/api\/(?:stream|token|thumb)\.php\?v=([0-9a-f]{16,64})/i);
  if (!vm) {
    return { site: 'dizigom', found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: watchUrl, fastNote: 'player sayfasında video no yok', sources: [] };
  }
  const V = vm[1];

  let tok = null;
  try {
    const r = await fetchPage(pOrigin + '/api/token.php?v=' + V, { waitMs: 500 });
    const j = JSON.parse(r.html);
    if (j && j.ok && j.token) tok = j.token;
  } catch (e) {}
  if (!tok) {
    return { site: 'dizigom', found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: watchUrl, fastNote: 'token alınamadı', sources: [] };
  }

  const link = pOrigin + '/api/stream.php?v=' + V + '&token=' + tok;
  return {
    site: 'dizigom',
    found: true,
    match: { slug: best.slug, title: best.text, year: best.year },
    watchUrl: watchUrl,
    sources: [{ provider: 'dizigom', url: link, type: 'hls', referer: sUrl, origin: pOrigin }]
  };
}

/* POST ile arama yapan siteler için (ddizi) */
async function findPostSite(cfg, names, year, type, paramName) {
  const searchUrl = cfg.base + cfg.search;
  let searchHtml;
  try {
    const r = await fetchPage(searchUrl, { waitMs: 1500, postData: paramName + encodeURIComponent(names[0]) });
    searchHtml = r.html;
  } catch (err) {
    return { site: cfg.base, found: false, error: 'arama: ' + err.message, sources: [] };
  }
  const best = pickResult(searchHtml, cfg.base, names, year, type);
  if (!best) return { site: cfg.base, found: false, sources: [] };

  let detailHtml;
  try {
    const r = await fetchPage(best.url, { waitMs: 2500, networkIdle: true });
    detailHtml = r.html;
  } catch (err) {
    return { site: cfg.base, found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: best.url, fastNote: 'detay sayfası açılamadı: ' + err.message, sources: [] };
  }
  const sources = extractSources(detailHtml, cfg.base);
  return { site: cfg.base, found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: best.url, sources: sources.map(s => ({ provider: s.provider, url: s.url, type: s.type, referer: '', origin: cfg.base })) };
}

async function findHdfilmizle(cfg, names, year, type) {
  const sitemaps = [cfg.base + '/sitemapppz/sitemap-videolar-1.xml', cfg.base + '/sitemapppz/sitemap-videolar-2.xml'];
  function norm(s) {
    let x = String(s || '').toLowerCase().replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c');
    if (x.normalize) x = x.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return x.replace(/[^a-z0-9]+/g, ' ').replace(/^ +| +$/g, '');
  }
  const allUrls = [];
  await Promise.all(sitemaps.map(async sm => {
    try {
      const r = await fetchPage(sm, { waitMs: 300 });
      const re = /<loc>([^<]+)<\/loc>/g;
      let m;
      while ((m = re.exec(r.html)) !== null) {
        const u = m[1];
        if (u.startsWith(cfg.base + '/') && !/\/(?:sitemap|wp-|category|tag|page|author)\b/i.test(u)) {
          const slug = new URL(u).pathname.replace(/^\/+|\/+$/g, '');
          if (slug && slug.indexOf('/') < 0) allUrls.push({ slug, url: u });
        }
      }
    } catch (e) {}
  }));

  let best = null, bestScore = 0;
  for (const item of allUrls) {
    const slugTitle = norm(item.slug.replace(/[-_]+/g, ' ').replace(/\bizle\b/gi, '').replace(/\bhd\b/gi, '').trim());
    if (!slugTitle) continue;
    let score = 0;
    names.forEach((n, idx) => {
      const w = norm(n);
      if (!w) return;
      const weight = idx === 0 ? 1.2 : 1;
      if (slugTitle === w) score = Math.max(score, 100 * weight);
      else if (slugTitle.indexOf(w) >= 0 || w.indexOf(slugTitle) >= 0) score = Math.max(score, 80 * weight);
      else {
        const a = w.split(' '), b = slugTitle.split(' ');
        let n2 = 0;
        a.forEach(x => { if (x.length > 2 && b.indexOf(x) >= 0) n2++; });
        score = Math.max(score, 62 * n2 / Math.max(1, Math.min(a.length, b.length)) * weight);
      }
    });
    if (score > bestScore) { bestScore = score; best = item; }
  }
  if (!best || bestScore < 50) return { site: 'hdfilmizle', found: false, sources: [] };

  try {
    const r = await fetchPage(best.url, { waitMs: 2500, networkIdle: true });
    const sources = extractSources(r.html, cfg.base);
    return { site: 'hdfilmizle', found: true, match: { slug: best.slug, title: best.slug, year: null }, watchUrl: best.url, sources: sources.map(s => ({ provider: s.provider, url: s.url, type: s.type, referer: '', origin: cfg.base })) };
  } catch (e) {
    return { site: 'hdfilmizle', found: true, match: { slug: best.slug, title: best.slug, year: null }, watchUrl: best.url, fastNote: e.message, sources: [] };
  }
}

const server = app.listen(PORT, () => {
  console.log('MultiMedia render server listening on port ' + PORT);
});
server.timeout = 120000; /* 2 dakika — eski 5dk yerine hızlı */
