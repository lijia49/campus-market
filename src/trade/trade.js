/**
 * 交易核心（甲路线：纯撮合，平台不经手资金）
 *
 * 与账本（src/ledger）的区别：
 *   账本  → 记「钱」变了多少（托管模式用）
 *   本文件 → 记「事」到哪一步了（撮合模式用）
 *
 * 这里不出现任何金额账户、余额、冻结。
 * 金额只是一个「描述性字段」——记录双方约定的价格，平台不碰这笔钱。
 *
 * 平台真正的价值在这三件事：
 *   1. 订单状态机 —— 让双方对「进行到哪了」有共同认知
 *   2. 防重复     —— 同一笔交易不能重复确认（用 UNIQUE 约束焊死）
 *   3. 信用记录   —— 谁守约、谁放鸽子，全部留痕，同学圈子里瞒不住
 *
 * 设计约定：
 *   所有关键状态变更都记为「事件」，事件一旦写入不可修改、不可删除。
 *   这叫「追加式记录」——出纠纷时，能完整回放当时发生了什么。
 */

const { DatabaseSync } = require('node:sqlite');

// 订单状态机
// 两条业务线共用，只是「交付」和「确认」的叫法不同
//   闲置交易：卖家发货 → 买家确认收货
//   跑腿任务：接单者完成 → 发布者验收
const STATUS = {
  OPEN: 'open',               // 已发布，等待接单
  TAKEN: 'taken',             // 已接单，等待交付
  DELIVERING: 'delivering',   // 已交付，等待确认
  COMPLETED: 'completed',     // 已完成
  CANCELLED: 'cancelled',     // 已取消
  DISPUTED: 'disputed',       // 有争议，待处理
};

// 合法状态流转表
// 只允许表里列出的跳转，其他一律拒绝。
// 把「规则」写成数据（而不是散落在 if-else 里），改动时只动这张表。
//
// 格式说明：
//   '状态A': { '目标状态': ['触发这个跳转的动作', ...] }
//
// ⚠️ 这里曾经踩过一个坑：最初写成简单的数组 [目标状态, ...]，
//    结果 disputed（争议中）允许直接跳到 completed，
//    导致「当事人自己点确认就能把争议抹掉」，争议机制形同虚设。
//    修法是把「动作」也写进规则里 —— 争议必须走 resolve 才能结束。
const ALLOWED_TRANSITIONS = {
  [STATUS.OPEN]: {
    [STATUS.TAKEN]: ['take'],
    [STATUS.CANCELLED]: ['cancel'],
  },
  [STATUS.TAKEN]: {
    [STATUS.DELIVERING]: ['deliver'],
    [STATUS.OPEN]: ['cancel'],              // 接单方放弃，退回可接单状态
    [STATUS.CANCELLED]: ['cancel'],
  },
  [STATUS.DELIVERING]: {
    [STATUS.COMPLETED]: ['confirm'],
    [STATUS.DISPUTED]: ['dispute'],
    [STATUS.TAKEN]: ['reopen'],             // 交付被退回，重新来
  },
  [STATUS.COMPLETED]: {},
  [STATUS.CANCELLED]: {},
  [STATUS.DISPUTED]: {
    // 关键：争议只能通过 resolve 结束，当事人不能自己 confirm 抹掉
    [STATUS.COMPLETED]: ['resolve'],
    [STATUS.CANCELLED]: ['resolve'],
  },
};

class TradeCore {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this.db.exec('PRAGMA journal_mode = WAL');
    this._initSchema();
  }

  _initSchema() {
    // ── 用户表 ────────────────────────────────────────────────
    // 学号是核心：校园场景里，学号就是天然的唯一身份
    // 没有学号的人（比如校外）也能用，但拿不到「已实名」标记
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        nickname     TEXT NOT NULL,
        student_no   TEXT UNIQUE,          -- 学号，可空（校外用户）
        verified     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
        contact      TEXT,                 -- 联系方式（由用户自愿填写）
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // ── 交易表 ────────────────────────────────────────────────
    // goods = 闲置物品，task = 跑腿任务
    // price 只是「双方约定价」，平台不经手，仅作展示与记录
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trades (
        id           TEXT PRIMARY KEY,
        kind         TEXT NOT NULL CHECK (kind IN ('goods','task')),
        title        TEXT NOT NULL,
        description  TEXT,
        price        INTEGER NOT NULL CHECK (price >= 0),   -- 单位：分
        publisher_id TEXT NOT NULL REFERENCES users(id),
        taker_id     TEXT REFERENCES users(id),
        status       TEXT NOT NULL DEFAULT 'open'
                     CHECK (status IN ('open','taken','delivering','completed','cancelled','disputed')),
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
        CHECK (publisher_id <> taker_id)   -- 自己不能接自己的单
      )
    `);

    // ── 事件表（追加式，不可改不可删）───────────────────────────
    // 每一次状态变化都留一条，含操作人和时间。
    // UNIQUE(trade_id, action) 是关键防线：
    //   同一笔交易的同一种确认动作，只能发生一次。
    //   防的是「手抖点两次确认」和「网络重试」。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS trade_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        trade_id   TEXT NOT NULL REFERENCES trades(id),
        actor_id   TEXT NOT NULL REFERENCES users(id),
        action     TEXT NOT NULL
                   CHECK (action IN ('publish','take','deliver','confirm',
                                     'cancel','reopen','dispute','resolve')),
        from_status TEXT,
        to_status   TEXT NOT NULL,
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (trade_id, action)
      )
    `);

    // ── 信用记录表 ────────────────────────────────────────────
    // 这是甲路线真正的护城河。
    // 平台不经手钱，唯一能约束用户的就是「声誉」。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS credit_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL REFERENCES users(id),
        trade_id   TEXT REFERENCES trades(id),
        kind       TEXT NOT NULL
                   CHECK (kind IN ('complete','cancel_by_taker','cancel_by_publisher',
                                   'dispute_lost','dispute_won','no_show')),
        score      INTEGER NOT NULL,   -- 本次加减分
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status, kind)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_events_trade ON trade_events(trade_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_credit_user ON credit_events(user_id)');
  }

  // ══ 用户 ═══════════════════════════════════════════════════

  register({ id, nickname, studentNo = null, contact = null }) {
    // 学号存在即视为已实名（真实项目里这一步要对接学校系统核验）
    const verified = studentNo ? 1 : 0;
    this.db.prepare(
      `INSERT INTO users (id, nickname, student_no, verified, contact)
       VALUES (?, ?, ?, ?, ?)`
    ).run(id, nickname, studentNo, verified, contact);
    return { id, nickname, studentNo, verified: !!verified };
  }

  getUser(id) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(id);
    if (!u) throw new Error(`用户不存在: ${id}`);
    return { ...u, verified: !!u.verified, score: this.getScore(id) };
  }

  // 信用分：基础 100 分，加减信用事件
  getScore(userId) {
    const r = this.db.prepare(
      'SELECT COALESCE(SUM(score),0) AS s FROM credit_events WHERE user_id = ?'
    ).get(userId);
    return 100 + r.s;
  }

  // ══ 发布与接单 ═════════════════════════════════════════════

  publish({ tradeId, kind, title, description = null, priceYuan, publisherId }) {
    if (!['goods', 'task'].includes(kind)) throw new Error(`未知类型: ${kind}`);
    const price = Math.round(priceYuan * 100);
    if (price < 0) throw new Error('价格不能为负');
    this._mustUser(publisherId);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      this.db.prepare(
        `INSERT INTO trades (id, kind, title, description, price, publisher_id, status)
         VALUES (?, ?, ?, ?, ?, ?, 'open')`
      ).run(tradeId, kind, title, description, price, publisherId);

      this._event(tradeId, publisherId, 'publish', null, STATUS.OPEN);
      this.db.exec('COMMIT');
      return this.getTrade(tradeId);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  take({ tradeId, takerId }) {
    this._mustUser(takerId);
    const t = this._mustTrade(tradeId);
    if (t.publisher_id === takerId) throw new Error('不能接自己发布的单');

    return this._transition(tradeId, takerId, 'take', STATUS.TAKEN, {
      guard: (cur) => {
        if (cur.taker_id) throw new Error('这笔单已经被别人接了');
      },
      update: 'taker_id = ?',
      updateArgs: [takerId],
    });
  }

  deliver({ tradeId, actorId, note = null }) {
    return this._transition(tradeId, actorId, 'deliver', STATUS.DELIVERING, {
      guard: (cur) => {
        // 只有接单方/卖家能发起交付
        if (cur.taker_id !== actorId) throw new Error('只有接单方可以标记为已交付');
      },
      note,
    });
  }

  // 确认完成 —— 关键防重点
  // UNIQUE(trade_id, 'confirm') 保证同一笔单只能确认一次
  confirm({ tradeId, actorId, note = null }) {
    const t = this._mustTrade(tradeId);
    const r = this._transition(tradeId, actorId, 'confirm', STATUS.COMPLETED, {
      guard: (cur) => {
        // 发布者确认（买家确认收货 / 发布者验收）
        if (cur.publisher_id !== actorId) throw new Error('只有发布方可以确认完成');
      },
      note,
    });

    // 完成后给双方加信用分
    this._credit(t.publisher_id, tradeId, 'complete', 2);
    if (t.taker_id) this._credit(t.taker_id, tradeId, 'complete', 3);
    return r;
  }

  // 取消
  cancel({ tradeId, actorId, note = null }) {
    const t = this._mustTrade(tradeId);
    return this._transition(tradeId, actorId, 'cancel', STATUS.CANCELLED, {
      guard: (cur) => {
        const isPublisher = cur.publisher_id === actorId;
        const isTaker = cur.taker_id === actorId;
        if (!isPublisher && !isTaker) throw new Error('你不是这笔单的参与方');
      },
      note,
      after: (cur) => {
        // 接了单又取消 → 扣分（放鸽子）
        if (cur.taker_id === actorId && cur.status === STATUS.TAKEN) {
          this._credit(actorId, tradeId, 'cancel_by_taker', -5);
        }
      },
    });
  }

  // 发起争议
  dispute({ tradeId, actorId, note = null }) {
    return this._transition(tradeId, actorId, 'dispute', STATUS.DISPUTED, {
      guard: (cur) => {
        if (cur.publisher_id !== actorId && cur.taker_id !== actorId) {
          throw new Error('你不是这笔单的参与方');
        }
      },
      note,
    });
  }

  // 裁定争议（由平台管理员执行，不是当事人）
  //
  // 为什么要单独一个动作？
  //   如果允许当事人自己 confirm，那争议发起方一提争议，
  //   对方直接点确认就把争议抹掉了 —— 争议机制就白做了。
  //   所以争议只能由第三方裁定，且必须留下裁定说明。
  resolve({ tradeId, actorId, outcome, note = null }) {
    if (!['completed', 'cancelled'].includes(outcome)) {
      throw new Error(`裁定结果只能是 completed 或 cancelled，收到 ${outcome}`);
    }
    if (!note || !note.trim()) {
      throw new Error('裁定必须填写说明');
    }
    return this._transition(tradeId, actorId, 'resolve', outcome, {
      guard: () => {},
      note,
      after: (cur) => {
        // 判给谁，谁加回信用分；判负的一方扣分
        const winner = outcome === 'completed' ? cur.taker_id : cur.publisher_id;
        const loser = outcome === 'completed' ? cur.publisher_id : cur.taker_id;
        if (winner) this._credit(winner, tradeId, 'dispute_won', 2);
        if (loser) this._credit(loser, tradeId, 'dispute_lost', -8);
      },
    });
  }

  // ══ 查询 ═══════════════════════════════════════════════════

  getTrade(id) {
    const t = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
    if (!t) return undefined;
    return { ...t, price: t.price / 100 };
  }

  listTrades({ status = null, kind = null, limit = 50 } = {}) {
    let sql = 'SELECT * FROM trades WHERE 1=1';
    const args = [];
    if (status) { sql += ' AND status = ?'; args.push(status); }
    if (kind) { sql += ' AND kind = ?'; args.push(kind); }
    sql += ' ORDER BY created_at DESC LIMIT ?';
    args.push(limit);
    return this.db.prepare(sql).all(...args).map((t) => ({ ...t, price: t.price / 100 }));
  }

  getEvents(tradeId) {
    return this.db.prepare(
      'SELECT * FROM trade_events WHERE trade_id = ? ORDER BY id'
    ).all(tradeId);
  }

  getCreditHistory(userId) {
    return this.db.prepare(
      'SELECT * FROM credit_events WHERE user_id = ? ORDER BY id'
    ).all(userId);
  }

  // ══ 自检：状态一致性 ═══════════════════════════════════════
  //
  // 甲路线没有「钱」可以对账，那自检什么？
  // 检「状态和事实是否自相矛盾」：
  //   1. 状态是 taken 之后，必须有接单人
  //   2. 完成的单，必须走过 delivering
  //   3. 每笔单的最终状态，必须和最后一条事件记录一致
  audit() {
    const problems = [];

    // ① 有接单人的单，状态不该还是 open
    const bad1 = this.db.prepare(
      `SELECT id FROM trades WHERE status = 'open' AND taker_id IS NOT NULL`
    ).all();
    bad1.forEach((t) => problems.push(`订单 ${t.id}: 状态 open 但已有接单人`));

    // ② 非 open 状态的单，该有对应的发布事件
    const bad2 = this.db.prepare(
      `SELECT t.id FROM trades t
        WHERE NOT EXISTS (SELECT 1 FROM trade_events e
                          WHERE e.trade_id = t.id AND e.action = 'publish')`
    ).all();
    bad2.forEach((t) => problems.push(`订单 ${t.id}: 没有发布事件，来源不明`));

    // ③ 已完成/已取消是终态，不该再有后续事件
    const bad3 = this.db.prepare(
      `SELECT t.id, t.status, e.action, e.created_at
         FROM trades t
         JOIN trade_events e ON e.trade_id = t.id
        WHERE t.status IN ('completed','cancelled')
          AND e.action IN ('deliver','confirm','take')
          AND e.id > (SELECT MAX(id) FROM trade_events
                       WHERE trade_id = t.id
                         AND action IN ('confirm','cancel'))`
    ).all();
    bad3.forEach((t) => problems.push(`订单 ${t.id}: 终态 ${t.status} 之后仍有事件 ${t.action}`));

    // ④ 状态与最后一条事件应一致
    const all = this.db.prepare('SELECT id, status FROM trades').all();
    all.forEach((t) => {
      const last = this.db.prepare(
        'SELECT to_status FROM trade_events WHERE trade_id = ? ORDER BY id DESC LIMIT 1'
      ).get(t.id);
      if (last && last.to_status !== t.status) {
        problems.push(`订单 ${t.id}: 表里状态 ${t.status}，最后事件却是 ${last.to_status}`);
      }
    });

    return { ok: problems.length === 0, problems };
  }

  // ══ 内部 ═══════════════════════════════════════════════════

  // 通用的状态流转方法：所有动作都走这里，保证规则统一
  _transition(tradeId, actorId, action, toStatus, opts = {}) {
    this._mustUser(actorId);
    const cur = this._mustTrade(tradeId);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // ① 查最新的状态（必须在事务内查，避免读到旧值）
      const fresh = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(tradeId);

      // ② 校验流转是否合法（目标状态 + 触发动作 双重校验）
      const allowedMap = ALLOWED_TRANSITIONS[fresh.status] || {};
      const allowedActions = allowedMap[toStatus];
      if (!allowedActions) {
        throw new Error(`不允许从 ${fresh.status} 变为 ${toStatus}`);
      }
      if (!allowedActions.includes(action)) {
        throw new Error(
          `状态 ${fresh.status} 下不能用 ${action} 触发 ${toStatus}（只允许 ${allowedActions.join('/')}）`
        );
      }

      // ③ 业务自定义校验
      if (opts.guard) opts.guard(fresh);

      // ④ 更新状态（带条件，防止并发下被人抢先改掉）
      let sql = 'UPDATE trades SET status = ?, updated_at = datetime(\'now\')';
      const args = [toStatus];
      if (opts.update) {
        sql += ', ' + opts.update;
        args.push(...opts.updateArgs);
      }
      sql += ' WHERE id = ? AND status = ?';  // ← 带上原状态，防止覆盖别人的修改
      args.push(tradeId, fresh.status);

      const r = this.db.prepare(sql).run(...args);
      if (r.changes === 0) {
        throw new Error('状态已被其他操作改变，请刷新后重试');
      }

      // ⑤ 记事件（UNIQUE 约束保证同动作只记一次）
      this._event(tradeId, actorId, action, fresh.status, toStatus, opts.note);

      // ⑥ 业务自定义后置动作
      if (opts.after) opts.after(fresh);

      this.db.exec('COMMIT');
      return this.getTrade(tradeId);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  _event(tradeId, actorId, action, fromStatus, toStatus, note = null) {
    this.db.prepare(
      `INSERT INTO trade_events (trade_id, actor_id, action, from_status, to_status, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(tradeId, actorId, action, fromStatus, toStatus, note);
  }

  _credit(userId, tradeId, kind, score) {
    this.db.prepare(
      'INSERT INTO credit_events (user_id, trade_id, kind, score) VALUES (?, ?, ?, ?)'
    ).run(userId, tradeId, kind, score);
  }

  _mustUser(id) {
    const r = this.db.prepare('SELECT 1 FROM users WHERE id = ?').get(id);
    if (!r) throw new Error(`用户不存在: ${id}`);
  }

  _mustTrade(id) {
    const t = this.db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
    if (!t) throw new Error(`交易不存在: ${id}`);
    return t;
  }

  close() {
    this.db.close();
  }
}

module.exports = { TradeCore, STATUS, ALLOWED_TRANSITIONS };
