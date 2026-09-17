/**
 * 账本核心（第一版）
 *
 * 设计原则（都是从我们讨论里推出来的）：
 *   1. 余额表用 `WHERE balance >= N` 原子扣减，杜绝"先查后改"的缝隙
 *   2. 订单表用 UNIQUE 约束，杜绝同一笔订单扣两次
 *   3. 每一笔资金变动都写一条流水，账目可追溯
 *
 * 使用 Node 内置的 node:sqlite（Node 22+ 自带，无需安装数据库）
 */

const { DatabaseSync } = require('node:sqlite');

// 金额一律用「分」为单位存储，绝不用浮点数。
// 原因：0.1 + 0.2 !== 0.3，钱上不能有这种误差。
const YUAN = 100;

class Ledger {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);

    // 打开外键约束（SQLite 默认是关的，不开的话关联约束形同虚设）
    this.db.exec('PRAGMA foreign_keys = ON');

    // 用 WAL 模式提升并发读性能
    this.db.exec('PRAGMA journal_mode = WAL');

    this._initSchema();
  }

  _initSchema() {
    // ── 账户表 ────────────────────────────────────────────────
    // balance        可用余额（分）
    // frozen         冻结金额（分）—— 下单后钱先锁在这里
    // 关键约束：CHECK 保证任何情况下都不能为负
    // 这是「数据库层铁律」，应用代码再怎么写错也绕不过去
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS accounts (
        user_id   TEXT PRIMARY KEY,
        balance   INTEGER NOT NULL DEFAULT 0 CHECK (balance >= 0),
        frozen    INTEGER NOT NULL DEFAULT 0 CHECK (frozen  >= 0),
        updated_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // ── 订单表 ────────────────────────────────────────────────
    // 两种类型共用一张表：
    //   type='goods' → 闲置交易（卖家发货，买家确认）
    //   type='task'  → 任务发布（接单人干活，发布者验收）
    // status 就是那个「共用状态机」
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS orders (
        id          TEXT PRIMARY KEY,
        type        TEXT NOT NULL CHECK (type IN ('goods','task')),
        buyer_id    TEXT NOT NULL,
        seller_id   TEXT NOT NULL,
        amount      INTEGER NOT NULL CHECK (amount > 0),
        status      TEXT NOT NULL DEFAULT 'created'
                    CHECK (status IN ('created','paid','delivered','completed','cancelled')),
        created_at  TEXT NOT NULL DEFAULT (datetime('now')),
        updated_at  TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // ── 流水表 ────────────────────────────────────────────────
    // 每一笔资金变动都留痕，这是对账和排查的依据
    //
    // ⚠️ 这里有个 UNIQUE 约束是关键防线：
    //    (order_id, action) 唯一 → 同一笔订单的同一种动作只能发生一次
    //    这样即使有人手抖点两次「支付」，第二次会直接被数据库拒绝
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS transactions (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id    TEXT NOT NULL,
        order_id   TEXT,
        action     TEXT NOT NULL
                   CHECK (action IN ('deposit','freeze','unfreeze','settle','withdraw')),
        amount     INTEGER NOT NULL,
        balance_after  INTEGER NOT NULL,
        frozen_after   INTEGER NOT NULL,
        created_at TEXT NOT NULL DEFAULT (datetime('now')),
        UNIQUE (order_id, action)
      )
    `);

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tx_user ON transactions(user_id, created_at)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_tx_order ON transactions(order_id)');
  }

  // ── 开户 ───────────────────────────────────────────────────
  createAccount(userId) {
    this.db.prepare(
      'INSERT OR IGNORE INTO accounts (user_id, balance, frozen) VALUES (?, 0, 0)'
    ).run(userId);
    return this.getBalance(userId);
  }

  // ── 查余额 ─────────────────────────────────────────────────
  getBalance(userId) {
    const row = this.db.prepare(
      'SELECT balance, frozen FROM accounts WHERE user_id = ?'
    ).get(userId);
    if (!row) throw new Error(`账户不存在: ${userId}`);
    return {
      balance: row.balance / YUAN,
      frozen: row.frozen / YUAN,
      available: (row.balance - row.frozen) / YUAN,
    };
  }

  // ── 充值 ───────────────────────────────────────────────────
  // 演示用途：模拟用户往平台充钱
  deposit(userId, yuan) {
    const amount = Math.round(yuan * YUAN);
    if (amount <= 0) throw new Error('充值金额必须大于 0');
    this._mustExist(userId);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // 累加式更新是安全的：数据库会自己保证这一个语句的原子性
      this.db.prepare(
        'UPDATE accounts SET balance = balance + ?, updated_at = datetime(\'now\') WHERE user_id = ?'
      ).run(amount, userId);

      const after = this._rawBalance(userId);
      this._logTx(userId, null, 'deposit', amount, after);
      this.db.exec('COMMIT');
      return this.getBalance(userId);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── 下单并冻结资金 ─────────────────────────────────────────
  //
  // 这是整个账本最关键的一段。注意看：
  //   「判断余额够不够」和「扣减」写在同一句 SQL 里，
  //   中间没有任何缝隙给别的请求插进来。
  //
  // 同时订单号 + 'freeze' 动作有 UNIQUE 约束，
  //   即使调用方重复调用，第二次也会被数据库拒绝。
  createOrderAndFreeze({ orderId, type, buyerId, sellerId, amountYuan }) {
    const amount = Math.round(amountYuan * YUAN);
    if (amount <= 0) throw new Error('金额必须大于 0');
    this._mustExist(buyerId);
    this._mustExist(sellerId);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // ① 先建订单（如果订单号重复，主键约束会直接拒绝）
      this.db.prepare(
        `INSERT INTO orders (id, type, buyer_id, seller_id, amount, status)
         VALUES (?, ?, ?, ?, ?, 'created')`
      ).run(orderId, type, buyerId, sellerId, amount);

      // ② 原子冻结：WHERE 里带条件，余额不够就改不到行
      //    changes() 返回受影响行数，0 表示没冻成
      const r = this.db.prepare(
        `UPDATE accounts
            SET frozen = frozen + ?, updated_at = datetime('now')
          WHERE user_id = ? AND (balance - frozen) >= ?`
      ).run(amount, buyerId, amount);

      if (r.changes === 0) {
        // 钱不够 → 抛错 → 整个事务回滚，订单也不会留下
        throw new Error('可用余额不足');
      }

      // ③ 记流水（UNIQUE(order_id, action) 保证同单只冻一次）
      const after = this._rawBalance(buyerId);
      this._logTx(buyerId, orderId, 'freeze', -amount, after);

      // ④ 订单状态推进
      this.db.prepare(
        `UPDATE orders SET status = 'paid', updated_at = datetime('now') WHERE id = ?`
      ).run(orderId);

      this.db.exec('COMMIT');
      return { orderId, status: 'paid', frozenAmount: amountYuan };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── 确认收货 / 验收完成 → 结算 ──────────────────────────────
  // 钱从「买家冻结」转成「卖家可用」
  settle(orderId) {
    const order = this.db.prepare('SELECT * FROM orders WHERE id = ?').get(orderId);
    if (!order) throw new Error(`订单不存在: ${orderId}`);
    if (order.status !== 'paid') {
      throw new Error(`订单状态是 ${order.status}，不能结算`);
    }

    this.db.exec('BEGIN IMMEDIATE');
    try {
      // ① 解冻买家（frozen 减少，balance 同步减少：钱离开了买家账户）
      const r1 = this.db.prepare(
        `UPDATE accounts
            SET frozen  = frozen  - ?,
                balance = balance - ?,
                updated_at = datetime('now')
          WHERE user_id = ? AND frozen >= ?`
      ).run(order.amount, order.amount, order.buyer_id, order.amount);
      if (r1.changes === 0) throw new Error('冻结金额异常，无法结算');

      // ② 给卖家加钱
      this.db.prepare(
        `UPDATE accounts
            SET balance = balance + ?, updated_at = datetime('now')
          WHERE user_id = ?`
      ).run(order.amount, order.seller_id);

      // ③ 记两条流水
      const buyerAfter = this._rawBalance(order.buyer_id);
      this._logTx(order.buyer_id, orderId, 'unfreeze', -order.amount, buyerAfter);
      const sellerAfter = this._rawBalance(order.seller_id);
      this._logTx(order.seller_id, orderId, 'settle', order.amount, sellerAfter);

      // ④ 状态推进
      this.db.prepare(
        `UPDATE orders SET status = 'completed', updated_at = datetime('now') WHERE id = ?`
      ).run(orderId);

      this.db.exec('COMMIT');
      return { orderId, status: 'completed', settled: order.amount / YUAN };
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── 提现（演示：只是记账）──────────────────────────────────
  withdraw(userId, yuan) {
    const amount = Math.round(yuan * YUAN);
    if (amount <= 0) throw new Error('提现金额必须大于 0');
    this._mustExist(userId);

    this.db.exec('BEGIN IMMEDIATE');
    try {
      const r = this.db.prepare(
        `UPDATE accounts
            SET balance = balance - ?, updated_at = datetime('now')
          WHERE user_id = ? AND (balance - frozen) >= ?`
      ).run(amount, userId, amount);

      if (r.changes === 0) throw new Error('可用余额不足，无法提现');

      const after = this._rawBalance(userId);
      this._logTx(userId, null, 'withdraw', -amount, after);
      this.db.exec('COMMIT');
      return this.getBalance(userId);
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  // ── 查流水 ─────────────────────────────────────────────────
  getTransactions(userId) {
    return this.db.prepare(
      'SELECT * FROM transactions WHERE user_id = ? ORDER BY id'
    ).all(userId).map((t) => ({
      ...t,
      amount: t.amount / YUAN,
      balance_after: t.balance_after / YUAN,
      frozen_after: t.frozen_after / YUAN,
    }));
  }

  // ── 对账：钱的总量守恒 ─────────────────────────────────────
  //
  // 语义约定（很重要，写代码时全靠它）：
  //   balance   = 账户总资产（含被冻结的部分），跟银行 App 的口径一致
  //   frozen    = 其中有多少被锁住（是 balance 的子集，不是额外资产）
  //   available = balance - frozen，真正能动用的钱
  //
  // 因此守恒式是：
  //   Σbalance  ==  总充值 - 总提现
  //
  // ⚠️ 千万不要写成 Σbalance + Σfrozen —— 冻结的钱是从 balance 划出来的，
  //    那样算等于把它数了两遍。
  audit() {
    const sums = this.db.prepare(
      'SELECT COALESCE(SUM(balance),0) AS b, COALESCE(SUM(frozen),0) AS f FROM accounts'
    ).get();
    const flows = this.db.prepare(
      `SELECT
         COALESCE(SUM(CASE WHEN action='deposit'  THEN amount ELSE 0 END),0) AS dep,
         COALESCE(SUM(CASE WHEN action='withdraw' THEN amount ELSE 0 END),0) AS wd
       FROM transactions`
    ).get();

    const left = sums.b;
    const right = flows.dep + flows.wd;
    return {
      totalBalance: sums.b / YUAN,
      totalFrozen: sums.f / YUAN,
      totalIn: flows.dep / YUAN,
      totalOut: -flows.wd / YUAN,
      left,
      right,
      diff: left - right,
      balanced: left === right,
    };
  }

  // ── 内部工具 ───────────────────────────────────────────────
  _mustExist(userId) {
    const r = this.db.prepare('SELECT 1 FROM accounts WHERE user_id = ?').get(userId);
    if (!r) throw new Error(`账户不存在: ${userId}`);
  }

  _rawBalance(userId) {
    const r = this.db.prepare(
      'SELECT balance, frozen FROM accounts WHERE user_id = ?'
    ).get(userId);
    return { balance: r.balance, frozen: r.frozen };
  }

  _logTx(userId, orderId, action, amount, after) {
    this.db.prepare(
      `INSERT INTO transactions (user_id, order_id, action, amount, balance_after, frozen_after)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(userId, orderId, action, amount, after.balance, after.frozen);
  }

  close() {
    this.db.close();
  }
}

module.exports = { Ledger, YUAN };
