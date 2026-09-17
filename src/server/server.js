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
const { IdentityCore, CLAIM_STATUS } = require('../identity/identity');

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
  // 身份审核与交易核心共用同一个数据库文件。
  // attention：IdentityCore 会建 users 表（IF NOT EXISTS），
  // 结构跟 TradeCore 一致，所以谁先建都行，不会打架。
  const identity = new IdentityCore(DB_PATH);

  // 首次启动时造两个演示用户，方便你立刻上手试
  seedDemoUsers(core, identity);

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const p = url.pathname;

    // ── API 路由 ──────────────────────────────────────────────
    if (p.startsWith('/api/')) {
      try {
        await handleApi(req, res, p, core, identity);
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

  return { server, core, identity };
}

async function handleApi(req, res, p, core, identity) {
  // ── 发布交易 ──────────────────────────────────────────────
  //
  // 注意流程变了：发布前必须先过身份这一关。
  // 老板拍板的分界线：「允许浏览，不允许发布和下单」——
  //   浏览是零风险高价值的行为（他看，你就赢得了审核他的时间）；
  //   发布和接单是会产生责任的行为，没确认身份的人不配产生责任。
  if (p === '/api/publish' && req.method === 'POST') {
    const b = await readBody(req);

    if (!b.nickname || !String(b.nickname).trim()) {
      throw new Error('请填写昵称');
    }
    const nickname = String(b.nickname).trim().slice(0, 20);
    const studentNo = b.studentNo ? String(b.studentNo).trim().slice(0, 20) : null;
    const realName = b.realName ? String(b.realName).trim().slice(0, 20) : null;

    // ── 第一步：确定身份 ────────────────────────────────────
    let userId;

    if (studentNo && realName) {
      // 有学号 + 真实姓名 → 走审核流程
      //
      // ⚠️ 这里踩过一个真 bug（端到端测试抓出来的）：
      //    最初只查「这个学号有没有通过审核的主人」，查到就直接认成同一人。
      //    结果——只要知道同学号，随便填个名字就能顶替，实名形同虚设。
      //    所以查到主人之后，必须再比一次姓名；姓名不符就是真冲突。
      const owner = core.db
        .prepare('SELECT id, nickname FROM users WHERE student_no = ? AND verified = 1')
        .get(studentNo);

      if (owner) {
        // 学号有主人 → 核对姓名是不是同一个人
        const ownerClaim = identity.db.prepare(
          `SELECT real_name FROM identity_claims
            WHERE user_id = ? AND status = 'verified' LIMIT 1`
        ).get(owner.id);

        if (ownerClaim && ownerClaim.real_name === realName) {
          // 姓名也对得上 → 认成本人，放行。
          //
          // ⚠️ 这里要说清楚一道「设计的边界」，免得你以后看到这个分支觉得是漏洞：
          //
          //   在「没有密码、没有登录态」的前提下，「本人二次来访」和
          //   「另一个人知道你的学号+姓名」在信息层面是完全一样的，
          //   系统无法区分。
          //
          //   所以这一段不是漏洞，是设计固有的局限。真正解决它要靠
          //   「登录」（密码 / 短信 / 人脸）——那是下一步的事。
          //   现在这个阶段，学号+姓名是唯一的凭证，认第一个来的人。
          userId = owner.id;
        } else {
          // 姓名对不上 → 有人在用别人的学号，走冲突流程
          const conflictId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
          const result = identity.submit({
            userId: conflictId, nickname, studentNo, realName,
          });
          sendJson(res, 200, {
            ok: false,
            needReview: true,
            identityStatus: result.status,
            user: result.user,
            message:
              `学号 ${studentNo} 已被他人登记，且你填的姓名与登记的不一致——` +
              `已提交人工审核。若你确实是本人（比如只是换了设备），请等待核实。`,
          });
          return;
        }
      } else {
        // 学号没有主人 → 尝试提交身份声明（可能自动通过，也可能进待审）
        const newId = 'u_' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

        let result;
        try {
          result = identity.submit({ userId: newId, nickname, studentNo, realName });
        } catch (e) {
          // 提交被拒（学号格式不对、已有待审声明等）→ 直接冒泡给前端
          throw e;
        }

        // 待审 / 挂起 → 不能发布，但要把状态明确告诉用户
        if (result.status !== CLAIM_STATUS.VERIFIED) {
          sendJson(res, 200, {
            ok: false,
            needReview: true,
            identityStatus: result.status,
            user: result.user,
            message: result.message,
          });
          return;
        }

        userId = newId;
      }
    } else if (studentNo && !realName) {
      // 填了学号没填姓名 → 审核机制没法判断归属，要求补全
      throw new Error('填了学号就要一并填写真实姓名，否则无法核验身份');
    } else {
      // 完全没填学号 → 匿名用户，能浏览但不能发布
      throw new Error('发布需要先完成学号实名，请填写学号和真实姓名（现在可以先去浏览）');
    }

    // ── 第二步：二次确认身份仍然有效 ────────────────────────
    // 这一步看着多余（上面不是刚验过吗），但很有必要：
    // owner 分支是通过 users 表查到的，而 users.student_no 可能被
    // 管理操作改过；这里再查一次 claim，是「防御性编程」的惯例——
    // 发布这种会产生责任的动作，值得多花一次查询确认。
    const st = identity.getStatus(userId);
    if (!st.canTransact) {
      throw new Error(
        (st.reason || '身份未通过核验') + '——身份通过后才能发布'
      );
    }

    // ── 第三步：校验内容并落库 ──────────────────────────────
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
      identityStatus: CLAIM_STATUS.VERIFIED,
      message: '发布成功',
    });
    return;
  }

  // ── 身份状态查询（前端用来显示「你现在能不能发」）──────────
  if (p === '/api/identity/status' && req.method === 'GET') {
    const url = new URL(req.url, 'http://localhost');
    const studentNo = url.searchParams.get('studentNo');
    if (!studentNo) throw new Error('请提供学号');

    const user = core.db
      .prepare('SELECT id FROM users WHERE student_no = ? AND verified = 1')
      .get(studentNo);

    if (user) {
      sendJson(res, 200, {
        ok: true,
        stage: CLAIM_STATUS.VERIFIED,
        canBrowse: true,
        canTransact: true,
        message: '身份已通过核验',
      });
      return;
    }

    // 没通过：看看有没有在审核中的声明
    const claim = identity.db.prepare(
      `SELECT status, reason FROM identity_claims
        WHERE student_no = ? ORDER BY id DESC LIMIT 1`
    ).get(studentNo);

    sendJson(res, 200, {
      ok: true,
      stage: claim ? claim.status : 'none',
      canBrowse: true,
      canTransact: false,
      message: claim ? claim.reason : '该学号尚未提交过身份声明',
    });
    return;
  }

  // ── 待审队列（给人工审核用，实际项目里要加鉴权）───────────
  if (p === '/api/identity/pending' && req.method === 'GET') {
    sendJson(res, 200, { ok: true, pending: identity.listPending({ limit: 50 }) });
    return;
  }

  // ── 人工裁定 ──────────────────────────────────────────────
  if (p === '/api/identity/review' && req.method === 'POST') {
    const b = await readBody(req);
    const claim = identity.review({
      claimId: Number(b.claimId),
      reviewerId: b.reviewerId || 'admin_demo',
      decision: b.decision,
      note: b.note,
    });
    sendJson(res, 200, { ok: true, claim, message: '裁定完成' });
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
    const pending = identity.db.prepare(
      `SELECT COUNT(*) AS n FROM identity_claims WHERE status IN ('pending','held')`
    ).get();
    sendJson(res, 200, {
      ok: true,
      users: users.n,
      trades: trades.n,
      pendingReview: pending.n,
    });
    return;
  }

  throw new Error('没有这个接口: ' + p);
}

// 首次启动造演示数据
function seedDemoUsers(core, identity) {
  const n = core.db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (n > 0) return; // 已经有数据就不重复造

  // 演示用户走完整的身份审核流程，不绕过它——
  // 这样演示数据和真实数据在同一个状态空间里，不会出现「演示用户没声明」的矛盾。
  const mk = (id, nickname, studentNo, realName) => {
    identity.submit({ userId: id, nickname, studentNo, realName });
    // users 表由 identity.submit 负责建，这里把 nickname 补齐
    core.db.prepare('UPDATE users SET nickname = ? WHERE id = ?').run(nickname, id);
  };

  mk('demo_ming', '小明', '2315402125', '何孝彬');
  mk('demo_hua', '小华', '2315402126', '黄小华');

  console.log('');
  console.log('  已创建两个演示用户（均通过身份核验）：');
  console.log('    小明（学号 2315402125 / 何孝彬）');
  console.log('    小华（学号 2315402126 / 黄小华）');
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
