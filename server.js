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
    CREATE TABLE IF NOT EXISTS bucket_list (id INTEGER PRIMARY KEY AUTOINCREMENT, title TEXT NOT NULL, description TEXT DEFAULT '', is_completed INTEGER DEFAULT 0, completed_at TEXT, created_at TEXT DEFAULT (datetime('now','localtime')));
  `);
  db.run(`CREATE TABLE IF NOT EXISTS albums (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, description TEXT DEFAULT '', parent_id INTEGER DEFAULT NULL, created_at TEXT DEFAULT (datetime('now','localtime')))`);
  try { db.run('ALTER TABLE photos ADD COLUMN album_id INTEGER DEFAULT NULL'); } catch (_) {}
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
    CREATE TABLE IF NOT EXISTS bucket_list (id SERIAL PRIMARY KEY, title TEXT NOT NULL, description TEXT DEFAULT '', is_completed BOOLEAN DEFAULT FALSE, completed_at TIMESTAMP, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
    CREATE TABLE IF NOT EXISTS albums (id SERIAL PRIMARY KEY, name TEXT NOT NULL, description TEXT DEFAULT '', parent_id INTEGER DEFAULT NULL, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP);
  `);
  try { await db.query('ALTER TABLE photos ADD COLUMN IF NOT EXISTS album_id INTEGER DEFAULT NULL'); } catch (_) {}
}

// ── ============================================================
//    Express 中间件
//    ============================================================

app.use(express.json({ limit: '50mb' }));
app.use(express.static(__dirname));

// ── 告知前端当前模式 ──
app.get('/api/mode', (req, res) => {
  res.json({ mode: IS_CLOUD ? 'cloud' : 'local' });
});

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
  await runSql('INSERT INTO settings (key, value) VALUES ($1,$2) ON CONFLICT (key) DO UPDATE SET value=excluded.value', [key, value ?? '']);
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

// ── Bucket List ──
app.get('/api/bucketlist', async (req, res) => {
  const items = await queryAll('SELECT * FROM bucket_list ORDER BY is_completed ASC, created_at DESC');
  // SQLite 用 0/1，PostgreSQL 用 true/false，统一成 boolean
  items.forEach(i => i.is_completed = !!i.is_completed);
  res.json(items);
});

app.post('/api/bucketlist', async (req, res) => {
  const { title, description } = req.body;
  if (!title?.trim()) return res.status(400).json({ error: '标题不能为空' });
  const id = await runSql('INSERT INTO bucket_list (title, description) VALUES ($1,$2) RETURNING id', [title.trim(), description?.trim()||'']);
  res.json(await queryOne('SELECT * FROM bucket_list WHERE id = $1', [id]));
});

app.put('/api/bucketlist/:id', async (req, res) => {
  const item = await queryOne('SELECT * FROM bucket_list WHERE id = $1', [req.params.id]);
  if (!item) return res.status(404).json({ error: '不存在' });
  const newStatus = !item.is_completed;
  const now = isPostgres
    ? 'NOW()'
    : "datetime('now','localtime')";
  if (newStatus) {
    await runSql(`UPDATE bucket_list SET is_completed=$1, completed_at=${now} WHERE id=$2`, [isPostgres ? true : 1, req.params.id]);
  } else {
    await runSql('UPDATE bucket_list SET is_completed=$1, completed_at=NULL WHERE id=$2', [isPostgres ? false : 0, req.params.id]);
  }
  const updated = await queryOne('SELECT * FROM bucket_list WHERE id = $1', [req.params.id]);
  if (updated) updated.is_completed = !!updated.is_completed;
  res.json(updated);
});

app.delete('/api/bucketlist/:id', async (req, res) => {
  await runSql('DELETE FROM bucket_list WHERE id = $1', [req.params.id]);
  res.json({ success: true });
});

// ── Photos ──
app.get('/api/photos', async (req, res) => {
  const { album_id } = req.query;
  let sql, params;
  if (album_id != null) {
    sql = 'SELECT * FROM photos WHERE album_id = $1 ORDER BY created_at DESC';
    params = [album_id];
  } else {
    sql = 'SELECT * FROM photos ORDER BY created_at DESC';
    params = [];
  }
  if (IS_CLOUD) {
    const photos = await queryAll(sql.replace('SELECT *', 'SELECT id, original_name, description, album_id, created_at'), params);
    return res.json(photos);
  }
  res.json(await queryAll(sql, params));
});

app.get('/api/photos/random', async (req, res) => {
  const count = Math.min(parseInt(req.query.count) || 5, 10);
  const cols = IS_CLOUD ? 'id, original_name, description' : 'id, filename, original_name, description';
  const photos = await queryAll(`SELECT ${cols} FROM photos ORDER BY RANDOM() LIMIT ${count}`, []);
  res.json(photos);
});

app.get('/api/photos/:id/data', async (req, res) => {
  if (!IS_CLOUD) return res.status(400).json({ error: '仅云端模式使用' });
  const photo = await queryOne('SELECT data_base64 FROM photos WHERE id = $1', [req.params.id]);
  if (!photo) return res.status(404).json({ error: '照片不存在' });
  res.json({ data: photo.data_base64 });
});

app.post('/api/photos/upload', async (req, res) => {
  if (IS_CLOUD) {
    const { name, data_base64, description, album_id } = req.body;
    if (!name || !data_base64) return res.status(400).json({ error: '请选择照片' });
    const id = await runSql(
      'INSERT INTO photos (filename, original_name, description, data_base64, album_id) VALUES ($1,$2,$3,$4,$5) RETURNING id',
      [Date.now() + '.jpg', name, description?.trim() || '', data_base64, album_id || null]
    );
    return res.json(await queryOne('SELECT id, original_name, description, album_id, created_at FROM photos WHERE id = $1', [id]));
  }
  upload.single('photo')(req, res, async (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.file) return res.status(400).json({ error: '请选择照片' });
    const id = await runSql(
      'INSERT INTO photos (filename, original_name, description, album_id) VALUES ($1,$2,$3,$4) RETURNING id',
      [req.file.filename, req.file.originalname, req.body.description?.trim() || '', req.body.album_id || null]
    );
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

// ── Albums ──
async function deleteAlbumCascade(albumId) {
  if (!IS_CLOUD) {
    const photos = await queryAll('SELECT * FROM photos WHERE album_id = $1', [albumId]);
    for (const p of photos) {
      const fp = path.join(uploadsDir, p.filename);
      if (fs.existsSync(fp)) fs.unlinkSync(fp);
    }
  }
  await runSql('DELETE FROM photos WHERE album_id = $1', [albumId]);
  const subs = await queryAll('SELECT id FROM albums WHERE parent_id = $1', [albumId]);
  for (const sub of subs) await deleteAlbumCascade(sub.id);
  await runSql('DELETE FROM albums WHERE id = $1', [albumId]);
}

app.get('/api/albums', async (req, res) => {
  const { parent_id } = req.query;
  let albums;
  if (parent_id === undefined || parent_id === 'null' || parent_id === '') {
    albums = await queryAll('SELECT * FROM albums WHERE parent_id IS NULL ORDER BY created_at ASC', []);
  } else {
    albums = await queryAll('SELECT * FROM albums WHERE parent_id = $1 ORDER BY created_at ASC', [parent_id]);
  }
  for (const a of albums) {
    const pc = await queryOne('SELECT COUNT(*) AS cnt FROM photos WHERE album_id = $1', [a.id]);
    a.photo_count = parseInt(pc?.cnt || 0);
    const sc = await queryOne('SELECT COUNT(*) AS cnt FROM albums WHERE parent_id = $1', [a.id]);
    a.sub_count = parseInt(sc?.cnt || 0);
    if (!IS_CLOUD) {
      const cover = await queryOne('SELECT filename FROM photos WHERE album_id = $1 LIMIT 1', [a.id]);
      a.cover_filename = cover?.filename || null;
    } else {
      const cover = await queryOne('SELECT id FROM photos WHERE album_id = $1 LIMIT 1', [a.id]);
      a.cover_photo_id = cover?.id || null;
    }
  }
  res.json(albums);
});

app.post('/api/albums', async (req, res) => {
  const { name, description, parent_id } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '请输入相册名称' });
  const id = await runSql(
    'INSERT INTO albums (name, description, parent_id) VALUES ($1,$2,$3) RETURNING id',
    [name.trim(), description?.trim() || '', parent_id || null]
  );
  res.json(await queryOne('SELECT * FROM albums WHERE id = $1', [id]));
});

app.put('/api/albums/:id', async (req, res) => {
  const { name, description } = req.body;
  if (!name?.trim()) return res.status(400).json({ error: '请输入相册名称' });
  await runSql('UPDATE albums SET name=$1, description=$2 WHERE id=$3',
    [name.trim(), description?.trim() || '', req.params.id]);
  res.json(await queryOne('SELECT * FROM albums WHERE id = $1', [req.params.id]));
});

app.delete('/api/albums/:id', async (req, res) => {
  await deleteAlbumCascade(req.params.id);
  res.json({ success: true });
});

// ── Miss You ──
app.post('/api/miss-you', async (req, res) => {
  try {
    const rows = await queryAll('SELECT key, value FROM settings');
    const cfg = {};
    rows.forEach(r => cfg[r.key] = r.value);

    const toEmail = cfg.miss_you_email;
    if (!toEmail) {
      return res.status(400).json({ code: 'NO_EMAIL', error: '请先设置对方的邮箱地址' });
    }

    const resendKey = process.env.RESEND_API_KEY || cfg.resend_api_key;
    if (!resendKey) {
      return res.status(400).json({ code: 'NO_SENDER', error: '请先在配置中填入 Resend API Key' });
    }

    const timeStr = new Date().toLocaleString('zh-CN', {
      timeZone: 'Asia/Shanghai', year: 'numeric', month: 'long',
      day: 'numeric', hour: '2-digit', minute: '2-digit',
    });

    const emailHtml = `
      <div style="max-width:480px;margin:32px auto;font-family:'PingFang SC','Microsoft YaHei',sans-serif;border-radius:20px;overflow:hidden;box-shadow:0 8px 32px rgba(0,0,0,0.10);">
        <div style="background:linear-gradient(135deg,#D4878F 0%,#9B5C63 100%);padding:44px 36px;text-align:center;">
          <div style="font-size:60px;line-height:1;margin-bottom:14px;">♡</div>
          <h1 style="color:#fff;font-size:28px;margin:0;font-weight:600;letter-spacing:0.02em;">我想你了宝宝</h1>
        </div>
        <div style="background:#FDF8F6;padding:36px;text-align:center;">
          <p style="font-size:16px;line-height:2;color:#8A7070;margin:0 0 24px;">
            在 <strong style="color:#9B5C63;">${timeStr}</strong>，<br>
            有人点了"我想你了宝宝"按钮，<br>
            那个人非常非常想念你 ♡
          </p>
          <div style="background:#FBF0F1;border:1px solid #EDD5D8;border-radius:12px;padding:18px 24px;">
            <p style="margin:0;color:#9B5C63;font-size:15px;">💌 去看看你们的小世界吧~</p>
          </div>
        </div>
        <div style="background:#FDF8F6;padding:16px 36px 28px;text-align:center;border-top:1px solid #EDE0E2;">
          <p style="margin:0;font-size:12px;color:#C5A5A7;">— 我们的小世界 · 只属于你们两个人 —</p>
        </div>
      </div>
    `;

    const resp = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${resendKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'onboarding@resend.dev', to: [toEmail], subject: '💕 我想你了宝宝', html: emailHtml }),
    });
    if (!resp.ok) {
      const errBody = await resp.json().catch(() => ({}));
      throw new Error(errBody.message || `Resend HTTP ${resp.status}`);
    }

    res.json({ success: true });
  } catch (err) {
    console.error('miss-you 发送失败:', err.message);
    res.status(500).json({ error: '发送失败：' + err.message });
  }
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
