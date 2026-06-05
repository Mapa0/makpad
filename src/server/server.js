const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const Database = require('better-sqlite3');
const { Client: MinioClient } = require('minio');

const PORT = Number(process.env.PORT || 3000);
const ROOT_DIR = path.resolve(__dirname, '..', '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const APP_PUBLIC_DIR = path.join(PUBLIC_DIR, 'app');
const ADMIN_PUBLIC_DIR = path.join(PUBLIC_DIR, 'admin');
const SCRIPTS_DIR = path.join(ROOT_DIR, 'scripts');
const DATA_DIR = process.env.DATA_DIR || path.join(ROOT_DIR, 'data');
const DB_PATH = process.env.DB_PATH || path.join(DATA_DIR, 'makpad.db');
const S3_BUCKET = process.env.S3_BUCKET;
const MAX_UPLOAD_BUFFER_SIZE = Number(process.env.MAX_UPLOAD_BUFFER_SIZE || 512 * 1024 * 1024);
const DEFAULT_CONFIG = {
  fileTtlMs: Number(process.env.FILE_TTL_MS || 60 * 60 * 1000),
  maxFileSize: Number(process.env.MAX_FILE_SIZE || 100 * 1024 * 1024),
  maxFilesPerSlug: Number(process.env.MAX_FILES_PER_SLUG || 20),
  uploadCooldownMs: Number(process.env.UPLOAD_COOLDOWN_MS || 10 * 1000),
};
const uploadThrottle = new Map();

fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
  CREATE TABLE IF NOT EXISTS notes (
    slug TEXT PRIMARY KEY,
    content TEXT NOT NULL DEFAULT '',
    char_count INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    slug TEXT NOT NULL,
    original_name TEXT NOT NULL,
    object_key TEXT NOT NULL,
    content_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_attachments_slug ON attachments(slug);
  CREATE INDEX IF NOT EXISTS idx_attachments_created_at ON attachments(created_at);

  CREATE TABLE IF NOT EXISTS config (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
`);

const statements = {
  getConfig: db.prepare('SELECT key, value FROM config'),
  setConfig: db.prepare('INSERT INTO config (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'),
  getNote: db.prepare('SELECT slug, content, char_count AS charCount, created_at AS createdAt, updated_at AS updatedAt FROM notes WHERE slug = ?'),
  upsertNote: db.prepare(`
    INSERT INTO notes (slug, content, char_count, created_at, updated_at)
    VALUES (@slug, @content, @charCount, @now, @now)
    ON CONFLICT(slug) DO UPDATE SET
      content = excluded.content,
      char_count = excluded.char_count,
      updated_at = excluded.updated_at
  `),
  deleteNote: db.prepare('DELETE FROM notes WHERE slug = ?'),
  listNotes: db.prepare('SELECT slug, char_count AS charCount, updated_at AS updatedAt FROM notes ORDER BY updated_at DESC'),
  listSlugs: db.prepare(`
    SELECT slug FROM notes
    UNION
    SELECT slug FROM attachments
    ORDER BY slug
  `),
  listAttachments: db.prepare(`
    SELECT id, slug, original_name AS originalName, object_key AS objectKey, content_type AS contentType, size, created_at AS createdAt
    FROM attachments
    WHERE slug = ?
    ORDER BY created_at DESC
  `),
  getAttachment: db.prepare(`
    SELECT id, slug, original_name AS originalName, object_key AS objectKey, content_type AS contentType, size, created_at AS createdAt
    FROM attachments
    WHERE slug = ? AND id = ?
  `),
  insertAttachment: db.prepare(`
    INSERT INTO attachments (id, slug, original_name, object_key, content_type, size, created_at)
    VALUES (@id, @slug, @originalName, @objectKey, @contentType, @size, @createdAt)
  `),
  deleteAttachment: db.prepare('DELETE FROM attachments WHERE id = ?'),
  deleteAttachmentsBySlug: db.prepare('DELETE FROM attachments WHERE slug = ?'),
  expiredAttachments: db.prepare(`
    SELECT id, slug, original_name AS originalName, object_key AS objectKey, content_type AS contentType, size, created_at AS createdAt
    FROM attachments
    WHERE created_at <= ?
  `),
  attachmentSummary: db.prepare(`
    SELECT slug, COUNT(*) AS attachmentCount, COALESCE(SUM(size), 0) AS attachmentBytes, MAX(created_at) AS newestAttachmentAt
    FROM attachments
    GROUP BY slug
  `),
};

function seedConfig() {
  const existing = Object.fromEntries(statements.getConfig.all().map((row) => [row.key, row.value]));
  for (const [key, value] of Object.entries(DEFAULT_CONFIG)) {
    if (existing[key] === undefined) statements.setConfig.run(key, String(value));
  }
}

seedConfig();

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '2mb' }));

const s3Endpoint = process.env.S3_ENDPOINT ? new URL(process.env.S3_ENDPOINT) : null;
const hasS3Config = Boolean(
  S3_BUCKET
  && s3Endpoint
  && process.env.S3_ACCESS_KEY_ID
  && process.env.S3_SECRET_ACCESS_KEY
);
const s3 = hasS3Config ? new MinioClient({
  endPoint: s3Endpoint.hostname,
  port: Number(s3Endpoint.port || (s3Endpoint.protocol === 'https:' ? 443 : 80)),
  useSSL: s3Endpoint.protocol === 'https:',
  region: process.env.S3_REGION || 'garage',
  accessKey: process.env.S3_ACCESS_KEY_ID,
  secretKey: process.env.S3_SECRET_ACCESS_KEY,
  pathStyle: true,
}) : null;
const attachmentsEnabled = Boolean(s3);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BUFFER_SIZE, files: 1 },
});

function normalizeSlug(rawSlug) {
  const decoded = decodeURIComponent(String(rawSlug || '')).trim();
  const clean = decoded.replace(/^\/+|\/+$/g, '');

  if (!clean || clean === 'index.html' || clean === '200.html' || clean === 'admin') {
    return null;
  }

  return clean
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80))
    .filter(Boolean)
    .join('/');
}

function slugKey(slug) {
  return crypto.createHash('sha256').update(slug).digest('hex');
}

function objectKey(slug, id, fileName) {
  const safeName = path.basename(fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return `attachments/${slugKey(slug)}/${id}/${safeName || 'file'}`;
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

function getConfig() {
  const saved = Object.fromEntries(statements.getConfig.all().map((row) => [row.key, Number(row.value)]));
  return {
    fileTtlMs: clampNumber(saved.fileTtlMs, 60 * 1000, 7 * 24 * 60 * 60 * 1000, DEFAULT_CONFIG.fileTtlMs),
    maxFileSize: clampNumber(saved.maxFileSize, 1024, MAX_UPLOAD_BUFFER_SIZE, DEFAULT_CONFIG.maxFileSize),
    maxFilesPerSlug: clampNumber(saved.maxFilesPerSlug, 1, 200, DEFAULT_CONFIG.maxFilesPerSlug),
    uploadCooldownMs: clampNumber(saved.uploadCooldownMs, 0, 60 * 60 * 1000, DEFAULT_CONFIG.uploadCooldownMs),
  };
}

function writeRuntimeConfig(config) {
  const current = getConfig();
  const nextConfig = {
    fileTtlMs: clampNumber(config.fileTtlMs, 60 * 1000, 7 * 24 * 60 * 60 * 1000, current.fileTtlMs),
    maxFileSize: clampNumber(config.maxFileSize, 1024, MAX_UPLOAD_BUFFER_SIZE, current.maxFileSize),
    maxFilesPerSlug: clampNumber(config.maxFilesPerSlug, 1, 200, current.maxFilesPerSlug),
    uploadCooldownMs: clampNumber(config.uploadCooldownMs, 0, 60 * 60 * 1000, current.uploadCooldownMs),
  };

  const save = db.transaction((values) => {
    for (const [key, value] of Object.entries(values)) statements.setConfig.run(key, String(value));
  });
  save(nextConfig);
  return nextConfig;
}

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function requireAdmin(req, res, next) {
  const password = process.env.MAKPAD_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN;
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');

  if (!password) return res.status(403).json({ error: 'Senha admin não configurada.' });
  if (token !== password) return res.status(401).json({ error: 'Acesso admin negado.' });

  next();
}

function fileResponse(file) {
  return {
    id: file.id,
    name: file.originalName,
    size: file.size,
    createdAt: file.createdAt,
    expiresAt: file.createdAt + getConfig().fileTtlMs,
  };
}

function attachmentsUnavailable(res) {
  return res.status(503).json({ error: 'Attachments are disabled for this MAKPAD installation.' });
}

function saveNoteContent(slug, content) {
  const now = Date.now();
  statements.upsertNote.run({ slug, content, charCount: content.length, now });
}

async function removeS3Object(objectKeyValue) {
  if (!s3 || !objectKeyValue) return;
  await s3.removeObject(S3_BUCKET, objectKeyValue).catch((error) => {
    console.error(`Failed to remove S3 object ${objectKeyValue}`, error);
  });
}

async function removeAttachment(file) {
  await removeS3Object(file.objectKey);
  statements.deleteAttachment.run(file.id);
}

async function cleanupSlug(slug) {
  const { fileTtlMs } = getConfig();
  const expiresBefore = Date.now() - fileTtlMs;
  const files = statements.listAttachments.all(slug);

  for (const file of files) {
    if (file.createdAt <= expiresBefore) await removeAttachment(file);
  }

  return statements.listAttachments.all(slug);
}

async function removeAllFilesForSlug(slug) {
  const files = statements.listAttachments.all(slug);
  await Promise.all(files.map((file) => removeS3Object(file.objectKey)));
  statements.deleteAttachmentsBySlug.run(slug);
}

async function cleanupAllUploads() {
  const { fileTtlMs } = getConfig();
  const expired = statements.expiredAttachments.all(Date.now() - fileTtlMs);

  for (const file of expired) {
    await removeAttachment(file);
  }

  await cleanupExpiredS3Objects();
}

function listS3Objects(prefix) {
  return new Promise((resolve, reject) => {
    if (!s3) return resolve([]);

    const objects = [];
    const stream = s3.listObjectsV2(S3_BUCKET, prefix, true);

    stream.on('data', (object) => objects.push(object));
    stream.on('error', reject);
    stream.on('end', () => resolve(objects));
  });
}

async function cleanupExpiredS3Objects() {
  if (!s3) return;

  const now = Date.now();
  const { fileTtlMs } = getConfig();
  const objects = await listS3Objects('attachments/');
  const expiredObjects = objects.filter((object) => {
    if (!object.name || !object.lastModified) return false;
    return now - new Date(object.lastModified).getTime() >= fileTtlMs;
  });

  await Promise.all(expiredObjects.map((object) => removeS3Object(object.name)));
}

async function adminOverview() {
  await cleanupAllUploads();

  const notes = new Map(statements.listNotes.all().map((note) => [note.slug, note]));
  const summaries = new Map(statements.attachmentSummary.all().map((row) => [row.slug, row]));
  const slugs = statements.listSlugs.all().map((row) => row.slug);
  const hashToSlug = new Map(slugs.map((slug) => [slugKey(slug), slug]));
  const bucketObjects = await listS3Objects('attachments/');
  const objectBytesBySlug = new Map();
  let orphanedAttachmentBytes = 0;
  let orphanedAttachmentCount = 0;

  for (const object of bucketObjects) {
    const [, hash] = String(object.name || '').split('/');
    const slug = hashToSlug.get(hash);

    if (slug) {
      objectBytesBySlug.set(slug, (objectBytesBySlug.get(slug) || 0) + Number(object.size || 0));
    } else {
      orphanedAttachmentBytes += Number(object.size || 0);
      orphanedAttachmentCount += 1;
    }
  }

  const rows = slugs.map((slug) => {
    const note = notes.get(slug) || {};
    const attachmentSummary = summaries.get(slug) || {};
    const attachmentBytes = Number(attachmentSummary.attachmentBytes || 0);

    return {
      slug,
      charCount: Number(note.charCount || 0),
      updatedAt: note.updatedAt || null,
      attachmentCount: Number(attachmentSummary.attachmentCount || 0),
      attachmentBytes,
      bucketAttachmentBytes: objectBytesBySlug.get(slug) || attachmentBytes,
      newestAttachmentAt: attachmentSummary.newestAttachmentAt || null,
    };
  });

  rows.sort((a, b) => b.bucketAttachmentBytes - a.bucketAttachmentBytes || b.attachmentCount - a.attachmentCount);

  return {
    attachmentsEnabled,
    config: getConfig(),
    totals: {
      notes: rows.length,
      chars: rows.reduce((total, row) => total + row.charCount, 0),
      attachments: rows.reduce((total, row) => total + row.attachmentCount, 0),
      attachmentBytes: rows.reduce((total, row) => total + row.attachmentBytes, 0),
      bucketAttachmentBytes: bucketObjects.reduce((total, object) => total + Number(object.size || 0), 0),
      orphanedAttachmentCount,
      orphanedAttachmentBytes,
    },
    notes: rows,
  };
}

app.get('/api/download/:id', asyncHandler(async (req, res) => {
  if (!attachmentsEnabled) return attachmentsUnavailable(res);

  const slug = normalizeSlug(req.query.slug);
  if (!slug) return res.status(404).json({ error: 'Arquivo não encontrado.' });

  await cleanupSlug(slug);
  const file = statements.getAttachment.get(slug, req.params.id);
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado.' });

  const object = await s3.getObject(S3_BUCKET, file.objectKey);
  res.attachment(file.originalName);
  res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
  return object.pipe(res);
}));

app.get('/api/public/config', (req, res) => {
  const config = getConfig();
  res.json({
    attachmentsEnabled,
    fileTtlMs: config.fileTtlMs,
    maxFileSize: config.maxFileSize,
    maxFilesPerSlug: config.maxFilesPerSlug,
    uploadCooldownMs: config.uploadCooldownMs,
  });
});

app.get('/api/note/:slug(*)', (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.status(404).send('');

  const note = statements.getNote.get(slug);
  res.type('text/plain').send(note?.content || '');
});

app.put('/api/note/:slug(*)', (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: 'Note inválido.' });

  const content = String(req.body || '');
  saveNoteContent(slug, content);
  res.json({ ok: true, charCount: content.length });
});

app.get('/api/files/:slug(*)', asyncHandler(async (req, res) => {
  if (!attachmentsEnabled) return res.json({ files: [], attachmentsEnabled: false });

  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.json({ files: [], attachmentsEnabled: true });

  const files = (await cleanupSlug(slug)).map(fileResponse);
  res.json({ files, attachmentsEnabled: true });
}));

app.post('/api/files/:slug(*)', upload.single('file'), asyncHandler(async (req, res) => {
  if (!attachmentsEnabled) return attachmentsUnavailable(res);

  const slug = normalizeSlug(req.params.slug);
  if (!slug || !req.file) return res.status(400).json({ error: 'Arquivo inválido.' });

  const config = getConfig();
  const files = await cleanupSlug(slug);
  const lastUploadAt = uploadThrottle.get(slug) || 0;
  const remainingCooldownMs = config.uploadCooldownMs - (Date.now() - lastUploadAt);

  if (req.file.size > config.maxFileSize) {
    return res.status(413).json({ error: 'Arquivo acima do tamanho máximo permitido.' });
  }

  if (files.length >= config.maxFilesPerSlug) {
    return res.status(429).json({ error: 'Limite de arquivos por conversa atingido.' });
  }

  if (remainingCooldownMs > 0) {
    return res.status(429).json({
      error: 'Aguarde antes de enviar outro arquivo.',
      retryAfterMs: remainingCooldownMs,
    });
  }

  const id = crypto.randomUUID();
  const key = objectKey(slug, id, req.file.originalname);
  const record = {
    id,
    slug,
    originalName: req.file.originalname,
    objectKey: key,
    contentType: req.file.mimetype || 'application/octet-stream',
    size: req.file.size,
    createdAt: Date.now(),
  };

  await s3.putObject(S3_BUCKET, key, req.file.buffer, req.file.size, {
    'Content-Type': record.contentType,
  });

  statements.insertAttachment.run(record);
  uploadThrottle.set(slug, Date.now());
  res.status(201).json({ file: fileResponse(record) });
}));

app.get('/api/admin/overview', requireAdmin, asyncHandler(async (req, res) => {
  res.json(await adminOverview());
}));

app.get('/api/admin/config', requireAdmin, (req, res) => {
  res.json({ config: getConfig(), maxUploadBufferSize: MAX_UPLOAD_BUFFER_SIZE });
});

app.put('/api/admin/config', requireAdmin, (req, res) => {
  res.json({ config: writeRuntimeConfig(req.body || {}) });
});

app.post('/api/admin/cleanup-expired', requireAdmin, asyncHandler(async (req, res) => {
  await cleanupAllUploads();
  res.json(await adminOverview());
}));

app.delete('/api/admin/chats/:slug(*)', requireAdmin, asyncHandler(async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: 'Chat inválido.' });

  const deleteNote = Boolean(req.body?.deleteNote);
  const deleteAttachments = req.body?.deleteAttachments !== false;

  if (deleteAttachments) await removeAllFilesForSlug(slug);
  if (deleteNote) statements.deleteNote.run(slug);

  res.json({ ok: true });
}));

app.get('/admin', (req, res) => {
  res.sendFile(path.join(ADMIN_PUBLIC_DIR, 'index.html'));
});

app.use(express.static(PUBLIC_DIR));
app.use('/icons', express.static(path.join(PUBLIC_DIR, 'assets', 'icons')));

app.get('/app.js', (req, res) => res.sendFile(path.join(APP_PUBLIC_DIR, 'app.js')));
app.get('/style.css', (req, res) => res.sendFile(path.join(APP_PUBLIC_DIR, 'style.css')));
app.get('/200.html', (req, res) => res.sendFile(path.join(APP_PUBLIC_DIR, 'index.html')));
app.get('/admin.js', (req, res) => res.sendFile(path.join(ADMIN_PUBLIC_DIR, 'admin.js')));
app.get('/admin.css', (req, res) => res.sendFile(path.join(ADMIN_PUBLIC_DIR, 'admin.css')));
app.get('/install.sh', (req, res) => res.sendFile(path.join(SCRIPTS_DIR, 'install', 'install.sh')));
app.get('/install.ps1', (req, res) => res.sendFile(path.join(SCRIPTS_DIR, 'install', 'install.ps1')));
app.get('/makpad-cli.txt', (req, res) => res.sendFile(path.join(SCRIPTS_DIR, 'cli', 'makpad-cli.sh')));
app.get('/makpad-ps1.txt', (req, res) => res.sendFile(path.join(SCRIPTS_DIR, 'cli', 'makpad.ps1')));

app.get('*', (req, res) => {
  res.sendFile(path.join(APP_PUBLIC_DIR, 'index.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  if (err.code === 'LIMIT_FILE_SIZE') {
    return res.status(413).json({ error: 'Arquivo acima do limite absoluto do servidor.' });
  }
  res.status(500).json({ error: 'Erro interno ao processar a solicitação.' });
});

cleanupAllUploads();
setInterval(() => cleanupAllUploads(), 10 * 60 * 1000).unref();

app.listen(PORT, () => {
  console.log(`MAKPAD listening on port ${PORT}`);
  console.log(`SQLite database: ${DB_PATH}`);
});
