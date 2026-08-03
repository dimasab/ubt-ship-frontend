//******************************************* MULAI FILE KAPAL.JS *******************************************
/**
 * 
 * Version: 5 -> delete filepath from response
 * 
 * 
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const router = express.Router();

const OUTPUT_DIR = path.join(__dirname, 'output');

// Simple in-memory rate limiter (no external packages)
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 5; // max requests per window per key
const rateLimitStore = new Map(); // key -> { count, resetAt }

// periodic cleanup to avoid unbounded memory growth
setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitStore.entries()) {
        if (v.resetAt + RATE_LIMIT_WINDOW_MS * 5 < now) {
            rateLimitStore.delete(k);
        }
    }
}, RATE_LIMIT_WINDOW_MS);

function ubtshipRateLimit(req, res, next) {
    const key = (req.headers['x-api-key'] || req.ip || req.headers['x-forwarded-for'] || 'unknown').toString();
    const now = Date.now();
    let entry = rateLimitStore.get(key);
    if (!entry || now > entry.resetAt) {
        entry = { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS };
    } else {
        entry.count += 1;
    }
    rateLimitStore.set(key, entry);

    res.set('X-RateLimit-Limit', String(RATE_LIMIT_MAX));
    res.set('X-RateLimit-Remaining', String(Math.max(0, RATE_LIMIT_MAX - entry.count)));
    res.set('X-RateLimit-Reset', String(Math.ceil(entry.resetAt / 1000)));

    if (entry.count > RATE_LIMIT_MAX) {
        return res.status(429).json({ error: `Too many requests (max ${RATE_LIMIT_MAX} per minute)` });
    }

    next();
}

const UBTSHIP_API_KEY = String(process.env.UBTSHIP_API_KEY || '').trim();
const UBTSHIP_BODY_SECRET = String(process.env.UBTSHIP_BODY_SECRET || '').trim();

router.post('/ubtship/create-json', (req, res) => {
    // --- Header verification ---
    const authHeader = String(req.headers['authorization'] || '');
    const bearerToken = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

    if (!UBTSHIP_API_KEY) {
        console.error('ubtship: UBTSHIP_API_KEY env variable is not set');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }
    if (!crypto.timingSafeEqual(Buffer.from(bearerToken), Buffer.from(UBTSHIP_API_KEY))) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    // --- Body secret verification ---
    const { fileName, fileContent, secret } = req.body;

    if (!UBTSHIP_BODY_SECRET) {
        console.error('ubtship: UBTSHIP_BODY_SECRET env variable is not set');
        return res.status(500).json({ error: 'Server misconfiguration' });
    }
    const secretBuffer = Buffer.from(String(secret || ''));
    const expectedBuffer = Buffer.from(UBTSHIP_BODY_SECRET);
    if (secretBuffer.length !== expectedBuffer.length || !crypto.timingSafeEqual(secretBuffer, expectedBuffer)) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    if (!fileName || fileContent === undefined) {
        return res.status(400).json({ error: 'fileName and fileContent are required' });
    }

    const safeName = path.basename(fileName);
    if (!safeName || safeName !== fileName) {
        return res.status(400).json({ error: 'Invalid fileName' });
    }

    const filePath = path.join(OUTPUT_DIR, safeName.endsWith('.json') ? safeName : safeName + '.json');

    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }

    const content = typeof fileContent === 'string' ? fileContent : JSON.stringify(fileContent, null, 2);

    fs.writeFile(filePath, content, 'utf8', (err) => {
        if (err) {
            console.error('ubtship create-json error:', err.message);
            return res.status(500).json({ error: 'Failed to write file' });
        }
        return res.json({ success: true, filePath: path.relative(__dirname, filePath) });
    });
});

router.get('/ubtship/read-json', ubtshipRateLimit, (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(100, parseInt(req.query.limit, 10) || 20));

    if (!fs.existsSync(OUTPUT_DIR)) {
        return res.json({ page, limit, totalFiles: 0, totalPages: 0, items: [] });
    }

    const files = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
        .filter((dirent) => dirent.isFile() && dirent.name.toLowerCase().endsWith('.json'))
        .map((dirent) => {
            const filePath = path.join(OUTPUT_DIR, dirent.name);
            return {
                fileName: dirent.name,
                filePath,
            };
        })
        .sort((a, b) => a.fileName.localeCompare(b.fileName, 'en', { numeric: true }));

    const totalFiles = files.length;
    const totalPages = Math.max(1, Math.ceil(totalFiles / limit));
    const pageIndex = Math.min(page, totalPages) - 1;
    const pageFiles = files.slice(pageIndex * limit, pageIndex * limit + limit);

    const items = pageFiles.map((file) => {
        const raw = fs.readFileSync(file.filePath, 'utf8');
        let parsed = null;
        let parseError = null;

        try {
            parsed = JSON.parse(raw);
        } catch (err) {
            parseError = err.message;
        }

        return {
            fileName: file.fileName,
            content: parsed,
            parseError,
        };
    });

    return res.json({
        page,
        limit,
        totalFiles,
        totalPages,
        items,
    });
});

module.exports = router;
