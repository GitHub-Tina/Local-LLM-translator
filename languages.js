/**
 * languages.js — 语言表、模型请求格式规则、宿主权限工具。
 * background（importScripts）、popup/options（<script>）共用。
 */

const LANGUAGES = {
    af: "Afrikaans", am: "Amharic", ar: "Arabic", az: "Azerbaijani",
    be: "Belarusian", bg: "Bulgarian", bn: "Bengali", bs: "Bosnian",
    ca: "Catalan", cs: "Czech", cy: "Welsh", da: "Danish", de: "German",
    el: "Greek", en: "English", es: "Spanish", et: "Estonian", eu: "Basque",
    fa: "Persian", fi: "Finnish", fil: "Filipino", fr: "French", ga: "Irish",
    gl: "Galician", gu: "Gujarati", he: "Hebrew", hi: "Hindi", hr: "Croatian",
    hu: "Hungarian", hy: "Armenian", id: "Indonesian", is: "Icelandic",
    it: "Italian", ja: "Japanese", ka: "Georgian", kk: "Kazakh", km: "Khmer",
    kn: "Kannada", ko: "Korean", ky: "Kyrgyz", lo: "Lao", lt: "Lithuanian",
    lv: "Latvian", mg: "Malagasy", mi: "Maori", mk: "Macedonian", ml: "Malayalam",
    mn: "Mongolian", ms: "Malay", mt: "Maltese", my: "Burmese", ne: "Nepali",
    nl: "Dutch", no: "Norwegian", pa: "Punjabi", pl: "Polish", ps: "Pashto",
    pt: "Portuguese", ro: "Romanian", ru: "Russian", si: "Sinhala", sk: "Slovak",
    sl: "Slovenian", sq: "Albanian", sr: "Serbian", sv: "Swedish", sw: "Swahili",
    ta: "Tamil", te: "Telugu", th: "Thai", tr: "Turkish", uk: "Ukrainian",
    ur: "Urdu", uz: "Uzbek", vi: "Vietnamese", yi: "Yiddish", yo: "Yoruba",
    zh: "Chinese", zu: "Zulu"
};

// 常用语言排在选择器前面（其余按字母序）
const COMMON_LANGUAGES = ['zh', 'en', 'ja', 'ko', 'de', 'fr', 'es', 'ru', 'pt', 'it'];

function getLanguageName(code) {
    const baseCode = String(code || '').split('-')[0].toLowerCase();
    return LANGUAGES[baseCode] || code;
}

function getSortedLanguageCodes() {
    const rest = Object.keys(LANGUAGES).filter(c => !COMMON_LANGUAGES.includes(c)).sort();
    return [...COMMON_LANGUAGES, ...rest];
}

// ============================================================================
// 模型 -> 请求格式映射（单一事实来源）
// plainText: true 表示该模型输出裸译文，不走 JSON 批处理协议。
const MODEL_FORMAT_RULES = [
    { format: 'translategemma', plainText: true, patterns: ['translategemma', 'translate-gemma', 'translate_gemma'] },
    { format: 'hunyuan', plainText: true, patterns: ['hunyuan-mt', 'hunyuanmt', 'hunyuan_mt', 'hy-mt', 'hy_mt'] }
];

const PLAIN_TEXT_FORMATS = new Set(MODEL_FORMAT_RULES.filter(r => r.plainText).map(r => r.format));

function detectRequestFormat(modelId) {
    if (!modelId) return 'default';
    const id = modelId.toLowerCase();
    for (const rule of MODEL_FORMAT_RULES) {
        if (rule.patterns.some(p => id.includes(p))) return rule.format;
    }
    return 'default';
}

function resolveRequestFormat(settings, modelId) {
    const fmt = settings && settings.requestFormat;
    if (!fmt || fmt === 'auto') {
        return detectRequestFormat(modelId || (settings && settings.selectedModel));
    }
    return fmt;
}

// ============================================================================
// 非本机服务器需要按源申请宿主权限（localhost/127.0.0.1 已被静态授权覆盖）。
const LOCAL_HOSTNAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

function hostPermissionPattern(rawUrl) {
    if (!rawUrl) return null;
    let u;
    try { u = new URL(rawUrl); } catch (e) { return null; }
    if (LOCAL_HOSTNAMES.has(u.hostname)) return null;
    return `${u.protocol}//${u.hostname}/*`;
}

async function ensureHostPermissions(urls) {
    const api = (typeof browser !== 'undefined') ? browser : chrome;
    const patterns = [...new Set((urls || []).map(hostPermissionPattern).filter(Boolean))];
    if (!patterns.length) return true;
    try {
        return await api.permissions.request({ origins: patterns });
    } catch (e) {
        console.error('宿主权限申请失败:', e);
        return false;
    }
}

(function (root) {
    root.LANGUAGES = LANGUAGES;
    root.COMMON_LANGUAGES = COMMON_LANGUAGES;
    root.getLanguageName = getLanguageName;
    root.getSortedLanguageCodes = getSortedLanguageCodes;
    root.MODEL_FORMAT_RULES = MODEL_FORMAT_RULES;
    root.PLAIN_TEXT_FORMATS = PLAIN_TEXT_FORMATS;
    root.detectRequestFormat = detectRequestFormat;
    root.resolveRequestFormat = resolveRequestFormat;
    root.hostPermissionPattern = hostPermissionPattern;
    root.ensureHostPermissions = ensureHostPermissions;
})(typeof self !== 'undefined' ? self : globalThis);
