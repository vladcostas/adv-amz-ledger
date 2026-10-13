const express = require('express');
const axios = require('axios');
const cors = require('cors');
const zlib = require('zlib');
const fs = require('fs');
const path = require('path');

// Latest Amazon data, saved so a restarted server can answer straight away (git-ignored)
const DATA_FILE = path.join(__dirname, 'amazon-data.json');

const app = express();
app.use(cors());
app.use(express.json());

// Amazon credentials (load from environment variables)
const CONFIG = {
  clientId: process.env.AMAZON_CLIENT_ID,
  clientSecret: process.env.AMAZON_CLIENT_SECRET,
  refreshToken: process.env.AMAZON_REFRESH_TOKEN,
  sellingPartnerId: process.env.AMAZON_SELLER_ID || 'A12MJTUALT3TNJ',
  endpoint: 'https://sellingpartnerapi-eu.amazon.com'
};

// Marketplaces the account sells in (all served by the EU endpoint)
const ALL_MARKETPLACES = {
  UK: 'A1F83G8C2ARO7P',
  DE: 'A1PA6795UKMFR9',
  FR: 'A13V1IB3VIYZZH',
  ES: 'A1RKKUPIHCS9HS',
  IT: 'APJ6JRA9NG5V4',
  NL: 'A1805IZSGTT6HS',
  BE: 'AMEN7PMS3EDWL',
  PL: 'A1C3SOZRARQ6R3',
  SE: 'A2NODRKZP88ZB9',
  IE: 'A28R8C7NBKEWEA',
  AE: 'A2VIGQ35RCS4UG',
  SA: 'A17E79C6D8DWNP'
};

// Optional AMAZON_MARKETPLACES=DE,FR,UK limits which countries are synced
const MARKETPLACES = Object.fromEntries(
  Object.entries(ALL_MARKETPLACES).filter(([code]) =>
    !process.env.AMAZON_MARKETPLACES ||
    process.env.AMAZON_MARKETPLACES.split(',').map(c => c.trim().toUpperCase()).includes(code))
);

// Pan-EU stock is shared, so every EU marketplace reports the same pool: fetch it once
const EU_POOL = ['DE', 'FR', 'ES', 'IT', 'NL', 'BE', 'PL', 'SE', 'IE'];

const SALES_DAYS = 30;
// Data is refreshed in the background; /sync answers from the latest copy.
// Stock is refreshed every 30 minutes. Sales come from reports that lag ~2 days and Amazon only
// lets the account create a few reports every few minutes, so sales are refreshed every 6 hours.
const REFRESH_MS = 30 * 60 * 1000;
const SALES_REFRESH_MS = 6 * 60 * 60 * 1000;

// Validate credentials on startup
if (!CONFIG.clientId || !CONFIG.clientSecret || !CONFIG.refreshToken) {
  console.error('❌ ERROR: Missing Amazon credentials in environment variables');
  console.error('Required: AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, AMAZON_REFRESH_TOKEN');
  process.exit(1);
}

let cachedToken = null;
let tokenExpiry = null;
let tokenRequest = null;

// Parallel callers share one in-flight token request
function getAccessToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    return Promise.resolve(cachedToken);
  }
  if (!tokenRequest) {
    tokenRequest = fetchAccessToken().finally(() => { tokenRequest = null; });
  }
  return tokenRequest;
}

async function fetchAccessToken() {
  console.log('[TOKEN] Fetching new token...');
  try {
    const response = await axios.post('https://api.amazon.com/auth/o2/token', {
      grant_type: 'refresh_token',
      refresh_token: CONFIG.refreshToken,
      client_id: CONFIG.clientId,
      client_secret: CONFIG.clientSecret
    });

    cachedToken = response.data.access_token;
    tokenExpiry = Date.now() + (response.data.expires_in * 1000) - 60000;
    console.log('[TOKEN] New token obtained, expires in', response.data.expires_in, 's');
    return cachedToken;
  } catch (error) {
    console.error('[TOKEN] Error:', error.response?.data || error.message);
    throw new Error('Failed to get access token: ' + (error.response?.data?.error_description || error.message));
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

// SP-API call with the token in x-amz-access-token (an Authorization: Bearer header returns 403).
// Retries on 429 (rate limited) with backoff.
async function spApi(method, path, data) {
  for (let attempt = 0; ; attempt++) {
    const token = await getAccessToken();
    try {
      const response = await axios({
        method,
        url: CONFIG.endpoint + path,
        data,
        headers: { 'x-amz-access-token': token }
      });
      return response.data;
    } catch (error) {
      // Some Reports API calls refill at one per minute, so back off up to a minute
      if (error.response?.status === 429 && attempt < 6) {
        await sleep(Math.min(5000 * 2 ** attempt, 60000));
        continue;
      }
      const detail = error.response?.data?.errors?.[0]?.message;
      throw new Error(`${error.response?.status || ''} ${detail || error.message} (${path.split('?')[0]})`.trim());
    }
  }
}

// Sales & Traffic report: one report returns every ASIN's sales for a marketplace.
// Amazon's data lags ~2 days, so the window ends 2 days ago.
async function createSalesReport(marketplaceId) {
  const end = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
  const start = new Date(end.getTime() - SALES_DAYS * 24 * 60 * 60 * 1000);

  const created = await spApi('post', '/reports/2021-06-30/reports', {
    reportType: 'GET_SALES_AND_TRAFFIC_REPORT',
    marketplaceIds: [marketplaceId],
    dataStartTime: start.toISOString().slice(0, 10),
    dataEndTime: end.toISOString().slice(0, 10),
    reportOptions: { asinGranularity: 'CHILD', dateGranularity: 'DAY' }
  });
  return created.reportId;
}

// Recent finished reports per marketplace, so a restart doesn't spend the create quota again
async function findRecentReports(codes) {
  const since = new Date(Date.now() - SALES_REFRESH_MS).toISOString();
  const found = {};
  try {
    const data = await spApi('get', `/reports/2021-06-30/reports?reportTypes=GET_SALES_AND_TRAFFIC_REPORT&processingStatuses=DONE&createdSince=${since}&pageSize=100`);
    // Newest first, so keep the first report seen for each marketplace
    for (const report of data.reports || []) {
      const code = codes.find(c => (report.marketplaceIds || []).length === 1 && report.marketplaceIds[0] === MARKETPLACES[c]);
      if (code && !found[code]) found[code] = report;
    }
  } catch (err) {
    console.error('[SALES] Could not list recent reports:', err.message);
  }
  return found;
}

// Reuse recent reports where possible, create the rest, then poll them all from a single loop
// (getReport allows ~2 calls/second for the whole account).
async function getAllSalesReports(codes) {
  const pending = {};
  const results = {};

  const recent = await findRecentReports(codes);
  for (const [code, report] of Object.entries(recent)) {
    try {
      results[code] = { sales: await downloadSalesReport(code, report.reportDocumentId), at: Date.parse(report.createdTime) };
    } catch (err) {
      console.error(`[SALES] ${code}: could not reuse report: ${err.message}`);
    }
  }

  for (const code of codes.filter(c => !results[c])) {
    try {
      pending[code] = await createSalesReport(MARKETPLACES[code]);
    } catch (err) {
      results[code] = { error: err.message };
    }
    await sleep(1000);
  }

  console.log(`[SALES] ${Object.keys(pending).length} reports queued at Amazon`);

  // Amazon processes a seller's reports one at a time, so the last can take several minutes
  const startedAt = Date.now();
  while (Object.keys(pending).length) {
    if (Date.now() - startedAt > 20 * 60 * 1000) {
      for (const code of Object.keys(pending)) results[code] = { error: 'report timed out' };
      break;
    }
    await sleep(5000);
    for (const [code, reportId] of Object.entries(pending)) {
      try {
        const report = await spApi('get', `/reports/2021-06-30/reports/${reportId}`);
        if (report.processingStatus === 'DONE') {
          results[code] = { sales: await downloadSalesReport(code, report.reportDocumentId), at: Date.now() };
          delete pending[code];
        } else if (['CANCELLED', 'FATAL'].includes(report.processingStatus)) {
          // CANCELLED means Amazon had no data for the period, e.g. a marketplace with no sales
          results[code] = report.processingStatus === 'CANCELLED' ? { sales: {}, at: Date.now() } : { error: 'report failed' };
          delete pending[code];
        }
      } catch (err) {
        results[code] = { error: err.message };
        delete pending[code];
      }
      await sleep(600);
    }
  }
  return results;
}

async function downloadSalesReport(code, reportDocumentId) {
  const doc = await spApi('get', `/reports/2021-06-30/documents/${reportDocumentId}`);
  const file = await axios.get(doc.url, { responseType: 'arraybuffer' });
  const raw = doc.compressionAlgorithm === 'GZIP' ? zlib.gunzipSync(file.data) : Buffer.from(file.data);
  const json = JSON.parse(raw.toString('utf8'));

  const byAsin = {};
  for (const row of json.salesAndTrafficByAsin || []) {
    const s = row.salesByAsin || {};
    const asin = row.childAsin || row.parentAsin;
    const prev = byAsin[asin] || { units: 0, orders: 0, refunds: 0, revenue: 0 };
    byAsin[asin] = {
      units: prev.units + (s.unitsOrdered || 0),
      orders: prev.orders + (s.totalOrderItems || 0),
      refunds: prev.refunds + (s.unitsRefunded || 0),
      revenue: Math.round((prev.revenue + (s.orderedProductSales?.amount || 0)) * 100) / 100,
      currency: s.orderedProductSales?.currencyCode || prev.currency || null
    };
  }
  console.log(`[SALES] ${code}: ${Object.keys(byAsin).length} ASINs`);
  return byAsin;
}

// FBA inventory for every SKU in a marketplace (paginated), summed per ASIN
async function getInventory(code, marketplaceId) {
  const byAsin = {};
  const startedAt = Date.now();
  let pages = 0;
  let nextToken = null;
  do {
    const query = `granularityType=Marketplace&granularityId=${marketplaceId}&marketplaceIds=${marketplaceId}&details=true` +
      (nextToken ? `&nextToken=${encodeURIComponent(nextToken)}` : '');
    const data = await spApi('get', `/fba/inventory/v1/summaries?${query}`);
    pages++;
    for (const inv of data.payload?.inventorySummaries || []) {
      const d = inv.inventoryDetails || {};
      const prev = byAsin[inv.asin] || { stockFBA: 0, stockTotal: 0, inbound: 0 };
      byAsin[inv.asin] = {
        stockFBA: prev.stockFBA + (d.fulfillableQuantity || 0),
        stockTotal: prev.stockTotal + (inv.totalQuantity || 0),
        inbound: prev.inbound + (d.inboundWorkingQuantity || 0) + (d.inboundShippedQuantity || 0) + (d.inboundReceivingQuantity || 0)
      };
    }
    nextToken = data.pagination?.nextToken;
    if (nextToken) await sleep(600);
  } while (nextToken);
  console.log(`[INVENTORY] ${code}: ${Object.keys(byAsin).length} ASINs (${pages} pages, ${Math.round((Date.now() - startedAt) / 1000)}s)`);
  return byAsin;
}

// Stock: one fetch for the shared EU pool, plus one for each marketplace outside it
async function getAllInventory(codes) {
  const euCode = codes.find(c => EU_POOL.includes(c));
  const inventory = {};
  for (const code of codes.filter(c => !EU_POOL.includes(c) || c === euCode)) {
    try {
      inventory[code] = await getInventory(code, MARKETPLACES[code]);
    } catch (err) {
      console.error(`[INVENTORY] ${code}: ${err.message}`);
      inventory[code] = null;
    }
  }
  for (const code of codes) {
    if (EU_POOL.includes(code)) inventory[code] = inventory[euCode];
  }
  return inventory;
}

let latest = loadSavedData(); // { at, markets }
let refreshing = null;

function loadSavedData() {
  try {
    const saved = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    console.log(`[SYNC] Loaded saved data from ${new Date(saved.at).toISOString()}`);
    return saved;
  } catch {
    return null;
  }
}

// Refresh stock for every marketplace, and sales for marketplaces whose sales are missing or
// older than SALES_REFRESH_MS (reports and stock run side by side)
async function refreshAllMarkets() {
  const codes = Object.keys(MARKETPLACES);
  const startedAt = Date.now();
  const previous = latest?.markets || {};
  const salesDue = codes.filter(c => !previous[c]?.sales || !previous[c]?.salesAt || startedAt - previous[c].salesAt > SALES_REFRESH_MS);
  console.log(`[SYNC] Refreshing stock for ${codes.length} marketplaces; sales for ${salesDue.length ? salesDue.join(', ') : 'none (still fresh)'}`);

  const [reports, inventory] = await Promise.all([
    salesDue.length ? getAllSalesReports(salesDue) : {},
    getAllInventory(codes)
  ]);

  const markets = {};
  for (const code of codes) {
    const report = reports[code];
    markets[code] = {
      sales: report?.sales || previous[code]?.sales || null,
      salesAt: report?.sales ? report.at : previous[code]?.salesAt || null,
      // Keep the previous stock if this fetch failed
      inventory: inventory[code] || previous[code]?.inventory || null,
      error: report?.error || null
    };
    if (markets[code].error) console.error(`[SALES] ${code}: ${markets[code].error}`);
  }

  latest = { at: Date.now(), markets };
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(latest));
  } catch (err) {
    console.error('[SYNC] Could not save data:', err.message);
  }
  console.log(`[SYNC] Refresh done in ${Math.round((Date.now() - startedAt) / 1000)}s`);
  return latest;
}

function startRefresh() {
  if (!refreshing) {
    refreshing = refreshAllMarkets()
      .catch(err => { console.error('[SYNC] Refresh failed:', err.message); throw err; })
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

// Latest data; waits for the first refresh if the server has just started
async function getMarkets() {
  if (latest) return latest;
  return startRefresh();
}

function buildProduct(asin, markets, lastSync) {
  const perMarket = {};
  let sales = 0, orders = 0, refunds = 0;
  const revenueByCurrency = {};
  let euStock = null;
  let stockFBA = 0, stockTotal = 0;

  for (const [code, m] of Object.entries(markets)) {
    const s = m.sales?.[asin];
    const inv = m.inventory?.[asin];
    if (!s && !inv) continue;

    perMarket[code] = {
      units: s?.units || 0,
      orders: s?.orders || 0,
      refunds: s?.refunds || 0,
      revenue: s?.revenue || 0,
      currency: s?.currency || null,
      stockFBA: inv?.stockFBA || 0,
      stockTotal: inv?.stockTotal || 0,
      inbound: inv?.inbound || 0
    };

    sales += perMarket[code].units;
    orders += perMarket[code].orders;
    refunds += perMarket[code].refunds;
    if (s?.currency) {
      revenueByCurrency[s.currency] = Math.round(((revenueByCurrency[s.currency] || 0) + s.revenue) * 100) / 100;
    }

    if (inv) {
      if (EU_POOL.includes(code)) {
        // Shared Pan-EU pool: take the largest single-market view rather than summing duplicates
        if (!euStock || inv.stockTotal > euStock.stockTotal) euStock = inv;
      } else {
        stockFBA += inv.stockFBA;
        stockTotal += inv.stockTotal;
      }
    }
  }
  if (euStock) {
    stockFBA += euStock.stockFBA;
    stockTotal += euStock.stockTotal;
  }

  return {
    asin,
    sales,
    orders,
    refunds,
    revenueByCurrency,
    stockFBA,
    stockTotal,
    markets: perMarket,
    periodDays: SALES_DAYS,
    lastSync,
    success: true
  };
}

app.get('/sync', async (req, res) => {
  try {
    console.log('[REQUEST] Received sync request');
    const asins = String(req.query.asins || '').split(',').map(a => a.trim()).filter(a => a);
    console.log(`[REQUEST] ASINs: ${asins.length} items`);

    if (!asins.length) {
      return res.status(400).json({ error: 'No ASINs provided' });
    }

    const { at, markets } = await getMarkets();
    const lastSync = new Date(at).toISOString();
    const data = {};
    for (const asin of asins) data[asin] = buildProduct(asin, markets, lastSync);

    const failed = Object.entries(markets).filter(([, m]) => m.error || !m.inventory).map(([code]) => code);
    if (failed.length) console.warn(`[RESPONSE] Incomplete markets: ${failed.join(', ')}`);
    console.log(`[RESPONSE] ${asins.length} ASINs across ${Object.keys(markets).length} marketplaces`);

    res.json(data);
  } catch (error) {
    console.error('[ERROR] Sync request failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    marketplaces: Object.keys(MARKETPLACES),
    dataUpdated: latest ? new Date(latest.at).toISOString() : null,
    refreshing: Boolean(refreshing),
    timestamp: new Date().toISOString()
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`🌍 Marketplaces: ${Object.keys(MARKETPLACES).join(', ')}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔄 Sync endpoint: http://localhost:${PORT}/sync?asins=ASIN1,ASIN2\n`);

  // Load data now and keep it fresh, so the dashboard's Sync button answers immediately
  startRefresh().catch(() => {});
  setInterval(() => startRefresh().catch(() => {}), REFRESH_MS);
});
