# Deploy Node.js Sync Server to Replit

## Step 1: Create Replit Project

Go to https://replit.com and click **Import from GitHub**

Paste:
```
https://github.com/vladcostas/adv-amz-ledger
```

## Step 2: Add Secrets

Click **Secrets** (lock icon) on left sidebar.

Add these environment variables (values from your LWA credentials file):

```
AMAZON_CLIENT_ID = [your value]
AMAZON_CLIENT_SECRET = [your value]  
AMAZON_REFRESH_TOKEN = [your value]
```

## Step 3: Run

Click **Run** - server starts automatically

You'll get a URL like: `https://projectname.replit.dev`

## Step 4: Test

Visit: `https://projectname.replit.dev/health`

Should return JSON with status ok.

## Step 5: Update Dashboard

In `index.html`, find and update:

```javascript
const SYNC_ENDPOINT = 'https://projectname.replit.dev/sync';
```

Then push to GitHub and reload the dashboard.

## Later Migration

The code is standard Node.js + Express, so you can migrate to:
- Railway.app
- Render.com
- Your own server

Just set the same environment variables and run `npm start`.
