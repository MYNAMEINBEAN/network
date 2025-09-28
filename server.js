// server.js
// Minimal Express server that fetches a target URL, extracts resources and probes them.

const express = require('express');
const cheerio = require('cheerio');
const path = require('path');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

const MAX_RESOURCES = 200;
const TIMEOUT = 20000; // ms
const CSS_FETCH_TIMEOUT = 8000;
const CONCURRENCY = 8;

function isBlockedUrl(u) {
  try {
    const url = new URL(u);
    if (!['http:', 'https:'].includes(url.protocol)) return true;
    const host = url.hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
    if (host.endsWith('.local')) return true;
    if (/^(10\.|127\.|192\.168\.|169\.254\.)/.test(host)) return true;
    return false;
  } catch (e) {
    return true;
  }
}

function absoluteUrl(base, relative) {
  try {
    return new URL(relative, base).href;
  } catch (e) {
    return null;
  }
}

function findCssUrls(cssText, base) {
  const urls = [];
  const re = /url\(\s*['"]?([^'")]+)['"]?\s*\)/g;
  let m;
  while ((m = re.exec(cssText)) !== null) {
    const u = absoluteUrl(base, m[1]);
    if (u) urls.push(u);
  }
  return urls;
}

async function fetchWithTimeout(url, opts = {}, timeout = TIMEOUT) {
  const controller = new AbortController();
  const signal = controller.signal;
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const r = await fetch(url, { ...opts, signal, redirect: 'follow' });
    clearTimeout(timer);
    return r;
  } catch (e) {
    clearTimeout(timer);
    throw e;
  }
}

async function probeResource(resourceUrl) {
  const result = {
    url: resourceUrl,
    status: null,
    ok: false,
    contentType: null,
    size: null,
    timeMs: null,
    methodTried: null,
    error: null
  };

  const start = Date.now();
  try {
    result.methodTried = 'HEAD';
    let res = await fetchWithTimeout(resourceUrl, { method: 'HEAD' }, TIMEOUT);
    if (res.status === 405 || res.status === 501) {
      result.methodTried = 'GET';
      res = await fetchWithTimeout(resourceUrl, { method: 'GET' }, TIMEOUT);
    }
    result.status = res.status;
    result.ok = res.ok;
    result.contentType = res.headers.get('content-type') || null;
    const cl = res.headers.get('content-length');
    if (cl) result.size = parseInt(cl, 10);
    if ((!result.size || isNaN(result.size)) && result.methodTried === 'GET') {
      try {
        const buf = await res.arrayBuffer();
        result.size = buf.byteLength;
      } catch (e) {
        // ignore
      }
    }
  } catch (err) {
    result.error = String(err.message || err);
  } finally {
    result.timeMs = Date.now() - start;
  }
  return result;
}

app.post('/api/inspect', async (req, res) => {
  try {
    const target = (req.body && req.body.url || '').trim();
    if (!target) return res.status(400).json({ error: 'Missing url in body' });
    if (isBlockedUrl(target)) return res.status(400).json({ error: 'URL blocked (private or non-http(s) scheme)' });

    // Fetch main document
    let pageResp;
    let html = '';
    const tStart = Date.now();
    try {
      pageResp = await fetchWithTimeout(target, { method: 'GET' }, TIMEOUT);
      html = await pageResp.text();
    } catch (err) {
      return res.status(502).json({ error: 'Failed to fetch target URL', detail: String(err.message || err) });
    }
    const mainTime = Date.now() - tStart;

    // parse for resources
    const $ = cheerio.load(html);
    const resources = new Map();

    function pushUrl(u, initiator) {
      if (!u) return;
      if (isBlockedUrl(u)) return;
      if (!resources.has(u)) resources.set(u, { url: u, initiator });
    }

    $('script[src]').each((_, el) => pushUrl(absoluteUrl(target, $(el).attr('src')), 'script'));
    $('img').each((_, el) => {
      const src = $(el).attr('src') || $(el).attr('data-src');
      pushUrl(absoluteUrl(target, src), 'img');
      const srcset = $(el).attr('srcset');
      if (srcset) {
        srcset.split(',').forEach(part => {
          const url = part.trim().split(/\s+/)[0];
          pushUrl(absoluteUrl(target, url), 'img-srcset');
        });
      }
    });
    $('link[rel="stylesheet"]').each((_, el) => pushUrl(absoluteUrl(target, $(el).attr('href')), 'stylesheet'));
    $('link[rel="preload"][href]').each((_, el) => pushUrl(absoluteUrl(target, $(el).attr('href')), 'preload'));
    $('iframe').each((_, el) => pushUrl(absoluteUrl(target, $(el).attr('src')), 'iframe'));
    $('audio,video,source').each((_, el) => pushUrl(absoluteUrl(target, $(el).attr('src')), 'media'));
    $('[style]').each((_, el) => {
      const style = $(el).attr('style') || '';
      findCssUrls(style, target).forEach(u => pushUrl(u, 'inline-style'));
    });
    $('style').each((_, el) => {
      const css = $(el).html() || '';
      findCssUrls(css, target).forEach(u => pushUrl(u, 'style-tag'));
    });

    const cssLinks = [];
    $('link[rel="stylesheet"]').each((_, el) => {
      const href = $(el).attr('href');
      if (href) cssLinks.push(absoluteUrl(target, href));
    });

    // build initial toProbe array
    const toProbe = [];
    for (const [u, meta] of resources) {
      if (toProbe.length >= MAX_RESOURCES) break;
      toProbe.push({ url: u, initiator: meta.initiator });
    }

    // fetch CSS and add url()s found
    for (const cssUrl of cssLinks) {
      if (!cssUrl || toProbe.length >= MAX_RESOURCES) break;
      if (isBlockedUrl(cssUrl)) continue;
      try {
        const r = await fetchWithTimeout(cssUrl, { method: 'GET' }, CSS_FETCH_TIMEOUT);
        if (r.ok) {
          const cssText = await r.text();
          const extra = findCssUrls(cssText, cssUrl);
          for (const u of extra) {
            if (toProbe.length >= MAX_RESOURCES) break;
            if (!toProbe.find(x => x.url === u)) toProbe.push({ url: u, initiator: 'css-url' });
          }
        }
      } catch (e) {
        // ignore css fetch errors
      }
    }

    // Ensure main doc is first
    const probes = [{ url: target, initiator: 'document', mainStatus: { status: pageResp.status, ok: pageResp.ok, contentType: pageResp.headers.get('content-type') }, mainTimeMs: mainTime }]
      .concat(toProbe.filter(t => t.url !== target).slice(0, MAX_RESOURCES));

    // probe with limited concurrency
    const results = [];
    for (let i = 0; i < probes.length; i += CONCURRENCY) {
      const chunk = probes.slice(i, i + CONCURRENCY);
      const promises = chunk.map(async (item) => {
        try {
          const info = await probeResource(item.url);
          info.initiator = item.initiator || null;
          return info;
        } catch (e) {
          return { url: item.url, error: String(e.message || e) };
        }
      });
      const chunkResults = await Promise.all(promises);
      results.push(...chunkResults);
    }

    res.json({
      fetchedUrl: target,
      main: probes[0].mainStatus ? { status: probes[0].mainStatus.status, ok: probes[0].mainStatus.ok, contentType: probes[0].mainStatus.contentType, timeMs: probes[0].mainTimeMs } : null,
      resources: results.slice(0, MAX_RESOURCES),
      note: `Limited to ${MAX_RESOURCES} resources. Dynamic requests (XHR/fetch inserted by page JS) won't be captured because the tool does not execute page JS.`
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Internal error', detail: String(err.message || err) });
  }
});

// health
app.get('/health', (req, res) => res.send('ok'));

// start
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Network inspector listening on ${PORT}`));
