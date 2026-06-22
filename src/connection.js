import CDP from 'chrome-remote-interface';

let client = null;
let targetInfo = null;
const CDP_HOST = 'localhost';
const CDP_PORT = 9222;
const MAX_RETRIES = 5;
const BASE_DELAY = 500;

// Known direct API paths discovered via live probing (see PROBE_RESULTS.md)
const KNOWN_PATHS = {
  chartApi: 'window.TradingViewApi._activeChartWidgetWV.value()',
  chartWidgetCollection: 'window.TradingViewApi._chartWidgetCollection',
  bottomWidgetBar: 'window.TradingView.bottomWidgetBar',
  replayApi: 'window.TradingViewApi._replayApi',
  alertService: 'window.TradingViewApi._alertService',
  chartApiInstance: 'window.ChartApiInstance',
  mainSeriesBars: 'window.TradingViewApi._activeChartWidgetWV.value()._chartWidget.model().mainSeries().bars()',
  // Phase 1: Strategy data — model().dataSources() → find strategy → .performance().value(), .ordersData(), .reportData()
  strategyStudy: 'chart._chartWidget.model().model().dataSources()',
  // Phase 2: Layouts — getSavedCharts(cb), loadChartFromServer(id)
  layoutManager: 'window.TradingViewApi.getSavedCharts',
  // Phase 5: Symbol search — searchSymbols(query) returns Promise
  symbolSearchApi: 'window.TradingViewApi.searchSymbols',
  // Phase 6: Pine scripts — REST API at pine-facade.tradingview.com/pine-facade/list/?filter=saved
  pineFacadeApi: 'https://pine-facade.tradingview.com/pine-facade',
};

export { KNOWN_PATHS };

/**
 * Sanitize a string for safe interpolation into JavaScript code evaluated via CDP.
 * Uses JSON.stringify to produce a properly escaped JS string literal (with quotes).
 * Prevents injection via quotes, backticks, template literals, or control chars.
 */
export function safeString(str) {
  return JSON.stringify(String(str));
}

/**
 * Validate that a value is a finite number. Throws if NaN, Infinity, or non-numeric.
 * Prevents corrupt values from reaching TradingView APIs that persist to cloud state.
 */
export function requireFinite(value, name) {
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`${name} must be a finite number, got: ${value}`);
  return n;
}

export async function getClient() {
  if (client) {
    try {
      // Liveness check that doubles as a front-tab check: read the bound tab's
      // visibility. If it's no longer the chart the user is looking at, drop the
      // connection and rebind below so data + screenshots stay on the same chart.
      const vis = (await client.Runtime.evaluate({
        expression: 'document.visibilityState', returnByValue: true,
      })).result?.value;
      if (await boundTargetStillPreferred(vis)) return client;
    } catch {
      // Connection is dead — fall through to reconnect.
    }
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
  return connect();
}

function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

// Should we keep the currently-bound target, or rebind to a better one?
async function boundTargetStillPreferred(vis) {
  const pin = process.env.TV_CHART_SLUG;
  if (pin) {
    // Pinned: stay on the pinned chart regardless of which tab is on screen.
    return new RegExp(`/chart/${escapeRe(pin)}`, 'i').test(targetInfo?.url || '');
  }
  if (vis === 'visible') return true;
  // Bound tab is hidden — only switch if a *different* chart tab is now visible.
  // (If nothing is visible, e.g. the whole app is backgrounded, keep current to
  // avoid thrashing between charts.)
  try {
    const { charts } = await listChartTargets();
    const other = await findVisibleChartTarget(charts.filter(t => t.id !== targetInfo?.id));
    return !other;
  } catch {
    return true;
  }
}

export async function connect() {
  let lastError;
  for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
    try {
      const target = await findChartTarget();
      if (!target) {
        throw new Error('No TradingView chart target found. Is TradingView open with a chart?');
      }
      targetInfo = target;
      client = await CDP({ host: CDP_HOST, port: CDP_PORT, target: target.id });

      // Enable required domains
      await client.Runtime.enable();
      await client.Page.enable();
      await client.DOM.enable();

      return client;
    } catch (err) {
      lastError = err;
      const delay = Math.min(BASE_DELAY * Math.pow(2, attempt), 30000);
      await new Promise(r => setTimeout(r, delay));
    }
  }
  throw new Error(`CDP connection failed after ${MAX_RETRIES} attempts: ${lastError?.message}`);
}

async function listChartTargets() {
  const resp = await fetch(`http://${CDP_HOST}:${CDP_PORT}/json/list`);
  const targets = await resp.json();
  return {
    charts: targets.filter(t => t.type === 'page' && /tradingview\.com\/chart/i.test(t.url)),
    anyTv: targets.find(t => t.type === 'page' && /tradingview/i.test(t.url)) || null,
  };
}

// Open a throwaway CDP connection to read an expression from another target
// without disturbing the main client. Used to inspect candidate chart tabs.
async function probeExpr(targetId, expression) {
  let c;
  try {
    c = await CDP({ host: CDP_HOST, port: CDP_PORT, target: targetId });
    await c.Runtime.enable();
    const r = await c.Runtime.evaluate({ expression, returnByValue: true });
    return r.result?.value ?? null;
  } catch {
    return null;
  } finally {
    if (c) { try { await c.close(); } catch {} }
  }
}

// 'visible' marks the front (on-screen) tab; background tabs report 'hidden'.
async function findVisibleChartTarget(charts) {
  for (const t of charts) {
    if (await probeExpr(t.id, 'document.visibilityState') === 'visible') return t;
  }
  return null;
}

const SYMBOL_EXPR = `(function(){try{return window.TradingViewApi._activeChartWidgetWV.value().symbol();}catch(e){return null;}})()`;

function slugOf(url) {
  return (String(url).match(/\/chart\/([^/?#]+)/) || [])[1] || null;
}

// Diagnostic: every open chart tab with its symbol, visibility, and whether the
// MCP is currently bound to it. Lets callers detect/expose multi-tab ambiguity.
export async function getChartTabs() {
  const { charts } = await listChartTargets();
  const out = [];
  for (const t of charts) {
    out.push({
      id: t.id,
      slug: slugOf(t.url),
      symbol: await probeExpr(t.id, SYMBOL_EXPR),
      visibility: await probeExpr(t.id, 'document.visibilityState'),
      bound: t.id === targetInfo?.id,
    });
  }
  return out;
}

async function findChartTarget() {
  const { charts, anyTv } = await listChartTargets();
  if (charts.length === 0) return anyTv;

  // Pin override: bind to a specific chart by URL slug (the /chart/<slug>/ id),
  // regardless of which tab is on screen. Set TV_CHART_SLUG to enable.
  const pin = process.env.TV_CHART_SLUG;
  if (pin) {
    const pinned = charts.find(t => new RegExp(`/chart/${escapeRe(pin)}`, 'i').test(t.url));
    if (pinned) return pinned;
  }

  if (charts.length === 1) return charts[0];

  // Multiple chart tabs open: bind to the visible (front) tab so that data tools
  // and screenshots both refer to the chart the user is actually looking at.
  // Fall back to the first chart if none report visible (e.g. app backgrounded).
  return (await findVisibleChartTarget(charts)) || charts[0];
}

export async function getTargetInfo() {
  if (!targetInfo) {
    await getClient();
  }
  return targetInfo;
}

export async function evaluate(expression, opts = {}) {
  const c = await getClient();
  const result = await c.Runtime.evaluate({
    expression,
    returnByValue: true,
    awaitPromise: opts.awaitPromise ?? false,
    ...opts,
  });
  if (result.exceptionDetails) {
    const msg = result.exceptionDetails.exception?.description
      || result.exceptionDetails.text
      || 'Unknown evaluation error';
    throw new Error(`JS evaluation error: ${msg}`);
  }
  return result.result?.value;
}

export async function evaluateAsync(expression) {
  return evaluate(expression, { awaitPromise: true });
}

export async function disconnect() {
  if (client) {
    try { await client.close(); } catch {}
    client = null;
    targetInfo = null;
  }
}

// --- Direct API path helpers ---
// Each returns the STRING expression path after verifying it exists.
// Callers use the returned string in their own evaluate() calls.

async function verifyAndReturn(path, name) {
  const exists = await evaluate(`typeof (${path}) !== 'undefined' && (${path}) !== null`);
  if (!exists) {
    throw new Error(`${name} not available at ${path}`);
  }
  return path;
}

export async function getChartApi() {
  return verifyAndReturn(KNOWN_PATHS.chartApi, 'Chart API');
}

export async function getChartCollection() {
  return verifyAndReturn(KNOWN_PATHS.chartWidgetCollection, 'Chart Widget Collection');
}

export async function getBottomBar() {
  return verifyAndReturn(KNOWN_PATHS.bottomWidgetBar, 'Bottom Widget Bar');
}

export async function getReplayApi() {
  return verifyAndReturn(KNOWN_PATHS.replayApi, 'Replay API');
}

export async function getMainSeriesBars() {
  return verifyAndReturn(KNOWN_PATHS.mainSeriesBars, 'Main Series Bars');
}
