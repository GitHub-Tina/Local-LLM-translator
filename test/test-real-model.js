/**
 * 真实 llama.cpp 模型端到端测试：沙箱 background.js -> llama-server -> qwen2.5-7b。
 * 前置：llama-server 已在 --port 18090 上运行。
 * 运行：node test/test-real-model.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');
const PORT = process.env.PORT || '18090';

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ ${name}${detail ? ' — ' + String(detail).substring(0, 300) : ''}`); }
}

function makeChromeStub() {
    const listeners = { onMessage: [], onConnect: [], onStartup: [], onInstalled: [] };
    const store = {};
    return {
        _listeners: listeners, _store: store,
        storage: {
            onChanged: { addListener: () => {} },
            local: {
                get: async (keys) => { const out = {}; for (const k of [].concat(keys)) if (store[k] !== undefined) out[k] = store[k]; return out; },
                set: async (obj) => { Object.assign(store, obj); },
                remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; }
            }
        },
        runtime: {
            onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
            onConnect: { addListener: () => {} },
            onStartup: { addListener: (fn) => listeners.onStartup.push(fn) },
            onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
            connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
            lastError: null
        },
        contextMenus: { create: () => {}, onClicked: { addListener: () => {} } },
        tabs: { sendMessage: async () => { throw new Error('no tab'); } },
        scripting: { registerContentScripts: async () => {}, unregisterContentScripts: async () => {}, executeScript: async () => [] }
    };
}

function loadBackground() {
    const sandbox = {};
    sandbox.chrome = makeChromeStub();
    Object.assign(sandbox, {
        console, URL, fetch: (...a) => fetch(...a), AbortController, setTimeout, clearTimeout,
        importScripts: (...files) => {
            for (const f of files) {
                vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
            }
        }
    });
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
    return sandbox;
}

async function sendMessage(sandbox, message) {
    const listener = sandbox.chrome._listeners.onMessage[0];
    return new Promise((resolve) => listener(message, {}, resolve));
}

async function main() {
    // 1. 探测 + 拿到真实模型 id
    const probe = await (await fetch(`http://127.0.0.1:${PORT}/v1/models`)).json();
    const modelId = probe.data[0].id;
    console.log(`真实模型: ${modelId}`);

    const sb = loadBackground();
    await sendMessage(sb, { type: 'SAVE_SETTINGS', settings: {
        provider: 'openai',
        openaiUrl: `http://127.0.0.1:${PORT}`,
        selectedModel: modelId,
        cacheMode: 'session',
        temperature: 0.3,
        maxConcurrentRequests: 1
    } });

    const texts = [
        { id: 10, text: 'The quick brown fox jumps over the lazy dog near the riverbank at dawn.' },
        { id: 11, text: 'Machine translation has improved significantly with large language models.' },
        { id: 12, text: 'Please rotate your tires every 8,000 kilometers.' }
    ];

    console.log('\n[批量翻译：英 -> 中（含 JSON Schema 约束）]');
    const t0 = Date.now();
    const r = await sendMessage(sb, { type: 'TRANSLATE', texts, targetLanguage: 'zh', sourceLanguage: 'en' });
    const dt = ((Date.now() - t0) / 1000).toFixed(1);
    check('无错误', !r.error, r.error);

    const ok = (r.translations || []).filter(t => !t.error && t.text);
    check(`3 条全部返回译文（${dt}s）`, ok.length === 3, JSON.stringify(r.translations));
    for (const t of ok) {
        console.log(`    id=${t.id}: ${t.text}`);
        check(`id=${t.id} 译文含 CJK 字符`, /[\u4e00-\u9fff]/.test(t.text), t.text);
        check(`id=${t.id} 译文不是原文回显`, t.text.trim() !== texts.find(x => x.id === t.id).text);
        check(`id=${t.id} 无结构泄漏`, !/\btranslations\b|```/.test(t.text));
    }

    console.log('\n[缓存命中：同文本第二轮]');
    const t1 = Date.now();
    const r2 = await sendMessage(sb, { type: 'TRANSLATE', texts, targetLanguage: 'zh', sourceLanguage: 'en' });
    const dt2 = ((Date.now() - t1) / 1000).toFixed(2);
    check(`全部来自缓存（${dt2}s）`, r2.fromCache === 3, JSON.stringify(r2));

    console.log('\n[逐条兜底路径（单条纯文本）]');
    const t2 = Date.now();
    const r3 = await sendMessage(sb, {
        type: 'TRANSLATE',
        texts: [{ id: 99, text: 'To be, or not to be, that is the question.' }],
        targetLanguage: 'zh',
        sourceLanguage: 'en'
    });
    const dt3 = ((Date.now() - t2) / 1000).toFixed(1);
    const single = (r3.translations || [])[0];
    check(`单条翻译成功（${dt3}s）`, single && !single.error && /[\u4e00-\u9fff]/.test(single.text || ''), JSON.stringify(single));
    if (single) console.log(`    ${single.text}`);

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('测试崩溃:', e); process.exit(1); });
