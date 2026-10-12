const express = require('express');
const axios = require('axios');
const cors = require('cors');

const app = express();
app.use(cors());
app.use(express.json());

// Amazon credentials (load from environment variables)
const CONFIG = {
  clientId: process.env.AMAZON_CLIENT_ID,
  clientSecret: process.env.AMAZON_CLIENT_SECRET,
  refreshToken: process.env.AMAZON_REFRESH_TOKEN,
  sellingPartnerId: process.env.AMAZON_SELLER_ID || 'A12MJTUALT3TNJ',
  endpoint: 'https://sellingpartnerapi-eu.amazon.com',
  marketplaceId: process.env.AMAZON_MARKETPLACE_ID || 'A1F83G8C2ARO7P'
};

// Validate credentials on startup
if (!CONFIG.clientId || !CONFIG.clientSecret || !CONFIG.refreshToken) {
  console.error('❌ ERROR: Missing Amazon credentials in environment variables');
  console.error('Required: AMAZON_CLIENT_ID, AMAZON_CLIENT_SECRET, AMAZON_REFRESH_TOKEN');
  process.exit(1);
}

let cachedToken = null;
let tokenExpiry = null;

async function getAccessToken() {
  if (cachedToken && tokenExpiry && Date.now() < tokenExpiry) {
    console.log('[TOKEN] Using cached token');
    return cachedToken;
  }

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

async function getProductMetrics(asin) {
  try {
    const token = await getAccessToken();

    // Get sales metrics
    const salesUrl = `${CONFIG.endpoint}/sales/v1/orderMetrics?marketplaceIds=${CONFIG.marketplaceId}&interval=DAY&granularity=TOTAL&timePeriodType=PREVIOUS_30_DAYS`;
    console.log(`[SALES] Fetching for ${asin}...`);

    const salesResponse = await axios.get(salesUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-amzn-requestid': Math.random().toString(36).substring(7)
      }
    });

    let sales = 0, orders = 0, refunds = 0;
    if (salesResponse.data?.payload?.length > 0) {
      const metric = salesResponse.data.payload[0];
      sales = metric.unitsSold || 0;
      orders = metric.ordersCount || 0;
      refunds = metric.refundsCount || 0;
    }
    console.log(`[SALES] ${asin}: units=${sales}, orders=${orders}, refunds=${refunds}`);

    // Get inventory metrics
    const inventoryUrl = `${CONFIG.endpoint}/fba/inventory/v1/summaries?marketplaceIds=${CONFIG.marketplaceId}&details=true`;
    console.log(`[INVENTORY] Fetching for ${asin}...`);

    const inventoryResponse = await axios.get(inventoryUrl, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'x-amzn-requestid': Math.random().toString(36).substring(7)
      }
    });

    let stockFBA = 0, stockTotal = 0;
    if (inventoryResponse.data?.payload?.inventories) {
      const inv = inventoryResponse.data.payload.inventories.find(i => i.asin === asin);
      if (inv?.inventorySummary) {
        stockFBA = inv.inventorySummary.fulfillableQuantity || 0;
        stockTotal = (inv.inventorySummary.fulfillableQuantity || 0) + (inv.inventorySummary.reservedQuantity || 0);
      }
    }
    console.log(`[INVENTORY] ${asin}: FBA=${stockFBA}, Total=${stockTotal}`);

    return {
      asin,
      sales,
      orders,
      refunds,
      stockFBA,
      stockTotal,
      lastSync: new Date().toISOString(),
      success: true
    };
  } catch (error) {
    console.error(`[ERROR] ${asin}:`, error.message);
    return {
      asin,
      error: error.message,
      success: false
    };
  }
}

async function syncMultipleASINs(asins) {
  const results = {};
  console.log(`[SYNC] Starting sync for ${asins.length} ASINs`);

  for (let i = 0; i < asins.length; i++) {
    const asin = asins[i];
    console.log(`[SYNC] ${i + 1}/${asins.length} - Processing ${asin}`);
    results[asin] = await getProductMetrics(asin);
    if (i < asins.length - 1) await new Promise(r => setTimeout(r, 100));
  }

  console.log('[SYNC] Completed');
  return results;
}

app.get('/sync', async (req, res) => {
  try {
    console.log('[REQUEST] Received sync request');
    const asinParam = req.query.asins || '';

    let asins = [];
    if (asinParam.includes(',')) {
      asins = asinParam.split(',').map(a => a.trim()).filter(a => a);
    } else {
      asins = asinParam ? [asinParam] : [];
    }

    console.log(`[REQUEST] ASINs: ${asins.length} items`);

    if (!asins.length) {
      return res.status(400).json({ error: 'No ASINs provided' });
    }

    const data = await syncMultipleASINs(asins);
    const successCount = Object.values(data).filter(d => d.success).length;
    console.log(`[RESPONSE] Success: ${successCount}/${asins.length}`);

    res.json(data);
  } catch (error) {
    console.error('[ERROR] Sync request failed:', error.message);
    res.status(500).json({ error: error.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`\n✅ Server running on port ${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
  console.log(`🔄 Sync endpoint: http://localhost:${PORT}/sync?asins=ASIN1,ASIN2\n`);
});
