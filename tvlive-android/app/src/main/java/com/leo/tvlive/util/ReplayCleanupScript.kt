package com.leo.tvlive.util

/**
 * 回放页「去广告 + 重排」注入脚本（v1.4.3）。
 *
 * ── 为什么要它 ─────────────────────────────────────────────
 * 用户 2026-10-13 反馈两件事：
 *   1) 进到播放页（详情页 shplay.php）后「🔴红点没了、没法往下滚、看不到下面的内容」；
 *   2) 想把页面里的广告全去掉，只留播放器和播放列表。
 *
 * 抓取真实详情页（tools/probe_out/play_embed.html）后确认页面结构：
 *   · 顶部一大块广告：<div class="anchor_banner"><div class="banners_area"> 里全是
 *     <a class="banner_" href=".../index/banner_click?id=..."> 赌博/博彩外链
 *     （jusobook1.com、happytoto24.com、7st-333.com、dafs105.com、no1-789.com、neotvsports.com…）；
 *   · 左侧栏 .t-p-side 里也塞了一排 <a class="banner_"> 广告；
 *   · 播放器是 <iframe id="view_iframe" class="video-frame">（在 .play-box-main 里）；
 *   · 播放列表是 .play-box-side-main（右侧栏，自带内部滚动 852>465）；
 *   · 播放器上方还盖着一个广告 iframe <iframe id="adFrame" class="ad-frame"
 *     src="https://www.dodotv20.com/ad/index.html">——它若加载卡住，会拖住主文档的
 *     load 事件，使 App 的 onPageFinished 迟迟不触发，红点注入被延迟（这正解释了「红点没了」）；
 *   · 播放器行下方还有「추천비디오」推荐区和翻页——用户想看到的「下面的内容」。
 *
 * 也就是说：播放页是个「播放器 + 右侧播放列表 + 下方推荐 + 满屏广告」的复杂嵌套布局，
 * 红点的边缘滚动够不到真正的滚动容器，且广告 iframe 拖慢了注入时机。
 *
 * ── 本脚本做什么 ───────────────────────────────────────────
 * 在回放页（列表页 / 详情页都生效，因为广告两处都有）注入后：
 *   ① 立刻删掉所有广告 DOM：#adFrame、.anchor_banner、.banners_area、所有 a.banner_；
 *   ② 仅在「有播放器」的详情页上，隐藏左侧栏 .t-p-side（用户要的「只留播放器+播放列表」，
 *      且把横向空间让给播放器），并把页面重排成【播放器在上、播放列表+推荐在下】的
 *      单列、整体可滚动布局——这样红点贴边滚动就能一路把下方内容滚出来；
 *   ③ 用 MutationObserver + 10 秒内的定时兜底，反复清理「延迟注入」的广告
 *      （广告脚本常在页面 load 之后才把 banner 塞进来，只清一次会漏）；
 *   ④ 绝不碰红点光标自己（__tvnav_dot / __tvnav_tip），也不删播放器/播放列表/推荐区。
 *
 * ── 与 Kotlin 侧的约定 ─────────────────────────────────────
 * · 暴露 window.__tvClean = { version, clean }，供 MainActivity 的红点心跳判断「清理脚本是否还在」；
 * · 不依赖任何外部库，纯 ES5（兼容老电视盒子 WebView）。
 */
object ReplayCleanupScript {

    /** 脚本版本：改动逻辑必须递增，否则已加载页面不会更新（短路由直接 return） */
    private const val VERSION = 2

    /** 待注入的脚本源码（严格 ES5：不用箭头函数 / let / const / 模板字符串） */
    val JS: String = """
(function () {
  var V = $VERSION;
  // 同版本已注入过：只保留观察者（它一直在跑），不重复挂样式/定时器
  if (window.__tvClean && window.__tvClean.version === V) { return; }

  /**
   * 把重排用的 CSS 写进一个固定 id 的 <style>。
   * ⚠️ 关键：textContent 只在「元素首次创建」时赋值。
   *    若每次 clean() 都对已存在的 style 重设 textContent，会触发 childList 突变 →
   *    MutationObserver（观察 subtree childList）回调 → 再调 clean() → 再重设 textContent …
   *    形成永不停歇的微任务循环，把主线程钉死，导致页面卡死 / evaluate 超时。
   *    所以：已存在就绝不再碰它的内容。
   */
  function addStyle(css) {
    try {
      var s = document.getElementById('__tvclean_style');
      if (!s) {
        s = document.createElement('style');
        s.id = '__tvclean_style';
        s.textContent = css;
        (document.head || document.documentElement).appendChild(s);
      }
    } catch (e) {}
  }

  /** 一次性清理：移除广告节点（幂等，多跑无害） */
  function clean() {
    // ① 广告 iframe：盖在播放器上方的 #adFrame，直接摘掉
    try {
      var ad = document.getElementById('adFrame');
      if (ad && ad.parentNode) ad.parentNode.removeChild(ad);
    } catch (e) {}

    // ② 顶部广告块 + 侧边/正文里所有 <a class="banner_"> 广告链接
    //    .anchor_banner 是顶部整块广告的容器，删它等于删掉整块；.banner_ 是具体广告链。
    try {
      var ads = document.querySelectorAll('.anchor_banner, .banners_area, .ad-frame, a.banner_, .banner_');
      for (var i = 0; i < ads.length; i++) {
        var n = ads[i];
        if (n && n.parentNode) n.parentNode.removeChild(n);
      }
    } catch (e) {}

    // ③ 仅详情页（存在播放器 .play-box）才隐藏左侧栏、并做单列重排
    var hasPlayer = false;
    try { hasPlayer = !!document.querySelector('.play-box'); } catch (e) {}
    if (hasPlayer) {
      // 隐藏左侧栏菜单+广告，把整屏宽度让给播放器（用户要「只留播放器+播放列表」）
      try {
        var side = document.querySelector('.t-p-side');
        if (side) side.style.display = 'none';
      } catch (e) {}
      // 重排为「播放器在上、播放列表+推荐在下」的单列、整体可滚动布局：
      //   · 放开 html/body 的高度与 overflow，让整页能滚（红点贴边滚动才能生效）；
      //   · .play-box / .play-box-main / .play-box-side 全部改成块级、宽度 100%；
      //   · 播放器 iframe 给一个 16:9 的具体高度（否则 height:100% 套在 auto 高度父级上会塌成 0）；
      //   · 播放列表 .play-box-side-main 取消内部固定高度与隐藏滚动，让它顺着页面自然展开。
      addStyle(
        'html,body{height:auto !important;min-height:0 !important;overflow:auto !important;overflow-x:hidden !important;}' +
        '.t-p{display:block !important;height:auto !important;}' +
        '.play-box{display:block !important;width:100% !important;}' +
        '.play-box-main{width:100% !important;height:auto !important;}' +
        '#view_iframe.video-frame{width:100% !important;height:56.25vw !important;max-height:100vh !important;min-height:300px !important;display:block !important;background:#000;}' +
        '.play-box-side{display:block !important;width:100% !important;height:auto !important;}' +
        '.play-box-side-main{width:100% !important;height:auto !important;max-height:none !important;overflow:visible !important;}' +
        '.t-p-side{display:none !important;}' +
        '#adFrame{display:none !important;}'
      );
    }
  }

  // 立即清一次（页面初载时广告多半已在内联 HTML 里）
  clean();

  // 10 秒内每 1 秒再清一次：广告脚本常在 load 之后才把 banner 塞进来，只清一次会漏
  var timer = setInterval(clean, 1000);
  setTimeout(function () { try { clearInterval(timer); } catch (e) {} }, 10000);

  // MutationObserver：DOM 一旦被广告脚本改动，立刻补清（比定时更及时）
  try {
    var obs = new MutationObserver(function () { clean(); });
    obs.observe(document.documentElement, { childList: true, subtree: true });
  } catch (e) {}

  // 暴露给原生层：红点心跳据此判断「清理脚本是否还在」
  window.__tvClean = { version: V, clean: clean };
})();
""".trimIndent()
}
