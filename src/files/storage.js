'use strict';
// Private file storage for answer sheets and answer keys.
//  - Validation uses the actual bytes (magic numbers), never the filename or the
//    browser-supplied MIME type.
//  - Stored under generated random names; original names are metadata only.
//  - Files live in DATA_DIR/private, which is never exposed as a static directory.
//  - Every read goes through resolveSafe(), which blocks path traversal.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { AppError } = require('../services/errors');

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB per file (server-side, independent of the browser)

const ALLOWED_EXT = {
  pdf: 'application/pdf',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
  // فایلِ صوتیِ بخشِ لیسنینگِ آزمونِ زبان
  mp3: 'audio/mpeg',
  m4a: 'audio/mp4',
  aac: 'audio/aac',
  ogg: 'audio/ogg',
  oga: 'audio/ogg',
  opus: 'audio/ogg',
  wav: 'audio/wav',
  weba: 'audio/webm',
  webm: 'audio/webm',
};

/** پسوندهایی که محتوای صوتی دارند (برای پیامِ خطایِ روشن‌تر). */
const AUDIO_EXT = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'wav', 'weba', 'webm']);

// Executables, scripts, markup, archives and other active formats are refused by name too.
const DENY_EXT = /\.(exe|dll|bat|cmd|com|scr|msi|msp|ps1|psm1|sh|bash|js|mjs|cjs|vbs|jar|php\d?|py|pl|rb|html?|xhtml|svg|hta|apk|app|bin|dmg|deb|rpm|zip|rar|7z|gz|tar|iso|lnk|docm?|xlsm?|pptm?)$/i;

function sniffType(buf) {
  if (buf.length >= 5 && buf.subarray(0, 5).toString('latin1') === '%PDF-') return 'application/pdf';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'image/jpeg';
  if (buf.length >= 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'image/webp';
  return sniffAudio(buf);
}

/**
 * تشخیصِ فایل‌های صوتی از روی نشانه‌ی ابتدای فایل.
 * ID3 (MP3)، ftyp/M4A (MP4)، OggS، RIFF/WAVE و EBML (WebM) پوشش داده می‌شوند.
 */
function sniffAudio(buf) {
  if (buf.length < 4) return null;
  if (buf.subarray(0, 3).toString('latin1') === 'ID3') return 'audio/mpeg';
  if (buf[0] === 0xff && (buf[1] === 0xfb || buf[1] === 0xf3 || buf[1] === 0xf2)) return 'audio/mpeg';  // MP3 بدون ID3
  if (buf.length >= 12 && buf.subarray(4, 8).toString('latin1') === 'ftyp') {
    const brand = buf.subarray(8, 12).toString('latin1');
    if (['M4A ', 'mp42', 'isom', 'dash', 'qt  '].includes(brand)) return 'audio/mp4';
    return 'audio/mp4';
  }
  if (buf.subarray(0, 4).toString('latin1') === 'OggS') return 'audio/ogg';
  if (buf.length >= 12
    && buf.subarray(0, 4).toString('latin1') === 'RIFF'
    && buf.subarray(8, 12).toString('latin1') === 'WAVE') return 'audio/wav';
  if (buf.length >= 4 && buf[0] === 0x1a && buf[1] === 0x45 && buf[2] === 0xdf && buf[3] === 0xa3) return 'audio/webm';
  return null;
}

// Native executables / scripts / markup disguised as images or PDFs.
function looksExecutable(buf) {
  const head = buf.subarray(0, 64).toString('latin1');
  return buf.subarray(0, 2).toString('latin1') === 'MZ' ||        // Windows PE
    buf.subarray(0, 4).toString('latin1') === '\x7fELF' ||         // ELF
    head.startsWith('#!') ||
    /^\s*<\s*(\?php|script|html|svg)/i.test(head) ||
    /^\s*<\?xml[\s\S]{0,200}<svg/i.test(head);
}

// PDFs with launch/script features are rejected (heuristic; compressed object
// streams can still hide markers, so this is one layer, not the only one).
const PDF_ACTIVE = /\/(JavaScript|JS|Launch|EmbeddedFile|RichMedia|XFA|SubmitForm|ImportData)\b/;

function sanitizeName(name) {
  const base = path.basename(String(name || 'file')).replace(/[\u0000-\u001f\u007f<>:"/\\|?*]/g, '_');
  return base.slice(0, 180) || 'file';
}

/** Validate an uploaded buffer. Returns metadata or throws AppError (413/415/400). */
function validateUpload({ buffer, originalName, maxBytes = MAX_BYTES }) {
  if (!Buffer.isBuffer(buffer) || buffer.length === 0) throw new AppError(400, 'empty_file', 'فایل خالی است');
  if (buffer.length > maxBytes) throw new AppError(413, 'file_too_large', 'حجم فایل بیش از ۱۰ مگابایت است');
  const name = sanitizeName(originalName);
  if (DENY_EXT.test(name)) throw new AppError(415, 'unsupported_type', 'این نوع فایل مجاز نیست');
  const ext = (path.extname(name).slice(1) || '').toLowerCase();
  if (!ALLOWED_EXT[ext]) throw new AppError(415, 'unsupported_type', 'فقط PDF، PNG، JPG، WEBP یا فایل صوتی (MP3/M4A/OGG/WAV) مجاز است');
  if (looksExecutable(buffer)) throw new AppError(415, 'unsupported_type', 'محتوای فایل مجاز نیست');
  const detected = sniffType(buffer);
  // صوت‌ها انواعِ گوناگونی دارند (مثلاً m4a و weba هر دو ذیلِ mp4/webm)؛
  // برایشان کافی است که محتوا واقعاً صوت باشد.
  if (AUDIO_EXT.has(ext)) {
    if (!detected || !detected.startsWith('audio/')) {
      throw new AppError(415, 'content_mismatch', 'محتوای فایل صوتی نیست');
    }
  } else if (!detected || detected !== ALLOWED_EXT[ext]) {
    throw new AppError(415, 'content_mismatch', 'محتوای فایل با پسوند آن مطابقت ندارد');
  }
  if (detected === 'application/pdf' && PDF_ACTIVE.test(buffer.toString('latin1'))) {
    throw new AppError(415, 'pdf_active_content', 'PDF حاوی محتوای فعال (اسکریپت) است و پذیرفته نمی‌شود');
  }
  return {
    originalName: name,
    mimeType: detected,
    sizeBytes: buffer.length,
    sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
  };
}

function storageRoot(dataDir) {
  return path.join(dataDir, 'private');
}

/** Write bytes to a new random path. Returns the relative storage name. */
function writePrivate(dataDir, buffer, now = new Date()) {
  const root = storageRoot(dataDir);
  const month = now.toISOString().slice(0, 7);
  const rel = path.join('uploads', month, `${crypto.randomBytes(24).toString('hex')}.bin`);
  const full = resolveSafe(dataDir, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true, mode: 0o700 });
  const fd = fs.openSync(full, 'wx', 0o600); // fail if the name somehow exists
  try {
    fs.writeSync(fd, buffer);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  void root;
  return rel.split(path.sep).join('/');
}

/** Resolve a stored relative name inside the private root. Blocks traversal and absolute paths. */
function resolveSafe(dataDir, storageName) {
  if (typeof storageName !== 'string' || !/^uploads\/\d{4}-\d{2}\/[a-f0-9]{48}\.bin$/.test(storageName)) {
    throw new AppError(404, 'not_found', 'فایل یافت نشد');
  }
  const root = path.resolve(storageRoot(dataDir));
  const full = path.resolve(root, storageName);
  if (!full.startsWith(root + path.sep)) throw new AppError(404, 'not_found', 'فایل یافت نشد');
  return full;
}

function readPrivate(dataDir, storageName) {
  const full = resolveSafe(dataDir, storageName);
  if (!fs.existsSync(full)) throw new AppError(404, 'file_missing', 'فایل روی سرور یافت نشد');
  return fs.readFileSync(full);
}

function removePrivate(dataDir, storageName) {
  try { fs.unlinkSync(resolveSafe(dataDir, storageName)); } catch (e) { if (e.code !== 'ENOENT') throw e; }
}

/** Walk the uploads tree (used by orphan cleanup). */
function listStoredFiles(dataDir) {
  const out = [];
  const root = path.resolve(storageRoot(dataDir), 'uploads');
  if (!fs.existsSync(root)) return out;
  for (const month of fs.readdirSync(root)) {
    const dir = path.join(root, month);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const f of fs.readdirSync(dir)) {
      const full = path.join(dir, f);
      out.push({ storageName: `uploads/${month}/${f}`, full, mtimeMs: fs.statSync(full).mtimeMs });
    }
  }
  return out;
}

module.exports = {
  MAX_BYTES, ALLOWED_EXT, validateUpload, writePrivate, resolveSafe, readPrivate, removePrivate,
  listStoredFiles, sniffType, sanitizeName,
};
