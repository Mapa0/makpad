const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { Client: MinioClient } = require('minio');

const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const META_DIR = path.join(DATA_DIR, 'metadata');
const CONFIG_PATH = path.join(DATA_DIR, 'admin-config.json');
const NOTE_INDEX_PATH = path.join(DATA_DIR, 'notes.json');
const S3_BUCKET = process.env.S3_BUCKET;
const KVDB_URL = process.env.KVDB_URL || 'https://kvdb.io/PN9BCNTq5bPDAQwk9gugKQ/';
const MAX_UPLOAD_BUFFER_SIZE = Number(process.env.MAX_UPLOAD_BUFFER_SIZE || 512 * 1024 * 1024);
const DEFAULT_CONFIG = {
  fileTtlMs: Number(process.env.FILE_TTL_MS || 60 * 60 * 1000),
  maxFileSize: Number(process.env.MAX_FILE_SIZE || 100 * 1024 * 1024),
  maxFilesPerSlug: Number(process.env.MAX_FILES_PER_SLUG || 20),
  uploadCooldownMs: Number(process.env.UPLOAD_COOLDOWN_MS || 10 * 1000),
};
const uploadThrottle = new Map();

fs.mkdirSync(META_DIR, { recursive: true });

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.text({ type: 'text/plain', limit: '2mb' }));
const s3Endpoint = process.env.S3_ENDPOINT ? new URL(process.env.S3_ENDPOINT) : null;
const s3 = S3_BUCKET && s3Endpoint ? new MinioClient({
  endPoint: s3Endpoint.hostname,
  port: Number(s3Endpoint.port || (s3Endpoint.protocol === 'https:' ? 443 : 80)),
  useSSL: s3Endpoint.protocol === 'https:',
  region: process.env.S3_REGION || 'garage',
  accessKey: process.env.S3_ACCESS_KEY_ID,
  secretKey: process.env.S3_SECRET_ACCESS_KEY,
  pathStyle: true,
}) : null;

function normalizeSlug(rawSlug) {
  const decoded = decodeURIComponent(String(rawSlug || '')).trim();
  const clean = decoded.replace(/^\/+|\/+$/g, '');

  if (!clean || clean === 'index.html' || clean === '200.html') {
    return null;
  }

  return clean
    .split('/')
    .filter(Boolean)
    .map((part) => part.replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 80))
    .filter(Boolean)
    .join('/');
}

function clampNumber(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(Math.max(Math.floor(number), min), max);
}

function readRuntimeConfig() {
  try {
    return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function getConfig() {
  const saved = readRuntimeConfig();
  return {
    fileTtlMs: clampNumber(saved.fileTtlMs, 60 * 1000, 7 * 24 * 60 * 60 * 1000, DEFAULT_CONFIG.fileTtlMs),
    maxFileSize: clampNumber(saved.maxFileSize, 1024, MAX_UPLOAD_BUFFER_SIZE, DEFAULT_CONFIG.maxFileSize),
    maxFilesPerSlug: clampNumber(saved.maxFilesPerSlug, 1, 200, DEFAULT_CONFIG.maxFilesPerSlug),
    uploadCooldownMs: clampNumber(saved.uploadCooldownMs, 0, 60 * 60 * 1000, DEFAULT_CONFIG.uploadCooldownMs),
  };
}

function writeRuntimeConfig(config) {
  const nextConfig = {
    fileTtlMs: clampNumber(config.fileTtlMs, 60 * 1000, 7 * 24 * 60 * 60 * 1000, getConfig().fileTtlMs),
    maxFileSize: clampNumber(config.maxFileSize, 1024, MAX_UPLOAD_BUFFER_SIZE, getConfig().maxFileSize),
    maxFilesPerSlug: clampNumber(config.maxFilesPerSlug, 1, 200, getConfig().maxFilesPerSlug),
    uploadCooldownMs: clampNumber(config.uploadCooldownMs, 0, 60 * 60 * 1000, getConfig().uploadCooldownMs),
  };

  fs.writeFileSync(CONFIG_PATH, JSON.stringify(nextConfig, null, 2));
  return nextConfig;
}

function readNoteIndex() {
  try {
    const notes = JSON.parse(fs.readFileSync(NOTE_INDEX_PATH, 'utf8'));
    return notes && typeof notes === 'object' ? notes : {};
  } catch {
    return {};
  }
}

function writeNoteIndex(notes) {
  fs.writeFileSync(NOTE_INDEX_PATH, JSON.stringify(notes, null, 2));
}

function updateNoteIndex(slug, content) {
  const notes = readNoteIndex();
  notes[slug] = {
    slug,
    charCount: content.length,
    updatedAt: Date.now(),
  };
  writeNoteIndex(notes);
}

function removeNoteFromIndex(slug) {
  const notes = readNoteIndex();
  delete notes[slug];
  writeNoteIndex(notes);
}

function kvdbKeyUrl(slug) {
  return KVDB_URL + slug;
}

function slugDir(slug) {
  const slugKey = crypto.createHash('sha256').update(slug).digest('hex');
  return path.join(META_DIR, slugKey);
}

function slugKey(slug) {
  return crypto.createHash('sha256').update(slug).digest('hex');
}

function objectKey(slug, id, fileName) {
  const safeName = path.basename(fileName || 'file').replace(/[^a-zA-Z0-9._-]/g, '-').slice(0, 120);
  return `attachments/${slugKey(slug)}/${id}/${safeName || 'file'}`;
}

function metaPath(slug) {
  return path.join(slugDir(slug), 'metadata.json');
}

function readMetadata(slug) {
  try {
    const metadata = JSON.parse(fs.readFileSync(metaPath(slug), 'utf8'));
    return Array.isArray(metadata) ? metadata : metadata.files || [];
  } catch {
    return [];
  }
}

function writeMetadata(slug, files) {
  fs.mkdirSync(slugDir(slug), { recursive: true });
  fs.writeFileSync(metaPath(slug), JSON.stringify({ slug, files }, null, 2));
}

async function removeFile(slug, file) {
  if (s3 && file.objectKey) {
    await s3.removeObject(S3_BUCKET, file.objectKey).catch(() => {});
    return;
  }

  if (file.storedName) {
    fs.rmSync(path.join(slugDir(slug), file.storedName), { force: true });
  }
}

async function cleanupSlug(slug) {
  const now = Date.now();
  const { fileTtlMs } = getConfig();
  const kept = [];

  for (const file of readMetadata(slug)) {
    const expired = now - file.createdAt >= fileTtlMs;
    const exists = s3 ? Boolean(file.objectKey) : fs.existsSync(path.join(slugDir(slug), file.storedName));

    if (expired || !exists) {
      await removeFile(slug, file);
    } else {
      kept.push(file);
    }
  }

  writeMetadata(slug, kept);
  return kept;
}

async function cleanupAllUploads() {
  if (fs.existsSync(META_DIR)) {
    for (const entry of fs.readdirSync(META_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(META_DIR, entry.name, 'metadata.json'), 'utf8'));
        if (metadata.slug) await cleanupSlug(metadata.slug);
      } catch {
        // Ignore folders without metadata.
      }
    }
  }

  await cleanupExpiredS3Objects();
}

function listS3Objects(prefix) {
  return new Promise((resolve, reject) => {
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

  if (!expiredObjects.length) return;

  await Promise.all(expiredObjects.map((object) => (
    s3.removeObject(S3_BUCKET, object.name).catch((error) => {
      console.error(`Failed to remove expired S3 object ${object.name}`, error);
    })
  )));
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BUFFER_SIZE, files: 1 },
});

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function fileResponse(file) {
  const expiresAt = file.createdAt + getConfig().fileTtlMs;
  return {
    id: file.id,
    name: file.originalName,
    size: file.size,
    createdAt: file.createdAt,
    expiresAt,
  };
}

function findFileById(slug, id) {
  const files = readMetadata(slug);
  return files.find((item) => item.id === id);
}

async function fetchNoteContent(slug) {
  const response = await fetch(kvdbKeyUrl(slug));
  if (!response.ok) return '';
  return response.text();
}

async function saveNoteContent(slug, content) {
  const response = await fetch(kvdbKeyUrl(slug), {
    method: 'POST',
    body: content,
    headers: { 'Content-Type': 'text/plain' },
  });
  if (!response.ok) throw new Error(`KVDB save failed with ${response.status}`);
  updateNoteIndex(slug, content);
}

async function deleteNoteContent(slug) {
  await fetch(kvdbKeyUrl(slug), { method: 'DELETE' }).catch(() => {});
  removeNoteFromIndex(slug);
}

async function removeAllFilesForSlug(slug) {
  const files = readMetadata(slug);
  await Promise.all(files.map((file) => removeFile(slug, file)));
  writeMetadata(slug, []);
}

function removeSlugMetadata(slug) {
  fs.rmSync(slugDir(slug), { recursive: true, force: true });
}

function requireAdmin(req, res, next) {
  const password = process.env.MAKPAD_ADMIN_PASSWORD || process.env.ADMIN_PASSWORD || process.env.ADMIN_TOKEN;
  const token = String(req.get('authorization') || '').replace(/^Bearer\s+/i, '');

  if (!password) return res.status(403).json({ error: 'Senha admin não configurada.' });
  if (token !== password) return res.status(401).json({ error: 'Acesso admin negado.' });

  next();
}

function knownSlugs() {
  const slugs = new Set(Object.keys(readNoteIndex()));

  if (fs.existsSync(META_DIR)) {
    for (const entry of fs.readdirSync(META_DIR, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;

      try {
        const metadata = JSON.parse(fs.readFileSync(path.join(META_DIR, entry.name, 'metadata.json'), 'utf8'));
        if (metadata.slug) slugs.add(metadata.slug);
      } catch {
        // Ignore folders without metadata.
      }
    }
  }

  return [...slugs].sort((a, b) => a.localeCompare(b));
}

async function adminOverview() {
  const notes = readNoteIndex();
  const slugs = knownSlugs();
  const hashToSlug = new Map(slugs.map((slug) => [slugKey(slug), slug]));
  const bucketObjects = s3 ? await listS3Objects('attachments/') : [];
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

  const rows = [];
  for (const slug of slugs) {
    const files = await cleanupSlug(slug);
    const attachmentBytes = files.reduce((total, file) => total + Number(file.size || 0), 0);
    let noteInfo = notes[slug];

    if (!noteInfo) {
      const content = await fetchNoteContent(slug).catch(() => '');
      noteInfo = { slug, charCount: content.length, updatedAt: null };
      if (content) updateNoteIndex(slug, content);
    }

    rows.push({
      slug,
      charCount: Number(noteInfo.charCount || 0),
      updatedAt: noteInfo.updatedAt || null,
      attachmentCount: files.length,
      attachmentBytes,
      bucketAttachmentBytes: objectBytesBySlug.get(slug) || attachmentBytes,
      newestAttachmentAt: files.reduce((newest, file) => Math.max(newest, Number(file.createdAt || 0)), 0) || null,
    });
  }

  rows.sort((a, b) => b.bucketAttachmentBytes - a.bucketAttachmentBytes || b.attachmentCount - a.attachmentCount);

  return {
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
  const slug = normalizeSlug(req.query.slug);
  if (!slug) return res.status(404).json({ error: 'Arquivo não encontrado.' });

  await cleanupSlug(slug);
  const file = findFileById(slug, req.params.id);
  if (!file) return res.status(404).json({ error: 'Arquivo não encontrado.' });

  if (s3 && file.objectKey) {
    const object = await s3.getObject(S3_BUCKET, file.objectKey);

    res.attachment(file.originalName);
    res.setHeader('Content-Type', file.contentType || 'application/octet-stream');
    return object.pipe(res);
  }

  return res.download(path.join(slugDir(slug), file.storedName), file.originalName);
}));

app.get('/api/public/config', (req, res) => {
  const config = getConfig();
  res.json({
    fileTtlMs: config.fileTtlMs,
    maxFileSize: config.maxFileSize,
    maxFilesPerSlug: config.maxFilesPerSlug,
    uploadCooldownMs: config.uploadCooldownMs,
  });
});

app.get('/api/note/:slug(*)', asyncHandler(async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.status(404).send('');

  const content = await fetchNoteContent(slug);
  updateNoteIndex(slug, content);
  res.type('text/plain').send(content);
}));

app.put('/api/note/:slug(*)', asyncHandler(async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.status(400).json({ error: 'Note inválido.' });

  const content = String(req.body || '');
  await saveNoteContent(slug, content);
  res.json({ ok: true, charCount: content.length });
}));

app.get('/api/files/:slug(*)', asyncHandler(async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  if (!slug) return res.json({ files: [] });

  const files = (await cleanupSlug(slug)).map(fileResponse);
  res.json({ files });
}));

app.post('/api/files/:slug(*)', upload.single('file'), asyncHandler(async (req, res) => {
  const slug = normalizeSlug(req.params.slug);
  if (!slug || !req.file) return res.status(400).json({ error: 'Arquivo inválido.' });
  if (!s3) return res.status(500).json({ error: 'S3 não configurado.' });

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

  await s3.putObject(S3_BUCKET, key, req.file.buffer, req.file.size, {
    'Content-Type': req.file.mimetype || 'application/octet-stream',
  });

  const record = {
    id,
    originalName: req.file.originalname,
    objectKey: key,
    contentType: req.file.mimetype || 'application/octet-stream',
    size: req.file.size,
    createdAt: Date.now(),
  };

  files.push(record);
  writeMetadata(slug, files);
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
  if (deleteNote) {
    await deleteNoteContent(slug);
    removeSlugMetadata(slug);
  }

  res.json({ ok: true });
}));

app.use(express.static(__dirname));
app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'admin.html'));
});
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '200.html'));
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
});
