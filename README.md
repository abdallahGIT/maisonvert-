# Coeur de Boeuf tomato seeds: landing page, COD orders, admin

- `/` is the landing page (Arabic, RTL, mobile-first)
- `/admin` is the admin page (password protected)
- `api/` holds the serverless functions (Vercel)

## Features

- **Order form:** phone first (digits only, max 10, must start with 05/06/07), name, wilaya, then a commune dropdown filtered by wilaya (58 wilayas, 1,541 communes), reference / nearest landmark, and quantity.
- **Leads:** as soon as a visitor types 3 phone digits, they're saved as a lead. The same browser keeps updating one row. Once they order, the lead is marked as "ordered".
- **Telegram:** every order is sent to Telegram, independently of the database. If the DB is down, the order still reaches Telegram, marked "not saved". If Telegram is down, the order still saves.
- **Duplicate guard:** the same phone within 15 minutes counts as one order.
- **Admin page:**
  - orders with status (new, confirmed, no answer, cancelled, shipped, delivered, returned), notes, search, and CSV export
  - a leads-to-call list
  - a price sheet. The sell price shown on the landing page comes from here.
  - weekly profit and cost, with ad spend in $ times that week's dollar rate
  - a chart of this week vs last week: confirmation rate, orders, confirmed orders, leads

Weeks start on Saturday (Algeria time).

## Deploy on Vercel

1. Import this repo in Vercel (Add New, then Project). Leave the framework as "Other" with no build command. `vercel.json` already sets it up.
2. Go to Storage, Create Database, choose **Neon (Postgres)**, and connect it to the project. This adds `DATABASE_URL` automatically. Tables are created on the first request.
3. Under Settings, then Environment Variables, add:
   - `ADMIN_PASSWORD`: a long password for `/admin`
   - `TELEGRAM_BOT_TOKEN`: the bot token from @BotFather
   - `TELEGRAM_CHAT_ID`: your chat id. Use `/admin`, then the Telegram tab, then "find Chat ID" after sending /start to the bot. For several chats, separate the ids with commas.
4. Redeploy. Open `/admin`, set the prices in the price sheet tab, then press the Telegram test button.

## Local development

```bash
npm install
DATABASE_URL=postgresql://postgres:pg@localhost:5432/tomato ADMIN_PASSWORD=test node dev-server.js
```
