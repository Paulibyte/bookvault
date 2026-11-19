// Usage: node scripts/create-admin.js "Full Name" email@example.com password
// Creates an admin, or promotes an existing account (and resets its password if given).
const bcrypt = require('bcryptjs');
const { db } = require('../src/db');
const [name, email, password] = process.argv.slice(2);
if (!email) { console.log('Usage: node scripts/create-admin.js "Full Name" email password'); process.exit(1); }
const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email.toLowerCase());
if (u) {
  db.prepare('UPDATE users SET is_admin = 1, is_blocked = 0 WHERE id = ?').run(u.id);
  if (password) db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(bcrypt.hashSync(password, 10), u.id);
  console.log('Promoted to admin:', email);
} else {
  if (!password || !name) { console.log('Name and password are required for a new admin.'); process.exit(1); }
  db.prepare('INSERT INTO users (full_name, email, phone, password_hash, is_admin) VALUES (?, ?, ?, ?, 1)').run(name, email.toLowerCase(), '', bcrypt.hashSync(password, 10));
  console.log('Admin created:', email);
}
