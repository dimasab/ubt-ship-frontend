'use strict';

const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { test } = require('node:test');

const TOKEN = 'test-api-token';
const SECRET = 'test-body-secret';
const SOURCE_PATH = path.resolve(__dirname, '..', 'kapal.js');
const source = fs.readFileSync(SOURCE_PATH, 'utf8');

// Run the production route handlers, replacing only framework registration,
// storage I/O, the environment and the clock. Nothing contacts a real service.
async function loadRouter({ token = TOKEN, secret = SECRET } = {}) {
    const routes = new Map();
    const writes = [];
    let now = 1_800_000_000_000;
    const router = {};
    for (const method of ['get', 'post']) {
        router[method] = (url, ...handlers) => routes.set(`${method} ${url}`, handlers);
    }

    class MemoryDatabase {
        constructor(_filename, callback) {
            queueMicrotask(() => callback(null));
        }
        exec(_sql, callback) {
            queueMicrotask(() => callback(null));
        }
        run(_sql, _params, callback) {
            queueMicrotask(() => callback.call({ lastID: 1, changes: 1 }, null));
        }
        get(_sql, _params, callback) {
            queueMicrotask(() => callback(null, { totalFiles: 0 }));
        }
        all(_sql, _params, callback) {
            queueMicrotask(() => callback(null, []));
        }
    }

    const storage = {
        existsSync: () => true,
        mkdirSync: () => {},
        readdirSync: () => [],
        statSync: () => ({ size: 10, mtimeMs: 1 }),
        writeFile(filename, content, encoding, callback) {
            writes.push({ filename, content, encoding });
            queueMicrotask(() => callback(null));
        },
    };
    const modules = {
        express: { Router: () => router },
        fs: storage,
        path,
        crypto,
        sqlite3: { verbose: () => ({ Database: MemoryDatabase }) },
    };
    const context = {
        require(name) {
            assert.ok(Object.hasOwn(modules, name), `Unexpected dependency: ${name}`);
            return modules[name];
        },
        Buffer,
        __dirname: path.dirname(SOURCE_PATH),
        module: { exports: {} },
        process: { env: { UBTSHIP_API_KEY: token, UBTSHIP_BODY_SECRET: secret } },
        console: { error() {} },
        Date: class extends Date { static now() { return now; } },
        setInterval: () => ({ unref() {} }),
    };
    vm.runInNewContext(source, context, { filename: SOURCE_PATH });
    // Allow the module's startup database sync to finish before exercising it.
    await new Promise(setImmediate);

    return {
        writes,
        setNow(value) { now = value; },
        getNow() { return now; },
        async create(req) {
            const response = makeResponse();
            const [handler] = routes.get('post /ubtship/create-json');
            handler(req, response);
            await response.finished;
            return response;
        },
        limit(req) {
            const response = makeResponse();
            const [middleware] = routes.get('get /ubtship/read-json');
            let nextCalls = 0;
            middleware(req, response, () => { nextCalls += 1; });
            return { ...response, nextCalls };
        },
    };
}

function makeResponse() {
    let finish;
    return {
        statusCode: 200,
        headers: {},
        body: undefined,
        finished: new Promise(resolve => { finish = resolve; }),
        set(name, value) { this.headers[name.toLowerCase()] = value; return this; },
        status(value) { this.statusCode = value; return this; },
        json(value) {
            this.body = JSON.parse(JSON.stringify(value));
            finish();
            return this;
        },
    };
}

function createRequest(overrides = {}) {
    return {
        headers: { authorization: `Bearer ${TOKEN}` },
        body: { fileName: 'snapshot.json', fileContent: { status: 'active' }, secret: SECRET },
        ...overrides,
    };
}

function readRequest(ip = '192.0.2.10', headers = {}) {
    return { ip, headers, socket: { remoteAddress: ip } };
}

for (const [label, authorization] of [
    ['missing', undefined],
    ['empty', ''],
    ['empty bearer', 'Bearer '],
    ['shorter', 'Bearer x'],
    ['longer', `Bearer ${TOKEN}x`],
    ['same-length incorrect', `Bearer ${'x'.repeat(TOKEN.length)}`],
    ['wrong scheme', `Basic ${TOKEN}`],
    ['duplicate values', [`Bearer ${TOKEN}`, `Bearer ${TOKEN}`]],
]) {
    test(`rejects ${label} credentials with 401, not an exception`, async () => {
        const app = await loadRouter();
        const response = await app.create(createRequest({ headers: { authorization } }));
        assert.equal(response.statusCode, 401);
        assert.deepEqual(response.body, { error: 'Unauthorized' });
        assert.equal(app.writes.length, 0);
    });
}

for (const body of [undefined, null, [], 'text', 42]) {
    test(`rejects a non-object request body (${JSON.stringify(body)})`, async () => {
        const app = await loadRouter();
        const response = await app.create(createRequest({ body }));
        assert.equal(response.statusCode, 400);
        assert.equal(app.writes.length, 0);
    });
}

for (const secret of [undefined, '', 'x', `${SECRET}x`, 'x'.repeat(SECRET.length), {}, [], 42]) {
    test(`rejects an invalid body secret (${JSON.stringify(secret)})`, async () => {
        const app = await loadRouter();
        const req = createRequest();
        req.body.secret = secret;
        const response = await app.create(req);
        assert.equal(response.statusCode, 401);
        assert.equal(app.writes.length, 0);
    });
}

for (const fileName of [42, {}, ['snapshot.json'], '../snapshot.json', '/snapshot.json', 'bad\0name']) {
    test(`rejects an invalid filename (${JSON.stringify(fileName)}) without writing`, async () => {
        const app = await loadRouter();
        const req = createRequest();
        req.body.fileName = fileName;
        const response = await app.create(req);
        assert.equal(response.statusCode, 400);
        assert.equal(app.writes.length, 0);
    });
}

test('valid authentication still writes and indexes a snapshot', async () => {
    const app = await loadRouter();
    const response = await app.create(createRequest());
    assert.equal(response.statusCode, 200);
    assert.equal(response.body.success, true);
    assert.equal(response.body.indexed, true);
    assert.equal(app.writes.length, 1);
    assert.deepEqual(JSON.parse(app.writes[0].content), { status: 'active' });
});

for (const config of [{ token: '' }, { secret: '' }]) {
    test(`missing server credential fails closed (${Object.keys(config)[0]})`, async () => {
        const app = await loadRouter(config);
        const response = await app.create(createRequest());
        assert.equal(response.statusCode, 500);
        assert.deepEqual(response.body, { error: 'Server misconfiguration' });
        assert.equal(app.writes.length, 0);
    });
}

test('changing unverified API-key and forwarding headers cannot reset the same client quota', async () => {
    const app = await loadRouter();
    for (let i = 0; i < 8; i += 1) {
        const response = app.limit(readRequest('192.0.2.10', {
            'x-api-key': `unverified-${i}`,
            'x-forwarded-for': `198.51.100.${i + 1}`,
        }));
        assert.equal(response.nextCalls, i < 5 ? 1 : 0);
        assert.equal(response.statusCode, i < 5 ? 200 : 429);
        assert.equal(response.headers['x-ratelimit-limit'], '5');
        assert.equal(response.headers['x-ratelimit-remaining'], String(Math.max(0, 4 - i)));
        if (i >= 5) assert.equal(response.headers['retry-after'], '60');
    }
});

test('falls back to the connection address, never raw forwarding headers', async () => {
    const app = await loadRouter();
    for (let i = 0; i < 6; i += 1) {
        const response = app.limit({
            headers: { 'x-api-key': String(i), 'x-forwarded-for': `198.51.100.${i + 1}` },
            socket: { remoteAddress: '192.0.2.20' },
        });
        assert.equal(response.statusCode, i < 5 ? 200 : 429);
    }
});

test('uses a shared fallback quota when no network identity is available', async () => {
    const app = await loadRouter();
    for (let i = 0; i < 6; i += 1) {
        const response = app.limit({ headers: { 'x-forwarded-for': String(i) } });
        assert.equal(response.statusCode, i < 5 ? 200 : 429);
    }
});

test('separate Express-resolved client IPs receive separate quotas', async () => {
    const app = await loadRouter();
    for (let i = 0; i < 5; i += 1) app.limit(readRequest());
    assert.equal(app.limit(readRequest()).statusCode, 429);
    const otherClient = app.limit({
        ip: '192.0.2.11',
        headers: {},
        socket: { remoteAddress: '127.0.0.1' },
    });
    assert.equal(otherClient.nextCalls, 1);
    assert.equal(otherClient.headers['x-ratelimit-remaining'], '4');
});

test('quota resets exactly at the deadline and rejected requests do not extend it', async () => {
    const app = await loadRouter();
    const start = app.getNow();
    for (let i = 0; i < 5; i += 1) app.limit(readRequest());
    app.setNow(start + 59_999);
    const blocked = app.limit(readRequest());
    assert.equal(blocked.statusCode, 429);
    assert.equal(blocked.headers['retry-after'], '1');
    app.setNow(start + 60_000);
    const renewed = app.limit(readRequest());
    assert.equal(renewed.nextCalls, 1);
    assert.equal(renewed.headers['x-ratelimit-remaining'], '4');
    assert.equal(renewed.headers['x-ratelimit-reset'], String((start + 120_000) / 1000));
    assert.equal(renewed.headers['retry-after'], undefined);
});
