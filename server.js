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
 * GET /sites → { siteId: { base, ...patterns } }
 * GET /find/:site?names=...&year=...&type=movie|tv&s=N&e=N&imdb=ttXXXX
 * → { site, bulundu, eşleşme:{slug,başlık,yıl}, watchUrl,
 * kaynaklar:[{sağlayıcı,url,tür,yönlendiren,kaynak}] }
 *
 * CORS: * (Tizen TV'den çağrılabilir)
 * Motor: Express + Puppeteer (başsız Chromium, Cloudflare bypass)
 */
const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 10000;

sabit SİTELER = {
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

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, Gecko gibi) Chrome/131.0.0.0 Safari/537.36';

/* Statik fetch (Chromium gerekmez) — Cloudflare olmayan siteler için çok daha hızlı.
   Chromium yüklü değilse bile bu siteler çalışır. Cloudflare challenge dönerse
   Puppeteer'a fallback yapılır.
   TR IP spoofing: hdfilmcehennemi gibi 451 legal engel (region) veren siteler için
   X-Forwarded-For ile TR IP adresi gönderir — Cloudflare origin'e iletir. */
const TR_IPS = ['85.34.1.1', '81.215.1.1', '78.135.1.1', '212.252.1.1'];
trIp() fonksiyonu { TR_IPS[Math.floor(Math.random() * TR_IPS.length)] değerini döndürür; }

async function fetchStatic(url, { postData = null, timeout = 12000, spoofTr = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  denemek {
    sabit başlıklar = {
      'Kullanıcı Aracısı': UA,
      'Kabul Et': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': 'tr-TR,tr;q=0.9,en;q=0.8',
      'Accept-Encoding': 'gzip, deflate, br',
      'Önbellek Kontrolü': 'önbellek yok',
      'Pragma': 'önbelleksiz',
      'Sec-Ch-Ua': '"Google Chrome";v="131", "Chromium";v="131", "Not_A Brand";v="24"',
      'Sec-Ch-Ua-Mobile': '?0',
      'Sec-Ch-Ua-Platform': '"Windows"',
      'Sec-Fetch-Dest': 'belge',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'yok',
      'Sec-Fetch-User': '?1',
      'Güvenli Olmayan Yükseltme İstekleri': '1'
    };
    eğer (spoofTr) {
      sabit ip = trIp();
      başlıklar['X-Forwarded-For'] = ip;
      başlıklar['CF-Connecting-IP'] = ip;
      başlıklar['X-Real-IP'] = ip;
      başlıklar['Gerçek İstemci IP'] = ip;
    }
    sabit opt ​​= {
      yöntem: postData ? 'POST' : 'GET',
      başlıklar,
      Yönlendirme: 'takip et',
      sinyal: kontrolcü.sinyali
    };
    eğer (postData) {
      başlıklar['Content-Type'] = 'application/x-www-form-urlencoded';
      opt.body = postData;
    }
    const r = await fetch(url, opt);
    const html = await r.text();
    sabit durum = r.durum;
    const finalUrl = r.url;
    { html, status, finalUrl } döndür;
  } Sonunda {
    Zaman aşımını temizle(zamanlayıcı);
  }
}

/* Cloudflare challenge tespiti */
fonksiyon isCloudflareChallenge(html) {
  Eğer (!html) ise false döndür;
  const t = html.slice(0, 4000).toLowerCase();
  return /just a moment|bir dakika lütfen|attention required|cf-challenge|challenge-platform|window\.location\.reload\(\)/i.test(html) ||
    (html.length < 2000 && /<title>[^<]*(just a moment|bir dakika|attention)[^<]*<\/title>/i.test(html));
}

tarayıcı sözü (browserPromise) boş olsun;
getBrowser() fonksiyonu {
  Eğer tarayıcı sözü (browserPromise) yoksa {
    /* Dockerfile'da PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium ayarlanmıştır.
       Bu sayede sistem Chromium'unu kullanır — "Could not find Chrome" hatası çözülür. */
    const executablePath = process.env.PUPPETEER_EXECUTABLE_PATH || undefined;
    sabit başlatmaOpt = {
      başsız: 'yeni',
      argümanlar: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled', '--disable-dev-shm-usage', '--disable-gpu']
    };
    if (executablePath) launchOpt.executablePath = executablePath;
    browserPromise = puppeteer.launch(launchOpt);
    browserPromise.catch(() => { browserPromise = null; });
  }
  browserPromise'ı döndür;
}

async function fetchPage(url, { waitMs = 2000, networkIdle = false, waitForSelector = null, postData = null, spoofTr = false } = {}) {
  const browser = await getBrowser();
  const page = await browser.newPage();
  await page.setUserAgent(UA);
  const extraHeaders = { 'Accept-Language': 'tr-TR,tr;q=0.9' };
  eğer (spoofTr) {
    sabit ip = trIp();
    extraHeaders['X-Forwarded-For'] = ip;
    extraHeaders['CF-Connecting-IP'] = ip;
    extraHeaders['X-Real-IP'] = ip;
    extraHeaders['True-Client-IP'] = ip;
  }
  await page.setExtraHTTPHeaders(extraHeaders);
  await page.evaluateOnNewDocument(() => {
    Object.defineProperty(navigator, 'webdriver', { get: () => undefined });
  });
  denemek {
    izin ver;
    eğer (postData) {
      resp = await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000, method: 'POST', postData });
    } başka {
      resp = await page.goto(url, { waitUntil: networkIdle ? 'networkidle2' : 'domcontentloaded', timeout: 30000 });
    }
    /* Cloudflare challenge bekle (maks 20sn — eski 45sn yerine hızlı) */
    const t0 = Date.now();
    while (Date.now() - t0 < 20000) {
      const title = await page.title().catch(() => '');
      if (title && !/just a moment|bir dakika|attention required|cloudflare/i.test(title)) break;
      await new Promise(r => setTimeout(r, 1200));
    }
    eğer (seçiciyi bekle) {
      try { await page.waitForSelector(waitForSelector, { timeout: 8000 }); } catch (e) {}
    }
    await new Promise(r => setTimeout(r, waitMs));
    const html = await page.content();
    const finalUrl = page.url();
    const status = resp ? resp.status() : 200;
    { html, durum, finalUrl, sayfa } döndür;
  } Sonunda {
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
  denemek {
    sabit oyuncu komut dosyaları = [];
    sayfa.on('request', req => {
      const u = req.url();
      if (/\/(?:assets\/js\/core|e\/c)\.js/i.test(u) || /\/assets\/js\/s\.php\?s=/i.test(u)) {
        oyuncuKomut Dosyaları.itme(u);
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
      return it ? el.getAttribute('data-pv') : null;
    }).catch(() => null);
    const coreScript = playerScripts.find(u => /\/(?:assets\/js\/core|e\/c)\.js/i.test(u));
    const sUrl = playerScripts.find(u => /\/assets\/js\/s\.php\?s=/i.test(u));
    playerInfo = { dataPv, coreScript, sUrl, finalUrl: page.url() };
  } Sonunda {
    await page.close().catch(() => {});
  }
  Oyuncu bilgilerini döndür;
}

fonksiyon absUrl(u, base) {
  Eğer (!u) ise '' döndür;
  if (/^https?:\/\//i.test(u)) return u;
  try { return new URL(u, base).href; } catch (e) { return ''; }
}
fonksiyon isPlayerHost(u) {
  const hosts = ['vidrame','hotstream','vixolity','playerx','oynat','vidmoly','sibnet','vk','mail.ru','myvi','fembed','gdrive','dailymotion','streamtape','doodstream','mixdrop','voe','upstream','files.im','rapidvid','cloudvideo','suat','wargamings','pl.','ha.vixolity','video.carnoots'];
  denemek {
    const h = new URL(u).hostname.replace(/^www\./, '').toLowerCase();
    return hosts.some(s => h.indexOf(s) >= 0) || /\.(m3u8|mp4|mkv|webm)(\?|$|#)/i.test(u);
  } catch (e) { return false; }
}

fonksiyon extractSources(html, base) {
  sabit kaynaklar = [];
  sabit görüldü = {};
  fonksiyon push(url, type, label) {
    Eğer (!url || seen[url]) yoksa, geri dön;
    if (!/^https?:\/\//i.test(url)) return;
    if (/\.(?:jpe?g|png|gif|webp|svg|ico|css|js|json|xml)(\?|$)/i.test(url)) return;
    görülen[url] = 1;
    t = tip olsun;
    Eğer t yoksa, t = /\.m3u8(\?|$|#)/i.test(url) ? 'hls' : (/\.mp4(\?|$|#)/i.test(url) ? 'mp4' : 'iframe');
    sources.push({ provider: label || (() => { try { return new URL(url).hostname; } catch (e) { return 'player'; } })(), url, type: t });
  }
  m'yi bırakalım;
  const iframeRe = /<iframe\b[^>]*?\bsrc\s*=\s*["']([^"']+)["']/gi;
  while ((m = iframeRe.exec(html)) !== null) {
    const u = absUrl(m[1], base);
    if (u && isPlayerHost(u)) push(u, null, 'iframe');
  }
  const dataRe = /data-(?:src|video|iframe|url|m3u8|mp4|frame|embed|player-src|video-src)\s*=\s*["']([^"']+)["']/gi;
  while ((m = dataRe.exec(html)) !== null) {
    sabit ham = m[1];
    if (raw.indexOf('${') >= 0) continue;
    if (/^data:/i.test(raw)) continue;
    const u = absUrl(raw, base);
    if (u && isPlayerHost(u)) push(u, null, 'data-src');
  }
  const mediaRe = /(https?:\/\/[^\s"'<>]+?\.(?:m3u8|mp4|mkv|webm)(?:\?[^\s"'<>]*)?)/gi;
  while ((m = mediaRe.exec(html)) !== null) push(m[1], null, 'media');
  const ldRe = /<script[^>]*type=["']application\/ld\+json["'][^>]*>([^<]+)<\/script>/gi;
  while ((m = ldRe.exec(html)) !== null) {
    denemek {
      sabit veri = JSON.parse(m[1]);
      const arr = Array.isArray(data) ? data : (data['@graph'] || [data]);
      (sabit o'nun arr'ı için) {
        (!o) devam et;
        Eğer o.contentUrl değeri 'string' ise, o.contentUrl'ye null ve 'json-ld' değeri atanmalıdır.
        Eğer o.embedUrl değeri 'string' ise, o.embedUrl'ye null değerini ve 'json-ld' değerini ekleyin.
      }
    } catch (e) {}
  }
  Kaynakları döndür;
}

fonksiyon pickReult(html, base, names, year, type) {
  const origin = base.match(/^https?:\/\/[^/]+/)[0];
  sabit sonuçlar = [];
  const aRe = /<a\b[^>]*\bhref=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi;
  m'yi bırakalım;
  while ((m = aRe.exec(html)) !== null) {
    let href = m[1];
    if (/^\//.test(href)) href = origin + href;
    if (!href.startsWith(origin)) continue;
    sabit yol = yeni URL(href).yoladı;
    if (/^\/(?:film|dizi|izle|diziler|category|tag|page|wp-|sitemap|ara|search|arama)\b/i.test(path)) {
      /* /film/ ve /diziler/ path'leri geçerli içerik sayfaları — hariç tutma */
      if (!/^\/(?:film|dizi|diziler|izle)\//i.test(path)) continue;
    }
    Eğer yol '/' ise veya yolun uzunluğu 3'ten az ise devam et;
    /* text + title attr + img alt — en zengin metin kaynağı */
    let text = m[2].replace(/<[^>]+>/g, ' ').replace(/&/g, '&').replace(/\s+/g, ' ').trim();
    const tagAttrs = m[0].match(/\btitle=["']([^"']+)["']/i);
    const altAttrs = m[2].match(/\balt=["']([^"']+)["']/i);
    if (!text && tagAttrs && tagAttrs[1]) text = tagAttrs[1];
    if (altAttrs && altAttrs[1] && text.length < altAttrs[1].length) text = altAttrs[1];
    Eğer metin 2'den küçükse devam et;
    const ys = text.match(/\b(19|20)\d{2}\b/g);
    const slug = path.replace(/^\/+|\/+$/g, '');
    sonuçlar.push({ slug, text, year: ys ? Number(ys[ys.length - 1]) : null, url: href });
  }
  fonksiyon norm(lar) {
    let x = String(s || '').toLowerCase().replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c');
    if (x.normalize) x = x.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return x.replace(/[^a-z0-9]+/g, ' ').replace(/^ +| +$/g, '');
  }
  let best = null, bestScore = 0;
  (sonuçların sabit bir sayısı için) {
    sabit t = norm(c.text);
    sabit slugN = norm(c.slug);
    puan = 0 olsun;
    isimler.forEach((n, idx) => {
      sabit w = norm(n);
      Eğer (!w) ise geri dön;
      /* İlk sorgu (IMDb ID hariç, orijinal isim) en yüksek öncelik */
      sabit ağırlık = idx === 0 ? 1.2 : 1;
      Eğer (t === w) ise, skor = Math.max(skor, 100 * ağırlık);
      aksi takdirde eğer (t.indexOf(w) >= 0 veya w.indexOf(t) >= 0) puan = Math.max(puan, 80 * ağırlık);
      başka {
        const a = w.split(' '), b = t.split(' ');
        n2 = 0 olsun;
        a.forEach(x => { if (x.length > 2 && b.indexOf(x) >= 0) n2++; });
        puan = Math.max(puan, 62 * n2 / Math.max(1, Math.min(a.length, b.length)) * ağırlık);
      }
      /* Slug eşleştirme — URL path'inde isim geçiyorsa güçlü sinyal */
      Eğer (slugN.indexOf(w) >= 0 veya w.indexOf(slugN) >= 0 ise) skor = Math.max(skor, 75 * ağırlık);
      başka {
        const sa = w.split(' ');
        n3 = 0 olsun;
        sa.forEach(x => { if (x.length > 2 && slugN.indexOf(x) >= 0) n3++; });
        if (n3 > 0) score = Math.max(score, 55 * n3 / Math.max(1, sa.length) * weight);
      }
    });
    /* type filtreleme: dizi arıyorsak film path'ini cezalandır, tersi de */
    if (type === 'tv' && /\/(film|filmler|fragman)\b/i.test(c.url) && !/\/(dizi|sezon|bolum)\b/i.test(c.url)) score -= 20;
    if (type === 'movie' && /\/(dizi|sezon|bolum)\b/i.test(c.url) && !/\/(film|filmler)\b/i.test(c.url)) score -= 20;
    if (year && c.year) score += Math.abs(c.year - year) <= 1 ? 12 : -8;
    Eğer puan en iyi puandan büyükse, en iyi puanı puana eşitle; en iyi puanı da c'ye eşitle.
  }
  en iyi puanı döndür >= 35 ? en iyi : null;
}

sabit önbellek = yeni bir Harita();
function cacheGet(k) { const v = cache.get(k); if (v && Date.now() - vt < 7200000) return vv; return null; }
function cacheSet(k, v) { cache.set(k, { v, t: Date.now() }); if (cache.size > 200) { const first = cache.keys().next().value; cache.delete(first); } }

app.get('/', (req, res) => res.type('text').send('MultiMedia resolver çalışıyor'));

uygulama.get('/sites', (req, res) => {
  sabit çıkış = {};
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
  sabit cfg = SITES[siteId];
  if (!cfg) return res.status(404).json({ error: 'Bilinmeyen site: ' + siteId });

  /* names sırası: server'a gelen names zaten orijinal → TR sırasında.
     IMDb ID ayrı imdb parametresi olarak gelir. */
  const names = (req.query.names || '').split('|').map(s => s.trim()).filter(Boolean);
  const year = req.query.year ? Number(req.query.year) : null;
  const type = req.query.type === 'tv' ? 'tv' : 'movie';
  sabit s = req.query.s || req.query.season;
  const e = req.query.e || req.query.episode;
  const imdbId = req.query.imdb || '';
  Eğer isim uzunluğu yeterli değilse ve imdb kimliği doğru değilse, res.json'dan site kimliğini, bulunan değeri false olarak ve kaynakları [] olarak döndürün.

  const cacheKey = siteId + ':' + names.join('|') + ':' + year + ':' + type + ':' + s + ':' + e + ':' + imdbId;
  const cached = cacheGet(cacheKey);
  Eğer önbelleğe alınmışsa, Object.assign({ cached: true }, cached)) değerini döndürün.

  denemek {
    /* 1) hdfilmdelisi vixolity doğrudan bağlantı (IMDb ID ile) */
    if (cfg.vixolity && imdbId) {
      sabit vurl = type === 'tv'
        ? 'https://ha.vixolity.com/vs/' + imdbId + '/s' + s + '/e' + (Number(e) < 10 ? '0' + e : e)
        : 'https://ha.vixolity.com/vs/' + imdbId;
      const result = { site: siteId, found: true, match: { slug: imdbId, title: names[0] || imdbId, year: year }, watchUrl: cfg.base + '/film/' + imdbId, sources: [{ provider: 'varsayilan', url: vurl, type: 'hls', referer: 'https://pl.vixolity.com/', origin: cfg.base }] };
      cacheSet(cacheKey, result);
      res.json(sonuç)'u döndür;
    }

    /* 2) carnoots kalıp (anime, type=tv) */
    if (cfg.video && type === 'tv' && s && e) {
      const slug = String(names[0] || imdbId || '').toLowerCase().replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
      const vurl = cfg.video.replace('{slug}', slug).replace('{s}', s).replace('{e}', e);
      const result = { site: siteId, found: true, match: { slug, title: names[0], year }, watchUrl: cfg.base + '/browse', sources: [{ provider: 'carnoots', url: vurl, type: 'hls', referer: '', origin: cfg.base }] };
      cacheSet(cacheKey, result);
      res.json(sonuç)'u döndür;
    }

    /* 3) hdfilmizle sitemap araması */
    if (cfg.sitemap) {
      const result = await findHdfilmizle(cfg, names, year, type);
      cacheSet(cacheKey, result);
      res.json(sonuç)'u döndür;
    }

    /* 4) Dizigom: özel player script akışı (data-pv düzeltmesi) */
    if (siteId === 'dizigom') {
      const result = await findDizigom(cfg, names, year, type, s, e);
      cacheSet(cacheKey, result);
      res.json(sonuç)'u döndür;
    }

    /* 5) ddizi: POST ile arama */
    if (cfg.searchPost) {
      const result = await findPostSite(cfg, names, year, type, 'arama=');
      cacheSet(cacheKey, result);
      res.json(sonuç)'u döndür;
    }

    /* 6) Generic: ara → en iyi sonucu seç → detay sayfasını aç → kaynak çıkar */
    if (!cfg.search) {
      const result = { site: siteId, found: false, error: 'bu site için arama yolu tanımlı değil', sources: [] };
      cacheSet(cacheKey, result);
      res.json(sonuç)'u döndür;
    }
    const searchPath = cfg.search;
    const searchUrl = cfg.base + searchPath + encodeURIComponent(names[0]);
    aramaHTML'sine izin ver;
    let usedStatic = false;
    /* Önce statik fetch (Chromium gerekmez — çok daha hızlı).
       Cloudflare challenge dönerse veya static bayrağı yoksa Puppeteer'a düş.
       region=true ise TR IP spoof ile dene (451 legal engeli aşmak için). */
    eğer (cfg.static || cfg.fallbackRender || cfg.region) {
      denemek {
        const postData = cfg.searchPost ? ('arama=' + encodeURIComponent(names[0])) : null;
        const r = await fetchStatic(searchUrl, { postData, spoofTr: !!cfg.region });
        if (r.status >= 200 && r.status < 400 && !isCloudflareChallenge(r.html) && r.html.length > 2000) {
          searchHtml = r.html;
          KullanılanStatik = true;
        }
      } catch (e) { /* statik başarısız — Puppeteer'a düş */ }
    }
    Eğer (aramaHtml yoksa) {
      denemek {
        const postData = cfg.searchPost ? ('arama=' + encodeURIComponent(names[0])) : null;
        const r = await fetchPage(searchUrl, { waitMs: 1500, postData, spoofTr: !!cfg.region });
        searchHtml = r.html;
      } hata yakala {
        const result = { site: siteId, found: false, error: 'arama başarısız: ' + err.message, sources: [] };
        cacheSet(cacheKey, result);
        res.json(sonuç)'u döndür;
      }
    }

    const best = pickResult(searchHtml, cfg.base, names, year, type);
    eğer (!en iyi) {
      const result = { site: siteId, found: false, sources: [], method: usedStatic ? 'static' : 'render' };
      cacheSet(cacheKey, result);
      res.json(sonuç)'u döndür;
    }

    detayHtml'i bırak;
    /* Detay sayfası için de önce statik (varsa), sonra Render. */
    if (usedStatic && (cfg.static || cfg.fallbackRender || cfg.region)) {
      denemek {
        const r = await fetchStatic(best.url, { spoofTr: !!cfg.region });
        if (r.status >= 200 && r.status < 400 && !isCloudflareChallenge(r.html) && r.html.length > 2000) {
          detayHtml = r.html;
        }
      } catch (e) { /* statik başarısız — Render'a düş */ }
    }
    Eğer (detailHtml) yoksa {
      denemek {
        const r = await fetchPage(best.url, { waitMs: 2500, networkIdle: true, spoofTr: !!cfg.region });
        detayHtml = r.html;
      } hata yakala {
        const result = { site: siteId, found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: best.url, fastNote: 'detay sayfa açısılamadı: ' + err.message, sources: [] };
        cacheSet(cacheKey, result);
        res.json(sonuç)'u döndür;
      }
    }

    const sources = extractSources(detailHtml, cfg.base);
    sabit sonuç = {
      site: siteId,
      bulundu: doğru,
      eşleşme: { slug: best.slug, title: best.text, year: best.year },
      watchUrl: best.url,
      yöntem: usedStatic ? 'static' : 'render',
      Kaynaklar: sources.map(s => ({ provider: s.provider, url: s.url, type: s.type, referer: '', origin: cfg.base }))
    };
    cacheSet(cacheKey, result);
    res.json(sonuç);
  } hata yakala {
    res.json({ site: siteId, found: false, error: err.message, sources: [] });
  }
});

/* Dizigom: data-pv düzeltmesi — Puppeteer ile runtime'da player script bekle. */
async function findDizigom(cfg, names, year, type, s, e) {
  const searchUrl = cfg.base + cfg.search + encodeURIComponent(names[0]);
  aramaHTML'sine izin ver;
  denemek {
    const r = await fetchPage(searchUrl, { waitMs: 1500 });
    searchHtml = r.html;
  } hata yakala {
    return { site: 'dizigom', found: false, error: 'arama: ' + err.message, sources: [] };
  }
  const best = pickResult(searchHtml, cfg.base, names, year, type);
  Eğer (!best) ise, 'dizigom' sitesini döndür, 'found' değerini ata, 'sources' değerini ata ([]) yaz.

  const watchUrl = type === 'tv'
    ? cfg.base + '/' + best.slug + '-' + s + '-season-' + e + '-volume/'
    : cfg.base + '/film/' + best.slug;

  const playerInfo = await fetchDizigomPlayer(watchUrl, cfg.base);
  if (!playerInfo || !playerInfo.dataPv) {
    return { site: 'dizigom', found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: watchUrl, fastNote: 'sayfada data-pv kapatıldı (player script çalıştırıldı)', sources: [] };
  }

  const coreScript = playerInfo.coreScript;
  if (!coreScript) {
    return { site: 'dizigom', found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: watchUrl, fastNote: 'core.js', sources: [] };
  }
  const pOrigin = coreScript.match(/^https?:\/\/[^/]+/)[0];
  const sUrl = pOrigin + '/assets/js/s.php?s=' + encodeURIComponent(playerInfo.dataPv);

  spHtml'ye izin ver;
  denemek {
    const r = await fetchPage(sUrl, { waitMs: 1000 });
    spHtml = r.html;
  } hata yakala {
    return { site: 'dizigom', found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: watchUrl, fastNote: 'playersayfa açılamadı: ' + err.message, sources: [] };
  }

  const vm = String(spHtml).match(/api\/(?:stream|token|thumb)\.php\?v=([0-9a-f]{16,64})/i);
  eğer (!vm) {
    return { site: 'dizigom', found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: watchUrl, fastNote: 'player sayfalarında video yok', sources: [] };
  }
  sabit V = vm[1];

  let took = null;
  denemek {
    const r = await fetchPage(pOrigin + '/api/token.php?v=' + V, { waitMs: 500 });
    const j = JSON.parse(r.html);
    Eğer (j && j.ok && j.token) ise, tok = j.token;
  } catch (e) {}
  eğer (!tok) {
    return { site: 'dizigom', found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: watchUrl, fastNote: 'token alınamadı', sources: [] };
  }

  const link = pOrigin + '/api/stream.php?v=' + V + '&token=' + tok;
  geri dönmek {
    site: 'dizigom',
    bulundu: doğru,
    eşleşme: { slug: best.slug, title: best.text, year: best.year },
    watchUrl: watchUrl,
    Kaynaklar: [{ sağlayıcı: 'dizigom', url: bağlantı, tür: 'hls', yönlendiren: sUrl, kaynak: pOrigin }]
  };
}

/* POST ile arama yapan siteler için (ddizi) */
asenkron fonksiyon findPostSite(cfg, isimler, yıl, tür, paramName) {
  const searchUrl = cfg.base + cfg.search;
  aramaHTML'sine izin ver;
  denemek {
    const r = await fetchPage(searchUrl, { waitMs: 1500, postData: paramName + encodeURIComponent(names[0]) });
    searchHtml = r.html;
  } hata yakala {
    return { site: cfg.base, found: false, error: 'arama: ' + err.message, sources: [] };
  }
  const best = pickResult(searchHtml, cfg.base, names, year, type);
  Eğer (!best) ise, { site: cfg.base, found: false, sources: [] } döndür;

  detayHtml'i bırak;
  denemek {
    const r = await fetchPage(best.url, { waitMs: 2500, networkIdle: true });
    detayHtml = r.html;
  } hata yakala {
    return { site: cfg.base, found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: best.url, fastNote: 'detay sayfa açısılamadı: ' + err.message, sources: [] };
  }
  const sources = extractSources(detailHtml, cfg.base);
  return { site: cfg.base, found: true, match: { slug: best.slug, title: best.text, year: best.year }, watchUrl: best.url, sources: sources.map(s => ({ provider: s.provider, url: s.url, type: s.type, referer: '', origin: cfg.base })) };
}

async function findHdfilmizle(cfg, names, year, type) {
  const sitemaps = [cfg.base + '/sitemapppz/sitemap-videolar-1.xml', cfg.base + '/sitemapppz/sitemap-videolar-2.xml'];
  fonksiyon norm(lar) {
    let x = String(s || '').toLowerCase().replace(/ı/g, 'i').replace(/ğ/g, 'g').replace(/ü/g, 'u').replace(/ş/g, 's').replace(/ö/g, 'o').replace(/ç/g, 'c');
    if (x.normalize) x = x.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    return x.replace(/[^a-z0-9]+/g, ' ').replace(/^ +| +$/g, '');
  }
  sabit allUrls = [];
  await Promise.all(sitemaps.map(async sm => {
    denemek {
      const r = await fetchPage(sm, { waitMs: 300 });
      const re = /<loc>([^<]+)<\/loc>/g;
      m'yi bırakalım;
      while ((m = re.exec(r.html)) !== null) {
        sabit u = m[1];
        if (u.startsWith(cfg.base + '/') && !/\/(?:sitemap|wp-|category|tag|page|author)\b/i.test(u)) {
          const slug = new URL(u).pathname.replace(/^\/+|\/+$/g, '');
          Eğer '/' dizinine sahip değilse, allUrls.push({ slug, url: u });
        }
      }
    } catch (e) {}
  }));

  let best = null, bestScore = 0;
  (tüm URL'lerin sabit öğesi için) {
    const slugTitle = norm(item.slug.replace(/[-_]+/g, ' ').replace(/\bizle\b/gi, '').replace(/\bhd\b/gi, '').trim());
    if (!slugTitle) continue;
    puan = 0 olsun;
    isimler.forEach((n, idx) => {
      sabit w = norm(n);
      Eğer (!w) ise geri dön;
      sabit ağırlık = idx === 0 ? 1.2 : 1;
      if (slugTitle === w) score = Math.max(score, 100 * weight);
      aksi takdirde eğer (slugTitle.indexOf(w) >= 0 veya w.indexOf(slugTitle) >= 0) puan = Math.max(puan, 80 * ağırlık);
      başka {
        const a = w.split(' '), b = slugTitle.split(' ');
        n2 = 0 olsun;
        a.forEach(x => { if (x.length > 2 && b.indexOf(x) >= 0) n2++; });
        puan = Math.max(puan, 62 * n2 / Math.max(1, Math.min(a.length, b.length)) * ağırlık);
      }
    });
    Eğer puan en iyi puandan büyükse, en iyi puanı puana eşitle; en iyi puanı da öğeye eşitle.
  }
  Eğer (!best || bestScore < 50) ise, 'hdfilmizle' sitesini, bulunan değeri false olarak ve kaynakları [] olarak döndür;

  denemek {
    const r = await fetchPage(best.url, { waitMs: 2500, networkIdle: true });
    const sources = extractSources(r.html, cfg.base);
    return { site: 'hdfilmizle', found: true, match: { slug: best.slug, title: best.slug, year: null }, watchUrl: best.url, sources: sources.map(s => ({ provider: s.provider, url: s.url, type: s.type, referer: '', origin: cfg.base })) };
  } yakala (e) {
    return { site: 'hdfilmizle', found: true, match: { slug: best.slug, title: best.slug, year: null }, watchUrl: best.url, fastNote: e.message, sources: [] };
  }
}

sabit sunucu = uygulama.dinle(PORT, () => {
  console.log('Multimedya işleme sunucusu ' + PORT + port numarasında dinliyor');
});
server.timeout = 120000; /* 2 dakika — eski 5dk yerine hızlı */
