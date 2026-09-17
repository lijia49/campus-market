/**
 * 网页服务（零依赖，只用 Node 自带模块）
 *
 * 为什么不用 Express 这类框架？
 *   第一版的目标是「让你看懂整个请求怎么走的」。
 *   框架会把这些细节藏起来，反而妨碍理解。
 *   等你能清楚说出「一个请求从浏览器到数据库经历了什么」，再换框架不迟。
 *
 * 职责：
 *   1. 提供静态文件（public/ 里的 HTML/CSS/JS）
 *   2. 提供 JSON 接口（/api/...），转发给 TradeCore 处理
 *   3. 把错误统一转成 JSON，别让页面白屏
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { TradeCore, STATUS } = require('../trade/trade');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(__dirname, '..', '..', 'public');
const DB_PATH = path.join(__dirname, '..', '..', 'data.db');

// 静态文件的 MIME 类型表
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

// ── 请求体解析 ────────────────────────────────────────────────
// 浏览器发来的 POST 数据是一段一段流式传过来的，
// 我们要把它们拼起来，再解析成对象。
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    const LIMIT = 1024 * 100; // 100KB 上限，防止有人塞超大请求把内存撑爆
    req.on('data', (c) => {
      size += c.length;
      if (size > LIMIT) {
        reject(new Error('请求体过大'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(new Error('请求体不是合法的 JSON'));
      }
    });
    req.on('error', reject);
  });
}

function sendJson(res, statusCode, data) {
  const body = JSON.stringify(data, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

// ── 静态文件服务 ──────────────────────────────────────────────
function serveStatic(req, res, urlPath) {
  // 默认打开 index.html
  let rel = urlPath === '/' ? '/index.html' : urlPath;

  // 安全：禁止用 ../ 跳出 public 目录读系统文件
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);

  // 再确认一次最终路径确实在 public 里面
  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
    res.end('禁止访问');
    return;
  }

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('找不到该文件');
      return;
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Content-Length': data.length,
    });
    res.end(data);
  });
}

// ══ 主服务 ═══════════════════════════════════════════════════

function createServer() {
  const core = new TradeCore(DB_PATH);

  // 首次启动时造两个演示用户，方便你立刻上手试
  seedDemoUsers(core);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    // ── API 路由 ──────────────────────────────────────────────
    if (p.startsWith('/api/')) {
      try {
        await handleApi(req, res, p, core);
      } catch (e) {
        // 业务错误（余额不足、状态不对等）返回 400，让前端能显示原因
        sendJson(res, 400, { ok: false, error: e.message || String(e) });
      }
      return;
    }

    // ── 静态文件 ──────────────────────────────────────────────
    if (req.method !== 'GET') {
      res.writeHead(405);
      res.end('方法不允许');
      return;
    }
    serveStatic(req, res, p);
  });

  return { server, core };
}

async function handleApi(req, res, p, core) {
  // ── 发布交易 ──────────────────────────────────────────────
  if (p === '/api/publish' && req.method === 'POST') {
    const b = await readBody(req);

    // 简化身份：第一版没有登录，用「昵称 + 学号」现场建档
    // 同一个学号重复发布，会复用同一个用户
    if (!b.nickname || !String(b.nickname).trim()) {
      throw new Error('请填写昵称');
    }
    const nickname = String(b.nickname).trim().slice(0, 20);
    const studentNo = b.studentNo ? String(b.studentNo).trim().slice(0, 20) : null;

    // 用学号找用户，找不到就建一个
    let userId;
    if (studentNo) {
      const found = core.db.prepare('SELECT id FROM users WHERE student_no = ?').get(studentNo);
      if (found) {
        userId = found.id;
      } else {
        userId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
        core.register({ id: userId, nickname, studentNo });
      }
    } else {
      // 没填学号：每次发布都会新建一个临时用户
      userId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
      core.register({ id: userId, nickname });
    }

    // 校验发布内容
    if (!b.title || !String(b.title).trim()) throw new Error('请填写标题');
    const kind = b.kind === 'task' ? 'task' : 'goods';
    const priceYuan = Number(b.priceYuan);
    if (!Number.isFinite(priceYuan) || priceYuan < 0) throw new Error('价格格式不正确');
    if (priceYuan > 100000) throw new Error('价格超出合理范围');

    const tradeId = 't_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

    const trade = core.publish({
      tradeId,
      kind,
      title: String(b.title).trim().slice(0, 60),
      description: b.description ? String(b.description).trim().slice(0, 500) : null,
      priceYuan,
      publisherId: userId,
    });

    sendJson(res, 200, {
      ok: true,
      trade,
      publisher: core.getUser(userId),
      message: '发布成功',
    });
    return;
  }

  // ── 交易列表 ──────────────────────────────────────────────
  if (p === '/api/trades' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const kind = url.searchParams.get('kind');
    const status = url.searchParams.get('status');
    const list = core.listTrades({
      kind: kind && ['goods', 'task'].includes(kind) ? kind : null,
      status: status && Object.values(STATUS).includes(status) ? status : null,
      limit: 100,
    });
    sendJson(res, 200, { ok: true, trades: list });
    return;
  }

  // ── 单个交易详情 ──────────────────────────────────────────
  if (p.startsWith('/api/trades/') && req.method === 'GET') {
    const id = decodeURIComponent(p.slice('/api/trades/'.length));
    const trade = core.getTrade(id);
    if (!trade) throw new Error('这笔交易不存在');
    sendJson(res, 200, {
      ok: true,
      trade,
      events: core.getEvents(id),
    });
    return;
  }

  // ── 健康检查 ──────────────────────────────────────────────
  if (p === '/api/health') {
    const users = core.db.prepare('SELECT COUNT(*) AS n FROM users').get();
    const trades = core.db.prepare('SELECT COUNT(*) AS n FROM trades').get();
    sendJson(res, 200, { ok: true, users: users.n, trades: trades.n });
    return;
  }

  throw new Error('没有这个接口: ' + p);
}

// 首次启动造演示数据
function seedDemoUsers(core) {
  const n = core.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return; // 已经有数据就不重复造

  core.register({ id: 'demo_ming', nickname: '小明', studentNo: '2315402125' });
  core.register({ id: 'demo_hua', nickname: '小华', studentNo: '2315402126' });

  console.log('');
  console.log('  已创建两个演示用户：');
  console.log('    小明（学号 2315402125）');
  console.log('    小华（学号 2315402126）');
}

// ══ 启动 ═════════════════════════════════════════════════════

if (require.main === module) {
  const { server } = createServer();
  server.listen(PORT, () => {
    console.log('');
    console.log('  校园二手市场 已启动');
    console.log('  ─────────────────────────────────');
    console.log('  打开浏览器访问： http://localhost:' + PORT);
    console.log('  数据库文件：     data.db');
    console.log('  按 Ctrl+C 停止');
    console.log('');
  });
}

module.exports = { createServer };
