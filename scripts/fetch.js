/* scripts/fetch.js — Bihari News data generator */
const Parser = require('rss-parser');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');

/* ---------- GLOBAL SAFETY ---------- */
process.on('unhandledRejection', (err) => {
  console.error('⚠️  Unhandled rejection:', err && err.message ? err.message : err);
});
process.on('uncaughtException', (err) => {
  console.error('⚠️  Uncaught exception:', err && err.message ? err.message : err);
});

/* ---------- CONFIG ---------- */
const CONFIG = {
  MAX_ITEMS: 70,
  SCRAPE_CONCURRENCY: 8,
  REQUEST_TIMEOUT: 15000,
  MAX_PARAGRAPHS: 40,
  MIN_PARA_LENGTH: 40,
  MAX_IMAGES: 8,
  RETRY_ATTEMPTS: 2,
  RETRY_DELAY: 1000,
  MAX_AGE_HOURS: 72,
  REUSE_WINDOW_HOURS: 48,
  USER_AGENT:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
};

const FEEDS = [
  { url: 'https://news.google.com/rss/search?q=%22Bihar%20government%22%20yojana&hl=hi-IN&gl=IN&ceid=IN:hi', tag: 'scheme' },
  { url: 'https://news.google.com/rss/search?q=Bihar%20scheme&hl=en-IN&gl=IN&ceid=IN:en', tag: 'scheme' },
  { url: 'https://news.google.com/rss/search?q=Bihar%20government%20policy&hl=en-IN&gl=IN&ceid=IN:en', tag: 'rule' },
  { url: 'https://news.google.com/rss/search?q=Bihar%20news&hl=hi-IN&gl=IN&ceid=IN:hi', tag: 'news' },
  { url: 'https://news.google.com/rss/search?q=Bihar&hl=en-IN&gl=IN&ceid=IN:en', tag: 'news' },
  { url: 'https://news.google.com/rss/search?q=Patna%20news&hl=en-IN&gl=IN&ceid=IN:en', tag: 'news' }
];

/* ---------- HELPERS ---------- */
const stripHtml = (s) =>
  !s
    ? ''
    : s
        .replace(/<[^>]*>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ')
        .trim();

const uid = (s) => {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  return 'u' + Math.abs(h).toString(36);
};

const hostOf = (url) => {
  try { return new URL(url).hostname.replace(/^www\./, ''); } catch { return ''; }
};

const absolutize = (href, base) => {
  if (!href || href.startsWith('data:')) return '';
  try { return new URL(href, base).href; } catch { return ''; }
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchWithTimeout(url, opts = {}, timeoutMs = CONFIG.REQUEST_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      ...opts,
      signal: controller.signal,
      headers: {
        'User-Agent': CONFIG.USER_AGENT,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'hi-IN,hi;q=0.9,en;q=0.8',
        ...(opts.headers || {})
      },
      redirect: 'follow'
    });
    return res;
  } finally {
    clearTimeout(timer);
  }
}

async function fetchWithRetry(url, opts = {}) {
  let lastErr;
  for (let i = 0; i < CONFIG.RETRY_ATTEMPTS; i++) {
    try {
      const res = await fetchWithTimeout(url, opts);
      if (res.ok) return res;
      lastErr = new Error('HTTP ' + res.status);
    } catch (e) { lastErr = e; }
    if (i < CONFIG.RETRY_ATTEMPTS - 1) await sleep(CONFIG.RETRY_DELAY * (i + 1));
  }
  throw lastErr || new Error('fetch failed');
}

function categorize(item) {
  const t = (item.title + ' ' + (item.desc || '')).toLowerCase();
  if (/योजना|scheme|yojana|benefit|लाभ|subsidy|सब्सिडी|आवास|pension|पेंशन|राशन|ration|kisan|किसान|awas|ujjwala|उज्ज्वला|scholarship|छात्रवृत्ति/i.test(t)) return 'scheme';
  if (/नियम|rule|regulation|अधिसूचना|advisory|order|आदेश|कानून|law|act\b|policy|नीति/i.test(t)) return 'rule';
  if (/घोषणा|announce|declared|launch|शुरू|शुभारंभ|inaugurat/i.test(t)) return 'announce';
  if (/सूचना|notice|notification|alert|चेतावनी|warning|deadline|अंतिम तिथि/i.test(t)) return 'notify';
  return 'news';
}

function isBiharRelevant(item) {
  const text = (item.title + ' ' + (item.desc || '') + ' ' + (item.source || '')).toLowerCase();
  return /bihar|बिहार|patna|पटना|nitish|tejashwi|samrat|sushil|gopalganj|muzaffarpur|gaya|भागलपुर|darbhanga|purnia|chapra|saran|siwan|araria|madhubani|सरकार|योजना|government|scheme|मुख्यमंत्री/.test(text);
}

/* ---------- ARTICLE PARSER ---------- */
const JUNK_SELECTORS = [
  'script,style,noscript,iframe,svg,form,button,input,textarea',
  'nav,header,footer,aside,[role="navigation"],[role="banner"],[role="complementary"]',
  '[aria-hidden="true"]',
  '.ad,.ads,.advert,.advertisement,.sponsored,.promo',
  '.social,.share,.sharing,.comments,.comment,.sidebar,.menu,.breadcrumb',
  '.related,.recommended,.newsletter,.subscribe',
  '[class*="advert"],[class*="sponsor"],[class*="social"],[class*="share-"]',
  '[class*="comment"],[class*="related"],[class*="recommend"]',
  '[class*="newsletter"],[class*="subscribe"],[id*="advert"],[id*="comment"]'
];

const BODY_SELECTORS = [
  '[itemprop="articleBody"]',
  '.article-body','.articleBody','.article-content','.article__body','.article__content',
  '.story-body','.story-content','.story__content','.post-content','.post-body','.post__content',
  '.entry-content','.content-body','.content__body','.news-content','.news-detail','.detail-content',
  '.td-post-content','.article-text','.article-detail','article','main'
];

function parseArticleHtml(html, sourceUrl) {
  const $ = cheerio.load(html);
  JUNK_SELECTORS.forEach((sel) => { try { $(sel).remove(); } catch {} });

  let ogImage =
    $('meta[property="og:image:secure_url"]').attr('content') ||
    $('meta[property="og:image"]').attr('content') ||
    $('meta[name="twitter:image"]').attr('content') ||
    $('link[rel="image_src"]').attr('href') || '';
  ogImage = absolutize(ogImage, sourceUrl);

  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="twitter:title"]').attr('content') ||
    $('h1').first().text().trim() ||
    $('title').text().trim() || '';

  const author =
    $('meta[name="author"]').attr('content') ||
    $('[rel="author"]').first().text().trim() || '';

  const publishedAt =
    $('meta[property="article:published_time"]').attr('content') ||
    $('time[datetime]').first().attr('datetime') || '';

  let container = null;
  for (const sel of BODY_SELECTORS) {
    const el = $(sel).first();
    if (el.length && el.find('p').length >= 3) { container = el; break; }
  }
  if (!container || !container.length) container = $('body');

  const paragraphs = [];
  const seen = new Set();
  container.find('p').each((_, el) => {
    if (paragraphs.length >= CONFIG.MAX_PARAGRAPHS) return;
    const txt = $(el).text().replace(/\s+/g, ' ').trim();
    if (txt.length < CONFIG.MIN_PARA_LENGTH) return;
    if (/^(share|subscribe|follow us|read more|advertisement|copyright|©|photo:|image:|credit:|tags?:)/i.test(txt)) return;
    const key = txt.slice(0, 60).toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    paragraphs.push(txt);
  });

  const images = [];
  const imgSeen = new Set();
  if (ogImage) imgSeen.add(ogImage.split('?')[0]);
  container.find('img').each((_, el) => {
    if (images.length >= CONFIG.MAX_IMAGES) return;
    const src =
      $(el).attr('data-src') ||
      $(el).attr('data-lazy-src') ||
      $(el).attr('data-original') ||
      ($(el).attr('data-srcset') || '').split(',')[0].trim().split(' ')[0] ||
      $(el).attr('src') || '';
    const abs = absolutize(src, sourceUrl);
    if (!abs) return;
    if (/logo|icon|avatar|pixel|tracker|spacer|blank|1x1|\.svg$/i.test(abs)) return;
    const w = parseInt($(el).attr('width') || '0', 10);
    const h = parseInt($(el).attr('height') || '0', 10);
    if ((w && w < 200) || (h && h < 150)) return;
    const base = abs.split('?')[0];
    if (imgSeen.has(base)) return;
    imgSeen.add(base);
    images.push({ src: abs, alt: ($(el).attr('alt') || '').trim() });
  });

  return { ogImage, title, author, publishedAt, paragraphs, images };
}

async function resolveGoogleNewsUrl(url) {
  if (!url.includes('news.google.com')) return url;
  try {
    const res = await fetchWithTimeout(url, {}, 10000);
    if (res.url && !res.url.includes('news.google.com')) return res.url;
    const html = await res.text();
    const $ = cheerio.load(html);
    const meta = $('meta[http-equiv="refresh"]').attr('content');
    if (meta) {
      const m = meta.match(/url=(.+)$/i);
      if (m && m[1]) return m[1].trim();
    }
  } catch {}
  return url;
}

async function scrapeArticle(url) {
  try {
    const res = await fetchWithRetry(url);
    const finalUrl = res.url || url;
    const html = await res.text();
    if (!html || html.length < 500) return null;
    const parsed = parseArticleHtml(html, finalUrl);
    parsed.resolvedLink = finalUrl;
    return parsed;
  } catch (e) {
    return null;
  }
}

/* ---------- CONCURRENCY POOL ---------- */
async function runPool(items, worker, concurrency) {
  const results = new Array(items.length);
  let index = 0;
  const runners = Array.from({ length: concurrency }, async () => {
    while (true) {
      const i = index++;
      if (i >= items.length) break;
      try { results[i] = await worker(items[i], i); }
      catch { results[i] = null; }
    }
  });
  await Promise.all(runners);
  return results;
}

/* ---------- MAIN ---------- */
async function main() {
  const outDir = path.join(process.cwd(), 'data');
  const outPath = path.join(outDir, 'news.json');
  if (!fs.existsSync(outDir)) fs.mkdirSync(outDir, { recursive: true });

  /* load existing */
  let existing = [];
  try {
    if (fs.existsSync(outPath)) {
      const parsed = JSON.parse(fs.readFileSync(outPath, 'utf8'));
      if (Array.isArray(parsed)) existing = parsed;
    }
  } catch (e) {
    console.log('  (existing file unreadable, starting fresh)');
  }
  const existingMap = new Map(existing.map((it) => [it.id, it]));
  console.log(`Existing items: ${existing.length}`);

  /* ---- STEP 1: RSS ---- */
  console.log(`\n[1/3] Fetching ${FEEDS.length} RSS feeds...`);
  const parser = new Parser({
    timeout: CONFIG.REQUEST_TIMEOUT,
    headers: { 'User-Agent': CONFIG.USER_AGENT }
  });

  const rssResults = await Promise.allSettled(
    FEEDS.map(async (f) => {
      try {
        const feed = await parser.parseURL(f.url);
        console.log(`  ✓ ${f.tag}: ${feed.items.length} items`);
        return feed.items.map((it) => {
          const title = stripHtml(it.title || '');
          let desc = stripHtml(it.contentSnippet || it.content || it.summary || '');
          if (desc.startsWith(title)) desc = desc.slice(title.length).replace(/^[\s\-–—|:]+/, '').trim();
          if (desc.length > 320) desc = desc.slice(0, 320).trim() + '…';
          return {
            id: uid(title + it.link),
            title,
            link: it.link,
            desc,
            source: stripHtml(it.creator || '') || hostOf(it.link),
            ts: it.pubDate ? new Date(it.pubDate).getTime() : Date.now(),
            feedTag: f.tag
          };
        });
      } catch (e) {
        console.log(`  ✗ ${f.tag}: ${e.message}`);
        return [];
      }
    })
  );

  let all = [];
  rssResults.forEach((r) => { if (r.status === 'fulfilled' && Array.isArray(r.value)) all.push(...r.value); });
  console.log(`  Total raw RSS items: ${all.length}`);

  /* ---- STEP 2: filter ---- */
  const seen = new Set();
  all = all.filter((it) => {
    if (!it.title || !it.link) return false;
    if (seen.has(it.id)) return false;
    seen.add(it.id);
    return true;
  });

  all = all.filter(isBiharRelevant);
  const cutoff = Date.now() - CONFIG.MAX_AGE_HOURS * 3600 * 1000;
  all = all.filter((it) => it.ts >= cutoff);
  all.sort((a, b) => b.ts - a.ts);
  all = all.slice(0, CONFIG.MAX_ITEMS);
  all.forEach((it) => { it.cat = categorize(it); });

  console.log(`\n[2/3] After filter: ${all.length} items to enrich`);

  /* ---- STEP 3: scrape ---- */
  let scraped = 0, reused = 0, failed = 0;

  const enriched = await runPool(
    all,
    async (item) => {
      const old = existingMap.get(item.id);
      const canReuse =
        old &&
        Array.isArray(old.paragraphs) &&
        old.paragraphs.length >= 2 &&
        old.scrapedAt &&
        Date.now() - old.scrapedAt < CONFIG.REUSE_WINDOW_HOURS * 3600 * 1000;

      if (canReuse) {
        reused++;
        return { ...item, ...old, ...item };
      }

      let realUrl = item.link;
      if (realUrl.includes('news.google.com')) realUrl = await resolveGoogleNewsUrl(realUrl);

      const s = await scrapeArticle(realUrl);

      if (s && s.paragraphs && s.paragraphs.length >= 2) {
        scraped++;
        return {
          ...item,
          image: s.ogImage || null,
          images: s.images || [],
          paragraphs: s.paragraphs,
          author: s.author || '',
          publishedAt: s.publishedAt || '',
          resolvedLink: s.resolvedLink || realUrl,
          scrapedAt: Date.now()
        };
      }

      if (s && s.ogImage) {
        failed++;
        return { ...item, image: s.ogImage, images: s.images || [], paragraphs: [], resolvedLink: realUrl, scrapedAt: Date.now() };
      }

      failed++;
      return {
        ...item,
        image: (old && old.image) || null,
        images: (old && old.images) || [],
        paragraphs: (old && old.paragraphs) || [],
        resolvedLink: realUrl,
        scrapedAt: Date.now()
      };
    },
    CONFIG.SCRAPE_CONCURRENCY
  );

  const finalItems = enriched.filter(Boolean);

  console.log(`\n[3/3] Results:`);
  console.log(`  Scraped fresh : ${scraped}`);
  console.log(`  Reused cache  : ${reused}`);
  console.log(`  Failed/partial: ${failed}`);
  console.log(`  Total         : ${finalItems.length}`);

  fs.writeFileSync(outPath, JSON.stringify(finalItems, null, 2));
  const sizeKB = (fs.statSync(outPath).size / 1024).toFixed(1);
  console.log(`\n✅ Saved ${finalItems.length} items → data/news.json (${sizeKB} KB)`);
}

main()
  .then(() => { console.log('Done.'); process.exit(0); })
  .catch((e) => {
    console.error('❌ FATAL:', e && e.stack ? e.stack : e);
    process.exit(1);
  });
