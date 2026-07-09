#!/usr/bin/env node

import { spawn } from "node:child_process";
import http from "node:http";

const PAGE_URL = "https://www.cuatro.com/en-directo/";
const FALLBACK_CONFIG_URL =
  "https://mab.mediaset.es/1.0.0/get?oid=bitban_api&eid=%2Fapi%2Fcms%2Fcuatro%2Fvideos%2FMDSVST20210525_0003%2Fconfig%2Ffinal.json%3Fplatform%3Dmultisite";

const PLAYERS = new Set(["vlc", "mpv", "ffplay"]);
const TOKEN_REFRESH_MARGIN_MS = 120_000;
const FALLBACK_REFRESH_MS = 10 * 60_000;
const TOKEN_QUERY_KEYS = new Set([
  "hdntl",
  "hdnts",
  "token",
  "sig",
  "exp",
  "acl",
  "auth",
  "policy",
  "signature",
  "key-pair-id",
]);

function usage(exitCode = 0) {
  const out = exitCode === 0 ? process.stdout : process.stderr;
  out.write(`Usage: node cuatro-live.mjs [options]

Resolve the current Cuatro live HLS URL through the same public service chain
used by the web player: page config -> delivery -> GBX -> Cerbero token.

Options:
  --print                 Print the tokenized HLS URL.
  --player <name>         Launch vlc, mpv, or ffplay with the resolved URL.
  --serve                 Print a localhost HLS URL and keep a token-rewriting proxy running.
  --quality <value>       Variant to select: best, 1080, 720, 576, or audio. Default: best.
  --prefer <cdn>          Prefer akamai or fastly. Default: akamai.
  --platform <name>       Override Mediaset service platform path for probing. Default: page config.
  --list                  List verified stream candidates and variants, then exit.
  --lgs                   Prefer the sign-language HD stream when available.
  --no-verify             Do not fetch candidate playlists before selecting.
  --json                  Print machine-readable metadata. Redacts token unless --print is also set.
  --verbose               Print non-secret resolution details.
  --timeout <ms>          Request timeout. Default: 15000.
  --help                  Show this help.

Examples:
  node cuatro-live.mjs --print
  node cuatro-live.mjs --player vlc
  node cuatro-live.mjs --serve
  node cuatro-live.mjs --quality 720 --player mpv
  node cuatro-live.mjs --prefer fastly --player mpv
  node cuatro-live.mjs --lgs --print
`);
  process.exit(exitCode);
}

function parseArgs(argv) {
  const opts = {
    print: false,
    player: null,
    serve: false,
    quality: "best",
    prefer: "akamai",
    platform: null,
    list: false,
    lgs: false,
    verify: true,
    json: false,
    verbose: false,
    timeoutMs: 15_000,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") usage(0);
    if (arg === "--print") {
      opts.print = true;
    } else if (arg === "--player") {
      opts.player = argv[++i];
      if (!opts.player) throw new Error("--player requires a value");
      if (!PLAYERS.has(opts.player)) {
        throw new Error(`Unsupported player '${opts.player}'. Use vlc, mpv, or ffplay.`);
      }
    } else if (arg === "--serve") {
      opts.serve = true;
    } else if (arg === "--quality") {
      opts.quality = parseQualityArg(argv[++i]);
    } else if (arg === "--prefer") {
      opts.prefer = argv[++i];
      if (!opts.prefer) throw new Error("--prefer requires a value");
      if (!["akamai", "fastly"].includes(opts.prefer)) {
        throw new Error("--prefer must be akamai or fastly");
      }
    } else if (arg === "--platform") {
      opts.platform = argv[++i];
      if (!opts.platform) throw new Error("--platform requires a value");
    } else if (arg === "--list") {
      opts.list = true;
    } else if (arg === "--lgs") {
      opts.lgs = true;
    } else if (arg === "--no-verify") {
      opts.verify = false;
    } else if (arg === "--json") {
      opts.json = true;
    } else if (arg === "--verbose") {
      opts.verbose = true;
    } else if (arg === "--timeout") {
      const raw = argv[++i];
      if (!raw) throw new Error("--timeout requires a value");
      opts.timeoutMs = Number.parseInt(raw, 10);
      if (!Number.isFinite(opts.timeoutMs) || opts.timeoutMs <= 0) {
        throw new Error("--timeout must be a positive integer");
      }
    } else {
      throw new Error(`Unknown option '${arg}'`);
    }
  }

  return opts;
}

function parseQualityArg(raw) {
  if (!raw) throw new Error("--quality requires a value");
  const normalized = String(raw).trim().toLowerCase().replace(/p$/, "");
  if (normalized === "best" || normalized === "auto" || normalized === "max") return "best";
  if (normalized === "audio") return "audio";
  const height = Number.parseInt(normalized, 10);
  if (!Number.isFinite(height) || height <= 0) {
    throw new Error("--quality must be best, audio, or a vertical resolution like 1080/720/576");
  }
  return height;
}

function decodeHtmlEntities(input) {
  return input
    .replaceAll("&amp;", "&")
    .replaceAll("&quot;", "\"")
    .replaceAll("&#34;", "\"")
    .replaceAll("&#x22;", "\"")
    .replaceAll("&apos;", "'")
    .replaceAll("&#39;", "'")
    .replaceAll("&#x27;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">");
}

function redactToken(value) {
  if (!value) return value;
  return value
    .replace(/([?&](?:hdntl|hdnts|token|sig|exp|acl|auth|Policy|Signature|Key-Pair-Id)=)[^&]+/gi, "$1<redacted>")
    .replace(/([?&][^=&]*(?:token|sig|auth)[^=&]*=)[^&]+/gi, "$1<redacted>");
}

function appendUrlSuffix(url, suffix) {
  if (!suffix) return url;
  const clean = String(suffix).trim();
  if (!clean) return url;

  const parsed = stripTokenQueryParams(url);
  const suffixParams = new URLSearchParams(clean.replace(/^[?&]/, ""));
  for (const key of suffixParams.keys()) {
    parsed.searchParams.delete(key);
  }
  url = parsed.href;

  if (clean.startsWith("?")) {
    return url.includes("?") ? `${url}&${clean.slice(1)}` : `${url}${clean}`;
  }
  if (clean.startsWith("&")) {
    return url.includes("?") ? `${url}${clean}` : `${url}?${clean.slice(1)}`;
  }
  return url.includes("?") ? `${url}&${clean}` : `${url}?${clean}`;
}

function stripTokenQueryParams(url) {
  const parsed = new URL(url);
  for (const key of [...parsed.searchParams.keys()]) {
    if (TOKEN_QUERY_KEYS.has(key.toLowerCase()) || /(?:token|sig|auth)/i.test(key)) {
      parsed.searchParams.delete(key);
    }
  }
  return parsed;
}

function extractTokenSuffix(url) {
  const parsed = new URL(url);
  const rawQuery = parsed.search ? parsed.search.slice(1).split("&") : [];
  const tokenPairs = [];
  for (const pair of rawQuery) {
    const key = pair.split("=", 1)[0] || "";
    if (TOKEN_QUERY_KEYS.has(key.toLowerCase()) || /(?:token|sig|auth)/i.test(key)) {
      tokenPairs.push(pair);
    }
  }
  return tokenPairs.length ? `?${tokenPairs.join("&")}` : null;
}

function parseTokenExpiresAt(tokenSuffix) {
  if (!tokenSuffix) return null;
  const params = new URLSearchParams(String(tokenSuffix).replace(/^[?&]/, ""));
  for (const value of params.values()) {
    const expMatch = String(value).match(/(?:^|~)exp=(\d+)(?:~|$)/);
    if (expMatch) return Number.parseInt(expMatch[1], 10) * 1000;

    const hdntlMatch = String(value).match(/^(\d+)-/);
    if (hdntlMatch) return Number.parseInt(hdntlMatch[1], 10) * 1000;
  }
  return null;
}

function replacePlatformSegment(url, platform) {
  if (!platform || !url) return url;
  return url
    .replace(/\/multisite(?=\/|$)/gi, `/${platform}`)
    .replace(/%2Fmultisite(?=%2F|$)/gi, `%2F${encodeURIComponent(platform)}`);
}

function applyPlatformOverride(config, platform) {
  if (!platform) return config;
  const next = structuredClone(config);
  for (const [key, value] of Object.entries(next.services || {})) {
    if (typeof value === "string") {
      next.services[key] = replacePlatformSegment(value, platform);
    }
  }
  return next;
}

function createTimeout(ms) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), ms);
  return { controller, timeout };
}

function browserHeaders(extra = {}) {
  return {
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "es-ES,es;q=0.9,en;q=0.8",
    "Origin": "https://www.cuatro.com",
    "User-Agent":
      "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148 Safari/537.36",
    "Referer": PAGE_URL,
    ...extra,
  };
}

async function fetchText(url, opts = {}) {
  const { timeoutMs = 15_000, headers = {}, method = "GET", body, credentials } = opts;
  const { controller, timeout } = createTimeout(timeoutMs);
  try {
    const response = await fetch(url, {
      method,
      body,
      credentials,
      signal: controller.signal,
      headers: browserHeaders(headers),
    });
    const text = await response.text();
    if (!response.ok) {
      throw new Error(
        `HTTP ${response.status} for ${redactToken(url)}: ${text.slice(0, 300).replace(/\s+/g, " ")}`
      );
    }
    return { text, response };
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error(`Timed out after ${timeoutMs}ms fetching ${redactToken(url)}`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchJson(url, opts = {}) {
  const { text, response } = await fetchText(url, opts);
  try {
    return { json: JSON.parse(text), response };
  } catch (error) {
    throw new Error(`Invalid JSON from ${redactToken(url)}: ${error.message}`);
  }
}

function discoverConfigUrl(pageHtml) {
  const decoded = decodeHtmlEntities(pageHtml);
  const candidates = [];

  for (const match of decoded.matchAll(/"dataConfig"\s*:\s*\[0,\s*"([^"]+(?:\/|%2F)config(?:\/|%2F)final\.json[^"]*)"\]/gi)) {
    candidates.push(match[1]);
  }

  for (const match of decoded.matchAll(/https:\/\/mab\.mediaset\.es\/1\.0\.0\/get\?oid=bitban_api[^"'\s<>]+(?:\/|%2F)config(?:\/|%2F)final\.json[^"'\s<>]*/gi)) {
    candidates.push(match[0]);
  }

  return candidates.find((url) => url.includes("%2Fapi%2Fcms%2Fcuatro%2Fvideos%2F")) || null;
}

async function getConfigUrl(opts) {
  try {
    const { text } = await fetchText(PAGE_URL, { timeoutMs: opts.timeoutMs });
    const discovered = discoverConfigUrl(text);
    if (discovered) {
      return {
        url: discovered,
        discovered: true,
        platform: opts.platform,
      };
    }
    return {
      url: FALLBACK_CONFIG_URL,
      discovered: false,
      platform: opts.platform,
    };
  } catch (error) {
    if (opts.verbose) {
      console.error(`Could not inspect page, using fallback config: ${error.message}`);
    }
    return {
      url: FALLBACK_CONFIG_URL,
      discovered: false,
      platform: opts.platform,
    };
  }
}

function ensureConfig(config) {
  if (!config || typeof config !== "object") throw new Error("Config response was not an object");
  if (!config.services || typeof config.services !== "object") {
    throw new Error("Config response did not include services");
  }
  if (!config.services.caronte) throw new Error("Config response did not include services.caronte");
  if (!config.services.gbx) throw new Error("Config response did not include services.gbx");
}

function ensureDelivery(delivery) {
  if (!delivery || typeof delivery !== "object") throw new Error("Delivery response was not an object");
  if (!Array.isArray(delivery.dls) || delivery.dls.length === 0) {
    throw new Error("Delivery response did not include stream locations");
  }
  if (!delivery.cerbero) throw new Error("Delivery response did not include Cerbero URL");
  if (!delivery.bbx) throw new Error("Delivery response did not include bbx");
}

function candidateScore(candidate, opts) {
  let score = 0;
  const quality = String(candidate.quality || "").toLowerCase();
  const format = String(candidate.format || "").toLowerCase();
  const adtype = String(candidate.adtype || "").toLowerCase();
  const cdn = String(candidate.cdn || "").toLowerCase();

  if (format === "hls") score += 10_000;
  if (quality === "hd") score += 1_000;
  if (quality === "sd") score += 100;

  if (opts.lgs) {
    score += candidate.lgs ? 300 : 0;
  } else {
    score += candidate.lgs ? -300 : 300;
  }

  if (adtype === "linear") score += 200;
  if (adtype === "ssai") score += 80;
  if (adtype === "csai") score += 20;

  if (cdn === opts.prefer) score += 100;
  if (Number.isFinite(candidate.pri)) score += Math.max(0, 50 - candidate.pri);
  if (candidate.drm) score -= 10_000;
  if (!candidate.stream) score -= 10_000;

  return score;
}

function selectCandidates(delivery, tokens, opts) {
  return delivery.dls
    .filter((location) => {
      const token = tokens?.[String(location.lid)]?.cdn;
      return location.stream && String(location.format).toLowerCase() === "hls" && !location.drm && token;
    })
    .map((location) => {
      const suffix = tokens[String(location.lid)].cdn;
      const url = appendUrlSuffix(location.stream, suffix);
      return {
        location,
        tokenSuffix: suffix,
        url,
        score: candidateScore(location, opts),
      };
    })
    .sort((a, b) => b.score - a.score);
}

function parseVariants(playlistText) {
  const lines = playlistText.split(/\r?\n/);
  const variants = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!line.startsWith("#EXT-X-STREAM-INF:")) continue;
    const attrs = Object.fromEntries(
      [...line.slice("#EXT-X-STREAM-INF:".length).matchAll(/([A-Z0-9-]+)=("[^"]*"|[^,]*)/g)]
        .map((match) => [match[1].toLowerCase(), match[2].replace(/^"|"$/g, "")])
    );
    variants.push({
      bandwidth: attrs.bandwidth ? Number(attrs.bandwidth) : undefined,
      resolution: attrs.resolution,
      frameRate: attrs["frame-rate"],
      codecs: attrs.codecs,
      uri: lines[i + 1] && !lines[i + 1].startsWith("#") ? lines[i + 1] : undefined,
    });
  }
  return variants.sort((a, b) => (b.bandwidth || 0) - (a.bandwidth || 0));
}

function variantHeight(variant) {
  const match = String(variant.resolution || "").match(/x(\d+)$/i);
  return match ? Number.parseInt(match[1], 10) : null;
}

function chooseVariant(variants, quality) {
  if (!Array.isArray(variants) || variants.length === 0) return null;
  if (quality === "audio") {
    return variants.find((variant) => !variantHeight(variant)) || null;
  }
  if (quality === "best") {
    return variants.find((variant) => variantHeight(variant)) || variants[0];
  }
  return variants.find((variant) => variantHeight(variant) === quality) || null;
}

function describeVariant(variant) {
  if (!variant) return "none";
  const height = variantHeight(variant);
  if (!height) return `audio ${variant.bandwidth || "unknown"}bps`;
  return `${variant.resolution || `${height}p`} ${variant.bandwidth || "unknown"}bps`;
}

async function verifyCandidate(candidate, opts) {
  try {
    const { text, response } = await fetchText(candidate.url, {
      timeoutMs: opts.timeoutMs,
      headers: { Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*" },
    });
    const ok = text.trimStart().startsWith("#EXTM3U");
    const variants = ok ? parseVariants(text) : [];
    const selectedVariant = ok ? chooseVariant(variants, opts.quality) : null;
    return {
      ok,
      status: response.status,
      contentType: response.headers.get("content-type"),
      variants,
      selectedVariant,
      qualityMatched: ok && Boolean(selectedVariant),
      child: ok && selectedVariant ? await verifyChildPlaylist(candidate, text, opts, selectedVariant) : null,
      error: ok ? undefined : "Response was not an HLS playlist",
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function verifyChildPlaylist(candidate, masterText, opts, selectedVariant) {
  if (!selectedVariant?.uri) return null;

  const directUrl = new URL(selectedVariant.uri, candidate.url).href;
  const tokenizedUrl = appendUrlSuffix(new URL(selectedVariant.uri, candidate.location.stream).href, candidate.tokenSuffix);

  const direct = await probePlaylistUrl(directUrl, opts);
  if (direct.ok) {
    return {
      mode: "direct",
      status: direct.status,
      contentType: direct.contentType,
      tokenRewriteNeeded: false,
    };
  }

  const tokenized = directUrl === tokenizedUrl ? direct : await probePlaylistUrl(tokenizedUrl, opts);
  return {
    mode: tokenized.ok ? "tokenized" : "failed",
    status: tokenized.ok ? tokenized.status : direct.status,
    contentType: tokenized.ok ? tokenized.contentType : direct.contentType,
    tokenRewriteNeeded: tokenized.ok,
    error: tokenized.ok ? undefined : tokenized.error || direct.error,
  };
}

async function probePlaylistUrl(url, opts) {
  try {
    const { text, response } = await fetchText(url, {
      timeoutMs: opts.timeoutMs,
      headers: { Accept: "application/vnd.apple.mpegurl, application/x-mpegURL, */*" },
    });
    return {
      ok: text.trimStart().startsWith("#EXTM3U"),
      status: response.status,
      contentType: response.headers.get("content-type"),
    };
  } catch (error) {
    return { ok: false, error: error.message };
  }
}

async function loadLiveData(opts) {
  const configRef = await getConfigUrl(opts);
  const { json: rawConfig } = await fetchJson(configRef.url, { timeoutMs: opts.timeoutMs });
  const config = applyPlatformOverride(rawConfig, opts.platform);
  ensureConfig(config);

  const { json: delivery } = await fetchJson(config.services.caronte, { timeoutMs: opts.timeoutMs });
  ensureDelivery(delivery);

  const { json: gbxResponse } = await fetchJson(config.services.gbx, { timeoutMs: opts.timeoutMs });
  const gbx = gbxResponse.gbx;
  if (!gbx) throw new Error("GBX response did not include gbx");

  const { json: cerbero } = await fetchJson(delivery.cerbero, {
    timeoutMs: opts.timeoutMs,
    method: "POST",
    credentials: "include",
    headers: { "Content-Type": "application/json;charset=UTF-8" },
    body: JSON.stringify({ bbx: delivery.bbx, gbx }),
  });

  if (!cerbero.tokens || typeof cerbero.tokens !== "object") {
    const details = cerbero.code ? ` Cerbero code: ${cerbero.code}` : "";
    throw new Error(`Cerbero response did not include CDN tokens.${details}`);
  }

  const candidates = selectCandidates(delivery, cerbero.tokens, opts);
  if (candidates.length === 0) {
    throw new Error("No playable non-DRM HLS candidates with CDN tokens were returned");
  }

  return { configRef, config, delivery, cerbero, candidates };
}

async function resolveLive(opts) {
  const data = await loadLiveData(opts);
  const { configRef, config, delivery, candidates } = data;
  const attempts = [];
  let bestObserved = null;
  if (opts.verify) {
    for (const candidate of candidates) {
      const verification = await verifyCandidate(candidate, opts);
      attempts.push({ candidate, verification });
      if (verification.ok && verification.variants[0]) {
        const observed = verification.variants[0];
        if (!bestObserved || (observed.bandwidth || 0) > (bestObserved.bandwidth || 0)) {
          bestObserved = observed;
        }
      }
      if (verification.ok && verification.qualityMatched) {
        return {
          configRef,
          config,
          delivery,
          selected: candidate,
          verification,
          attempts,
          requestedQuality: opts.quality,
        };
      }
    }
    const summary = attempts
      .slice(0, 5)
      .map(({ candidate, verification }) => {
        const loc = candidate.location;
        const detail = verification.ok && !verification.qualityMatched
          ? `no ${opts.quality} variant`
          : verification.error || verification.status;
        return `lid=${loc.lid} ${loc.cdn}/${loc.quality}/${loc.adtype}: ${detail}`;
      })
      .join("; ");
    const qualityDetail = opts.quality === "best" ? "" : ` Requested quality '${opts.quality}' was not available; best observed was ${describeVariant(bestObserved)}.`;
    throw new Error(`No candidate playlist verified successfully.${qualityDetail} ${summary}`);
  }

  return {
    configRef,
    config,
    delivery,
    selected: candidates[0],
    verification: null,
    attempts,
    requestedQuality: opts.quality,
  };
}

async function listLive(opts) {
  const data = await loadLiveData(opts);
  const attempts = [];
  for (const candidate of data.candidates) {
    const verification = await verifyCandidate(candidate, { ...opts, quality: "best" });
    attempts.push({ candidate, verification });
  }
  return { ...data, attempts };
}

function publicMetadata(result, includeUrl) {
  const loc = result.selected.location;
  const variants = result.verification?.variants || [];
  const publicVariant = (variant) => variant
    ? { ...variant, uri: includeUrl ? variant.uri : redactToken(variant.uri) }
    : null;
  return {
    title: result.config.info?.title || "Directo Cuatro",
    configUrl: result.configRef.url,
    configDiscoveredFromPage: result.configRef.discovered,
    platformOverride: result.configRef.platform || null,
    requestedQuality: result.requestedQuality || "best",
    selected: {
      lid: loc.lid,
      cdn: loc.cdn,
      format: loc.format,
      quality: loc.quality,
      adtype: loc.adtype,
      signLanguage: Boolean(loc.lgs),
      baseStream: loc.stream,
      url: includeUrl ? result.selected.url : redactToken(result.selected.url),
    },
    verification: result.verification
      ? {
          status: result.verification.status,
          contentType: result.verification.contentType,
          childPlaylist: result.verification.child,
          selectedVariant: publicVariant(result.verification.selectedVariant),
          topVariant: publicVariant(variants[0]),
          variants: variants.length,
        }
      : null,
  };
}

function listMetadata(result) {
  return {
    title: result.config.info?.title || "Directo Cuatro",
    configUrl: result.configRef.url,
    platformOverride: result.configRef.platform || null,
    candidates: result.attempts.map(({ candidate, verification }) => ({
      lid: candidate.location.lid,
      cdn: candidate.location.cdn,
      quality: candidate.location.quality,
      adtype: candidate.location.adtype,
      signLanguage: Boolean(candidate.location.lgs),
      baseStream: candidate.location.stream,
      ok: Boolean(verification.ok),
      error: verification.error,
      variants: (verification.variants || []).map((variant) => ({
        resolution: variant.resolution || "audio",
        bandwidth: variant.bandwidth,
        frameRate: variant.frameRate,
        uri: redactToken(variant.uri),
      })),
    })),
  };
}

function printList(result) {
  for (const { candidate, verification } of result.attempts) {
    const loc = candidate.location;
    console.log(`lid=${loc.lid} ${loc.cdn} ${loc.quality} ${loc.adtype}${loc.lgs ? " lgs" : ""}`);
    if (!verification.ok) {
      console.log(`  error: ${verification.error || "playlist failed verification"}`);
      continue;
    }
    for (const variant of verification.variants) {
      console.log(`  ${describeVariant(variant)}${variant.frameRate ? ` ${variant.frameRate}fps` : ""}`);
    }
  }
}

function rewritePlaylist(text, rawBaseUrl, makeLocalUrl, selectedVariant = null, registerUrlToken = () => {}, inheritedTokenSuffix = null) {
  const lines = text.split(/\r?\n/);
  const isMaster = lines.some((line) => line.startsWith("#EXT-X-STREAM-INF:"));

  const rewriteUri = (uri) => {
    const absolute = new URL(uri, rawBaseUrl).href;
    registerUrlToken(absolute, extractTokenSuffix(absolute) || inheritedTokenSuffix);
    return makeLocalUrl(absolute);
  };

  if (isMaster && selectedVariant?.uri) {
    const rewritten = [];
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i];
      if (line.startsWith("#EXT-X-STREAM-INF:")) {
        const uri = lines[i + 1];
        if (uri === selectedVariant.uri) {
          rewritten.push(line);
          rewritten.push(rewriteUri(uri));
        }
        i += 1;
        continue;
      }

      if (line.includes("URI=\"")) {
        rewritten.push(line.replace(/URI="([^"]+)"/g, (_match, uri) => {
          return `URI="${rewriteUri(uri)}"`;
        }));
      } else {
        rewritten.push(line);
      }
    }
    return rewritten.join("\n");
  }

  return lines
    .map((line) => {
      if (!line) return line;

      const uriAttrRewritten = line.replace(/URI="([^"]+)"/g, (_match, uri) => {
        return `URI="${rewriteUri(uri)}"`;
      });

      if (uriAttrRewritten.startsWith("#")) return uriAttrRewritten;
      return rewriteUri(uriAttrRewritten);
    })
    .join("\n");
}

async function fetchUpstream(url, req, opts) {
  const { controller, timeout } = createTimeout(opts.timeoutMs);
  const headers = browserHeaders({ Accept: "*/*" });
  if (req.headers.range) headers.Range = req.headers.range;

  try {
    return await fetch(url, {
      signal: controller.signal,
      headers,
    });
  } finally {
    clearTimeout(timeout);
  }
}

function sendText(res, status, text, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "Content-Type": contentType,
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function createProxyState(result, opts) {
  const state = {
    result,
    opts,
    lastRefreshAt: Date.now(),
    tokenExpiresAt: parseTokenExpiresAt(result.selected.tokenSuffix),
    allowedHosts: new Set(),
    tokenByUrl: new Map(),
    refreshPromise: null,
  };
  updateProxyState(state, result);
  return state;
}

function updateProxyState(state, result) {
  state.result = result;
  state.allowedHosts = new Set(result.delivery.dls.map((location) => new URL(location.stream).host));
  state.lastRefreshAt = Date.now();
  state.tokenExpiresAt = parseTokenExpiresAt(result.selected.tokenSuffix);
  state.tokenByUrl.clear();
}

function shouldRefreshProxyState(state) {
  const now = Date.now();
  if (state.tokenExpiresAt) {
    return now >= state.tokenExpiresAt - TOKEN_REFRESH_MARGIN_MS;
  }
  return now - state.lastRefreshAt >= FALLBACK_REFRESH_MS;
}

async function refreshProxyState(state, reason, force = false) {
  if (!force && !shouldRefreshProxyState(state)) return state.result;
  if (state.refreshPromise) return state.refreshPromise;

  state.refreshPromise = (async () => {
    if (state.opts.verbose) {
      console.error(`Refreshing Cuatro stream token (${reason})...`);
    }
    const next = await resolveLive(state.opts);
    updateProxyState(state, next);
    if (state.opts.verbose) {
      const loc = next.selected.location;
      console.error(`Refreshed token for lid=${loc.lid} ${loc.cdn} ${loc.quality} ${loc.adtype}`);
    }
    return next;
  })().finally(() => {
    state.refreshPromise = null;
  });

  return state.refreshPromise;
}

async function startProxy(result, opts) {
  const state = createProxyState(result, opts);

  const makeLocalUrl = (rawUrl) => {
    const parsed = stripTokenQueryParams(rawUrl);
    if (!state.allowedHosts.has(parsed.host)) return rawUrl;
    return `/hls?u=${encodeURIComponent(parsed.href)}`;
  };

  const registerUrlToken = (rawUrl, tokenSuffix) => {
    if (!tokenSuffix) return;
    const parsed = stripTokenQueryParams(rawUrl);
    if (!state.allowedHosts.has(parsed.host)) return;
    state.tokenByUrl.set(parsed.href, tokenSuffix);
  };

  const tokenForRawUrl = (rawUrl) => {
    const stripped = stripTokenQueryParams(rawUrl).href;
    return state.tokenByUrl.get(stripped) || state.result.selected.tokenSuffix;
  };

  const upstreamUrlForRawUrl = (rawUrl) => appendUrlSuffix(rawUrl, tokenForRawUrl(rawUrl));

  const isMasterRawUrl = (rawUrl) => stripTokenQueryParams(rawUrl).href === stripTokenQueryParams(state.result.selected.location.stream).href;

  const deriveChildPlaylistUrl = (rawUrl) => {
    const parsed = stripTokenQueryParams(rawUrl);
    const match = parsed.pathname.match(/^(.*-\d+)\.ts$/);
    if (!match) return null;
    parsed.pathname = `${match[1].replace(/-\d+$/, "")}.m3u8`;
    parsed.search = "";
    return parsed.href;
  };

  const primePlaylistMappings = async (rawUrl) => {
    const upstream = await fetchUpstream(upstreamUrlForRawUrl(rawUrl), { headers: {} }, opts);
    if (!upstream.ok) {
      await upstream.arrayBuffer().catch(() => null);
      return false;
    }
    const contentType = upstream.headers.get("content-type") || "";
    const parsed = new URL(rawUrl);
    const isPlaylist = parsed.pathname.endsWith(".m3u8") || contentType.toLowerCase().includes("mpegurl");
    if (!isPlaylist) {
      await upstream.arrayBuffer().catch(() => null);
      return false;
    }
    const text = await upstream.text();
    const selected = state.result.selected;
    const selectedVariant = rawUrl === selected.location.stream && opts.quality !== "best"
      ? state.result.verification?.selectedVariant
      : null;
    rewritePlaylist(text, rawUrl, makeLocalUrl, selectedVariant, registerUrlToken, tokenForRawUrl(rawUrl));
    return true;
  };

  const primeMappingsForRetry = async (rawUrl) => {
    if (!isMasterRawUrl(rawUrl)) {
      await primePlaylistMappings(state.result.selected.location.stream).catch(() => false);
    }
    if (!state.tokenByUrl.has(stripTokenQueryParams(rawUrl).href)) {
      const childUrl = deriveChildPlaylistUrl(rawUrl);
      if (childUrl && state.tokenByUrl.has(stripTokenQueryParams(childUrl).href)) {
        await primePlaylistMappings(childUrl).catch(() => false);
      }
    }
  };

  const serveUpstream = async (req, res, rawUrl) => {
    let parsed;
    try {
      parsed = new URL(rawUrl);
    } catch {
      sendText(res, 400, "Bad upstream URL");
      return;
    }

    if (!state.allowedHosts.has(parsed.host)) {
      sendText(res, 403, "Host is not allowed by this resolver");
      return;
    }

    let upstream;
    try {
      await refreshProxyState(state, "scheduled");
      upstream = await fetchUpstream(upstreamUrlForRawUrl(rawUrl), req, opts);
      if (upstream.status === 401 || upstream.status === 403) {
        await upstream.arrayBuffer().catch(() => null);
        await refreshProxyState(state, `upstream HTTP ${upstream.status}`, true);
        await primeMappingsForRetry(rawUrl);
        upstream = await fetchUpstream(upstreamUrlForRawUrl(rawUrl), req, opts);
      }
    } catch (error) {
      sendText(res, 502, `Upstream fetch failed: ${redactToken(error.message)}`);
      return;
    }

    if (!upstream.ok) {
      const body = await upstream.text().catch(() => "");
      sendText(res, upstream.status, body || `Upstream returned HTTP ${upstream.status}`);
      return;
    }

    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const isPlaylist = parsed.pathname.endsWith(".m3u8") || contentType.toLowerCase().includes("mpegurl");
    if (isPlaylist) {
      const text = await upstream.text();
      const selected = state.result.selected;
      const selectedVariant = rawUrl === selected.location.stream && opts.quality !== "best"
        ? state.result.verification?.selectedVariant
        : null;
      const inheritedTokenSuffix = tokenForRawUrl(rawUrl);
      const rewritten = rewritePlaylist(text, rawUrl, makeLocalUrl, selectedVariant, registerUrlToken, inheritedTokenSuffix);
      sendText(res, 200, rewritten, "application/vnd.apple.mpegurl");
      return;
    }

    const body = Buffer.from(await upstream.arrayBuffer());
    const headers = {
      "Content-Type": contentType,
      "Cache-Control": upstream.headers.get("cache-control") || "no-store",
      "Content-Length": String(body.length),
    };
    const contentRange = upstream.headers.get("content-range");
    if (contentRange) headers["Content-Range"] = contentRange;
    if (req.headers.range) headers["Accept-Ranges"] = "bytes";
    res.writeHead(upstream.status, headers);
    res.end(body);
  };

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", "http://127.0.0.1");
    if (url.pathname === "/" || url.pathname === "/master.m3u8") {
      serveUpstream(req, res, state.result.selected.location.stream);
      return;
    }
    if (url.pathname === "/hls") {
      const rawUrl = url.searchParams.get("u");
      if (!rawUrl) {
        sendText(res, 400, "Missing upstream URL");
        return;
      }
      serveUpstream(req, res, rawUrl);
      return;
    }
    sendText(res, 404, "Not found");
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  return {
    server,
    url: `http://127.0.0.1:${address.port}/master.m3u8`,
  };
}

function printHuman(result, opts) {
  const loc = result.selected.location;
  const variants = result.verification?.variants || [];
  if (opts.verbose || !opts.print) {
    console.error(`Selected lid=${loc.lid} ${loc.cdn} ${loc.quality} ${loc.adtype}${loc.lgs ? " lgs" : ""}`);
    if (result.verification) {
      const top = variants[0];
      const topText = top
        ? ` top variant ${top.resolution || "unknown resolution"} ${top.bandwidth || "unknown"}bps`
        : " no variant list found";
      console.error(`Playlist verified: HTTP ${result.verification.status};${topText}`);
      if (result.verification.selectedVariant && opts.quality !== "best") {
        console.error(`Selected variant: ${describeVariant(result.verification.selectedVariant)}`);
      }
      if (result.verification.child?.tokenRewriteNeeded) {
        console.error("Nested variant playlists also require the CDN token suffix.");
      }
    } else {
      console.error("Playlist verification skipped");
    }
  }

  if (opts.print) {
    console.log(result.selected.url);
    if (result.verification?.child?.tokenRewriteNeeded && !opts.player && !opts.serve) {
      console.error("Note: nested playlists need token rewriting; use --player or --serve for VLC/mpv/ffplay.");
    }
  } else if (!opts.player && !opts.serve) {
    console.error("Resolved successfully. Use --print to emit the tokenized URL, --serve for a localhost HLS URL, or --player vlc/mpv/ffplay to launch playback.");
  }
}

function launchPlayer(player, url) {
  const argsByPlayer = {
    vlc: [url],
    mpv: [url],
    ffplay: ["-i", url],
  };
  return new Promise((resolve) => {
    const child = spawn(player, argsByPlayer[player], {
      stdio: "inherit",
      detached: false,
    });
    child.on("error", (error) => {
      console.error(`Could not launch ${player}: ${error.message}`);
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      if (signal) resolve(1);
      else resolve(code ?? 0);
    });
  });
}

function waitForStop(server) {
  return new Promise((resolve) => {
    const stop = () => {
      server.close(() => resolve());
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    usage(1);
  }

  try {
    if (!opts.verify && opts.quality !== "best") {
      throw new Error("--quality requires playlist verification");
    }

    if (opts.list) {
      const listed = await listLive(opts);
      if (opts.json) {
        console.log(JSON.stringify(listMetadata(listed), null, 2));
      } else {
        printList(listed);
      }
      return;
    }

    const result = await resolveLive(opts);
    let proxy = null;
    if (opts.player || opts.serve) {
      proxy = await startProxy(result, opts);
      console.error(`Local HLS proxy: ${proxy.url}`);
    }

    if (opts.json) {
      const metadata = publicMetadata(result, opts.print);
      if (proxy) metadata.localProxyUrl = proxy.url;
      console.log(JSON.stringify(metadata, null, 2));
    } else {
      printHuman(result, opts);
      if (opts.serve && proxy) console.log(proxy.url);
    }

    if (opts.player && proxy) {
      const code = await launchPlayer(opts.player, proxy.url);
      proxy.server.close();
      process.exitCode = code;
    } else if (opts.serve && proxy) {
      console.error("Press Ctrl-C to stop the local HLS proxy.");
      await waitForStop(proxy.server);
    }
  } catch (error) {
    console.error(`Error: ${redactToken(error.message)}`);
    process.exit(1);
  }
}

main();
