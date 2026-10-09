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

if (!process.env.SESSION_SECRET && process.env.NODE_ENV === 'production') {
  console.error('SESSION_SECRET is required in production. Copy .env.example to .env and set it.');
  process.exit(1);
}
const SESSION_SECRET = process.env.SESSION_SECRET || 'development-only-secret-change-me';

function readDb() {
  if (!fs.existsSync(DB_FILE)) return { users: [], materials: [], bookmarks: {} };
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch (e) { console.error('Database JSON could not be read:', e.message); throw e; }
}
let db = readDb();
function saveDb() {
  const tmp = DB_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2));
  fs.renameSync(tmp, DB_FILE);
}
function publicUser(user) { return { id: user.id, name: user.name, email: user.email, role: user.role, createdAt: user.createdAt }; }
function safeText(v, max = 180) { return String(v ?? '').trim().slice(0, max); }
function findUserByEmail(email) { return db.users.find(u => u.email.toLowerCase() === String(email).toLowerCase()); }

async function ensureAdmin() {
  const email = String(process.env.ADMIN_EMAIL || 'admin@example.com').toLowerCase();
  const existing = findUserByEmail(email);
  if (existing) {
    if (existing.role !== 'admin') {
      throw new Error('ADMIN_EMAIL belongs to an existing non-admin account. Choose an unused ADMIN_EMAIL or recover the intended account after verifying its owner; no account was promoted.');
    }
    if (!Array.isArray(db.bookmarks[existing.id])) { db.bookmarks[existing.id] = []; saveDb(); }
    return;
  }
  const password = process.env.ADMIN_PASSWORD;
  if (!password) throw new Error('ADMIN_PASSWORD is not set. Copy .env.example to .env and set ADMIN_PASSWORD (min 12 characters).');
  if (password.length < 12) throw new Error('ADMIN_PASSWORD must be at least 12 characters.');
  const admin = { id: crypto.randomUUID(), name: safeText(process.env.ADMIN_NAME || 'System Admin', 80), email, passwordHash: await bcrypt.hash(password, 12), role: 'admin', createdAt: new Date().toISOString() };
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
app.use(session({ store: new FileStore({ path: path.join(DATA_DIR, 'sessions'), ttl: 8 * 60 * 60, retries: 0 }), name: 'smm.sid', secret: SESSION_SECRET, resave: false, saveUninitialized: false, cookie: { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', maxAge: 1000 * 60 * 60 * 8 } }));
app.use(['/api/auth/login', '/api/auth/register'], rateLimit({ windowMs: 15 * 60 * 1000, limit: 40, standardHeaders: true, legacyHeaders: false }));
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

const storage = multer.diskStorage({
  destination: (_req, _file, cb) => cb(null, UPLOAD_DIR),
  filename: (_req, file, cb) => cb(null, `${crypto.randomUUID()}.pdf`)
});
const upload = multer({ storage, limits: { fileSize: 20 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext !== '.pdf' || file.mimetype !== 'application/pdf') return cb(new Error('Only PDF files are allowed.'));
  cb(null, true);
} });

app.get('/api/health', (_req, res) => res.json({ ok: true, app: 'StudyHub' }));
app.get('/api/auth/me', (req, res) => {
  const user = db.users.find(u => u.id === req.session.userId);
  res.json({ user: user ? publicUser(user) : null });
});
app.post('/api/auth/register', asyncRoute(async (req, res) => {
  const name = safeText(req.body.name, 80);
  const email = safeText(req.body.email, 254).toLowerCase();
  const password = String(req.body.password || '');
  if (name.length < 2) return res.status(400).json({ error: 'Enter your full name.' });
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Enter a valid email address.' });
  if (password.length < 8 || password.length > 128) return res.status(400).json({ error: 'Password must be 8–128 characters.' });
  if (findUserByEmail(email)) return res.status(409).json({ error: 'An account with this email already exists.' });
  const user = { id: crypto.randomUUID(), name, email, passwordHash: await bcrypt.hash(password, 12), role: 'student', createdAt: new Date().toISOString() };
  db.users.push(user); db.bookmarks[user.id] = []; saveDb(); req.session.userId = user.id;
  res.status(201).json({ user: publicUser(user) });
}));
app.post('/api/auth/login', asyncRoute(async (req, res) => {
  const email = safeText(req.body.email, 254).toLowerCase();
  const password = String(req.body.password || '');
  const user = findUserByEmail(email);
  if (!user || !(await bcrypt.compare(password, user.passwordHash))) return res.status(401).json({ error: 'Email or password is incorrect.' });
  req.session.userId = user.id; res.json({ user: publicUser(user) });
}));
app.post('/api/auth/logout', (req, res) => req.session.destroy(() => { res.clearCookie('smm.sid', { httpOnly: true, sameSite: 'lax' }); res.json({ ok: true }); }));

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
  res.json({ materials: items.map(m => ({ ...m, bookmarked: saved.includes(m.id) })), subjects: [...new Set(db.materials.map(m => m.subject))].sort() });
});
app.post('/api/materials', auth, adminOnly, upload.single('pdf'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Choose a PDF file to upload.' });
  const header = Buffer.alloc(5);
  let fd;
  let validPdf = false;
  try {
    fd = fs.openSync(req.file.path, 'r');
    validPdf = fs.readSync(fd, header, 0, header.length, 0) === header.length && header.equals(Buffer.from('%PDF-'));
  } finally { if (fd !== undefined) fs.closeSync(fd); }
  if (!validPdf) {
    fs.unlinkSync(req.file.path);
    return res.status(400).json({ error: 'The uploaded file is not a PDF (%PDF- header missing).' });
  }
  const title = safeText(req.body.title, 140), subject = safeText(req.body.subject, 100), description = safeText(req.body.description, 800);
  if (title.length < 2 || subject.length < 2) { fs.unlinkSync(req.file.path); return res.status(400).json({ error: 'Title and subject are required.' }); }
  const material = { id: crypto.randomUUID(), title, subject, description, originalName: path.basename(req.file.originalname).slice(0, 180), storedName: req.file.filename, size: req.file.size, uploadedBy: req.user.id, uploadedByName: req.user.name, createdAt: new Date().toISOString() };
  db.materials.push(material); saveDb(); res.status(201).json({ material: { ...material, bookmarked: false } });
});
app.get('/api/materials/:id/pdf', auth, (req, res) => {
  const material = db.materials.find(m => m.id === req.params.id);
  if (!material) return res.status(404).json({ error: 'Material not found.' });
  const file = path.join(UPLOAD_DIR, path.basename(material.storedName));
  if (!fs.existsSync(file)) return res.status(404).json({ error: 'PDF file is missing from the server.' });
  res.setHeader('Content-Type', 'application/pdf');
  const filename = Buffer.from(material.originalName, 'utf8').toString('utf8');
  const fallback = filename.replace(/[^\x20-\x7e]|["\\]/g, '_') || 'document.pdf';
  const encoded = encodeURIComponent(filename).replace(/['()*]/g, c => '%' + c.charCodeAt(0).toString(16).toUpperCase());
  res.setHeader('Content-Disposition', `inline; filename="${fallback}"; filename*=UTF-8''${encoded}`);
  res.setHeader('X-Content-Type-Options', 'nosniff'); res.sendFile(file);
});
app.delete('/api/materials/:id', auth, adminOnly, (req, res) => {
  const i = db.materials.findIndex(m => m.id === req.params.id);
  if (i < 0) return res.status(404).json({ error: 'Material not found.' });
  const [material] = db.materials.splice(i, 1);
  const file = path.join(UPLOAD_DIR, path.basename(material.storedName));
  if (fs.existsSync(file)) fs.unlinkSync(file);
  for (const userId of Object.keys(db.bookmarks)) db.bookmarks[userId] = db.bookmarks[userId].filter(id => id !== material.id);
  saveDb(); res.json({ ok: true });
});
app.post('/api/materials/:id/bookmark', auth, (req, res) => {
  if (!db.materials.some(m => m.id === req.params.id)) return res.status(404).json({ error: 'Material not found.' });
  const list = db.bookmarks[req.user.id] || [];
  const i = list.indexOf(req.params.id);
  if (i >= 0) list.splice(i, 1); else list.push(req.params.id);
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

app.use((err, _req, res, _next) => {
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'PDF must be 20 MB or smaller.' : 'Upload failed. Check the file and try again.' });
  if (err.message === 'Only PDF files are allowed.') return res.status(400).json({ error: err.message });
  console.error(err); res.status(500).json({ error: 'Something went wrong on the server.' });
});

ensureAdmin().then(() => app.listen(PORT, () => console.log(`StudyHub running at http://localhost:${PORT}`))).catch(err => { console.error(err); process.exit(1); });
