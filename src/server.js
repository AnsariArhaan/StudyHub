const express = require('express');
const session = require('express-session');
const FileStore = require('session-file-store')(session);
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const bcrypt = require('bcryptjs');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const app = express();
const PORT = Number(process.env.PORT || 3000);
const ROOT = path.join(__dirname, '..');
const DATA_DIR = path.join(ROOT, 'data');
const UPLOAD_DIR = path.join(ROOT, 'uploads');
const DB_FILE = path.join(DATA_DIR, 'db.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
fs.mkdirSync(UPLOAD_DIR, { recursive: true });

// B-01: values shipped in .env.example are public and must never run a live server.
const KNOWN_DUMMY_VALUES = new Set(['dummy-secret-key-12345', 'dummy-password-123', 'development-only-secret-change-me', 'CHANGE-ME-long-random-string', 'CHANGE-ME-min-12-chars']);
function isDummyValue(v) { return !v || KNOWN_DUMMY_VALUES.has(String(v).trim()); }

let SESSION_SECRET = process.env.SESSION_SECRET;
if (SESSION_SECRET && KNOWN_DUMMY_VALUES.has(SESSION_SECRET.trim())) {
  console.error('SESSION_SECRET is still the example value from .env.example. Set a long random secret in .env before starting StudyHub.');
  process.exit(1);
}
if (!SESSION_SECRET) {
  if (process.env.NODE_ENV === 'production') {
    console.error('SESSION_SECRET is required in production. Copy .env.example to .env and set it.');
    process.exit(1);
  }
  // Development fallback: random per boot, so signed session cookies from older runs never validate.
  SESSION_SECRET = crypto.randomBytes(32).toString('hex');
  console.warn('SESSION_SECRET is not set; using a random development secret. Existing sessions are invalidated on every restart.');
}

function readDb() {
  if (!fs.existsSync(DB_FILE)) return { users: [], materials: [], bookmarks: {} };
  let parsed;
  try { parsed = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('Database JSON could not be read:', e.message); throw e; }
  // B-07: tolerate older or partial files - missing keys fall back to empty collections.
  if (!parsed || typeof parsed !== 'object') parsed = {};
  if (!Array.isArray(parsed.users)) parsed.users = [];
  if (!Array.isArray(parsed.materials)) parsed.materials = [];
  if (!parsed.bookmarks || typeof parsed.bookmarks !== 'object' || Array.isArray(parsed.bookmarks)) parsed.bookmarks = {};
  return parsed;
}
let db = readDb();
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  const payload = JSON.stringify(db, null, 2);
  // B-07: flush to disk before the rename so a crash cannot leave a truncated db,
  // and keep one rolling backup of the last state for recovery.
  const fd = fs.openSync(tmp, 'w');
  try { fs.writeSync(fd, payload); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  fs.renameSync(tmp, DB_FILE);
  try { fs.copyFileSync(DB_FILE, DB_FILE + '.bak'); } catch {}
}
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt }; }
function safeText(v, max = 180) { return String(v ?? '').trim().slice(0, max); }
function findUserByEmail(email) { return db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase()); }

async function ensureAdmin() {
  const email = String(process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const existing = findUserByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') {
      // B-24: pointing ADMIN_EMAIL at an existing student used to crash the boot. Promote the account instead.
      existing.role = 'admin';
      saveDb();
      console.log(`Existing account ${email} promoted to admin to match ADMIN_EMAIL.`);
    }
    if (!Array.isArray(db.bookmarks[existing.id])) { db.bookmarks[existing.id] = []; saveDb(); }
    // B-01: an admin account created from the example password must not stay usable.
    if (await bcrypt.compare('dummy-password-123', existing.passwordHash)) {
      const rotation = process.env.ADMIN_PASSWORD;
      if (isDummyValue(rotation) || String(rotation).length < 12) {
        throw new Error(`The admin account ${email} still uses the example password from .env.example. Set a real ADMIN_PASSWORD (min 12 characters) in .env and restart; StudyHub will re-hash it onto the existing admin account.`);
      }
      existing.passwordHash = await bcrypt.hash(String(rotation), 12);
      saveDb();
      console.log(`Admin account ${email} password rotated away from the example value.`);
    }
    return;
  }
  const password = process.env.ADMIN_PASSWORD;
  if (isDummyValue(password)) throw new Error('ADMIN_PASSWORD is missing or still the example value. Set a real ADMIN_PASSWORD (min 12 characters) in .env.');
  if (String(password).length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  const admin = { id: crypto.randomUUID(), name: safeText(process.env.ADMIN_NAME || 'System Admin', 80), email, passwordHash: await bcrypt.hash(String(password), 12), role: 'admin', createdAt: new Date().toISOString() };
  db.users.push(admin);
  db.bookmarks[admin.id] = [];
  saveDb();
  console.log(`Initial admin created: ${email}`);
}

// Direct connections are the default. Trust only the deployment's known proxies.
const proxySetting = String(process.env.TRUST_PROXY || '0').trim();
if (proxySetting === 'true') throw new Error('TRUST_PROXY=true is unsafe. Use a known hop count or trusted proxy IPs/CIDRs.');
app.set('trust proxy', proxySetting === 'false' ? false : /^\d+$/.test(proxySetting) ? Number(proxySetting) : proxySetting.split(',').map(value => value.trim()));
app.disable('x-powered-by');
app.use(helmet({ contentSecurityPolicy: { directives: { defaultSrc: ["'self'"], scriptSrc: ["'self'"], styleSrc: ["'self'", "'unsafe-inline'"], imgSrc: ["'self'", 'data:'], objectSrc: ["'none'"], frameAncestors: ["'self'"] } } }));
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// B-12: session ids become file names in the file store. Only accept the id alphabet
// express-session generates, so a forged (but validly signed) id can never traverse paths.
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{8,128}$/;
function invalidSessionIdError() { const err = new Error('Invalid session id.'); err.status = 400; return err; }
class SafeFileStore extends FileStore {
  get(id, cb) { if (!SAFE_SESSION_ID.test(String(id))) return cb(invalidSessionIdError()); super.get(id, cb); }
  set(id, sess, cb) { if (!SAFE_SESSION_ID.test(String(id))) return cb && cb(invalidSessionIdError()); super.set(id, sess, cb); }
  destroy(id, cb) { if (!SAFE_SESSION_ID.test(String(id))) return cb && cb(invalidSessionIdError()); super.destroy(id, cb); }
  touch(id, sess, cb) { if (!SAFE_SESSION_ID.test(String(id))) return cb && cb(invalidSessionIdError()); super.touch(id, sess, cb); }
}

app.use(session({ store: new SafeFileStore({ path: path.join(DATA_DIR, 'sessions'), ttl: 8 * 60 * 60, retries: 0 }), name: 'smm.sid', secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 } }));

// B-04: bucket failed attempts per account+IP instead of per bare IP, and never count
// successful logins, so one campus NAT can no longer lock out every student behind it.
const ipKeyGenerator = rateLimit.ipKeyGenerator || ((ip) => ip);
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 40,
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => `${ipKeyGenerator(req.ip)}|${typeof req.body?.email === 'string' ? req.body.email.toLowerCase().slice(0, 254) : ''}`,
  handler: (_req, res) => res.status(429).json({ error: 'Too many attempts. Wait a few minutes and try again.' })
});
app.use(['/api/auth/login', '/api/auth/register'], authLimiter);

// B-14: lightweight CSRF defence - every mutating API call must carry the custom header
// the frontend sends. Cross-site forms cannot set custom headers, and SameSite=Lax stays on.
app.use('/api', (req, res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'XMLHttpRequest') {
    return res.status(403).json({ error: 'This request is missing a required header. Reload the page and try again.' });
  }
  next();
});

app.use(express.static(path.join(ROOT, 'public'), { index: 'index.html', maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0 }));

function auth(req, res, next) {
  const user = db.users.find(u => u.id === req.session.userId);
  if (!user) return res.status(401).json({ error: 'Please sign in to continue.' });
  req.user = user; next();
}
function adminOnly(req, res, next) {
  if (!req.user || req.user.role !== 'admin') return res.status(403).json({ error: 'Administrator access required.' });
  next();
}
function asyncRoute(fn) { return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next); }
function regenerateSession(req, userId) { // B-13
  return new Promise((resolve, reject) => req.session.regenerate(err => { if (err) return reject(err); req.session.userId = userId; resolve(); }));
}

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}.pdf`)
});
// Browser multipart filenames use UTF-8; explicit filename* charsets remain supported.
// B-21/B-22: extension and browser MIME type are no longer trusted or required here -
// every upload is verified against the real PDF structure after it lands.
const upload = multer({ storage, defParamCharset: 'utf8', limits: { fileSize: 20 * 1024 * 1024, files: 1 } });

// B-21: a real PDF starts with %PDF- and ends with %%EOF. Checking both stops text files
// that merely begin with the magic bytes, without rejecting valid PDFs (B-22).
function isRealPdf(filePath) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    if (size < 16) return false;
    const header = Buffer.alloc(5);
    if (fs.readSync(fd, header, 0, header.length, 0) !== header.length || !header.equals(Buffer.from('%PDF-'))) return false;
    const tailLength = Math.min(1024, size);
    const tail = Buffer.alloc(tailLength);
    fs.readSync(fd, tail, 0, tailLength, size - tailLength);
    return tail.includes('%%EOF');
  } catch { return false; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

// B-23: bcrypt ignores everything after the first 72 bytes, so longer passwords are
// silently truncated. Enforce the limit in bytes, not characters.
function passwordBytes(password) { return Buffer.byteLength(password, 'utf8'); }

// Missed-gap fix: block the most common passwords outright.
const COMMON_PASSWORDS = new Set(['password', 'password1', 'password123', '12345678', '123456789', '1234567890', 'qwerty123', 'letmein123', 'iloveyou', 'admin1234', 'welcome1', 'studyhub123', 'student123', 'changeme123']);

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'StudyHub' }));
app.get('/api/auth/config', (_req, res) => res.json({ inviteRequired: Boolean(process.env.REGISTRATION_INVITE_CODE) }));
app.get('/api/auth/me', (req, res) => {
  const user = db.users.find(u => u.id === req.session.userId);
  res.json({ user: user ? publicUser(user) : null });
});
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  // B-11: reject non-string fields instead of coercing them into "[object Object]".
  if (typeof req.body?.name !== 'string' || typeof req.body?.email !== 'string' || typeof req.body?.password !== 'string') {
    return res.status(400).json({ error: 'Name, email and password must be plain text.' });
  }
  const name = safeText(req.body.name, 80);
  const email = safeText(req.body.email, 254).toLowerCase();
  const password = req.body.password;
  if (name.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8) return res.status(400).json({ error: 'Password must be at least 8 characters.' });
  if (passwordBytes(password) > 72) return res.status(400).json({ error: 'Password must be 72 bytes or fewer (bcrypt ignores anything longer).' });
  if (COMMON_PASSWORDS.has(password.toLowerCase())) return res.status(400).json({ error: 'That password is too common. Pick something harder to guess.' });
  // B-03: registration can be gated with REGISTRATION_INVITE_CODE in .env.
  const inviteCode = process.env.REGISTRATION_INVITE_CODE;
  if (inviteCode && req.body.inviteCode !== inviteCode) return res.status(403).json({ error: 'Registration needs the invite code from your administrator.' });
  if (findUserByEmail(email)) return res.status(409).json({ error: 'This email cannot be used for a new account.' });
  const passwordHash = await bcrypt.hash(password, 12);
  // B-02: the email may have been registered while we were hashing - check again.
  if (findUserByEmail(email)) return res.status(409).json({ error: 'This email cannot be used for a new account.' });
  const user = { id: crypto.randomUUID(), name, email, passwordHash, role: 'student', createdAt: new Date().toISOString() };
  db.users.push(user); db.bookmarks[user.id] = []; saveDb();
  await regenerateSession(req, user.id); // B-13
  res.status(201).json({ user: publicUser(user) });
}));
const UNKNOWN_USER_HASH = bcrypt.hashSync(crypto.randomBytes(18).toString('hex'), 12);
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  if (typeof req.body?.email !== 'string' || typeof req.body?.password !== 'string') {
    return res.status(400).json({ error: 'Email and password must be plain text.' });
  }
  const email = safeText(req.body.email, 254).toLowerCase();
  const password = req.body.password;
  const user = findUserByEmail(email);
  // B-05: compare against a real hash even when the email does not exist, so the
  // response time is the same for known and unknown accounts.
  const ok = await bcrypt.compare(password, user ? user.passwordHash : UNKNOWN_USER_HASH);
  if (!user || !ok) return res.status(401).json({ error: 'Email or password is incorrect.' });
  await regenerateSession(req, user.id); // B-13
  res.json({ user: publicUser(user) });
}));
app.post('/api/auth/logout', (req, res) => req.session.destroy(() => { res.clearCookie('smm.sid', { httpOnly: true, sameSite: 'lax' }); res.json({ ok: true }); }));

// B-17: subject names are compared case-insensitively; the first spelling wins so
// "Math" and "math" can never become two different subjects.
function canonicalSubject(name) {
  const cleaned = safeText(name, 100);
  const existing = db.materials.find(m => m.subject.toLowerCase() === cleaned.toLowerCase());
  return existing ? existing.subject : cleaned;
}

// B-16: students only see display fields; internal storage names and uploader ids stay hidden.
function materialFor(user, material, saved) {
  const base = { id: material.id, title: material.title, subject: material.subject, description: material.description, originalName: material.originalName, size: material.size, uploadedByName: material.uploadedByName, createdAt: material.createdAt, bookmarked: saved.includes(material.id) };
  if (user.role === 'admin') { base.storedName = material.storedName; base.uploadedBy = material.uploadedBy; }
  return base;
}

app.get('/api/materials', auth, (req, res) => {
  const term = safeText(req.query.q, 120).toLowerCase();
  const subject = safeText(req.query.subject, 100).toLowerCase();
  const bookmarkedOnly = req.query.bookmarked === 'true';
  const saved = db.bookmarks[req.user.id] || [];
  let items = db.materials.filter(m => {
    const matchesTerm = !term || [m.title, m.subject, m.description, m.originalName, m.uploadedByName].some(v => String(v || '').toLowerCase().includes(term));
    const matchesSubject = !subject || m.subject.toLowerCase() === subject;
    const matchesBookmark = !bookmarkedOnly || saved.includes(m.id);
    return matchesTerm && matchesSubject && matchesBookmark;
  }).sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  res.json({ materials: items.map(m => materialFor(req.user, m, saved)), subjects: [...new Set(db.materials.map(m => m.subject))].sort() });
});
app.post('/api/materials', auth, adminOnly, upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a PDF file to upload.' });
  if (!isRealPdf(req.file.path)) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'The uploaded file is not a valid PDF.' });
  }
  const title = safeText(req.body.title, 140), subject = canonicalSubject(req.body.subject), description = safeText(req.body.description, 800);
  if (title.length < 2 || subject.length < 2) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Title and subject are required.' }); }
  const material = { id: crypto.randomUUID(), title, subject, description, originalName: path.basename(req.file.originalname).slice(0, 180), storedName: req.file.filename, size: req.file.size, uploadedBy: req.user.id, uploadedByName: req.user.name, createdAt: new Date().toISOString() };
  db.materials.push(material);
  try { saveDb(); } catch (e) { // B-20: never leave a file on disk that the database does not know about.
    db.materials = db.materials.filter(m => m.id !== material.id);
    fs.unlinkSync(req.file.path);
    throw e;
  }
  res.status(201).json({ material: materialFor(req.user, material, []) });
});
app.get('/api/materials/:id/pdf', auth, (req, res) => {
  const material = db.materials.find(m => m.id === req.params.id);
  if (!material) return res.status(404).json({ error: 'Material not found.' });
  const file = path.join(UPLOAD_DIR, path.basename(material.storedName));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'PDF file is missing from the server.' });
  res.setHeader('Content-Type', 'application/pdf');
  // B-15: PDFs sit behind a login - only this browser may cache them, never shared caches.
  res.setHeader('Cache-Control', 'private, max-age=0, must-revalidate');
  const filename = material.originalName; // B-31: the dead Buffer round-trip is gone.
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'document.pdf';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  res.setHeader('Content-Disposition', `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`);
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.sendFile(file);
});
app.delete('/api/materials/:id', auth, adminOnly, (req, res) => {
  const i = db.materials.findIndex(m => m.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Material not found.' });
  const [material] = db.materials.splice(i, 1);
  for (const userId of Object.keys(db.bookmarks)) db.bookmarks[userId] = db.bookmarks[userId].filter(id => id !== material.id);
  try { saveDb(); } catch (e) { db.materials.splice(i, 0, material); throw e; } // B-20
  // B-20: only delete the file once the database change is durable.
  const file = path.join(UPLOAD_DIR, path.basename(material.storedName));
  if (fs.existsSync(file)) fs.unlinkSync(file);
  res.json({ ok: true });
});
// B-25: the client sends the desired state instead of relying on a blind toggle.
app.post('/api/materials/:id/bookmark', auth, (req, res) => {
  if (!db.materials.some(m => m.id === req.params.id)) return res.status(404).json({ error: 'Material not found.' });
  const list = db.bookmarks[req.user.id] || [];
  const has = list.includes(req.params.id);
  const want = typeof req.body?.bookmarked === 'boolean' ? req.body.bookmarked : !has;
  if (want && !has) list.push(req.params.id);
  if (!want && has) list.splice(list.indexOf(req.params.id), 1);
  db.bookmarks[req.user.id] = list; saveDb(); res.json({ bookmarked: list.includes(req.params.id) });
});

app.get('/api/admin/summary', auth, adminOnly, (_req, res) => res.json({ users: db.users.length, students: db.users.filter(u => u.role === 'student').length, materials: db.materials.length, subjects: new Set(db.materials.map(m => m.subject)).size }));
app.get('/api/admin/users', auth, adminOnly, (_req, res) => res.json({ users: db.users.map(publicUser).sort((a,b) => b.createdAt.localeCompare(a.createdAt)) }));
app.delete('/api/admin/users/:id', auth, adminOnly, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: 'You cannot delete your own admin account.' });
  const target = db.users.find(u => u.id === req.params.id);
  if (!target) return res.status(404).json({ error: 'User not found.' });
  if (target.role === 'admin' && db.users.filter(u => u.role === 'admin').length <= 1) return res.status(400).json({ error: 'At least one administrator must remain.' });
  db.users = db.users.filter(u => u.id !== target.id); delete db.bookmarks[target.id]; saveDb(); res.json({ ok: true });
});

// Missed-gap fix: unknown API routes answer with JSON instead of Express's HTML
// "Cannot GET" page (which the service worker could previously cache as the app shell).
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

app.use((err, _req, res, _next) => {
  // B-10: bad JSON and oversized bodies are client errors (400/413), not 500s.
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'The request body is not valid JSON.' });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'The request is too large.' });
  if (err?.type === 'entity.verify.failed' || err?.type === 'request.size.invalid') return res.status(400).json({ error: 'The request body could not be read.' });
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'PDF must be 20 MB or smaller.' : 'Upload failed. Check the file and try again.' });
  console.error(err); res.status(err?.status || 500).json({ error: 'Something went wrong on the server.' });
});

ensureAdmin().then(() => app.listen(PORT, () => console.log(`StudyHub running at http://localhost:${PORT}`))).catch(err => { console.error(err); process.exit(1); });
