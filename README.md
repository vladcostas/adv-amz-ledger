# ADV Amazon Ledger

Seller dashboard for ADV products: monthly sales, stock, Keepa BSR / Buy Box.

- **Live dashboard:** https://vladcostas.github.io/adv-amz-ledger/ (served from `index.html` on `main`)
- **Sync server:** `server.js` (Node.js, port 3000) – Amazon SP-API sales + FBA stock

## Setup (Windows or Mac)

Needs: Git, Node.js 20.6+, Python 3.

```bash
git clone https://github.com/vladcostas/adv-amz-ledger.git
cd adv-amz-ledger
npm install
```

Copy `.env.example` to `.env` and fill in the keys (get them from the team via a
password manager — never chat/email). `.env` is git-ignored; never commit it.

Start the sync server:

```bash
npm run dev
```

`✅ Server running on port 3000` means the keys loaded.

### What the sync server does

- Covers all 12 marketplaces: UK, DE, FR, ES, IT, NL, BE, PL, SE, IE, AE, SA
  (limit with `AMAZON_MARKETPLACES=DE,FR,UK` in `.env`).
- **Sales** (last 30 days, per product and country) come from Amazon's Sales & Traffic report.
  Amazon's figures lag about 2 days, and it only lets us create a few reports every few minutes,
  so sales refresh every 6 hours. The first start after a fresh setup can take ~10 minutes.
- **FBA stock** refreshes every 30 minutes. Pan-EU stock is counted once, not once per EU country.
- Data refreshes in the background and is saved to `amazon-data.json` (git-ignored), so the
  dashboard's Sync button answers instantly, even after a restart.
- `http://localhost:3000/health` shows when the data was last updated.
- On Windows PowerShell use `npm.cmd run dev` (plain `npm` is blocked by the default script policy).

## Working together

1. Get the latest: `git switch main` then `git pull`
2. Make a branch for your change: `git switch -c short-description`
3. Commit, then `git push -u origin short-description`
4. Open a pull request on GitHub and ask a colleague to review
5. Merge to `main` only after review — **anything on `main` goes live immediately**

Only one person should run the daily data sync, to avoid duplicate Keepa usage and conflicting commits.
