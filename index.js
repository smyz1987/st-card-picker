// st-card-picker: AI 选卡师
// 输入需求 → AI 从全部角色卡推荐最适合的（可配置独立 LLM API，OpenAI 兼容格式）
// 玩法：智能匹配 / 随机骰子 / 心情模式 / 盲盒
import { getContext } from '../../../extensions.js';
import { generateQuietPrompt } from '../../../../script.js';

const LS_SETTINGS = 'st-cp-settings';
const PANEL_ID = 'st-cp-panel';
const WAND_ID = 'st-cp-wand';

let settings = { enabled: true, useMain: false, baseUrl: '', apiKey: '', model: '', topN: 5 };

function loadSettings() {
    try { settings = Object.assign(settings, JSON.parse(localStorage.getItem(LS_SETTINGS) || '{}')); } catch { /* ignore */ }
}
function saveSettings() { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
loadSettings();

// ---------- 角色数据 ----------
function getAllChars() {
    try {
        const ctx = getContext();
        return (ctx && Array.isArray(ctx.characters)) ? ctx.characters : [];
    } catch { return []; }
}
function charName(c) { return String((c && (c.name || (c.data && c.data.name))) || '未知'); }
function charAvatar(c) { return String((c && (c.avatar || (c.data && c.data.avatar))) || ''); }
function charTags(c) { try { const t = (c && (c.tags || (c.data && c.data.tags))) || []; return t.join('、'); } catch { return ''; } }
function charDesc(c, n) { return truncate(String((c && (c.description || (c.data && c.data.description))) || ''), n); }
function charFirstMes(c, n) { return truncate(String((c && (c.first_mes || (c.data && c.data.first_mes))) || ''), n); }
function truncate(s, n) { return s.length > n ? s.slice(0, n) + '…' : s; }
function pickRandom(arr) { return arr[Math.floor(Math.random() * arr.length)]; }

// ---------- LLM 调用 ----------
// 主 API：直接调用酒馆官方静默生成接口，真正跟随当前主连接（支持任意主源类型）
async function mainQuiet(messages) {
    if (typeof generateQuietPrompt !== 'function') {
        throw new Error('跟随主 API 需要酒馆的静默生成接口，当前版本不可用，请改用副 API');
    }
    const prompt = messages.map(m => (m.role === 'system' ? '【系统指令】' : '【用户需求】') + '\n' + m.content).join('\n\n');
    try {
        // 长角色清单生成较慢（实测约 30-70 秒），90 秒超时兜底
        const out = await Promise.race([
            generateQuietPrompt(prompt, { quietToLoud: true }),
            new Promise((_, rej) => setTimeout(() => rej(new Error('主 API 响应超时（90秒）——请检查酒馆主 API 是否已连接（发送框不应显示"未连接到 API"），或改用副 API')), 90000)),
        ]);
        if (!out) throw new Error('主 API 返回为空');
        return String(out);
    } catch (e) {
        throw new Error('跟随主 API 生成失败：' + (e && e.message ? e.message : e));
    }
}

async function llm(messages) {
    if (settings.useMain) return mainQuiet(messages);
    const api = { baseUrl: String(settings.baseUrl || ''), apiKey: String(settings.apiKey || ''), model: String(settings.model || '') };
    if (!api.baseUrl || !api.apiKey || !api.model) {
        throw new Error('请先在设置里配置 API（Base URL / API Key / 模型）');
    }
    let url = String(api.baseUrl).trim().replace(/\/+$/, '');
    if (!/\/v\d+$/.test(url)) url += '/v1';
    url += '/chat/completions';
    // 副 API 也设超时，避免接口挂起时界面一直"挑选中"
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    let res;
    try {
        res = await fetch(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + api.apiKey },
            body: JSON.stringify({
                model: api.model,
                messages: messages,
                temperature: 0.7,
                max_tokens: 1600,
            }),
            signal: ctrl.signal,
        });
    } catch (e) {
        if (e && e.name === 'AbortError') throw new Error('副 API 响应超时（120秒）——请检查 Base URL / Key / 网络');
        throw e;
    } finally {
        clearTimeout(timer);
    }
    if (!res.ok) {
        let msg = 'HTTP ' + res.status;
        try { const j = await res.json(); msg += ': ' + (j.error && (j.error.message || j.error)) || JSON.stringify(j).slice(0, 200); } catch { /* ignore */ }
        throw new Error(msg);
    }
    const j = await res.json();
    const text = j && j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content;
    if (!text) throw new Error('API 返回为空');
    return String(text);
}

// 拉取模型列表（OpenAI 兼容 /models 接口），填到模型下拉
async function fetchModels(baseUrl, apiKey) {
    let url = String(baseUrl || '').trim().replace(/\/+$/, '');
    if (!url) return [];
    const tryUrls = /\/v\d+$/i.test(url) ? [url + '/models'] : [url + '/models', url + '/v1/models'];
    for (const u of tryUrls) {
        try {
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 15000);
            let res;
            try {
                res = await fetch(u, { headers: { 'Authorization': 'Bearer ' + apiKey }, signal: ctrl.signal });
            } finally { clearTimeout(timer); }
            if (!res.ok) continue;
            const j = await res.json();
            const models = (j && Array.isArray(j.data)) ? j.data.map(m => m && m.id).filter(Boolean) : [];
            if (models.length) return models;
        } catch { /* try next */ }
    }
    return [];
}

// ---------- 智能匹配 ----------
const CHUNK_BUDGET = 12000;   // 单片字符预算（AI 每次只看这么多角色）
const MAX_CHUNKS = 6;         // 最大分片数（角色再多也最多切 6 片，全库覆盖）

function buildCharBlock(c) {
    const name = charName(c);
    const tags = charTags(c);
    const desc = charDesc(c, 180);
    const first = charFirstMes(c, 120);
    return '【' + name + '】' + (tags ? '\n标签: ' + tags : '') + (desc ? '\n人设: ' + desc : '') + (first ? '\n开场白: ' + first : '');
}

function buildCharChunks() {
    const chars = getAllChars();
    if (!chars.length) return [];
    // 先按预算顺序分片（每片 ≤ CHUNK_BUDGET 字符）
    const chunks = [];
    let cur = [];
    let used = 0;
    for (const c of chars) {
        const block = buildCharBlock(c);
        if (used + block.length > CHUNK_BUDGET && cur.length) {
            chunks.push(cur);
            cur = [];
            used = 0;
        }
        cur.push(block);
        used += block.length;
    }
    if (cur.length) chunks.push(cur);
    // 角色特别多时，超过上限则摊平成 MAX_CHUNKS 片，保证全库都进视野
    if (chunks.length > MAX_CHUNKS) {
        const all = chunks.flat();
        const per = Math.ceil(all.length / MAX_CHUNKS);
        const merged = [];
        for (let i = 0; i < all.length; i += per) merged.push(all.slice(i, i + per));
        return merged;
    }
    return chunks;
}

function parseLLMArray(out) {
    let cleaned = String(out).trim();
    cleaned = cleaned.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
    const start = cleaned.indexOf('[');
    const end = cleaned.lastIndexOf(']');
    if (start < 0 || end < start) throw new Error('AI 返回格式无法解析：' + out.slice(0, 120));
    const arr = JSON.parse(cleaned.slice(start, end + 1));
    if (!Array.isArray(arr)) throw new Error('AI 返回不是数组');
    return arr;
}

// 角色名归一化：去掉空白/标点/括号备注，用于 AI 返回名与角色卡名对不上时的模糊匹配
function normalizeName(s) {
    return String(s || '').replace(/[\s\u3000\t\r\n（）()【】\[\]『』「」《》〈〉""''：:、，,。.!！?？·—\-_*~`·]+/g, '').toLowerCase();
}
function findCharFuzzy(name, chars) {
    const n = normalizeName(name);
    if (!n) return null;
    // 1) 精确名
    let c = chars.find(x => charName(x) === String(name).trim());
    if (c) return c;
    // 2) 归一化后精确
    c = chars.find(x => normalizeName(charName(x)) === n);
    if (c) return c;
    // 3) 相互包含（AI 可能截断/多字）
    c = chars.find(x => { const cn = normalizeName(charName(x)); return cn && (cn.includes(n) || n.includes(cn)) && Math.min(cn.length, n.length) >= 2; });
    return c || null;
}

async function matchCards(userInput, onProgress) {
    const chunks = buildCharChunks();
    if (!chunks.length) throw new Error('角色库为空');
    const sys = '你是一位懂角色扮演、懂人物设定的选卡助手。用户会告诉你此刻想玩的「感觉/需求」，你要从给出的角色卡清单中挑选最适合的 ' + settings.topN + ' 张，按匹配度从高到低排列。' +
        '判断依据：需求与角色人设、标签、开场白风格的契合度。' +
        '只输出 JSON 数组，格式：[{"name":"角色名(必须与清单中的名字完全一致)","match":85,"reason":"为什么适合，结合具体人设点写"}]，不要输出其他内容。';
    const chars = getAllChars();
    const all = [];
    const errors = [];
    let timeoutCount = 0;
    // 分片全扫：每个分片都让 AI 挑一次，保证全库角色都进入过视野
    for (let i = 0; i < chunks.length; i++) {
        const chunk = chunks[i];
        if (typeof onProgress === 'function') onProgress(i + 1, chunks.length);
        const user = '我现在的需求：' + userInput + '\n\n角色卡清单（这是角色库的一部分）：\n' + chunk.join('\n');
        try {
            const out = await llm([
                { role: 'system', content: sys },
                { role: 'user', content: user },
            ]);
            timeoutCount = 0;
            const arr = parseLLMArray(out);
            for (const item of arr) {
                const c = findCharFuzzy(String(item.name), chars) || null;
                all.push({ name: String(item.name), match: Number(item.match) || 0, reason: String(item.reason || ''), char: c });
            }
        } catch (e) {
            const msg = String(e.message || e);
            // 明确的连接类错误立即停止；超时先记一次，连续两片超时才停（避免偶发慢生成误杀）
            if (/未连接|连接失败|HTTP|Failed to fetch|network|Network|fetch|返回为空/i.test(msg)) throw new Error(msg);
            if (/超时/i.test(msg)) {
                timeoutCount++;
                if (timeoutCount >= 2) throw new Error(msg);
            }
            errors.push(msg);
        }
    }
    if (!all.length) throw new Error(errors[0] || 'AI 没有返回任何推荐');
    // 合并去重：同名保留 match 高者，按 match 降序，取 topN
    const seen = new Map();
    for (const item of all) {
        const k = item.name;
        if (!seen.has(k) || item.match > seen.get(k).match) seen.set(k, item);
    }
    return Array.from(seen.values()).sort((a, b) => b.match - a.match).slice(0, Number(settings.topN) || 5);
}

// ---------- 心情模式（本地关键词预筛 + 可选 AI 精推） ----------
const MOODS = {
    '🍬 甜宠': ['甜', '宠', '温柔', '治愈', '恋爱', '软萌', '体贴', '阳光', '黏人', '暖'],
    '🩸 黑深残': ['黑暗', '血腥', '虐', '疯狂', '病娇', '扭曲', '绝望', '阴郁', '残酷', '病态'],
    '🕵️ 悬疑': ['悬疑', '侦探', '谜', '案件', '秘密', '推理', '阴谋', '神秘', '调查', '真相'],
    '☕ 日常': ['日常', '轻松', '生活', '陪伴', '闲聊', '温馨', '平淡', '室友', '校园'],
    '⚔️ 冒险': ['冒险', '战斗', '世界', '旅程', '勇者', '奇幻', '魔法', '异世界', '探索', '史诗'],
    '🚀 科幻': ['科幻', '未来', 'AI', '机器人', '宇宙', '赛博', '机械', '科技', '仿生', '太空'],
    '🌿 治愈': ['治愈', '温柔', '安慰', '拥抱', '安静', '植物', '猫咪', '音乐', '风', '光'],
};
function moodKeywords(moodLabel) {
    const m = MOODS[moodLabel];
    return m ? m : [];
}
function localMoodMatch(moodLabel) {
    const kws = moodKeywords(moodLabel);
    const chars = getAllChars();
    return chars.filter(c => {
        const hay = (charName(c) + charTags(c) + charDesc(c, 300) + charFirstMes(c, 200)).toLowerCase();
        return kws.some(k => hay.includes(k.toLowerCase()));
    });
}

// ---------- 面板 UI ----------
function escapeHtml(s) {
    return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function buildSettingsHTML() {
    return '<div class="st-cp-title">AI 选卡师 · 设置</div>' +
        '<div class="st-cp-row st-cp-toggle"><label for="st-cp-enabled">启用选卡师</label>' +
        '<span class="st-cp-switch"><input type="checkbox" id="st-cp-enabled"' + (settings.enabled ? ' checked' : '') + '></span>' +
        '<span class="st-cp-toggle-tip" id="st-cp-enabled-tip">' + (settings.enabled ? '已启用' : '已停用（入口会变灰）') + '</span></div>' +
        '<div class="st-cp-row st-cp-toggle"><label for="st-cp-usemain">使用酒馆主 API</label>' +
        '<span class="st-cp-switch"><input type="checkbox" id="st-cp-usemain"' + (settings.useMain ? ' checked' : '') + '></span>' +
        '<span class="st-cp-toggle-tip">复用酒馆当前主连接，副 API 不填</span></div>' +
        '<div class="st-cp-row" id="st-cp-row-baseurl"><label>API Base URL（副 API）</label><input type="text" id="st-cp-baseurl" placeholder="https://api.example.com" value="' + escapeHtml(settings.baseUrl) + '"></div>' +
        '<div class="st-cp-row" id="st-cp-row-apikey"><label>API Key（副 API）</label><input type="password" id="st-cp-apikey" placeholder="sk-..." value="' + escapeHtml(settings.apiKey) + '"></div>' +
        '<div class="st-cp-row" id="st-cp-row-model"><label>模型 <span class="st-cp-mini-btn" id="st-cp-fetch-models">🔄 自动拉取</span></label>' +
        '<input type="text" id="st-cp-model" list="st-cp-models" placeholder="gpt-4o-mini / gemini-..." value="' + escapeHtml(settings.model) + '">' +
        '<datalist id="st-cp-models"></datalist></div>' +
        '<div class="st-cp-row"><label>推荐数量</label><input type="number" id="st-cp-topn" min="1" max="10" value="' + Number(settings.topN) + '"></div>' +
        '<div class="st-cp-btn-row"><div class="st-cp-action" id="st-cp-save-settings">保存设置</div></div>' +
        '<div class="st-cp-note">智能匹配/生日等需要调用的玩法走 API：勾选「使用酒馆主 API」则复用主连接；不勾选则用下方副 API。点「🔄 自动拉取」可获取模型列表。</div>';
}

function buildMatchHTML() {
    return '<div class="st-cp-title">AI 选卡师 · 智能匹配</div>' +
        '<textarea id="st-cp-input" rows="3" placeholder="描述你想玩的感觉，例如：想要一个温柔病娇的妹妹，前期甜蜜后期黑化，有悬疑感……"></textarea>' +
        '<div class="st-cp-btn-row"><div class="st-cp-action" id="st-cp-do-match">✨ 让 AI 推荐</div></div>' +
        '<div class="st-cp-result" id="st-cp-result"></div>';
}

function buildDiceHTML() {
    return '<div class="st-cp-title">AI 选卡师 · 随机骰子</div>' +
        '<div class="st-cp-btn-row"><div class="st-cp-action" id="st-cp-do-dice">🎲 掷骰子</div></div>' +
        '<div class="st-cp-result" id="st-cp-dice-result"></div>';
}

function buildMoodHTML() {
    return '<div class="st-cp-title">AI 选卡师 · 心情模式</div>' +
        '<div class="st-cp-moods">' + Object.keys(MOODS).map(m => '<span class="st-cp-mood" data-mood="' + escapeHtml(m) + '">' + m + '</span>').join('') + '</div>' +
        '<div class="st-cp-result" id="st-cp-mood-result"></div>';
}

function buildBlindHTML() {
    return '<div class="st-cp-title">AI 选卡师 · 盲盒</div>' +
        '<div class="st-cp-btn-row"><div class="st-cp-action" id="st-cp-do-blind">🎁 抽一个盲盒</div></div>' +
        '<div class="st-cp-result" id="st-cp-blind-result"></div>';
}

function renderCharCard(c, extra) {
    if (!c) return '<div class="st-cp-card">（未找到对应角色卡）</div>';
    const av = charAvatar(c);
    const tags = charTags(c);
    const desc = charDesc(c, 400);
    const first = charFirstMes(c, 300);
    return '<div class="st-cp-card">' +
        (av ? '<img class="st-cp-avatar" src="' + escapeHtml(av) + '" onerror="this.style.display=\'none\'">' : '') +
        '<div class="st-cp-card-body">' +
        '<div class="st-cp-card-name">' + escapeHtml(charName(c)) + '</div>' +
        (extra ? extra : '') +
        (tags ? '<div class="st-cp-card-tags">' + escapeHtml(tags) + '</div>' : '') +
        (desc ? '<div class="st-cp-card-desc">' + escapeHtml(desc) + '</div>' : '') +
        (first ? '<div class="st-cp-card-first">「' + escapeHtml(first) + '」</div>' : '') +
        '</div></div>';
}

function openPanel() {
    const $old = $('#' + PANEL_ID);
    if ($old.length) { $old.remove(); return; }
    const $panel = $('<div id="' + PANEL_ID + '" class="st-cp-panel"></div>');
    $panel.html(
        '<div class="st-cp-tabs">' +
        '<span class="st-cp-tab active" data-tab="match">智能匹配</span>' +
        '<span class="st-cp-tab" data-tab="dice">骰子</span>' +
        '<span class="st-cp-tab" data-tab="mood">心情</span>' +
        '<span class="st-cp-tab" data-tab="blind">盲盒</span>' +
        '<span class="st-cp-tab" data-tab="settings">设置</span>' +
        '</div>' +
        '<div class="st-cp-body" id="st-cp-body"></div>'
    );
    $('body').append($panel);
    switchTab('match');
    $panel.on('mousedown.stcp touchstart.stcp', function (e) { e.stopPropagation(); });
    $panel.on('click.stcp', '.st-cp-tab', function () { switchTab($(this).attr('data-tab')); });
}

function switchTab(tab) {
    const $panel = $('#' + PANEL_ID);
    if (!$panel.length) return;
    $panel.find('.st-cp-tab').removeClass('active').filter('[data-tab="' + tab + '"]').addClass('active');
    const $body = $panel.find('#st-cp-body');
    if (tab === 'settings') $body.html(buildSettingsHTML());
    else if (tab === 'dice') $body.html(buildDiceHTML());
    else if (tab === 'mood') $body.html(buildMoodHTML());
    else if (tab === 'blind') $body.html(buildBlindHTML());
    else $body.html(buildMatchHTML());
    bindTabEvents(tab);
}

function bindTabEvents(tab) {
    const $panel = $('#' + PANEL_ID);
    if (! $panel.length) return;
    if (tab === 'settings') {
        // 副 API 行与主 API 开关联动
        const syncRows = function () {
            const useMain = $panel.find('#st-cp-usemain').is(':checked');
            $panel.find('#st-cp-row-baseurl, #st-cp-row-apikey, #st-cp-row-model').toggle(!useMain);
        };
        $panel.off('click.stcpAct').on('click.stcpAct', '#st-cp-usemain', syncRows);
        syncRows();   // 打开设置页时立即同步一次显隐
        $panel.on('change.stcpAct', '#st-cp-enabled', function () {
            $panel.find('#st-cp-enabled-tip').text($(this).is(':checked') ? '已启用' : '已停用（入口会变灰）');
        });
        $panel.on('click.stcpAct', '#st-cp-fetch-models', async function () {
            const baseUrl = String($panel.find('#st-cp-baseurl').val() || '').trim();
            const apiKey = String($panel.find('#st-cp-apikey').val() || '').trim();
            const $tip = $(this);
            if (!baseUrl || !apiKey) { $tip.text('⚠ 先填 Base URL / Key'); return; }
            $tip.text('⏳ 拉取中…');
            try {
                const models = await fetchModels(baseUrl, apiKey);
                const $dl = $panel.find('#st-cp-models');
                $dl.empty();
                models.forEach(m => $dl.append('<option value="' + escapeHtml(m) + '">'));
                $tip.text(models.length ? '✅ 已拉取 ' + models.length + ' 个' : '⚠ 未获取到模型');
            } catch { $tip.text('⚠ 拉取失败'); }
        });
        $panel.on('click.stcpAct', '#st-cp-save-settings', function () {
            settings.enabled = $panel.find('#st-cp-enabled').is(':checked');
            settings.useMain = $panel.find('#st-cp-usemain').is(':checked');
            settings.baseUrl = String($panel.find('#st-cp-baseurl').val() || '').trim();
            settings.apiKey = String($panel.find('#st-cp-apikey').val() || '').trim();
            settings.model = String($panel.find('#st-cp-model').val() || '').trim();
            settings.topN = Math.max(1, Math.min(10, Number($panel.find('#st-cp-topn').val()) || 5));
            saveSettings();
            refreshWandState();
            $panel.find('#st-cp-body').prepend('<div class="st-cp-note st-cp-ok">✓ 已保存</div>');
        });
        // 输入实时写回 settings（切换 tab 也不丢）——仅当设置 tab 可见时生效
        $panel.off('input.stcpLive').on('input.stcpLive', function () {
            if (! $panel.find('#st-cp-baseurl').length) return;   // 不在设置 tab，忽略，防止覆盖
            settings.enabled = $panel.find('#st-cp-enabled').is(':checked');
            settings.useMain = $panel.find('#st-cp-usemain').is(':checked');
            settings.baseUrl = String($panel.find('#st-cp-baseurl').val() || '').trim();
            settings.apiKey = String($panel.find('#st-cp-apikey').val() || '').trim();
            settings.model = String($panel.find('#st-cp-model').val() || '').trim();
            settings.topN = Math.max(1, Math.min(10, Number($panel.find('#st-cp-topn').val()) || 5));
        });
        // 主 API 开关：切换即时生效 + 即时保存，避免"点一次没反应"
        $panel.on('change.stcpAct', '#st-cp-usemain', function () {
            settings.useMain = $(this).is(':checked');
            syncRows();
            saveSettings();
            $panel.find('#st-cp-body').prepend('<div class="st-cp-note st-cp-ok">✓ 已切换：' + (settings.useMain ? '使用酒馆主 API' : '使用副 API') + '</div>');
        });
    } else if (tab === 'match') {
        $panel.off('click.stcpAct').on('click.stcpAct', '#st-cp-do-match', async function () {
            const input = String($panel.find('#st-cp-input').val() || '').trim();
            if (!input) { $panel.find('#st-cp-result').html('<div class="st-cp-note">先描述一下你想玩的感觉～</div>'); return; }
            const $r = $panel.find('#st-cp-result');
            $r.html('<div class="st-cp-note">AI 正在全库挑选中…</div>');
            try {
                const items = await matchCards(input, function (cur, total) {
                    $r.html('<div class="st-cp-note">AI 正在挑选中…（扫描角色库 ' + cur + '/' + total + ' 片）</div>');
                });
                $r.html(items.map(item => {
                    const extra = '<div class="st-cp-match">匹配度 ' + item.match + '%</div><div class="st-cp-reason">' + escapeHtml(item.reason) + '</div>';
                    return renderCharCard(item.char, extra);
                }).join('') || '<div class="st-cp-note">没有推荐结果</div>');
            } catch (e) {
                $r.html('<div class="st-cp-note st-cp-err">⚠ ' + escapeHtml(e.message) + '</div>');
            }
        });
    } else if (tab === 'dice') {
        $panel.off('click.stcpAct').on('click.stcpAct', '#st-cp-do-dice', function () {
            const chars = getAllChars();
            const $r = $panel.find('#st-cp-dice-result');
            if (!chars.length) { $r.html('<div class="st-cp-note">角色库为空</div>'); return; }
            const c = pickRandom(chars);
            $r.html(renderCharCard(c, '<div class="st-cp-match">🎲 随机抽中</div>'));
        });
    } else if (tab === 'mood') {
        $panel.off('click.stcpAct').on('click.stcpAct', '.st-cp-mood', function () {
            const mood = $(this).attr('data-mood');
            const $r = $panel.find('#st-cp-mood-result');
            const hits = localMoodMatch(mood);
            if (!hits.length) { $r.html('<div class="st-cp-note">「' + escapeHtml(mood) + '」暂无本地命中，试试其他心情</div>'); return; }
            const c = pickRandom(hits);
            $r.html('<div class="st-cp-note">「' + escapeHtml(mood) + '」本地命中 ' + hits.length + ' 张，随机抽一张：</div>' + renderCharCard(c));
        });
    } else if (tab === 'blind') {
        $panel.off('click.stcpAct').on('click.stcpAct', '#st-cp-do-blind', function () {
            const chars = getAllChars();
            const $r = $panel.find('#st-cp-blind-result');
            if (!chars.length) { $r.html('<div class="st-cp-note">角色库为空</div>'); return; }
            const c = pickRandom(chars);
            const clue = buildBlindClue(c);
            $r.html(
                '<div class="st-cp-note">盲盒开启 —— 看线索猜猜是谁？</div>' +
                clue +
                '<div class="st-cp-btn-row"><div class="st-cp-action" id="st-cp-blind-reveal">揭晓</div></div>'
            );
            $panel.off('click.stcpAct', '#st-cp-blind-reveal').on('click.stcpAct', '#st-cp-blind-reveal', function () {
                $r.html(renderCharCard(c, '<div class="st-cp-match">🎁 揭晓</div>'));
            });
        });
    }
}

// 构建盲盒线索：开场白够长就用开场白；太短/没有就补人设和标签，保证线索量
function buildBlindClue(c) {
    const first = charFirstMes(c, 200);
    const desc = charDesc(c, 160);
    const tags = charTags(c);
    const lines = [];
    if (first && first.trim().length >= 15) {
        lines.push('「' + first + '」');
    } else if (first && first.trim().length > 0) {
        lines.push('「' + first + '」（开场白太短，再给你补点线索）');
    } else {
        lines.push('（这个角色没有开场白，只能靠人设猜了）');
    }
    if (desc) lines.push('人设：' + desc);
    if (tags) lines.push('标签：' + tags);
    let html = escapeHtml(lines.join('\n'));
    // 角色名自动起雾（模糊隐藏），避免剧透
    const name = String(charName(c) || '').trim();
    if (name.length >= 2) {
        const nm = escapeHtml(name);
        html = html.split(nm).join('<span class="st-cp-fog">' + nm + '</span>');
    }
    return '<div class="st-cp-blind-first">' + html + '</div>';
}

// ---------- 魔法棒菜单入口注入 ----------
function refreshWandState() {
    const el = document.getElementById(WAND_ID);
    if (!el) return;
    if (settings.enabled) {
        el.style.opacity = '1';
        el.textContent = '🎴 AI 选卡师';
        el.title = 'AI 选卡师：智能匹配 / 骰子 / 心情 / 盲盒';
    } else {
        el.style.opacity = '.45';
        el.textContent = '🎴 AI 选卡师（已停用）';
        el.title = '已停用。点击打开设置可重新启用';
    }
}

function injectButton() {
    const menu = document.getElementById('extensionsMenu');
    if (!menu || document.getElementById(WAND_ID)) return;
    const el = document.createElement('div');
    el.id = WAND_ID;
    el.className = 'list-group-item flex-container flexGap5 interactable';
    el.setAttribute('tabindex', '0');
    el.addEventListener('click', function (e) {
        e.preventDefault();
        e.stopPropagation();
        openPanel();
    });
    menu.appendChild(el);
    refreshWandState();
}

$(function () {
    injectButton();
    // 兜底重注入（酒馆重绘/菜单重建后）
    setInterval(function () {
        if (!document.getElementById(WAND_ID)) injectButton();
        else refreshWandState();
    }, 3000);
});

// 点击面板外关闭
$(document).on('mousedown.stcp touchstart.stcp', function (e) {
    if (!$(e.target).closest('#' + WAND_ID).length && !$(e.target).closest('#' + PANEL_ID).length) {
        $('#' + PANEL_ID).remove();
    }
});

// ---------- CSS ----------
const STYLE_ID = 'st-cp-style';
if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = `
.st-cp-panel { position:fixed; top:12px; right:12px; z-index:99999; width:min(340px,calc(100vw - 24px)); max-height:80vh; overflow-y:auto; background:var(--SmartThemeBlurTintColor,#1e1e2e); color:var(--SmartThemeMainColor,#e0e0e0); border:1px solid var(--SmartThemeBorderColor,#666); border-radius:12px; padding:10px 12px; box-shadow:0 6px 24px rgba(0,0,0,.4); font-size:13px; }
.st-cp-tabs { display:flex; flex-wrap:wrap; gap:4px; margin-bottom:10px; }
.st-cp-tab { padding:4px 10px; border-radius:20px; cursor:pointer; font-size:12px; background:rgba(217,167,167,.15); color:#D9A7A7; }
.st-cp-tab.active { background:#D9A7A7; color:#3a2a2a; font-weight:700; }
.st-cp-title { font-weight:700; margin-bottom:8px; color:#D9A7A7; }
.st-cp-row { margin-bottom:8px; }
.st-cp-row label { display:block; font-size:12px; opacity:.8; margin-bottom:2px; }
.st-cp-row input { width:100%; box-sizing:border-box; padding:5px 8px; border-radius:6px; border:1px solid var(--SmartThemeBorderColor,#666); background:var(--SmartThemeBlurTintColor,#2a2a3a); color:var(--SmartThemeMainColor,#e0e0e0); font-size:12px; outline:none; }
.st-cp-toggle { display:flex; align-items:center; gap:8px; }
.st-cp-toggle label { flex:1; margin:0; }
.st-cp-switch { position:relative; width:34px; height:18px; flex-shrink:0; cursor:pointer; }
.st-cp-switch input { opacity:0; position:absolute; inset:0; width:100%; height:100%; margin:0; cursor:pointer; z-index:2; }
.st-cp-switch::after { content:''; position:absolute; inset:0; border-radius:18px; background:#444; transition:.2s; }
.st-cp-switch:has(input:checked)::after { background:#D9A7A7; }
.st-cp-switch::before { content:''; position:absolute; top:2px; left:2px; width:14px; height:14px; border-radius:50%; background:#fff; z-index:1; transition:.2s; }
.st-cp-switch:has(input:checked)::before { transform:translateX(16px); }
.st-cp-toggle-tip { font-size:11px; opacity:.7; flex-shrink:0; }
.st-cp-mini-btn { display:inline-block; padding:2px 8px; border-radius:12px; cursor:pointer; font-size:11px; background:rgba(217,167,167,.2); color:#D9A7A7; margin-left:6px; }
.st-cp-mini-btn:hover { background:rgba(217,167,167,.35); }
.st-cp-note { font-size:12px; opacity:.75; margin:6px 0; }
.st-cp-ok { color:#A9C3A0; }
.st-cp-err { color:#E88; }
.st-cp-btn-row { margin:8px 0; }
.st-cp-action { display:inline-block; padding:6px 16px; border-radius:20px; cursor:pointer; font-size:13px; background:#D9A7A7; color:#3a2a2a; font-weight:700; }
.st-cp-action:hover { filter:brightness(1.1); }
#st-cp-input { width:100%; box-sizing:border-box; padding:6px 8px; border-radius:6px; border:1px solid var(--SmartThemeBorderColor,#666); background:var(--SmartThemeBlurTintColor,#2a2a3a); color:var(--SmartThemeMainColor,#e0e0e0); font-size:13px; outline:none; resize:vertical; font-family:inherit; }
.st-cp-result { margin-top:4px; }
.st-cp-card { display:flex; gap:10px; padding:8px; border-radius:10px; background:rgba(217,167,167,.12); margin-bottom:8px; }
.st-cp-avatar { width:52px; height:52px; border-radius:8px; object-fit:cover; flex-shrink:0; }
.st-cp-card-body { flex:1; min-width:0; }
.st-cp-card-name { font-weight:700; color:#C9A076; margin-bottom:2px; }
.st-cp-match { font-size:12px; color:#D9B48C; margin:2px 0; font-weight:700; }
.st-cp-reason { font-size:12px; color:#C2A67F; margin:2px 0; line-height:1.5; }
.st-cp-card-tags { font-size:11px; color:#A98F6D; margin:2px 0; }
.st-cp-card-desc { font-size:12px; color:#C2A67F; margin:2px 0; word-break:break-all; }
.st-cp-card-first { font-size:12px; color:#C2A67F; margin:2px 0; font-style:italic; word-break:break-all; }
.st-cp-moods { display:flex; flex-wrap:wrap; gap:6px; margin-bottom:8px; }
.st-cp-mood { padding:5px 12px; border-radius:20px; cursor:pointer; font-size:12px; background:rgba(217,167,167,.15); color:#D9A7A7; }
.st-cp-mood:hover { background:rgba(217,167,167,.3); }
.st-cp-blind-first { font-size:13px; padding:10px; border-radius:8px; background:rgba(217,167,167,.1); margin:6px 0; white-space:pre-wrap; word-break:break-all; line-height:1.6; color:#FF8FA3; }
.st-cp-fog { filter:blur(5px); -webkit-filter:blur(5px); color:#FF8FA3; }
`;
    document.head.appendChild(style);
}
