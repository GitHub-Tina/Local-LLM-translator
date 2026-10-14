/**
 * background.js — Local LLM Translator 服务工作者。
 * 负责：设置存取、后端探测与模型列表、批量翻译管线、消息路由、右键菜单、
 * 自动翻译所需的 content script 动态注册。
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

if (typeof importScripts === 'function') {
    importScripts('textutils.js', 'languages.js', 'cache.js');
}

// ============================================================================
// 设置
// ============================================================================

const DEFAULT_SETTINGS = {
    provider: 'auto',            // 'auto' | 'ollama' | 'openai'（OpenAI 兼容：llama.cpp / LM Studio / vLLM…）
    ollamaUrl: 'http://127.0.0.1:11434',
    openaiUrl: 'http://127.0.0.1:8080', // llama.cpp 默认；LM Studio 用预设按钮切到 1234
    selectedModel: '',
    targetLanguage: 'zh',
    sourceLanguage: 'auto',       // 'auto' = 从页面 lang 属性检测
    displayMode: 'replace',       // 'replace' 原位替换 | 'bilingual' 段落对照
    maxItemsPerBatch: 8,
    maxCharsPerBatch: 1200,
    maxConcurrentRequests: 3,
    temperature: 0.3,
    useStructuredOutput: true,    // 尽量用 JSON Schema 约束输出
    maxOutputRetries: 2,
    plainTextFallback: true,      // 批量失败后逐条纯文本兜底
    customPrompts: {},            // 按格式的 { system, user } 覆盖
    requestFormat: 'auto',        // 'auto' | 'default' | 'simple' | 'translategemma' | 'hunyuan'
    numCtx: 0,                    // Ollama 上下文窗口（0 = 模型默认）
    cacheMode: 'session',         // 'off' | 'session' | 'persistent'
    autoTranslateNewContent: true,// 首次翻译后自动翻译动态新增内容
    autoTranslatePages: false,    // 页面声明语言 ≠ 目标语言时自动翻译（需 <all_urls> 权限）
    autoTranslateNeverLanguages: [],
    autoTranslateNeverSites: [],
    debug: false
};

let debugEnabled = false;
function debugLog(...args) { if (debugEnabled) console.log('[LLMT]', ...args); }
function debugWarn(...args) { if (debugEnabled) console.warn('[LLMT]', ...args); }

const PROMPT_TEMPLATES = {
    default: {
        system: `You are a professional translator. Translate the given texts into {{targetLanguage}}.
Respond ONLY with a JSON object in this exact format:
{"translations": [{"id": 0, "text": "translated text"}, {"id": 1, "text": "another translation"}]}
Keep each translation concise and natural. Preserve the original meaning, tone, numbers and proper nouns. Do not merge, split, add or drop items.`,
        user: `Translate the following texts into {{targetLanguage}}:\n{{texts}}`
    },
    simple: {
        system: `You are a translator. Translate into {{targetLanguage}}. Output JSON only:\n{"translations": [{"id": N, "text": "translation"}]}`,
        user: `Translate into {{targetLanguage}}:\n{{texts}}`
    },
    translategemma: {
        // TranslateGemma 官方提示词格式，勿改
        system: '',
        user: `You are a professional {{sourceLang}} ({{sourceCode}}) to {{targetLang}} ({{targetCode}}) translator. Your goal is to accurately convey the meaning and nuances of the original {{sourceLang}} text while adhering to {{targetLang}} grammar, vocabulary, and cultural sensitivities.
Produce only the {{targetLang}} translation, without any additional explanations or commentary. Please translate the following {{sourceLang}} text into {{targetLang}}:


{{texts}}`
    },
    hunyuan: {
        system: '',
        user: `Translate the following segment into {{targetLanguage}}, without additional explanation.\n{{texts}}`
    }
};

const TRANSLATION_JSON_SCHEMA = {
    "type": "object",
    "properties": {
        "translations": {
            "type": "array",
            "items": {
                "type": "object",
                "properties": {
                    "id": { "type": "integer" },
                    "text": { "type": "string" }
                },
                "required": ["id", "text"],
                "additionalProperties": false
            }
        }
    },
    "required": ["translations"],
    "additionalProperties": false
};

let cachedModels = null;
let modelsCacheTime = 0;
const MODEL_CACHE_TTL = 60000;

let cachedSettings = null;

async function loadSettings() {
    try {
        const result = await browserAPI.storage.local.get('settings');
        cachedSettings = { ...DEFAULT_SETTINGS, ...(result.settings || {}) };
        debugEnabled = !!cachedSettings.debug;
        return cachedSettings;
    } catch (e) {
        console.error('读取设置失败:', e);
        cachedSettings = { ...DEFAULT_SETTINGS };
        return cachedSettings;
    }
}

async function saveSettings(partial) {
    cachedSettings = { ...DEFAULT_SETTINGS, ...cachedSettings, ...partial };
    debugEnabled = !!cachedSettings.debug;
    await browserAPI.storage.local.set({ settings: cachedSettings });
    return cachedSettings;
}

async function getSettings() {
    if (!cachedSettings) return loadSettings();
    return cachedSettings;
}

// storage 被其他途径（扩展页、未来功能）直接写入时失效内存缓存，避免读到旧设置
browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.settings) {
        cachedSettings = null;
    }
});

// ============================================================================
// content script 动态注册（自动翻译 / 需要常驻的能力）
// ============================================================================

const CONTENT_SCRIPT_ID = 'llm-translator-content';

function needsContentScript(settings) {
    return !!(settings && settings.autoTranslatePages);
}

async function syncContentScriptRegistration() {
    const settings = await getSettings();
    if (needsContentScript(settings)) {
        try {
            await browserAPI.scripting.registerContentScripts([{
                id: CONTENT_SCRIPT_ID,
                matches: ['http://*/*', 'https://*/*'],
                js: ['textutils.js', 'content.js'],
                runAt: 'document_idle'
            }]);
        } catch (e) { /* 已注册，非错误 */ }
        return true;
    }
    try {
        await browserAPI.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
    } catch (e) { /* 未注册，非错误 */ }
    return false;
}

// ============================================================================
// 后端探测与模型列表
// ============================================================================

async function probeProvider(url) {
    try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 2000);
        const response = await fetch(url, { method: 'GET', signal: controller.signal });
        clearTimeout(timeout);
        return { ok: response.ok, blocked: false };
    } catch (e) {
        // 常规 fetch 失败：可能是 CORS 挡了响应。no-cors 探测拿到不透明响应即说明端口活着。
        try {
            const controller2 = new AbortController();
            const timeout2 = setTimeout(() => controller2.abort(), 2000);
            await fetch(url, { method: 'GET', mode: 'no-cors', signal: controller2.signal });
            clearTimeout(timeout2);
            return { ok: false, blocked: true };
        } catch (e2) {
            return { ok: false, blocked: false };
        }
    }
}

async function detectProviders(ollamaUrl, openaiUrl, provider = 'auto') {
    ollamaUrl = normalizeServerUrl(ollamaUrl);
    openaiUrl = normalizeServerUrl(openaiUrl);
    const skipped = { ok: false, blocked: false };
    const [ollama, openai] = await Promise.all([
        (provider === 'ollama' || provider === 'auto') ? probeProvider(`${ollamaUrl}/api/tags`) : skipped,
        (provider === 'openai' || provider === 'auto') ? probeProvider(`${openaiUrl}/v1/models`) : skipped
    ]);
    return {
        ollama: ollama.ok, ollama_blocked: ollama.blocked,
        openai: openai.ok, openai_blocked: openai.blocked
    };
}

async function listOllamaModels(url) {
    url = normalizeServerUrl(url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${url}/api/tags`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`Ollama 模型列表请求失败 (${response.status})`);
        const data = await response.json();
        return (data.models || []).map(m => ({ id: m.name, name: m.name, provider: 'ollama' }));
    } finally { clearTimeout(timeoutId); }
}

async function listOpenAIModels(url) {
    url = normalizeServerUrl(url);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 5000);
    try {
        const response = await fetch(`${url}/v1/models`, { signal: controller.signal });
        clearTimeout(timeoutId);
        if (!response.ok) throw new Error(`OpenAI 兼容后端模型列表请求失败 (${response.status})`);
        const data = await response.json();
        return (data.data || []).map(m => ({ id: m.id, name: m.id, provider: 'openai' }));
    } finally { clearTimeout(timeoutId); }
}

async function listModels(settings, useCache = true) {
    if (useCache && cachedModels && (Date.now() - modelsCacheTime < MODEL_CACHE_TTL)) {
        return cachedModels;
    }
    const models = [];
    const provider = settings.provider;
    // 并行查询；只有显式选定某后端时，该后端的失败才向外抛
    const [ollamaResult, openaiResult] = await Promise.allSettled([
        (provider === 'ollama' || provider === 'auto') ? listOllamaModels(settings.ollamaUrl) : Promise.resolve([]),
        (provider === 'openai' || provider === 'auto') ? listOpenAIModels(settings.openaiUrl) : Promise.resolve([])
    ]);
    if (ollamaResult.status === 'fulfilled') models.push(...ollamaResult.value);
    else if (provider === 'ollama') throw ollamaResult.reason;
    if (openaiResult.status === 'fulfilled') models.push(...openaiResult.value);
    else if (provider === 'openai') throw openaiResult.reason;

    cachedModels = models;
    modelsCacheTime = Date.now();
    return models;
}

async function detectModelProvider(modelId, settings) {
    const models = await listModels(settings, true);
    const model = models.find(m => m.id === modelId);
    return model ? model.provider : null;
}

// ============================================================================
// 翻译调用
// ============================================================================

async function callOllama(settings, modelId, systemPrompt, userPrompt, jsonOutput) {
    const body = {
        model: modelId,
        stream: false,
        prompt: systemPrompt ? `${systemPrompt}\n\n${userPrompt}` : userPrompt,
        keep_alive: '30m'
    };
    if (jsonOutput) body.format = TRANSLATION_JSON_SCHEMA; // 传完整 schema，Ollama 会约束形状
    body.options = {};
    if (settings.temperature !== undefined) body.options.temperature = settings.temperature;
    if (settings.numCtx) body.options.num_ctx = settings.numCtx;

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${normalizeServerUrl(settings.ollamaUrl)}/api/generate`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('Ollama 请求超时（5 分钟）');
        throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        if (response.status === 403) throw new Error('Ollama 返回 403：请设置 OLLAMA_ORIGINS 允许扩展访问（见 README）');
        const error = await response.text();
        throw new Error(`Ollama 错误 (${response.status}): ${error || '(空响应)'}`);
    }

    const data = await response.json();
    debugLog(`callOllama: 响应长度=${(data.response || '').length} done_reason=${data.done_reason || 'unknown'}`);
    return { content: data.response, finishReason: data.done_reason || null };
}

async function callOpenAI(settings, modelId, systemPrompt, userPrompt, jsonOutput) {
    const messages = [];
    if (systemPrompt) messages.push({ role: 'system', content: systemPrompt });
    messages.push({ role: 'user', content: userPrompt });

    const body = {
        model: modelId,
        messages,
        temperature: settings.temperature === undefined ? 0.3 : settings.temperature,
        stream: false
    };
    if (jsonOutput) {
        body.response_format = {
            type: 'json_schema',
            json_schema: { name: 'translation_response', strict: true, schema: TRANSLATION_JSON_SCHEMA }
        };
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 300000);
    let response;
    try {
        response = await fetch(`${normalizeServerUrl(settings.openaiUrl)}/v1/chat/completions`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: controller.signal
        });
    } catch (e) {
        clearTimeout(timeoutId);
        if (e.name === 'AbortError') throw new Error('请求超时（5 分钟）');
        if (e instanceof TypeError) throw new Error('无法连接 OpenAI 兼容后端：服务未启动或被 CORS 拦截（llama.cpp 加 --api-key 或检查端口）');
        throw e;
    }
    clearTimeout(timeoutId);

    if (!response.ok) {
        const error = await response.text();
        // 老服务器（llama.cpp 2024 年中之前、旧 vLLM）不认 response_format -> 去掉重试一次
        if (jsonOutput && response.status === 400 && /response_format|json_schema|guided/i.test(error)) {
            debugWarn('服务器拒绝结构化输出，去掉 response_format 重试');
            return callOpenAI(settings, modelId, systemPrompt, userPrompt, false);
        }
        throw new Error(`后端错误 (${response.status}): ${error || '(空响应)'}`);
    }

    const data = await response.json();
    let content = (data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '';
    content = content.replace(/^```json\s*/, '').replace(/^```\s*/, '').replace(/\s*```$/, '');
    const finishReason = (data.choices && data.choices[0] && data.choices[0].finish_reason) || null;
    debugLog(`callOpenAI: finish_reason=${finishReason || 'unknown'}`);
    return { content, finishReason };
}

async function callProvider(provider, settings, modelId, systemPrompt, userPrompt, jsonOutput) {
    if (provider === 'ollama') return callOllama(settings, modelId, systemPrompt, userPrompt, jsonOutput);
    return callOpenAI(settings, modelId, systemPrompt, userPrompt, jsonOutput);
}

// 逐条纯文本翻译 —— 批量彻底失败时的最后兜底：整段响应即译文，无结构可解析错。
async function translatePlainItem(provider, settings, modelId, text, vars) {
    const systemPrompt = `You are a professional translator. Translate the user's text into ${vars.targetLanguage}. Output ONLY the translation, with no quotes, labels, JSON, or commentary.`;
    const { content } = await callProvider(provider, settings, modelId, systemPrompt, text, false);
    return cleanTranslationText((content || '').trim());
}

async function autoDetectAndSelectModel() {
    try {
        const settings = await getSettings();
        if (settings.selectedModel) return null;

        const models = await listModels(settings, false);
        if (models.length === 0) return null;

        const preferred = models.find(m => detectRequestFormat(m.id) !== 'default') || models[0];
        await saveSettings({ selectedModel: preferred.id, provider: preferred.provider });
        console.log(`[LLMT] 自动选择模型: ${preferred.id} (${preferred.provider})`);
        return preferred;
    } catch (e) {
        console.warn('[LLMT] 自动选模型失败:', e.message);
        return null;
    }
}

// ============================================================================
// 翻译主管线
// ============================================================================

async function translate(textItems, targetLanguage, settings) {
    const modelId = settings.selectedModel;
    if (!modelId) throw new Error('未选择模型');

    let provider = settings.provider;
    if (provider === 'auto') {
        provider = await detectModelProvider(modelId, settings);
        if (!provider) throw new Error('无法确定模型所属后端，请手动选择 Provider');
    }

    const format = resolveRequestFormat(settings, modelId);
    const isPlainText = PLAIN_TEXT_FORMATS.has(format);
    const template = PROMPT_TEMPLATES[format] || PROMPT_TEMPLATES.default;

    const override = settings.customPrompts && settings.customPrompts[format];
    const systemTemplate = (override && override.system) || template.system;
    const userTemplate = (override && override.user) || template.user;

    const targetLangName = getLanguageName(targetLanguage);
    const sourceLangCode = (settings.sourceLanguage && settings.sourceLanguage !== 'auto')
        ? settings.sourceLanguage : 'en';
    const baseVars = {
        targetLanguage: targetLangName,
        sourceLang: getLanguageName(sourceLangCode),
        sourceCode: sourceLangCode.toUpperCase(),
        targetLang: targetLangName,
        targetCode: String(targetLanguage).toUpperCase()
    };

    const wantJson = !!settings.useStructuredOutput && !isPlainText;

    // 一批子集请求 -> Map<originalId, 合格译文>（可疑/空结果丢弃）
    const requestBatch = async (items) => {
        const mappedItems = items.map((item, index) => ({ id: index, text: item.text, originalId: item.id }));
        const vars = { ...baseVars, texts: formatTextsForPrompt(mappedItems) };
        const systemPrompt = buildPrompt(systemTemplate, vars);
        const userPrompt = buildPrompt(userTemplate, vars);

        const { content: raw, finishReason } = await callProvider(provider, settings, modelId, systemPrompt, userPrompt, wantJson);
        debugLog('原始响应(前300字符):', (raw || '').substring(0, 300));

        const parsed = parseTranslationResponse(raw, mappedItems, finishReason);
        const good = new Map();
        for (const t of parsed) {
            if (t && t.text && !t.error && !isSuspiciousTranslation(t.text)) {
                const originalItem = mappedItems.find(m => m.id === t.id);
                if (originalItem) good.set(originalItem.originalId, t.text);
            }
        }
        return good;
    };

    // 单条请求：用该格式自己的模板、无编号标记 —— 结构上不可能对错行
    const requestOne = async (text) => {
        const vars = { ...baseVars, texts: text };
        const { content } = await callProvider(provider, settings, modelId,
            buildPrompt(systemTemplate, vars), buildPrompt(userTemplate, vars), false);
        return cleanTranslationText((content || '').trim());
    };

    const results = new Map(); // originalId -> 译文

    // ---- 缓存 + 去重：相同原文只翻一次 ----
    const cacheEnabled = settings.cacheMode !== 'off'
        && typeof cacheGetMany === 'function' && typeof cacheKey === 'function';
    const promptSig = hashString([
        format, wantJson ? 'json' : 'plain', String(settings.temperature),
        systemTemplate, userTemplate
    ].join('\u0000'));
    const keyFor = cacheEnabled
        ? (text) => cacheKey(modelId, sourceLangCode, targetLanguage, promptSig, text)
        : (text) => text;

    const groups = new Map(); // key -> { item(代表), ids(所有同文 originalId) }
    for (const item of textItems) {
        const k = keyFor(item.text);
        const g = groups.get(k);
        if (g) g.ids.push(item.id);
        else groups.set(k, { item, ids: [item.id] });
    }

    let cacheHitCount = 0, fromCacheItems = 0;
    let missGroups;
    if (cacheEnabled) {
        try {
            const keys = [...groups.values()].map(g => keyFor(g.item.text));
            const found = await cacheGetMany(keys);
            missGroups = [];
            for (const g of groups.values()) {
                const cached = found.get(keyFor(g.item.text));
                if (cached !== undefined) {
                    results.set(g.item.id, cached);
                    cacheHitCount++;
                    fromCacheItems += g.ids.length;
                } else {
                    missGroups.push(g);
                }
            }
        } catch (e) {
            debugWarn('缓存读取失败，全部直接翻译:', e && e.message);
            missGroups = [...groups.values()];
        }
    } else {
        missGroups = [...groups.values()];
    }
    debugLog(`缓存: ${cacheHitCount} 命中 / ${missGroups.length} 未命中 (${groups.size} 唯一 / ${textItems.length} 总计)`);

    let pending = missGroups.map(g => g.item);

    // ---- 批量请求 + 只重试缺失项 ----
    const maxRetries = Number.isInteger(settings.maxOutputRetries) ? settings.maxOutputRetries : 2;
    debugLog(`translate: provider=${provider} model=${modelId} format=${format} items=${textItems.length} json=${wantJson}`);
    for (let attempt = 0; attempt <= maxRetries && pending.length > 0; attempt++) {
        let good;
        try {
            good = await requestBatch(pending);
        } catch (e) {
            if (attempt === maxRetries) throw e;
            debugWarn(`第 ${attempt + 1} 次批量请求异常:`, e.message);
            continue;
        }
        for (const item of pending) {
            const text = good.get(item.id);
            if (text !== undefined) results.set(item.id, text);
        }
        pending = pending.filter(item => !results.has(item.id));
        if (pending.length) debugWarn(`${pending.length} 条缺失/畸形（第 ${attempt + 1} 次）`);
        // 多条目批一条都拿不到 = 响应无法对齐；重发相同输入只会复现失败，跳过重试走兜底
        if (good.size === 0 && pending.length > 1) {
            debugWarn('批量不可用，跳过剩余重试');
            break;
        }
    }

    // ---- 逐条纯文本兜底 ----
    if (pending.length > 0 && settings.plainTextFallback !== false) {
        debugWarn(`对 ${pending.length} 条执行逐条兜底`);
        for (const item of pending) {
            try {
                const text = isPlainText
                    ? await requestOne(item.text)
                    : await translatePlainItem(provider, settings, modelId, item.text, baseVars);
                if (text && !isSuspiciousTranslation(text)) results.set(item.id, text);
            } catch (e) {
                debugWarn(`逐条兜底失败 id=${item.id}:`, e.message);
            }
        }
    }

    // ---- 写缓存（await 保证 MV3 SW 不至于在 IndexedDB 提交前被回收）----
    if (cacheEnabled) {
        const entries = [];
        for (const g of missGroups) {
            if (results.has(g.item.id)) entries.push([keyFor(g.item.text), results.get(g.item.id)]);
        }
        if (entries.length) {
            try { await cacheSetMany(entries); }
            catch (e) { debugWarn('缓存写入失败:', e && e.message); }
        }
    }

    // 同文各组回填
    for (const g of groups.values()) {
        if (!results.has(g.item.id)) continue;
        const text = results.get(g.item.id);
        for (const id of g.ids) results.set(id, text);
    }

    const translations = textItems.map(item => results.has(item.id)
        ? { id: item.id, text: results.get(item.id) }
        : { id: item.id, error: 'translation failed' });
    return { translations, fromCache: fromCacheItems, total: textItems.length, cacheActive: cacheEnabled };
}

// ============================================================================
// 消息路由
// ============================================================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    (async () => {
        try {
            const settings = await getSettings();
            switch (message.type) {
                case 'GET_SETTINGS':
                    sendResponse({ settings });
                    break;

                case 'SAVE_SETTINGS': {
                    const saved = await saveSettings(message.settings);
                    sendResponse({ settings: saved });
                    break;
                }

                case 'DETECT_PROVIDERS': {
                    const providers = await detectProviders(settings.ollamaUrl, settings.openaiUrl, settings.provider);
                    sendResponse(providers);
                    break;
                }

                case 'LIST_MODELS': {
                    const models = await listModels(settings, !message.forceRefresh);
                    sendResponse({ models });
                    break;
                }

                case 'SYNC_CONTENT_SCRIPT': {
                    const registered = await syncContentScriptRegistration();
                    sendResponse({ ok: true, registered });
                    break;
                }

                case 'ADD_NEVER_SITE': {
                    const host = typeof message.hostname === 'string' ? message.hostname.trim().toLowerCase() : '';
                    if (!host) { sendResponse({ ok: false }); break; }
                    const sites = Array.isArray(settings.autoTranslateNeverSites) ? [...settings.autoTranslateNeverSites] : [];
                    if (!sites.includes(host)) sites.push(host);
                    await saveSettings({ autoTranslateNeverSites: sites });
                    sendResponse({ ok: true, sites });
                    break;
                }

                case 'REMOVE_NEVER_SITE': {
                    const host = typeof message.hostname === 'string' ? message.hostname.trim().toLowerCase() : '';
                    const sites = (Array.isArray(settings.autoTranslateNeverSites) ? settings.autoTranslateNeverSites : [])
                        .filter(s => s !== host);
                    await saveSettings({ autoTranslateNeverSites: sites });
                    sendResponse({ ok: true, sites });
                    break;
                }

                case 'TRANSLATE': {
                    let s = { ...settings, sourceLanguage: message.sourceLanguage || settings.sourceLanguage || 'auto' };
                    if (!s.selectedModel) {
                        await autoDetectAndSelectModel();
                        const refreshed = await getSettings();
                        s = { ...s, selectedModel: refreshed.selectedModel, provider: refreshed.provider };
                    }
                    const result = await translate(message.texts, message.targetLanguage, s);
                    sendResponse({
                        translations: result.translations,
                        fromCache: result.fromCache,
                        total: result.total,
                        cacheActive: result.cacheActive
                    });
                    break;
                }

                case 'CLEAR_CACHE':
                    try {
                        await cacheClear();
                        sendResponse({ ok: true });
                    } catch (e) {
                        sendResponse({ ok: false, error: e && e.message });
                    }
                    break;

                case 'CACHE_COUNT':
                    try {
                        sendResponse({ count: await cacheCount() });
                    } catch (e) {
                        sendResponse({ count: 0, error: e && e.message });
                    }
                    break;

                case 'PING':
                    sendResponse({ pong: true });
                    break;

                default:
                    sendResponse({ error: '未知消息类型' });
            }
        } catch (e) {
            console.error('[LLMT] 处理消息出错:', e);
            sendResponse({ error: e.message });
        }
    })();
    return true; // 保持异步响应通道
});

// 长翻译期间 content script 通过该端口心跳，防止 service worker 休眠
browserAPI.runtime.onConnect.addListener((port) => {
    if (port.name === 'keepalive') {
        port.onMessage.addListener(() => { /* ping 即保活 */ });
    }
});

// 浏览器启动：会话级缓存此时清空
browserAPI.runtime.onStartup.addListener(async () => {
    try {
        const settings = await getSettings();
        if (settings.cacheMode === 'session' && typeof cacheClear === 'function') {
            await cacheClear();
        }
    } catch (e) { /* 尽力而为 */ }
});

// ============================================================================
// 右键菜单
// ============================================================================

async function detectPageLanguageInTab(tabId) {
    try {
        const result = await browserAPI.scripting.executeScript({
            target: { tabId },
            func: () => {
                const htmlLang = document.documentElement.lang || document.querySelector('html')?.getAttribute('lang');
                if (htmlLang) return htmlLang.split('-')[0].toLowerCase();
                const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
                if (metaLang) return metaLang.split('-')[0].toLowerCase();
                return null;
            }
        });
        return (result && result[0] && result[0].result) || null;
    } catch (e) {
        return null;
    }
}

async function sendToTab(tabId, messageFactory) {
    try {
        await browserAPI.tabs.sendMessage(tabId, messageFactory());
    } catch (e) {
        // content script 未加载 —— 注入后重试
        await browserAPI.scripting.executeScript({
            target: { tabId },
            files: ['textutils.js', 'content.js']
        });
        await new Promise(resolve => setTimeout(resolve, 200));
        await browserAPI.tabs.sendMessage(tabId, messageFactory());
    }
}

browserAPI.runtime.onInstalled.addListener(async () => {
    browserAPI.contextMenus.create(
        { id: 'translate-page', title: '翻译整页（本地 LLM）', contexts: ['page'] },
        () => { if (browserAPI.runtime.lastError) { /* 重复创建忽略 */ } }
    );
    browserAPI.contextMenus.create(
        { id: 'translate-selection', title: '翻译选中文字（本地 LLM）', contexts: ['selection'] },
        () => { if (browserAPI.runtime.lastError) { /* 同上 */ } }
    );

    await autoDetectAndSelectModel();
    await syncContentScriptRegistration();
});

browserAPI.contextMenus.onClicked.addListener(async (info, tab) => {
    if (!tab || !tab.id) return;
    if (info.menuItemId !== 'translate-page' && info.menuItemId !== 'translate-selection') return;

    try {
        const settings = await getSettings();
        let sourceLang = settings.sourceLanguage;
        if (!sourceLang || sourceLang === 'auto') {
            sourceLang = await detectPageLanguageInTab(tab.id) || 'auto';
        }
        if (info.menuItemId === 'translate-page') {
            await sendToTab(tab.id, () => ({
                type: 'START_TRANSLATION',
                targetLanguage: settings.targetLanguage,
                sourceLanguage: sourceLang,
                displayMode: settings.displayMode,
                showStatus: true
            }));
        } else {
            await sendToTab(tab.id, () => ({
                type: 'TRANSLATE_SELECTION',
                targetLanguage: settings.targetLanguage,
                sourceLanguage: sourceLang,
                displayMode: settings.displayMode
            }));
        }
    } catch (e) {
        console.error('[LLMT] 右键翻译失败:', e);
    }
});

loadSettings().then(() => {
    console.log('[LLMT] Local LLM Translator background 已加载');
});
