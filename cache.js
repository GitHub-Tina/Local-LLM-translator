/**
 * cache.js — 译文缓存（仅 background 加载）。
 *
 * 键 = 决定模型输出的全部输入（模型 + 源/目标语言 + 提示词形态 + 原文），
 * 因此同一字符串只翻一次，可跨批次、跨页面、跨会话复用。
 *
 * 两层结构：
 *  - 内存 Map：快速命中层；IndexedDB 不可用（隐私加固浏览器）时的唯一存储。
 *  - IndexedDB：跨会话持久层（cacheMode = 'persistent' 时才有意义）。
 *
 * 设计参考：offline-browser-translate 的两层缓存与容量修剪策略。
 */
(function () {
    const DB_NAME = 'llm-translator-cache';
    const STORE = 'translations';
    const DB_VERSION = 1;
    const MAX_ENTRIES = 100000; // IndexedDB 软上限，超出按时间淘汰最旧
    const MEM_MAX = 50000;      // 内存层上限，约束 RAM 占用
    const SEP = String.fromCharCode(0); // NUL 不会出现在页面文本里

    const mem = new Map();
    let idbDisabled = false;
    let dbPromise = null;
    let approxCount = null;

    function memSet(k, v) {
        if (mem.has(k)) mem.delete(k); // 重新插入以保持 LRU 顺序
        mem.set(k, v);
        if (mem.size > MEM_MAX) mem.delete(mem.keys().next().value);
    }

    function openDB() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise((resolve, reject) => {
            const req = indexedDB.open(DB_NAME, DB_VERSION);
            req.onupgradeneeded = () => {
                const db = req.result;
                if (!db.objectStoreNames.contains(STORE)) {
                    const store = db.createObjectStore(STORE, { keyPath: 'k' });
                    store.createIndex('ts', 'ts', { unique: false });
                }
            };
            req.onsuccess = () => resolve(req.result);
            req.onerror = () => { dbPromise = null; idbDisabled = true; reject(req.error); };
        });
        return dbPromise;
    }

    function cacheKey(model, sourceCode, targetCode, promptSig, text) {
        return [model || '', sourceCode || '', targetCode || '', promptSig || '', text].join(SEP);
    }

    function cacheGetMany(keys) {
        if (!keys || keys.length === 0) return Promise.resolve(new Map());
        const out = new Map();
        const missing = [];
        for (const key of keys) {
            if (mem.has(key)) out.set(key, mem.get(key));
            else missing.push(key);
        }
        if (missing.length === 0 || idbDisabled) return Promise.resolve(out);
        return openDB().then(db => new Promise((resolve) => {
            const store = db.transaction(STORE, 'readonly').objectStore(STORE);
            let remaining = missing.length;
            const done = () => { if (--remaining === 0) resolve(out); };
            missing.forEach((key) => {
                const r = store.get(key);
                r.onsuccess = () => {
                    if (r.result) { out.set(key, r.result.v); memSet(key, r.result.v); }
                    done();
                };
                r.onerror = () => done();
            });
        })).catch(() => out);
    }

    function cacheSetMany(entries) {
        if (!entries || entries.length === 0) return Promise.resolve();
        for (const [k, v] of entries) memSet(k, v);
        if (idbDisabled) return Promise.resolve();
        const ts = Date.now();
        return openDB().then(db => new Promise((resolve, reject) => {
            const t = db.transaction(STORE, 'readwrite');
            const store = t.objectStore(STORE);
            for (const [k, v] of entries) store.put({ k, v, ts });
            t.oncomplete = () => resolve();
            t.onerror = () => reject(t.error);
        })).then(() => maybeTrim(entries.length))
            .catch(() => { idbDisabled = true; });
    }

    function maybeTrim(added) {
        const seed = (approxCount !== null)
            ? Promise.resolve(approxCount)
            : cacheCount().then(c => (approxCount = c));
        return seed.then(() => {
            approxCount += (added || 0);
            if (approxCount <= MAX_ENTRIES) return;
            let toDelete = approxCount - MAX_ENTRIES + Math.floor(MAX_ENTRIES * 0.1);
            return openDB().then(db => new Promise((resolve) => {
                const store = db.transaction(STORE, 'readwrite').objectStore(STORE);
                const cur = store.index('ts').openCursor();
                cur.onsuccess = () => {
                    const c = cur.result;
                    if (c && toDelete > 0) { c.delete(); toDelete--; approxCount--; c.continue(); }
                    else resolve();
                };
                cur.onerror = () => resolve();
            }));
        });
    }

    function cacheClear() {
        mem.clear();
        if (idbDisabled) return Promise.resolve();
        return openDB().then(db => new Promise((resolve, reject) => {
            const r = db.transaction(STORE, 'readwrite').objectStore(STORE).clear();
            r.onsuccess = () => { approxCount = 0; resolve(); };
            r.onerror = () => reject(r.error);
        })).catch(() => { /* 内存层已清 */ });
    }

    function cacheCount() {
        if (idbDisabled) return Promise.resolve(mem.size);
        return openDB().then(db => new Promise((resolve, reject) => {
            const r = db.transaction(STORE, 'readonly').objectStore(STORE).count();
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => reject(r.error);
        })).catch(() => mem.size);
    }

    function cachePersistentAvailable() {
        if (idbDisabled) return Promise.resolve(false);
        return openDB().then(() => true).catch(() => false);
    }

    const g = (typeof self !== 'undefined') ? self
        : (typeof globalThis !== 'undefined') ? globalThis : window;
    Object.assign(g, { cacheKey, cacheGetMany, cacheSetMany, cacheClear, cacheCount, cachePersistentAvailable });
})();
