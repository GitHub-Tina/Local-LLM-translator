/**
 * textutils.js 纯函数单元测试（Node vm 沙箱）。
 * 运行：node test/test-textutils.js
 */
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.join(__dirname, '..');

function loadSandbox(file) {
    const code = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const sandbox = { console, URL, setTimeout, clearTimeout };
    sandbox.self = sandbox;
    vm.createContext(sandbox);
    vm.runInContext(code, sandbox, { filename: file });
    return sandbox;
}

let passed = 0, failed = 0;
function check(name, cond, detail) {
    if (cond) { passed++; console.log(`  ✓ ${name}`); }
    else { failed++; console.error(`  ✗ ${name}${detail ? ' — ' + detail : ''}`); }
}

function eq(a, b) { return JSON.stringify(a) === JSON.stringify(b); }

const tu = loadSandbox('textutils.js');

// ---------------------------------------------------------------- 分句
console.log('\n[splitIntoSentences]');
{
    const r = tu.splitIntoSentences('Hello world. This is sentence two! And three?');
    check('英文按句切分', r.length === 3, JSON.stringify(r));
}
{
    const r = tu.splitIntoSentences('第一句。第二句！第三句？');
    check('中文标点切分', r.length === 3, JSON.stringify(r));
}
{
    const r = tu.splitIntoSentences('The value is 3.14 exactly. Next.');
    check('小数点不切分', r.length === 2, JSON.stringify(r));
}
{
    const r = tu.splitIntoSentences('One line without terminator');
    check('无终止符整段返回', r.length === 1 && r[0] === 'One line without terminator');
}
{
    const r = tu.splitIntoSentences('');
    check('空串返回空数组', eq(r, []));
}

// ---------------------------------------------------------------- 可翻译判断
console.log('\n[isTranslatableText]');
check('普通英文可翻译', tu.isTranslatableText('Hello') === true);
check('纯数字不可翻译', tu.isTranslatableText('12345') === false);
check('纯标点不可翻译', tu.isTranslatableText('!!! ...') === false);
check('单字符不可翻译', tu.isTranslatableText('a') === false);
check('中文可翻译', tu.isTranslatableText('你好世界') === true);

// ---------------------------------------------------------------- 响应解析
console.log('\n[parseTranslationResponse]');
const items = [{ id: 0, text: 'a' }, { id: 1, text: 'b' }, { id: 2, text: 'c' }];

{
    const r = tu.parseTranslationResponse('{"translations":[{"id":0,"text":"甲"},{"id":1,"text":"乙"},{"id":2,"text":"丙"}]}', items);
    check('标准 JSON 全量解析', r.length === 3 && r[0].text === '甲' && r[2].text === '丙', JSON.stringify(r));
}
{
    const r = tu.parseTranslationResponse('```json\n{"translations":[{"id":0,"text":"甲"},{"id":1,"text":"乙"},{"id":2,"text":"丙"}]}\n```', items);
    check('markdown 代码块包裹的 JSON', r.length === 3, JSON.stringify(r));
}
{
    const r2 = tu.parseTranslationResponse('好的：\n{"translations":[{"id":0,"text":"甲"},{"id":1,"text":"乙"},{"id":2,"text":"丙"}]}', items);
    check('散文包裹的内嵌 JSON', r2.length === 3 && r2[1].text === '乙', JSON.stringify(r2));
}
{
    // 模型回显顺序编号（0,1,2）但我们的 id 是任意值
    const myItems = [{ id: 41, text: 'a' }, { id: 77, text: 'b' }];
    const r = tu.parseTranslationResponse('{"translations":[{"id":0,"text":"甲"},{"id":1,"text":"乙"}]}', myItems);
    check('顺序编号重映射', r[0].id === 41 && r[1].id === 77, JSON.stringify(r));
}
{
    const r = tu.parseTranslationResponse('[0]: 甲\n[1]: 乙\n[2]: 丙', items);
    check('[id]: 标记逐行解析', r.length === 3 && r[1].text === '乙', JSON.stringify(r));
}
{
    const r = tu.parseTranslationResponse('[0]: 甲合并\n续行内容\n[1]: 乙\n[2]: 丙', items);
    check('标记续行并入', r.length === 3 && r[0].text.includes('续行内容'), JSON.stringify(r));
}
{
    // finishReason = 'length'：最后一段可能截断，应丢弃
    const r = tu.parseTranslationResponse('[0]: 甲\n[1]: 乙\n[2]: 被截断的半句', items, 'length');
    check('截断响应丢弃末段', r.length === 2, JSON.stringify(r));
}
{
    // 重复编号 -> 编号不可信 -> 整体拒收
    const r = tu.parseTranslationResponse('[0]: 甲\n[0]: 乙\n[5]: 丙', items);
    check('编号异常整体拒收', eq(r, []), JSON.stringify(r));
}
{
    const r = tu.parseTranslationResponse('只有一条整段译文', [{ id: 9, text: 'only' }]);
    check('单条整段响应', r.length === 1 && r[0].id === 9 && r[0].text === '只有一条整段译文');
}
{
    // JSON 里带 id 前缀回显
    const r = tu.parseTranslationResponse('{"translations":[{"id":0,"text":"[0]: 甲"},{"id":1,"text":"乙"}]}', [{ id: 3, text: 'a' }, { id: 4, text: 'b' }]);
    check('译文内 id 前缀被清洗', r[0].text === '甲', JSON.stringify(r));
}

// ---------------------------------------------------------------- 清洗与可疑判断
console.log('\n[cleanTranslationText / isSuspiciousTranslation]');
check('剥除 id 前缀', tu.cleanTranslationText('[12]: 你好') === '你好');
check('剥除泄漏标签', tu.cleanTranslationText('<div>内容</div>') === '内容');
check('保留正文小于号', tu.cleanTranslationText('a < b') === 'a < b');
check('可疑：空', tu.isSuspiciousTranslation('') === true);
check('可疑：schema 键名', tu.isSuspiciousTranslation('"translations":') === true);
check('可疑：JSON 包裹', tu.isSuspiciousTranslation('{"id": 1}') === true);
check('可疑：代码块', tu.isSuspiciousTranslation('```json x') === true);
check('正常译文不可疑', tu.isSuspiciousTranslation('你好，世界') === false);

// ---------------------------------------------------------------- URL 归一化
console.log('\n[normalizeServerUrl]');
check('去尾 /v1', tu.normalizeServerUrl('http://127.0.0.1:8080/v1/') === 'http://127.0.0.1:8080');
check('localhost -> 127.0.0.1', tu.normalizeServerUrl('http://localhost:11434') === 'http://127.0.0.1:11434');
check('去尾斜杠', tu.normalizeServerUrl('http://127.0.0.1:1234//') === 'http://127.0.0.1:1234');

// ---------------------------------------------------------------- 提示词
console.log('\n[buildPrompt / formatTextsForPrompt]');
check('变量替换', tu.buildPrompt('To {{targetLanguage}}: {{texts}}', { targetLanguage: 'Chinese', texts: 'X' }) === 'To Chinese: X');
check('批量格式化', tu.formatTextsForPrompt([{ id: 0, text: 'a' }, { id: 1, text: 'b' }]) === '[0]: a\n[1]: b');

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed > 0 ? 1 : 0);
