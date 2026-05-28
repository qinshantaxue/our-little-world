/* ============================================================
   我们的小世界 — HTTP 服务端
   支持双模式：本地 SQLite / 云端 PostgreSQL
   ============================================================ */
const express = require('express');
const multer  = require('multer');
const path    = require('path');
const fs      = require('fs');
const os      = require('os');

// ── 判断运行模式 ──────────────────────────────────────────────
const DATABASE_URL = process.env.DATABASE_URL;
const IS_CLOUD     = !!DATABASE_URL;
const PORT = process.env.PORT || 3000;

console.log(`🌐 模式: ${IS_CLOUD ? '☁️ 云端 (PostgreSQL)' : '💻 本地 (SQLite)'}`);

const app = express();

// ── 确保本地目录存在 ──────────────────────────────────────────
const dataDir    = path.join(__dirname, 'data');
const uploadsDir = path.join(__dirname, 'uploads');
[dataDir, uploadsDir].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

// ── ============================================================
//    数据库层
//    ============================================================

let db;
let isPostgres = false;

// ── 统一查询接口 ──────────────────────────────────────────
async function queryAll(sql, params = []) {
  if (isPostgres) {
    const { rows } = await db.query(sql, params);
    return rows;
  } else {
    const stmt = db.prepare(sql);
    if (params.length) stmt.bind(params);
    const rows = [];
    while (stmt.step()) rows.push(stmt.getAsObject());
    stmt.free();
    return rows;
  }
}

async function queryOne(sql, params = []) {
  const rows = await queryAll(sql, params);
  return rows.length ? rows[0] : null;
}

async function runSql(sql, params = []) {
  if (isPostgres) {
    const result = await db.query(sql, params);
    return result.rows[0]?.id ?? null;
  } else {
    db.run(sql, params);
    const idResult = await queryOne('SELECT last_insert_rowid() AS id');
    saveSQLite();
    return idResult ? idResult.id : null;
  }
}

// ── 数据库初始化 ──────────────────────────────────────────
async function initDb() {
  if (IS_CLOUD) {
    await initPostgres();
  } else {
    await initSQLite();
  }
  console.log('📦 数据库就绪');
}

// ── SQLite ─────────────────────────────────────────────────
async function initSQLite() {
  const initSqlJs = require('sql.js');
  const SQL = await initSqlJs();
  const dbPath = path.join(dataDir, 'database.sqlite');
  let buffer;
  try { buffer = fs.readFileSync(dbPath); } catch (_) {}
  db = new SQL.Database(buffer);
  db.run('PRAGMA foreign_keys = ON');
  db.run(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY AUTOINCREMENT, content TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS diary (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT DEFAULT '', content TEXT NOT NULL, entry_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS timeline (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '', event_date TEXT NOT NULL, created_at TEXT DEFAULT (datetime('now','localtime')));
    CREATE TABLE IF NOT EXISTS photos (id INTEGER PRIMARY KEY AUTOINCREMENT, filename TEXT NOT NULL, original_name TEXT NOT NULL, description TEXT DEFAULT '', created_at TEXT DEFAULT (datetime('now','localtime')));
  `);
  saveSQLite();
}

function saveSQLite() {
  fs.writeFileSync(path.join(dataDir, 'database.sqlite'), Buffer.from(db.export()));
}

// ── PostgreSQL（Render 云） ────────────────────────────────
async function initPostgres() {
  const { Pool } = require('pg');
  db = new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });
  isPostgres = true;
  await db.query('SELECT 1'); // 测试连接
  await db.query(`
    CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS notes (id SERIAL PRIMARY KEY, content TEXT NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS diary (id SERIAL PRIMARY KEY, title TEXT DEFAULT '', content TEXT NOT NULL, entry_date DATE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS timeline (id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', event_date DATE NOT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS photos (id SERIAL PRIMARY KEY, filename TEXT NOT NULL, original_name TEXT NOT NULL, description TEXT DEFAULT '', data_base64 TEXT NOT NULL DEFAULT '', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  `);
}

// ── ============================================================
//    Express 中间件
//    ============================================================

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ── Multer（仅本地模式使用）──────────────────────────────────
const storage = multer.diskStorage({
  destination: uploadsDir,
  filename(req, file, cb) {
    cb(null, Date.now() + '-' + Math.round(Math.random() * 1E9) + path.extname(file.originalname).toLowerCase());
  }
});
const upload = multer({
  storage, limits: { fileSize: 15 * 1024 * 1024 },
  fileFilter(req, file, cb) {
    cb(null, ['image/jpeg','image/png','image/gif','image/webp','image/heic','image/heif'].includes(file.mimetype));
  }
});

if (!IS_CLOUD) app.use('/uploads', express.static(uploadsDir));

// ── ============================================================
//    RESTful API
//    ============================================================

// ── Settings ──
app.get('/api/settings', async (req, res) => {
  const rows = await queryAll('SELECT key, value FROM settings');
  const obj = {};
  rows.forEach(r => obj[r.key] = r.value);
  res.json(obj);
});

app.put('/api/settings', async (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'key 不能为空' });
  await runSql('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=$2', [key, value ?? '']);
  res.json({ success: true });
});

// ── Notes ──
app.get('/api/notes', async (req, res) => {
  res.json(await queryAll('SELECT * FROM notes ORDER BY created_at DESC'));
});

app.post('/api/notes', async (req, res) => {
  const { content } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: '内容不能为空' });
  const id = await runSql('INSERT INTO notes (content) VALUES ($1) RETURNING id', [content.trim()]);
  res.json(await queryOne('SELECT * FROM notes WHERE id = $1', [id]));
});

app.delete('/api/notes/:id', async (req, res) => {
  await runSql('DELETE FROM notes WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ── Diary ──
app.get('/api/diary', async (req, res) => {
  res.json(await queryAll('SELECT * FROM diary ORDER BY entry_date DESC, id DESC'));
});

app.post('/api/diary', async (req, res) => {
  const { title, content, entry_date } = req.body;
  if (!content?.trim()) return res.status(400).json({ error: '内容不能为空' });
  const date = entry_date || new Date().toISOString().slice(0, 10);
  const id = await runSql('INSERT INTO diary (title, content, entry_date) VALUES ($1,$2,$3) RETURNING id', [title?.trim()||'', content.trim(), date]);
  res.json(await queryOne('SELECT * FROM diary WHERE id = $1', [id]));
});

app.delete('/api/diary/:id', async (req, res) => {
  await runSql('DELETE FROM diary WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ── Timeline ──
app.get('/api/timeline', async (req, res) => {
  res.json(await queryAll('SELECT * FROM timeline ORDER BY event_date DESC, id DESC'));
});

app.post('/api/timeline', async (req, res) => {
  const { title, description, event_date } = req.body;
  if (!title?.trim() || !event_date) return res.status(400).json({ error: '标题和日期不能为空' });
  const id = await runSql('INSERT INTO timeline (title, description, event_date) VALUES ($1,$2,$3) RETURNING id', [title.trim(), description?.trim()||'', event_date]);
  res.json(await queryOne('SELECT * FROM timeline WHERE id = $1', [id]));
});

app.delete('/api/timeline/:id', async (req, res) => {
  await runSql('DELETE FROM timeline WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ── Photos ──
app.get('/api/photos', async (req, res) => {
  if (IS_CLOUD) {
    const photos = await queryAll('SELECT id, original_name, description, created_at FROM photos ORDER BY created_at DESC');
    return res.json(photos);
  }
  res.json(await queryAll('SELECT * FROM photos ORDER BY created_at DESC'));
});

app.get('/api/photos/:id/data', async (req, res) => {
  if (!IS_CLOUD) return res.status(400).json({ error: '仅云端模式使用' });
  const photo = await queryOne('SELECT data_base64 FROM photos WHERE id = $1', [req.params.id]);
  if (!photo) return res.status(404).json({ error: '照片不存在' });
  res.json({ data: photo.data_base64 });
});

app.post('/api/photos/upload', async (req, res) => {
  if (IS_CLOUD) {
    const { name, data_base64, description } = req.body;
    if (!name || !data_base64) return res.status(400).json({ error: '请选择照片' });
    const id = await runSql(
      'INSERT INTO photos (filename, original_name, description, data_base64) VALUES ($1,$2,$3,$4) RETURNING id',
      [Date.now()+'.jpg', name, description?.trim()||'', data_base64]
    );
    return res.json(await queryOne('SELECT id, original_name, description, created_at FROM photos WHERE id = $1', [id]));
  }
  // 本地模式
  upload.single('photo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '请选择照片' });
    const id = await runSql('INSERT INTO photos (filename, original_name, description) VALUES ($1,$2,$3) RETURNING id', [
      req.file.filename, req.file.originalname, req.body.description?.trim()||''
    ]);
    res.json(await queryOne('SELECT * FROM photos WHERE id = $1', [id]));
  });
});

app.delete('/api/photos/:id', async (req, res) => {
  if (!IS_CLOUD) {
    const photo = await queryOne('SELECT * FROM photos WHERE id = $1', [req.params.id]);
    if (photo) {
      const fp = path.join(uploadsDir, photo.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  }
  await runSql('DELETE FROM photos WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ── ============================================================
//    启动
//    ============================================================

async function start() {
  await initDb();

  function getLocalIP() {
    const ifaces = os.networkInterfaces();
    for (const name of Object.keys(ifaces)) {
      for (const iface of ifaces[name]) {
        if (iface.family === 'IPv4' && !iface.internal) return iface.address;
      }
    }
    return '127.0.0.1';
  }

  app.listen(PORT, () => {
    if (IS_CLOUD) {
      console.log('');
      console.log('  ╔══════════════════════════════════════╗');
      console.log('  ║   ☁️  我们的小世界  云端版已启动！  ║');
      console.log('  ╠══════════════════════════════════════╣');
      console.log(`  ║  端口: ${PORT}                      ║`);
      console.log('  ╚══════════════════════════════════════╝');
      console.log('');
    } else {
      const ip = getLocalIP();
      console.log('');
      console.log('  ╔══════════════════════════════════════╗');
      console.log('  ║   ❤  我们的小世界  已启动！          ║');
      console.log('  ╠══════════════════════════════════════╣');
      console.log(`  ║  本地:   http://localhost:${PORT}      ║`);
      console.log(`  ║  局域网: http://${ip}:${PORT}  ║`);
      console.log('  ╚══════════════════════════════════════╝');
      console.log('');
    }
  });
}

start().catch(err => {
  console.error('❌ 启动失败:', err);
  process.exit(1);
});
