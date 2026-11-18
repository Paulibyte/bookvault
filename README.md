# BookVault: eBook & course-file store

Sell PDF textbooks, Word handouts and ZIP packs to students. Every PDF and Word copy is **personalised automatically**: the buyer's name, email and phone are printed in the header, the order number and date go in the footer, your logo sits faded in the centre of every page, and the file opens only with a **password unique to that buyer**. Buyers download a `.zip` from their library. You don't do any watermarking or WhatsApp sending yourself any more.

## What's inside

**For students (the store)**
- **Books** and **Apps & Software** tabs, with search, categories and sorting: *Most popular* (sales and ratings combined), *Best selling*, *Top rated*, *Newest* and price. The top 3 titles get a **#1 / #2 / #3 Bestseller** badge.
- Ratings and reviews (1–5 stars) from **verified buyers only**
- Checkout with **OPay** or **direct bank deposit** (upload a receipt; the admin confirms)
- **My Library**
  - **📖 Read** opens the book inside the app, with zoom, night mode and the last page remembered
  - **Save offline** keeps the book on the device so it opens without internet (see *Saved books*)
  - **🎧 Listen** reads the book aloud, with a choice of voice and speed, and turns pages automatically
  - **⬇ Download .zip**: the watermarked, password-protected file, as before
- **Install prompt**: Android, Windows and Mac (Chrome/Edge) get an "Install" banner. iPhone users get "Share → Add to Home Screen" instructions.
- Logging out clears books saved on that device, so shared phones and laptops stay safe

**For authors (`/author`)**
- Apply with a pen name, legal name, bio, ID document and photo. The admin verifies the application.
- Submit books (PDF/Word) or software (ZIP), each with a **copyright declaration**:
  - how they hold the rights (sole author / co-author / licensed)
  - ISBN, publisher and edition
  - four declarations
  - a typed signature that must match their legal name
  - an optional supporting document
  The date, time and IP address are recorded with each declaration.
- Titles go live only after **admin approval**. Replacing a file or changing a title sends it back for review.
- Sales dashboard: earnings by month, sales by title, recent sales and ratings
- **Royalties**
  - Authors add bank details, then either **request a payout** or switch on **automatic payout**, which raises a request as soon as their balance reaches the minimum
  - Each request shows in *Admin → Payouts* for you to pay

**For you (`/admin`)**
- Everything from before, plus:
  - **Authors**: verify, reject or suspend, view their ID, and override the commission per author
  - **Products → Awaiting review**: read the copyright declaration, download the original file, then **Approve & publish** or **Send back** with a note
  - **Payouts**: see the author's bank details and the amount, make the transfer from your bank, then **Mark paid** with the transfer reference. You can also see balances still owed.
  - **Reviews**: hide or show reviews
- **Settings → Authors, royalties & reviews**
  - Store commission (default 30%; the author keeps 70%)
  - Minimum payout (default ₦5,000)
  - Turn author sign-ups and reviews on or off

**File rules**
| Uploaded as | What the buyer gets |
|---|---|
| Book `.pdf` | Watermarked, AES-256-locked PDF in a zip, **plus** the in-app reader |
| Book `.docx` | Watermarked, password-encrypted Word file in a zip, **plus** the in-app reader (a PDF copy is made automatically if LibreOffice is installed) |
| **Software** (any file, `.zip` recommended) | Exactly what was uploaded, **never stamped or watermarked**; non-zip files are wrapped in a zip |

## Run on your Hostinger VPS (alongside Reseeti/Jobtins)

```bash
# 1. system packages (qpdf does the PDF encryption)
sudo apt update && sudo apt install -y qpdf
# optional, lets students read Word books in the app (~300 MB):
sudo apt install -y libreoffice-writer --no-install-recommends

# 2. code
cd /var/www && sudo git clone https://github.com/<you>/bookvault.git && cd bookvault
# (or upload this folder and unzip it here)
npm install --omit=dev

# 3. config
cp .env.example .env
nano .env        # set APP_URL, SESSION_SECRET, OPay keys
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"   # paste as SESSION_SECRET

# 4. start with PM2
pm2 start ecosystem.config.js && pm2 save
```

**Nginx** (`/etc/nginx/sites-available/books.yourdomain.com`):
```nginx
server {
    server_name books.yourdomain.com;
    client_max_body_size 600M;          # big textbook uploads
    proxy_read_timeout 300s;            # first download of a large book takes a few seconds
    location / {
        proxy_pass http://127.0.0.1:3050;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```
```bash
sudo ln -s /etc/nginx/sites-available/books.yourdomain.com /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx
sudo certbot --nginx -d books.yourdomain.com
```
Add an **A record** for `books` pointing at your VPS IP in Hostinger DNS.

## First login
1. Open the site and click **Log in → Create an account**. **The first account created becomes the admin.**
2. Go to **Admin → Settings** and fill in your bank details, upload your logo (a transparent PNG works best) and adjust the header/footer text.
3. Go to **Products → Add product**, upload a book, then click **Test copy** to check the watermark.

If you're locked out: `node scripts/create-admin.js "Your Name" you@email.com NewPassword`

## OPay setup
1. In the OPay merchant dashboard, copy your **Merchant ID**, **Public key** and **Secret key** into `.env`.
2. Keep `OPAY_MODE=sandbox` and do a test purchase. When it unlocks correctly, change it to `live` and run `pm2 restart bookvault`.
3. In **Admin → Settings**, tick *Accept online payment with OPay*.

The app never trusts the redirect or webhook alone. It always asks OPay's status API (signed with HMAC-SHA512) and checks the amount before unlocking. Webhook URL: `https://books.yourdomain.com/payments/opay/webhook` (sent automatically with each payment).

## Backups
Everything lives in two folders: `data/` (the database) and `storage/` (books, covers, receipts and generated copies). Back them up regularly, for example:
```bash
tar czf ~/bookvault-backup-$(date +%F).tgz -C /var/www/bookvault data storage
```
`storage/deliveries/` only holds cached buyer copies and can be deleted at any time; they regenerate on the next download.

## Updating an existing install
Your existing database upgrades itself automatically the first time the new version starts. Products, orders and buyers are kept.
```bash
cd /var/www/bookvault && git pull && npm ci --omit=dev && pm2 restart bookvault
```
If npm warns about install scripts, run `npm install-scripts approve better-sqlite3 && npm rebuild better-sqlite3`.

## Updating (general)
```bash
cd /var/www/bookvault && git pull && npm ci --omit=dev && pm2 restart bookvault
```
Keep server-only edits in `.env`, never in `package.json`, so `git pull` doesn't conflict.

## Tech
Node.js 18+ · Express · EJS · SQLite (better-sqlite3) · PDF.js (in-app reader) · Web Speech API (read-aloud) · Service Worker (offline) · pdf-lib + qpdf (PDF) · JSZip + officecrypto-tool (Word) · sharp (images) · archiver (zip).
Run a single instance; SQLite and the on-the-fly watermarking expect one process.
