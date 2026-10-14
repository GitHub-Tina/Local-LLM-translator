/**
 * options.js — 完整设置页。读写 storage 中的 settings，保存后通知 background。
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const $ = (id) => document.getElementById(id);

const DEFAULT_SYSTEM_PROMPT = `You are a professional translator. Translate the given texts into {{targetLanguage}}.
Respond ONLY with a JSON object in this exact format:
{"translations": [{"id": 0, "text": "translated text"}, {"id": 1, "text": "another translation"}]}
Keep each translation concise and natural. Preserve the original meaning, tone, numbers and proper nouns. Do not merge, split, add or drop items.`;

const DEFAULT_USER_PROMPT = `Translate the following texts into {{targetLanguage}}:\n{{texts}}`;

let settings = null;

async function load() {
    const r = await browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' }).catch(() => null);
    settings = (r && r.settings) || {};
    fillForm();
    refreshCacheCount();
}

function fillLanguageSelects() {
    // 目标语言：全部语言
    const targetSel = $('targetLanguage');
    targetSel.innerHTML = '';
    for (const code of getSortedLanguageCodes()) {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = `${LANGUAGES[code]} (${code})`;
        targetSel.appendChild(opt);
    }
    // 源语言：auto + 全部
    const sourceSel = $('sourceLanguage');
    const autoOpt = document.createElement('option');
    autoOpt.value = 'auto';
    autoOpt.textContent = '自动（按页面 lang 属性）';
    sourceSel.appendChild(autoOpt);
    for (const code of getSortedLanguageCodes()) {
        const opt = document.createElement('option');
        opt.value = code;
        opt.textContent = `${LANGUAGES[code]} (${code})`;
        sourceSel.appendChild(opt);
    }
}

function fillForm() {
    fillLanguageSelects();

    $('providerSelect').value = settings.provider || 'auto';
    $('requestFormat').value = settings.requestFormat || 'auto';
    $('ollamaUrl').value = settings.ollamaUrl || '';
    $('openaiUrl').value = settings.openaiUrl || '';
    $('numCtx').value = settings.numCtx || 0;

    $('targetLanguage').value = settings.targetLanguage || 'zh';
    $('sourceLanguage').value = settings.sourceLanguage || 'auto';
    $('displayMode').value = settings.displayMode || 'replace';
    $('temperature').value = settings.temperature === undefined ? 0.3 : settings.temperature;
    $('maxConcurrentRequests').value = settings.maxConcurrentRequests || 3;
    $('maxItemsPerBatch').value = settings.maxItemsPerBatch || 8;
    $('maxCharsPerBatch').value = settings.maxCharsPerBatch || 1200;
    $('maxOutputRetries').value = settings.maxOutputRetries === undefined ? 2 : settings.maxOutputRetries;

    $('useStructuredOutput').checked = settings.useStructuredOutput !== false;
    $('plainTextFallback').checked = settings.plainTextFallback !== false;
    $('autoTranslateNewContent').checked = settings.autoTranslateNewContent !== false;
    $('autoTranslatePages').checked = !!settings.autoTranslatePages;

    $('neverLanguages').value = (settings.autoTranslateNeverLanguages || []).join(', ');
    $('neverSites').value = (settings.autoTranslateNeverSites || []).join('\n');

    $('cacheMode').value = settings.cacheMode || 'session';
    $('debug').checked = !!settings.debug;

    const custom = (settings.customPrompts && settings.customPrompts.default) || {};
    $('systemPrompt').value = custom.system || '';
    $('userPrompt').value = custom.user || '';
}

function parseList(text) {
    return String(text || '')
        .split(/[,\n]/)
        .map(s => s.trim().toLowerCase())
        .filter(Boolean);
}

async function save() {
    let autoTranslatePages = $('autoTranslatePages').checked;
    // 打开自动翻译需要 <all_urls> 权限
    if (autoTranslatePages && !settings.autoTranslatePages) {
        const granted = await browserAPI.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
        if (!granted) {
            autoTranslatePages = false;
            $('autoTranslatePages').checked = false;
            alert('未授予「所有网站」权限，自动翻译保持关闭。');
        }
    }

    const customPrompts = { ...(settings.customPrompts || {}) };
    const sys = $('systemPrompt').value.trim();
    const usr = $('userPrompt').value.trim();
    if (sys || usr) {
        customPrompts.default = {
            system: sys || DEFAULT_SYSTEM_PROMPT,
            user: usr || DEFAULT_USER_PROMPT
        };
    } else {
        delete customPrompts.default;
    }

    const partial = {
        provider: $('providerSelect').value,
        requestFormat: $('requestFormat').value,
        ollamaUrl: $('ollamaUrl').value.trim() || 'http://127.0.0.1:11434',
        openaiUrl: $('openaiUrl').value.trim() || 'http://127.0.0.1:8080',
        numCtx: Math.max(0, parseInt($('numCtx').value, 10) || 0),

        targetLanguage: $('targetLanguage').value,
        sourceLanguage: $('sourceLanguage').value,
        displayMode: $('displayMode').value,
        temperature: Math.max(0, Math.min(2, parseFloat($('temperature').value) || 0.3)),
        maxConcurrentRequests: Math.max(1, Math.min(32, parseInt($('maxConcurrentRequests').value, 10) || 3)),
        maxItemsPerBatch: Math.max(1, Math.min(32, parseInt($('maxItemsPerBatch').value, 10) || 8)),
        maxCharsPerBatch: Math.max(200, Math.min(8000, parseInt($('maxCharsPerBatch').value, 10) || 1200)),
        maxOutputRetries: Math.max(0, Math.min(5, parseInt($('maxOutputRetries').value, 10) || 0)),

        useStructuredOutput: $('useStructuredOutput').checked,
        plainTextFallback: $('plainTextFallback').checked,
        autoTranslateNewContent: $('autoTranslateNewContent').checked,
        autoTranslatePages,

        autoTranslateNeverLanguages: parseList($('neverLanguages').value),
        autoTranslateNeverSites: parseList($('neverSites').value),

        cacheMode: $('cacheMode').value,
        debug: $('debug').checked,
        customPrompts
    };

    await ensureHostPermissions([partial.ollamaUrl, partial.openaiUrl]).catch(() => true);

    const r = await browserAPI.runtime.sendMessage({ type: 'SAVE_SETTINGS', settings: partial });
    if (r && r.settings) settings = r.settings;
    await browserAPI.runtime.sendMessage({ type: 'SYNC_CONTENT_SCRIPT' });

    const tip = $('savedTip');
    tip.hidden = false;
    setTimeout(() => { tip.hidden = true; }, 1800);
}

async function resetDefaults() {
    if (!confirm('确定恢复全部默认设置？（不会删除缓存）')) return;
    await browserAPI.storage.local.remove('settings');
    const r = await browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' });
    settings = (r && r.settings) || {};
    fillForm();
    const tip = $('savedTip');
    tip.hidden = false;
    setTimeout(() => { tip.hidden = true; }, 1800);
}

async function refreshCacheCount() {
    try {
        const r = await browserAPI.runtime.sendMessage({ type: 'CACHE_COUNT' });
        $('cacheCount').textContent = (r && typeof r.count === 'number') ? r.count : '…';
    } catch (e) {
        $('cacheCount').textContent = '…';
    }
}

$('saveBtn').addEventListener('click', save);
$('resetBtn').addEventListener('click', resetDefaults);
$('resetPrompts').addEventListener('click', () => {
    $('systemPrompt').value = '';
    $('userPrompt').value = '';
});
$('clearCache').addEventListener('click', async () => {
    const r = await browserAPI.runtime.sendMessage({ type: 'CLEAR_CACHE' });
    alert(r && r.ok ? '缓存已清空' : '清空失败');
    refreshCacheCount();
});

load();
