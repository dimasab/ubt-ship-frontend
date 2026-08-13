//******************************************* MULAI FILE KAPAL.JS *******************************************
/**
 * 
 * Version: 10 -> cap increase from 100 to 500
 * 
 * 
 */

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const sqlite3 = require('sqlite3').verbose();

const router = express.Router();

const OUTPUT_DIR = path.join(__dirname, 'output');
const DB_PATH = path.join(__dirname, 'ubtship.db');

let db = null;
let dbPromise = null;

// Simple in-memory rate limiter (no external packages)
const RATE_LIMIT_WINDOW_MS = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX = 5; // max requests per window per key
const rateLimitStore = new Map(); // key -> { count, resetAt }

// periodic cleanup to avoid unbounded memory growth
const rateLimitCleanupTimer = setInterval(() => {
    const now = Date.now();
    for (const [k, v] of rateLimitStore.entries()) {
        if (v.resetAt + RATE_LIMIT_WINDOW_MS * 5 < now) {
            rateLimitStore.delete(k);
        }
    }
}, RATE_LIMIT_WINDOW_MS);

if (typeof rateLimitCleanupTimer.unref === 'function') {
    rateLimitCleanupTimer.unref();
}

function ensureOutputDir() {
    if (!fs.existsSync(OUTPUT_DIR)) {
        fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    }
}

function parseSnapshotContent(raw) {
    try {
        const parsed = JSON.parse(raw);
        return {
            content: parsed,
            contentJson: JSON.stringify(parsed),
            parseError: null,
        };
    } catch (err) {
        return {
            content: null,
            contentJson: null,
            parseError: err.message,
        };
    }
}

function dbRun(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.run(sql, params, function onRun(err) {
            if (err) {
                reject(err);
                return;
            }

            resolve({
                lastID: this.lastID,
                changes: this.changes,
            });
        });
    });
}

function dbGet(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.get(sql, params, (err, row) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(row);
        });
    });
}

function dbAll(database, sql, params = []) {
    return new Promise((resolve, reject) => {
        database.all(sql, params, (err, rows) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(rows);
        });
    });
}

function dbExec(database, sql) {
    return new Promise((resolve, reject) => {
        database.exec(sql, (err) => {
            if (err) {
                reject(err);
                return;
            }

            resolve();
        });
    });
}

async function getDatabase() {
    if (db) {
        return db;
    }

    if (dbPromise) {
        return dbPromise;
    }

    ensureOutputDir();

    dbPromise = new Promise((resolve, reject) => {
        const database = new sqlite3.Database(DB_PATH, (err) => {
            if (err) {
                reject(err);
                return;
            }

            resolve(database);
        });
    })
        .then(async (database) => {
            await dbExec(database, `
                CREATE TABLE IF NOT EXISTS ubtship_snapshots (
                    file_name TEXT PRIMARY KEY,
                    file_path TEXT NOT NULL,
                    raw_content TEXT NOT NULL,
                    content_json TEXT,
                    parse_error TEXT,
                    file_mtime_ms REAL NOT NULL,
                    file_size INTEGER NOT NULL,
                    indexed_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_ubtship_snapshots_file_name
                ON ubtship_snapshots(file_name DESC);
            `);

            db = database;
            return database;
        })
        .catch((err) => {
            dbPromise = null;
            throw err;
        });

    return dbPromise;
}

async function syncOutputDirectoryToDatabase() {
    const database = await getDatabase();

    ensureOutputDir();

    const files = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true })
        .filter((dirent) => dirent.isFile() && dirent.name.toLowerCase().endsWith('.json'));

    const seenFileNames = new Set();

    await dbRun(database, 'BEGIN TRANSACTION');

    try {
        for (const dirent of files) {
            const fileName = dirent.name;
            const filePath = path.join(OUTPUT_DIR, fileName);
            const stats = fs.statSync(filePath);
            const existing = await dbGet(
                database,
                `
                    SELECT file_mtime_ms, file_size
                    FROM ubtship_snapshots
                    WHERE file_name = ?
                `,
                [fileName],
            );

            seenFileNames.add(fileName);

            if (existing && Number(existing.file_mtime_ms) === stats.mtimeMs && Number(existing.file_size) === stats.size) {
                continue;
            }

            const rawContent = fs.readFileSync(filePath, 'utf8');
            const parsed = parseSnapshotContent(rawContent);

            await dbRun(
                database,
                `
                    INSERT INTO ubtship_snapshots (
                        file_name,
                        file_path,
                        raw_content,
                        content_json,
                        parse_error,
                        file_mtime_ms,
                        file_size,
                        indexed_at
                    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
                    ON CONFLICT(file_name) DO UPDATE SET
                        file_path = excluded.file_path,
                        raw_content = excluded.raw_content,
                        content_json = excluded.content_json,
                        parse_error = excluded.parse_error,
                        file_mtime_ms = excluded.file_mtime_ms,
                        file_size = excluded.file_size,
                        indexed_at = excluded.indexed_at
                `,
                [
                    fileName,
                    filePath,
                    rawContent,
                    parsed.contentJson,
                    parsed.parseError,
                    stats.mtimeMs,
                    stats.size,
                    new Date().toISOString(),
                ],
            );
        }

        const indexedFiles = await dbAll(database, 'SELECT file_name FROM ubtship_snapshots');
        for (const row of indexedFiles) {
            if (!seenFileNames.has(row.file_name)) {
                await dbRun(database, 'DELETE FROM ubtship_snapshots WHERE file_name = ?', [row.file_name]);
            }
        }

        await dbRun(database, 'COMMIT');
    } catch (err) {
        await dbRun(database, 'ROLLBACK');
        throw err;
    }
}

async function upsertSnapshotRecord(fileName, filePath, rawContent) {
    const stats = fs.statSync(filePath);
    const parsed = parseSnapshotContent(rawContent);

    const database = await getDatabase();
    await dbRun(
        database,
        `
            INSERT INTO ubtship_snapshots (
                file_name,
                file_path,
                raw_content,
                content_json,
                parse_error,
                file_mtime_ms,
                file_size,
                indexed_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(file_name) DO UPDATE SET
                file_path = excluded.file_path,
                raw_content = excluded.raw_content,
                content_json = excluded.content_json,
                parse_error = excluded.parse_error,
                file_mtime_ms = excluded.file_mtime_ms,
                file_size = excluded.file_size,
                indexed_at = excluded.indexed_at
        `,
        [
            fileName,
            filePath,
            rawContent,
            parsed.contentJson,
            parsed.parseError,
            stats.mtimeMs,
            stats.size,
            new Date().toISOString(),
        ],
    );

    return parsed;
}

async function listSnapshotsFromDatabase(page, limit) {
    const database = await getDatabase();
    await syncOutputDirectoryToDatabase();

    const countRow = await dbGet(database, 'SELECT COUNT(*) AS totalFiles FROM ubtship_snapshots');
    const totalFiles = Number((countRow && countRow.totalFiles) || 0);
    const totalPages = totalFiles === 0 ? 0 : Math.ceil(totalFiles / limit);
    const safePage = totalPages === 0 ? 1 : Math.min(page, totalPages);
    const offset = (safePage - 1) * limit;

    const rows = await dbAll(
        database,
        `
            SELECT file_name, content_json, parse_error
            FROM ubtship_snapshots
            ORDER BY file_name DESC
            LIMIT ? OFFSET ?
        `,
        [limit, offset],
    );

    const items = rows.map((row) => ({
        fileName: row.file_name,
        content: row.content_json ? JSON.parse(row.content_json) : null,
        parseError: row.parse_error,
    }));

    return {
        page: safePage,
        limit,
        totalFiles,
        totalPages,
        items,
    };
}

syncOutputDirectoryToDatabase().catch((err) => {
    console.error('ubtship sqlite startup sync error:', err.message);
});

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

    ensureOutputDir();

    const content = typeof fileContent === 'string' ? fileContent : JSON.stringify(fileContent, null, 2);

    fs.writeFile(filePath, content, 'utf8', async (err) => {
        if (err) {
            console.error('ubtship create-json error:', err.message);
            return res.status(500).json({ error: 'Failed to write file' });
        }

        let indexed = true;

        try {
            await upsertSnapshotRecord(path.basename(filePath), filePath, content);
        } catch (dbError) {
            indexed = false;
            console.error('ubtship sqlite index error:', dbError.message);
        }

        return res.json({
            success: true,
            indexed,
            filePath: path.relative(__dirname, filePath),
        });
    });
});

router.get('/ubtship/read-json', ubtshipRateLimit, async (req, res) => {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.max(1, Math.min(500, parseInt(req.query.limit, 10) || 20));

    try {
        return res.json(await listSnapshotsFromDatabase(page, limit));
    } catch (err) {
        console.error('ubtship read-json sqlite error:', err.message);
        return res.status(500).json({ error: 'Failed to read indexed snapshots' });
    }
});

router.get(['/ubtship/ui', '/ubtship/ui/'], (req, res) => {
    res.sendFile(path.join(__dirname, 'ui.html'));
});

module.exports = router;
