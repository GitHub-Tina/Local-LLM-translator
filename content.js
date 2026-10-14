/**
 * content.js — 页面端脚本：DOM 文本采集、优先级调度、译文应用（原位替换 / 双语对照）、
 * 进度组件、动态内容自动翻译。textutils.js 必须先于本文件注入。
 */

const browserAPI = typeof browser !== 'undefined' ? browser : chrome;

// 防重复注入
if (window.__llmtContentLoaded) {
    throw new Error('LLMT content script 已注入');
}
window.__llmtContentLoaded = true;

let debugEnabled = false;
function debugLog(...args) { if (debugEnabled) console.log('[LLMT]', ...args); }
function debugWarn(...args) { if (debugEnabled) console.warn('[LLMT]', ...args); }

// ============================================================================
// 状态
// ============================================================================

// nodeId -> { node, originalText, segments:[{id, originalText, translated, processedText}] }
const textNodeMap = new Map();
const segmentToNodeIdMap = new Map(); // segmentId -> nodeId
const translatedNodeSet = new Set();
const blockUnitMap = new Map();       // blockEl -> { blockEl, nodeIds, chunkUnits:[{id,text,priority,kind}], insertedEls }
let nextNodeId = 0;
let nextSegmentId = 0;
let nextUnitId = 0;

let translationInProgress = false;
let translationCancelled = false;
let currentTargetLanguage = 'zh';
let currentDisplayMode = 'replace';   // 'replace' | 'bilingual'
let maxConcurrentRequests = 3;
let maxItemsPerBatch = 8;
let maxCharsPerBatch = 1200;
let autoTranslateNewContent = true;
let pendingTranslationQueue = [];
let scrollDebounceTimer = null;

// 还原/切换状态
let hasTranslationCache = false;
let isShowingTranslations = false;

// 动态内容监听
let mutationObserver = null;
let pendingNewNodes = [];
let mutationDebounceTimer = null;

// ============================================================================
// 初始设置同步 + 自动翻译入口
// ============================================================================

browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' }).then(r => {
    if (r && r.settings) {
        const s = r.settings;
        debugEnabled = !!s.debug;
        if (s.targetLanguage) currentTargetLanguage = s.targetLanguage;
        if (s.displayMode) currentDisplayMode = s.displayMode;
        maybeAutoTranslatePage(s);
    }
}).catch(() => { /* background 未就绪 */ });

browserAPI.storage.onChanged.addListener((changes, area) => {
    if (area !== 'local' || !changes.settings) return;
    const s = changes.settings.newValue;
    if (s && s.targetLanguage) currentTargetLanguage = s.targetLanguage;
    if (s && s.displayMode) currentDisplayMode = s.displayMode;
});

// ============================================================================
// 采集过滤
// ============================================================================

const SKIP_TAGS = new Set([
    'SCRIPT', 'STYLE', 'NOSCRIPT', 'IFRAME', 'OBJECT', 'EMBED',
    'SVG', 'CANVAS', 'VIDEO', 'AUDIO', 'CODE', 'PRE', 'KBD', 'SAMP',
    'INPUT', 'TEXTAREA', 'SELECT', 'BUTTON'
]);

function shouldSkipElement(element) {
    if (!element || !element.tagName) return true;
    if (element.isContentEditable) return true;
    let curr = element;
    while (curr) {
        if (curr.tagName && SKIP_TAGS.has(curr.tagName)) return true;
        if (curr.getAttribute && curr.getAttribute('translate') === 'no') return true;
        if (curr.dataset && curr.dataset.llmt) return true; // 我们插入的元素
        if (curr.id === 'llmt-widget') return true;
        curr = curr.parentElement;
    }
    return false;
}

// ============================================================================
// 优先级：视口内 > 正文区 > 标签语义
// ============================================================================

const TAG_PRIORITY = {
    P: 80, H1: 70, H2: 60, H3: 50, H4: 40, H5: 40, H6: 40,
    LI: 30, BLOCKQUOTE: 25, FIGCAPTION: 25, TD: 20, TH: 20,
    SPAN: 5, DIV: 5, A: -10, LABEL: -30, BUTTON: -50
};

function calculatePriority(node) {
    const parent = node.parentElement;
    if (!parent) return 0;
    let priority = 0;
    const rect = parent.getBoundingClientRect();
    if (rect.top < window.innerHeight && rect.bottom > 0 &&
        rect.left < window.innerWidth && rect.right > 0) {
        priority += 1000; // 视口可见
    }
    if (parent.closest('main, article, [role="main"], [role="article"]')) {
        priority += 500;
    } else if (parent.closest('nav, aside, footer, header, [role="navigation"], [role="complementary"]')) {
        priority -= 300;
    }
    priority += TAG_PRIORITY[parent.tagName] || 0;
    return Math.max(0, priority);
}

// ============================================================================
// 文本节点注册（替换模式的翻译单元 = 节点内句子分段）
// ============================================================================

function registerTextNode(node) {
    const nodeId = nextNodeId++;
    const priority = calculatePriority(node);
    const originalText = node.textContent;
    const segments = [];
    const textItems = [];

    const rawSegments = originalText.length > 200
        ? splitIntoSentences(originalText) : [originalText];

    for (const rawSeg of rawSegments) {
        if (isTranslatableText(rawSeg)) {
            const segmentId = nextSegmentId++;
            segmentToNodeIdMap.set(segmentId, nodeId);
            segments.push({ id: segmentId, originalText: rawSeg, translated: false, processedText: null });
            textItems.push({ id: segmentId, text: rawSeg.trim(), priority, kind: 'segment' });
        } else {
            segments.push({ id: null, originalText: rawSeg, translated: false, processedText: null });
        }
    }

    textNodeMap.set(nodeId, { node, originalText, segments });
    translatedNodeSet.add(node); // 已处理标记（防重复采集）
    return textItems;
}

// 双语模式的块边界：最近的块级祖先
const BLOCK_SELECTOR = 'p, li, dd, dt, h1, h2, h3, h4, h5, h6, blockquote, figcaption, td, th, article, section, main, aside, header, footer, div';

// 把同块的文本节点合成"块单元"；超长块按句子切成多个块单元（各自插入一段译文）
function buildBlockUnits(nodeEntries) {
    const byBlock = new Map(); // blockEl -> members
    for (const { nodeId, entry, priority } of nodeEntries) {
        const blockEl = entry.node.parentElement && entry.node.parentElement.closest(BLOCK_SELECTOR);
        if (!blockEl || blockEl === document.body) continue; // 无合适块 -> 调用方回退替换模式
        if (!byBlock.has(blockEl)) byBlock.set(blockEl, []);
        byBlock.get(blockEl).push({ nodeId, entry, priority });
    }

    const units = [];
    for (const [blockEl, members] of byBlock) {
        const priority = Math.max(...members.map(m => m.priority));
        const parts = [];
        for (const m of members) {
            const t = m.entry.originalText.trim();
            if (t) parts.push(t);
        }
        const fullText = parts.join(' ');
        if (!isTranslatableText(fullText)) continue;

        const nodeIds = members.map(m => m.nodeId);
        // 超长块按句子切分，每片不超过 maxCharsPerBatch
        const chunks = [];
        if (fullText.length > maxCharsPerBatch) {
            const sentences = splitIntoSentences(fullText);
            let buf = '';
            for (const s of sentences) {
                if (buf && (buf.length + s.length) > maxCharsPerBatch) {
                    chunks.push(buf.trim());
                    buf = s;
                } else {
                    buf += s;
                }
            }
            if (buf.trim()) chunks.push(buf.trim());
        } else {
            chunks.push(fullText);
        }

        const chunkUnits = chunks.map((text, i) => ({
            id: nextUnitId++,
            text,
            priority: priority - i,
            kind: 'block'
        }));
        blockUnitMap.set(blockEl, { blockEl, nodeIds, chunkUnits, insertedEls: [] });
        units.push(...chunkUnits);
    }
    return units;
}

// 通用收尾：按当前显示模式把 segment 项组合成最终单元列表
function assembleUnits(segmentItems, nodeEntries) {
    if (currentDisplayMode !== 'bilingual') return segmentItems;
    const blockUnits = buildBlockUnits(nodeEntries);
    const blockNodeIds = new Set();
    for (const u of blockUnitMap.values()) for (const nid of u.nodeIds) blockNodeIds.add(nid);
    // 没归入任何块的节点回退为 segment 单元
    const fallback = segmentItems.filter(item => !blockNodeIds.has(segmentToNodeIdMap.get(item.id)));
    return [...blockUnits, ...fallback];
}

/**
 * 采集翻译单元（全页）。
 * replace 模式 -> 句子级 segment 单元；bilingual 模式 -> 块级单元。
 */
function extractUnits(root = document.body, onlyNew = false) {
    if (!onlyNew) {
        textNodeMap.clear();
        segmentToNodeIdMap.clear();
        translatedNodeSet.clear();
        blockUnitMap.clear();
        nextNodeId = 0; nextSegmentId = 0; nextUnitId = 0;
    }

    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
            if (onlyNew && translatedNodeSet.has(node)) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
            if (!isTranslatableText(node.textContent)) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });

    const segmentItems = [];
    const nodeEntries = [];
    let node;
    while (node = walker.nextNode()) {
        const items = registerTextNode(node);
        segmentItems.push(...items);
        if (currentDisplayMode === 'bilingual') {
            nodeEntries.push({
                nodeId: nextNodeId - 1,
                entry: textNodeMap.get(nextNodeId - 1),
                priority: items.length ? items[0].priority : 0
            });
        }
    }

    const units = assembleUnits(segmentItems, nodeEntries);
    units.sort((a, b) => b.priority - a.priority);
    return units;
}

// 采集新增节点（动态内容）
function extractNewUnits(addedNodes) {
    const segmentItems = [];
    const nodeEntries = [];
    for (const node of addedNodes) {
        if (node.nodeType === Node.TEXT_NODE) {
            if (!translatedNodeSet.has(node) && isTranslatableText(node.textContent)) {
                const parent = node.parentElement;
                if (parent && !shouldSkipElement(parent)) {
                    const items = registerTextNode(node);
                    segmentItems.push(...items);
                    if (currentDisplayMode === 'bilingual') {
                        nodeEntries.push({
                            nodeId: nextNodeId - 1,
                            entry: textNodeMap.get(nextNodeId - 1),
                            priority: items.length ? items[0].priority : 0
                        });
                    }
                }
            }
        } else if (node.nodeType === Node.ELEMENT_NODE) {
            collectFromSubtree(node, segmentItems, nodeEntries);
        }
    }
    const units = assembleUnits(segmentItems, nodeEntries);
    units.sort((a, b) => b.priority - a.priority);
    return units;
}

function collectFromSubtree(root, outSegments, outEntries) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
        acceptNode: (node) => {
            if (translatedNodeSet.has(node)) return NodeFilter.FILTER_REJECT;
            const parent = node.parentElement;
            if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
            if (!isTranslatableText(node.textContent)) return NodeFilter.FILTER_REJECT;
            const style = window.getComputedStyle(parent);
            if (style.display === 'none' || style.visibility === 'hidden') return NodeFilter.FILTER_REJECT;
            return NodeFilter.FILTER_ACCEPT;
        }
    });
    let node;
    while (node = walker.nextNode()) {
        const items = registerTextNode(node);
        outSegments.push(...items);
        if (currentDisplayMode === 'bilingual') {
            outEntries.push({
                nodeId: nextNodeId - 1,
                entry: textNodeMap.get(nextNodeId - 1),
                priority: items.length ? items[0].priority : 0
            });
        }
    }
}

function extractSelectionUnits(selection) {
    const items = [];
    const seenNodes = new Set();
    for (let i = 0; i < selection.rangeCount; i++) {
        const range = selection.getRangeAt(i);
        const ancestor = range.commonAncestorContainer;
        const root = ancestor.nodeType === Node.TEXT_NODE ? ancestor.parentElement : ancestor;
        if (!root) continue;
        const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
            acceptNode: (node) => {
                if (seenNodes.has(node)) return NodeFilter.FILTER_REJECT;
                if (!range.intersectsNode(node)) return NodeFilter.FILTER_REJECT;
                const parent = node.parentElement;
                if (!parent || shouldSkipElement(parent)) return NodeFilter.FILTER_REJECT;
                if (!isTranslatableText(node.textContent)) return NodeFilter.FILTER_REJECT;
                return NodeFilter.FILTER_ACCEPT;
            }
        });
        let node;
        while (node = walker.nextNode()) {
            seenNodes.add(node);
            let existing = null;
            for (const [, entry] of textNodeMap) {
                if (entry.node === node) { existing = entry; break; }
            }
            const priority = calculatePriority(node);
            if (existing) {
                for (const seg of existing.segments) {
                    if (seg.id !== null) {
                        items.push({ id: seg.id, text: seg.originalText.trim(), priority, kind: 'segment' });
                    }
                }
            } else {
                items.push(...registerTextNode(node));
            }
        }
    }
    items.sort((a, b) => b.priority - a.priority);
    return items;
}

// ============================================================================
// 译文应用
// ============================================================================

// 替换模式：重建整个文本节点（保留段外空白；CJK 源 -> 无尾空格时补一个）
function replaceSegment(segmentId, translatedText) {
    const nodeId = segmentToNodeIdMap.get(segmentId);
    if (nodeId === undefined) return false;
    const entry = textNodeMap.get(nodeId);
    if (!entry) return false;
    const segment = entry.segments.find(s => s.id === segmentId);
    if (!segment) return false;

    const segOriginal = segment.originalText;
    const leadingSpace = (segOriginal.match(/^\s*/) || [''])[0];
    const trailingSpace = (segOriginal.match(/\s*$/) || [''])[0];
    const trimmed = (translatedText || '').trim();

    let effectiveTrailing = trailingSpace;
    if (!effectiveTrailing && trimmed) {
        if (/[\u3000-\u9fff\uff00-\uffef]/.test(segOriginal)) effectiveTrailing = ' ';
    }

    segment.translated = true;
    segment.processedText = leadingSpace + trimmed + effectiveTrailing;

    try {
        entry.node.textContent = entry.segments.map(s => s.translated ? s.processedText : s.originalText).join('');
    } catch (e) { return false; }
    if (entry.node.parentElement) entry.node.parentElement.dataset.translated = 'true';
    return true;
}

// 双语模式：在块后插入译文段（多个 chunk 按顺序插入）
function insertBlockTranslation(unitId, translatedText) {
    let owner = null;
    let chunkIndex = -1;
    for (const u of blockUnitMap.values()) {
        const idx = u.chunkUnits.findIndex(c => c.id === unitId);
        if (idx !== -1) { owner = u; chunkIndex = idx; break; }
    }
    if (!owner || !owner.blockEl || !owner.blockEl.parentNode) return false;

    try {
        const el = document.createElement('p');
        el.className = 'llmt-bilingual';
        el.setAttribute('translate', 'no');
        el.dataset.llmt = '1';
        el.textContent = (translatedText || '').trim();
        // 多个 chunk：第 i 段插在第 i-1 段插入元素之后，保持顺序
        const anchor = chunkIndex > 0 && owner.insertedEls[chunkIndex - 1]
            ? owner.insertedEls[chunkIndex - 1]
            : owner.blockEl;
        owner.blockEl.parentNode.insertBefore(el, anchor.nextSibling);
        owner.insertedEls[chunkIndex] = el;
        // 标记该块文本节点已翻译，避免动态监听重复翻译
        for (const nid of owner.nodeIds) {
            const entry = textNodeMap.get(nid);
            if (entry) for (const seg of entry.segments) seg.translated = true;
        }
        return true;
    } catch (e) {
        return false;
    }
}

function applyTranslation(unit, translatedText) {
    if (unit.kind === 'block') return insertBlockTranslation(unit.id, translatedText);
    return replaceSegment(unit.id, translatedText);
}

// 还原全部
function restoreOriginalText() {
    for (const [, entry] of textNodeMap) {
        if (entry.segments.some(s => s.translated)) {
            try { entry.node.textContent = entry.originalText; } catch (e) { /* 节点可能已移除 */ }
        }
    }
    for (const [, u] of blockUnitMap.values()) {
        for (const el of (u.insertedEls || [])) {
            try { el.remove(); } catch (e) { /* 同上 */ }
        }
        u.insertedEls = [];
    }
    isShowingTranslations = false;
    stopAutoTranslate();
}

// 切回已缓存的译文（仅替换模式可廉价重建；双语对照需重新翻译）
function restoreCachedTranslations() {
    let restored = 0;
    for (const [, entry] of textNodeMap) {
        if (entry.segments.some(s => s.translated && s.processedText !== null)) {
            try {
                entry.node.textContent = entry.segments.map(s => s.translated ? s.processedText : s.originalText).join('');
                restored++;
            } catch (e) { /* 节点可能已移除 */ }
        }
    }
    if (restored > 0) isShowingTranslations = true;
    return restored > 0;
}

// ============================================================================
// 双语样式
// ============================================================================

function ensureBilingualStyles() {
    if (document.getElementById('llmt-bilingual-style')) return;
    const style = document.createElement('style');
    style.id = 'llmt-bilingual-style';
    style.setAttribute('translate', 'no');
    style.dataset.llmt = '1';
    style.textContent = `
        .llmt-bilingual {
            all: initial;
            display: block;
            font-family: inherit;
            font-size: inherit;
            line-height: inherit;
            color: #4b5563;
            background: transparent;
            margin: 4px 0 0 0;
            padding: 0 0 0 10px;
            border-left: 2px solid rgba(99, 102, 241, 0.45);
            -webkit-user-select: text;
            user-select: text;
        }
        .llmt-bilingual:empty { display: none; }
    `;
    (document.head || document.documentElement).appendChild(style);
}

// ============================================================================
// 进度组件（右下角胶囊，结构只建一次）
// ============================================================================

let widgetEl = null;
let widgetMinimizeTimer = null;
let widgetHideTimer = null;
let widgetHovered = false;
let widgetState = 'idle'; // 'idle' | 'progress' | 'complete'

function ensureWidgetStyles() {
    if (document.getElementById('llmt-widget-style')) return;
    const style = document.createElement('style');
    style.id = 'llmt-widget-style';
    style.setAttribute('translate', 'no');
    style.dataset.llmt = '1';
    style.textContent = `
        #llmt-widget, #llmt-widget * { box-sizing: border-box; }
        #llmt-widget {
            position: fixed; bottom: 20px; right: 20px; z-index: 2147483647;
            overflow: hidden; background: #111827; color: #f9fafb;
            font-family: system-ui, -apple-system, "Microsoft YaHei", sans-serif;
            font-size: 13px; line-height: 1.4; box-shadow: 0 4px 16px rgba(0,0,0,0.3);
            user-select: none; border-radius: 10px;
            opacity: 0; transform: translateY(10px); pointer-events: none;
            transition: opacity .25s ease, transform .25s ease, border-radius .25s ease;
        }
        #llmt-widget.llmt-visible { opacity: 1; transform: translateY(0); pointer-events: auto; }
        #llmt-widget.llmt-error { background: #7f1d1d; }
        #llmt-widget .llmt-row { display: flex; align-items: center; gap: 8px; padding: 8px 12px; white-space: nowrap; }
        #llmt-widget.llmt-minimized { border-radius: 50%; cursor: pointer; }
        #llmt-widget.llmt-minimized .llmt-row { display: none; }
        #llmt-widget .llmt-pct {
            display: none; align-items: center; justify-content: center;
            width: 42px; height: 42px; font-size: 11px; font-weight: 700;
        }
        #llmt-widget.llmt-minimized .llmt-pct { display: flex; }
        #llmt-widget .llmt-msg { max-width: 280px; overflow: hidden; text-overflow: ellipsis; }
        #llmt-widget .llmt-actions { display: flex; align-items: center; gap: 6px; margin-left: auto; }
        #llmt-widget .llmt-actions[hidden] { display: none; }
        #llmt-widget button {
            background: rgba(255,255,255,0.12); border: 1px solid rgba(255,255,255,0.25);
            color: #f9fafb; padding: 2px 8px; border-radius: 6px; cursor: pointer;
            font-family: inherit; font-size: 11px; font-weight: 600; white-space: nowrap;
        }
        #llmt-widget button:hover { background: rgba(255,255,255,0.22); }
        #llmt-widget button.llmt-stop { background: #dc2626; border-color: #dc2626; }
        #llmt-widget button.llmt-stop:hover { background: #b91c1c; }
    `;
    (document.head || document.documentElement).appendChild(style);
}

function getWidget() {
    if (widgetEl) return widgetEl;
    ensureWidgetStyles();
    const el = document.createElement('div');
    el.id = 'llmt-widget';
    el.setAttribute('translate', 'no');
    el.dataset.llmt = '1';
    el.innerHTML = `
        <div class="llmt-row">
            <span class="llmt-msg"></span>
            <div class="llmt-actions" hidden>
                <button type="button" class="llmt-never" hidden>本站不再自动翻译</button>
                <button type="button" class="llmt-stop" title="停止翻译">停止</button>
            </div>
        </div>
        <span class="llmt-pct"></span>
    `;
    document.body.appendChild(el);
    widgetEl = el;

    el.querySelector('.llmt-stop').addEventListener('click', () => stopCurrentTranslation(false));
    el.querySelector('.llmt-never').addEventListener('click', async () => {
        stopCurrentTranslation(true);
        try {
            await browserAPI.runtime.sendMessage({ type: 'ADD_NEVER_SITE', hostname: location.hostname });
            showToast(`${location.hostname} 已加入自动翻译排除名单`);
        } catch (e) {
            showToast('保存站点偏好失败', true);
        }
    });

    el.addEventListener('mouseenter', () => {
        widgetHovered = true;
        clearTimeout(widgetMinimizeTimer);
        clearTimeout(widgetHideTimer);
        if (widgetState === 'progress') el.classList.remove('llmt-minimized');
    });
    el.addEventListener('mouseleave', () => {
        widgetHovered = false;
        if (widgetState === 'progress') scheduleMinimize(1200);
        else if (widgetState === 'complete') scheduleHide(1500);
    });
    el.addEventListener('click', (e) => {
        // 最小化圆圈点击 -> 展开
        if (el.classList.contains('llmt-minimized') && widgetState === 'progress') {
            e.stopPropagation();
            el.classList.remove('llmt-minimized');
            scheduleMinimize(3000);
        }
    });
    return el;
}

function setWidgetMessage(el, message) {
    const msgEl = el.querySelector('.llmt-msg');
    if (msgEl) msgEl.textContent = message;
}

function scheduleMinimize(delay) {
    clearTimeout(widgetMinimizeTimer);
    if (widgetState !== 'progress') return;
    widgetMinimizeTimer = setTimeout(() => {
        if (!widgetHovered && widgetState === 'progress' && widgetEl) {
            widgetEl.classList.add('llmt-minimized');
        }
    }, delay);
}

function scheduleHide(delay) {
    clearTimeout(widgetHideTimer);
    widgetHideTimer = setTimeout(() => {
        if (widgetHovered) return;
        if (widgetState === 'complete') hideWidget();
    }, delay);
}

function startProgressWidget({ auto = false, message = '' } = {}) {
    const el = getWidget();
    clearTimeout(widgetHideTimer);
    widgetState = 'progress';
    el.classList.remove('llmt-error', 'llmt-minimized');
    el.classList.add('llmt-visible');
    setWidgetMessage(el, message);
    const pctEl = el.querySelector('.llmt-pct');
    if (pctEl) pctEl.textContent = '0%';
    el.querySelector('.llmt-actions').hidden = false;
    el.querySelector('.llmt-never').hidden = !auto;
    if (!widgetHovered) scheduleMinimize(3000);
}

function updateProgressWidget(percent, message) {
    if (!widgetEl || widgetState !== 'progress') return;
    const pct = Math.max(0, Math.min(100, Math.round(percent)));
    const pctEl = widgetEl.querySelector('.llmt-pct');
    if (pctEl) pctEl.textContent = pct + '%';
    if (message !== undefined && !widgetEl.classList.contains('llmt-minimized')) {
        setWidgetMessage(widgetEl, message);
    }
}

function endWidgetMessage(message, isError = false, hideDelay) {
    const el = getWidget();
    clearTimeout(widgetMinimizeTimer);
    widgetState = 'complete';
    el.classList.remove('llmt-minimized');
    el.classList.toggle('llmt-error', isError);
    el.classList.add('llmt-visible');
    el.querySelector('.llmt-actions').hidden = true;
    setWidgetMessage(el, message);
    scheduleHide(hideDelay !== undefined ? hideDelay : (isError ? 5000 : 3500));
}

function completeWidget(message, isError = false) {
    endWidgetMessage(message, isError);
}

function showToast(message, isError = false) {
    endWidgetMessage(message, isError, isError ? 4000 : 2500);
}

function hideWidget() {
    clearTimeout(widgetMinimizeTimer);
    clearTimeout(widgetHideTimer);
    widgetState = 'idle';
    widgetHovered = false;
    if (widgetEl) widgetEl.classList.remove('llmt-visible', 'llmt-minimized', 'llmt-error');
}

function stopCurrentTranslation(silent = false) {
    translationCancelled = true;
    if (!silent) showToast('已停止翻译');
    pendingTranslationQueue = [];
    stopAutoTranslate();
}

// content -> background 的保活端口（防 MV3 service worker 休眠）
function startKeepAlive() {
    let port = null;
    let interval = null;
    try {
        port = browserAPI.runtime.connect({ name: 'keepalive' });
        port.onDisconnect.addListener(() => {
            port = null;
            if (interval) { clearInterval(interval); interval = null; }
        });
        interval = setInterval(() => {
            if (port) {
                try { port.postMessage({ type: 'ping' }); }
                catch (e) { clearInterval(interval); interval = null; }
            }
        }, 20000);
    } catch (e) { /* 保活失败不致命 */ }
    return function stopKeepAlive() {
        if (interval) clearInterval(interval);
        if (port) { try { port.disconnect(); } catch (e) { /* 忽略 */ } }
    };
}

// ============================================================================
// 语言检测与自动翻译
// ============================================================================

function getDeclaredPageLanguage() {
    const htmlLang = document.documentElement.lang || document.querySelector('html')?.getAttribute('lang');
    if (htmlLang) return htmlLang.split('-')[0].toLowerCase();
    const metaLang = document.querySelector('meta[http-equiv="content-language"]')?.getAttribute('content');
    if (metaLang) return metaLang.split('-')[0].toLowerCase();
    return null;
}

function getPageLanguage() {
    return getDeclaredPageLanguage() || 'en';
}

function hostMatchesNeverSite(hostname, sites) {
    const host = (hostname || '').toLowerCase();
    if (!host || !Array.isArray(sites)) return false;
    return sites.some(entry => {
        const site = String(entry || '').trim().toLowerCase();
        if (!site) return false;
        return host === site || host.endsWith('.' + site);
    });
}

let autoTranslateChecked = false;
async function maybeAutoTranslatePage(settings) {
    if (autoTranslateChecked) return;
    autoTranslateChecked = true;
    if (!settings || !settings.autoTranslatePages) return;
    if (window.top !== window.self) return; // 只处理顶层文档
    if (translationInProgress) return;

    const pageLang = getDeclaredPageLanguage();
    if (!pageLang) return; // 页面未声明语言则不猜 —— 本地推理有实际成本

    const target = String(settings.targetLanguage || currentTargetLanguage || 'zh').split('-')[0].toLowerCase();
    if (pageLang === target) return;

    const neverLangs = Array.isArray(settings.autoTranslateNeverLanguages) ? settings.autoTranslateNeverLanguages : [];
    if (neverLangs.includes(pageLang)) return;
    if (hostMatchesNeverSite(location.hostname, settings.autoTranslateNeverSites)) return;

    debugLog(`自动翻译: ${pageLang} -> ${target}`);
    await translatePage(target, pageLang, { auto: true });
}

// ============================================================================
// 批量翻译（含消息层重试）
// ============================================================================

async function translateBatch(units, targetLanguage, sourceLanguage = 'auto', retries = 3) {
    if (units.length === 0) return { applied: 0, failed: [], fromCache: 0, total: 0, cacheActive: false };

    const pageLanguage = (sourceLanguage && sourceLanguage !== 'auto') ? sourceLanguage : getPageLanguage();
    let lastError = null;

    for (let attempt = 0; attempt < retries; attempt++) {
        try {
            if (attempt > 0) await new Promise(r => setTimeout(r, 500 * attempt));
            const response = await browserAPI.runtime.sendMessage({
                type: 'TRANSLATE',
                texts: units.map(u => ({ id: u.id, text: u.text })),
                targetLanguage,
                sourceLanguage: pageLanguage
            });

            if (!response) throw new Error('后台无响应（service worker 休眠？）');
            if (response.error) throw new Error(response.error);

            let applied = 0;
            const failed = [];
            const received = new Set();

            for (const t of (response.translations || [])) {
                received.add(t.id);
                const unit = units.find(u => u.id === t.id);
                if (!t.error && t.text) {
                    if (unit && applyTranslation(unit, t.text)) applied++;
                    else if (unit) failed.push(unit);
                } else if (unit) {
                    failed.push(unit);
                }
            }
            for (const u of units) {
                if (!received.has(u.id)) failed.push(u);
            }
            return {
                applied, failed,
                fromCache: response.fromCache || 0,
                total: response.total || units.length,
                cacheActive: !!response.cacheActive
            };
        } catch (e) {
            lastError = e;
            debugWarn(`批次第 ${attempt + 1}/${retries} 次失败:`, e.message);
        }
    }
    console.error('[LLMT] 批量翻译彻底失败:', lastError && lastError.message);
    return { applied: 0, failed: units, fromCache: 0, total: units.length, cacheActive: false };
}

// ============================================================================
// 主流程
// ============================================================================

function onScroll() {
    if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);
    scrollDebounceTimer = setTimeout(() => {
        if (pendingTranslationQueue.length === 0) return;
        for (const item of pendingTranslationQueue) {
            if (item.kind === 'segment') {
                const nodeId = segmentToNodeIdMap.get(item.id);
                const entry = nodeId !== undefined ? textNodeMap.get(nodeId) : null;
                if (entry && entry.node) item.priority = calculatePriority(entry.node);
            } else {
                let owner = null;
                for (const u of blockUnitMap.values()) {
                    if (u.chunkUnits && u.chunkUnits.some(c => c.id === item.id)) { owner = u; break; }
                }
                if (owner && owner.blockEl && owner.blockEl.parentElement) {
                    item.priority = calculatePriority({ parentElement: owner.blockEl });
                }
            }
        }
        pendingTranslationQueue.sort((a, b) => b.priority - a.priority);
    }, 120);
}

async function translatePage(targetLanguage, sourceLanguage = 'auto', { auto = false } = {}) {
    if (translationInProgress) {
        showToast('已有翻译正在进行…', true);
        return;
    }

    // 读取运行参数（设置可能在 popup 中被改过）
    let settings = {};
    try {
        const r = await browserAPI.runtime.sendMessage({ type: 'GET_SETTINGS' });
        if (r && r.settings) settings = r.settings;
    } catch (e) { /* 用默认值 */ }
    currentTargetLanguage = targetLanguage || currentTargetLanguage;
    currentDisplayMode = settings.displayMode || currentDisplayMode;
    maxConcurrentRequests = Math.max(1, Math.min(32, settings.maxConcurrentRequests || 3));
    maxItemsPerBatch = Math.max(1, settings.maxItemsPerBatch || 8);
    maxCharsPerBatch = Math.max(200, settings.maxCharsPerBatch || 1200);
    autoTranslateNewContent = settings.autoTranslateNewContent !== false;
    if (currentDisplayMode === 'bilingual') ensureBilingualStyles();

    translationInProgress = true;
    translationCancelled = false;
    const verb = auto ? '自动翻译中' : '翻译中';
    startProgressWidget({ auto, message: '正在提取文本…' });

    window.addEventListener('scroll', onScroll, { passive: true });
    const stopKeepAlive = startKeepAlive();

    try {
        const units = extractUnits();
        if (units.length === 0) {
            completeWidget('没有找到可翻译的文本', true);
            return;
        }

        pendingTranslationQueue = [...units];
        updateProgressWidget(0, `共 ${units.length} 个单元，${verb}…`);

        let totalApplied = 0;
        let totalProcessed = 0;
        let totalFromCache = 0;
        let cacheActive = false;
        const totalItems = units.length;
        const failedUnits = [];
        let inFlight = [];

        // 按"条数 + 字符数"双约束组批
        const takeBatch = () => {
            const batch = [];
            let chars = 0;
            while (pendingTranslationQueue.length > 0 && batch.length < maxItemsPerBatch) {
                const next = pendingTranslationQueue[0];
                if (batch.length > 0 && chars + next.text.length > maxCharsPerBatch) break;
                batch.push(pendingTranslationQueue.shift());
                chars += next.text.length;
            }
            return batch;
        };

        while ((pendingTranslationQueue.length > 0 || inFlight.length > 0) && !translationCancelled) {
            while (inFlight.length < maxConcurrentRequests && pendingTranslationQueue.length > 0) {
                const batch = takeBatch();
                totalProcessed += batch.length;
                const batchId = nextUnitId++;
                const promise = translateBatch(batch, targetLanguage, sourceLanguage)
                    .then(result => ({ batchId, result, batch, success: true }))
                    .catch(error => ({ batchId, error, batch, success: false }));
                inFlight.push({ batchId, promise });
            }

            const percent = Math.min(100, Math.round((totalProcessed / totalItems) * 100));
            updateProgressWidget(percent, `${verb} ${percent}%`);

            if (inFlight.length > 0) {
                const completed = await Promise.race(inFlight.map(b => b.promise));
                inFlight = inFlight.filter(b => b.batchId !== completed.batchId);
                if (completed.success) {
                    totalApplied += completed.result.applied;
                    totalFromCache += completed.result.fromCache || 0;
                    if (completed.result.cacheActive) cacheActive = true;
                    if (completed.result.failed && completed.result.failed.length > 0) {
                        failedUnits.push(...completed.result.failed);
                    }
                } else {
                    console.error('[LLMT] 批次错误:', completed.error);
                    failedUnits.push(...completed.batch);
                }
            }

            if (translationCancelled) break;
        }

        if (totalApplied > 0) {
            hasTranslationCache = true;
            isShowingTranslations = true;
        }

        if (!translationCancelled) {
            if (failedUnits.length > 0) {
                console.warn(`[LLMT] ${failedUnits.length} 个单元失败:`,
                    failedUnits.slice(0, 5).map(f => String(f.text).substring(0, 30)));
            }
            if (autoTranslateNewContent) startAutoTranslate(targetLanguage);

            let msg = `已翻译 ${totalApplied}/${totalItems} 个单元`;
            if (failedUnits.length > 0) msg += `，${failedUnits.length} 个失败`;
            if (cacheActive && totalFromCache > 0 && totalItems > 0) {
                msg += `（${Math.round((totalFromCache / totalItems) * 100)}% 来自缓存）`;
            }
            completeWidget(msg);
        }
    } catch (e) {
        console.error('[LLMT] 翻译出错:', e);
        completeWidget(`出错: ${e.message}`, true);
    } finally {
        stopKeepAlive();
        translationInProgress = false;
        translationCancelled = false;
        pendingTranslationQueue = [];
        window.removeEventListener('scroll', onScroll);
        try {
            browserAPI.runtime.sendMessage({ type: 'TRANSLATION_COMPLETE' }).catch(() => {});
        } catch (e) { /* popup 可能已关闭 */ }
    }
}

async function translateSelection(targetLanguage, sourceLanguage = 'auto') {
    if (translationInProgress) {
        showToast('已有翻译正在进行…', true);
        return;
    }
    const selection = window.getSelection();
    if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
        showToast('未选中任何文本', true);
        return;
    }

    translationInProgress = true;
    translationCancelled = false;
    const stopKeepAlive = startKeepAlive();
    startProgressWidget({ message: '正在提取选中文本…' });

    try {
        // 选区翻译固定用替换模式（通常是短语，无需对照段）
        const prevMode = currentDisplayMode;
        currentDisplayMode = 'replace';
        const items = extractSelectionUnits(selection);
        currentDisplayMode = prevMode;

        if (items.length === 0) {
            completeWidget('选区内无可翻译文本', true);
            return;
        }

        let totalApplied = 0;
        const failed = [];
        for (let i = 0; i < items.length && !translationCancelled; i += maxItemsPerBatch) {
            const batch = items.slice(i, i + maxItemsPerBatch);
            const result = await translateBatch(batch, targetLanguage, sourceLanguage);
            totalApplied += result.applied;
            if (result.failed) failed.push(...result.failed);
            const percent = Math.min(100, Math.round(((i + batch.length) / items.length) * 100));
            updateProgressWidget(percent, `翻译选中 ${percent}%`);
        }

        if (totalApplied > 0) {
            hasTranslationCache = true;
            isShowingTranslations = true;
        }
        let msg = `已翻译选中文本 ${totalApplied}/${items.length} 段`;
        if (failed.length > 0) msg += `，${failed.length} 个失败`;
        completeWidget(msg);
    } catch (e) {
        console.error('[LLMT] 选区翻译出错:', e);
        completeWidget(`出错: ${e.message}`, true);
    } finally {
        stopKeepAlive();
        translationInProgress = false;
        translationCancelled = false;
    }
}

// ============================================================================
// 动态内容自动翻译
// ============================================================================

function startAutoTranslate(targetLanguage) {
    if (mutationObserver) mutationObserver.disconnect();
    autoTranslateNewContent = true;
    currentTargetLanguage = targetLanguage;
    pendingNewNodes = [];

    mutationObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
            if (mutation.type === 'childList') {
                for (const node of mutation.addedNodes) pendingNewNodes.push(node);
            }
        }
        if (mutationDebounceTimer) clearTimeout(mutationDebounceTimer);
        mutationDebounceTimer = setTimeout(translatePendingNodes, 600);
    });
    mutationObserver.observe(document.body, { childList: true, subtree: true });
}

function stopAutoTranslate() {
    if (mutationObserver) {
        mutationObserver.disconnect();
        mutationObserver = null;
    }
    if (mutationDebounceTimer) {
        clearTimeout(mutationDebounceTimer);
        mutationDebounceTimer = null;
    }
    pendingNewNodes = [];
}

async function translatePendingNodes() {
    if (pendingNewNodes.length === 0 || translationInProgress) return;
    const nodes = [...pendingNewNodes];
    pendingNewNodes = [];

    // 过滤自己插入的元素
    const meaningful = nodes.filter(n => {
        if (n.nodeType === Node.ELEMENT_NODE) return !(n.dataset && n.dataset.llmt);
        return true;
    });
    if (meaningful.length === 0) return;

    const units = extractNewUnits(meaningful);
    if (units.length === 0) return;

    translationInProgress = true;
    showToast(`正在翻译新增的 ${units.length} 个单元…`);
    try {
        const result = await translateBatch(units, currentTargetLanguage);
        if (result.applied > 0) showToast(`已翻译 ${result.applied} 个新增单元`);
    } catch (e) {
        showToast(`动态翻译出错: ${e.message}`, true);
    } finally {
        translationInProgress = false;
    }
}

// ============================================================================
// 消息入口
// ============================================================================

browserAPI.runtime.onMessage.addListener((message, sender, sendResponse) => {
    switch (message.type) {
        case 'START_TRANSLATION':
            translatePage(message.targetLanguage, message.sourceLanguage || 'auto');
            sendResponse({ started: true });
            break;

        case 'TRANSLATE_SELECTION':
            translateSelection(message.targetLanguage, message.sourceLanguage || 'auto');
            sendResponse({ started: true });
            break;

        case 'CANCEL_TRANSLATION':
            stopCurrentTranslation(true);
            sendResponse({ cancelled: true });
            break;

        case 'RESTORE_ORIGINAL':
            restoreOriginalText();
            showToast('已还原原文');
            sendResponse({ restored: true });
            break;

        case 'TOGGLE_TRANSLATION':
            if (isShowingTranslations) {
                restoreOriginalText();
                sendResponse({ showing: 'original' });
            } else if (hasTranslationCache && restoreCachedTranslations()) {
                showToast('已切回译文');
                sendResponse({ showing: 'translated' });
            } else {
                sendResponse({ showing: 'original', note: 'bilingual-cache-not-rebuildable' });
            }
            break;

        case 'GET_TRANSLATION_STATUS':
            sendResponse({
                isTranslating: translationInProgress,
                hasTranslation: hasTranslationCache,
                showing: isShowingTranslations ? 'translated' : 'original'
            });
            break;

        case 'GET_PAGE_LANGUAGE':
            sendResponse({ language: getPageLanguage() });
            break;

        case 'PING':
            sendResponse({ pong: true });
            break;

        default:
            sendResponse({ unknown: true });
    }
    return true;
});

console.log('[LLMT] Local LLM Translator content 已加载');
