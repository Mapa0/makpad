const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const express = require('express');
const multer = require('multer');
const { Client: MinioClient } = require('minio');

const PORT = Number(process.env.PORT || 3000);
const FILE_TTL_MS = Number(process.env.FILE_TTL_MS || 60 * 60 * 1000);
const MAX_FILE_SIZE = Number(process.env.MAX_FILE_SIZE || 100 * 1024 * 1024);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const META_DIR = path.join(DATA_DIR, 'metadata');
const S3_BUCKET = process.env.S3_BUCKET;

fs.mkdirSync(META_DIR, { recursive: true });

const app = express();
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
  const kept = [];

  for (const file of readMetadata(slug)) {
    const expired = now - file.createdAt >= FILE_TTL_MS;
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
  const objects = await listS3Objects('attachments/');
  const expiredObjects = objects.filter((object) => {
    if (!object.name || !object.lastModified) return false;
    return now - new Date(object.lastModified).getTime() >= FILE_TTL_MS;
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
  limits: { fileSize: MAX_FILE_SIZE, files: 1 },
});

function asyncHandler(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function fileResponse(file) {
  const expiresAt = file.createdAt + FILE_TTL_MS;
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

  const files = await cleanupSlug(slug);
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
  res.status(201).json({ file: fileResponse(record) });
}));

app.use(express.static(__dirname));
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, '200.html'));
});

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(500).json({ error: 'Erro interno ao processar a solicitação.' });
});

cleanupAllUploads();
setInterval(() => cleanupAllUploads(), Math.min(FILE_TTL_MS, 10 * 60 * 1000)).unref();

app.listen(PORT, () => {
  console.log(`MAKPAD listening on port ${PORT}`);
});
