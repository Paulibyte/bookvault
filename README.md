# BookVault: eBook & course-file store

Sell PDF textbooks, Word handouts and ZIP packs to students. Every PDF and Word copy is **personalised automatically**: the buyer's name, email and phone are printed in the header, the order number and date go in the footer, your logo sits faded in the centre of every page, and the file opens only with a **password unique to that buyer**. Buyers download a `.zip` from their library. You don't do any watermarking or WhatsApp sending yourself any more.

## What's inside

**For students (the store)**
- A catalogue with covers, prices, categories, search and filters (PDF / Word / packs)
- A cart and checkout with **OPay Checkout** (card, transfer, USSD, wallet; unlocks instantly) or **direct bank deposit** (the student uploads a receipt and you confirm it)
- **My Library**: download buttons and the password for each book, with a Copy button
- Installs on a phone like an app (PWA: "Add to Home screen")

**For you (`/admin`)**
- A dashboard showing revenue, transfers waiting to be confirmed, a 14-day sales chart and best sellers
- Products: upload a file and cover, write a description, set the price and category, show or hide it, turn protection on or off. Use **Test copy** to see exactly what a buyer receives.
- Orders: view the receipt, then **Confirm** or **Reject** with a note. You can re-check an order with OPay, reset a buyer's download count and see the download log (IP and device).
- Customers: block an account, reset a password, correct a name (their books regenerate) and **Give a product** for cash payments
- Settings: bank details, header/footer templates, watermark logo, opacity and size, a download limit, and whether PDFs can be printed

**File rules**
| Uploaded file | What the buyer gets |
|---|---|
| `.pdf` | Watermarked and AES-256 password-locked PDF inside a zip (editing and copying are blocked; printing is optional) |
| `.docx` | Header, footer and logo added to every section, then password-encrypted (opens in Word, WPS and LibreOffice) inside a zip |
| `.zip` | Your zip, unchanged |
| anything else | Wrapped in a zip, unchanged |

Old `.doc` files can't be watermarked. Open them in Word and use **Save As → .docx** first.

## Run on your Hostinger VPS (alongside Reseeti/Jobtins)

```bash
# 1. system packages (qpdf does the PDF encryption)
sudo apt update && sudo apt install -y qpdf

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

## Updating
```bash
cd /var/www/bookvault && git pull && npm install --omit=dev && pm2 restart bookvault
```
Keep server-only edits in `.env`, never in `package.json`, so `git pull` doesn't conflict.

## Tech
Node.js 18+ · Express · EJS · SQLite (better-sqlite3) · pdf-lib + qpdf (PDF) · JSZip + officecrypto-tool (Word) · sharp (images) · archiver (zip).
Run a single instance; SQLite and the on-the-fly watermarking expect one process.
