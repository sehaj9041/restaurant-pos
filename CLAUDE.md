# Vishal Foodiez restaurant POS

## How to work with me (user preferences)
- User writes Hinglish. Reply in Hinglish, short and direct. No long summaries, no recap of what the code does.
- Do NOT end with "commit kar doon?". Commit/push only when asked. (Auto-commits happen on the user's side; Render deploys from `main`.)
- Fix what was asked, do not refactor around it. Ask a question only when the choice really changes the work.
- Say plainly when something was not run/tested (no local Postgres, no printer, no browser here).

## Stack
- `server.js` (Express 5) + `database.js` (Postgres via `pg`, SQLite-style `db.get/all/run` wrapper, `?` placeholders). Deployed on Render (`render-build.sh`). **No usable local DB**: `restaurant.db` is a stale SQLite file, ignore it.
- Pages are static files in `public/` (no framework): `index.html` POS, `kiosk.html`, `kitchen.html` (KDS), `order.html` (website ordering), `table-order.html` (table QR), `admin.html`, `token-display.html`, `feedback.html`. Owner reports: `private/reports-all.html` (+ `reports.js`, the page the owner really uses) and older `private/report.html`; both are served under a secret URL.
- Other modules: `engagement.js` (coupons, loyalty, feedback), `tableQr.js`, `menuImport.js` (Excel import), `paytmUpi.js`, `razorpayPay.js`, `staff*.js`.
- Clients that hardcode `https://menu.vishalfoodiez.in` (do not rename/remove that host): desktop POS exe (`desktop/main.js`), `android-tv-kds`, `android-tv-token`, `printer agent/`. Customer site is `orders.vishalfoodiez.in`; `vishalfoodiez.in` landing page is `public/site/index.html`.
- iOS app is a separate Xcode project: `~/Documents/Vishal Foodiez` (WebView of orders.vishalfoodiez.in, Firebase push).

## Gotchas
- **Line endings**: CRLF files: `server.js`, `database.js`, `public/index.html`, `public/kitchen.html`, `public/admin.html`, `public/order.html`, `private/report.html`. All others are LF. Keep each file's endings (edit in place; for scripted edits read bytes, convert, write back, and check `git diff --stat` is small).
- Syntax-check after edits: `node --check file.js`; for html, parse the `<script>` blocks with `new Function`.
- Prices for website orders are recomputed server-side (`validateOnlineItems`), so any new add-on source must also be added there.
- Images are stored in Postgres (`uploaded_files`), served by `/uploads/:name`; uploads are resized to 900px WebP with `sharp`; old big ones are compressed in the background after startup.
- Menu/addon API responses are cached (`menuCache`); every write under `/api` clears it.

## Domain logic worth knowing
- **Add-on groups** (`addon_groups`): items are `{name, price, image, available}`. `source_category` makes a group pull its items live from a menu category. Upsells with `as_addon = 1` (Admin > Upsells, cross-sell) become virtual groups with negative ids (`crossSellData`, `applyCrossSell` in server.js); the admin UI uses `/api/addon-groups?admin=1` so it never sees them. Per-size groups: `variation.addon_groups` override the item's.
- **KDS** (`/api/kot`): order = when the order first reached the KDS (`kds_seq_at`, stamped by a Postgres trigger on every move into `RUNNING_TABLE`). Timer starts from `kds_at` (also reset when new items are added to a running KOT). `accepted_at`/`created_at` are only fallbacks.
- **Veg/Non-veg**: `menu.food_type` (`veg|nonveg|egg`); KDS/report match order lines to the menu by item name (strip trailing `(...)`, prefix match before `(`, `-`, `:`, `,`).
- **Feedback**: receipt/kiosk/website use signed links (`/api/feedback/qr/:orderId`); `feedback.html?g=1` is the order-less version (token display QR). 4-5 stars show the Google review button (`google_review_url` setting).
- **Printing**: kiosk bill is drawn to a canvas and sent as ESC/POS raster (red slots are replaced by QR images, detected by connected regions). POS desktop exe sends the bill HTML to `printBillBitmap` in `desktop/main.js`; `index.html` renders it at CSS zoom 2.2 so the capture is crisp. Changing `desktop/main.js` needs a new exe (`cd desktop && npm run dist`); changing `index.html` does not.
- **Kiosk**: idle "Still thinking?" popup (`armIdleTimer`), done screen shows a rate-us QR for 12s.
