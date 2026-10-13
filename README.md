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

## Working together

1. Get the latest: `git switch main` then `git pull`
2. Make a branch for your change: `git switch -c short-description`
3. Commit, then `git push -u origin short-description`
4. Open a pull request on GitHub and ask a colleague to review
5. Merge to `main` only after review — **anything on `main` goes live immediately**

Only one person should run the daily data sync, to avoid duplicate Keepa usage and conflicting commits.
