/**
 * textutils.js — 纯函数工具集，被 background（service worker，经 importScripts）
 * 与 content（注入时排在 content.js 之前）共用。不得触碰 DOM / 扩展 API，
 * 以便在 Node vm 沙箱中直接单测。
 *
 * 设计参考：offline-browser-translate 项目的批处理 [id]: 文本协议与容错解析思路。
 */

// 分句：中文标点直接切；西文句点要求后随空白或行尾，避免切破 "3.14"、"e.g."、URL。
function splitIntoSentences(text) {
    if (!text) return [];
    const segments = [];
    let current = '';

    for (let i = 0; i < text.length; i++) {
        const ch = text[i];
        current += ch;

        if ('。？！；'.includes(ch)) {
            segments.push(current);
            current = '';
            continue;
        }

        if (!'.!?'.includes(ch)) continue;

        const prev = text[i - 1] || '';
        const next = text[i + 1] || '';
        if (ch === '.' && /\d/.test(prev) && /\d/.test(next)) continue; // 小数点

        while (i + 1 < text.length && '.!?'.includes(text[i + 1])) {
            current += text[++i];
        }
        if (i + 1 >= text.length || /\s/.test(text[i + 1])) {
            while (i + 1 < text.length && /\s/.test(text[i + 1])) {
                current += text[++i];
            }
            segments.push(current);
            current = '';
        }
    }

    if (current) segments.push(current);
    return segments.length > 0 ? segments : [text];
}

// 文本是否值得翻译：至少 2 个字符且含 Unicode 字母（跳过纯数字/符号/空白）。
function isTranslatableText(text) {
    if (!text) return false;
    const trimmed = text.trim();
    if (trimmed.length < 2) return false;
    return /\p{L}/u.test(trimmed);
}

// 批量条目 -> "[0]: xxx\n[1]: yyy" 提示词正文
function formatTextsForPrompt(textItems) {
    return textItems.map(item => `[${item.id}]: ${item.text}`).join('\n');
}

function buildPrompt(template, vars) {
    let result = template;
    for (const [key, value] of Object.entries(vars)) {
        result = result.replace(new RegExp(`{{${key}}}`, 'g'), value);
    }
    return result;
}

// 小模型偶尔泄漏的行内 HTML 标签白名单；只剥这些，避免误伤 "a < b" 这类正文。
const LEAKED_HTML_TAG = /<\/?(?:div|span|p|br|b|i|em|strong|ul|ol|li|a|h[1-6])\b[^>]*>/gi;

// 清洗译文：去掉模型回显的 "[99]: " 前缀、泄漏的标签，压缩多余空格。
// 不做 trim —— 首尾空白由 content.js 按原文补齐。
function cleanTranslationText(text) {
    if (!text) return text;
    let cleaned = text.replace(/^\[?\d+\]?:\s*/g, '');
    cleaned = cleaned.replace(LEAKED_HTML_TAG, '');
    cleaned = cleaned.replace(/  +/g, ' ');
    return cleaned;
}

// 译文是否疑似泄漏了结构（JSON/markdown）而非真正译文 —— 用于拒收，保住原文。
function isSuspiciousTranslation(text) {
    if (text === null || text === undefined) return true;
    const t = String(text).trim();
    if (!t) return true;
    if (!/\p{L}/u.test(t)) return true; // 纯标点/花括号
    if (/["']?(?:translations|id|text)["']?\s*:/.test(t)) return true; // 泄漏了 schema 键名
    if (/^[\[{][\s\S]*[\]}]$/.test(t) && /["':]/.test(t)) return true; // 整段被 JSON 包裹
    if (t.includes('```')) return true; // markdown 代码块
    return false;
}

// 从混杂散文中提取第一个配平的 {...}（处理字符串与转义），比贪婪正则可靠。
function extractJsonObject(text) {
    const start = text.indexOf('{');
    if (start === -1) return null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (inString) {
            if (escaped) escaped = false;
            else if (ch === '\\') escaped = true;
            else if (ch === '"') inString = false;
        } else if (ch === '"') {
            inString = true;
        } else if (ch === '{') {
            depth++;
        } else if (ch === '}') {
            depth--;
            if (depth === 0) return text.slice(start, i + 1);
        }
    }
    return null; // 截断未闭合 —— 交给上层回退
}

/**
 * 解析模型批量翻译响应 -> [{id, text}]。
 * originalItems 是发送时的条目（已重编号为 0..n-1）。finishReason 来自
 * done_reason/finish_reason：'length' 表示输出被截断。
 * 多级容错：JSON -> 内嵌 JSON -> [id]: 标记逐行 -> 单条整段 -> 按行对齐。
 */
function parseTranslationResponse(response, originalItems, finishReason) {
    const expectedCount = originalItems.length;
    let translations = [];

    try {
        const cleanResponse = response
            .replace(/^```json\s*/m, '')
            .replace(/^```\s*/m, '')
            .replace(/\s*```$/m, '')
            .trim();
        const parsed = JSON.parse(cleanResponse);
        if (parsed.translations && Array.isArray(parsed.translations)) {
            translations = parsed.translations;
        } else if (Array.isArray(parsed)) {
            translations = parsed;
        }
    } catch (e) {
        const jsonStr = extractJsonObject(response);
        if (jsonStr) {
            try {
                const parsed = JSON.parse(jsonStr);
                if (parsed.translations && Array.isArray(parsed.translations)) {
                    translations = parsed.translations;
                } else if (Array.isArray(parsed)) {
                    translations = parsed;
                }
            } catch (e2) { /* 落到标记解析 */ }
        }
    }

    if (translations.length > 0) {
        translations = translations.map(t => ({ ...t, text: cleanTranslationText(t.text) }));

        // 模型可能回显顺序编号而非我们的 id；无法对上时按位置重映射
        const llmIds = translations.map(t => t.id);
        const ourIds = originalItems.map(t => t.id);
        const llmUsedSequential = llmIds.every((id, i) => id === i);
        const idsMismatch = !llmIds.some(id => ourIds.includes(id));
        if (llmUsedSequential || idsMismatch) {
            translations = translations.map((t, index) => ({
                id: originalItems[index] !== undefined ? originalItems[index].id : t.id,
                text: t.text,
                error: t.error
            }));
        }
        return translations;
    }

    // 单条：整段响应即译文（保留换行）
    if (expectedCount === 1) {
        const text = response.trim().replace(/^\[?\d+\]?:\s*/, '');
        return [{ id: originalItems[0].id, text: cleanTranslationText(text) }];
    }

    // [id]: 标记逐行解析，续行并入当前段
    const idMarkerRegex = /^\[?(\d+)\]?:\s*(.*)$/;
    const segments = [];
    let current = null;
    for (const line of response.split('\n')) {
        const match = line.match(idMarkerRegex);
        if (match) {
            if (current) segments.push(current);
            current = { id: parseInt(match[1]), text: match[2] };
        } else if (current) {
            current.text += '\n' + line;
        }
    }
    if (current) segments.push(current);

    // 输出被截断时，最后一段可能只写了一半 —— 丢弃它，交由重试
    if (finishReason === 'length' && segments.length > 0) {
        segments.pop();
        if (segments.length === 0) return [];
    }

    if (segments.length > 0) {
        const ids = segments.map(s => s.id);
        const ourIdSet = new Set(originalItems.map(item => item.id));
        const allOurs = ids.every(id => ourIdSet.has(id));
        const unique = new Set(ids).size === ids.length;
        if (!allOurs || !unique) return []; // 编号不可信，整体拒收走兜底

        for (const seg of segments) {
            const text = seg.text.trim();
            if (!text) continue;
            translations.push({ id: seg.id, text: cleanTranslationText(text) });
        }
        return translations;
    }

    // 最后手段：一行一条按序对齐 —— 仅当行数与条数完全一致时才可信
    // （行数不足说明模型在散文作答，按位对齐会把答案错配给前面的条目，必须拒收整批走重试）
    const lines = response.split('\n').filter(l => l.trim());
    if (lines.length === expectedCount) {
        for (let i = 0; i < lines.length; i++) {
            translations.push({ id: originalItems[i].id, text: cleanTranslationText(lines[i].trim()) });
        }
    }
    return translations;
}

// cyrb53 —— 快速非加密哈希，把提示词形态折叠进缓存键
function hashString(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
        const ch = str.charCodeAt(i);
        h1 = Math.imul(h1 ^ ch, 2654435761);
        h2 = Math.imul(h2 ^ ch, 1597334647);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (h2 >>> 0).toString(36) + (h1 >>> 0).toString(36);
}

// 归一化服务器地址：去尾斜杠与多余 /v1（我们自行拼接完整路径）；
// localhost -> 127.0.0.1（规避 IPv6 优先解析导致的连接拒绝）。
function normalizeServerUrl(rawUrl) {
    let url = (rawUrl || '').trim().replace(/\/+$/, '').replace(/\/v1$/i, '').replace(/\/+$/, '');
    try {
        const parsed = new URL(url);
        if (parsed.hostname === 'localhost') {
            parsed.hostname = '127.0.0.1';
            url = parsed.toString().replace(/\/+$/, '');
        }
    } catch (_) { /* 非法输入留给调用方的 fetch 报真实错误 */ }
    return url;
}

// 三大上下文通用导出（service worker 的 self / 页面 window / Node vm 的 globalThis）
(function (root) {
    root.splitIntoSentences = splitIntoSentences;
    root.isTranslatableText = isTranslatableText;
    root.formatTextsForPrompt = formatTextsForPrompt;
    root.buildPrompt = buildPrompt;
    root.cleanTranslationText = cleanTranslationText;
    root.isSuspiciousTranslation = isSuspiciousTranslation;
    root.extractJsonObject = extractJsonObject;
    root.parseTranslationResponse = parseTranslationResponse;
    root.hashString = hashString;
    root.normalizeServerUrl = normalizeServerUrl;
})(typeof self !== 'undefined' ? self : globalThis);
