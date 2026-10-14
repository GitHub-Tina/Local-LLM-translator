/**
 * background.js 沙箱端到端测试：模拟 chrome.* API + 真实 fetch 打到 mock-server。
 * 覆盖：模型列表、正常翻译、散文包裹解析、重试、丢条兜底、schema 降级、缓存去重。
 * 运行：node test/test-background.js （自动拉起/关闭 mock-server 子进程）
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------------------------------------------------------------- 沙箱设施

function makeChromeStub() {
    const listeners = { onMessage: [], onConnect: [], onStartup: [], onInstalled: [], contextClicked: [] };
    const store = { settings: undefined };
    return {
        _listeners: listeners,
        _store: store,
        storage: {
            onChanged: { addListener: () => {} },
            local: {
                get: async (keys) => {
                    const out = {};
                    for (const k of [].concat(keys)) if (store[k] !== undefined) out[k] = store[k];
                    return out;
                },
                set: async (obj) => { Object.assign(store, obj); },
                remove: async (keys) => { for (const k of [].concat(keys)) delete store[k]; }
            }
        },
        runtime: {
            onMessage: { addListener: (fn) => listeners.onMessage.push(fn) },
            onConnect: { addListener: (fn) => listeners.onConnect.push(fn) },
            onStartup: { addListener: (fn) => listeners.onStartup.push(fn) },
            onInstalled: { addListener: (fn) => listeners.onInstalled.push(fn) },
            sendMessage: async () => { throw new Error('not used'); },
            connect: () => ({ onDisconnect: { addListener() {} }, onMessage: { addListener() {} }, postMessage() {}, disconnect() {} }),
            lastError: null
        },
        contextMenus: {
            create: () => {},
            onClicked: { addListener: (fn) => listeners.contextClicked.push(fn) }
        },
        tabs: { sendMessage: async () => { throw new Error('no tab'); } },
        scripting: {
            registerContentScripts: async () => {},
            unregisterContentScripts: async () => {},
            executeScript: async () => []
        }
    };
}

function loadBackground() {
    const sandbox = {};
    const importScripts = (...files) => {
        for (const f of files) {
            vm.runInContext(fs.readFileSync(path.join(ROOT, f), 'utf8'), sandbox, { filename: f });
        }
    };
    sandbox.chrome = makeChromeStub();
    Object.assign(sandbox, {
        console, URL, fetch: (...a) => fetch(...a), AbortController, setTimeout, clearTimeout,
        importScripts
    });
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    // background.js 顶部自带 importScripts，由它加载依赖
    vm.runInContext(fs.readFileSync(path.join(ROOT, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
    return sandbox;
}

async function sendMessage(sandbox, message) {
    const listener = sandbox.chrome._listeners.onMessage[0];
    return new Promise((resolve) => {
        listener(message, {}, resolve);
    });
}

async function waitInstalled(sandbox) {
    const fn = sandbox.chrome._listeners.onInstalled[0];
    await fn();
}

// ---------------------------------------------------------------- mock 服务器管理

async function startMock(mode, port) {
    const proc = spawn(process.execPath, [path.join(__dirname, 'mock-server.mjs')], {
        env: { ...process.env, MODE: mode, PORT: String(port) },
        stdio: ['ignore', 'pipe', 'pipe']
    });
    // 等待端口就绪
    for (let i = 0; i < 50; i++) {
        try {
            const r = await fetch(`http://127.0.0.1:${port}/v1/models`);
            if (r.ok) return proc;
        } catch (e) { /* retry */ }
        await sleep(100);
    }
    throw new Error('mock server 未就绪');
}

function stopMock(proc) {
    return new Promise((resolve) => {
        proc.on('exit', resolve);
        proc.kill();
    });
}

// ---------------------------------------------------------------- 测试用例

const TEXTS = [
    { id: 1, text: 'The quick brown fox.' },
    { id: 2, text: 'Jumps over the lazy dog.' },
    { id: 3, text: 'Hello world.' }
];

async function runTests() {
    const PORT = 18190 + Math.floor(Math.random() * 100);

    console.log('\n[模型列表与探测]');
    {
        const proc = await startMock('ok', PORT);
        try {
            const sb = loadBackground();
            // 先把 mock 地址写入设置（默认指向 8080，探测不到）
            await sendMessage(sb, { type: 'SAVE_SETTINGS', settings: {
                provider: 'auto',
                openaiUrl: `http://127.0.0.1:${PORT}`
            } });
            await waitInstalled(sb); // 触发 onInstalled（右键菜单 + 自动选模型）

            const models = await sendMessage(sb, { type: 'LIST_MODELS' });
            check('列出模型', models.models.length === 2, JSON.stringify(models));

            const det = await sendMessage(sb, { type: 'DETECT_PROVIDERS' });
            check('探测 OpenAI 兼容后端在线', det.openai === true, JSON.stringify(det));

            const settingsAfterInstall = sb.chrome._store.settings || {};
            check('安装时自动选择模型', settingsAfterInstall.selectedModel === 'qwen2.5:7b-instruct', JSON.stringify(settingsAfterInstall));
        } finally {
            await stopMock(proc);
        }
    }

    for (const mode of ['ok', 'prose', 'flaky', 'missing', 'rejectschema']) {
        console.log(`\n[翻译管线 MODE=${mode}]`);
        const proc = await startMock(mode, PORT);
        try {
            const sb = loadBackground();
            await sendMessage(sb, { type: 'SAVE_SETTINGS', settings: {
                provider: 'openai',
                openaiUrl: `http://127.0.0.1:${PORT}`,
                selectedModel: 'test-model',
                cacheMode: 'off',          // 每种模式独立验证推理路径
                plainTextFallback: true,
                maxOutputRetries: 2
            } });

            const r = await sendMessage(sb, {
                type: 'TRANSLATE',
                texts: TEXTS.map(t => ({ ...t })),
                targetLanguage: 'zh',
                sourceLanguage: 'en'
            });
            check('无错误返回', !r.error, JSON.stringify(r).substring(0, 200));
            const ok = (r.translations || []).filter(t => !t.error);
            check(`全部 3 条有译文（实际 ${ok.length}）`, ok.length === 3, JSON.stringify(r.translations));
            check('译文带 mock 前缀且对应正确', ok.length === 3 &&
                ok.find(t => t.id === 1).text === '【译】The quick brown fox.', JSON.stringify(ok));
        } finally {
            await stopMock(proc);
        }
    }

    console.log('\n[缓存与去重]');
    {
        const proc = await startMock('ok', PORT);
        try {
            const sb = loadBackground();
            await sendMessage(sb, { type: 'SAVE_SETTINGS', settings: {
                provider: 'openai',
                openaiUrl: `http://127.0.0.1:${PORT}`,
                selectedModel: 'test-model',
                cacheMode: 'session'
            } });

            const r1 = await sendMessage(sb, { type: 'TRANSLATE', texts: TEXTS.map(t => ({ ...t })), targetLanguage: 'zh', sourceLanguage: 'en' });
            check('首轮全部翻译', r1.translations.filter(t => !t.error).length === 3);

            // 第二轮：相同文本应全部来自内存缓存
            const r2 = await sendMessage(sb, { type: 'TRANSLATE', texts: TEXTS.map(t => ({ ...t })), targetLanguage: 'zh', sourceLanguage: 'en' });
            check('第二轮全部缓存命中', r2.fromCache === 3, JSON.stringify(r2));

            const cnt = await sendMessage(sb, { type: 'CACHE_COUNT' });
            check('缓存计数 >= 3', cnt.count >= 3, JSON.stringify(cnt));

            const clr = await sendMessage(sb, { type: 'CLEAR_CACHE' });
            check('清空缓存成功', clr.ok === true);
        } finally {
            await stopMock(proc);
        }
    }

    console.log('\n[设置校验]');
    {
        const sb = loadBackground();
        const r = await sendMessage(sb, { type: 'GET_SETTINGS' });
        check('GET_SETTINGS 返回默认设置', r.settings && r.settings.targetLanguage === 'zh' && r.settings.displayMode === 'replace');
        await sendMessage(sb, { type: 'SAVE_SETTINGS', settings: { targetLanguage: 'en' } });
        const r2 = await sendMessage(sb, { type: 'GET_SETTINGS' });
        check('SAVE_SETTINGS 生效', r2.settings.targetLanguage === 'en');
    }
}

runTests().then(() => {
    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exit(failed > 0 ? 1 : 0);
}).catch(e => {
    console.error('测试崩溃:', e);
    process.exit(1);
});
