/**
 * Core alert logic.
 */
import { evaluate, evaluateAsync } from '../connection.js';

// Map the public condition names to TradingView's internal condition types.
// Verified live against pricealerts.tradingview.com/create_alert.
const CONDITION_TYPES = {
  crossing: 'cross',
  greater_than: 'greater',
  less_than: 'less',
};

export async function create({ condition, price, message }) {
  // The create-alert dialog cannot be driven from injected JS: its fields have
  // no stable selectors AND TradingView only commits values from TRUSTED input
  // events, so native-setter / execCommand / CDP Input.insertText all left the
  // alert at the pre-filled default price. Instead we POST directly to the same
  // internal REST service that list() reads from — this applies the exact price,
  // condition, and message. (Endpoint, payload shape, and condition types were
  // reverse-engineered by capturing the live UI's own create_alert request.)
  const priceNum = Number(price);
  if (!Number.isFinite(priceNum)) throw new Error(`Invalid price: ${price}`);
  const condType = CONDITION_TYPES[condition] || 'cross';

  // Read the current chart symbol + resolution to target the alert.
  const ctx = await evaluate(`
    (function() {
      var c = window.TradingViewApi._activeChartWidgetWV.value();
      return { symbol: c.symbol(), resolution: String(c.resolution()) };
    })()
  `);
  if (!ctx || !ctx.symbol) throw new Error('Could not read current chart symbol');

  const ticker = String(ctx.symbol).split(':').pop();
  const msg = message || `${ticker} ${condition} ${priceNum}`;
  const expiration = new Date(Date.now() + 30 * 864e5).toISOString();

  // Build the payload, then JSON-encode it twice so it is injected into the
  // evaluate() string as a safe (injection-proof) JS string literal.
  const payload = {
    conditions: [{
      type: condType,
      frequency: 'on_first_fire',
      series: [{ type: 'barset' }, { type: 'value', value: priceNum }],
      resolution: ctx.resolution,
    }],
    symbol: ctx.symbol,
    resolution: ctx.resolution,
    message: msg,
    sound_file: 'alert/fired',
    sound_duration: 0,
    popup: true,
    auto_deactivate: true,
    email: false,
    sms_over_email: false,
    mobile_push: true,
    web_hook: null,
    name: msg,
    expiration,
    active: true,
    ignore_warnings: true,
  };
  const bodyLiteral = JSON.stringify(JSON.stringify({ payload }));

  // text/plain content-type avoids a CORS preflight (which blocks application/json).
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/create_alert', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: ${bodyLiteral}
    })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        var r = d.r || {};
        var series = (r.condition && r.condition.series) || [];
        return { s: d.s, errmsg: d.errmsg, err: d.err, alert_id: r.alert_id,
                 value: series[1] && series[1].value };
      })
      .catch(function(e) { return { s: 'error', errmsg: e.message }; })
  `);

  if (!result || result.s !== 'ok') {
    const reason = result?.errmsg || result?.err?.code || 'create_alert request failed';
    return { success: false, error: reason, condition, price: priceNum, source: 'internal_api' };
  }
  return {
    success: true,
    alert_id: result.alert_id,
    symbol: ctx.symbol,
    price: result.value ?? priceNum,
    condition,
    message: msg,
    source: 'internal_api',
  };
}

export async function list() {
  // Use pricealerts REST API — returns structured data with alert_id, symbol, price, conditions
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
      .then(function(r) { return r.json(); })
      .then(function(data) {
        if (data.s !== 'ok' || !Array.isArray(data.r)) return { alerts: [], error: data.errmsg || 'Unexpected response' };
        return {
          alerts: data.r.map(function(a) {
            var sym = '';
            try { sym = JSON.parse(a.symbol.replace(/^=/, '')).symbol || a.symbol; } catch(e) { sym = a.symbol; }
            return {
              alert_id: a.alert_id,
              symbol: sym,
              type: a.type,
              message: a.message,
              active: a.active,
              condition: a.condition,
              resolution: a.resolution,
              created: a.create_time,
              last_fired: a.last_fire_time,
              expiration: a.expiration,
            };
          })
        };
      })
      .catch(function(e) { return { alerts: [], error: e.message }; })
  `);
  return { success: true, alert_count: result?.alerts?.length || 0, source: 'internal_api', alerts: result?.alerts || [], error: result?.error };
}

export async function deleteAlerts({ delete_all, alert_id }) {
  // Delete via the internal REST service (verified live). Supports deleting a
  // single alert by id or, with delete_all, every alert returned by list_alerts.
  let ids = [];
  if (alert_id != null && alert_id !== '') {
    const n = Number(alert_id);
    if (!Number.isFinite(n)) throw new Error(`Invalid alert_id: ${alert_id}`);
    ids = [n];
  } else if (delete_all) {
    const listed = await evaluateAsync(`
      fetch('https://pricealerts.tradingview.com/list_alerts', { credentials: 'include' })
        .then(function(r) { return r.json(); })
        .then(function(d) { return (d.r || []).map(function(a) { return a.alert_id; }); })
        .catch(function() { return []; })
    `);
    ids = Array.isArray(listed) ? listed : [];
  } else {
    throw new Error('Provide alert_id to delete one alert, or delete_all: true to delete all.');
  }

  if (ids.length === 0) {
    return { success: true, deleted: 0, note: 'No alerts to delete', source: 'internal_api' };
  }

  const bodyLiteral = JSON.stringify(JSON.stringify({ payload: { alert_ids: ids } }));
  const result = await evaluateAsync(`
    fetch('https://pricealerts.tradingview.com/delete_alerts', {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'text/plain;charset=UTF-8' },
      body: ${bodyLiteral}
    })
      .then(function(r) { return r.json(); })
      .then(function(d) { return { s: d.s, errmsg: d.errmsg }; })
      .catch(function(e) { return { s: 'error', errmsg: e.message }; })
  `);

  if (!result || result.s !== 'ok') {
    return { success: false, error: result?.errmsg || 'delete_alerts request failed', source: 'internal_api' };
  }
  return { success: true, deleted: ids.length, alert_ids: ids, source: 'internal_api' };
}
