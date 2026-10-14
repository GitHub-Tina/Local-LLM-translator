/**
 * popup.js — 弹窗逻辑：模型/语言选择、翻译控制、快捷设置。
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

const $ = (id) => document.getElementById(id);

let settings = null;
let models = [];
let currentTab = null;
let toastTimer = null;

function showToast(message) {
    const el = $('toast');
    el.textContent = message;
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { el.hidden = true; }, 2200);
}

function send(msg) {
    return browserAPI.runtime.sendMessage(msg);
}

// ============================================================================
// 初始化
// ============================================================================

async function init() {
    const [tab] = await browserAPI.tabs.query({ active: true, currentWindow: true });
    currentTab = tab;

    const r = await send({ type: 'GET_SETTINGS' }).catch(() => null);
    settings = (r && r.settings) || {};

    renderSettings();
    await Promise.all([
        refreshProviderStatus(),
        loadModels(false),
        refreshCacheCount(),
        refreshTabStatus()
    ]);
}

function renderSettings() {
    // 目标语言
    $('langTriggerLabel').textContent = getLanguageName(settings.targetLanguage || 'zh');
    // 显示方式
    document.querySelectorAll('#displayModeSeg button').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === (settings.displayMode || 'replace'));
    });
    // 快捷设置
    $('providerSelect').value = settings.provider || 'auto';
    $('ollamaUrl').value = settings.ollamaUrl || '';
    $('openaiUrl').value = settings.openaiUrl || '';
    $('cacheMode').value = settings.cacheMode || 'session';
    $('autoTranslatePages').checked = !!settings.autoTranslatePages;
}

// ============================================================================
// 后端状态
// ============================================================================

async function refreshProviderStatus() {
    const dot = $('providerStatus');
    try {
        const r = await send({ type: 'DETECT_PROVIDERS' });
        const anyOk = r && (r.ollama || r.openai);
        const anyBlocked = r && (r.ollama_blocked || r.openai_blocked);
        if (anyOk) {
            dot.className = 'status-dot ok';
            dot.title = `后端在线：${[r.ollama ? 'Ollama' : '', r.openai ? 'OpenAI 兼容' : ''].filter(Boolean).join(' + ')}`;
        } else if (anyBlocked) {
            dot.className = 'status-dot warn';
            dot.title = '后端可达但可能被 CORS 拦截（Ollama 需设置 OLLAMA_ORIGINS）';
        } else {
            dot.className = 'status-dot err';
            dot.title = '未检测到后端：请启动 Ollama / llama.cpp / LM Studio';
        }
    } catch (e) {
        dot.className = 'status-dot err';
        dot.title = '后端检测失败';
    }
}

// ============================================================================
// 模型选择器
// ============================================================================

async function loadModels(forceRefresh) {
    const trigger = $('modelTrigger');
    trigger.disabled = true;
    $('modelTriggerLabel').textContent = '加载模型中…';
    try {
        const r = await send({ type: 'LIST_MODELS', forceRefresh });
        models = (r && r.models) || [];
    } catch (e) {
        models = [];
        $('modelTriggerLabel').textContent = '模型加载失败';
        return;
    } finally {
        trigger.disabled = false;
    }

    if (models.length === 0) {
        $('modelTriggerLabel').textContent = '未发现模型';
        $('translateBtn').disabled = true;
    } else {
        const selected = models.find(m => m.id === settings.selectedModel);
        if (selected) {
            $('modelTriggerLabel').textContent = selected.id;
        } else {
            // 没有有效选择时默认取第一个（含提供商），并保存
            const preferred = models.find(m => detectRequestFormat(m.id) !== 'default') || models[0];
            $('modelTriggerLabel').textContent = preferred.id;
            if (!settings.selectedModel) {
                settings.selectedModel = preferred.id;
                settings.provider = preferred.provider;
                await send({ type: 'SAVE_SETTINGS', settings: { selectedModel: preferred.id, provider: preferred.provider } });
            }
        }
        $('translateBtn').disabled = false;
    }
    renderModelList($('modelSearch').value);
}

function renderModelList(filter) {
    const list = $('modelList');
    list.innerHTML = '';
    const f = (filter || '').toLowerCase();
    const filtered = models.filter(m => !f || m.id.toLowerCase().includes(f));
    $('modelEmpty').hidden = filtered.length > 0;
    for (const m of filtered) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        if (m.id === settings.selectedModel) li.classList.add('selected');
        const name = document.createElement('span');
        name.textContent = m.id;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = m.provider === 'ollama' ? 'Ollama' : 'OpenAI';
        li.appendChild(name);
        li.appendChild(tag);
        li.addEventListener('click', async () => {
            settings.selectedModel = m.id;
            settings.provider = m.provider;
            await send({ type: 'SAVE_SETTINGS', settings: { selectedModel: m.id, provider: m.provider } });
            $('modelTriggerLabel').textContent = m.id;
            closeMenus();
            renderModelList(f);
        });
        list.appendChild(li);
    }
}

// ============================================================================
// 语言选择器
// ============================================================================

function renderLangList(filter) {
    const list = $('langList');
    list.innerHTML = '';
    const f = (filter || '').toLowerCase();
    const codes = getSortedLanguageCodes().filter(code => {
        if (!f) return true;
        const name = LANGUAGES[code] || '';
        return code.includes(f) || name.toLowerCase().includes(f);
    });
    for (const code of codes) {
        const li = document.createElement('li');
        li.setAttribute('role', 'option');
        if (code === (settings.targetLanguage || 'zh')) li.classList.add('selected');
        const name = document.createElement('span');
        name.textContent = LANGUAGES[code] || code;
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = code;
        li.appendChild(name);
        li.appendChild(tag);
        li.addEventListener('click', async () => {
            settings.targetLanguage = code;
            await send({ type: 'SAVE_SETTINGS', settings: { targetLanguage: code } });
            $('langTriggerLabel').textContent = LANGUAGES[code] || code;
            closeMenus();
            renderLangList(f);
        });
        list.appendChild(li);
    }
}

// ============================================================================
// 下拉开关
// ============================================================================

function closeMenus() {
    $('modelMenu').hidden = true;
    $('langMenu').hidden = true;
    $('modelTrigger').setAttribute('aria-expanded', 'false');
    $('langTrigger').setAttribute('aria-expanded', 'false');
}

function setupPicker(triggerId, menuId, searchId, onInput) {
    $(triggerId).addEventListener('click', (e) => {
        e.stopPropagation();
        const menu = $(menuId);
        const willOpen = menu.hidden;
        closeMenus();
        menu.hidden = !willOpen;
        $(triggerId).setAttribute('aria-expanded', String(willOpen));
        if (willOpen) {
            $(searchId).value = '';
            onInput('');
            $(searchId).focus();
        }
    });
    $(searchId).addEventListener('input', () => onInput($(searchId).value));
    $(searchId).addEventListener('click', (e) => e.stopPropagation());
}

document.addEventListener('click', closeMenus);

// ============================================================================
// 页面翻译控制
// ============================================================================

async function ensureContentScript(tabId) {
    try {
        await browserAPI.tabs.sendMessage(tabId, { type: 'PING' });
        return true;
    } catch (e) {
        try {
            await browserAPI.scripting.executeScript({
                target: { tabId },
                files: ['textutils.js', 'content.js']
            });
            await new Promise(r => setTimeout(r, 150));
            return true;
        } catch (e2) {
            showToast('无法注入脚本：' + (e2.message || '页面受限'));
            return false;
        }
    }
}

async function startTranslation() {
    if (!currentTab || !currentTab.id) return;
    if (!settings.selectedModel) { showToast('请先选择模型'); return; }
    const ok = await ensureContentScript(currentTab.id);
    if (!ok) return;
    try {
        await browserAPI.tabs.sendMessage(currentTab.id, {
            type: 'START_TRANSLATION',
            targetLanguage: settings.targetLanguage || 'zh',
            sourceLanguage: settings.sourceLanguage || 'auto',
            displayMode: settings.displayMode || 'replace'
        });
        setBusy(true);
        // 轮询状态恢复按钮
        pollStatus();
    } catch (e) {
        showToast('启动失败：' + (e.message || '未知错误'));
    }
}

let pollTimer = null;
async function pollStatus() {
    clearTimeout(pollTimer);
    pollTimer = setTimeout(async () => {
        const busy = await refreshTabStatus();
        if (busy) pollStatus();
    }, 1200);
}

async function cancelTranslation() {
    if (!currentTab || !currentTab.id) return;
    try {
        await browserAPI.tabs.sendMessage(currentTab.id, { type: 'CANCEL_TRANSLATION' });
    } catch (e) { /* 忽略 */ }
    setBusy(false);
}

async function restoreOriginal() {
    if (!currentTab || !currentTab.id) return;
    const ok = await ensureContentScript(currentTab.id);
    if (!ok) return;
    try {
        await browserAPI.tabs.sendMessage(currentTab.id, { type: 'RESTORE_ORIGINAL' });
    } catch (e) {
        showToast('还原失败：' + (e.message || ''));
    }
}

function setBusy(busy) {
    $('translateBtn').disabled = busy || models.length === 0;
    $('translateBtnText').textContent = busy ? '翻译中…' : '翻译网页';
    $('cancelBtn').hidden = !busy;
}

async function refreshTabStatus() {
    if (!currentTab || !currentTab.id) return false;
    try {
        const r = await browserAPI.tabs.sendMessage(currentTab.id, { type: 'GET_TRANSLATION_STATUS' });
        if (r && r.isTranslating) {
            setBusy(true);
            return true;
        }
    } catch (e) { /* 无 content script，正常 */ }
    setBusy(false);
    return false;
}

// ============================================================================
// 快捷设置
// ============================================================================

async function refreshCacheCount() {
    try {
        const r = await send({ type: 'CACHE_COUNT' });
        $('cacheCount').textContent = r && typeof r.count === 'number' ? r.count : '…';
    } catch (e) {
        $('cacheCount').textContent = '…';
    }
}

async function saveQuickSettings() {
    const autoTranslate = $('autoTranslatePages').checked;
    // 自动翻译需要 <all_urls> 权限 —— 必须在用户手势内申请
    if (autoTranslate && !settings.autoTranslatePages) {
        const granted = await browserAPI.permissions.request({ origins: ['<all_urls>'] }).catch(() => false);
        if (!granted) {
            $('autoTranslatePages').checked = false;
            showToast('未授予「所有网站」权限，自动翻译未开启');
        }
    }
    const partial = {
        provider: $('providerSelect').value,
        ollamaUrl: $('ollamaUrl').value.trim() || 'http://127.0.0.1:11434',
        openaiUrl: $('openaiUrl').value.trim() || 'http://127.0.0.1:8080',
        cacheMode: $('cacheMode').value,
        autoTranslatePages: $('autoTranslatePages').checked
    };
    // 非本机地址需要按源授权
    const ok = await ensureHostPermissions([partial.ollamaUrl, partial.openaiUrl]).catch(() => true);
    if (!ok) showToast('未授予远程服务器访问权限，可能无法连接');

    const r = await send({ type: 'SAVE_SETTINGS', settings: partial });
    if (r && r.settings) settings = { ...settings, ...r.settings };
    await send({ type: 'SYNC_CONTENT_SCRIPT' });
    showToast('设置已保存');
    refreshProviderStatus();
    loadModels(true);
}

// ============================================================================
// 事件绑定
// ============================================================================

$('translateBtn').addEventListener('click', startTranslation);
$('cancelBtn').addEventListener('click', cancelTranslation);
$('restoreBtn').addEventListener('click', restoreOriginal);
$('refreshModels').addEventListener('click', () => loadModels(true));

$('toggleQuick').addEventListener('click', () => {
    const sec = $('quickSection');
    sec.hidden = !sec.hidden;
    $('toggleQuick').classList.toggle('open', !sec.hidden);
});

document.querySelectorAll('#displayModeSeg button').forEach(btn => {
    btn.addEventListener('click', async () => {
        document.querySelectorAll('#displayModeSeg button').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        settings.displayMode = btn.dataset.mode;
        await send({ type: 'SAVE_SETTINGS', settings: { displayMode: btn.dataset.mode } });
    });
});

document.querySelectorAll('.preset-chips .chip').forEach(chip => {
    chip.addEventListener('click', () => {
        $('openaiUrl').value = chip.dataset.url;
    });
});

$('saveQuick').addEventListener('click', saveQuickSettings);
$('clearCache').addEventListener('click', async () => {
    const r = await send({ type: 'CLEAR_CACHE' });
    showToast(r && r.ok ? '缓存已清空' : '清空失败');
    refreshCacheCount();
});
$('openOptions').addEventListener('click', () => browserAPI.runtime.openOptionsPage());

setupPicker('modelTrigger', 'modelMenu', 'modelSearch', (v) => renderModelList(v));
setupPicker('langTrigger', 'langMenu', 'langSearch', (v) => renderLangList(v));

init();
