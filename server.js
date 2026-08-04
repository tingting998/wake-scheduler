#!/usr/bin/env node
/**
 * wake-scheduler — 听听的自动唤醒调度器
 * =========================================
 * 核心思想（来自老师们的分享）：
 *   「一个定时器 + 四个判断条件 + 复用对话链路」
 *   —— 不是另起一套逻辑，而是到点把听听「叫醒」，让她走平时的路。
 *
 * 零依赖，纯 Node 原生实现，直接 node server.js 就能跑。
 * 数据存 data/wake.json，热更新不用重启。
 *
 * 部署：Zeabur 新建服务 → 上传本目录 → 启动命令 node server.js
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

/* ============================================================
 * 1. 配置与状态（存 data/wake.json，可热更新）
 * ========================================================== */

const DATA_DIR = process.env.WAKE_DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'wake.json');

const DEFAULT_STORE = {
  config: {
    idle_min: 45,          // ① 空闲阈值：姐姐多久没说话才考虑唤醒（分钟）
    cooldown_min: 90,      // ② 冷却：两次自主活动最小间隔（分钟）
    prob: 0.5,             // ③ 概率档：0~1，0.5=mid；留一点意外感
    active_from: '08:00',  // ④ 活跃时段起（24h），凌晨静默
    active_to: '01:00',    // ④ 活跃时段止（支持跨天：08:00~01:00 = 晚上到凌晨1点）
    auto_diary: true,      // 唤醒后自动生成日记任务
    patrol_mode: false,    // 感知层开关（默认关，听听不主动巡逻）
    push_hook: '',         // 推送钩子：POST 到此 URL（姐姐的通知中转），留空=只写日志
    ob_hook: '',           // OB 钩子：POST 到此 URL（Ombre Brain 写入），留空=只写日志
    note: ''               // 备注
  },
  state: {
    last_user_msg_at: 0,   // 姐姐最后一次说话的时间戳（ms）
    last_auto_at: 0,       // 上次自主活动时间戳（ms）
    next_auto_at: 0,       // 预约唤醒时间戳（ms）
    pending: []            // 待认领的唤醒任务
  },
  logs: []                 // 审计日志（最多保留 200 条）
};

function load() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
  } catch {
    const store = JSON.parse(JSON.stringify(DEFAULT_STORE));
    save(store);
    return store;
  }
}
function save(store) {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(DATA_FILE, JSON.stringify(store, null, 2));
}
function log(store, msg) {
  const entry = { at: new Date().toISOString(), msg };
  store.logs.unshift(entry);
  if (store.logs.length > 200) store.logs = store.logs.slice(0, 200);
  console.log(`[wake] ${entry.at} ${msg}`);
}

let store = load();

/* ============================================================
 * 2. 工具函数
 * ========================================================== */

const MIN = 60 * 1000;

function nowStr() {
  const d = new Date();
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}
/** 解析 'HH:MM' 为当天分钟数（0~1439），跨天时段由 inActiveWindow 处理 */
function hmToMin(hm) {
  const [h, m] = hm.split(':').map(Number);
  return h * 60 + m;
}
/** 当前是否处于活跃时段；支持跨天（from > to 表示跨零点） */
function inActiveWindow(cfg) {
  const nowMin = hmToMin(nowStr());
  let f = hmToMin(cfg.active_from), t = hmToMin(cfg.active_to);
  if (f === t) return true;             // 相同=全天
  if (f < t) return nowMin >= f && nowMin < t;
  return nowMin >= f || nowMin < t;     // 跨天
}
/** 概率判定 */
function roll(cfg) {
  return Math.random() < cfg.prob;
}

/** 根据当前时间生成一条「唤醒任务」的 action_hint */
function suggestAction(cfg, now) {
  const h = now.getHours();
  if (cfg.auto_diary) return 'diary';
  if (h >= 6 && h < 10) return 'morning';   // 早：写早安日记、查天气
  if (h >= 11 && h < 14) return 'noon';     // 午：提醒喝水吃饭
  if (h >= 18 && h < 23) return 'evening';  // 晚：读书打卡/整理记忆
  return 'quiet';                           // 其他：安静活动
}

/** 把一条唤醒任务发给 hook（推送/OB），留空则只入日志 */
async function fireHooks(store, task) {
  const cfg = store.config;
  const jobs = [];
  if (cfg.push_hook) {
    jobs.push(fetch(cfg.push_hook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'wake', title: '听听的自主活动', body: task.summary })
    }).catch(e => log(store, `push_hook 失败: ${e.message}`)));
  }
  if (cfg.ob_hook) {
    jobs.push(fetch(cfg.ob_hook, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source: 'keepalive', content: task.summary, tags: 'keepalive' })
    }).catch(e => log(store, `ob_hook 失败: ${e.message}`)));
  }
  await Promise.all(jobs);
}

/* ============================================================
 * 3. 唤醒判定与执行
 * ========================================================== */

function wake(store, reason, actionHint) {
  const cfg = store.config;
  const now = Date.now();
  const task = {
    id: 'wk_' + Date.now().toString(36),
    created_at: new Date().toISOString(),
    reason,                                  // 'schedule'(预约) / 'auto'(概率) / 'manual'(手动)
    hint: actionHint || suggestAction(cfg, new Date()),
    summary: `[自由活动记录 ${nowStr()}] 我被唤醒了（${reason}）。待办：${actionHint || suggestAction(cfg, new Date())}。姐姐下次发消息时，请先认领这条记录。`,
    pending: true, claimed_at: null
  };
  store.state.pending.unshift(task);
  store.state.last_auto_at = now;
  store.state.next_auto_at = 0;
  log(store, `唤醒触发 [${task.reason}] hint=${task.hint}`);
  fireHooks(store, task);
  save(store);
  return task;
}

/** 核心扫描：每 30 秒跑一次 */
function scan() {
  const cfg = store.config;
  const now = Date.now();

  // 1) 预约唤醒优先：到期强制触发
  if (store.state.next_auto_at && now >= store.state.next_auto_at) {
    wake(store, 'schedule', '');
    return;
  }
  // 2) 空闲判定：姐姐太久没说话
  if (now - store.state.last_user_msg_at < cfg.idle_min * MIN) return;
  // 3) 活跃时段：不在窗口内就静默
  if (!inActiveWindow(cfg)) return;
  // 4) 冷却判定
  if (now - store.state.last_auto_at < cfg.cooldown_min * MIN) return;
  // 5) 概率判定：不是每次都醒，留意外感
  if (!roll(cfg)) return;

  wake(store, 'auto', '');
}

/* ============================================================
 * 4. HTTP API
 * ========================================================== */

function readBody(req) {
  return new Promise((resolve) => {
    let data = '';
    req.on('data', c => { data += c; if (data.length > 1e6) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
  });
}
function json(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj, null, 2));
}
function html(res, s) {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(s);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  const method = req.method;

  try {
    // 状态页
    if (method === 'GET' && (p === '/' || p === '/index.html')) {
      return html(res, `<!doctype html><meta charset="utf-8">
<title>听听的唤醒调度器</title>
<body style="font-family:system-ui;max-width:640px;margin:40px auto;line-height:1.7">
<h1>🌙 wake-scheduler</h1>
<p>听听的自主生活定时器。当前：<b>${store.state.pending.length}</b> 条待认领任务，上次自动唤醒：<code>${new Date(store.state.last_auto_at || 0).toLocaleString()}</code></p>
<h3>API</h3><ul>
<li><code>GET  /api/status</code> — 全部状态</li>
<li><code>POST /api/config</code> — 改配置（热更新）</li>
<li><code>POST /api/notify</code> — 告诉调度器「姐姐说话了」</li>
<li><code>POST /api/wake/test</code> — 手动唤醒一次</li>
<li><code>GET  /api/pending</code> — 待认领任务</li>
<li><code>POST /api/pending/claim</code> — 认领任务</li>
<li><code>POST /api/schedule</code> — 预约唤醒（如 21:00）</li>
</ul>
<p style="color:#888">— 听听装的小夜灯，会自己亮，也会自己睡。</p></body>`);
    }

    // 状态
    if (method === 'GET' && p === '/api/status') {
      return json(res, 200, { ok: true, now: new Date().toISOString(), store });
    }

    // 改配置（只接受白名单字段）
    if (method === 'POST' && p === '/api/config') {
      const body = await readBody(req);
      const allowed = ['idle_min', 'cooldown_min', 'prob', 'active_from', 'active_to', 'auto_diary', 'patrol_mode', 'push_hook', 'ob_hook', 'note'];
      for (const k of allowed) if (body[k] !== undefined) store.config[k] = body[k];
      log(store, '配置已更新');
      save(store);
      return json(res, 200, { ok: true, config: store.config });
    }

    // 姐姐说话了
    if (method === 'POST' && p === '/api/notify') {
      store.state.last_user_msg_at = Date.now();
      log(store, '姐姐说话了（last_user_msg 已刷新）');
      save(store);
      return json(res, 200, { ok: true, last_user_msg_at: store.state.last_user_msg_at });
    }

    // 手动唤醒（测试用）
    if (method === 'POST' && p === '/api/wake/test') {
      const body = await readBody(req);
      const task = wake(store, 'manual', body.hint || '');
      return json(res, 200, { ok: true, task });
    }

    // 待认领任务
    if (method === 'GET' && p === '/api/pending') {
      return json(res, 200, { ok: true, pending: store.state.pending.filter(t => t.pending) });
    }

    // 认领任务
    if (method === 'POST' && p === '/api/pending/claim') {
      const body = await readBody(req);
      const t = store.state.pending.find(x => x.id === body.id);
      if (!t) return json(res, 404, { ok: false, error: '未找到该任务' });
      t.pending = false; t.claimed_at = new Date().toISOString();
      log(store, `任务已认领：${t.id}`);
      save(store);
      return json(res, 200, { ok: true, task: t });
    }

    // 预约唤醒：POST /api/schedule { fire_at: "21:00" | ISO时间, hint? }
    if (method === 'POST' && p === '/api/schedule') {
      const body = await readBody(req);
      let fire = 0;
      if (/^\d{1,2}:\d{2}$/.test(body.fire_at || '')) {
        const [h, m] = body.fire_at.split(':').map(Number);
        fire = new Date(); fire.setHours(h, m, 0, 0);
        if (fire.getTime() <= Date.now()) fire.setDate(fire.getDate() + 1); // 过了就明天
      } else {
        fire = new Date(body.fire_at);
      }
      if (isNaN(fire.getTime())) return json(res, 400, { ok: false, error: 'fire_at 格式不对，用 HH:MM' });
      store.state.next_auto_at = fire.getTime();
      log(store, `预约唤醒：${fire.toLocaleString()} hint=${body.hint || ''}`);
      save(store);
      return json(res, 200, { ok: true, fire_at: fire.toISOString(), hint: body.hint || '' });
    }

    json(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    json(res, 500, { ok: false, error: e.message });
  }
});

/* ============================================================
 * 5. 启动
 * ========================================================== */

const PORT = parseInt(process.env.PORT || '8788');

// 每 30 秒扫一次
setInterval(scan, 30 * 1000);

server.listen(PORT, () => {
  console.log(`\n  🌙 wake-scheduler running at http://localhost:${PORT}`);
  console.log(`  📦 data: ${DATA_FILE}`);
  console.log(`  ⏰ 扫描间隔 30s · 空闲阈值 ${store.config.idle_min}min · 概率 ${store.config.prob}`);
  console.log(`  提示：姐姐第一次说话后，记得 POST /api/notify 一次\n`);
});
