/* 团务助手 · content script（两个发布版共用）
 * 名单抓取 / 行勾选 / 重置码记录 / 评议批量设置 / 录入预检。
 * 不代点审批；批量任务需要用户确认后才开始，确认后会自动填写表单并点击提交。
 */
(() => {
  'use strict';
  if (window.__ZHTJ_HELPER_LOADED__) return;
  window.__ZHTJ_HELPER_LOADED__ = true;

  /* ---------------- utils ---------------- */
  const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));
  const esc = (s) =>
    String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const visible = (el) => !!el && el.getClientRects().length > 0;
  const text = (el) => (el && el.innerText ? el.innerText.replace(/\s+/g, ' ').trim() : '');

  // 团徽：和扩展图标同一张图（extension/icons/icon48.png，源图 data/web_logo.png）
  const LOGO_URL =
    typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getURL
      ? chrome.runtime.getURL('icons/icon48.png')
      : '';

  /* ---------------- state ---------------- */
  const state = {
    roster: [], // {key,no,name,gender,ethnic,phone,duty,inOrg,joinYm}
    selected: new Set(),
    _rosterSig: '',
    codes: [], // {name,code,expiry,time}
    rowsByKey: new Map(),
    lastKey: null,
    running: false,
    pendingName: '',
    route: '',
    logs: [],
    // ballX / ballY：悬浮球左上角坐标（px）；null 表示用默认位置（贴右上）
    // snapEdge：松手后是否吸附到最近的页边（默认开）
    settings: { autoClose: true, delay: 400, snapEdge: true, ballX: null, ballY: null },
    update: null,
  };

  function log(msg) {
    const t = new Date().toTimeString().slice(0, 8);
    state.logs.push(`[${t}] ${msg}`);
    if (state.logs.length > 300) state.logs.shift();
    renderLog();
  }

  // 日志是全局的（放在面板底部），各个页签只放自己的内容
  function renderLog() {
    if (!shadow) return;
    const n = shadow.querySelector('[data-logn]');
    if (n) n.textContent = String(state.logs.length);
    const box = shadow.querySelector('.logbox');
    if (box) {
      box.textContent = state.logs.join('\n');
      if (box.style.display !== 'none') box.scrollTop = box.scrollHeight;
    }
  }

  /* ---------------- page helpers ---------------- */
  // 注意：真实地址是 https://zhtj.youth.cn/zhtj/center/...，pathname 以 /zhtj/ 开头
  const isCenter = () => location.pathname.includes('/center');
  const routeKind = () => {
    const p = location.pathname;
    const low = p.toLowerCase();
    if (low.includes('/manage/memberlist')) return 'memberlist';
    if (low.includes('/manage/managetransferprocessdo')) return 'transfer';
    if (low.includes('/manage/membererecord')) return 'record';
    // 团员信息页有多个入口：memberinfo / memberBaseInfo / myleaguememberinfo；
    // 团干（团内职务非空）走的是 cadresinfo，表单结构一样，按同一类处理
    if (low.includes('cadresinfo') || (low.includes('member') && low.includes('info'))) return 'memberinfo';
    if (low.includes('/manage/twosystem')) return 'twosystem';
    return 'other';
  };

  function tableHeaders(table) {
    return $$('.el-table__header th .cell', table).map((c) => text(c)).filter(Boolean);
  }

  function findMemberTable() {
    const tables = $$('.el-table').filter(visible);
    return (
      tables.find((t) => {
        const h = tableHeaders(t);
        return h.includes('团内职务') && h.includes('姓名');
      }) ||
      tables.find((t) => {
        const h = tableHeaders(t);
        return h.includes('手机号码') && h.includes('姓名');
      }) ||
      null
    );
  }

  // 取单元格文字：克隆后剔除插件自己插入的勾选框，避免污染"序号"
  function cellText(td) {
    if (!td) return '';
    const cell = td.querySelector('.cell') || td;
    const clone = cell.cloneNode(true);
    clone.querySelectorAll('.zhtj-cb').forEach((n) => n.remove());
    return String(clone.textContent || '').replace(/\s+/g, ' ').trim();
  }

  // 去掉姓名后的 "(管理员)" 之类的角标
  const cleanName = (s) => String(s || '').replace(/[（(]\s*管理员\s*[)）]/g, '').trim();

  // 表头文案会因组织类型 / 页面版本而略有差异（比如「手机号码」「手机号」），
  // 先精确匹配，再按关键字包含匹配；都没有就返回 -1，导出时留空。
  function headerIndex(heads, names) {
    for (const n of names) {
      const i = heads.indexOf(n);
      if (i >= 0) return i;
    }
    for (const n of names) {
      const i = heads.findIndex((h) => h && h.includes(n));
      if (i >= 0) return i;
    }
    return -1;
  }

  function readRows(table) {
    const heads = tableHeaders(table);
    const idx = {
      no: headerIndex(heads, ['序号']),
      name: headerIndex(heads, ['姓名']),
      gender: headerIndex(heads, ['性别']),
      ethnic: headerIndex(heads, ['民族']),
      phone: headerIndex(heads, ['手机号码', '手机号', '手机', '联系电话']),
      duty: headerIndex(heads, ['团内职务', '职务']),
      inOrg: headerIndex(heads, ['团籍是否在本组织', '团籍是否在本', '团籍是否', '团籍']),
      joinYm: headerIndex(heads, ['入团年月', '入团时间', '入团日期']),
    };
    const trs = $$('.el-table__body tbody tr', table).filter((tr) => $$('td', tr).length);
    return trs.map((tr, i) => {
      const tds = $$('td', tr);
      const cell = (k) => (idx[k] < 0 || !tds[idx[k]] ? '' : cellText(tds[idx[k]]));
      const no = cell('no') || String(i + 1);
      const name = cleanName(cell('name'));
      const phone = cell('phone');
      return {
        key: `${no}|${name}|${phone}`,
        no,
        name,
        gender: cell('gender'),
        ethnic: cell('ethnic'),
        phone,
        duty: cell('duty'),
        inOrg: cell('inOrg'),
        joinYm: cell('joinYm'),
        el: tr,
      };
    });
  }

  function currentTable() {
    return findMemberTable() || findPjTable() || $$('.el-table').filter(visible)[0] || null;
  }

  function rowSignature() {
    const t = currentTable();
    if (!t) return '';
    const trs = $$('.el-table__body tbody tr', t);
    if (!trs.length) return '0';
    return `${trs.length}|${text(trs[0]).slice(0, 40)}`;
  }

  function pagerNear(table) {
    let node = table;
    for (let i = 0; i < 6 && node; i++) {
      node = node.parentElement;
      if (!node) break;
      const cands = $$('[class*="pagination"], [class*="pager"], .el-pagination', node).filter(visible);
      const hit = cands.find((x) => /共\s*\d+\s*条/.test(text(x)));
      if (hit) return hit;
    }
    return null;
  }

  function pager() {
    const near = pagerNear(findMemberTable());
    if (near) return near;
    const lists = $$('.el-pagination, [class*="pagination"], [class*="pager"]').filter(visible);
    let p = lists.find((x) => /共\s*\d+\s*条/.test(text(x)) && !/共\s*0\s*条/.test(text(x)));
    if (!p) p = lists.find((x) => /共\s*\d+\s*条/.test(text(x)));
    if (!p) {
      const hit = $$('div, span, section')
        .filter((x) => {
          const t = text(x);
          return visible(x) && t.length < 90 && /\d+\s*-\s*\d+\s*共\s*\d+\s*条/.test(t);
        })
        .pop();
      p = hit ? hit.closest('[class*="pagination"], [class*="pager"]') || hit.parentElement : null;
    }
    return p || null;
  }

  function isDead(el) {
    if (!el) return true;
    if (el.disabled) return true;
    if (/is-disabled|(^|\s)disabled(\s|$)/.test(String(el.getAttribute('class') || ''))) return true;
    if (el.getAttribute('aria-disabled') === 'true') return true;
    return false;
  }

  function leafBy(root, re) {
    if (!root) return null;
    const all = $$('a, button, span, li, i, em, div', root);
    const hits = all.filter((el) => {
      const cls = String(el.getAttribute('class') || '');
      return (
        re.test(text(el)) ||
        re.test(cls) ||
        re.test(el.getAttribute('title') || '') ||
        re.test(el.getAttribute('aria-label') || '')
      );
    });
    return hits.length ? hits[hits.length - 1] : null;
  }

  // 翻页候选：分页器上“首页 / 上一页 / 下一页 / 末页”都是 <a>，页码是 <li> 或 <span>
  function pagerCandidates(p, kind) {
    const cands = [];
    const push = (el) => {
      if (el && visible(el) && !isDead(el) && cands.indexOf(el) < 0) cands.push(el);
    };
    const leaves = $$('a, button', p).filter(visible);
    const byText = (re) => leaves.filter((el) => re.test(text(el)));
    const info = pageInfo();
    if (kind === 'next') {
      $$('.el-pager li, li', p)
        .filter(visible)
        .filter((el) => text(el) === String(info.current + 1))
        .forEach(push);
      byText(/下一页/).slice(-2).forEach(push);
      push($$('[class*="next"]', p).filter(visible).pop());
    } else if (kind === 'prev') {
      byText(/上一页/).slice(-2).forEach(push);
      push($$('[class*="prev"]', p).filter(visible).pop());
    } else if (kind === 'first') {
      byText(/首\s*页/).slice(-2).forEach(push);
    } else if (kind === 'last') {
      byText(/末\s*页/).slice(-2).forEach(push);
    }
    return cands;
  }

  // 点一下分页按钮，只有表格内容真的变了才算成功
  async function clickPager(kind) {
    const p = pager();
    if (!p) {
      log('没找到分页控件');
      return false;
    }
    const cands = pagerCandidates(p, kind);
    if (!cands.length) return false;
    for (const el of cands) {
      const sig = rowSignature();
      el.click();
      if (await waitSignatureChange(sig, 4000)) return true;
    }
    if (kind === 'next') {
      log(`翻页失败：分页控件「${text(p).slice(0, 40)}」点不动。请手动点「下一页」后按【追加本页】。`);
    }
    return false;
  }

  const clickNext = () => clickPager('next');

  // 网站自带的「导出团员数据」把当前页码直接拼进了请求地址：
  //   /v1/center/exportmembers/{当前页}/{搜索词}/{身份证号}/{性别}
  // 页面停在第 2 页及以后时，这个导出拿不到数据，下载下来的 xlsx 是空的
  // （不抓取时表格停在第 1 页，所以看起来“只有抓取后才会坏”）。
  // 因此凡是插件替用户翻过页的流程，结束时都要把表格翻回第 1 页。
  async function backToFirstPage() {
    const info = pageInfo();
    if (!info.total || info.current <= 1) return true;
    const ok = await gotoPage(1);
    if (ok) log('已把名单翻回第 1 页（不翻回去，网站自带的「导出团员数据」会下载到空文件）');
    else log('⚠️ 没能翻回第 1 页，请手动点「首页」，否则网站自带的导出可能是空的');
    return ok;
  }

  /* ---------------- roster capture ---------------- */
  async function captureRoster() {
    if (state.running) return;
    const table = findMemberTable();
    if (!table) {
      log('未找到团员表格，请确认在「团员管理 → 团员列表」页面');
      return;
    }
    state.running = true;
    state._official = undefined; // 组织/筛选可能变了，补齐数据重新取
    renderRoster();
    try {
      const merged = new Map();
      let pageNo = 0;
      const pinfo = pageInfo();
      if (pinfo.current > 1) {
        log(`先回到第 1 页再读（当前在第 ${pinfo.current} 页）`);
        const back = await gotoPage(1);
        if (!back) log('⚠️ 回不到第 1 页，只能从当前页往后读');
      }
      log(`分页：${text(pager()) || '(未识别)'}；共 ${pinfo.total || '?'} 条，约 ${pinfo.pages} 页`);
      for (;;) {
        pageNo += 1;
        readRows(table).forEach((r) => {
          if (r.name) merged.set(r.key, r);
        });
        log(`已读取第 ${pageNo} 页，累计 ${merged.size} 人`);
        const info = pageInfo();
        if (info.total && merged.size >= info.total) break;
        const ok = await clickNext();
        if (!ok) break;
        await sleep(250);
        if (pageNo >= 40) break;
      }
      state.roster = Array.from(merged.values());
      log(`✅ 抓取完成，共 ${state.roster.length} 人`);
      await compareSnapshot();
      if (pinfo.total && state.roster.length < pinfo.total) {
        log(`⚠️ 只抓到 ${state.roster.length}/${pinfo.total} 人，请把这条日志截图反馈给作者`);
      }
      decorate();
    } catch (e) {
      log(`抓取出错：${e.message}`);
    } finally {
      // 必须翻回第 1 页，否则网站自带的「导出团员数据」会下载到空文件
      try {
        await backToFirstPage();
      } catch (e) {
        /* 翻页失败不影响已经抓到的名单 */
      }
      state.running = false;
      renderRoster();
    }
  }

  function appendCurrentPage() {
    const rows = currentRows();
    if (!rows.length) {
      log('当前页没有读到数据');
      return;
    }
    const map = new Map(state.roster.map((r) => [r.key, r]));
    rows.forEach((r) => {
      if (r.name) map.set(r.key, r);
    });
    state.roster = Array.from(map.values());
    log(`已追加本页 ${rows.length} 行，累计 ${state.roster.length} 人`);
    decorate();
    renderRoster();
  }

  async function compareSnapshot() {
    try {
      const ids = state.roster.map((r) => `${r.name}|${r.phone}`);
      const got = await chrome.storage.local.get('zhtjRosterSnapshot');
      const prev = got && got.zhtjRosterSnapshot;
      if (prev && Array.isArray(prev.ids) && prev.ids.length) {
        const oldSet = new Set(prev.ids);
        const newSet = new Set(ids);
        const added = ids.filter((x) => !oldSet.has(x));
        const removed = prev.ids.filter((x) => !newSet.has(x));
        if (added.length || removed.length) {
          const when = prev.at ? new Date(prev.at).toLocaleDateString() : '上次';
          log(`相比${when}：新增 ${added.length} 人，减少 ${removed.length} 人`);
        } else {
          log('与上次名单一致');
        }
      }
      await chrome.storage.local.set({ zhtjRosterSnapshot: { at: Date.now(), ids } });
    } catch (e) {
      /* 非扩展环境忽略 */
    }
  }

  async function waitSignatureChange(prev, timeout) {    const t0 = Date.now();
    while (Date.now() - t0 < timeout) {
      await sleep(120);
      const now = rowSignature();
      if (now && now !== prev) return true;
    }
    return false;
  }

  function currentRows() {
    const table = findMemberTable();
    return table ? readRows(table) : [];
  }

  function findRowByKey(key) {
    const rows = currentRows();
    const exact = rows.find((r) => r.key === key);
    if (exact) return exact;
    // 容错：姓名+手机号 / 仅姓名
    const parts = String(key).split('|');
    const name = parts[1] || '';
    const phone = parts[2] || '';
    return (
      rows.find((r) => r.name === name && r.phone === phone) ||
      rows.find((r) => r.name === name) ||
      null
    );
  }

  async function locateRow(key) {
    let row = findRowByKey(key);
    if (row) return row;
    const info = pageInfo();
    const origin = info.current || 1;
    const pages = Math.max(1, info.pages || 1);
    log(`当前页没找到，逐页搜索（共 ${pages} 页）…`);
    for (let p = 1; p <= pages; p++) {
      if (p === origin) continue;
      const ok = await gotoPage(p);
      if (!ok) continue;
      decorate();
      row = findRowByKey(key);
      if (row) return row;
    }
    if (origin !== pageInfo().current) await gotoPage(origin);
    return null;
  }

  function pageInfo() {
    const p = pager();
    const m = text(p).match(/(\d+)\s*-\s*(\d+)\s*共\s*(\d+)\s*条/);
    if (!m) return { size: state.pageSize || 10, total: 0, current: 1, pages: 1 };
    const start = Number(m[1]);
    const end = Number(m[2]);
    const total = Number(m[3]);
    if (start === 1) state.pageSize = Math.max(1, end);
    const size = state.pageSize || Math.max(1, end - start + 1);
    return { size, total, current: Math.floor((start - 1) / size) + 1, pages: Math.ceil(total / size) };
  }

  async function gotoPage(n) {
    for (let guard = 0; guard < 20; guard++) {
      const info = pageInfo();
      if (info.current === n) return true;
      let ok;
      if (info.current < n) ok = await clickPager('next');
      else if (info.current === n + 1) ok = await clickPager('prev');
      else {
        ok = await clickPager('first');
        // 没有「首页」就一页页退回去
        if (!ok) ok = await clickPager('prev');
      }
      if (!ok) return false;
      await sleep(200);
    }
    return pageInfo().current === n;
  }

  /* ---------------- selection layer ---------------- */
  function injectPageStyle() {
    if (document.getElementById('zhtj-helper-style')) return;
    const s = document.createElement('style');
    s.id = 'zhtj-helper-style';
    s.textContent = `
      .zhtj-row-sel > td { background: #fff1f0 !important; }
      .zhtj-cb { display:inline-block; width:15px; height:15px; line-height:15px; text-align:center;
        border:1px solid #c8161d; border-radius:3px; margin-right:6px; vertical-align:-2px;
        font-size:11px; color:#fff; cursor:pointer; user-select:none; background:#fff; }
      .zhtj-cb.on { background:#c8161d; }
    `;
    document.head.appendChild(s);
  }

  function decorate() {
    const table = findMemberTable();
    if (!table) return;
    $$('.el-table__body tbody tr', table).forEach((tr) => {
      const firstCell = tr.querySelector('td .cell');
      if (!firstCell || firstCell.querySelector('.zhtj-cb')) return;
      const cb = document.createElement('span');
      cb.className = 'zhtj-cb';
      cb.textContent = '';
      cb.dataset.zhtj = '1';
      firstCell.insertBefore(cb, firstCell.firstChild);
    });
    syncDecoration();
  }

  function keyOfRow(tr) {
    const hit = currentRows().find((r) => r.el === tr);
    return hit ? hit.key : '';
  }

  function syncDecoration() {
    currentRows().forEach((r) => {
      const on = state.selected.has(r.key);
      r.el.classList.toggle('zhtj-row-sel', on);
      const cb = r.el.querySelector('.zhtj-cb');
      if (cb) {
        cb.classList.toggle('on', on);
        cb.textContent = on ? '✓' : '';
      }
    });
  }

  function toggleKey(key, force) {
    if (!key) return;
    const on = force == null ? !state.selected.has(key) : force;
    if (on) state.selected.add(key);
    else state.selected.delete(key);
    state.lastKey = key;
    syncDecoration();
    paintRosterSelection();
  }

  // 找到元素所在的滚动容器（有的页面滚动的是内层 div，不是 window）
  function scrollParent(el) {
    let n = el && el.parentElement;
    while (n && n !== document.body) {
      const s = getComputedStyle(n);
      if (/(auto|scroll|overlay)/.test(s.overflowY) && n.scrollHeight > n.clientHeight + 2) return n;
      n = n.parentElement;
    }
    return null;
  }

  document.addEventListener(
    'click',
    (e) => {
      const cb = e.target.closest && e.target.closest('.zhtj-cb');
      if (!cb) return;
      e.preventDefault();
      e.stopPropagation();
      const tr = cb.closest('tr');
      // 勾选时守住所处滚动位置，避免视口被拉回顶部
      const winY = window.scrollY;
      const sc = scrollParent(tr);
      const scY = sc ? sc.scrollTop : 0;
      const dock = shadow && shadow.querySelector('.body[data-pane="roster"]');
      const dockY = dock ? dock.scrollTop : 0;
      const restore = () => {
        if (Math.abs(window.scrollY - winY) > 1) window.scrollTo(0, winY);
        if (sc && Math.abs(sc.scrollTop - scY) > 1) sc.scrollTop = scY;
        if (dock && Math.abs(dock.scrollTop - dockY) > 1) dock.scrollTop = dockY;
      };
      const key = keyOfRow(tr);
      if (e.shiftKey && state.lastKey) {
        const keys = state.roster.map((r) => r.key);
        const a = keys.indexOf(state.lastKey);
        const b = keys.indexOf(key);
        if (a >= 0 && b >= 0) {
          const [s, t] = a < b ? [a, b] : [b, a];
          for (let i = s; i <= t; i++) state.selected.add(keys[i]);
          syncDecoration();
          paintRosterSelection();
          restore();
          return;
        }
      }
      toggleKey(key);
      restore();
    },
    true
  );

  /* ---------------- reset code capture ---------------- */
  function watchDialogs() {
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        for (const n of m.addedNodes) {
          if (n.nodeType !== 1) continue;
          const dlgs = [];
          if (n.matches && n.matches('.el-dialog, .el-message-box')) dlgs.push(n);
          if (n.querySelectorAll) $$('.el-dialog, .el-message-box', n).forEach((d) => dlgs.push(d));
          dlgs.forEach((d) => setTimeout(() => tryDialog(d), 150));
        }
      }
    });
    mo.observe(document.body, { childList: true, subtree: true });
  }

  function startDialogPoll() {
    if (state._poll) return;
    state._poll = setInterval(() => {
      $$('.el-dialog, .el-message-box').forEach(tryDialog);
    }, 500);
  }

  function tryDialog(dlg) {
    if (!visible(dlg)) return;
    const t = text(dlg);
    if (!/重置密码验证码/.test(t)) return;
    const code = (t.match(/验证码[：:]\s*([0-9A-Za-z]{4,20})/) || [])[1] || '';
    const expiry = (t.match(/有效期至[：:]\s*([0-9]{4}-[0-9]{2}-[0-9]{2})/) || [])[1] || '';
    if (!code) return;
    if (dlg.dataset.zhtjSeen === code) return;
    dlg.dataset.zhtjSeen = code;
    if (state.codes.some((c) => c.code === code)) return;
    state.codes.push({
      name: state.pendingName || '（手动）',
      code,
      expiry,
      time: new Date().toTimeString().slice(0, 5),
    });
    state.pendingName = '';
    log(`✅ 已记录验证码：${code}${expiry ? '（有效期至 ' + expiry + '）' : ''}`);
    renderTasks();
    if (state.settings.autoClose) {
      setTimeout(() => {
        const btn =
          $$('button', dlg).find((b) => /确\s*定|关\s*闭/.test(text(b))) ||
          dlg.querySelector('.el-dialog__headerbtn');
        if (btn) btn.click();
      }, 500);
    }
  }

  function findResetAction(tr) {
    if (!tr) return null;
    const tds = $$('td', tr);
    const last = tds[tds.length - 1];
    if (!last) return null;
    const cands = $$('span, a, button, i, em', last);
    const hit =
      cands.find((el) => /重置|钥匙|密码/.test(text(el))) ||
      cands.find((el) => /key|pwd|password/i.test(el.className || '')) ||
      cands.find((el) => /密码/.test(el.getAttribute('title') || '')) ||
      null;
    if (!hit) return null;
    return hit.closest('span, a, button') || hit;
  }

  async function fetchCodesForSelected() {
    if (state.running) return;
    const keys = Array.from(state.selected);
    if (!keys.length) {
      log('请先勾选团员');
      return;
    }
    state.running = true;
    log(`开始取码，共 ${keys.length} 人`);
    try {
      for (const key of keys) {
        const idx = state.roster.findIndex((r) => r.key === key);
        if (idx < 0) continue;
        const item = state.roster[idx];
        const size = pageInfo().size || 10;
        const page = Math.floor(idx / size) + 1;
        const ok = await gotoPage(page);
        if (!ok) log(`⚠️ 翻到第 ${page} 页失败，改为逐页搜索`);
        await sleep(120);
        decorate();
        const row = await locateRow(key);
        if (!row) {
          log(`⚠️ 翻遍所有页也没找到「${item.name}」，跳过`);
          continue;
        }
        const act = findResetAction(row.el);
        if (!act) {
          log(`⚠️ 未找到 ${item.name} 的取码按钮，请手动点该行的钥匙，我会自动记录`);
          state.pendingName = item.name;
          continue;
        }
        state.pendingName = item.name;
        act.click();
        await sleep(state.settings.delay);
        const t0 = Date.now();
        while (Date.now() - t0 < 3000) {
          if (state.codes.some((c) => c.name === item.name)) break;
          await sleep(150);
        }
        await sleep(250);
      }
      log('取码流程结束');
    } finally {
      // 取码同样会翻页，结束时也翻回第 1 页，免得网站自带的导出变成空文件
      try {
        await backToFirstPage();
      } catch (e) {
        /* 忽略 */
      }
      state.running = false;
      renderTasks();
    }
  }

  /* ---------------- export ---------------- */
  function csvCell(v) {
    const s = String(v == null ? '' : v);
    return /[",\r\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  }

  function download(name, content, type = 'text/csv;charset=utf-8') {
    const blob = new Blob([content], { type });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 2000);
  }

  /* ---------- 用网站自带的导出补齐页面表格里没有的列 ---------- */
  // 名单表格只显示 序号/姓名/民族/手机号码/团内职务；性别、团籍是否在本组织、入团年月
  // 是网站导出 xlsx 时才由服务端拼上的列。导出 CSV 时按网站自己那个导出接口取一次，
  // 再按「姓名+手机号」并回名单；取不到就留空，不影响 CSV 正常导出。
  // 接口地址取自网站源码：/v1/center/exportmembers/{页码}/{搜索词}/{身份证号}/{性别}
  const OFFICIAL_EXPORT_URL = '/v1/center/exportmembers/1///-1';

  async function readOfficialExport() {
    if (state._official !== undefined) return state._official;
    state._official = null;
    if (routeKind() !== 'memberlist') return null;
    try {
      const headers = {};
      const tk = csrfToken();
      if (tk) headers['X-CSRF-Token'] = tk;
      const r = await fetch(OFFICIAL_EXPORT_URL, {
        method: 'GET',
        credentials: 'include',
        headers,
        signal: AbortSignal.timeout(8000),
      });
      const type = String(r.headers.get('content-type') || '');
      if (!r.ok || /json|html|text\//i.test(type)) {
        log('网站导出接口暂未取到，性别/团籍/入团年月留空');
        return null;
      }
      const table = await parseXlsx(await r.arrayBuffer());
      if (!table || table.length < 2) return null;
      // 官方导出可能带一行标题（合并单元格），所以往下找真正的表头行
      const norm = (v) => String(v == null ? '' : v).trim();
      let headIdx = -1;
      for (let i = 0; i < Math.min(table.length, 8); i++) {
        if (table[i].map(norm).some((c) => c.includes('姓名'))) {
          headIdx = i;
          break;
        }
      }
      if (headIdx < 0) return null;
      const head = table[headIdx].map(norm);
      const iName = headerIndex(head, ['姓名']);
      const iPhone = headerIndex(head, ['手机号码', '手机号', '手机', '联系电话']);
      const iGender = headerIndex(head, ['性别']);
      const iInOrg = headerIndex(head, ['团籍是否在本组织', '团籍是否在本', '团籍']);
      const iJoin = headerIndex(head, ['入团年月', '入团时间', '入团日期']);
      if (iName < 0) return null;
      // 有些机器导出的单元格是 0/1 或日期序号，统一成能看懂的值
      const normGender = (v) => {
        const s = norm(v);
        if (s === '1') return '男';
        if (s === '0') return '女';
        return s;
      };
      const normYes = (v) => {
        const s = norm(v);
        if (s === '1' || s.toLowerCase() === 'true') return '是';
        if (s === '0' || s.toLowerCase() === 'false') return '否';
        return s;
      };
      const normYm = (v) => {
        const s = norm(v);
        if (/^\d{5}(\.\d+)?$/.test(s)) {
          const d = new Date(Date.UTC(1899, 11, 30) + Math.round(Number(s)) * 86400000);
          const y = d.getUTCFullYear();
          if (y > 1990 && y < 2100) return `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
        }
        if (/^\d{6}$/.test(s)) return `${s.slice(0, 4)}-${s.slice(4, 6)}`;
        return s;
      };
      const list = table
        .slice(headIdx + 1)
        .map((r) => ({
          name: cleanName(r[iName]),
          phone: iPhone >= 0 ? norm(r[iPhone]) : '',
          gender: iGender >= 0 ? normGender(r[iGender]) : '',
          inOrg: iInOrg >= 0 ? normYes(r[iInOrg]) : '',
          joinYm: iJoin >= 0 ? normYm(r[iJoin]) : '',
        }))
        .filter((r) => r.name);
      state._official = list;
      if (list.length) log(`已读到网站导出的 ${list.length} 行，用来补齐性别/团籍/入团年月`);
      return list;
    } catch (e) {
      log(`补齐字段失败（不影响导出）：${e.message}`);
      return null;
    }
  }

  async function enrichRoster() {
    if (!state.roster.some((r) => !r.gender || !r.inOrg || !r.joinYm)) return;
    const list = await readOfficialExport();
    if (!list || !list.length) return;
    const byKey = new Map();
    const byName = new Map();
    list.forEach((r) => {
      if (r.phone && !byKey.has(`${r.name}|${r.phone}`)) byKey.set(`${r.name}|${r.phone}`, r);
      const arr = byName.get(r.name) || [];
      arr.push(r);
      byName.set(r.name, arr);
    });
    let hit = 0;
    state.roster.forEach((row) => {
      let src = byKey.get(`${row.name}|${row.phone}`);
      if (!src) {
        // 官方导出里没有手机号时，只有同名唯一才敢对齐，避免张冠李戴
        const arr = byName.get(row.name) || [];
        if (arr.length === 1) src = arr[0];
      }
      if (!src) return;
      if (!row.gender && src.gender) row.gender = src.gender;
      if (!row.inOrg && src.inOrg) row.inOrg = src.inOrg;
      if (!row.joinYm && src.joinYm) row.joinYm = src.joinYm;
      hit += 1;
    });
    if (hit) log(`已补齐 ${hit} 人的性别/团籍/入团年月`);
  }

  async function exportRoster() {
    const rows = state.roster.filter((r) => !state.selected.size || state.selected.has(r.key));
    if (!rows.length) {
      log('没有可导出的数据');
      return;
    }
    try {
      await enrichRoster();
    } catch (e) {
      /* 补齐失败也照常导出 */
    }
    const data = [['序号', '姓名', '性别', '民族', '手机号码', '团内职务', '团籍是否在本组织', '入团年月']];
    rows.forEach((r) => data.push([r.no, r.name, r.gender, r.ethnic, r.phone, r.duty, r.inOrg, r.joinYm]));
    const csv = '\uFEFF' + data.map((r) => r.map(csvCell).join(',')).join('\r\n');
    const d = new Date();
    download(`团员名单_${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}.csv`, csv);
    log(`已导出 ${rows.length} 人`);
  }

  // 每行「姓名：验证码」，方便直接发出去让团员认领
  function codesText() {
    return state.codes.map((c) => `${c.name}：${c.code}`).join('\r\n');
  }

  function copyCodes() {
    if (!state.codes.length) {
      log('还没有记录到验证码');
      return;
    }
    copyText(codesText());
    log(`已复制 ${state.codes.length} 条验证码（姓名：验证码）`);
  }

  function exportCodes() {
    if (!state.codes.length) {
      log('还没有记录到验证码');
      return;
    }
    const d = new Date();
    const day = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`;
    download(`重置码_${day}.txt`, '\uFEFF' + codesText(), 'text/plain;charset=utf-8');
    log(`已导出 ${state.codes.length} 条到 重置码_${day}.txt`);
  }

  function copyText(t) {
    try {
      navigator.clipboard.writeText(t);
    } catch (e) {
      const ta = document.createElement('textarea');
      ta.value = t;
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
  }

  /* ---------------- 版本与更新入口 ---------------- */
  // 版本以 manifest 为准，避免 content.js 里的版本号与打包版本不一致
  const VERSION =
    typeof chrome !== 'undefined' &&
    chrome.runtime &&
    typeof chrome.runtime.getManifest === 'function'
      ? chrome.runtime.getManifest().version
      : '0.0.0';

  // Edge 商店版由构建脚本改为 false；
  // 完整版保持 true，由独立脚本负责网络检查，本文件只负责显示。
  const HAS_UPDATER = true;

  // 网络检查在独立脚本中；这里只把结果画到面板上。
  function showUpdateBar() {
    if (!shadow) return;
    const elb = shadow.querySelector('[data-upd]');
    if (!elb) return;
    if (!state.update) {
      elb.style.display = 'none';
      return;
    }
    elb.style.display = 'inline-block';
    elb.textContent = `新版 v${state.update.version}`;
    elb.title = '点击打开下载页';
  }

  // 供更新脚本回调；Edge 版没有更新脚本，hasUpdater 为 false。
  window.__CYLAA_HOST__ = {
    version: VERSION,
    hasUpdater: HAS_UPDATER,
    setUpdate(info) {
      state.update = info || null;
      showUpdateBar();
      const pane = shadow && shadow.querySelector('[data-pane="set"]');
      if (pane && pane.style.display !== 'none') renderSettings();
    },
    log,
  };

  // 更新脚本就绪后，如果设置页正开着，重画一次更新区域
  window.addEventListener('cylaa:updater-ready', () => {
    const pane = shadow && shadow.querySelector('[data-pane="set"]');
    if (pane && pane.style.display !== 'none') renderSettings();
    showUpdateBar();
  });

  /* ---------------- UI ---------------- */
  let root, shadow, el = {};

  // 重建面板内容时保住滚动位置，否则列表会跳回顶部
  function keepPanelScroll(pane, fn) {
    const bodyTop = pane.scrollTop;
    const list = pane.querySelector('.list');
    const listTop = list ? list.scrollTop : 0;
    fn();
    pane.scrollTop = bodyTop;
    const nl = pane.querySelector('.list');
    if (nl) nl.scrollTop = listTop;
  }

  function activateTab(name) {
    if (!shadow) return;
    const tab = shadow.querySelector(`.tabs div[data-tab="${name}"]`);
    if (!tab) return;
    shadow.querySelectorAll('.tabs div').forEach((x) => x.classList.toggle('on', x === tab));
    shadow.querySelectorAll('.body').forEach((p) => (p.style.display = p.dataset.pane === name ? 'block' : 'none'));
    if (name === 'pj') renderPj();
    if (name === 'imp') renderImp();
    if (name === 'info') renderInfo();
    if (name === 'roster') renderRoster();
    if (name === 'task') renderTasks();
  }

  /* ---------------- 悬浮球：位置、拖动、吸附 ---------------- */
  // 悬浮球（收起后的小圆钮）可以拖到任意位置；开启吸附时松手贴到最近的左右页边。
  // 展开成卡片时按球所在的半边决定往外/往里展开的方向，并把卡片整体夹在屏幕内。
  const BALL_SIZE = 46; // 小球直径，和 .dock.mini 的尺寸保持一致
  const DOCK_EDGE = 8; // 展开卡片与屏幕边缘的最小留白
  let dockEl = null;

  const viewportSize = () => ({ w: window.innerWidth, h: window.innerHeight });
  const clampNum = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  // 记录的是悬浮球左上角坐标；没记录过（或窗口变小）时给一个贴右上的默认位置
  function ballPos() {
    const { w, h } = viewportSize();
    let x = Number(state.settings.ballX);
    let y = Number(state.settings.ballY);
    if (!Number.isFinite(x) || state.settings.ballX == null) x = w - BALL_SIZE;
    if (!Number.isFinite(y) || state.settings.ballY == null) y = 88;
    return { x: clampNum(x, 0, Math.max(0, w - BALL_SIZE)), y: clampNum(y, 0, Math.max(0, h - BALL_SIZE)) };
  }

  // 收起状态：小球就在记录的位置
  function placeBall() {
    if (!root) return;
    const b = ballPos();
    root.style.left = `${b.x}px`;
    root.style.top = `${b.y}px`;
    root.style.right = 'auto';
  }

  // 展开状态：球在右半边就贴右展开，在左半边就贴左展开；
  // 球在下半边就向上展开，否则向下展开；最后整体夹进视口，避免卡片跑到屏幕外
  function placeDock() {
    if (!root || !dockEl) return;
    const { w, h } = viewportSize();
    // 先放开高度限制量出自然高度（窄屏时宽度也收一收）
    dockEl.style.maxHeight = `${Math.max(240, h - DOCK_EDGE * 2)}px`;
    dockEl.style.width = w < 420 + DOCK_EDGE * 2 ? `${Math.max(260, w - DOCK_EDGE * 2)}px` : '';
    const width = dockEl.offsetWidth || 420;
    const height = dockEl.offsetHeight || 0;
    const b = ballPos();
    const cx = b.x + BALL_SIZE / 2;
    const cy = b.y + BALL_SIZE / 2;
    let left = cx > w / 2 ? b.x + BALL_SIZE - width : b.x;
    let top = cy > h / 2 ? b.y + BALL_SIZE - height : b.y;
    // 横向允许贴边（吸附后和原来一样贴住页边），纵向留 8px 呼吸位
    left = clampNum(left, 0, Math.max(0, w - width));
    top = clampNum(top, DOCK_EDGE, Math.max(DOCK_EDGE, h - height - DOCK_EDGE));
    root.style.left = `${left}px`;
    root.style.top = `${top}px`;
    root.style.right = 'auto';
    dockEl.style.maxHeight = `${Math.max(240, h - top - DOCK_EDGE)}px`;
    // 贴着哪边，就只保留另一侧圆角，视觉上和原来贴边时一致
    const atRight = left + width >= w - 2;
    const atLeft = left <= 2;
    dockEl.classList.toggle('at-right', atRight && !atLeft);
    dockEl.classList.toggle('at-left', atLeft && !atRight);
  }

  function applyBallLayout() {
    if (!dockEl) return;
    if (dockEl.classList.contains('mini')) placeBall();
    else placeDock();
  }

  // 吸附到最近的页边：左右二选一，纵向保持不变
  function snapBallToEdge() {
    const { w, h } = viewportSize();
    const b = ballPos();
    state.settings.ballX = b.x + BALL_SIZE / 2 < w / 2 ? 0 : w - BALL_SIZE;
    state.settings.ballY = clampNum(b.y, 0, Math.max(0, h - BALL_SIZE));
    applyBallLayout();
  }

  function saveSettings() {
    try {
      chrome.storage.local.set({ zhtjHelperSettings: state.settings });
    } catch (e) {
      /* 非扩展环境忽略 */
    }
  }

  // 拖动结束后浏览器还会补一个 click，别把它当成“点开面板”
  function takeSwallowedClick() {
    if (!state._swallowClick) return false;
    state._swallowClick = false;
    return true;
  }

  function mount() {
    const host = document.createElement('div');
    host.id = 'zhtj-helper-host';
    host.style.cssText = 'position:fixed;z-index:2147483000;left:0;top:88px;';
    document.body.appendChild(host);
    shadow = host.attachShadow({ mode: 'open' });
    shadow.innerHTML = `
      <style>
        *{box-sizing:border-box;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
        .dock{width:420px;max-height:calc(100vh - 24px);background:#fff;border-radius:12px;
          box-shadow:0 6px 24px rgba(0,0,0,.14);display:flex;flex-direction:column;overflow:hidden;
          border:1px solid #eee;font-size:13px;color:#222}
        /* 展开后贴着某一侧页边时，只保留内侧圆角，和原来贴右时的观感一致 */
        .dock.at-right{border-radius:12px 0 0 12px;border-right:none;box-shadow:-6px 0 24px rgba(0,0,0,.14)}
        .dock.at-left{border-radius:0 12px 12px 0;border-left:none;box-shadow:6px 0 24px rgba(0,0,0,.14)}
        .hd{display:flex;align-items:center;gap:8px;padding:10px 12px;background:linear-gradient(90deg,#c8161d,#e23c3c);color:#fff}
        .hd .lg{width:26px;height:26px;flex:none;border-radius:50%;background:#fff;padding:1px;
          object-fit:contain;box-shadow:0 1px 3px rgba(0,0,0,.2)}
        .hd b{font-size:14px;font-weight:600;letter-spacing:.5px}
        .hd .tag{font-size:11px;background:rgba(255,255,255,.2);padding:2px 6px;border-radius:8px}
        .hd .upd{font-size:11px;background:#fff;color:#c8161d;border-radius:8px;padding:1px 6px;cursor:pointer}
        .hd .sp{flex:1}
        .hd button{background:transparent;border:0;color:#fff;cursor:pointer;font-size:15px;padding:2px 6px}
        .tabs{display:flex;border-bottom:1px solid #eee;background:#fafafa}
        .tabs div{flex:1;text-align:center;padding:8px 0;cursor:pointer;color:#666;font-size:13px}
        .tabs div.on{color:#c8161d;border-bottom:2px solid #c8161d;font-weight:600}
        .body{padding:10px 12px;overflow:auto;flex:1}
        .row{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:8px}
        button.b{border:1px solid #ddd;background:#fff;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px;color:#333}
        button.b:hover{border-color:#c8161d;color:#c8161d}
        button.b.p{background:#c8161d;border-color:#c8161d;color:#fff}
        button.b.p:hover{background:#a91117;color:#fff}
        .stat{display:flex;gap:10px;margin:6px 0 10px;font-size:12px;color:#666}
        .stat i{font-style:normal;color:#c8161d;font-weight:600;font-size:15px}
        .list{border:1px solid #f0f0f0;border-radius:8px;max-height:280px;overflow:auto}
        .item{display:flex;align-items:center;gap:8px;padding:6px 8px;border-bottom:1px solid #f6f6f6;cursor:pointer}
        .item:last-child{border-bottom:0}
        .item:hover{background:#fff8f8}
        .item .cb{width:14px;height:14px;border:1px solid #c8161d;border-radius:3px;flex:none;
          display:flex;align-items:center;justify-content:center;font-size:10px;color:#fff}
        .item.on .cb{background:#c8161d}
        .item .nm{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .item .ph{color:#999;font-size:11px}
        .item .pg{font-size:10px;color:#c8161d;border:1px solid #f0c9cb;border-radius:3px;padding:0 3px}
        .item .plan{font-size:11px;line-height:16px;padding:0 4px;border-radius:3px;background:#c8161d;color:#fff}
        .item .x{color:#c8c8c8;padding:0 3px;font-size:12px}
        .item .x:hover{color:#c8161d}
        .warn{background:#fff7e6;border:1px solid #ffd591;color:#a15c00;border-radius:6px;
          padding:6px 8px;font-size:11px;line-height:1.6;margin-bottom:8px}
        .rv{display:flex;align-items:center;gap:8px;padding:5px 8px;border-bottom:1px solid #f6f6f6;font-size:12px}
        .rv .rn{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .rv .rl{color:#c8161d;font-weight:600}
        .rv .rp{color:#bbb;font-size:11px}
        .fld{padding:6px 4px;border-bottom:1px solid #f6f6f6}
        .fh{display:flex;align-items:center;gap:6px;font-size:12px;margin-bottom:4px}
        .fh .fl{font-weight:600;color:#333}
        .fh .fk{font-size:10px;color:#999;border:1px solid #eee;border-radius:3px;padding:0 3px}
        .fh .fk.ro{color:#c8161d;border-color:#f0c9cb}
        .fh .fv{margin-left:auto;color:#999;font-size:11px;max-width:150px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
        .fi{width:100%;border:1px solid #ddd;border-radius:6px;padding:5px 7px;font-size:12px;outline:none}
        .fi:focus{border-color:#c8161d}
        .fi.dim{border-style:dashed;background:#fafafa;color:#bbb;font-size:11px;padding:4px 7px}
        .fld.locked{opacity:.72}
        button.b:disabled{color:#bbb;border-color:#eee;cursor:not-allowed}
        .log{background:#0f1115;color:#9ee493;border-radius:8px;padding:8px;height:150px;overflow:auto;
          font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.55;white-space:pre-wrap}
        .logbar{display:flex;align-items:center;gap:6px;padding:5px 12px;border-top:1px solid #eee;
          font-size:11px;color:#888;background:#fafafa}
        .logbar i{font-style:normal;color:#c8161d;font-weight:600}
        .logbar button{background:none;border:0;color:#c8161d;font-size:11px;cursor:pointer;padding:0 2px}
        .logbox{height:180px;overflow:auto;background:#0f1115;color:#9ee493;
          font-family:ui-monospace,Consolas,monospace;font-size:11px;line-height:1.55;
          white-space:pre-wrap;padding:8px 10px;border-top:1px solid #000}
        .dock.mini .logbar,.dock.mini .logbox{display:none!important}
        .empty{color:#999;text-align:center;padding:18px 0;font-size:12px}
        .code{display:flex;align-items:center;gap:8px;padding:5px 6px;border-bottom:1px solid #f4f4f4;font-size:12px}
        .code b{font-family:ui-monospace,Consolas,monospace;color:#c8161d;font-size:14px;letter-spacing:1px}
        .code .n{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
        .foot{padding:8px 12px;border-top:1px solid #eee;font-size:11px;color:#999;display:flex;justify-content:space-between}
        .dock.mini{width:46px;height:46px;border-radius:23px;cursor:grab;touch-action:none;
          user-select:none;-webkit-user-select:none}
        .dock.mini.dragging{cursor:grabbing}
        .dock.mini .tabs,.dock.mini .body,.dock.mini .foot{display:none!important}
        .dock.mini .hd{padding:0;height:46px;justify-content:center}
        .dock.mini .hd{position:relative}
        .dock.mini .hd .lg{width:34px;height:34px;padding:2px}
        .dock.mini .hd b,.dock.mini .hd .tag,.dock.mini .hd .sp{display:none}
        /* 收起成小圆钮时，整个圆钮就是展开按钮（铺满、透明，保留键盘可聚焦） */
        .dock.mini .hd button{position:absolute;inset:0;width:100%;height:100%;font-size:0;opacity:0;cursor:grab}
        .dock.mini.dragging .hd button{cursor:grabbing}
        label.sw{display:flex;align-items:center;gap:6px;font-size:12px;color:#444;margin:6px 0}
        .tiny{font-size:11px;color:#999;line-height:1.6}
        textarea.ta{width:100%;height:110px;border:1px solid #ddd;border-radius:6px;padding:6px;font-size:11px;
          font-family:ui-monospace,Consolas,monospace;resize:vertical;outline:none}
        .tbl{width:100%;border-collapse:collapse;font-size:11px}
        .tbl th,.tbl td{border-bottom:1px solid #f0f0f0;padding:4px 5px;text-align:left;vertical-align:top}
        .tbl th{color:#999;font-weight:500}
        .bad{color:#c8161d}
        .ok{color:#0a8a3a}
      </style>
      <div class="dock">
        <div class="hd">
          ${LOGO_URL ? `<img class="lg" src="${LOGO_URL}" alt="团务助手" title="团务助手 · 智慧团建">` : ''}<b>团务助手</b><span class="tag">v${VERSION}</span>${HAS_UPDATER ? '<span class="upd" data-upd style="display:none"></span>' : ''}<span class="sp"></span>
          <button title="收起">—</button>
        </div>
        <div class="tabs">
          <div data-tab="roster" class="on">名单</div>
          <div data-tab="pj">评议</div>
          <div data-tab="info">信息</div>
          <div data-tab="imp">录入</div>
          <div data-tab="task">取码</div>
          <div data-tab="set">设置</div>
        </div>
        <div class="body" data-pane="roster"></div>
        <div class="body" data-pane="pj" style="display:none"></div>
        <div class="body" data-pane="info" style="display:none"></div>
        <div class="body" data-pane="imp" style="display:none"></div>
        <div class="body" data-pane="task" style="display:none"></div>
        <div class="body" data-pane="set" style="display:none"></div>
        <div class="logbar"><span>日志 <i data-logn>0</i></span><span class="sp"></span>
          <button data-act="logtoggle">展开</button>
          <button data-act="logcopy">复制</button>
          <button data-act="logclear">清空</button>
        </div>
        <div class="logbox" style="display:none"></div>
        <div class="foot"><span data-kind>—</span><span>批量任务需确认后自动提交 · 请核对</span></div>
      </div>
    `;
    root = host;
    showUpdateBar();
    shadow.querySelectorAll('.tabs div').forEach((d) =>
      d.addEventListener('click', () => activateTab(d.dataset.tab))
    );
    // 列表项用事件委托：内容重建后依然有效，也避免每次渲染重复绑定
    const rosterPane = shadow.querySelector('[data-pane="roster"]');
    rosterPane.addEventListener('click', (e) => {
      const it = e.target.closest && e.target.closest('.item');
      if (!it || !it.dataset.key) return;
      toggleKey(it.dataset.key);
    });
    const pjPane = shadow.querySelector('[data-pane="pj"]');
    pjPane.addEventListener('click', (e) => onPjRowClick(e));

    // 底部日志抽屉：各页签共用
    const logbox = shadow.querySelector('.logbox');
    const logToggle = shadow.querySelector('[data-act="logtoggle"]');    logToggle.addEventListener('click', () => {
      const show = logbox.style.display === 'none';
      logbox.style.display = show ? 'block' : 'none';
      logToggle.textContent = show ? '收起' : '展开';
      renderLog();
    });
    shadow.querySelector('[data-act="logcopy"]').addEventListener('click', () => {
      copyText(state.logs.join('\n'));
    });
    shadow.querySelector('[data-act="logclear"]').addEventListener('click', () => {
      state.logs = [];
      renderLog();
    });

    const updEl = shadow.querySelector('[data-upd]');
    if (updEl)
      updEl.addEventListener('click', () => {
        const u = window.__CYLAA_UPDATER__;
        if (u) u.open();
        else log('更新检查未启用');
      });
    const dock = shadow.querySelector('.dock');
    dockEl = dock;
    const miniBtn = shadow.querySelector('.hd button');
    const setMini = (mini) => {
      dock.classList.toggle('mini', mini);
      if (mini) {
        // 小球是圆的，别留着展开态“贴边”的直角/无边框
        dock.classList.remove('at-right', 'at-left');
        dock.style.width = '';
      }
      miniBtn.textContent = mini ? '' : '—';
      miniBtn.title = mini ? '展开' : '收起';
      miniBtn.setAttribute('aria-label', mini ? '展开团务助手' : '收起团务助手');
      if (!mini) {
        const active = shadow.querySelector('.tabs div.on') || shadow.querySelector('.tabs div');
        shadow.querySelectorAll('.body').forEach((p) => {
          p.style.display = active && p.dataset.pane === active.dataset.tab ? 'block' : 'none';
        });
      }
      // 收起时回到悬浮球的位置；展开时按球在屏幕的哪半边决定卡片朝哪边展开
      applyBallLayout();
    };
    miniBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      if (takeSwallowedClick()) return;
      setMini(!dock.classList.contains('mini'));
    });
    dock.addEventListener('click', () => {
      if (takeSwallowedClick()) return;
      if (dock.classList.contains('mini')) setMini(false);
    });

    // 拖动悬浮球：只有收起成小球时可拖；移动超过 4px 才算拖动，否则仍然是点击展开
    let drag = null;
    dock.addEventListener('pointerdown', (e) => {
      if (!dock.classList.contains('mini')) return;
      if (e.button != null && e.button !== 0) return;
      const b = ballPos();
      drag = { id: e.pointerId, sx: e.clientX, sy: e.clientY, bx: b.x, by: b.y, moved: false };
      try {
        dock.setPointerCapture(e.pointerId);
      } catch (err) {
        /* 老浏览器忽略 */
      }
      dock.classList.add('dragging');
    });
    dock.addEventListener('pointermove', (e) => {
      if (!drag || e.pointerId !== drag.id) return;
      const dx = e.clientX - drag.sx;
      const dy = e.clientY - drag.sy;
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      drag.moved = true;
      const { w, h } = viewportSize();
      state.settings.ballX = clampNum(drag.bx + dx, 0, Math.max(0, w - BALL_SIZE));
      state.settings.ballY = clampNum(drag.by + dy, 0, Math.max(0, h - BALL_SIZE));
      placeBall();
      if (e.cancelable) e.preventDefault();
    });
    const endDrag = (e) => {
      if (!drag || (e && e.pointerId !== drag.id)) return;
      const moved = drag.moved;
      try {
        dock.releasePointerCapture(drag.id);
      } catch (err) {
        /* 忽略 */
      }
      drag = null;
      dock.classList.remove('dragging');
      if (!moved) return;
      state._swallowClick = true;
      setTimeout(() => {
        state._swallowClick = false;
      }, 400);
      if (state.settings.snapEdge) snapBallToEdge();
      else placeBall();
      saveSettings();
    };
    dock.addEventListener('pointerup', endDrag);
    dock.addEventListener('pointercancel', endDrag);
    window.addEventListener('resize', () => applyBallLayout());

    renderAll();
    renderLog();
    applyBallLayout();
    // 刷新后（比如为了回到第 1 页）把评议页签和已读取的数据恢复出来
    if (routeKind() === 'twosystem' && pjState.rows.length) activateTab('pj');
  }

  function renderAll() {
    renderRoster();
    renderTasks();
    renderPj();
    renderInfo();
    renderImp();
    renderSettings();
    const k = routeKind();
    const label =
      { memberlist: '团员列表', transfer: '组织关系审批', record: '电子数据库', twosystem: '两制', memberinfo: '团员信息', other: '其他页面' }[k] ||
      '—';
    const n = shadow.querySelector('[data-kind]');
    if (n) n.textContent = label;
  }

  // 只改选中态，不重建 DOM —— 重建会让列表滚回顶部
  function paintRosterSelection() {
    const pane = shadow && shadow.querySelector('[data-pane="roster"]');
    if (!pane) return;
    pane.querySelectorAll('.item').forEach((it) => {
      const on = state.selected.has(it.dataset.key);
      it.classList.toggle('on', on);
      const cb = it.querySelector('.cb');
      if (cb) cb.textContent = on ? '✓' : '';
    });
    const sel = pane.querySelector('[data-sel]');
    if (sel) sel.textContent = String(state.selected.size);
  }

  function renderRoster() {
    const pane = shadow && shadow.querySelector('[data-pane="roster"]');
    if (!pane) return;
    const sig = state.roster.map((r) => r.key).join(',');
    if (sig === state._rosterSig && pane.querySelector('.list')) {
      paintRosterSelection();
      return;
    }
    state._rosterSig = sig;
    const total = state.roster.length;
    const sel = state.selected.size;
    const list = state.roster
      .slice(0, 80)
      .map(
        (r) => `<div class="item ${state.selected.has(r.key) ? 'on' : ''}" data-key="${esc(r.key)}">
          <span class="cb">${state.selected.has(r.key) ? '✓' : ''}</span>
          <span class="nm">${esc(r.name || '(空)')}</span>
          <span class="ph">${esc((r.phone || '').slice(-4))}</span>
        </div>`
      )
      .join('');
    keepPanelScroll(pane, () => {
      pane.innerHTML = `
      <div class="row">
        <button class="b p" data-act="capture">抓取名单</button>
        <button class="b" data-act="append">追加本页</button>
        <button class="b" data-act="all">全选</button>
        <button class="b" data-act="none">清空</button>
        <button class="b" data-act="export">导出CSV</button>
      </div>
      <div class="stat"><span>共 <i>${total}</i> 人</span><span>已选 <i data-sel>${sel}</i> 人</span></div>
      <div class="list">${list || '<div class="empty">还没有数据，点「抓取名单」</div>'}</div>
      <div class="tiny" style="margin-top:8px">提示：表格每行最前面的方框就是勾选，支持 Shift 连选。</div>
    `;
    });
    pane.querySelectorAll('[data-act]').forEach((b) =>
      b.addEventListener('click', () => {
        const a = b.dataset.act;
        if (a === 'capture') captureRoster();
        if (a === 'append') appendCurrentPage();
        if (a === 'all') {
          state.roster.forEach((r) => state.selected.add(r.key));
          syncDecoration();
          paintRosterSelection();
        }
        if (a === 'none') {
          state.selected.clear();
          syncDecoration();
          paintRosterSelection();
        }
        if (a === 'export') exportRoster();
      })
    );
  }

  function renderTasks() {
    const pane = shadow && shadow.querySelector('[data-pane="task"]');
    if (!pane) return;
    const codes = state.codes
      .map(
        (c, i) => `<div class="code">
          <span class="n">${esc(c.name)}</span>
          <b>${esc(c.code)}</b>
          <span class="ph">${esc(c.expiry || '')}</span>
          <span class="x" data-copyone="${i}" title="复制这一条">复制</span>
        </div>`
      )
      .join('');
    pane.innerHTML = `
      <div class="row">
        <button class="b p" data-act="getcode">为选中人员取码</button>
        <button class="b" data-act="export">导出码</button>
        <button class="b" data-act="copy">复制全部</button>
        <button class="b" data-act="clear">清空</button>
      </div>
      <div class="stat"><span>已记录 <i>${state.codes.length}</i> 条</span><span>待取 <i>${state.selected.size}</i> 人</span></div>
      <div class="list" style="max-height:340px">${codes || '<div class="empty">先在「名单」勾人，或直接点页面上的钥匙<br>弹窗出现后自动记录</div>'}</div>
      <div class="tiny" style="margin-top:8px">
        导出的文件每行是「姓名：验证码」，可以直接发群里让团员认领。<br>
        插件只读弹窗里的码，不点提交、不改任何数据。
      </div>
    `;
    pane.querySelector('[data-act="getcode"]').addEventListener('click', fetchCodesForSelected);
    pane.querySelector('[data-act="export"]').addEventListener('click', exportCodes);
    pane.querySelector('[data-act="copy"]').addEventListener('click', copyCodes);
    pane.querySelector('[data-act="clear"]').addEventListener('click', () => {
      state.codes = [];
      renderTasks();
      renderLog();
    });
    pane.querySelectorAll('[data-copyone]').forEach((x) =>
      x.addEventListener('click', () => {
        const c = state.codes[Number(x.dataset.copyone)];
        if (!c) return;
        copyText(`${c.name}：${c.code}`);
        log(`已复制：${c.name}：${c.code}`);
      })
    );
    const lg = pane.querySelector('.log');
    if (lg) lg.scrollTop = lg.scrollHeight;
  }

  /* ---------------- 评议助手（两制） ---------------- */
  const PJ_LEVELS = ['优秀', '合格', '基本合格', '不合格'];
  const PJ_CACHE_KEY = 'zhtjPjCache';
  const pjState = {
    sel: new Set(),
    plan: new Map(), // key -> 等次（只在面板里，未写入网站）
    level: '合格',
    onlyEmpty: true,
    busy: false,
    mode: 'list', // list | review
    rows: [], // 已读取的全部页数据 {key,no,name,result,page,...}
    collectedAt: 0,
    year: '',
    _sig: '',
  };

  // 名单/勾选放 sessionStorage：翻页通常是自动的，但万一页面结构变了、
  // 只能靠刷新回第 1 页时，数据不会丢。关掉标签页即失效。
  function savePjCache() {
    try {
      sessionStorage.setItem(
        PJ_CACHE_KEY,
        JSON.stringify({
          at: pjState.collectedAt || Date.now(),
          year: pjState.year,
          rows: pjState.rows.map((r) => ({
            key: r.key,
            no: r.no,
            name: r.name,
            year: r.year,
            join: r.join,
            result: r.result,
            cnt: r.cnt,
            auth: r.auth,
            page: r.page,
          })),
          sel: Array.from(pjState.sel),
          plan: Array.from(pjState.plan.entries()),
          level: pjState.level,
          onlyEmpty: pjState.onlyEmpty,
        })
      );
    } catch (e) {
      /* 隐私模式等忽略 */
    }
  }

  function loadPjCache() {
    try {
      const raw = sessionStorage.getItem(PJ_CACHE_KEY);
      if (!raw) return 0;
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.rows) || !o.rows.length) return 0;
      if (Date.now() - (o.at || 0) > 6 * 3600 * 1000) return 0;
      pjState.rows = o.rows;
      pjState.collectedAt = o.at || 0;
      pjState.year = o.year || '';
      pjState.sel = new Set(Array.isArray(o.sel) ? o.sel : []);
      pjState.plan = new Map(Array.isArray(o.plan) ? o.plan : []);
      if (o.level) pjState.level = o.level;
      if (typeof o.onlyEmpty === 'boolean') pjState.onlyEmpty = o.onlyEmpty;
      return o.rows.length;
    } catch (e) {
      return 0;
    }
  }

  function clearPjCache() {
    pjState.rows = [];
    pjState.sel.clear();
    pjState.plan.clear();
    pjState.mode = 'list';
    pjState.collectedAt = 0;
    pjState._sig = '';
    try {
      sessionStorage.removeItem(PJ_CACHE_KEY);
    } catch (e) {}
  }

  function setPjResult(key, result) {
    const hit = pjState.rows.find((r) => r.key === key);
    if (hit) hit.result = result;
  }

  function findPjTable() {
    const tables = $$('.el-table').filter(visible);
    return (
      tables.find((t) => {
        const h = tableHeaders(t);
        return h.some((x) => x.includes('评议结果')) && h.includes('姓名');
      }) || null
    );
  }

  function readPjRows() {
    const t = findPjTable();
    if (!t) return [];
    const heads = tableHeaders(t);
    const kw = (name) => heads.findIndex((h) => h.includes(name));
    const iNo = kw('序号');
    const iName = kw('姓名');
    const iYear = kw('评议年度');
    const iJoin = kw('入团时间');
    const iRes = kw('评议结果');
    const iCnt = kw('优秀次数') >= 0 ? kw('优秀次数') : kw('年度评议');
    const iAuth = kw('上级认证');
    const trs = $$('.el-table__body tbody tr', t).filter((tr) => $$('td', tr).length);
    const curPage = pageInfo().current || 1;
    const seen = new Set();
    return trs.map((tr, i) => {
      const tds = $$('td', tr);
      const at = (k) => (k >= 0 && tds[k] ? cellText(tds[k]) : '');
      const selEl = tr.querySelector('.el-select');
      const input = selEl && selEl.querySelector('input');
      const raw = (input && input.value) || at(iRes) || '';
      const no = at(iNo) || String(i + 1);
      const name = cleanName(at(iName));
      // 用姓名当主键（跨页/刷新都稳定），重名时补序号
      let key = name || `#${no}`;
      if (seen.has(key)) key = `${key}#${no}`;
      seen.add(key);
      return {
        key,
        no,
        name,
        year: at(iYear),
        join: at(iJoin),
        result: String(raw).trim() || '请选择',
        cnt: at(iCnt),
        auth: at(iAuth),
        el: tr,
        selEl,
        page: curPage,
      };
    });
  }

  // 展开下拉：点一下输入框，然后轮询等它出现（Element UI 有时是异步渲染的）
  async function openSelect(selEl, useMouse) {
    const input = selEl.querySelector('input');
    const target = input || selEl;
    if (useMouse) {
      target.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
      target.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    }
    target.click();
    for (let i = 0; i < 12; i++) {
      await sleep(100);
      const drops = $$('.el-select-dropdown').filter(visible);
      const drop = drops[drops.length - 1];
      if (drop && $$('.el-select-dropdown__item', drop).length) return drop;
    }
    return null;
  }

  async function setSelectOption(selEl, label) {
    if (!selEl) return false;
    for (let attempt = 0; attempt < 2; attempt++) {
      const drop = await openSelect(selEl, attempt > 0);
      if (!drop) continue;
      const items = $$('.el-select-dropdown__item', drop).filter(visible);
      const item = items.find((x) => text(x) === label) || items.find((x) => text(x).indexOf(label) >= 0);
      if (!item) {
        document.body.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return false;
      }
      item.click();
      await sleep(200);
      const input = selEl.querySelector('input');
      const val = input ? String(input.value || '') : '';
      // 值没变成目标等次就再来一次（有的组件第一次点只是收起下拉）
      if (!val || val === label || val.indexOf(label) >= 0) return true;
    }
    return false;
  }

  // 当前页 + 已读取缓存合并后的视图
  function pjView() {
    const live = readPjRows();
    const info = pageInfo();
    const cur = info.current || 1;
    if (live.length && live[0].year && pjState.year && live[0].year !== pjState.year) {
      // 年度切换了，旧缓存作废
      pjState.rows = [];
      pjState.sel.clear();
      pjState.plan.clear();
    }
    if (live.length && live[0].year) pjState.year = live[0].year;
    const map = new Map(pjState.rows.map((r) => [r.key, r]));
    live.forEach((r) => map.set(r.key, Object.assign({}, map.get(r.key), r)));
    return { rows: Array.from(map.values()), live, cur, total: info.total || 0 };
  }

  async function collectPjAll() {
    if (pjState.busy) return;
    if (routeKind() !== 'twosystem' || !findPjTable()) {
      log('请先进入「两制 → 团员教育评议」页面');
      return;
    }
    const info0 = pageInfo();
    if (info0.current > 1) {
      log(`当前在第 ${info0.current} 页，先回到第 1 页再读`);
      await gotoPage(1);
    }
    pjState.busy = true;
    pjState.rows = [];
    pjState._sig = '';
    log(`开始读取评议名单：共 ${info0.total || '?'} 条，约 ${info0.pages} 页`);
    try {
      for (let guard = 0; guard < 40; guard++) {
        const rows = readPjRows();
        const cur = pageInfo().current || 1;
        const map = new Map(pjState.rows.map((r) => [r.key, r]));
        rows.forEach((r) => map.set(r.key, Object.assign({}, map.get(r.key), r, { page: cur })));
        pjState.rows = Array.from(map.values());
        log(`已读取第 ${cur} 页，累计 ${pjState.rows.length} 人`);
        const info = pageInfo();
        if (info.total && pjState.rows.length >= info.total) break;
        const ok = await clickNext();
        if (!ok) break;
        await sleep(250);
      }
      pjState.collectedAt = Date.now();
      savePjCache();
      log(`✅ 读取完成，共 ${pjState.rows.length} 人`);
      const after = pageInfo();
      if (after.total && pjState.rows.length < after.total) {
        log(`⚠️ 只读到 ${pjState.rows.length}/${after.total} 人，可手动翻页后点「追加本页」补齐`);
      }
      if (after.current > 1) log(`已读到第 ${after.current} 页（最后一页）。批量设置时插件会自动翻回前面的页。`);
    } catch (e) {
      log(`读取出错：${e.message}`);
    } finally {
      pjState.busy = false;
      renderPj();
    }
  }

  function appendPjPage() {
    const live = readPjRows();
    if (!live.length) {
      log('当前页没有读到评议数据');
      return;
    }
    const map = new Map(pjState.rows.map((r) => [r.key, r]));
    live.forEach((r) => map.set(r.key, r));
    pjState.rows = Array.from(map.values());
    pjState.collectedAt = Date.now();
    savePjCache();
    pjState._sig = '';
    log(`已追加本页 ${live.length} 行，累计 ${pjState.rows.length} 人`);
    renderPj();
  }

  // 应用清单：面板里先选好，复查之后再动页面
  function planList() {
    const rows = pjView().rows;
    const order = new Map(rows.map((r, i) => [r.key, i]));
    return Array.from(pjState.plan.entries())
      .filter(([k]) => order.has(k))
      .sort((a, b) => order.get(a[0]) - order.get(b[0]))
      .map(([key, level]) => {
        const r = rows.find((x) => x.key === key) || {};
        return { key, level, name: r.name || key, page: r.page || 1, result: r.result || '' };
      });
  }

  // 把“选中的人 + 当前等次”写进清单（不碰页面）
  function assignPlan() {
    const level = pjState.level;
    const sel = pjView().rows.filter((r) => pjState.sel.has(r.key));
    if (!sel.length) {
      log('先点名字勾选团员，再点「写入选中」');
      return;
    }
    let n = 0;
    let skipped = 0;
    sel.forEach((r) => {
      if (r.result && r.result !== '请选择') {
        skipped++;
        return;
      }
      pjState.plan.set(r.key, level);
      n++;
    });
    pjState.sel.clear();
    pjState._sig = '';
    savePjCache();
    renderPj();
    log(`已写入清单：${n} 人 → ${level}${skipped ? `；${skipped} 人页面上已评，跳过` : ''}`);
  }

  function clearPlan() {
    pjState.plan.clear();
    pjState._sig = '';
    savePjCache();
    renderPj();
    log('已清空应用清单');
  }

  function onPjRowClick(e) {
    const un = e.target.closest && e.target.closest('[data-unplan]');
    if (un) {
      pjState.plan.delete(un.dataset.unplan);
      pjState._sig = '';
      savePjCache();
      renderPj();
      return;
    }
    if (pjState.mode === 'review') return;
    const it = e.target.closest && e.target.closest('.item');
    if (!it || !it.dataset.key) return;
    const k = it.dataset.key;
    if (pjState.sel.has(k)) pjState.sel.delete(k);
    else pjState.sel.add(k);
    paintPjSelection();
    savePjCache();
  }

  // 真正去页面上点下拉：从第 1 页开始，一人一人来，失败立刻停
  async function applyPlan() {
    if (pjState.busy) return;
    const items = planList();
    if (!items.length) {
      log('应用清单是空的');
      return;
    }
    const view = pjView();
    const total = view.total || view.rows.length || 1;
    const max = Math.floor(total * 0.3);
    const youPlan = items.filter((x) => x.level === '优秀').length;
    const youNow = view.rows.filter((r) => r.result === '优秀' && !pjState.plan.has(r.key)).length;
    if (youNow + youPlan > max) {
      if (!confirm(`优秀：页面已有 ${youNow} 人，这次再设 ${youPlan} 人，上限 ${max} 人（${total}×30%）。\n超限可能被上级退回。仍要继续？`)) return;
    }
    if (
      !confirm(
        `即将在网站上为 ${items.length} 人选择等次。\n\n` +
          `⚠️ 页面上的下拉会被逐个点掉；若系统选中即保存，就无法改回。\n\n` +
          `点击「确定」后，插件会逐人操作并触发保存（等同提交）。请确认清单无误。`
      )
    )
      return;

    pjState.busy = true;
    pjState.mode = 'list';
    pjState._sig = '';
    renderPj();
    log(`开始应用：${items.length} 人，先回到第 1 页`);
    let okN = 0;
    let skipN = 0;
    let stopped = false;
    try {
      const back = await gotoPage(1);
      if (!back) log('⚠️ 没能回到第 1 页，从当前页往后应用');
      for (let gp = 0; gp < 40 && !stopped; gp++) {
        for (let gr = 0; gr < 40; gr++) {
          const rows = readPjRows();
          const next = rows.find((r) => pjState.plan.has(r.key));
          if (!next) break;
          const level = pjState.plan.get(next.key);
          if (next.result && next.result !== '请选择') {
            log(`⚠️ ${next.name} 页面上已是「${next.result}」，跳过（改不了）`);
            pjState.plan.delete(next.key);
            skipN++;
            continue;
          }
          const ok = await setSelectOption(next.selEl, level);
          if (!ok) {
            log(`❌ ${next.name} 没设成功，已停止。成功 ${okN} 人，清单里还剩 ${pjState.plan.size} 人，请手动核对。`);
            stopped = true;
            break;
          }
          okN++;
          pjState.plan.delete(next.key);
          setPjResult(next.key, level);
          savePjCache();
          log(`✅ ${next.name} → ${level}（系统已自动提交）`);
          await sleep(state.settings.delay);
        }
        if (stopped) break;
        const info = pageInfo();
        if (info.current >= (info.pages || 1)) break;
        const moved = await clickNext();
        if (!moved) break;
        await sleep(250);
      }
      if (!stopped) log(`应用完成：成功 ${okN} 人${skipN ? `，跳过 ${skipN} 人` : ''}。请在页面上复核。`);
    } finally {
      pjState.busy = false;
      pjState._sig = '';
      savePjCache();
      renderPj();
    }
  }

  function paintPjSelection() {
    const pane = shadow && shadow.querySelector('[data-pane="pj"]');
    if (!pane) return;
    pane.querySelectorAll('.item').forEach((it) => {
      const on = pjState.sel.has(it.dataset.key);
      it.classList.toggle('on', on);
      const cb = it.querySelector('.cb');
      if (cb) cb.textContent = on ? '✓' : '';
    });
    const a = pane.querySelector('[data-act="assign"]');
    if (a) a.textContent = `写入选中(${pjState.sel.size})`;
  }

  // 复查页：只读清单，确认后才允许应用
  function renderPjReview(pane, view) {
    const items = planList();
    const counts = {};
    items.forEach((x) => {
      counts[x.level] = (counts[x.level] || 0) + 1;
    });
    const total = view.total || view.rows.length || 1;
    const max = Math.floor(total * 0.3);
    const youNow = view.rows.filter((r) => r.result === '优秀' && !pjState.plan.has(r.key)).length;
    const list = items
      .map(
        (x) => `<div class="rv"><span class="rn">${esc(x.name)}</span>
          <span class="rl">${esc(x.level)}</span><span class="rp">P${x.page}</span></div>`
      )
      .join('');
    pane.innerHTML = `
      <div class="warn">⚠️ 应用会直接改页面上的下拉：若系统是“选中即保存”，改了就回不去；即使还要点「提交」，也请先逐条核对清单。</div>
      <div class="stat"><span>待应用 <i>${items.length}</i> 人</span>
        ${PJ_LEVELS.map((l) => (counts[l] ? `<span>${l} <i>${counts[l]}</i></span>` : '')).join('')}
        <span>优秀 <i class="${youNow + (counts['优秀'] || 0) > max ? 'bad' : ''}">${youNow + (counts['优秀'] || 0)}/${max}</i></span></div>
      <div class="list" style="max-height:300px">${list || '<div class="empty">清单是空的</div>'}</div>
      <div class="row" style="margin-top:8px">
        <button class="b" data-act="back">返回修改</button>
        <button class="b p" data-act="apply" ${items.length ? '' : 'disabled'}>确认应用(${items.length})</button>
      </div>
      <div class="tiny" style="margin-top:8px">应用时从第 1 页开始逐人选择；每人点完立即提交，中途失败会马上停下并告诉你卡在谁身上。</div>
    `;
    pane.querySelector('[data-act="back"]').addEventListener('click', () => {
      pjState.mode = 'list';
      pjState._sig = '';
      renderPj();
    });
    pane.querySelector('[data-act="apply"]').addEventListener('click', applyPlan);
  }

  function renderPj() {
    const pane = shadow && shadow.querySelector('[data-pane="pj"]');
    if (!pane) return;
    if (routeKind() !== 'twosystem') {
      pane.innerHTML = `<div class="empty">请先进入「两制 → 团员教育评议」页面</div>`;
      return;
    }
    const view = pjView();
    const rows = view.rows;
    if (!rows.length) {
      pane.innerHTML = `<div class="empty">还没读到评议表格。页面加载完后再点「读取全部」。</div>`;
      return;
    }
    if (pjState.mode === 'review') {
      pjState._sig = '';
      renderPjReview(pane, view);
      return;
    }
    const total = view.total || rows.length;
    const max = Math.floor(total * 0.3);
    const done = rows.filter((r) => r.result && r.result !== '请选择').length;
    const you = rows.filter((r) => r.result === '优秀').length;
    const sel = rows.filter((r) => pjState.sel.has(r.key)).length;
    const planN = rows.filter((r) => pjState.plan.has(r.key)).length;
    const sig =
      rows.map((r) => `${r.key}:${r.result}:${r.page}:${pjState.plan.get(r.key) || ''}`).join('|') +
      '#' + view.cur + '#' + rows.length;
    if (sig === pjState._sig && pane.querySelector('.list')) {
      paintPjSelection();
      return;
    }
    pjState._sig = sig;
    const list = rows
      .map((r) => {
        const plan = pjState.plan.get(r.key) || '';
        return `<div class="item ${pjState.sel.has(r.key) ? 'on' : ''}" data-key="${esc(r.key)}">
          <span class="cb">${pjState.sel.has(r.key) ? '✓' : ''}</span>
          <span class="nm">${esc(r.name || '(空)')}</span>
          ${plan ? `<span class="plan">${esc(plan)}</span>` : ''}
          ${r.page && r.page !== view.cur ? `<span class="pg">P${r.page}</span>` : ''}
          <span class="ph">${esc(r.result)}</span>
          ${plan ? `<span class="x" data-unplan="${esc(r.key)}" title="从清单移除">✕</span>` : ''}
        </div>`;
      })
      .join('');
    const when = pjState.collectedAt
      ? `读取于 ${new Date(pjState.collectedAt).toTimeString().slice(0, 5)}（${rows.length} 人）`
      : '仅当前页';
    keepPanelScroll(pane, () => {
      pane.innerHTML = `
      <div class="stat"><span>共 <i>${total}</i> 人</span><span>已读 <i>${rows.length}</i></span><span>已评 <i>${done}</i></span><span>优秀 <i class="${you > max ? 'bad' : ''}">${you}/${max}</i></span></div>
      <div class="row">
        <button class="b p" data-act="collect">读取全部</button>
        <button class="b" data-act="append">追加本页</button>
        <button class="b" data-act="reset">清空数据</button>
      </div>
      <div class="row">
        <select class="b" data-act="level" style="padding:5px 6px">
          ${PJ_LEVELS.map((l) => `<option ${l === pjState.level ? 'selected' : ''}>${l}</option>`).join('')}
        </select>
        <button class="b p" data-act="assign">写入选中(${sel})</button>
        <button class="b" data-act="clearplan">清空清单</button>
      </div>
      <div class="row">
        <button class="b" data-act="all">全选未评</button>
        <button class="b" data-act="none">清空选择</button>
      </div>
      <div class="list" style="max-height:300px">${list}</div>
      <button class="b p" data-act="review" style="width:100%;margin-top:8px" ${planN ? '' : 'disabled'}>复查并应用(${planN})</button>
      <div class="tiny" style="margin-top:8px">
        第 ${view.cur}/${pageInfo().pages} 页 · ${when}<br>
        流程：勾人 → 选等次 → <b>写入选中</b>（只进清单，不碰页面）→ <b>复查并应用</b> → 确认。<br>
        应用前不会对网站做任何改动；点「确认应用」后，插件会逐人选择等次（选中即保存，等同提交），请先核对清单。优秀上限 ${max} 人。
      </div>
    `;
    });
    pane.querySelector('[data-act="level"]').addEventListener('change', (e) => {
      pjState.level = e.target.value;
      savePjCache();
    });
    pane.querySelector('[data-act="assign"]').addEventListener('click', assignPlan);
    pane.querySelector('[data-act="clearplan"]').addEventListener('click', clearPlan);
    pane.querySelector('[data-act="review"]').addEventListener('click', () => {
      if (!pjState.plan.size) return;
      pjState.mode = 'review';
      pjState._sig = '';
      renderPj();
    });
    pane.querySelector('[data-act="collect"]').addEventListener('click', collectPjAll);
    pane.querySelector('[data-act="append"]').addEventListener('click', appendPjPage);
    pane.querySelector('[data-act="reset"]').addEventListener('click', () => {
      clearPjCache();
      log('已清空评议数据');
      renderPj();
    });
    pane.querySelector('[data-act="all"]').addEventListener('click', () => {
      pjView().rows.forEach((r) => {
        if (!r.result || r.result === '请选择') pjState.sel.add(r.key);
      });
      paintPjSelection();
      savePjCache();
    });
    pane.querySelector('[data-act="none"]').addEventListener('click', () => {
      pjState.sel.clear();
      paintPjSelection();
      savePjCache();
    });
  }

  /* ---------------- 团员信息（当前页表单 / 多人批量） ---------------- */
  const infoState = { fields: [], inputs: new Map(), mode: 'list', plan: new Map(), options: new Map() };
  const INFO_TPL_KEY = 'zhtjInfoTpl';

  // 内置选项模板：页面上读不到选项时用这些（值是系统里常见写法，应用时按页面真实选项再匹配一次）
  const INFO_DEFAULT_OPTIONS = {
    性别: ['男', '女'],
    民族: [
      '汉族', '蒙古族', '回族', '藏族', '维吾尔族', '苗族', '彝族', '壮族', '布依族', '朝鲜族',
      '满族', '侗族', '瑶族', '白族', '土家族', '哈尼族', '哈萨克族', '傣族', '黎族', '傈僳族',
      '佤族', '畲族', '高山族', '拉祜族', '水族', '东乡族', '纳西族', '景颇族', '柯尔克孜族', '土族',
      '达斡尔族', '仡佬族', '羌族', '布朗族', '撒拉族', '毛南族', '仫佬族', '锡伯族', '阿昌族', '普米族',
      '塔吉克族', '怒族', '乌孜别克族', '俄罗斯族', '鄂温克族', '德昂族', '保安族', '裕固族', '京族',
      '塔塔尔族', '独龙族', '鄂伦春族', '赫哲族', '门巴族', '珞巴族', '基诺族', '其他',
    ],
    职业: ['青年学生', '职业青年'],
    在读状况: ['普通高中在读', '中等职业高中在读', '初中在读', '普通高校在读', '高等职业院校在读', '已毕业'],
    学历: ['小学', '初中', '高中', '中专', '大专', '本科', '硕士研究生', '博士研究生'],
    政治面貌: [
      '中共党员', '中共预备党员', '共青团员', '中国国民党革命委员会会员', '中国民主同盟盟员',
      '中国民主建国会会员', '中国民主促进会会员', '中国农工民主党党员', '中国致公党党员',
      '九三学社社员', '台湾民主自治同盟盟员', '无党派人士', '群众',
    ],
    是否递交入党申请书: ['是', '否'],
  };

  // 字段模板存档：刷新/换页后还能在名单页直接配批量
  function saveInfoTemplate() {
    try {
      sessionStorage.setItem(
        INFO_TPL_KEY,
        JSON.stringify({
          fields: infoState.fields.map((f) => ({ key: f.key, label: f.label, kind: f.kind, readonly: f.readonly })),
          options: Array.from(infoState.options.entries()),
        })
      );
    } catch (e) {}
  }
  function loadInfoTemplate() {
    try {
      const raw = sessionStorage.getItem(INFO_TPL_KEY);
      if (!raw) return 0;
      const o = JSON.parse(raw);
      if (!o || !Array.isArray(o.fields) || !o.fields.length) return 0;
      infoState.fields = o.fields.map((f) => Object.assign({ el: null, selectEl: null, item: null, value: '' }, f));
      if (Array.isArray(o.options)) infoState.options = new Map(o.options);
      return o.fields.length;
    } catch (e) {
      return 0;
    }
  }
  const INFO_JOB_KEY = 'zhtjInfoJob';
  let infoJobRunning = false;

  // 字段名：先找 form-item 里的 label，找不到就看左边那个单元格（本页是表格布局）
  function fieldLabel(item, idx) {
    const clean = (s) =>
      String(s || '')
        .replace(/^[\s*＊·•]+/, '')
        .replace(/[\s*＊·•]+$/, '')
        .replace(/[:：]\s*$/, '')
        .trim();
    const labEl = item.querySelector('.el-form-item__label') || item.querySelector('label');
    const name = clean(text(labEl));
    if (name) return name;
    const cell = item.closest('td, th');
    if (cell) {
      let prev = cell.previousElementSibling;
      while (prev && !text(prev)) prev = prev.previousElementSibling;
      const t = prev ? clean(text(prev)) : '';
      if (t && t.length <= 16) return t;
    }
    const inp = item.querySelector('input, textarea');
    const ph = inp ? String(inp.placeholder || '').trim() : '';
    if (ph) {
      const t = clean(ph.replace(/^请选择/, ''));
      if (t) return t;
    }
    return `字段${idx}`;
  }

  // 扫描当前页的表单字段：按「标签 + 控件」配对，不写死任何字段名
  function scanFormFields() {
    const out = [];
    const seen = new Set();
    $$('.el-form-item')
      .filter(visible)
      .forEach((item, i) => {
        const selEl = item.querySelector('.el-select');
        const ta = item.querySelector('textarea');
        const inp = item.querySelector('input.el-input__inner, input');
        const isDate = !!item.querySelector('.el-date-editor');
        const isRadio = !!item.querySelector('.el-radio-group, .el-checkbox-group');
        let kind = '';
        if (selEl) kind = 'select';
        else if (isRadio) kind = 'radio';
        else if (ta) kind = 'textarea';
        else if (inp) kind = isDate ? 'date' : 'text';
        if (!kind && !isRadio) return;
        const label = fieldLabel(item, i + 1);
        let key = label;
        let n = 1;
        while (seen.has(key)) key = `${label}#${++n}`;
        seen.add(key);
        const textLike = kind === 'text' || kind === 'textarea' || kind === 'date';
        const locked = !(INFO_EDITABLE.includes(label) || INFO_EDITABLE_ALIAS.includes(label));
        out.push({
          key,
          label,
          kind,
          el: inp || null,
          selectEl: selEl || null,
          item,
          value: inp ? String(inp.value || '') : '',
          readonly: textLike ? !!(inp && (inp.readOnly || inp.disabled)) : false,
          locked,
        });
      });
    return out;
  }

  function setTextValue(input, v) {
    if (!input) return false;
    input.focus();
    const proto = input.tagName === 'TEXTAREA' ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, 'value');
    if (desc && desc.set) desc.set.call(input, v);
    else input.value = v;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new Event('blur', { bubbles: true }));
    return String(input.value) === String(v);
  }

  // 下拉选项：只从 Vue 组件里静默读，不点开页面上的下拉（避免串字段、页面闪）
  function selectOptionsOf(selEl) {
    try {
      const vm = selEl && selEl.__vue__;
      if (!vm || !Array.isArray(vm.options) || !vm.options.length) return null;
      const labels = vm.options
        .map((o) => String(o.label != null ? o.label : o.value == null ? '' : o.value))
        .filter(Boolean);
      if (!labels.length) return null;
      // 校验：当前值必须能在这组选项里找到，否则多半是读错了组件（会串到别的字段）
      const inp = selEl.querySelector('input');
      const cur = inp ? String(inp.value || '').trim() : '';
      if (cur && labels.indexOf(cur) < 0) return null;
      return labels;
    } catch (e) {
      return null;
    }
  }

  async function readOptionsForAll() {
    const sel = infoState.fields.filter((f) => f.kind === 'select' || f.kind === 'radio');
    if (!sel.length) return;
    let fromPage = 0;
    let fromDict = 0;
    for (const f of sel) {
      let labels =
        f.kind === 'select' ? selectOptionsOf(f.selectEl) || [] : $$('.el-radio', f.item).map((r) => text(r)).filter(Boolean);
      if (labels.length) fromPage++;
      if (!labels.length) {
        labels = dictLabelsFor(f.label);
        if (!labels.length) labels = dictByCurrentValue(f.value);
        if (labels.length) fromDict++;
      }
      if (!labels.length) labels = defaultOptionsFor(f.label); // 最后才用内置兜底
      if (labels.length) infoState.options.set(f.key, labels);
    }
    const withOpts = sel.filter((f) => infoState.options.get(f.key)).length;
    log(`下拉选项：${withOpts}/${sel.length} 可用（系统字典 ${fromDict} 个，页面 ${fromPage} 个，其余用内置）`);
    saveInfoTemplate();
    renderInfo();
  }

  function setRadioValue(item, label) {
    const radios = $$('.el-radio', item);
    const norm = (s) => String(s || '').replace(/\s+/g, '');
    const hit = radios.find((r) => norm(text(r)) === norm(label));
    if (!hit) return false;
    const input = hit.querySelector('input');
    (input || hit).click();
    return true;
  }

  function waitFor(fn, timeout = 10000, step = 200) {    return new Promise((resolve) => {
      const t0 = Date.now();
      const tick = () => {
        let v = false;
        try {
          v = fn();
        } catch (e) {
          v = false;
        }
        if (v) return resolve(v);
        if (Date.now() - t0 > timeout) return resolve(false);
        setTimeout(tick, step);
      };
      tick();
    });
  }

  const findButton = (re) => $$('button, .el-button').filter(visible).find((b) => re.test(text(b))) || null;

  // 现扫现找：表单是异步重绘的，扫太早会“找不到”本来存在的字段
  async function findFieldNow(label, tries = 4) {
    for (let i = 0; i < tries; i++) {
      const f = findFieldByLabel(scanFormFields(), label);
      if (f) return f;
      if (i < tries - 1) await sleep(400);
    }
    return null;
  }

  // 按字段名找人：先精确，再容忍「入团时间 / 入团年月」这类写法差异
  function findFieldByLabel(fields, label) {
    const norm = (s) => String(s || '').replace(/[\s:：]/g, '');
    const want = norm(label);
    let f = fields.find((x) => norm(x.label) === want);
    if (f) return f;
    return (
      fields.find((x) => want.length >= 2 && (norm(x.label).includes(want) || want.includes(norm(x.label)))) || null
    );
  }

  // 真正靠谱的选项来源：录入页用的字典接口 POST /v1/center/importenter
  // 返回 results.nationals / edus / politicals ...，用登录态直接取
  const DICT_KEY = 'zhtjInfoDict';
  let infoDict = null;

  function csrfToken() {
    try {
      const m = document.querySelector('meta[name="csrf-token"], meta[name="CSRF-Token"]');
      if (m && m.content) return m.content;
      const hit = String(document.cookie || '').match(/(?:^|;\s*)(?:csrf|CSRF|XSRF)[^=]*=([^;]+)/);
      if (hit) return decodeURIComponent(hit[1]);
    } catch (e) {}
    return '';
  }

  async function loadDict(force) {
    if (!force) {
      try {
        const raw = sessionStorage.getItem(DICT_KEY);
        if (raw) {
          infoDict = JSON.parse(raw);
          return infoDict;
        }
      } catch (e) {}
    }
    try {
      const headers = { 'Content-Type': 'application/json;charset=UTF-8' };
      const tk = csrfToken();
      if (tk) headers['X-CSRF-Token'] = tk;
      const r = await fetch('/v1/center/importenter', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: '{}',
        signal: AbortSignal.timeout(20000),
      });
      const j = await r.json();
      if (j && j.retCode === 1000 && j.results) {
        infoDict = j.results;
        try {
          sessionStorage.setItem(DICT_KEY, JSON.stringify(infoDict));
        } catch (e) {}
        log(`已取到系统字典：${Object.keys(infoDict).join('、')}`);
        return infoDict;
      }
      log(`字典接口返回 ${j && j.retCode}：${(j && j.retMsg) || ''}`);
    } catch (e) {
      log(`字典接口请求失败：${e.message}`);
    }
    return null;
  }

  // 字段名 → 字典里的键（键名来自录入页源码：nationals/edus/politicals/youngStudents…）
  const DICT_ALIAS = {
    民族: ['nationals', 'nations'],
    学历: ['edus', 'edu', 'educations'],
    政治面貌: ['politicals', 'politics'],
    在读状况: ['youngStudents', 'qnxs'],
    团内职务: ['tzbPositions', 'positions'],
    职业: ['jobTypes'],
  };

  function dictLabelsFor(label) {
    if (!infoDict) return [];
    const keys = DICT_ALIAS[label] || [];
    for (const k of keys) {
      const labels = dictValues(infoDict[k]);
      if (labels.length) return labels;
    }
    return [];
  }

  function dictValues(v) {
    if (!v) return [];
    // 57QT 是系统里被隐藏的一项（录入页也把它过滤掉了）
    const arr = Array.isArray(v) ? v : Object.keys(v).filter((k) => k !== '57QT').map((k) => v[k]);
    return arr
      .map((x) => (typeof x === 'string' ? x : x && (x.name || x.label || x.value)))
      .filter((x) => typeof x === 'string' && x.trim());
  }

  // 字典键名对不上时：用这个字段的当前值去猜是哪一本字典（例如当前值「青年学生」→ 找到职业字典）
  // 只允许改这三个字段，其余一律只读（明确禁止写）。只按完整字段名匹配，避免「具体职业」被误当成「职业」
  const INFO_EDITABLE = ['职业', '在读状况', '学历'];
  const INFO_EDITABLE_ALIAS = ['文化程度', '就读状况'];

  // 内置兜底：先精确匹配字段名，再按包含关系找（「* 职业」「职业：」都能命中）
  function defaultOptionsFor(label) {
    const key = String(label || '').trim();
    if (INFO_DEFAULT_OPTIONS[key]) return INFO_DEFAULT_OPTIONS[key];
    const hit = Object.keys(INFO_DEFAULT_OPTIONS).find((k) => key.includes(k) || k.includes(key));
    return hit ? INFO_DEFAULT_OPTIONS[hit] : [];
  }

  function dictByCurrentValue(cur) {
    if (!infoDict || !cur) return [];
    for (const k of Object.keys(infoDict)) {
      const labels = dictValues(infoDict[k]);
      if (labels.length > 1 && labels.indexOf(cur) >= 0) return labels;
    }
    return [];
  }

  // 批量目标 = 「名单」页勾选的人
  function infoPickedList() {
    return state.roster.filter((r) => state.selected.has(r.key));
  }

  function infoPlanList() {
    return Array.from(infoState.plan.entries())
      .map(([key, value]) => {
        const f = infoState.fields.find((x) => x.key === key);
        return { key, value, label: f ? f.label : key, kind: f ? f.kind : '' };
      })
      .filter((x) => x.value !== '');
  }

  async function applyInfo() {
    const items = infoPlanList();
    if (!items.length) {
      log('清单是空的：先在下面填要改的字段');
      return;
    }
    if (
      !confirm(
        `将修改 ${items.length} 个字段：\n${items
          .slice(0, 10)
          .map((x) => `${x.label} → ${x.value}`)
          .join('\n')}${items.length > 10 ? '\n…' : ''}\n\n只改你填了的字段，其它保持不动。写入后请核对，再自己点页面上的「提交」保存。\n\n确定写入？`
      )
    )
      return;
    let okN = 0;
    let failN = 0;
    for (const it of items) {
      const f = await findFieldNow(it.label);
      if (!f) {
        failN++;
        log(`⚠️ 没找到「${it.label}」，当前表单字段：${scanFormFields().map((x) => x.label).join('、')}`);
        continue;
      }
      let ok = false;
      if (f.locked) {
        failN++;
        log(`⚠️ ${f.label} 是只读字段（只允许改 职业 / 在读状况 / 学历），已跳过`);
        continue;
      }
      if (f.readonly) {
        failN++;
        log(`⚠️ ${f.label} 是只读，先点「进入修改态」再写入`);
        continue;
      }
      if (f.kind === 'select') ok = await setSelectOption(f.selectEl, it.value);
      else if (f.kind === 'radio') ok = setRadioValue(f.item, it.value);
      else ok = setTextValue(f.el, it.value);
      if (ok) {
        okN++;
        infoState.plan.delete(it.key);
      } else {
        failN++;
        if (f.kind === 'select' || f.kind === 'radio') log(`⚠️ ${f.label} 的下拉里找不到「${it.value}」，请手动选`);
      }
      log(`${ok ? '✅' : '⚠️'} ${f.label} → ${it.value}`);
      await sleep(150);
    }
    infoState.mode = 'list';
    infoState.inputs.clear();
    log(`已写入 ${okN} 个字段，失败 ${failN}。请核对后自己点页面上的「提交」保存（单人写入不提交）。`);
    infoState.fields = scanFormFields();
    renderInfo();
  }

  /* ---------- 多人批量：列表 → 编辑(跳转) → 修改 → 填写 → 提交 → 返回列表 ---------- */
  function saveInfoJob(job) {
    try {
      sessionStorage.setItem(INFO_JOB_KEY, JSON.stringify(job));
    } catch (e) {}
  }
  function loadInfoJob() {
    try {
      const raw = sessionStorage.getItem(INFO_JOB_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (e) {
      return null;
    }
  }
  function clearInfoJob() {
    try {
      sessionStorage.removeItem(INFO_JOB_KEY);
    } catch (e) {}
  }

  function goToListPage() {
    const base = location.pathname.split('/center/')[0] || '';
    location.assign(location.origin + base + '/center/manage/memberlist');
  }

  function findEditAction(tr) {
    const tds = $$('td', tr);
    for (let i = tds.length - 1; i >= 0; i--) {
      const cands = $$('span, a, button, i, em', tds[i]);
      const hit = cands.find((el) => /^编\s*辑$/.test(text(el)) || /编辑/.test(el.getAttribute('title') || ''));
      if (hit) return hit.closest('a, button, span') || hit;
    }
    return null;
  }

  async function findRowByName(name) {
    const hit = () => currentRows().find((r) => r.name === name) || null;
    let row = hit();
    if (row) return row;
    await gotoPage(1);
    for (let p = 0; p < 20; p++) {
      row = hit();
      if (row) return row;
      const info = pageInfo();
      if (info.current >= (info.pages || 1)) break;
      const moved = await clickNext();
      if (!moved) break;
      await sleep(250);
    }
    return null;
  }

  async function startInfoBatch(dryRun) {
    if (infoJobRunning) return;
    const names = infoPickedList().map((r) => r.name);
    const fields = infoPlanList().filter((x) => x.value !== '');
    if (!names.length) {
      log('先在「名单」页勾选要改的人（需要先抓过名单），再回来点批量');
      return;
    }
    if (!fields.length) {
      log('先在字段里填要改成什么');
      return;
    }
    const target = dryRun ? names.slice(0, 1) : names;
    if (
      !confirm(
        `将逐个处理 ${target.length} 人：${target.join('、')}${target.length < names.length ? ' 等' : ''}\n\n` +
          `每人会：列表点「编辑」→ 表单点「修改」→ 填 ${fields.length} 个字段 → 点「提交」→ 点「返回」→ 下一个人。\n` +
          `（团干的编辑页是 cadresinfo，会自动适配）\n` +
          `中途任何一个人失败都会立刻停下。\n\n` +
          `点击「确定」后，插件会按上面的步骤逐人自动提交；请确认你已核对名单与内容。\n\n开始吗？`
      )
    )
      return;
    const job = { names: target, fields: Object.fromEntries(fields.map((x) => [x.label, x.value])), i: 0, done: [], dryRun: !!dryRun };
    saveInfoJob(job);
    log(`批量任务开始：${target.length} 人…`);
    if (routeKind() === 'memberlist') {
      runListStep(job);
      return;
    }
    log('先回到团员列表…');
    goToListPage();
  }

  async function runListStep(job) {
    if (job.i >= job.names.length) return finishInfoJob(job);
    const name = job.names[job.i];
    log(`第 ${job.i + 1}/${job.names.length} 人：${name}，在列表里找…`);
    const ready = await waitFor(() => !!findMemberTable() && $$('.el-table__body tbody tr', findMemberTable()).length > 0, 15000);
    if (!ready) return failInfoJob(job, `列表没加载出来，停在「${name}」`);
    const row = await findRowByName(name);
    if (!row) return failInfoJob(job, `列表里找不到「${name}」，已停止`);
    const btn = findEditAction(row.el);
    if (!btn) return failInfoJob(job, `「${name}」这一行没找到「编辑」，已停止`);
    btn.click();
    let arrived = await waitFor(
      () => routeKind() === 'memberinfo' || $$('.el-form-item').filter(visible).length >= 3,
      12000
    );
    if (!arrived) {
      // 再点一次（有时第一次点被列表重绘吃掉）
      const again = findEditAction(row.el);
      if (again) again.click();
      arrived = await waitFor(() => routeKind() === 'memberinfo' || $$('.el-form-item').filter(visible).length >= 3, 10000);
    }
    if (!arrived) return failInfoJob(job, `点「编辑」后没进到团员信息页（当前 ${location.pathname}），停在「${name}」`);
    const isCadre = /cadresinfo/i.test(location.pathname);
    log(`已打开「${name}」的表单${isCadre ? '（团干页 cadresinfo）' : ''}，准备修改…`);
  }

  async function runFormStep(job) {
    const name = job.names[job.i] || '';
    const ready = await waitFor(() => $$('.el-form-item').filter(visible).length > 0, 15000);
    if (!ready) return failInfoJob(job, `「${name}」的表单没加载出来`);
    await sleep(400);
    // 核对是不是这个人（姓名有值才核对）
    const probe = scanFormFields().find((f) => f.label === '姓名');
    if (probe && probe.value && name && probe.value !== name) {
      return failInfoJob(job, `打开的不是「${name}」（页面显示「${probe.value}」），已停止`);
    }
    const editBtn = findButton(/^修\s*改$|^编\s*辑$/);
    if (editBtn) {
      editBtn.click();
      await sleep(700);
    }
    const fails = [];
    let filled = 0;
    for (const [label, value] of Object.entries(job.fields || {})) {
      // 每个字段都现扫现找：点「修改」后表单会重绘，改一个下拉还可能牵动别的行
      const f = await findFieldNow(label);
      if (!f) {
        const have = scanFormFields().map((x) => x.label).join('、');
        fails.push(`${label}(没找到)`);
        log(`  ⚠️ 没找到「${label}」，当前表单字段：${have}`);
        continue;
      }
      if (f.locked) {
        fails.push(`${label}(只读)`);
        log(`  ⚠️ 「${label}」只读，已跳过`);
        continue;
      }
      const ok =
        f.kind === 'select'
          ? await setSelectOption(f.selectEl, value)
          : f.kind === 'radio'
          ? setRadioValue(f.item, value)
          : setTextValue(f.el, value);
      if (ok) filled++;
      else fails.push(label);
      await sleep(200);
    }
    if (!filled) return failInfoJob(job, `「${name}」一个字段都没写进去（可能没进入修改态）`);
    const submit = findButton(/^提\s*交$/);
    if (!submit) return failInfoJob(job, `「${name}」没找到「提交」按钮`);
    submit.click();
    await sleep(700);

    // 提交后：可能先弹确认框；再等“成功”信号（提示条 或 表单变回只读）
    const confirmBtn = await waitFor(() => {
      const box = $$('.el-message-box').filter(visible)[0];
      if (!box) return null;
      return $$('button', box).find((b) => /确\s*定/.test(text(b))) || null;
    }, 2500);
    if (confirmBtn) {
      confirmBtn.click();
      await sleep(600);
    }
    const signal = await waitFor(() => {
      const toast = $$('.el-message, .el-message-box').filter(visible).find((m) => /成功|保存/.test(text(m)));
      if (toast) return 'toast';
      const f = scanFormFields().find((x) => job.fields && job.fields[x.label] != null);
      if (f && f.readonly) return 'readonly';
      return false;
    }, 8000);
    if (!signal) return failInfoJob(job, `「${name}」点提交后没看到成功提示，状态不明，已停下（请手动检查这个人）`);

    // 先记账，再点「返回」：返回可能是整页刷新，后面的代码不保证会执行到
    job.i += 1;
    job.done.push(name);
    saveInfoJob(job);
    log(`✅ ${name} 已保存（${job.i}/${job.names.length}）${fails.length ? '；未写入：' + fails.join('、') : ''}`);
    const isLast = job.i >= job.names.length;
    const backBtn = findButton(/^返\s*回$/);
    if (backBtn) backBtn.click();
    if (isLast) {
      if (backBtn) await waitFor(() => routeKind() === 'memberlist', 8000);
      return finishInfoJob(job);
    }
    if (!backBtn) {
      clearInfoJob();
      log(`⚠️ 「${name}」已保存，但没找到「返回」，任务已停（共完成 ${job.done.length} 人）`);
      return;
    }
    const back = await waitFor(() => routeKind() === 'memberlist', 12000);
    if (!back) {
      // 没回去就停，避免在旧表单上处理下一个人
      clearInfoJob();
      log(`⚠️ 「${name}」已保存，但点「返回」后没回到列表，任务已停（共完成 ${job.done.length} 人）`);
    }
  }

  function finishInfoJob(job) {
    log(`批量任务完成：${job.done.length} 人（${job.done.join('、')}）。请抽查几条。`);
    clearInfoJob();
    renderInfo();
  }

  function failInfoJob(job, msg) {
    log(`❌ ${msg}。已完成 ${job.done.length} 人${job.done.length ? '：' + job.done.join('、') : ''}`);
    clearInfoJob();
    renderInfo();
  }

  async function maybeResumeInfoJob() {
    if (infoJobRunning) return;
    const job = loadInfoJob();
    if (!job) return;
    const kind = routeKind();
    if (kind !== 'memberlist' && kind !== 'memberinfo') return;
    infoJobRunning = true;
    try {
      if (kind === 'memberlist') await runListStep(job);
      else await runFormStep(job);
    } catch (e) {
      log(`批量任务出错：${e.message}`);
      clearInfoJob();
    } finally {
      infoJobRunning = false;
    }
  }

  /* ---------- 界面 ---------- */
  function renderInfoBatchReview(pane) {
    const pickedRows = infoPickedList();
    const picked = pickedRows.map((r) => r.name);
    const cadres = pickedRows.filter((r) => String(r.duty || '').trim());
    const fields = infoPlanList();
    pane.innerHTML = `
      <div class="warn">逐个打开这些人的表单：点「修改」→ 填写 → 点「提交」→（不会自动返回）点「返回」→ 下一个人。<br>任何一个人失败就停下，并把卡在谁身上写进日志。</div>
      <div class="stat"><span>人员 <i>${picked.length}</i> 人</span><span>字段 <i>${fields.length}</i> 个</span></div>
      <div class="rv"><span class="rn">${esc(picked.join('、') || '（没选人）')}</span></div>
      ${cadres.length ? `<div class="tiny">其中团干 ${cadres.length} 人（${esc(cadres.map((r) => r.name).join('、'))}），会走 cadresinfo 页，表单结构不同也会自动适配。</div>` : ''}
      <div class="list" style="max-height:150px">${fields
        .map((x) => `<div class="rv"><span class="rn">${esc(x.label)}</span><span class="rl">${esc(x.value)}</span></div>`)
        .join('')}</div>
      <div class="row" style="margin-top:8px">
        <button class="b" data-act="bback">返回修改</button>
        <button class="b" data-act="btry" ${picked.length && fields.length ? '' : 'disabled'}>试跑第 1 人</button>
        <button class="b p" data-act="bgo" ${picked.length && fields.length ? '' : 'disabled'}>开始批量(${picked.length})</button>
      </div>
      <div class="tiny" style="margin-top:8px">建议先「试跑第 1 人」，确认整条链路都对，再放开批量。</div>
    `;
    pane.querySelector('[data-act="bback"]').addEventListener('click', () => {
      infoState.mode = 'list';
      renderInfo();
    });
    pane.querySelector('[data-act="btry"]').addEventListener('click', () => startInfoBatch(true));
    pane.querySelector('[data-act="bgo"]').addEventListener('click', () => startInfoBatch(false));
  }

  function renderInfoReview(pane) {
    const items = infoPlanList();
    const list = items
      .map((x) => `<div class="rv"><span class="rn">${esc(x.label)}</span><span class="rl">${esc(x.value)}</span></div>`)
      .join('');
    pane.innerHTML = `
      <div class="warn">只写你填了的这几项，其余字段不会动。写入前会弹窗让你确认；写入后请核对，再点页面上的「提交」保存（单人写入不提交）。</div>
      <div class="stat"><span>待改 <i>${items.length}</i> 个字段</span></div>
      <div class="list" style="max-height:320px">${list || '<div class="empty">没有要改的字段</div>'}</div>
      <div class="row" style="margin-top:8px">
        <button class="b" data-act="iback">返回修改</button>
        <button class="b p" data-act="iapply" ${items.length ? '' : 'disabled'}>确认写入(${items.length})</button>
      </div>
      <div class="tiny" style="margin-top:8px">日期类字段写入后，请到页面上看一眼是否被系统接受（日期控件比较挑剔）。</div>
    `;
    pane.querySelector('[data-act="iback"]').addEventListener('click', () => {
      infoState.mode = 'list';
      renderInfo();
    });
    pane.querySelector('[data-act="iapply"]').addEventListener('click', applyInfo);
  }

  function renderInfo() {
    const pane = shadow && shadow.querySelector('[data-pane="info"]');
    if (!pane) return;
    const onPage = routeKind() === 'memberinfo';
    if (onPage && !infoState.fields.length) {
      // 打开修改页就自动读一次模板，不用先点按钮
      infoState.fields = scanFormFields();
      if (infoState.fields.length) {
        saveInfoTemplate();
        loadDict().then(() => readOptionsForAll());
      }
    }
    if (!onPage && !infoState.fields.length) {
      pane.innerHTML = `<div class="empty">先在任意团员信息页点一次「读取本页表单」当模板；之后在「名单」页勾好人，也能回这里点「批量应用」</div>`;
      return;
    }
    if (infoState.mode === 'review') return renderInfoReview(pane);
    if (infoState.mode === 'batchreview') return renderInfoBatchReview(pane);
    const fields = infoState.fields;
    const planned = infoPlanList().length;
    const picked = infoPickedList().length;
    const rows = fields
      .map((f) => {
        const input = infoState.inputs.get(f.key) || '';
        const opts = infoState.options.get(f.key) || [];
        const kindTag = f.kind === 'select' ? '下拉' : f.kind === 'date' ? '日期' : f.kind === 'radio' ? '单选' : f.kind === 'textarea' ? '多行' : '文本';
        const control = f.locked
          ? '<div class="fi dim">只读字段，不参与修改</div>'
          : opts.length
          ? `<select class="fi" data-k="${esc(f.key)}">
              <option value="">（不改）</option>
              ${opts.map((o) => `<option value="${esc(o)}" ${input === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}
            </select>`
          : `<input class="fi" data-k="${esc(f.key)}" value="${esc(input)}" placeholder="${f.kind === 'select' || f.kind === 'radio' ? '填选项文字' : '不改就留空'}">`;
        return `<div class="fld ${f.locked ? 'locked' : ''}">
          <div class="fh"><span class="fl">${esc(f.label)}</span><span class="fk">${kindTag}</span>
            ${f.locked || f.readonly ? '<span class="fk ro">只读</span>' : ''}
            <span class="fv" title="${esc(f.value)}">${esc(f.value || '（空）')}</span></div>
          ${control}
        </div>`;
      })
      .join('');
    keepPanelScroll(pane, () => {
      pane.innerHTML = `
      <div class="row">
        ${onPage ? '<button class="b p" data-act="iscan">读取本页表单</button>' : ''}
        ${onPage ? '<button class="b" data-act="iedit">进入修改态</button>' : ''}
        <button class="b" data-act="iclear">清空填写</button>
      </div>
      <div class="stat"><span>字段 <i>${fields.length}</i> 个</span><span>待改 <i>${planned}</i> 个</span>${/cadresinfo/i.test(location.pathname) ? '<span>团干页</span>' : ''}</div>
      <div class="list" style="max-height:280px">${rows || '<div class="empty">先到一个团员信息页点「读取本页表单」</div>'}</div>
      ${onPage ? `<button class="b p" data-act="ireview" style="width:100%;margin-top:8px" ${planned ? '' : 'disabled'}>复核并写入(${planned})</button>` : ''}
      <div class="row" style="margin-top:8px;border-top:1px dashed #eee;padding-top:8px">
        <button class="b p" data-act="ibatch" ${planned && picked ? '' : 'disabled'}>批量应用(${picked}人)</button>
      </div>
      <div class="tiny" style="margin-top:8px">
        只填你要改的项，留空的保持原样；单人的写入只改表单值，<b>不点提交</b>。<br>
        <b>只有 职业 / 在读状况 / 学历 可改</b>，其余字段一律只读，插件不会写。<br>
        ${onPage && fields.some((f) => f.readonly && !f.locked) ? '有<b>只读</b>字段：先点「进入修改态」（等于页面上的「修改」），再填。<br>' : ''}
        <b>批量</b>目标 = 「名单」页勾选的人（现在 ${picked} 人${picked ? '' : '，先去名单页勾选'}）：填好字段值 → 批量应用，插件逐人打开、修改、填写、提交、返回。
      </div>
    `;
    });
    pane.querySelector('[data-act="iscan"]')?.addEventListener('click', () => {
      infoState.fields = scanFormFields();
      infoState.inputs.clear();
      infoState.plan.clear();
      infoState.options.clear();
      infoState.mode = 'list';
      log(`已扫描到 ${infoState.fields.length} 个字段${infoState.fields.length ? '' : '（页面结构可能不是 el-form-item，可把这条日志截图反馈给作者）'}`);
      saveInfoTemplate();
      renderInfo();
      loadDict().then(() => readOptionsForAll());
    });
    pane.querySelector('[data-act="iedit"]')?.addEventListener('click', () => {
      const btn = $$('button, .el-button').filter(visible).find((x) => /^修\s*改$|^编\s*辑$/.test(text(x)));
      if (!btn) {
        log('页面上没找到「修改」按钮，请手动点一下再点「读取本页表单」');
        return;
      }
      btn.click();
      log('已点「修改」，等页面进入编辑态后重新扫描…');
      setTimeout(() => {
        infoState.fields = scanFormFields();
        renderInfo();
      }, 900);
    });
    pane.querySelector('[data-act="iclear"]').addEventListener('click', () => {
      infoState.inputs.clear();
      infoState.plan.clear();
      renderInfo();
    });
    pane.querySelectorAll('.fi').forEach((inp) => {
      const onEdit = () => {
        const k = inp.dataset.k;
        const v = inp.value;
        if (v === '') infoState.inputs.delete(k);
        else infoState.inputs.set(k, v);
        infoState.plan = new Map(infoState.inputs);
        const btn = pane.querySelector('[data-act="ireview"]');
        if (btn) {
          const n = infoPlanList().length;
          btn.textContent = `复核并写入(${n})`;
          btn.disabled = n === 0;
        }
        const st = pane.querySelector('.stat');
        if (st) st.lastElementChild.innerHTML = `待改 <i>${infoPlanList().length}</i> 个`;
      };
      inp.addEventListener('input', onEdit);
      inp.addEventListener('change', onEdit);
    });
    pane.querySelector('[data-act="ireview"]')?.addEventListener('click', () => {
      if (!infoPlanList().length) return;
      infoState.mode = 'review';
      renderInfo();
    });
    pane.querySelector('[data-act="ibatch"]').addEventListener('click', () => {
      if (!infoPlanList().length || !infoPickedList().length) return;
      infoState.mode = 'batchreview';
      renderInfo();
    });
  }

  /* ---------------- 团员录入预检 ---------------- */
  const impState = { text: '', result: null, source: '' };

  function idError(id) {
    const s = String(id || '').trim().toUpperCase();
    if (!/^\d{17}[\dX]$/.test(s)) return '应为18位（末位可为X）';
    const w = [7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2];
    const c = '10X98765432';
    let sum = 0;
    for (let i = 0; i < 17; i++) sum += Number(s[i]) * w[i];
    return c[sum % 11] === s[17] ? '' : '校验位不正确';
  }

  function parseYm(s) {
    const m = String(s || '').match(/(\d{4})\D+(\d{1,2})/);
    if (!m) return null;
    return { y: Number(m[1]), m: Number(m[2]) };
  }

  /* ---------- 读 .xlsx / .csv（不依赖第三方库） ---------- */
  function colIndexFromRef(ref) {
    let n = 0;
    for (let i = 0; i < ref.length; i++) {
      const ch = ref[i];
      if (ch >= 'A' && ch <= 'Z') n = n * 26 + (ch.charCodeAt(0) - 64);
      else if (ch >= 'a' && ch <= 'z') n = n * 26 + (ch.charCodeAt(0) - 96);
      else break;
    }
    return n - 1;
  }

  // 解 zip：xlsx 就是个 zip，用浏览器自带的 deflate-raw 解压
  async function unzip(buf) {
    const dv = new DataView(buf);
    let eocd = -1;
    for (let i = buf.byteLength - 22; i >= Math.max(0, buf.byteLength - 66000); i--) {
      if (dv.getUint32(i, true) === 0x06054b50) {
        eocd = i;
        break;
      }
    }
    if (eocd < 0) throw new Error('不是有效的 xlsx 文件（.xls 请先另存为 .xlsx）');
    const count = dv.getUint16(eocd + 10, true);
    let off = dv.getUint32(eocd + 16, true);
    const files = new Map();
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(off, true) !== 0x02014b50) break;
      const method = dv.getUint16(off + 10, true);
      const compSize = dv.getUint32(off + 20, true);
      const nameLen = dv.getUint16(off + 28, true);
      const extraLen = dv.getUint16(off + 30, true);
      const commentLen = dv.getUint16(off + 32, true);
      const localOff = dv.getUint32(off + 42, true);
      const name = new TextDecoder('utf-8').decode(new Uint8Array(buf, off + 46, nameLen));
      files.set(name, { method, compSize, localOff });
      off += 46 + nameLen + extraLen + commentLen;
    }
    return async function read(name) {
      const f = files.get(name);
      if (!f) return null;
      const lo = f.localOff;
      const nameLen = dv.getUint16(lo + 26, true);
      const extraLen = dv.getUint16(lo + 28, true);
      const start = lo + 30 + nameLen + extraLen;
      const raw = new Uint8Array(buf, start, f.compSize);
      if (f.method === 0) return new TextDecoder('utf-8').decode(raw);
      if (typeof DecompressionStream === 'undefined') throw new Error('当前浏览器不支持解压，请把文件另存为 .csv');
      const ds = new DecompressionStream('deflate-raw');
      const writer = ds.writable.getWriter();
      writer.write(raw);
      writer.close();
      const reader = ds.readable.getReader();
      const chunks = [];
      let total = 0;
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.length;
      }
      const all = new Uint8Array(total);
      let off = 0;
      chunks.forEach((c) => {
        all.set(c, off);
        off += c.length;
      });
      return new TextDecoder('utf-8').decode(all);
    };
  }

  const xmlDoc = (t) => new DOMParser().parseFromString(t, 'application/xml');

  // 日期在 xlsx 里是“1900 起的天数”，按列名把数字换成年月
  function fixDateSerials(rows) {
    if (!rows.length) return rows;
    const head = rows[0].map((x) => String(x == null ? '' : x));
    let col = head.findIndex((h) => h.includes('入团'));
    if (col < 0) col = head.findIndex((h) => h.includes('时间') || h.includes('日期'));
    if (col < 0) return rows;
    for (let r = 1; r < rows.length; r++) {
      const v = String(rows[r][col] == null ? '' : rows[r][col]).trim();
      if (!/^\d{5}(\.\d+)?$/.test(v)) continue;
      const d = new Date(Date.UTC(1899, 11, 30) + Math.round(Number(v)) * 86400000);
      const y = d.getUTCFullYear();
      if (y > 1990 && y < 2100) rows[r][col] = `${y}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
    }
    return rows;
  }

  async function parseXlsx(buf) {
    const read = await unzip(buf);
    const wbXml = await read('xl/workbook.xml');
    if (!wbXml) throw new Error('不是有效的 xlsx 文件');
    let sheetPath = 'xl/worksheets/sheet1.xml';
    try {
      const wb = xmlDoc(wbXml);
      const sheet = wb.getElementsByTagName('sheet')[0];
      const rid = sheet && (sheet.getAttribute('r:id') || sheet.getAttribute('id'));
      const relsXml = await read('xl/_rels/workbook.xml.rels');
      if (rid && relsXml) {
        const rels = xmlDoc(relsXml);
        const rel = Array.from(rels.getElementsByTagName('Relationship')).find((x) => x.getAttribute('Id') === rid);
        if (rel) {
          const target = String(rel.getAttribute('Target') || '');
          sheetPath = target.startsWith('/') ? target.slice(1) : 'xl/' + target.replace(/^\.\//, '');
        }
      }
    } catch (e) {
      /* 用默认的 sheet1 */
    }
    const sheetXml = (await read(sheetPath)) || (await read('xl/worksheets/sheet1.xml'));
    if (!sheetXml) throw new Error('没找到工作表内容');
    const sharedXml = await read('xl/sharedStrings.xml');
    const shared = [];
    if (sharedXml) {
      const d = xmlDoc(sharedXml);
      Array.from(d.getElementsByTagName('si')).forEach((si) => {
        shared.push(Array.from(si.getElementsByTagName('t')).map((t) => t.textContent || '').join(''));
      });
    }
    const doc = xmlDoc(sheetXml);
    const rows = [];
    Array.from(doc.getElementsByTagName('row')).forEach((rowEl) => {
      const arr = [];
      Array.from(rowEl.getElementsByTagName('c')).forEach((c) => {
        const idx = Math.max(0, colIndexFromRef(c.getAttribute('r') || 'A'));
        const t = c.getAttribute('t');
        let v = '';
        if (t === 's') {
          const vEl = c.getElementsByTagName('v')[0];
          const i = vEl ? Number(vEl.textContent) : -1;
          v = shared[i] != null ? shared[i] : '';
        } else if (t === 'inlineStr') {
          v = Array.from(c.getElementsByTagName('t')).map((x) => x.textContent || '').join('');
        } else {
          const vEl = c.getElementsByTagName('v')[0];
          v = vEl ? vEl.textContent || '' : '';
        }
        arr[idx] = String(v).trim();
      });
      if (arr.length) rows.push(arr);
    });
    const width = rows.reduce((m, r) => Math.max(m, r.length), 0);
    rows.forEach((r) => {
      for (let i = 0; i < width; i++) if (r[i] == null) r[i] = '';
    });
    return fixDateSerials(rows);
  }

  function parseCsvText(text) {
    const rows = [];
    let row = [];
    let cell = '';
    let q = false;
    const s = String(text || '').replace(/^\uFEFF/, '');
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (q) {
        if (ch === '"') {
          if (s[i + 1] === '"') {
            cell += '"';
            i++;
          } else q = false;
        } else cell += ch;
      } else if (ch === '"') q = true;
      else if (ch === ',' || ch === '\t') {
        row.push(cell);
        cell = '';
      } else if (ch === '\n') {
        row.push(cell);
        rows.push(row);
        row = [];
        cell = '';
      } else if (ch !== '\r') cell += ch;
    }
    if (cell || row.length) {
      row.push(cell);
      rows.push(row);
    }
    return rows.filter((r) => r.some((x) => String(x == null ? '' : x).trim()));
  }

  function parseTextTable(raw) {
    const lines = String(raw || '')
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter(Boolean);
    if (!lines.length) return [];
    const first = lines[0];
    const sep = first.indexOf('\t') >= 0 ? '\t' : first.indexOf(',') >= 0 ? ',' : /\s{2,}/;
    return lines.map((l) =>
      String(l)
        .split(sep)
        .map((x) => x.trim().replace(/^"|"$/g, ''))
    );
  }

  async function handleImportFile(file) {
    if (!file) return;
    const name = file.name || '';
    try {
      let rows;
      if (/\.xlsx$/i.test(name)) rows = await parseXlsx(await file.arrayBuffer());
      else {
        // 中文 Excel 另存的 csv 常是 GBK，先按 UTF-8 解，出现乱码再换 GBK
        const buf = await file.arrayBuffer();
        let text = new TextDecoder('utf-8').decode(buf);
        if (text.indexOf('\uFFFD') >= 0) {
          try {
            text = new TextDecoder('gbk').decode(buf);
          } catch (e) {}
        }
        rows = parseCsvText(text);
      }
      rows = (rows || []).filter((r) => r.some((x) => String(x == null ? '' : x).trim()));
      if (rows.length < 2) {
        log(`「${name}」里没读到数据（至少要有表头 + 1 行）`);
        return;
      }
      impState.text = rows.map((r) => r.map((x) => String(x == null ? '' : x)).join('\t')).join('\n');
      impState.source = name;
      impState.result = validateRows(rows);
      log(`已读取「${name}」：${impState.result.rows.length} 行，问题 ${impState.result.errors.length} 条`);
      renderImp();
    } catch (e) {
      log(`读取「${name}」失败：${e.message}`);
    }
  }

  function validateImport(raw) {
    return validateRows(parseTextTable(raw));
  }

  function validateRows(rowsIn) {
    if (!rowsIn || rowsIn.length < 2) return { headers: [], rows: [], errors: [], ok: 0 };
    const norm = (v) => String(v == null ? '' : v).trim();
    const headers = (rowsIn[0] || []).map(norm);
    const find = (kw) => headers.findIndex((h) => h.indexOf(kw) >= 0);
    const iName = find('姓名');
    const iId = find('身份证');
    const iEth = find('民族');
    const iJoin = find('入团');
    const iCode = find('编号');
    const iPhone = find('手机');
    const rows = [];
    const errors = [];
    const seen = new Map();
    for (let r = 1; r < rowsIn.length; r++) {
      const cells = (rowsIn[r] || []).map(norm);
      const get = (i) => (i >= 0 ? cells[i] || '' : '');
      const name = get(iName);
      const id = get(iId);
      const eth = get(iEth);
      const join = get(iJoin);
      const code = get(iCode);
      const phone = get(iPhone);
      const row = { line: r + 1, name, id, eth, join, code, phone, errs: [] };
      if (!name) row.errs.push('姓名必填');
      else if (!/^[\u4e00-\u9fa5·]{2,15}$/.test(name)) row.errs.push('姓名应为 2-15 位中文');
      if (!id) row.errs.push('身份证必填');
      else {
        const e = idError(id);
        if (e) {
          row.errs.push('身份证' + e);
          // Excel 把 18 位当数字存会把后几位压掉，只能提示改列格式
          if (/^\d{13,}(\.\d+)?([eE]\+?\d+)?$/.test(id) || /[eE]\+/.test(id)) {
            row.errs.push('身份证疑似“数字格式”，后几位可能已失真（Excel 里请把该列设为文本后重存）');
          }
        }
        const up = id.toUpperCase();
        if (seen.has(up)) row.errs.push(`与第 ${seen.get(up)} 行身份证重复`);
        else seen.set(up, r + 1);
      }
      if (!eth) row.errs.push('民族必填');
      if (!join) row.errs.push('入团时间必填');
      else {
        const jm = parseYm(join);
        if (!jm || jm.m < 1 || jm.m > 12) row.errs.push('入团时间应形如 2025-05');
        else {
          if (jm.y >= 2016 && !code) row.errs.push('2016 年后入团必须填发展团员编号');
          if (/^\d{17}/.test(id)) {
            const by = Number(id.slice(6, 10));
            const bm = Number(id.slice(10, 12));
            const ageM = jm.y * 12 + jm.m - (by * 12 + bm);
            const need = jm.y >= 2017 ? 13 : 12;
            if (ageM < need * 12) row.errs.push(`入团时未满 ${need} 周岁（系统会拒绝）`);
            if (ageM > 28 * 12) row.errs.push('入团时已超 28 周岁（请核对）');
          }
        }
      }
      if (code) {
        if (!/^\d{8,16}$/.test(code)) row.errs.push('发展编号应为 8-16 位数字');
        else if (/^\d{4}/.test(code) && join) {
          const jm = parseYm(join);
          if (jm && Number(code.slice(0, 4)) !== jm.y) row.errs.push(`编号年份 ${code.slice(0, 4)} 与入团年份 ${jm.y} 不一致`);
        }
      }
      if (phone && !/^1[3-9]\d{9}$/.test(phone)) row.errs.push('手机号格式不正确');
      rows.push(row);
      row.errs.forEach((m) => errors.push({ line: row.line, name, msg: m }));
    }
    return { headers, rows, errors, ok: rows.filter((r) => !r.errs.length).length };
  }

  function exportImportErrors() {
    const res = impState.result;
    if (!res || !res.errors.length) {
      log('没有问题需要导出');
      return;
    }
    const data = [['行号', '姓名', '问题']];
    res.errors.forEach((e) => data.push([e.line, e.name, e.msg]));
    const csv = '\uFEFF' + data.map((r) => r.map(csvCell).join(',')).join('\r\n');
    download('录入预检问题.csv', csv);
  }

  function renderImp() {
    const pane = shadow && shadow.querySelector('[data-pane="imp"]');
    if (!pane) return;
    const res = impState.result;
    const summary = res
      ? `<div class="stat"><span>共 <i>${res.rows.length}</i> 行</span><span>通过 <i class="ok">${res.ok}</i></span><span>问题 <i class="bad">${res.errors.length}</i></span></div>`
      : '';
    const head = res && res.headers.length ? `<div class="tiny">表头：${esc(res.headers.join(' / '))}</div>` : '';
    const errs = res
      ? res.errors.length
        ? `<div class="list" style="max-height:200px"><table class="tbl"><thead><tr><th>行</th><th>姓名</th><th>问题</th></tr></thead><tbody>${res.errors
            .slice(0, 100)
            .map((e) => `<tr><td>${e.line}</td><td>${esc(e.name)}</td><td class="bad">${esc(e.msg)}</td></tr>`)
            .join('')}</tbody></table></div>`
        : `<div class="tiny ok">全部通过，可以上传。</div>`
      : '';
    pane.innerHTML = `
      <div class="tiny" style="margin-bottom:6px">可以直接选 Excel 文件（.xlsx）或 .csv，也可以把表格整块复制粘贴到下面。上传前先跑一遍校验。</div>
      <div class="row">
        <button class="b p" data-act="pick">选择表格文件</button>
        <input type="file" data-act="file" accept=".xlsx,.csv,.txt" style="display:none">
        <button class="b" data-act="check">预检</button>
        <button class="b" data-act="export">导出问题</button>
        <button class="b" data-act="clear">清空</button>
      </div>
      ${impState.source ? `<div class="tiny">已读取：${esc(impState.source)}（内容已填进下面的框，可以改）</div>` : ''}
      <textarea class="ta" data-act="ta" placeholder="姓名\t身份证\t民族\t入团时间\t发展团员编号\t手机号码">${esc(impState.text)}</textarea>
      ${summary}${head}${errs}
      <div class="tiny" style="margin-top:8px">
        支持 .xlsx / .csv；老的 .xls 请先在 Excel 里「另存为 .xlsx」。<br>
        检查：身份证校验位、入团年龄（2017 前 12 岁 / 后 13 岁）、编号年份一致性、编号与手机号格式、行内重复。<br>
        ⚠️ 身份证列请设成「文本」格式再导出——Excel 按数字存会把后几位压成 0，插件只能提示，救不回来。<br>
        本页不联网、不上传。
      </div>
    `;
    const ta = pane.querySelector('[data-act="ta"]');
    ta.addEventListener('input', () => {
      impState.text = ta.value;
      impState.source = '';
    });
    const fileInput = pane.querySelector('[data-act="file"]');
    pane.querySelector('[data-act="pick"]').addEventListener('click', () => fileInput.click());
    fileInput.addEventListener('change', () => {
      const f = fileInput.files && fileInput.files[0];
      if (f) handleImportFile(f);
    });
    pane.querySelector('[data-act="check"]').addEventListener('click', () => {
      impState.text = ta.value;
      impState.result = validateImport(ta.value);
      if (!impState.result.rows.length) log('没解析到数据，请确认复制时带了表头');
      else log(`预检完成：${impState.result.rows.length} 行，问题 ${impState.result.errors.length} 条`);
      renderImp();
    });
    pane.querySelector('[data-act="export"]').addEventListener('click', exportImportErrors);
    pane.querySelector('[data-act="clear"]').addEventListener('click', () => {
      impState.text = '';
      impState.result = null;
      renderImp();
    });
  }

  function fillUpdateSlot(pane) {
    if (!HAS_UPDATER) return;
    const slot = pane && pane.querySelector('[data-upd-slot]');
    if (!slot) return;
    const u = window.__CYLAA_UPDATER__;
    if (!u) {
      slot.innerHTML = '<div class="tiny">更新检查组件未加载</div>';
      return;
    }
    slot.innerHTML = u.settingsHtml();
    const checkBtn = slot.querySelector('[data-act="checkupd"]');
    if (checkBtn) checkBtn.addEventListener('click', () => u.check(true));
    const openBtn = slot.querySelector('[data-act="openupd"]');
    if (openBtn) openBtn.addEventListener('click', () => u.open());
  }

  function renderSettings() {
    const pane = shadow && shadow.querySelector('[data-pane="set"]');
    if (!pane) return;
    pane.innerHTML = `
      <label class="sw"><input type="checkbox" data-set="autoClose" ${state.settings.autoClose ? 'checked' : ''}> 记录后自动关闭弹窗</label>
      <label class="sw"><input type="checkbox" data-set="snapEdge" ${state.settings.snapEdge ? 'checked' : ''}> 悬浮球吸附到最近页边</label>
      <div class="tiny" style="margin:-2px 0 8px">收起成悬浮球后可以直接拖动；开启吸附时松手会贴到最近的左右页面边缘，卡片会按球的位置自动决定展开方向。</div>
      <label class="sw">操作间隔 <input type="number" data-set="delay" min="200" max="3000" step="100" value="${state.settings.delay}" style="width:70px"> ms</label>
      <div class="row" style="margin-top:8px">
        <button class="b" data-act="logout">清除本地数据</button>
      </div>
      <div style="border-top:1px dashed #eee;margin:10px 0"></div>
      ${
        HAS_UPDATER
          ? '<div data-upd-slot></div>'
          : `<div class="tiny">当前版本 v${VERSION}（商店版，更新由 Microsoft Edge 加载项商店完成）</div>`
      }
      <div class="tiny" style="margin-top:10px">
        本工具只读取当前页面已展示的数据与平台自身的同源接口，不上传任何内容。<br>
        批量任务需要你在面板中点击确认后才会执行；确认后插件会逐人填写并提交，请先核对名单与内容。<br>
        审批、删除等动作仍需你在页面上亲自操作。
      </div>
    `;
    pane.querySelectorAll('[data-set]').forEach((inp) =>
      inp.addEventListener('change', () => {
        const k = inp.dataset.set;
        state.settings[k] = inp.type === 'checkbox' ? inp.checked : Number(inp.value) || 400;
        if (k === 'snapEdge') {
          if (state.settings.snapEdge) snapBallToEdge();
          else applyBallLayout();
        }
        saveSettings();
      })
    );
    fillUpdateSlot(pane);
    pane.querySelector('[data-act="logout"]').addEventListener('click', () => {
      state.roster = [];
      state.selected.clear();
      state.codes = [];
      state.logs = [];
      state._rosterSig = null;
      state._official = undefined;
      clearPjCache();
      syncDecoration();
      renderAll();
      log('已清除');
    });
  }

  /* ---------------- bootstrap ---------------- */
  function onRouteChange() {
    if (!root) return;
    if (state.route === location.pathname) return;
    state.route = location.pathname;
    renderAll();
    if (routeKind() === 'memberlist') setTimeout(() => decorate(), 500);
  }

  function ensureMounted() {
    if (location.pathname.includes('/static/')) return;
    if (!root) {
      if (!document.body) return;
      injectPageStyle();
      mount();
      watchDialogs();
      startDialogPoll();
      const mo = new MutationObserver(() => {
        clearTimeout(state._t);
        state._t = setTimeout(() => {
          const kind = routeKind();
          if (kind === 'memberlist') decorate();
          if (kind === 'twosystem' && !pjState.busy) renderPj();
        }, 300);
      });
      mo.observe(document.body, { childList: true, subtree: true });
      onRouteChange();
      log('插件已就绪');
      return;
    }
    onRouteChange();
  }

  async function init() {
    console.info('[团务助手] content script 已注入', location.href);
    try {
      const saved = await chrome.storage.local.get('zhtjHelperSettings');
      if (saved && saved.zhtjHelperSettings) Object.assign(state.settings, saved.zhtjHelperSettings);
    } catch (e) {
      /* 非扩展环境（如本地 mock 页）忽略 */
    }
    // 评议页的名单与勾选存在 sessionStorage，刷新后恢复（兜底用）
    const restored = loadPjCache();
    // 团员信息的字段模板，刷新后也能在名单页直接配批量
    loadInfoTemplate();
    ensureMounted();
    if (restored) log(`已恢复评议数据：${restored} 人（勾选 ${pjState.sel.size} 人）`);
    setInterval(() => {
      try {
        ensureMounted();
        maybeResumeInfoJob();
      } catch (e) {
        console.error('[团务助手] 挂载失败', e);
      }
    }, 700);
  }


  try {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
    else init();
  } catch (e) {
    console.error('[团务助手] 初始化异常', e);
  }
})();
