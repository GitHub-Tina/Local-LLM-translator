/**
 * 模拟 OpenAI 兼容后端（llama.cpp / LM Studio 风格）。
 * 行为通过 MODE 环境变量切换，用于测试 background 的容错路径：
 *   MODE=ok          正常返回结构化 JSON（默认）
 *   MODE=prose       JSON 埋在散文里
 *   MODE=flaky       第一次请求返回垃圾，第二次正常（测重试）
 *   MODE=missing     丢掉最后一条（测逐条兜底）
 *   MODE=rejectschema 拒绝 response_format（400），测降级重试
 * 运行：MODE=ok PORT=18190 node test/mock-server.mjs
 */
import http from 'node:http';

const MODE = process.env.MODE || 'ok';
const PORT = parseInt(process.env.PORT || '18190', 10);

// "翻译"：给每条加前缀，便于断言映射关系
function fakeTranslate(text) {
    return `【译】${text}`;
}

function parseItems(userContent) {
    // "[0]: xxx\n[1]: yyy"
    const items = [];
    for (const line of userContent.split('\n')) {
        const m = line.match(/^\[(\d+)\]:\s*(.*)$/);
        if (m) items.push({ id: parseInt(m[1]), text: m[2] });
    }
    return items;
}

let requestCount = 0;

const server = http.createServer((req, res) => {
    const send = (status, body) => {
        res.writeHead(status, { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
    };

    if (req.method === 'GET' && req.url === '/v1/models') {
        return send(200, {
            object: 'list',
            data: [
                { id: 'qwen2.5:7b-instruct', object: 'model' },
                { id: 'test-model', object: 'model' }
            ]
        });
    }

    if (req.method === 'POST' && req.url === '/v1/chat/completions') {
        let raw = '';
        req.on('data', c => raw += c);
        req.on('end', () => {
            requestCount++;
            const body = JSON.parse(raw);
            const hasSchema = !!(body.response_format && body.response_format.type === 'json_schema');

            if (MODE === 'rejectschema' && hasSchema) {
                return send(400, { error: { message: 'response_format json_schema is not supported' } });
            }

            const userContent = (body.messages || []).filter(m => m.role === 'user').map(m => m.content).join('\n');
            // 逐条兜底请求没有 [id]: 标记（system 是纯翻译指令）——整段返回
            const items = parseItems(userContent);
            if (items.length === 0) {
                const single = userContent.trim();
                return send(200, {
                    choices: [{ message: { role: 'assistant', content: fakeTranslate(single) }, finish_reason: 'stop' }]
                });
            }

            if (MODE === 'flaky' && requestCount === 1) {
                return send(200, {
                    choices: [{ message: { role: 'assistant', content: '对不起，我不知道怎么翻译这些内容。' }, finish_reason: 'stop' }]
                });
            }

            let out;
            if (MODE === 'prose') {
                out = `好的，以下是翻译：\n{"translations":[${items.map(i => `{"id":${i.id},"text":"${fakeTranslate(i.text)}"}`).join(',')}]}\n希望有帮助！`;
            } else if (MODE === 'missing') {
                const kept = items.slice(0, items.length - 1);
                out = JSON.stringify({ translations: kept.map(i => ({ id: i.id, text: fakeTranslate(i.text) })) });
            } else {
                out = JSON.stringify({ translations: items.map(i => ({ id: i.id, text: fakeTranslate(i.text) })) });
            }
            return send(200, {
                choices: [{ message: { role: 'assistant', content: out }, finish_reason: 'stop' }]
            });
        });
        return;
    }

    send(404, { error: 'not found' });
});

server.listen(PORT, '127.0.0.1', () => {
    console.log(`mock server (${MODE}) listening on http://127.0.0.1:${PORT}`);
});
