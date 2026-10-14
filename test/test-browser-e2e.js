/**
 * 真实 Chromium 全链路验证（Edge，支持 --load-extension）：
 *   1. 起静态服务器供英文测试页
 *   2. 以 --load-extension 启动独立 Edge（临时 profile + CDP 19222）
 *   3. 按扩展名"Local LLM Translator"找到我们的 service worker，
 *      并用其真实执行上下文（executionContextCreated 的 contextId）执行
 *      chrome.* 调用 —— CDP 默认上下文看不到扩展 API 绑定
 *   4. 在 SW 上下文里配置设置、注入 content script、发 START_TRANSLATION
 *   5. 轮询测试页 [data-translated] / .llmt-bilingual，验证替换/双语两模式 + 还原
 * 前置：llama-server 在 18090 运行。
 * 运行：node test/test-browser-e2e.js
 */
const fs = require('fs');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const os = require('os');

const ROOT = path.join(__dirname, '..');
const PAGE_PORT = 18191;
const CDP_PORT = 19222;
const BROWSER = 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe';

const TEST_PAGE = `<!DOCTYPE html>
<html lang="en">
<head><meta charset="UTF-8"><title>E2E Test</title></head>
<body>
  <main>
    <h1>Local LLM Translator End-to-End Test</h1>
    <p id="p1">The quick brown fox jumps over the lazy dog near the riverbank at dawn.</p>
    <p id="p2">Machine translation quality has improved significantly with large language models.</p>
    <p id="p3">Please rotate your tires every 8,000 kilometers to ensure even wear.</p>
  </main>
  <nav><a href="#">Home</a> <a href="#">About</a></nav>
</body>
</html>`;

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  [PASS] ${name}`); }
    else { failed++; console.error(`  [FAIL] ${name}${detail ? ' — ' + String(detail).substring(0, 300) : ''}`); }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function getJson(url) {
    const r = await fetch(url);
    return r.json();
}

// 极简 CDP 客户端（Node 22 内置 WebSocket）
class Cdp {
    constructor(ws) {
        this.ws = ws; this.id = 0; this.pending = new Map(); this.events = [];
        this.ctxId = undefined;
        this.ws.addEventListener('message', (ev) => {
            const msg = JSON.parse(ev.data);
            if (msg.id && this.pending.has(msg.id)) {
                this.pending.get(msg.id)(msg);
                this.pending.delete(msg.id);
            } else if (msg.method === 'Runtime.executionContextCreated') {
                if (this.ctxId === undefined) this.ctxId = msg.params.context.id;
            }
        });
    }
    static async connect(wsUrl) {
        const ws = new WebSocket(wsUrl);
        await new Promise((res, rej) => {
            ws.addEventListener('open', res);
            ws.addEventListener('error', rej);
        });
        return new Cdp(ws);
    }
    send(method, params = {}) {
        const id = ++this.id;
        return new Promise((resolve) => {
            this.pending.set(id, resolve);
            this.ws.send(JSON.stringify({ id, method, params }));
        });
    }
    async evaluate(expression, awaitPromise = false) {
        await this.send('Runtime.enable');
        const params = { expression, awaitPromise, returnByValue: true };
        if (this.ctxId !== undefined) params.contextId = this.ctxId;
        const r = await this.send('Runtime.evaluate', params);
        const res = r.result;
        if (res && res.exceptionDetails) {
            throw new Error(JSON.stringify(res.exceptionDetails).substring(0, 400));
        }
        return res ? res.result : undefined;
    }
}

async function waitFor(fn, timeoutMs, label) {
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
        const v = await fn();
        if (v) return v;
        await sleep(500);
    }
    throw new Error('timeout: ' + label);
}

async function findOurExtension(cdpPort) {
    // 遍历 service_worker 目标，按 manifest 名字找到我们的扩展
    const list = await getJson(`http://127.0.0.1:${cdpPort}/json/list`);
    const sws = list.filter(t => t.type === 'service_worker');
    for (const sw of sws) {
        try {
            const c = await Cdp.connect(sw.webSocketDebuggerUrl);
            const name = await c.evaluate('chrome && chrome.runtime ? chrome.runtime.getManifest().name : ""');
            if (name && name.value === 'Local LLM Translator') return { sw, cdp: c, extId: new URL(sw.url).host };
        } catch (e) { /* 其他 SW 连不上/无 API，跳过 */ }
    }
    return null;
}

async function main() {
    // ---- 1. 静态页服务器
    const server = http.createServer((req, res) => {
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(TEST_PAGE);
    });
    await new Promise(r => server.listen(PAGE_PORT, '127.0.0.1', r));

    // ---- 2. 启动浏览器
    const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'llmt-e2e-'));
    const browserProc = spawn(BROWSER, [
        `--user-data-dir=${profileDir}`,
        `--remote-debugging-port=${CDP_PORT}`,
        `--load-extension=${ROOT}`,
        '--no-first-run', '--no-default-browser-check', '--no-experiments',
        '--window-size=1280,900',
        `http://127.0.0.1:${PAGE_PORT}/`
    ], { stdio: 'ignore' });
    console.log('browser PID:', browserProc.pid);

    try {
        await waitFor(async () => {
            try { return await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`); }
            catch (e) { return null; }
        }, 30000, 'CDP port');
        const version = await getJson(`http://127.0.0.1:${CDP_PORT}/json/version`);
        console.log('browser:', version.Browser);

        // ---- 3. 找到扩展 SW
        const ours = await waitFor(() => findOurExtension(CDP_PORT), 30000, 'extension service worker');
        const swCdp = ours.cdp;
        console.log('extension loaded:', ours.extId);

        const apis = await swCdp.evaluate('typeof chrome.storage + "/" + typeof chrome.scripting + "/" + typeof chrome.tabs');
        check('SW 上下文具备 storage/scripting/tabs API', apis.value === 'object/object/object', apis.value);
        if (apis.value !== 'object/object/object') throw new Error('扩展 API 缺失: ' + apis.value);

        const testPage = await waitFor(async () => {
            const list = await getJson(`http://127.0.0.1:${CDP_PORT}/json/list`);
            return list.find(t => t.type === 'page' && t.url.includes(`127.0.0.1:${PAGE_PORT}`));
        }, 20000, 'test page');
        const pageCdp = await Cdp.connect(testPage.webSocketDebuggerUrl);
        console.log('test page connected:', testPage.url);

        // ---- 4. 配置设置（直接写 storage；background 的 storage.onChanged 会失效缓存）
        const model = await swCdp.evaluate(`(async () => {
            const models = await (await fetch('http://127.0.0.1:18090/v1/models')).json();
            const id = models.data[0].id;
            await chrome.storage.local.set({ settings: {
                provider: 'openai',
                openaiUrl: 'http://127.0.0.1:18090',
                selectedModel: id,
                targetLanguage: 'zh',
                displayMode: 'replace',
                cacheMode: 'session',
                maxConcurrentRequests: 1
            }});
            return id;
        })()`, true);
        console.log('model configured:', model.value);

        // ---- 5. 替换模式：注入 + 翻译
        await swCdp.evaluate(`(async () => {
            const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${PAGE_PORT}/*' });
            await chrome.scripting.executeScript({
                target: { tabId: tab.id },
                files: ['textutils.js', 'content.js']
            });
            await new Promise(r => setTimeout(r, 400));
            await chrome.tabs.sendMessage(tab.id, {
                type: 'START_TRANSLATION',
                targetLanguage: 'zh',
                sourceLanguage: 'en'
            });
            return 'started';
        })()`, true);
        console.log('translation started (replace mode)');

        const translatedCount = await waitFor(async () => {
            const r = await pageCdp.evaluate(`document.querySelectorAll('[data-translated="true"]').length`);
            return r.value >= 3 ? r.value : null;
        }, 180000, 'replace-mode paragraphs');
        console.log('translated elements:', translatedCount);
        check('页面段落被翻译（>=3）', translatedCount >= 3, String(translatedCount));

        const p1 = await pageCdp.evaluate(`document.getElementById('p1').textContent`);
        console.log('p1:', p1.value);
        check('p1 含中文', /[\u4e00-\u9fff]/.test(p1.value), p1.value);
        check('p1 不再是英文原文', !/^The quick brown fox/.test(p1.value.trim()), p1.value);

        const widget = await pageCdp.evaluate(`!!document.getElementById('llmt-widget')`);
        check('进度组件已挂载', widget.value === true);

        // ---- 6. 还原
        await swCdp.evaluate(`(async () => {
            const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${PAGE_PORT}/*' });
            await chrome.tabs.sendMessage(tab.id, { type: 'RESTORE_ORIGINAL' });
        })()`, true);
        await sleep(800);
        const p1restored = await pageCdp.evaluate(`document.getElementById('p1').textContent`);
        check('还原后恢复原文', /^The quick brown fox/.test(p1restored.value.trim()), p1restored.value);

        // ---- 7. 双语对照模式
        await swCdp.evaluate(`(async () => {
            const s = (await chrome.storage.local.get('settings')).settings || {};
            s.displayMode = 'bilingual';
            await chrome.storage.local.set({ settings: s });
            const [tab] = await chrome.tabs.query({ url: 'http://127.0.0.1:${PAGE_PORT}/*' });
            await chrome.tabs.sendMessage(tab.id, {
                type: 'START_TRANSLATION',
                targetLanguage: 'zh',
                sourceLanguage: 'en'
            });
        })()`, true);
        const bilingualCount = await waitFor(async () => {
            const r = await pageCdp.evaluate(`document.querySelectorAll('p.llmt-bilingual').length`);
            return r.value >= 3 ? r.value : null;
        }, 180000, 'bilingual paragraphs');
        console.log('bilingual paragraphs:', bilingualCount);
        check('双语模式插入译文段（>=3）', bilingualCount >= 3, String(bilingualCount));
        const bi1 = await pageCdp.evaluate(`(document.querySelector('p.llmt-bilingual')||{}).textContent`);
        console.log('first bilingual:', bi1.value);
        check('对照译文含中文', /[\u4e00-\u9fff]/.test(bi1.value || ''), bi1.value);
        const p1kept = await pageCdp.evaluate(`document.getElementById('p1').textContent`);
        check('双语模式保留原文', /^The quick brown fox/.test(p1kept.value.trim()), p1kept.value);

        // 截图留档
        await pageCdp.send('Page.enable');
        const shot = await pageCdp.send('Page.captureScreenshot', { format: 'png' });
        const outPath = path.join(ROOT, 'test', 'screenshot-bilingual.png');
        fs.writeFileSync(outPath, Buffer.from(shot.result.data, 'base64'));
        console.log('screenshot saved:', outPath);

    } finally {
        browserProc.kill();
        server.close();
        await sleep(1000);
        try { fs.rmSync(profileDir, { recursive: true, force: true }); } catch (e) { /* Windows 文件锁，留给临时目录清理 */ }
    }

    console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
    process.exit(failed > 0 ? 1 : 0);
}

main().catch(e => { console.error('E2E 崩溃:', e.message); process.exit(1); });
