# Zadona — Sales, Inventory & Debt Tracker

A Swahili-language duka (shop) sales system: track inventory, record sales
(cash or on credit), and manage customer debts.

## Stack
- **Backend:** Node.js + Express
- **Database:** PostgreSQL (via `pg`)
- **Frontend:** Static HTML/CSS/JS served from `/public`

## Project structure
```
zadona-app/
├── server.js        # Express app + REST API
├── db.js            # PostgreSQL connection pool
├── schema.sql       # Table definitions (auto-run on startup)
├── package.json
├── .env.example
└── public/
    └── index.html   # Frontend (fetches data from /api/*)
```

## Run locally

1. Install dependencies:
   ```
   npm install
   ```
2. Copy `.env.example` to `.env` and point `DATABASE_URL` at a local
   PostgreSQL database (create one first, e.g. `createdb zadona`).
   Optionally add Twilio SMS settings to deliver password reset codes by phone:
   ```
   TWILIO_ACCOUNT_SID=your_account_sid
   TWILIO_AUTH_TOKEN=your_auth_token
   TWILIO_FROM_PHONE=+1234567890
   ```
3. Start the app:
   ```
   npm start
   ```
4. Open http://localhost:3000

The schema (`schema.sql`) runs automatically on every startup using
`CREATE TABLE IF NOT EXISTS`, so there's no separate migration step.

## Deploy to Railway

1. Push this project to GitHub.
2. In Railway: **New Project → Deploy from GitHub repo**, pick this repo.
3. **Add a PostgreSQL database**: New → Database → PostgreSQL. Railway
   automatically injects `DATABASE_URL` into your app service — you don't
   need to copy/paste it.
4. Confirm the app's **Start Command** is `npm start` (Railway usually
   detects this from `package.json` automatically).
5. Once deployed, open the generated Railway URL — the app will create its
   tables on first boot.

## API summary

| Method | Path                          | Purpose                          |
|--------|-------------------------------|-----------------------------------|
| GET    | /api/inventory                | List all items                   |
| POST   | /api/inventory                | Add new item                     |
| PATCH  | /api/inventory/:id/stock      | Adjust stock (`{ delta }`)       |
| DELETE | /api/inventory/:id            | Delete item                      |
| GET    | /api/sales                    | List all sales                   |
| POST   | /api/sales                    | Record a sale (decrements stock) |
| PATCH  | /api/sales/:id/mark-paid      | Mark one sale as fully paid      |
| POST   | /api/debts/pay                | Apply a partial/full payment     |
| POST   | /api/debts/pay-all            | Clear all debt for one customer  |

## Notes
- Sale creation and stock deduction happen in a single database
  transaction, so stock can never go negative even under concurrent sales.
- Debt payments are applied oldest-sale-first, matching the original
  behavior of the app.
