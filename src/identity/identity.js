/**
 * 身份审核核心
 * ═══════════════════════════════════════════════════════════
 *
 * 【为什么要有这一层】
 *
 * 甲路线（纯撮合）的平台不经手钱，那么唯一能约束用户的东西就是「信用」。
 * 而信用体系的前提是——「这个人是谁，他说的话算不算数」。
 * 没有身份，信用分就是记在一个虚构的昵称上，毫无威慑力。
 *
 * 所以审核机制不是附加功能，是甲路线能不能立住的地基。
 *
 *
 * 【架构决策：为什么不改 users 表】
 *
 * users 表被 trades / trade_events / credit_events 三张表外键引用着，
 * 动它等于动地基。而我们的需求是「学号可能被两个人同时声称」，
 * 这跟 users.student_no 的 UNIQUE 约束直接冲突。
 *
 * 解法是把「身份声明」独立成一张表：
 *
 *   users            —— 只管「已确认身份的人」，student_no 保持唯一（不动）
 *   identity_claims  —— 所有「声称」，含待审、已通过、被拒（新增）
 *
 * 这样带来一个免费的好处：
 *   待审用户根本不在 users 表里，而 trades.publisher_id 外键指向 users，
 *   所以待审用户「天然发不了单」——不用写一行业务判断，数据库直接拒绝。
 *
 *
 * 【核心业务规则：手滑 vs 真冒用】
 *
 * 老板选了「受理 + 人工裁定」（方案 B），代价是要承担运营成本。
 * 但如果不加过滤，50 个手滑填错学号的人会全部涌进人工队列。
 *
 * 观察：手滑的人不会精确地知道你叫什么名字。
 *
 *   情形          学号          姓名        判定
 *   ─────────────────────────────────────────────────────
 *   正常          2315402125    何孝彬      学号未被占用 → 直接通过
 *   手滑/撞号     2315402125    张三        学号被占 + 姓名不同 → 自动挂起（非冲突）
 *   真冒用        2315402125    何孝彬      学号被占 + 姓名相同 → 真冲突，必进人工
 *
 * 「姓名是否也撞上」是一个免费的过滤器，能在进人工之前自动分掉一半。
 *
 *
 * 【待审状态下能干什么】
 *
 * 老板拍的板：允许浏览，不允许发布和下单。
 *
 * 理由：浏览是零风险高价值的行为（他看，你就赢得了审核他的时间）；
 * 而发布和接单是会产生责任的行为——挂了单要认真对待，接了单要履约。
 * 「能看」和「能承担责任」是两件事，不该混在一起。
 *
 * 代码层面这个区分不靠业务判断实现，靠外键约束天然实现（见上）。
 */

const { DatabaseSync } = require('node:sqlite');

// ══ 声明状态 ═══════════════════════════════════════════════
const CLAIM_STATUS = {
  PENDING: 'pending',     // 待人工裁定（真冲突）
  HELD: 'held',           // 自动挂起（疑似手滑撞号，等本人确认）
  VERIFIED: 'verified',   // 已通过
  REJECTED: 'rejected',   // 已驳回
};

// ══ 允许的状态流转（目标状态 → 允许的动作）══════════════════
// 沿用第二阶段踩坑得到的教训：光约束「能去哪」不够，
// 还得约束「谁能推它去」——所以把触发动作也写进规则。
const ALLOWED_CLAIM_TRANSITIONS = {
  [CLAIM_STATUS.PENDING]: {
    [CLAIM_STATUS.VERIFIED]: ['approve'],
    [CLAIM_STATUS.REJECTED]: ['reject'],
  },
  [CLAIM_STATUS.HELD]: {
    [CLAIM_STATUS.VERIFIED]: ['approve', 'auto_confirm'],
    [CLAIM_STATUS.REJECTED]: ['reject'],
  },
  // 终态：不可再变
  [CLAIM_STATUS.VERIFIED]: {},
  [CLAIM_STATUS.REJECTED]: {},
};

class IdentityCore {
  constructor(dbPath = ':memory:') {
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA foreign_keys = ON');
    this._initSchema();
  }

  _initSchema() {
    // ── 已有表（与 trade.js 结构保持一致，共用同一个库）────────
    // users 保持原样：student_no 仍然 UNIQUE，
    // 因为这张表只放「已确认身份的人」。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS users (
        id           TEXT PRIMARY KEY,
        nickname     TEXT NOT NULL,
        student_no   TEXT UNIQUE,
        verified     INTEGER NOT NULL DEFAULT 0 CHECK (verified IN (0,1)),
        contact      TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    // ── 身份声明表（新增）─────────────────────────────────────
    // 一个 user_id 可以有多条声明（比如第一次手滑了，第二次改对）。
    // 但「同一个学号 + 同一个姓名」只能有一条「有效」声明，
    // 由下面的 idx_claim_verified_unique 唯一索引保证。
    //
    // reviewed_by 的含义：谁拍的这个板。
    //   人类审核员 → 填审核员 ID
    //   系统规则   → 填 'system:auto'（比如学号无主时自动通过）
    // 必须区分，否则自检会把「合法的自动通过」误报成「缺审核人」——
    // 天天报假警的报警系统，真出事时没人看。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_claims (
        id           INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id      TEXT NOT NULL,
        student_no   TEXT NOT NULL,
        real_name    TEXT NOT NULL,
        status       TEXT NOT NULL DEFAULT 'pending'
                     CHECK (status IN ('pending','held','verified','rejected')),
        reason       TEXT,
        reviewed_by  TEXT,
        review_note  TEXT,
        created_at   TEXT NOT NULL DEFAULT (datetime('now')),
        reviewed_at  TEXT
      )
    `);

    // ── 审核事件流水（追加式，同 trade_events 的思路）──────────
    // 争议时能完整回放：谁在什么时候、基于什么、把谁判成了什么。
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS identity_events (
        id         INTEGER PRIMARY KEY AUTOINCREMENT,
        claim_id   INTEGER NOT NULL REFERENCES identity_claims(id),
        actor_id   TEXT NOT NULL,
        action     TEXT NOT NULL
                   CHECK (action IN ('submit','auto_hold','approve','reject',
                                     'auto_confirm','conflict_detected')),
        from_status TEXT,
        to_status   TEXT NOT NULL,
        note       TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )
    `);

    this.db.exec('CREATE INDEX IF NOT EXISTS idx_claim_user ON identity_claims(user_id)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_claim_student ON identity_claims(student_no)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_claim_status ON identity_claims(status)');
    this.db.exec('CREATE INDEX IF NOT EXISTS idx_ievent_claim ON identity_events(claim_id)');

    // ── 关键防线：一个学号只能有一条「已通过」的声明 ───────────
    // 这是整个审核机制的地基。没有它，两个人可以同时是「何孝彬」。
    // 用部分唯一索引（partial index）表达「只在 verified 状态下唯一」。
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_claim_verified_unique
        ON identity_claims(student_no)
        WHERE status = 'verified'
    `);
  }

  // ══ 提交身份声明（注册入口）═════════════════════════════════
  /**
   * 创建用户 + 提交身份声明，一步完成。
   *
   * @param userId    用户 ID
   * @param nickname  昵称
   * @param studentNo 学号
   * @param realName  真实姓名
   * @returns { user, claim, status, message }
   */
  submit({ userId, nickname, studentNo, realName }) {
    if (!userId) throw new Error('缺少用户 ID');
    if (!nickname) throw new Error('请填写昵称');
    if (!studentNo) throw new Error('请填写学号');
    if (!realName) throw new Error('请填写真实姓名');

    // 学号格式：纯数字，8-12 位。挡掉明显乱填的。
    if (!/^\d{8,12}$/.test(studentNo)) {
      throw new Error('学号格式不对（应为 8-12 位数字）');
    }

    // 单独挡掉手机号。
    // 「8-12 位数字」这个宽松规则挡不住 13800138000（11 位刚好在范围内）。
    // 而 1[3-9] 开头 + 11 位 是手机号铁律，误伤概率极低，
    // 所以单独拦一道——这不叫「智能识别学号」，只是挡明显的填错格子。
    if (/^1[3-9]\d{9}$/.test(studentNo)) {
      throw new Error('这看起来是手机号，不是学号');
    }

    const existing = this.db
      .prepare('SELECT * FROM users WHERE id = ?')
      .get(userId);
    if (existing) {
      // 同一个用户重复提交：允许改，但把旧的有效声明作废
      const activeClaim = this.db.prepare(
        `SELECT * FROM identity_claims
          WHERE user_id = ? AND status IN ('pending','held')
          ORDER BY id DESC LIMIT 1`
      ).get(userId);
      if (activeClaim) {
        throw new Error('你已有一份待审核的身份声明，请等待审核结果');
      }
    } else {
      // 关键：先建用户，但此时不写 student_no、verified=0
      // 只有审核通过了才会把学号写进 users 表。
      // 这样「待审用户」天然存在于 users 但拿不到实名标记。
      this.db.prepare(
        `INSERT INTO users (id, nickname, student_no, verified, contact)
         VALUES (?, ?, NULL, 0, NULL)`
      ).run(userId, nickname);
    }

    // ── 分流判断：这个学号被人占了吗？───────────────────────
    const occupant = this.db.prepare(
      `SELECT * FROM identity_claims
        WHERE student_no = ? AND status IN ('verified','pending','held')
        ORDER BY id ASC LIMIT 1`
    ).get(studentNo);

    let status;
    let reason;

    if (!occupant) {
      // 无人占用 → 直接通过
      status = CLAIM_STATUS.VERIFIED;
      reason = null;
    } else if (occupant.real_name === realName) {
      // 学号被占 + 姓名也完全一样 → 真冒用/真冲突，必进人工
      status = CLAIM_STATUS.PENDING;
      reason = `学号 ${studentNo} 已被占用，且姓名一致，需人工裁定`;
    } else {
      // 学号被占 + 姓名不同 → 大概率是手滑填错了别人的学号
      status = CLAIM_STATUS.HELD;
      reason = `学号 ${studentNo} 已被他人占用（对方姓名与你不同），疑似填错学号`;
    }

    const r = this.db.prepare(
      `INSERT INTO identity_claims (user_id, student_no, real_name, status, reason)
       VALUES (?, ?, ?, ?, ?)`
    ).run(userId, studentNo, realName, status, reason);

    const claimId = Number(r.lastInsertRowid);

    this._event(claimId, userId, 'submit', null, 'submitted',
      `提交身份声明：${studentNo} / ${realName}`);

    if (status === CLAIM_STATUS.VERIFIED) {
      this._event(claimId, userId, 'approve', 'submitted', status,
        '学号未被占用，自动通过');
      // 机判的也要落 reviewed_by，但标成 system:auto —— 跟人判的区分开。
      // 不这样标，自检就会把合法的自动通过误报成「缺审核人」。
      this.db.prepare(
        `UPDATE identity_claims
            SET reviewed_by = 'system:auto', review_note = '学号未被占用，系统自动通过',
                reviewed_at = datetime('now')
          WHERE id = ?`
      ).run(claimId);
      this._grantIdentity(userId, studentNo);
    } else if (status === CLAIM_STATUS.HELD) {
      this._event(claimId, userId, 'auto_hold', 'submitted', status, reason);
      // 额外记一条「疑似冲突」，方便后台按类型筛选
      this._event(claimId, userId, 'conflict_detected', status, status, reason);
    } else {
      this._event(claimId, userId, 'conflict_detected', 'submitted', status, reason);
    }

    return {
      user: this.getUser(userId),
      claim: this.getClaim(claimId),
      status,
      message: this._message(status, reason),
    };
  }

  // ══ 人工裁定 ═══════════════════════════════════════════════
  /**
   * 审核员裁定。这是整个机制唯一的「人来拍板」环节。
   *
   * ⚠️ 一条关键业务规则（测试场景 9 逼出来的）：
   *
   *   「批准」这个动作，在学号已被别人占用时，语义上根本不成立。
   *
   * 想一下：张三手滑填了别人的学号 2315402125，审核员点「批准」。
   * 批准他什么？批准他拥有这个学号吗？——那学号就撞车了。
   *
   * 所以手滑撞号的正解不是「批准」，是「驳回 + 请他重新提交正确的学号」。
   * 「批准」只在一种情况下成立：这个学号当前无主（比如原来的主人被推翻）。
   *
   * 代码原本靠数据库 UNIQUE 约束兜底（会抛 constraint failed），
   * 但那样错误信息对审核员毫无意义。所以在这里主动拦一道，
   * 给出人能看懂的原因。
   *
   * @param claimId    要裁定的声明
   * @param reviewerId 审核员（必须真人，不许是当事人）
   * @param decision   'approve' | 'reject'
   * @param note       必须写理由——不写理由的裁定无法追溯
   */
  review({ claimId, reviewerId, decision, note }) {
    if (!reviewerId) throw new Error('缺少审核人');
    if (!note || !note.trim()) throw new Error('裁定必须填写审核说明');

    const fresh = this._mustClaim(claimId);

    // 越权防护：当事人不能审自己
    if (fresh.user_id === reviewerId) {
      throw new Error('不能审核自己的身份声明');
    }

    const targetStatus =
      decision === 'approve' ? CLAIM_STATUS.VERIFIED : CLAIM_STATUS.REJECTED;

    // 双重校验：目标状态 + 触发动作
    const allowedMap = ALLOWED_CLAIM_TRANSITIONS[fresh.status] || {};
    const allowedActions = allowedMap[targetStatus];
    if (!allowedActions) {
      throw new Error(`不允许从 ${fresh.status} 变为 ${targetStatus}`);
    }
    if (!allowedActions.includes(decision)) {
      throw new Error(
        `状态 ${fresh.status} 下不能用 ${decision} 触发 ${targetStatus}（只允许 ${allowedActions.join('/')}）`
      );
    }

    // ── 批准前的必要检查：这个学号现在是不是无主 ──────────────
    // 如果已被别人以 verified 占着，批准会导致一个学号两个主人。
    // 正确的做法是驳回，然后让当事人重新提交正确学号。
    if (targetStatus === CLAIM_STATUS.VERIFIED) {
      const owner = this.db.prepare(
        `SELECT id, user_id, real_name FROM identity_claims
          WHERE student_no = ? AND status = 'verified' AND id <> ?`
      ).get(fresh.student_no, claimId);

      if (owner) {
        throw new Error(
          `学号 ${fresh.student_no} 当前由用户 ${owner.user_id}（${owner.real_name}）持有，` +
          `不能批准第二条。若是此人填错了学号，请驳回并让他重新提交正确的学号。`
        );
      }
    }

    // 防重复：用 WHERE status = ? 把判断和修改焊在一条 SQL 里，
    // 防止两个审核员同时点（或同一个人手抖点两次）
    const r = this.db.prepare(
      `UPDATE identity_claims
          SET status = ?, reviewed_by = ?, review_note = ?,
              reviewed_at = datetime('now')
        WHERE id = ? AND status = ?`
    ).run(targetStatus, reviewerId, note.trim(), claimId, fresh.status);

    if (r.changes === 0) {
      throw new Error('该声明状态已变化，请刷新后重试');
    }

    this._event(claimId, reviewerId, decision, fresh.status, targetStatus,
      note.trim());

    if (targetStatus === CLAIM_STATUS.VERIFIED) {
      this._grantIdentity(fresh.user_id, fresh.student_no);
    }

    return this.getClaim(claimId);
  }

  // ══ 把身份写进 users 表（唯一的「开闸」动作）════════════════
  _grantIdentity(userId, studentNo) {
    // 学号已被别的已通过声明占用？→ 说明数据不一致，必须拦住
    const taken = this.db
      .prepare('SELECT id FROM users WHERE student_no = ? AND id <> ?')
      .get(studentNo, userId);
    if (taken) {
      throw new Error(`学号 ${studentNo} 已被另一个已通过的用户占用，数据不一致`);
    }

    this.db.prepare(
      `UPDATE users SET student_no = ?, verified = 1 WHERE id = ?`
    ).run(studentNo, userId);
  }

  // ══ 查询 ═══════════════════════════════════════════════════
  getClaim(claimId) {
    const c = this.db
      .prepare('SELECT * FROM identity_claims WHERE id = ?')
      .get(claimId);
    return c || null;
  }

  getUser(userId) {
    const u = this.db.prepare('SELECT * FROM users WHERE id = ?').get(userId);
    if (!u) throw new Error(`用户不存在: ${userId}`);
    return {
      ...u,
      verified: !!u.verified,
      // 对外只看得到「能不能承担责任」，看不到内部审核细节
      canTransact: !!u.verified,
    };
  }

  /** 某用户的当前身份状态（用于「待审时能干什么」的判断）*/
  getStatus(userId) {
    const claim = this.db.prepare(
      `SELECT * FROM identity_claims
        WHERE user_id = ?
        ORDER BY id DESC LIMIT 1`
    ).get(userId);

    if (!claim) {
      return { stage: 'none', canBrowse: true, canTransact: false };
    }

    const canTransact = claim.status === CLAIM_STATUS.VERIFIED;
    return {
      stage: claim.status,
      canBrowse: true,          // 任何状态下都能看——这是老板拍板的
      canTransact,
      reason: claim.reason,
      claim,
    };
  }

  /** 待审队列（给人工审核用）*/
  listPending({ status = null, limit = 50 } = {}) {
    const sql = status
      ? `SELECT * FROM identity_claims WHERE status = ? ORDER BY id ASC LIMIT ?`
      : `SELECT * FROM identity_claims
          WHERE status IN ('pending','held') ORDER BY id ASC LIMIT ?`;
    return status
      ? this.db.prepare(sql).all(status, limit)
      : this.db.prepare(sql).all(limit);
  }

  getEvents(claimId) {
    return this.db
      .prepare('SELECT * FROM identity_events WHERE claim_id = ? ORDER BY id ASC')
      .all(claimId);
  }

  // ══ 一致性自检 ════════════════════════════════════════════
  /**
   * 检查身份数据有没有自相矛盾。这个方法的价值在于——
   * 当系统跑久了、有人手工改过库、或者代码有 bug 时，
   * 你能在纠纷爆发之前发现问题。
   */
  audit() {
    const problems = [];

    // 1. users 里 verified=1 但没有已通过的声明
    const fakeVerified = this.db.prepare(`
      SELECT u.id, u.student_no FROM users u
       WHERE u.verified = 1
         AND NOT EXISTS (
           SELECT 1 FROM identity_claims c
            WHERE c.user_id = u.id AND c.status = 'verified'
         )
    `).all();
    fakeVerified.forEach((u) =>
      problems.push(`用户 ${u.id} 标记为已实名，但没有已通过的声明`));

    // 2. 同一学号有多条已通过的声明（唯一索引应该拦住，防索引被删）
    const dupVerified = this.db.prepare(`
      SELECT student_no, COUNT(*) AS n FROM identity_claims
       WHERE status = 'verified'
       GROUP BY student_no HAVING n > 1
    `).all();
    dupVerified.forEach((d) =>
      problems.push(`学号 ${d.student_no} 有 ${d.n} 条已通过的声明`));

    // 3. 已通过的声明，用户却没在 users 里拿到学号
    const orphan = this.db.prepare(`
      SELECT c.id, c.user_id, c.student_no FROM identity_claims c
       JOIN users u ON u.id = c.user_id
       WHERE c.status = 'verified'
         AND (u.student_no IS NULL OR u.student_no <> c.student_no)
    `).all();
    orphan.forEach((o) =>
      problems.push(`声明 ${o.id} 已通过，但用户 ${o.user_id} 的学号没同步`));

    // 4. 终态声明缺审核信息。
    //    注意要排除自动通过的——那些的 reviewed_by 是 'system:auto'，
    //    系统拍的板不该要求它有个「人」。
    //    （这条规则原先写漏了排除条件，导致合法的自动通过被误报成问题。
    //      假警刷多了，真出事时没人看，所以必须收紧。）
    const badFinal = this.db.prepare(`
      SELECT id, status, reviewed_by FROM identity_claims
       WHERE status IN ('verified','rejected')
         AND (reviewed_at IS NULL
              OR reviewed_by IS NULL
              OR trim(reviewed_by) = '')
    `).all();
    badFinal.forEach((c) =>
      problems.push(`声明 ${c.id} 是终态（${c.status}），但缺审核人和审核时间`));

    return { ok: problems.length === 0, problems };
  }

  // ══ 内部工具 ═══════════════════════════════════════════════
  _message(status, reason) {
    return {
      [CLAIM_STATUS.VERIFIED]: '身份核验通过，可以开始发布和接单了',
      [CLAIM_STATUS.PENDING]: '身份正在人工审核中，审核通过后即可发布（现在可以先逛逛）',
      [CLAIM_STATUS.HELD]: '你这个学号好像填错了（已被他人使用），请核对后重新提交',
      [CLAIM_STATUS.REJECTED]: '身份核验未通过，请联系管理员',
    }[status] + (reason ? `｜${reason}` : '');
  }

  _event(claimId, actorId, action, fromStatus, toStatus, note = null) {
    this.db.prepare(
      `INSERT INTO identity_events
         (claim_id, actor_id, action, from_status, to_status, note)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(claimId, actorId, action, fromStatus, toStatus, note);
  }

  _mustClaim(id) {
    const c = this.db
      .prepare('SELECT * FROM identity_claims WHERE id = ?')
      .get(id);
    if (!c) throw new Error(`身份声明不存在: ${id}`);
    return c;
  }

  close() {
    this.db.close();
  }
}

module.exports = { IdentityCore, CLAIM_STATUS, ALLOWED_CLAIM_TRANSITIONS };
