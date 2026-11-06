package com.leo.tvlive.util

/**
 * 回放页「红点鼠标光标」注入脚本。
 *
 * ── 为什么需要它 ─────────────────────────────────────────────
 * 回放站是第三方网页，遥控器（D-pad）在上面**完全没反应**：网页里没有任何东西会
 * 响应方向键，用户既看不到「当前选中在哪」，也不知道该按哪里才能播。
 *
 * Android WebView 自身不提供「方向键在网页里导航」的能力（Chromium 的空间导航
 * 默认关闭且没有开放设置项），所以只能由我们自己实现一套。
 *
 * ── v1.1.0 的路线变更：从「选框导航」改为「红点鼠标」────────────────
 * 上一版把页面上所有可交互元素枚举出来，方向键在元素之间跳、红框框住当前元素。
 * 实测问题（用户 2026-10-12 反馈）：
 *   · 只能点到「被我们判定为可交互」的元素，判定不到的地方就是盲区；
 *   · 换一个网站（DOM 结构不同、按钮是 div 且不带 onclick）就可能完全不灵；
 *   · 与真实鼠标/触屏的直觉不一致 —— 用户想要的其实是「一个能控制的指针」。
 *
 * 新版改成**鼠标隐喻**：屏幕中央出现一个红点 🔴，方向键按固定步长挪动它，
 * 按「确定」= 在红点所在位置按下鼠标。命中测试用浏览器原生的
 * document.elementFromPoint(x, y)，因此：
 *   · 任何网站、任何元素都能点到（不依赖我们对「可交互」的猜测）；
 *   · 元素没被点中也不会出错，最多是「点空了」；
 *   · 走的是标准鼠标事件流，站点自己的播放器逻辑能正常收到。
 *
 * ── 边缘滚动（用户 2026-10-12 追加要求）─────────────────────────
 * 红点走到**视口边缘**后，继续朝同一方向按方向键，不再「卡住不动」，而是
 * **朝该方向滚动页面**——内容从红点下面滑过去，用户就能看到后面的内容。
 * 这是长列表/长页面唯一的走法（一屏放不下，又不能把红点挪出屏幕）。
 *
 * 滚动顺序刻意做成「由内到外」，与浏览器滚轮的行为一致（scroll chaining）：
 *   红点所在的可滚动容器先滚 → 滚到头 → 再滚外层/整页。
 * 反过来先滚整页的话，红点停在一个内部滚动列表上时，用户永远看不到列表后面的条目。
 *
 * ── 已知边界（不回避）──────────────────────────────────────────
 * 1) 脚本运行在**顶层文档**。红点落在**跨域 iframe** 上方时，浏览器同源策略不允许
 *    我们进入其内部元素，只能点到 iframe 本身（同源 iframe 已做下钻，见 pick()）。
 * 2) 命中测试用的是「视口坐标」，页面对根元素做了 CSS transform 缩放时坐标会偏。
 * 3) 跨域 iframe 内部如果自己滚动，我们同样进不去 —— 只能滚外层（同源策略硬限制）。
 *
 * ── v1.3.0 新增：播放能力上报 + 黑屏自愈 ────────────────────────
 * 现象（用户 2026-10-12 反馈）：电视上点进具体视频后**一直黑屏、连播放按钮都不出现**，
 * 而同一个页面在手机上正常。这类问题的难点在于「网页里到底发生了什么」原本完全不可见，
 * 所以脚本承担两件事：
 *   ① 上报本机播放能力与视频状态（通过 report() 走 console.log，由原生层 onConsoleMessage 接收）；
 *   ② 做**有限次**的自动补救 —— 视频已在页面里却没在播时，替用户按一次「播放」。
 * 补救刻意限制在注入后的前 20 秒、且每个动作最多一次，避免把用户主动的暂停又播回来。
 *
 * ── 与 Kotlin 侧的约定 ────────────────────────────────────────
 * 注入后暴露 window.__tvNav，主界面把遥控器按键的 keyCode 原样传进来：
 *   19 上 · 20 下 · 21 左 · 22 右 · 23/66 确定
 * 诊断上报走 console.log，前缀 __TVNAV__（见 report），Kotlin 侧凭前缀识别。
 */
object TvNavScript {

    /**
     * 脚本版本：重复注入时用于短路（页面内已有同版本脚本就只重绘，不重复挂载）。
     * 改动脚本逻辑时必须递增，否则已加载过的页面会继续跑旧逻辑。
     */
    private const val VERSION = 7

    /** 待注入的脚本源码（ES5 语法，兼容老旧电视盒子上的老版 WebView） */
    val JS: String = """
(function () {
  // ── 复用短路：同版本已注入过就只重绘一次（页面跳转后旧上下文会整体消失，故这里是安全网）
  var nav = window.__tvNav;
  if (nav && nav.version === $VERSION) { nav.paint(); return; }
  // 注入的是「不同版本的旧脚本」→ 先让旧实例自清理（停掉它的定时器与监听器）。
  // 否则新旧两套脚本会同时响应方向键、同时监听 resize，互相打架 —— 这正是
  // 「回看页偶发错乱」的一大来源（v1.4.4 修）。
  if (nav && nav.dispose) { try { nav.dispose(); } catch (e) {} }

  var DOT = '__tvnav_dot';        // 红点（光标）的 DOM id
  var TIP = '__tvnav_tip';        // 红点下方「目标提示」的 DOM id
  var MAX_DEPTH = 4;              // 同源 iframe 下钻的最大层数（防循环嵌套）
  // 「贴边判定带」：红点进入距视口边缘 BAND 像素的范围后，再朝该方向按方向键 → 改为滚动页面。
  // 之所以不等到贴死边缘（0px）才滚：红点直径 18px，贴到 0 会被屏幕切掉一半，看不见就没法瞄。
  var BAND = 36;
  // 「硬边界」：页面在该方向已经滚到头、滚不动了，就允许红点继续贴到距边缘 HARD 像素，
  // 免得页面右边/下边最后 36px 内的内容永远点不到。
  var HARD = 8;

  var cx = 0, cy = 0;             // 光标位置（视口坐标系，单位 CSS 像素）
  var hovered = null;             // 上一次悬停的元素（用于补发 mouseout）

  // ── 回看页「后退栈」（v1.4.4）──────────────────────────────────
  // 站点是「列表页 → 点卡片进播放页」的多级站点，但跳转常发生在**同源 iframe 内部**，
  // 顶层 WebView 的历史并不增长 → webView.canGoBack() 恒为 false → 按返回键会**直接回直播**、
  // 退不回上一屏（用户 2026-10-13 反馈）。这里自己记住「每次点击前所在文档的地址」，
  // 后退时逐条还原，做到「一步一步返回上一个画面」。
  // 存的是 window 引用 + 点击前的 location.href；由 window.__tvNav.back() 驱动。
  var navStack = [];

  // ── 基础小工具 ────────────────────────────────────────────

  function vw() { return window.innerWidth || 1; }     // 视口宽度（拿不到时退化为 1，防除零）
  function vh() { return window.innerHeight || 1; }    // 视口高度
  function clamp(v, lo, hi) { return v < lo ? lo : (v > hi ? hi : v); }   // 数值夹取

  // 元素的「可点击目标」标签：命中元素本身不是链接/按钮时，向上找一层
  var CLICK_TAGS = { A: 1, BUTTON: 1, INPUT: 1, SELECT: 1, TEXTAREA: 1, VIDEO: 1, LABEL: 1 };

  // 元素是否看得见（有尺寸且未被隐藏）。
  // 注意用 ownerDocument.defaultView 取样式，这样元素位于同源 iframe 内部时也判得准。
  function visible(el) {
    if (!el || !el.getBoundingClientRect) return false;
    var r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;     // 尺寸为 0 的占位节点直接排除
    var w = (el.ownerDocument && el.ownerDocument.defaultView) || window;
    var s = w.getComputedStyle(el);
    if (s && (s.display === 'none' || s.visibility === 'hidden' || parseFloat(s.opacity) === 0)) return false;
    return true;
  }

  /**
   * 找「可见视频」的中心点，坐标换算到**顶层视口**；找不到返回 null。
   *
   * 为什么要递归进 iframe：回放站的播放器并不是放在顶层文档里的，而是在同源的
   * 播放器 iframe 内（真机线上页面实测：/api/embed?url=... 这种相对地址，故同源）。
   * 不钻进去的话，红点就只能落在整屏正中央 —— 播放器若不在正中，用户一进来
   * 还得先用方向键找过去。
   */
  function findVideoCenter(doc, ox, oy, depth) {
    if (!doc || depth > MAX_DEPTH) return null;
    var vs = doc.getElementsByTagName('video');
    for (var i = 0; i < vs.length; i++) {
      if (!visible(vs[i])) continue;
      var r = vs[i].getBoundingClientRect();
      return { x: ox + r.left + r.width / 2, y: oy + r.top + r.height / 2 };
    }
    // 本层没有视频 → 逐个同源 iframe 钻下去找（跨域 iframe 拿不到 contentDocument，自然跳过）
    var fs = doc.getElementsByTagName('iframe');
    for (var j = 0; j < fs.length; j++) {
      var idoc = null;
      try { idoc = fs[j].contentDocument; } catch (e) { idoc = null; }
      if (!idoc) continue;
      var fr = fs[j].getBoundingClientRect();
      if (fr.width < 2 || fr.height < 2) continue;      // display:none 的 iframe 尺寸为 0，跳过
      var c = findVideoCenter(
        idoc,
        ox + fr.left + (fs[j].clientLeft || 0),
        oy + fr.top + (fs[j].clientTop || 0),
        depth + 1
      );
      if (c) return c;
    }
    return null;
  }

  // ── 红点与提示标签（自己画的，不依赖页面样式，故任何站点都能显示）────

  function dot() {
    var d = document.getElementById(DOT);
    if (!d) {
      d = document.createElement('div');
      d.id = DOT;
      // position:fixed + 最大 z-index：贴在最上层，且不随页面滚动而漂移。
      // margin:-9px 让 left/top 指向的正是圆心（否则点会偏到圆心右下角）。
      // pointer-events:none 极其关键：红点自己绝不能挡住命中测试，否则永远只能点到它。
      d.style.cssText =
        'position:fixed;left:0;top:0;width:18px;height:18px;margin:-9px 0 0 -9px;' +
        'border-radius:50%;background:#FF3B30;' +
        'box-shadow:0 0 0 2px rgba(255,255,255,0.95),0 0 14px rgba(255,59,48,0.95);' +
        'z-index:2147483647;pointer-events:none;';
      document.documentElement.appendChild(d);
    }
    return d;
  }

  function tip() {
    var t = document.getElementById(TIP);
    if (!t) {
      t = document.createElement('div');
      t.id = TIP;
      t.style.cssText =
        'position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;' +
        'background:rgba(0,0,0,0.78);color:#fff;font:12px/16px sans-serif;' +
        'padding:2px 7px;border-radius:3px;max-width:280px;overflow:hidden;' +
        'white-space:nowrap;text-overflow:ellipsis;';
      document.documentElement.appendChild(t);
    }
    return t;
  }

  // ── 命中测试：红点下面到底是什么 ────────────────────────────

  /**
   * 在 (x, y) 处做命中测试，返回 { el, doc, x, y }：
   *   el  = 命中的元素（最深层）
   *   doc = 该元素所在文档（跨过同源 iframe 时会变成内层 document）
   *   x/y = 换算到该文档视口坐标系后的坐标（派发事件要用它）
   * 跨域 iframe 进不去，此时停在 iframe 元素这一层（el 即 iframe）。
   */
  function pick(x, y) {
    var doc = document, ex = x, ey = y, el = null, depth = 0;
    while (depth < MAX_DEPTH) {
      try { el = doc.elementFromPoint(ex, ey); } catch (e) { el = null; }
      if (!el) return null;                                   // 点到空白（如 html 之外的区域）
      if ((el.tagName || '').toUpperCase() !== 'IFRAME') break;
      var idoc = null;
      try { idoc = el.contentDocument; } catch (e) { idoc = null; }
      if (!idoc || !idoc.elementFromPoint) break;             // 跨域：拿不到内部文档，只能到此为止
      var r = el.getBoundingClientRect();
      // iframe 的边框占位要减掉：内容视口从 border 内侧开始
      ex = ex - r.left - (el.clientLeft || 0);
      ey = ey - r.top - (el.clientTop || 0);
      doc = idoc;
      depth++;
    }
    return { el: el, doc: doc, x: ex, y: ey };
  }

  /** 从命中元素向上找「真正该被点」的元素（鼠标点击会被祖先接住，但原生 click() 需要具体目标） */
  function clickable(el) {
    var node = el, depth = 0;
    while (node && depth < 6) {
      var n = (node.tagName || '').toUpperCase();
      // 标签名命中，或显式声明了 onclick / role=button，都算可点目标
      if (CLICK_TAGS[n] || (node.hasAttribute && (node.hasAttribute('onclick') || node.getAttribute('role') === 'button'))) {
        return node;
      }
      node = node.parentElement;
      depth++;
    }
    return el;   // 都没命中就退回最深层元素，靠事件冒泡让祖先的监听器接住
  }

  /** 生成红点下方的目标说明文字（电视上光有红点，用户不知道这一下会点到什么） */
  function describe(el) {
    if (!el) return '';
    var n = (el.tagName || '').toUpperCase();
    if (n === 'VIDEO') return '视频';
    if (n === 'IMG') { var a = (el.alt || '').replace(/\s+/g, ' ').trim(); return a ? ('图片：' + a.slice(0, 18)) : '图片'; }
    if (n === 'INPUT' || n === 'TEXTAREA' || n === 'SELECT') {
      var label = n === 'SELECT' ? '下拉框' : (n === 'TEXTAREA' ? '文本框' : '输入框');
      var p = (el.placeholder || el.value || el.title || '').replace(/\s+/g, ' ').trim();
      return label + (p ? ('：' + p.slice(0, 18)) : '');
    }
    // 容器类元素（子节点很多）的 textContent 是全页文字，拿来当提示会误导，直接跳过
    var kids = el.children ? el.children.length : 0;
    if (kids > 3) return '';
    var t = (el.textContent || '').replace(/\s+/g, ' ').trim();
    if (!t) return '';
    return t.length > 22 ? (t.slice(0, 22) + '…') : t;
  }

  // ── 渲染 ─────────────────────────────────────────────────

  /** 把提示标签摆到红点附近（贴近底边时改放上方，避免被裁掉） */
  function paintTip(text) {
    var t = tip();
    if (!text) { t.style.display = 'none'; return; }
    t.style.display = 'block';
    t.textContent = text;
    var ty = cy + 16;
    if (ty > vh() - 24) ty = cy - 30;                       // 底部空间不够 → 翻到上面
    t.style.left = clamp(cx - 24, 2, Math.max(2, vw() - 170)) + 'px';
    t.style.top = ty + 'px';
  }

  /**
   * 悬停：给红点下面的元素补发 mousemove / mouseover。
   * 这一步非常关键 —— 大量播放器（含常见网站在用的那些）**只在鼠标悬停时才显示
   * 控制条**，不补鼠标事件的话用户会看到「明明点到了、按钮却根本不存在」。
   */
  function hover() {
    var p = pick(cx, cy);
    if (!p || !p.el) { paintTip(''); return; }
    var el = p.el;
    try {
      var win = p.doc.defaultView || window;
      var o = { bubbles: true, cancelable: true, view: win, clientX: p.x, clientY: p.y, button: 0, buttons: 0 };
      el.dispatchEvent(new win.MouseEvent('mousemove', o));
      if (hovered !== el) {                                 // 换了目标才补 mouseout/mouseover，避免刷屏
        if (hovered) { try { hovered.dispatchEvent(new win.MouseEvent('mouseout', o)); } catch (e) {} }
        el.dispatchEvent(new win.MouseEvent('mouseover', o));
        hovered = el;
      }
    } catch (e) {}
    paintTip(describe(el));
  }

  /** 重绘红点（移动/页面变化后调用） */
  function paint() {
    var d = dot();
    d.style.display = 'block';
    d.style.left = cx + 'px';
    d.style.top = cy + 'px';
    hover();
  }

  // ── 滚动 ─────────────────────────────────────────────────

  /** 节点在指定方向上「是否还有可滚的余地」（样式允许滚 + 内容确实超出可视区） */
  function canScroll(node, dx, dy) {
    if (!node || node.nodeType !== 1) return false;
    var w = (node.ownerDocument && node.ownerDocument.defaultView) || window;
    var s = null;
    try { s = w.getComputedStyle(node); } catch (e) { s = null; }
    if (!s) return false;
    var okY = dy !== 0 && /(auto|scroll|overlay)/.test(s.overflowY) && node.scrollHeight > node.clientHeight + 2;
    var okX = dx !== 0 && /(auto|scroll|overlay)/.test(s.overflowX) && node.scrollWidth > node.clientWidth + 2;
    return okX || okY;
  }

  /** 把节点朝指定方向滚一段，返回是否真的滚动了（已经到头 = 原地不动 = 失败） */
  function scrollNode(node, dx, dy) {
    if (!node || node.nodeType !== 1) return false;
    var x0 = node.scrollLeft, y0 = node.scrollTop;
    try {
      if (dx) node.scrollLeft = x0 + dx;
      if (dy) node.scrollTop = y0 + dy;
    } catch (e) { return false; }
    return node.scrollLeft !== x0 || node.scrollTop !== y0;
  }

  /**
   * 尝试某个**文档的根滚动器**。
   * 为什么三个候选都要试：
   *   · document.scrollingElement 是标准答案，但**老 WebView（Chrome 51 之前）没有这个属性**；
   *   · 标准模式（有大写 DOCTYPE）下滚的是 <html>，怪异模式（quirks，老站常见）下滚的是 <body>；
   * 只试其中一个，就会在某一类页面上「静默失效」——现象正是「顶到边缘了但什么都没滚」。
   */
  function scrollDocRoot(doc, dx, dy) {
    if (!doc) return false;
    var cands = [doc.scrollingElement, doc.documentElement, doc.body];
    for (var i = 0; i < cands.length; i++) {
      if (scrollNode(cands[i], dx, dy)) return true;
    }
    return false;
  }

  /**
   * 兜底扫描：找出页面上所有「可滚、且矩形覆盖了红点位置」的容器，逐个试。
   * 只有在前面几条更便宜的路都失败时才走到这里 —— 用于「滚动容器并不是红点的祖先」
   * 这种少见结构（例如列表外层套了一层自己的滚动面板）。
   */
  function scanScrollable(dx, dy) {
    if (!document.querySelectorAll) return false;
    var all = document.querySelectorAll('div,section,main,ul,ol,article,aside,nav,table,form');
    var lim = all.length < 2500 ? all.length : 2500;   // 电视盒子 CPU 弱，扫太多会卡
    for (var i = 0; i < lim; i++) {
      var e = all[i];
      // 先做便宜的尺寸判断，只有「内容确实超出」才去读样式（getComputedStyle 很贵）
      var sY = dy !== 0 && e.scrollHeight > e.clientHeight + 2;
      var sX = dx !== 0 && e.scrollWidth > e.clientWidth + 2;
      if (!sY && !sX) continue;
      if (!canScroll(e, dx, dy)) continue;
      var r = e.getBoundingClientRect();
      if (cx < r.left || cx > r.right || cy < r.top || cy > r.bottom) continue;   // 红点不在这块区域里，跳过
      if (scrollNode(e, dx, dy)) return true;
    }
    return false;
  }

  /**
   * 滚动 (dx, dy)，返回是否成功。
   *
   * 顺序：**由内到外**（浏览器滚轮的标准行为，scroll chaining）——
   *   ① 红点正下方元素 → 逐级向上找可滚的祖先（有同源 iframe 时，链从内层文档开始）
   *   ② 红点所在文档（可能在内层同源 iframe 里）的根滚动器
   *   ③ 顶层文档的根滚动器 + window.scrollBy（个别老内核只认 window.scrollBy）
   *   ④ 兜底：几何扫描（见 scanScrollable）
   *
   * 线上实测（2026-10-12）：
   *   · 回放站列表页 → 整页滚动器是 <html>，window.scrollBy 有效，无内部滚动容器；
   *   · 回放站播放页 → 整页滚动器同样是 <html>，另有一个内部可滚容器 .play-box-side-main（852 > 465）。
   * 两条形态都被覆盖。
   */
  function tryScroll(dx, dy) {
    // ① 从红点下方元素起逐级向上（含同源 iframe 内层：pick 会钻进去，链自然从内层开始）
    var p = pick(clamp(cx, 2, vw() - 2), clamp(cy, 2, vh() - 2));
    var node = p ? p.el : null;
    var guard = 0;
    while (node && guard < 40) {
      if (canScroll(node, dx, dy) && scrollNode(node, dx, dy)) return true;
      node = node.parentElement;
      guard++;
    }

    // ② 红点所在文档的根滚动器（红点在同源 iframe 内时，这也是一层真实可滚对象）
    if (p && p.doc && p.doc !== document && scrollDocRoot(p.doc, dx, dy)) return true;

    // ③ 顶层文档根滚动器
    if (scrollDocRoot(document, dx, dy)) return true;

    // ③' window.scrollBy：极少数老内核不认 scrollTop 赋值，只认这个 API
    var se = document.scrollingElement || document.documentElement;
    if (se) {
      var x0 = se.scrollLeft, y0 = se.scrollTop;
      try { window.scrollBy(dx, dy); } catch (e) {}
      if (se.scrollLeft !== x0 || se.scrollTop !== y0) return true;
    }

    // ④ 兜底几何扫描
    return scanScrollable(dx, dy);
  }

  // ── 光标移动 ─────────────────────────────────────────────

  // 单次按键的位移步长：按视口比例给（不同分辨率/密度下手感一致），并设下限防止高 DPI 下太小。
  // v1.4.4：整体调细约一半（用户反馈「回放页某些地方的按钮按不到」）。
  //   旧值 0.08 / 0.09 在 1080p 上一按就跳 ~86 / 97px，控制条、列表项这种小目标常被一步跨过；
  //   新值 0.04 / 0.045（1080p ≈ 43 / 49px）既能落进小按钮，跨屏也不会太累（配合贴边滚动）。
  function stepX() { return Math.max(24, Math.round(vw() * 0.04)); }
  function stepY() { return Math.max(20, Math.round(vh() * 0.045)); }

  // 「贴边滚动步长」与「红点移动步长」**分开**（v1.4.4）。
  // 红点步长为精细瞄准调小了一半；但贴边滚动若跟着变慢，推页会按到手酸。
  // 故滚动仍沿用调细前的较大步长：瞄准精细、翻页利落，两不耽误。
  function scrollStepX() { return Math.max(48, Math.round(vw() * 0.08)); }
  function scrollStepY() { return Math.max(36, Math.round(vh() * 0.09)); }

  function move(dir) {
    var dx = 0, dy = 0;
    if (dir === 'left') dx = -stepX();
    else if (dir === 'right') dx = stepX();
    else if (dir === 'up') dy = -stepY();
    else dy = stepY();

    var nx = cx + dx, ny = cy + dy;

    // 红点已经贴着边、还要继续朝边外走 → 改为滚页面（内容从红点下面滑过），红点留在原地。
    // 滚动量用**独立的滚动步长**（比红点步长大），所以「瞄得细」不等于「翻得慢」。
    // 滚不动了（页面到头了）就走到下面的夹取逻辑，让红点贴到 HARD，边缘内容仍点得到。
    if (dx !== 0 && ((dx < 0 && nx < BAND) || (dx > 0 && nx > vw() - BAND)) && tryScroll(dx < 0 ? -scrollStepX() : scrollStepX(), 0)) nx = cx;
    if (dy !== 0 && ((dy < 0 && ny < BAND) || (dy > 0 && ny > vh() - BAND)) && tryScroll(0, dy < 0 ? -scrollStepY() : scrollStepY())) ny = cy;

    cx = clamp(nx, HARD, vw() - HARD);   // 夹在视口内，红点不会跑出屏幕
    cy = clamp(ny, HARD, vh() - HARD);
    paint();
    return true;
  }

  // ── 点击 ─────────────────────────────────────────────────

  /** 在红点位置「按下鼠标」 */
  function enter() {
    var p = pick(cx, cy);
    if (!p || !p.el) return false;
    var el = p.el;                     // 最深层元素：事件从它开始冒泡，路径与真实点击一致
    var target = clickable(el);        // 真正承担点击行为的元素（通常是外层 a / button）
    var win = p.doc.defaultView || window;

    // 记录「点击前所在文档的地址」，供后退还原（详见 navStack 说明）。
    // 放在 VIDEO 分支之前，保证任何点击都会留下一条可后退的记录；无跳转的记录在 back() 里会被跳过。
    try {
      navStack.push({ win: win, url: win.location.href });
      if (navStack.length > 40) navStack.shift();
    } catch (e) {}

    // <video> 直接切播放/暂停：部分站点不给 video 绑 click，纯 click() 会没反应
    if ((el.tagName || '').toUpperCase() === 'VIDEO') {
      try { if (el.paused) { el.play(); } else { el.pause(); } return true; } catch (e) {}
    }

    // 先补一套完整的鼠标事件序列：不少站点只监听 mousedown/mouseup，不认 click
    try {
      var base = { bubbles: true, cancelable: true, view: win, clientX: p.x, clientY: p.y, button: 0 };
      var down = { bubbles: true, cancelable: true, view: win, clientX: p.x, clientY: p.y, button: 0, buttons: 1 };
      var up = { bubbles: true, cancelable: true, view: win, clientX: p.x, clientY: p.y, button: 0, buttons: 0 };
      el.dispatchEvent(new win.MouseEvent('mousemove', base));
      el.dispatchEvent(new win.MouseEvent('mouseover', base));
      el.dispatchEvent(new win.MouseEvent('mousedown', down));
      el.dispatchEvent(new win.MouseEvent('mouseup', up));
    } catch (e) {}

    // 最后用原生 click()：只有它才会触发默认行为（链接跳转、表单提交、按钮的默认动作），
    // 合成事件（isTrusted=false）在多数浏览器里是不触发默认行为的。
    try { if (target.focus) target.focus(); } catch (e) {}
    try { target.click(); } catch (e) {}

    paint();     // 页面可能已经变了，重绘一次让提示文字跟上
    reportDepth();   // 把最新的后退栈深度报给原生层（返回键据此决定先退网页还是回直播）
    return true;
  }

  /** 把后退栈深度上报原生层（返回键据此判断「网页里还能不能往回退」） */
  function reportDepth() {
    report('nav', 'depth=' + navStack.length);
  }

  /**
   * 后退一步：把最近一次点击前的页面地址还原回去（详见 navStack 说明）。
   * 返回是否真的退了一步。找不到可还原的记录时返回 false，由原生层接管（回直播）。
   */
  function back() {
    var guard = 0;
    while (navStack.length && guard < 12) {
      guard++;
      var top = navStack.pop();
      try {
        var cur = top.win.location.href;
        if (cur === top.url) continue;     // 这次点击没有产生跳转，跳过这条噪音记录
        top.win.location.href = top.url;   // 还原到「点击前那一屏」
        reportDepth();
        return true;
      } catch (e) {}                        // 跨域/已失效的 window：跳过，继续往下找
    }
    reportDepth();
    return false;
  }

  // ── 诊断与自愈（v1.3.0）───────────────────────────────────

  /**
   * 往原生层上报一条信息。
   * 通道就用 console.log：WebView 会把网页的 console 消息回调给 App（onConsoleMessage），
   * 这是最省事、且在老 WebView 上也稳定的单向通道（不必额外挂 JavascriptInterface 桥）。
   */
  function report(kind, msg) {
    try { console.log('__TVNAV__ ' + kind + ' ' + msg); } catch (e) {}
  }

  /**
   * 「工作空间已停止」占位页检测（v1.4.4）。
   *
   * 现象（用户 2026-10-13 截图）：偶发整屏一张云沙箱错误页 ——
   *   「工作空间已停止 / 数据已保留，可点击下方按钮重新启动 / 错误码：12809 /
   *     SandboxId:… / TraceId:… / 立即启动 / 返回 Dashboard」，顶部伴着 dodotv20.com 字体 CORS 报错。
   * 定性：**不是播放器问题**，而是回放站（或其宿主云工作空间）空闲被停后返回的占位页，
   *   重启/重载即可恢复（实测后端 /api/config 此刻正常，属间歇性休眠）。
   * 处理：① 上报给原生层，触发自动重载唤醒；② 顺手点一下「立即启动」按钮（若有），一键唤醒。
   *
   * 返回 true 表示「当前就是停止页」，调用方据此跳过红点初始化与播放自愈。
   */
  function handleStoppedPage() {
    var txt = '';
    try { txt = (document.body && (document.body.innerText || document.body.textContent)) || ''; } catch (e) { txt = ''; }
    if (!txt || txt.indexOf('工作空间已停止') < 0) return false;

    report('stopped', '宿主机工作空间已停止（云沙箱空闲被停），尝试唤醒');
    try {
      var els = document.querySelectorAll('button,a,div,span');
      for (var i = 0; i < els.length && i < 600; i++) {
        var t = (els[i].textContent || '').replace(/\s+/g, '');
        if (t === '立即启动' || t === '启动' || t === '重新启动') { try { els[i].click(); } catch (e) {} break; }
      }
    } catch (e) {}
    return true;
  }

  /**
   * 本机播放能力摘要。
   * 「黑屏」到底是不是「这台设备根本播不了」造成的，看这一行就能分辨：
   *   mse=no        → 没有 MediaSource，基于 MSE 的播放器（hls.js 一类）必然初始化失败
   *   nativeHls=no  → WebView 不支持原生 HLS，而页面又没带自己的 hls 库 → 同样播不了
   */
  function caps() {
    var v = document.createElement('video');
    function can(t) { try { return v.canPlayType(t) ? 'yes' : 'no'; } catch (e) { return '?'; } }
    var hasMse = (typeof window.MediaSource !== 'undefined') || (typeof window.WebKitMediaSource !== 'undefined');
    // 内核版本：这是「回放站自己的播放器脚本为什么跑不起来」的第一手证据 ——
    // 站点用了 Artplayer / hls.js 这类新库，内核太旧（例如电视盒子上多年没更新的 WebView）
    // 会直接语法报错，页面里就永远建不出播放器。有了这一行，一眼就能分辨是「设备能力」还是「我们代码」。
    var ua = navigator.userAgent || '';
    var m = ua.match(/Chrome\/([0-9]+)/);
    return 'mse=' + (hasMse ? 'yes' : 'no') +
           ' nativeHls=' + can('application/vnd.apple.mpegurl') +
           ' mp4=' + can('video/mp4') +
           ' hlsLib=' + (window.Hls ? 'yes' : 'no') +
           ' kernel=' + (m ? ('Chrome/' + m[1]) : '?');
  }

  /**
   * 「页面里的视频到底怎么了」——把三种完全不同的情况分开说，避免一句笼统的「找不到 video」误导排查：
   *   · 真的没有 video 元素          → 站点脚本根本没建出播放器（多半是内核太旧 / 依赖没加载）
   *   · 有 video 但全部被隐藏/0×0    → 播放器建出来了，只是没显示（广告遮罩没放开之类）
   *   · 有可见 video 但没在播        → 建出来了、也在屏幕上，只是卡在暂停/加载中
   * 之前只报「找不到 video 元素」，而实际上播放器是建在 iframe 里、被广告盖着的，
   * 这句提示把排查带偏过一次（用户 2026-10-13 截图）。
   */
  function videoDiag() {
    var st = videoStats(document, 0, { total: 0, hidden: 0, visible: 0 });
    if (st.total === 0) return '页面里没有 video 元素（站点播放器没建出来）';
    if (st.visible === 0) return '有 ' + st.total + ' 个 video 但全部没显示（被隐藏或尺寸为 0）';
    return '有 ' + st.visible + ' 个可见的 video，但都还没开始播（暂停或缓冲中）';
  }

  /** 递归统计（含同源 iframe）video 总数 / 隐藏数 / 可见数 */
  function videoStats(doc, depth, acc) {
    if (!doc || depth > MAX_DEPTH) return acc;
    var vs = doc.getElementsByTagName('video');
    for (var i = 0; i < vs.length; i++) {
      acc.total++;
      if (visible(vs[i])) acc.visible++; else acc.hidden++;
    }
    var fs = doc.getElementsByTagName('iframe');
    for (var j = 0; j < fs.length; j++) {
      var idoc = null;
      try { idoc = fs[j].contentDocument; } catch (e) { idoc = null; }
      if (idoc) videoStats(idoc, depth + 1, acc);
    }
    return acc;
  }

  /** 在文档（含同源 iframe 递归）里找第一个「看得见」的 video */
  function firstVideo(doc, depth) {
    if (!doc || depth > MAX_DEPTH) return null;
    var vs = doc.getElementsByTagName('video');
    for (var i = 0; i < vs.length; i++) { if (visible(vs[i])) return vs[i]; }
    var fs = doc.getElementsByTagName('iframe');
    for (var j = 0; j < fs.length; j++) {
      var idoc = null;
      try { idoc = fs[j].contentDocument; } catch (e) { idoc = null; }
      if (!idoc) continue;
      var r = firstVideo(idoc, depth + 1);
      if (r) return r;
    }
    return null;
  }

  // 自愈窗口：只在这段时间内动手。之后再干预就是添乱（用户这时多半已经在正常操作了）。
  var WATCH_MS = 20000;
  var bornAt = Date.now();
  var playKicked = false;    // 是否已替用户按过一次「播放」
  var noVideoTold = false;   // 是否已上报过「页面里没有视频」
  var errTold = false;       // 是否已上报过视频错误
  var watchTimer = null;

  /**
   * 黑屏自愈巡检。每次只做一件事，且每件事最多做一次：
   *   · video 报了错      → 上报（电视上这类错误几乎必定是设备解码能力，或流地址不可达）
   *   · 存在 video 却在暂停 → 替用户 play() 一次（播放器常因「未获得用户手势」停在首帧黑屏）
   *   · 起播 8 秒后仍无 video → 上报（播放器整块没渲染出来，多半是页面脚本初始化失败）
   */
  function watchdog() {
    var t = Date.now() - bornAt;
    if (t > WATCH_MS) { if (watchTimer) clearInterval(watchTimer); return; }

    var v = firstVideo(document, 0);
    if (v) {
      if (v.error) {
        if (!errTold) { errTold = true; report('video', '播放出错 code=' + v.error.code + ' ' + (v.error.message || '')); }
        return;
      }
      if (v.paused && !playKicked) {
        playKicked = true;
        try {
          var pr = v.play();
          // play() 返回 Promise：被浏览器策略拒绝时，只有 catch 里才看得到原因 ——
          // 不接住它就是「静默失败」，这正是黑屏问题一直查不出来的原因。
          if (pr && pr.catch) pr.catch(function (e) { report('video', '自动播放被拒：' + ((e && e.name) || e)); });
        } catch (e) {}
      }
      return;
    }
    if (t > 8000 && !noVideoTold) {
      noVideoTold = true;
      // 用 videoDiag() 把「真没有 video」与「有 video 但被藏着/没在播」分开上报 ——
      // 之前那句笼统的「找不到 video 元素」曾把排查方向带偏（v1.3.0 的教训）。
      report('video', videoDiag());
    }
  }

  // ── 初始化 ───────────────────────────────────────────────

  /** 把红点放回屏幕中央；页面里（含同源 iframe 内）已有视频时，直接落在视频中心（进来最想点的就是它） */
  function reset() {
    cx = Math.round(vw() / 2);
    cy = Math.round(vh() / 2);
    var vc = findVideoCenter(document, 0, 0, 0);
    if (vc) { cx = Math.round(vc.x); cy = Math.round(vc.y); }
    cx = clamp(cx, HARD, vw() - HARD);   // 视频可能有一部分在屏幕外，坐标要夹回视口
    cy = clamp(cy, HARD, vh() - HARD);
    hovered = null;
    paint();
  }

  /**
   * 在原位重做一次「夹取 + 命中测试 + 重绘」（v1.4.4）。
   * 与 reset() 的区别：**不把红点挪回屏幕中央/视频中心**，只让它与当前布局重新对齐。
   * 用途：进/出全屏、系统栏显隐等改变了 WebView 视口大小后，由原生层主动调用，
   * 让红点位置与提示文字立刻跟上新布局（修「全屏返回后定位不准」）。
   */
  function repaint() {
    cx = clamp(cx, HARD, vw() - HARD);
    cy = clamp(cy, HARD, vh() - HARD);
    hovered = null;   // 强制重发一次 mouseover 并刷新提示文字
    paint();
  }

  // 视口尺寸变化（进/出全屏、旋转）后把红点夹回可见范围，否则它会留在屏幕外「消失」。
  // 用具名函数（而非匿名）保存引用，dispose() 时才能准确摘除监听器。
  function onResize() {
    cx = clamp(cx, HARD, vw() - HARD);
    cy = clamp(cy, HARD, vh() - HARD);
    paint();
    // v1.4.4：视口变化后页面通常还会再重排一次（如 56.25vw 的播放器高度跟着宽度走）。
    // 立即 paint 读到的可能还是**旧布局** → 提示文字与实际元素对不上，表现为
    // 「看着点的是这里、实际点到别处」。延迟再重绘一次，等布局稳定后刷新命中测试。
    setTimeout(paint, 320);
  }
  window.addEventListener('resize', onResize, false);

  // 暴露给原生层调用
  window.__tvNav = {
    version: $VERSION,
    paint: paint,
    reset: reset,
    repaint: repaint,           // v1.4.4：视口变化后原位重对齐（不挪回中心）
    back: back,                 // v1.4.4：回看页「后退一步」（还原到上次点击前的画面）
    // 自清理：停巡检定时器、摘掉 resize 监听器（供新版本脚本注入前清理旧实例，防新旧脚本打架）
    dispose: function () {
      try { if (watchTimer) clearInterval(watchTimer); } catch (e) {}
      try { window.removeEventListener('resize', onResize, false); } catch (e) {}
    },
    // 调试/自动化验证用：返回「当前位置下面的元素」的描述
    hit: function () {
      var p = pick(cx, cy);
      if (!p || !p.el) return '';
      return (p.el.id || p.el.tagName || '') + '|' + describe(p.el);
    },
    // 调试/自动化验证用：返回红点当前坐标
    pos: function () { return { x: cx, y: cy }; },
    // 调试/自动化验证用：返回本机播放能力 + 当前页面是否有可见视频
    diag: function () { return caps() + ' video=' + (firstVideo(document, 0) ? 'yes' : 'no'); },
    // 调试/自动化验证用：立刻跑一次自愈巡检（正式运行时由定时器驱动）
    watchOnce: function () { watchdog(); },
    key: function (code) {
      if (code === 19) return move('up');
      if (code === 20) return move('down');
      if (code === 21) return move('left');
      if (code === 22) return move('right');
      if (code === 23 || code === 66) return enter();
      return false;
    }
  };

  // 先判是不是「工作空间已停止」占位页：是的话不摆红点、不开巡检，交给原生层重载唤醒。
  if (!handleStoppedPage()) {
    reset();                          // 注入后立即把红点摆好，用户一进页面就能看见
    report('caps', caps());           // 上报本机播放能力：黑屏时原生层据此判断「是不是设备根本播不了」
    reportDepth();                    // 上报后退栈深度（初始 0 → 原生层知道「网页里暂时退不了」）
    watchTimer = setInterval(watchdog, 2500);   // 启动黑屏自愈巡检（20 秒后自行停止）
  }

  // 页面即将卸载 → 停掉巡检，免得定时器继续在旧页面上跑
  window.addEventListener('unload', function () { if (watchTimer) clearInterval(watchTimer); }, false);
})();
""".trimIndent()
}
