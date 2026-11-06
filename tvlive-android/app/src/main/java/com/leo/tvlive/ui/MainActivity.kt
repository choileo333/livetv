package com.leo.tvlive.ui

import android.annotation.SuppressLint
import android.content.Context
import java.io.ByteArrayInputStream
import android.graphics.Bitmap
import android.graphics.Color
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.LayerDrawable
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.text.InputType
import android.util.Log
import android.view.KeyEvent
import android.view.View
import android.view.ViewGroup
import android.view.inputmethod.InputMethodManager
import android.webkit.ConsoleMessage
import android.webkit.RenderProcessGoneDetail
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import androidx.appcompat.app.AlertDialog
import androidx.appcompat.app.AppCompatActivity
import androidx.core.content.ContextCompat
import androidx.core.view.WindowInsetsCompat
import androidx.core.view.WindowInsetsControllerCompat
import androidx.media3.ui.PlayerView
import androidx.recyclerview.widget.LinearLayoutManager
import androidx.recyclerview.widget.RecyclerView
import com.leo.tvlive.BuildConfig
import com.leo.tvlive.R
import com.leo.tvlive.data.Backend
import com.leo.tvlive.data.Channel
import com.leo.tvlive.data.ChannelRepo
import com.leo.tvlive.data.MimeHint
import com.leo.tvlive.data.Prefs
import com.leo.tvlive.player.LivePlayer
import com.leo.tvlive.util.DeviceUtil
import com.leo.tvlive.util.ReplayCleanupScript
import com.leo.tvlive.util.ReplayRescueScript
import com.leo.tvlive.util.TvNavScript

/**
 * 主界面：手机与电视共用一套逻辑，按设备形态分流交互。
 *
 * 手机（竖屏）：列表页 ⇄ 播放页 两级页面切换
 * 电视（横屏）：左侧列表 + 右侧播放区 常驻同屏，遥控器方向键导航
 *
 * 播放路径：
 *   直播 → ExoPlayer 播放「中继地址」（必须经服务端中继，否则多数频道因地域封锁打不开）
 *   回放 → WebView 打开后端内嵌代理页面（服务端补 Referer + 注入播放器补丁，网页版已验证可播）
 */
class MainActivity : AppCompatActivity() {

    private companion object {
        const val MODE_LIVE = 0          // 直播模式
        const val MODE_REPLAY = 1        // 回放模式
        const val GROUP_ALL = "全部"      // 分组筛选中的「全部」标识
        const val DIGIT_TIMEOUT = 900L   // 遥控器数字键缓冲时长（毫秒）
        /**
         * 回放页里「按住确定键多久算长按」（毫秒）。
         * 取得比系统默认的长按时间（500ms）略长一点：回放页操作需要频繁点按，
         * 阈值太短会把「手慢一点的单击」误判成长按，导致莫名其妙地切了全屏。
         */
        const val OK_LONG_PRESS_MS = 700L

        /** 回放页诊断在内存里最多保留多少条（v1.4.0 起会一并显示总条数，便于判断是不是连环故障） */
        const val DIAG_MAX = 6
        /**
         * 网页内核低于这个大版本就认为「老到可能跑不动站点的新式播放器」（Chrome 60 ≈ 2017 年）。
         * 站点播放器用的是 Artplayer + hls.js 这类新库，内核过旧会直接语法报错 ——
         * 表现就是「手机正常、电视黑屏」，而且页面里连 video 元素都建不出来。
         */
        const val OLD_KERNEL_MAX = 60
        /**
         * 站点「反调试」脚本的地址特征。回放站的详情页与播放器页都挂了这类脚本，
         * 它一旦误判就把整个页面清成 about:blank —— 是「点进具体视频就黑屏」的头号嫌疑，
         * 而它对用户毫无价值（用户根本不在用开发者工具），故一律拦掉。
         */
        val ANTI_DEBUG_RE = Regex("disable-devtool|disable_devtool|disabledev|devtools-detector", RegexOption.IGNORE_CASE)
        /**
         * 站点「反调试」把人「踢走」时跳的错误页。
         *
         * 回放站的播放器页(onet.php)里还有一段 inline 的 toDevtools()：
         *   console.log('', devtools)  // devtools 带自定义 toString，被序列化两次就…
         *   → window.location.href = "error0.html"
         * inline 脚本拦不掉（它写在 HTML 里，不是独立文件），但**它跳走的这个地址**我们能拦。
         * 用户根本不需要那个写着错误的空白页 —— 留在播放页本身，我们的兜底才可能救回来。
         */
        val ERROR_PAGE_RE = Regex("error0\\.html|live_error\\.html|/error\\d*\\.html", RegexOption.IGNORE_CASE)
        /**
         * 站点广告资源特征（v1.4.3 新增）。
         * 详情页有个盖在播放器上的广告 iframe（#adFrame → dodotv20.com/ad/index.html），
         * 它若加载卡住会拖住主文档的 load 事件，使 onPageFinished 迟迟不触发、红点注入被延迟
         * —— 这正解释了「进播放页后红点没了」。这里把广告类请求直接拦成空响应：
         *   · 既去广告（与 ReplayCleanupScript 的 DOM 清理形成双保险），
         *   · 又让 onPageFinished 及时触发，红点得以尽早出现。
         * 命中项：广告页路径 /ad/、广告点击跳转 banner_click、广告图床 xiaoca.top/sj/。
         * 注意：这些只会出现在「子资源 / 广告链接」的 URL 里，不会误伤主文档（/api/embed?url=…）。
         */
        val AD_RE = Regex("dodotv20\\.com/ad/|/ad/|banner_click|xiaoca\\.top/sj/", RegexOption.IGNORE_CASE)
        /** 注入脚本用 console.log 主动上报诊断时使用的前缀（与 TvNavScript.report 保持一致） */
        const val DIAG_PREFIX = "__TVNAV__"
        /** 回放站兜底地址：后端没下发 replayUrl 时使用，保证回放功能不至于是空的 */
        const val DEFAULT_REPLAY = "https://www.dodotv20.com/show.php?tid=3&order_type="
        /**
         * 回放页操作提示文案。
         * 页面重载成功后会把它恢复上去 —— 否则上一次的诊断文字会一直留在屏幕上误导用户。
         * 必须与两套布局里 tv_replay_hint 的 android:text 保持一致。
         */
        const val REPLAY_HINT_TEXT = "方向键移红点（贴边滚动）· 确定=点击 · 长按确定=全屏 · 返回=后退/回直播"

        /** 主题红：当前选中状态（当前模式 / 当前分组）的底色 */
        val COLOR_ACCENT = 0xFFE53935.toInt()
        /** 仅「获得焦点但未选中」时的底色 —— 电视端必须让用户看得到光标位置 */
        val COLOR_FOCUS_BG = 0xFF3A3A3A.toInt()
        /** 次要文字色（未选中、未聚焦时使用） */
        val COLOR_DIM = 0xFF9AA0A6.toInt()
        /**
         * 焦点细框颜色（纯白）。
         * 用户真机反馈「看不出现在选的是哪里」，故在原有底色变化之外，
         * 再统一加一圈 2dp 亮色描边 —— 白框在任何底色（含红底选中态）上都清晰可见。
         */
        val COLOR_RING = 0xFFFFFFFF.toInt()
        /** 焦点细框宽度（dp） —— 用户明确要求「细框」 */
        val RING_WIDTH_DP = 2
    }

    // ── 视图引用 ──────────────────────────────────────────────
    private lateinit var panelList: View              // 列表页容器
    private lateinit var panelPlayer: View            // 播放页容器
    private lateinit var recycler: RecyclerView       // 频道列表
    private lateinit var playerView: PlayerView       // 直播画面控件
    private lateinit var webView: WebView             // 回放网页控件
    private lateinit var tvStatus: TextView           // 状态提示行
    private lateinit var tvNowPlaying: TextView       // 当前播放名称
    private lateinit var tvAppTitle: TextView         // 标题（含版本号）
    private lateinit var tabLive: TextView            // 「直播」切换钮
    private lateinit var tabReplay: TextView          // 「回放」切换钮
    private lateinit var groupContainer: LinearLayout // 分组筛选条容器
    private lateinit var fullscreenContainer: FrameLayout // 网页全屏容器
    private lateinit var btnFav: TextView             // 收藏按钮
    private lateinit var btnBackend: TextView         // 后端设置入口
    private lateinit var btnPlayerBack: TextView      // 播放页返回
    private lateinit var btnReload: TextView          // 重载/重连
    private lateinit var playerTopBar: View           // 播放页顶栏（全屏时整条隐藏）
    private lateinit var liveControls: LinearLayout   // 画面上自绘的控制条（v1.1.0 起只剩「全屏」）
    private lateinit var btnCtrlFull: TextView        // 控制条：全屏 / 退出全屏
    private lateinit var tvReplayHint: TextView       // 回放页操作提示条
    private lateinit var playerHost: FrameLayout      // 播放区容器（网页渲染进程崩溃时用来原地重建 WebView）

    // ── 运行时状态 ────────────────────────────────────────────
    private lateinit var player: LivePlayer
    private lateinit var adapter: ChannelAdapter

    private var isTv = false                          // 是否电视形态
    private var mode = MODE_LIVE                      // 当前模式
    private var allChannels: List<Channel> = emptyList()    // 全部频道
    private var shownChannels: List<Channel> = emptyList()  // 当前展示（过滤后）
    private var curGroup = GROUP_ALL                  // 当前分组
    private var curChannel: Channel? = null           // 当前频道
    private var replayUrl = ""                        // 回放站地址（从后端取，失败用兜底）
    private var webViewLoaded = false                 // 回放页是否已加载过（避免重复加载）
    private var customViewCallback: WebChromeClient.CustomViewCallback? = null
    private var isFullscreen = false                  // 是否处于全屏（隐藏列表与顶栏，沉浸式）
    // 注：v1.1.0 起画面上不再有「播放/暂停」「静音」两个按钮（用户明确要求只留全屏），
    //     故此处的 muted 状态与配套的按钮文字同步逻辑一并移除，避免留下永远不会被触发的死代码。

    private val handler = Handler(Looper.getMainLooper())
    private val digitBuf = StringBuilder()            // 遥控器数字键缓冲

    // ── 回放页诊断（v1.3.0）──────────────────────────────────────
    // 背景（用户 2026-10-12 反馈）：电视上回放页点进具体视频后「一直黑屏、连播放按钮都不出现」，
    // 而同样的页面在手机上正常。排查时最大的障碍是 —— App 对网页里发生的事**完全不知情**：
    // JS 报错、资源加载失败、渲染进程被系统回收，全部被静默吞掉，用户只能看到一块黑屏。
    // 这正是「没有报错 ≠ 没有故障」的典型场景，故这里把这些统统记下来并回显：
    //   · JS 错误 / 注入脚本主动上报 → onConsoleMessage
    //   · 主文档与子资源加载失败      → onReceivedError / onReceivedHttpError
    //   · 网页渲染进程被系统回收      → onRenderProcessGone（老电视盒子上极常见，现象就是突然全黑）
    private val webDiag = ArrayList<String>()         // 最近若干条诊断（最多 DIAG_MAX 条）
    private var webCapsText = ""                      // 网页上报的本机播放能力摘要（MSE / 原生 HLS / 内核版本…）
    private var aboutBlankReloaded = false            // 页面被反调试脚本清空后是否已自动重载过一次（防死循环）
    private var hostStoppedRetries = 0                // 宿主机「工作空间已停止」自动唤醒重试次数（v1.4.4，限次防死循环）
    private var webNavDepth = 0                       // 网页内部「可后退步数」（v1.4.4，由注入脚本 report('nav') 上报）
    // ── v1.4.0 诊断显示策略 ──
    // 「哪条最该显示」：JS 异常与「自建播放失败」这类确定性错误，比泛泛的现象描述更接近根因，优先显示。
    private val SEVERE_RE = Regex(
        "SyntaxError|ReferenceError|TypeError|NotSupportedError|RangeError|" +
        "无法自建播放|自建播放失败|hls 致命错误|加载失败|播放出错|能力不足|内核过旧|网页引擎重启|请求被拒|网页打不开"
    )

    // ── 回放页「长按确定键 = 切换全屏」的计时（遥控器方向键被网页接管，全屏按钮无法用遥控器聚焦，
    //    故用长按确定键作为替代入口；详见 dispatchKeyEvent 的注释）────────────
    private var okLongPressFired = false              // 本次确定键是否已按「长按」处理过
    private val okLongPressTask = Runnable {
        okLongPressFired = true                       // 标记：本次按键已升级为长按
        toggleFullscreen()                            // 长按动作：切换全屏
    }

    // ── 电视端焦点相关状态 ────────────────────────────────────
    private var firstChipId = View.NO_ID              // 第一个分组按钮的 id（供上下方向键精确指向）
    private val chipViews = ArrayList<TextView>()     // 分组按钮集合（用于只刷新样式、不重建视图，避免焦点丢失）

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        isTv = DeviceUtil.isTelevision(this)   // 判定设备形态（决定页面切换方式）
        bindViews()
        setupPlayer()
        setupWebView()
        setupList()
        setupClicks()
        setupTabs()
        setupFocusVisuals()   // 电视端：让所有按钮都能被遥控器选中且焦点可见

        // 电视：播放区常驻；手机：初始只显示列表页
        panelPlayer.visibility = if (isTv) View.VISIBLE else View.GONE
        panelList.visibility = View.VISIBLE

        updateControlsForMode()   // 初始化「回放操作提示条」的可见性

        loadData()   // 拉取频道与配置

        // v1.4.3：启动红点心跳（回放模式下周期补注入红点光标/清理脚本，防「进播放页红点没了」）
        handler.postDelayed(navHeartbeat, 1200)
    }

    // ══════════════════ 初始化 ══════════════════

    /** 绑定所有控件引用（注意：手机与横屏两套布局的 id 完全一致，故此处无需区分） */
    private fun bindViews() {
        panelList = findViewById(R.id.panel_list)
        panelPlayer = findViewById(R.id.panel_player)
        recycler = findViewById(R.id.recycler_channels)
        playerView = findViewById(R.id.player_view)
        webView = findViewById(R.id.webview)
        playerHost = findViewById(R.id.player_host)
        tvStatus = findViewById(R.id.tv_status)
        tvNowPlaying = findViewById(R.id.tv_now_playing)
        tvAppTitle = findViewById(R.id.tv_app_title)
        tabLive = findViewById(R.id.tab_live)
        tabReplay = findViewById(R.id.tab_replay)
        groupContainer = findViewById(R.id.group_container)
        fullscreenContainer = findViewById(R.id.fullscreen_container)
        btnFav = findViewById(R.id.btn_fav)
        btnBackend = findViewById(R.id.btn_backend)
        btnPlayerBack = findViewById(R.id.btn_player_back)
        btnReload = findViewById(R.id.btn_reload)
        playerTopBar = findViewById(R.id.player_topbar)
        liveControls = findViewById(R.id.live_controls)
        btnCtrlFull = findViewById(R.id.btn_ctrl_full)
        tvReplayHint = findViewById(R.id.tv_replay_hint)

        // 标题带上版本号（版本可见，便于区分设备上装的是哪一版）
        tvAppTitle.text = "TvLive 直播 v${BuildConfig.VERSION_NAME}"
    }

    /** 初始化播放器 */
    private fun setupPlayer() {
        player = LivePlayer(this) { errName ->
            // 播放错误反馈到状态行：直播失败最常见的原因是源站不可达或被拒
            tvStatus.text = "播放出错（$errName），可点 ⟳ 重连或换台"
        }
        playerView.player = player.exo   // 把播放器实例交给 PlayerView 渲染
        playerView.keepScreenOn = true   // 播放期间屏幕常亮
        syncControlLabels()              // 初始化控制条上的文字
    }

    /** 同步自绘控制条上的文字，使其反映播放器真实状态 */
    private fun syncControlLabels() {
        // v1.1.0 起控制条只剩「全屏 / 退出全屏」一个按钮，故这里只需同步它的文案
        btnCtrlFull.text = if (isFullscreen) "退出全屏" else "全屏"
    }

    /** 初始化 WebView（用于回放页面） */
    @SuppressLint("SetJavaScriptEnabled")
    private fun setupWebView() {
        webView.settings.apply {
            javaScriptEnabled = true                                  // 回放站页面依赖 JS
            domStorageEnabled = true                                  // 部分播放器用 localStorage
            mediaPlaybackRequiresUserGesture = false                  // 允许无手势自动播放
            mixedContentMode = WebSettings.MIXED_CONTENT_ALWAYS_ALLOW // 允许 https 页面内加载 http 资源
            loadWithOverviewMode = true
            useWideViewPort = true
            // ── 为什么必须关缓存（v1.4.0 排查中踩到的坑）──
            // 反调试脚本一旦进了 WebView 的 HTTP 缓存，**缓存命中不会产生网络请求**，
            // shouldInterceptRequest 就不再被回调 —— 拦截就变成「第一次管用、之后时灵时不灵」，
            // 这正是「同一步操作有时黑屏有时不黑」这类最难查的故障。
            // 回放页的流量本来就不适合缓存（列表页/播放页是动态的，HLS 分片是一次性的），关掉代价极小。
            cacheMode = WebSettings.LOAD_NO_CACHE
        }

        // 电视端：让遥控器方向键能「走进」网页（否则焦点只能停在左侧列表，网页里的按钮点不到）
        webView.isFocusable = true
        webView.isFocusableInTouchMode = true

        webView.webViewClient = object : WebViewClient() {
            // ── 反调试脚本拦截（v1.4.0 的关键修复）──
            // 回放站的详情页与播放器页都挂了「反调试」脚本（<script disable-devtool-auto src=".../disable-devtool@latest">
            // 与 /mediaframe/disabledev2.js）。它一旦认为自己被开发者工具盯着，就会**把整个页面清成 about:blank**。
            // 在电视盒子的 WebView 上它会误判（WebView 的 console 通道行为与桌面控制台不同），
            // 现象正是用户报的「点进具体视频后整块黑屏、连播放按钮都没有」—— 我们已经用无头浏览器复现过：
            // 打开详情页几秒后文档地址变成 about:blank，控制台留下 `You don't have permission to use DEVTOOL!`。
            //
            // 这段「保护」对用户毫无价值（用户根本不在用开发者工具），却能把播放页整页干掉，
            // 所以直接拦掉：命中这类地址就返回一段空 JS，脚本等于不存在。
            override fun shouldInterceptRequest(
                view: WebView?, request: WebResourceRequest?
            ): WebResourceResponse? {
                val u = request?.url?.toString() ?: return null
                if (ANTI_DEBUG_RE.containsMatchIn(u)) {
                    return WebResourceResponse(
                        "application/javascript", "utf-8", ByteArrayInputStream(ByteArray(0))
                    )
                }
                // ── 广告资源屏蔽（v1.4.3）──
                // 同上思路：命中广告类地址就返回空响应，等于「这个请求不存在」。
                // 既能去掉广告，又能避免广告 iframe 卡住主文档 load、拖慢红点注入时机。
                if (AD_RE.containsMatchIn(u)) {
                    return WebResourceResponse(
                        "text/plain", "utf-8", ByteArrayInputStream(ByteArray(0))
                    )
                }
                return null
            }

            // ── 反调试的第二道闸：拦住「被踢走」的导航 ──
            // shouldInterceptRequest 只能拦「下载资源」，拦不了导航；
            // 而站点的 toDevtools() 是 inline 脚本（写在 HTML 里，不是独立文件），我们换不掉它，
            // 只能等它跳转时把门关上（详见 ERROR_PAGE_RE 的注释）。
            override fun shouldOverrideUrlLoading(view: WebView?, request: WebResourceRequest?): Boolean {
                val u = request?.url?.toString() ?: return false
                if (ERROR_PAGE_RE.containsMatchIn(u)) {
                    pushDiag("拦截跳转", "站点反调试想把页面跳到错误页（${shortUrl(u)}），已拦下")
                    return true
                }
                return false
            }

            // ── 尽早注入 ──
            // onPageFinished 要等整页（含广告位、统计脚本）都加载完才触发，那时站点的反调试脚本早跑完了。
            // onPageStarted 是能拿到的最早时机：脚本会在新文档建立后立刻执行，比 onPageFinished 早得多。
            // 两处都注入是刻意的 —— 脚本自身有版本号短路（重复注入直接 return），重复不会有害，漏注入才有害。
            override fun onPageStarted(view: WebView?, url: String?, favicon: Bitmap?) {
                super.onPageStarted(view, url, favicon)
                if (mode != MODE_REPLAY) return
                view?.evaluateJavascript(TvNavScript.JS, null)
                view?.evaluateJavascript(ReplayRescueScript.JS, null)
                view?.evaluateJavascript(ReplayCleanupScript.JS, null)   // v1.4.3：去广告 + 单列重排
            }

            // 页面加载完成：注入遥控器导航脚本 + 播放器兜底脚本 + 更新状态提示
            override fun onPageFinished(view: WebView?, url: String?) {
                // 页面被反调试脚本清成空白：说明拦截没赶上（换了新域名/新写法），如实报出来并自动重载一次。
                // 不能无限重载 —— 会真正变成死循环刷屏，用户只会看到画面一直闪。
                if (mode == MODE_REPLAY && url != null && url.startsWith("about:")) {
                    pushDiag("页面被清空", "站点反调试脚本把页面清成了空白（$url），已自动重新加载")
                    if (!aboutBlankReloaded) {
                        aboutBlankReloaded = true
                        view?.post { if (mode == MODE_REPLAY) view.reload() }
                    }
                    return
                }
                // 注入光标导航脚本，让遥控器方向键能在网页里移动（详见 TvNavScript 的注释）。
                // 每次页面加载完成都要注入：页面一跳转，上一份注入的上下文就没了。
                view?.evaluateJavascript(TvNavScript.JS, null)
                // 注入「播放器兜底」脚本（v1.4.0）：站点自己的播放器在电视上可能压根建不出来，
                // 等不到就由我们自己建一个（详见 ReplayRescueScript 的注释）。
                // 只在回放页注入：直播用的是原生播放器，网页里没有这回事。
                if (mode == MODE_REPLAY) view?.evaluateJavascript(ReplayRescueScript.JS, null)
                // v1.4.3：去广告 + 重排（与 onPageStarted 互为备份，漏一处不漏全局）
                if (mode == MODE_REPLAY) view?.evaluateJavascript(ReplayCleanupScript.JS, null)
                if (mode == MODE_REPLAY) {
                    // 明确告诉用户退路：遥控器进了网页后，按「返回」即可回到直播
                    tvStatus.text = if (isTv) "回放页已加载（按「返回」可回到直播）" else "回放页已加载"
                    // 页面这一轮加载成功 → 清空上一轮的诊断，提示条恢复成操作说明
                    // （不清的话「共 N 条」会把上一次的旧错误算进来，反而干扰判断）
                    webDiag.clear()
                    webCapsText = ""
                    tvReplayHint.text = REPLAY_HINT_TEXT
                }
            }

            // ── 诊断①：主文档加载失败（DNS 不通 / 连不上 / 超时 / 证书错误…）──
            // 刻意用旧签名（API 1+）：它只在**主文档**出错时回调，正好是我们关心的那一类；
            // 新签名会把页面上所有子资源（广告位、统计脚本）的失败也一股脑抛上来，噪音太大。
            @Deprecated("老签名：API 23 以下只有它可用")
            override fun onReceivedError(
                view: WebView?, errorCode: Int, description: String?, failingUrl: String?
            ) {
                pushDiag("网页打不开", "错误码 $errorCode · ${description ?: ""} · ${shortUrl(failingUrl ?: "")}")
            }

            // ── 诊断②：HTTP 层被拒（403 / 404 / 5xx）──
            // 回放站的防盗链失败大多长这样：请求被源站拒绝 → 页面拿不到内容 → 一片空白或黑屏。
            override fun onReceivedHttpError(
                view: WebView?, request: WebResourceRequest?, errorResponse: WebResourceResponse?
            ) {
                val code = errorResponse?.statusCode ?: -1
                if (code >= 400) {
                    pushDiag("请求被拒", "HTTP $code · ${shortUrl(request?.url?.toString() ?: "")}")
                }
            }

            // ── 诊断③：网页渲染进程被系统回收 ──
            // 老电视盒子内存紧张时极常见，现象正是「整块突然全黑、连按钮都没有，且不报任何错」。
            // 必须返回 true：返回 false 时系统会认为应用处理不了，连带把整个应用进程杀掉。
            override fun onRenderProcessGone(view: WebView?, detail: RenderProcessGoneDetail?): Boolean {
                val crashed = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) detail?.didCrash() else null
                pushDiag(
                    "网页引擎重启",
                    if (crashed == true) "渲染进程异常退出，已自动重建网页"
                    else "渲染进程被系统回收（通常是内存不足），已自动重建网页"
                )
                // 已死的 WebView 救不活，重新加载也没用 —— 只能在原位销毁重建
                handler.post { rebuildWebView() }
                return true
            }
        }

        webView.webChromeClient = object : WebChromeClient() {
            // ── 诊断：网页里的 JS 错误 + 注入脚本的主动上报 ──
            // 播放器初始化失败、解码器不支持、跨域被拒……都会以 JS 报错的形式出现在这里。
            // 不接这个回调的话，用户端只能看到「黑屏」，我们则一无所知（这正是之前排查困难的根源）。
            override fun onConsoleMessage(msg: ConsoleMessage): Boolean {
                val text = msg.message() ?: return true
                if (text.startsWith(DIAG_PREFIX)) {
                    // 注入脚本（TvNavScript）用带前缀的 console.log 上报：本机播放能力、视频状态…
                    handlePageReport(text.removePrefix(DIAG_PREFIX).trim())
                } else if (msg.messageLevel() >= ConsoleMessage.MessageLevel.ERROR) {
                    pushDiag("网页 JS 报错", "$text @ ${shortUrl(msg.sourceId() ?: "")}:${msg.lineNumber()}")
                }
                return true
            }

            // 网页内 video 请求全屏：把系统提供的视图挂到全屏容器上
            override fun onShowCustomView(view: View, callback: CustomViewCallback) {
                customViewCallback?.onCustomViewHidden()   // 若已有全屏视图，先收起
                customViewCallback = callback
                fullscreenContainer.addView(
                    view,
                    FrameLayout.LayoutParams(
                        ViewGroup.LayoutParams.MATCH_PARENT,
                        ViewGroup.LayoutParams.MATCH_PARENT
                    )
                )
                fullscreenContainer.visibility = View.VISIBLE
                fullscreenContainer.bringToFront()
            }

            // 退出网页全屏
            override fun onHideCustomView() {
                fullscreenContainer.removeAllViews()
                fullscreenContainer.visibility = View.GONE
                customViewCallback?.onCustomViewHidden()
                customViewCallback = null
            }
        }
    }

    // ══════════════════ 回放页诊断（v1.3.0） ══════════════════

    /**
     * 记录一条回放页诊断并回显到界面上。
     *
     * 为什么必须「回显」而不只是记日志：电视上装不了开发者工具，用户能提供给我们的信息
     * 只有屏幕上的内容。把原因直接打在状态行（电视端左侧常驻）和回放提示条上，
     * 用户拍张照就能把根因带回来 —— 而不是只能反复描述「就是黑屏」。
     */
    private fun pushDiag(tag: String, raw: String) {
        val msg = raw.replace(Regex("\\s+"), " ").trim()
        if (msg.isEmpty()) return
        val line = "$tag：${msg.take(110)}"
        webDiag.add(line)
        while (webDiag.size > DIAG_MAX) webDiag.removeAt(0)
        showDiag()
    }

    /**
     * 把诊断文字写进状态行与回放提示条。
     *
     * v1.4.0 改了「显示哪一条」：以前是**后到的覆盖先到的**（还带 400ms 节流），
     * 结果是最后一条「视频状态：找不到 video 元素」把真正的根因（更早的 JS 报错）挤掉了 ——
     * 用户 2026-10-13 的截图就是如此，我们据此还查错了方向。
     * 现在按「根因优先」挑：有 JS 异常/自建播放失败这类**确定性错误**就先显示最早的那条，
     * 否则显示本次加载的第一条（最早发生的通常最接近根因），并带上总条数。
     */
    private fun showDiag() {
        if (webDiag.isEmpty()) return
        // v1.4.4：按用户要求，网页上的警告信息【不再显示在界面上】——
        // 过去把诊断写进状态行(tvStatus)与回放提示条(tvReplayHint)，屏幕上总挂着「⚠ …」，
        // 用户明确要求去掉。红点旁边的「位置提示」是另一套（网页里的 __tvnav_tip），保留不动。
        // 诊断仍完整写入 logcat（tag=TvLive），需要时 adb logcat 可取，不影响用户。
        val root = webDiag.firstOrNull { SEVERE_RE.containsMatchIn(it) } ?: webDiag.first()
        Log.w("TvLive", "replay-diag: $root  (共 ${webDiag.size} 条)")
    }

    /** 处理注入脚本的主动上报（见 TvNavScript / ReplayRescueScript 里的 report，格式：__TVNAV__ <kind> <内容>） */
    private fun handlePageReport(payload: String) {
        when {
            payload.startsWith("caps ") -> {
                webCapsText = payload.removePrefix("caps ").trim()
                hostStoppedRetries = 0   // v1.4.4：能上报能力说明页面正常加载了 → 站点已恢复，重置唤醒计数
                // 只有「能力不足 / 内核过旧」才是黑屏的根因，这种情况必须显眼报出来；一切正常就不打扰用户
                if (webCapsText.contains("mse=no") || webCapsText.contains("nativeHls=no")) {
                    pushDiag("本机播放能力不足", webCapsText)
                } else if (kernelMajor(webCapsText) in 1 until OLD_KERNEL_MAX) {
                    // 内核老到一定程度，站点用的新库（Artplayer / hls.js 新版）会直接语法报错，
                    // 站点自己的播放器就永远建不出来 —— 这正是「手机正常、电视黑屏」的典型成因。
                    pushDiag("网页内核过旧", "$webCapsText（站点播放器可能无法运行）")
                }
            }
            // v1.4.4：网页内部「可后退步数」——回看页返回键据此决定「先退网页」还是「回直播」
            payload.startsWith("nav ") -> {
                val m = Regex("depth=(\\d+)").find(payload)
                webNavDepth = m?.groupValues?.get(1)?.toIntOrNull() ?: 0
            }
            // v1.4.4：宿主机「工作空间已停止」占位页 → 自动重载唤醒
            payload.startsWith("stopped ") -> onHostStopped(payload.removePrefix("stopped ").trim())
            payload.startsWith("video ") -> pushDiag("视频状态", payload.removePrefix("video ").trim())
            payload.startsWith("rescue ") -> pushDiag("播放器兜底", payload.removePrefix("rescue ").trim())
            payload.startsWith("gate ") -> pushDiag("广告遮罩", payload.removePrefix("gate ").trim())
            payload.startsWith("warn ") -> pushDiag("页面提示", payload.removePrefix("warn ").trim())
        }
    }

    /**
     * 处理「工作空间已停止」占位页（v1.4.4）。
     *
     * 背景：回放站或其宿主云工作空间空闲被停后，会整屏返回一张占位页
     *   （「工作空间已停止 / 错误码 12809 / SandboxId / TraceId / 立即启动 / 返回 Dashboard」）。
     * 实测后端 /api/config 此刻正常，说明是**间歇性休眠**，重载通常就能唤醒。
     * 故这里自动重载若干次尝试唤醒；限次是为了防死循环（若站点长时间停机，别把用户困在刷新里）。
     * 注入脚本已顺手点过「立即启动」按钮；这里的重载是第二重保险。
     */
    private fun onHostStopped(reason: String) {
        Log.w("TvLive", "replay-diag: 工作空间已停止 · $reason")
        if (hostStoppedRetries < 3) {
            hostStoppedRetries++
            tvStatus.text = "站点暂时停止（云工作空间休眠），正在尝试唤醒…（第 $hostStoppedRetries 次）"
            handler.postDelayed({
                if (mode == MODE_REPLAY && ::webView.isInitialized) webView.reload()
            }, 2500L)
        } else {
            tvStatus.text = "站点工作空间持续未启动，请稍后按 ⟳ 重载"
        }
    }

    /** 从能力摘要里抠出内核大版本号（解析不出返回 -1，调用方据此跳过判断） */
    private fun kernelMajor(caps: String): Int {
        val m = Regex("kernel=Chrome/(\\d+)").find(caps) ?: return -1
        return m.groupValues[1].toIntOrNull() ?: -1
    }

    /** 把完整地址截成「域名+末段」，免得状态行被长 URL 撑爆 */
    private fun shortUrl(u: String): String {
        if (u.isEmpty()) return ""
        val noScheme = u.substringAfter("://", u)
        return if (noScheme.length <= 60) noScheme else (noScheme.take(28) + "…" + noScheme.takeLast(26))
    }

    /**
     * 原地重建 WebView。
     *
     * 网页渲染进程被系统回收后，原来那个 WebView 已经彻底废了 —— reload、注入脚本、改设置
     * 都不会有任何反应（现象就是「突然全黑、按什么都没用」）。唯一出路是销毁重建。
     * 重建后若还在回放模式，自动把回放页重新加载一遍，用户不必自己再点一次。
     */
    private fun rebuildWebView() {
        if (!::webView.isInitialized) return
        try {
            val parent = (webView.parent as? ViewGroup) ?: playerHost
            val index = parent.indexOfChild(webView).coerceAtLeast(0)
            val lp = webView.layoutParams

            parent.removeView(webView)
            webView.destroy()                                // 老实例必须显式销毁，否则会泄漏渲染进程

            val fresh = WebView(this)
            if (lp != null) fresh.layoutParams = lp
            parent.addView(fresh, index)
            webView = fresh                                  // 后续所有代码都通过这个引用访问，直接换掉即可
            setupWebView()                                   // 重新挂上诊断 / 光标脚本 / 全屏回调
            webView.visibility = if (mode == MODE_REPLAY) View.VISIBLE else View.GONE

            webViewLoaded = false
            if (mode == MODE_REPLAY) {
                val target = replayUrl.ifBlank { DEFAULT_REPLAY }
                webView.loadUrl(Backend.embed(Prefs.backendUrl, target))
                webViewLoaded = true
                webView.post { webView.requestFocus() }
            }
        } catch (e: Exception) {
            pushDiag("网页重建失败", "${e.javaClass.simpleName} ${e.message ?: ""}")
        }
    }

    /** 初始化频道列表 */
    private fun setupList() {
        recycler.layoutManager = LinearLayoutManager(this)
        adapter = ChannelAdapter(
            items = emptyList(),
            isFav = { Prefs.isFavorite(it.id) },
            onClick = { position, ch -> onChannelClicked(position, ch) },
            onToggleFav = { ch -> onToggleFav(ch) },
            // 列表项按「上」跳到第一个分组按钮（无分组按钮时适配器会自动退到「直播」标签）
            upFocusId = { firstChipId }
        )
        recycler.adapter = adapter
    }

    /** 绑定按钮点击 */
    private fun setupClicks() {
        btnBackend.setOnClickListener { showBackendDialog() }   // 修改后端地址
        btnPlayerBack.setOnClickListener { showListPage() }     // 回到列表
        btnFav.setOnClickListener {                                 // 收藏当前频道
            curChannel?.let { onToggleFav(it) }
        }
        btnReload.setOnClickListener {                              // 重载：直播重连 / 回放刷新
            if (mode == MODE_REPLAY) webView.reload()
            else curChannel?.let { playLive(it) }
        }

        // ── 画面上自绘控制条 ──
        // v1.1.0：按用户要求精简，只保留「全屏 / 退出全屏」一个按钮
        btnCtrlFull.setOnClickListener { toggleFullscreen() }       // 全屏 / 退出全屏
    }

    /** 绑定「直播/回放」切换（含电视端「焦点可见」处理） */
    private fun setupTabs() {
        tabLive.setOnClickListener { switchMode(MODE_LIVE) }
        tabReplay.setOnClickListener { switchMode(MODE_REPLAY) }
        // 电视端：焦点进入/离开时刷新底色，否则用户根本看不到光标停在哪个标签上
        tabLive.setOnFocusChangeListener { _, _ -> updateTabStyle() }
        tabReplay.setOnFocusChangeListener { _, _ -> updateTabStyle() }
        updateTabStyle()
    }

    // ══════════════════ 电视端焦点处理 ══════════════════

    /**
     * 让顶栏/播放栏的按钮都能被遥控器选中，并且选中时有明显视觉反馈。
     *
     * 【v1.0.1 修复核心】真机实测（小米电视，2026-10-12 用户截图）：
     *   「直播/回放」标签与分组按钮遥控器完全选不中，而频道列表项能选中。
     *   对比两处代码发现唯一差别是列表项多声明了 focusableInTouchMode ——
     *   这台电视的应用窗口运行在**触摸模式**下，此时只有同时声明
     *   focusableInTouchMode 的控件才允许被方向键聚焦（仅 focusable 不够）。
     */
    private fun setupFocusVisuals() {
        makeFocusable(btnBackend, ContextCompat.getColor(this, R.color.panel_hi))
        makeFocusable(btnPlayerBack, Color.TRANSPARENT)
        makeFocusable(btnFav, Color.TRANSPARENT)
        makeFocusable(btnReload, Color.TRANSPARENT)
        // 自绘控制条上的按钮同样要能被遥控器选中，否则「全屏」按钮等于摆设
        // （v1.1.0 起控制条只剩这一个按钮）
        makeFocusable(btnCtrlFull, Color.TRANSPARENT)

        // 焦点连线：控制条按钮按「上」/「左」回到频道列表。
        // 不做连线的后果是遥控器一旦进了画面区就出不来。
        btnCtrlFull.nextFocusUpId = R.id.recycler_channels
        btnCtrlFull.nextFocusLeftId = R.id.recycler_channels
    }

    /** 把普通控件改造成「遥控器可选中 + 焦点可见」 */
    private fun makeFocusable(v: TextView, normalBg: Int) {
        v.isFocusable = true
        v.isFocusableInTouchMode = true          // ← 触摸模式下能被遥控器选中的关键
        v.setOnFocusChangeListener { _, hasFocus -> paintFocus(v, normalBg, hasFocus) }
        paintFocus(v, normalBg, false)           // 统一初始样式，避免残留
    }

    /**
     * 统一的焦点样式：底色 + （聚焦时）一圈细边框。
     *
     * 只用底色变化在电视上不够显眼（用户真机反馈「看不出现在选的是哪里」），
     * 故额外叠一层 2dp 亮色描边。选白色是因为它在**任何**底色上都看得见，
     * 包括「已选中」的红底状态（用红框叠红底会糊成一片）。
     */
    private fun paintFocus(v: View, bgColor: Int, focused: Boolean) {
        val layers = ArrayList<Drawable>(2)
        layers.add(ColorDrawable(bgColor))                       // 底层：底色
        if (focused) {
            layers.add(GradientDrawable().apply {                // 顶层：只描边、不填充
                shape = GradientDrawable.RECTANGLE
                setColor(Color.TRANSPARENT)
                setStroke(dp(RING_WIDTH_DP), COLOR_RING)
                cornerRadius = dp(4).toFloat()
            })
        }
        v.background = LayerDrawable(layers.toTypedArray())
    }

    /**
     * 把遥控器焦点落到列表的指定行。
     * 分两次 post：第一次滚动到该行，等布局完成后再取该项的视图请求焦点。
     * 取不到视图时（尚未布局）退回让列表自身请求焦点，保证焦点不会悬空。
     */
    private fun focusChannelRow(index: Int) {
        recycler.post {
            recycler.scrollToPosition(index)
            recycler.post {
                recycler.findViewHolderForAdapterPosition(index)?.itemView?.requestFocus()
                    ?: recycler.requestFocus()
            }
        }
    }

    // ══════════════════ 数据加载 ══════════════════

    /** 拉取频道列表与回放地址（后台线程执行，避免阻塞界面） */
    private fun loadData() {
        tvStatus.text = "正在加载频道…"
        Thread {
            val base = Prefs.backendUrl
            val channels = ChannelRepo.fetchChannels(base)          // 失败返回 null
            val replay = ChannelRepo.fetchReplayUrl(base)           // 失败返回 null
            handler.post {
                if (channels != null && channels.isNotEmpty()) {
                    allChannels = channels
                    tvStatus.text = "共 ${channels.size} 台（来源：后端）"
                } else {
                    // 后端不可达：回退内置少量频道，保证界面可用且有明确提示
                    allChannels = ChannelRepo.builtinChannels()
                    tvStatus.text = "后端不可达，已回退内置频道（可点「后端设置」修改地址）"
                }
                replay?.let { replayUrl = it }
                buildGroupBar()      // 生成分组筛选按钮
                applyFilter()        // 应用过滤并刷新列表

                // 电视端：启动后自动播放上次看过的频道，减少遥控器操作
                if (isTv) {
                    val target = shownChannels.firstOrNull { it.id == Prefs.lastChannelId }
                        ?: shownChannels.firstOrNull()
                    if (target != null) {
                        val idx = shownChannels.indexOf(target)
                        onChannelClicked(idx, target)
                        // 把遥控器光标落在「正在播放的那一行」：
                        // 否则焦点会停在列表第一行，与右侧画面不是同一台，容易误操作
                        focusChannelRow(idx)
                    } else {
                        recycler.requestFocus()
                    }
                }
            }
        }.start()
    }

    /**
     * 生成分组筛选按钮（「全部」+ 后端返回的各分组）。
     *
     * 电视端要点（v1.0.1 修复）：
     *   1) 每个按钮必须 isFocusableInTouchMode = true，否则遥控器选不中（真机实测）；
     *   2) 每个按钮分配独立 id，供上下方向键精确跳转；
     *   3) 按钮在**切换分组时不重建**（重建会立刻丢掉焦点），只刷新样式。
     */
    private fun buildGroupBar() {
        groupContainer.removeAllViews()
        chipViews.clear()
        firstChipId = View.NO_ID

        // 组装分组名列表：「全部」永远在最前，其余按名称排序
        val groups = ArrayList<String>()
        groups.add(GROUP_ALL)
        allChannels.map { it.group }
            .filter { it.isNotBlank() }
            .distinct()
            .sorted()
            .forEach { groups.add(it) }

        groups.forEach { g ->
            val tv = TextView(this).apply {
                id = View.generateViewId()             // 动态 id：供方向键与焦点恢复使用
                text = g
                textSize = 13f
                setPadding(dp(12), dp(8), dp(12), dp(8))
                isFocusable = true
                isFocusableInTouchMode = true          // ← 电视端能被遥控器选中的关键
                nextFocusUpId = R.id.tab_live            // 「上」→ 直播/回放标签行
                nextFocusDownId = R.id.recycler_channels // 「下」→ 频道列表
                setOnClickListener { onGroupClicked(this, g) }
                setOnFocusChangeListener { _, _ -> renderChip(this, g == curGroup) }
                renderChip(this, g == curGroup)
            }
            val lp = LinearLayout.LayoutParams(
                ViewGroup.LayoutParams.WRAP_CONTENT,
                ViewGroup.LayoutParams.WRAP_CONTENT
            )
            lp.marginEnd = dp(6)
            groupContainer.addView(tv, lp)

            chipViews.add(tv)
            if (firstChipId == View.NO_ID) firstChipId = tv.id
        }

        // ── 上下方向键贯通 ──
        // 列表「上」→ 第一个分组按钮；没有分组按钮时退到「直播」标签
        val downFromTabs = if (firstChipId != View.NO_ID) firstChipId else R.id.recycler_channels
        recycler.nextFocusUpId = if (firstChipId != View.NO_ID) firstChipId else R.id.tab_live
        // 顶栏「后端」按钮「下」→ 直播/回放标签行
        btnBackend.nextFocusDownId = R.id.tab_live
        // 「直播/回放」标签「下」→ 第一个分组按钮（无分组按钮时→列表）
        tabLive.nextFocusDownId = downFromTabs
        tabReplay.nextFocusDownId = downFromTabs
    }

    /**
     * 切换分组。
     * 只刷新样式、不重建视图，并把焦点留在被点的按钮上 —— 否则用户每选一次分组
     * 焦点都会丢失，需要重新用遥控器一路导航回来。
     */
    private fun onGroupClicked(view: View, g: String) {
        if (curGroup == g) {
            view.requestFocus()
            return
        }
        curGroup = g
        chipViews.forEach { renderChip(it, it.text.toString() == curGroup) }
        applyFilter()
        groupContainer.post { view.requestFocus() }   // 列表刷新后再恢复焦点
    }

    /**
     * 渲染单个分组按钮。
     * 优先级：当前分组（红底白字）> 仅聚焦（灰底白字）> 普通（透明底灰字）。
     */
    private fun renderChip(v: TextView, selected: Boolean) {
        val focused = v.isFocused
        v.setTextColor(if (selected || focused) Color.WHITE else COLOR_DIM)
        val bg = when {
            selected -> COLOR_ACCENT
            focused -> COLOR_FOCUS_BG
            else -> Color.TRANSPARENT
        }
        paintFocus(v, bg, focused)   // 聚焦时额外加一圈细边框
    }

    /** 按当前分组过滤并刷新列表 */
    private fun applyFilter() {
        shownChannels = if (curGroup == GROUP_ALL) {
            allChannels
        } else {
            allChannels.filter { it.group == curGroup }
        }
        adapter.submit(shownChannels)
        // 把当前分组的台数写在状态行：
        // 网页版的分类头上有数量，电视端没有，用户会怀疑「是不是少了几个台」；
        // 给出明确数字后可一眼核对（例如切到「韩国」应显示 31 台）。
        if (allChannels.isNotEmpty()) {
            tvStatus.text = if (curGroup == GROUP_ALL) {
                "共 ${allChannels.size} 台（来源：后端）"
            } else {
                "分组「$curGroup」共 ${shownChannels.size} 台"
            }
        }
    }

    // ══════════════════ 播放控制 ══════════════════

    /** 点击某个频道 */
    private fun onChannelClicked(position: Int, ch: Channel) {
        curChannel = ch
        Prefs.lastChannelId = ch.id       // 记住，下次启动自动恢复
        tvNowPlaying.text = ch.name
        updateFavIcon()

        if (mode == MODE_LIVE) {
            playLive(ch)
        } else {
            openReplay()                   // 回放模式下点频道 = 打开回放页
        }
        showPlayerPage()                   // 手机：切到播放页；电视：本就常驻
    }

    /**
     * 播放直播频道。
     * 关键一：播放方式要**跟随后端的 relay 标记**（与网页版一致）——
     *        默认经后端中继包装（Backend.relay），因为多数频道源有地域封锁 / Referer 校验，
     *        直连必然失败；但后端标了 `relay:false` 的频道（如韩国地面波主台 KBS/SBS/MBC/JTBC）
     *        连中继都够不到，只能本机直连，此时必须改用源地址。
     *        v1.1.1 之前 App 忽略该标记、一律走中继，导致这批台在网页版能试、在 App 必然报错。
     * 关键二：必须显式告知 MIME（按**源地址**推断）——中继地址丢了 .m3u8 后缀，
     *        不声明的话播放器会按普通 MP4 解析 m3u8 文本，报
     *        ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED（真机实测的报错）。
     */
    private fun playLive(ch: Channel) {
        webView.visibility = View.GONE
        playerView.visibility = View.VISIBLE
        // 状态行标出播放方式：用户能一眼看出这台是走中继还是本机直连（直连失败时也便于判断原因）
        tvStatus.text = "正在播放：${ch.name}（${Backend.relayLabel(ch.relay)}）"
        player.play(
            Backend.playUrl(Prefs.backendUrl, ch.url, ch.relay),
            MimeHint.of(ch.url)
        )
    }

    /**
     * 打开回放页。
     * 用 WebView 加载后端内嵌代理：服务端会给回放站补上它要求的 Referer，
     * 并注入脚本把播放器的取流请求改走中继 —— 这套逻辑网页版已实测可播，App 直接复用。
     */
    private fun openReplay() {
        player.pause()                        // 先暂停直播，避免两个声音叠加
        playerView.visibility = View.GONE
        webView.visibility = View.VISIBLE
        tvNowPlaying.text = "回放"
        updateControlsForMode()               // 回放时把「播放/静音」收起，只留「全屏」
        webNavDepth = 0                       // v1.4.4：新一轮回放，后退栈清零（返回键先退网页、后回直播）
        hostStoppedRetries = 0                // v1.4.4：重置「工作空间已停止」唤醒计数
        webView.post { webView.requestFocus() }   // 焦点交给网页，方向键才会被转发进去

        if (!webViewLoaded) {
            // 回放地址优先取后端配置；取不到时用兜底常量，保证功能不至于是空的
            val target = replayUrl.ifBlank { DEFAULT_REPLAY }
            aboutBlankReloaded = false        // 新一轮回放：重置「页面被清空」的自动重载闸门
            tvStatus.text = "正在加载回放页…"
            webView.loadUrl(Backend.embed(Prefs.backendUrl, target))
            webViewLoaded = true
        } else {
            // 页面已存在：重新注入一次脚本，保证当前页面具备光标导航能力
            webView.evaluateJavascript(TvNavScript.JS, null)
        }
    }

    /**
     * 按当前模式调整控件。
     *
     * v1.1.0 起控制条只剩「全屏」一个按钮，两种模式下都有意义（都是把左侧列表收掉、
     * 让播放区/网页占满屏幕），故不再需要按模式隐藏按钮。
     * 这里只剩下「回放页操作提示条」的显隐：不给提示，用户进了网页完全不知道该按什么。
     */
    private fun updateControlsForMode() {
        val replay = mode == MODE_REPLAY
        tvReplayHint.visibility = if (replay && isTv) View.VISIBLE else View.GONE
    }

    /** 切换直播/回放模式 */
    private fun switchMode(m: Int) {
        mode = m
        updateTabStyle()
        if (m == MODE_REPLAY) {
            openReplay()
            showPlayerPage()                  // 手机：直接进播放页看回放
        } else {
            webView.visibility = View.GONE
            playerView.visibility = View.VISIBLE
            tvNowPlaying.text = curChannel?.name ?: "直播"
            curChannel?.let { playLive(it) }  // 回到直播则重新连接当前频道
            if (isFullscreen) applyFullscreen(false)   // 切回直播时先退出全屏，避免界面被锁死
            updateControlsForMode()
            if (!isTv) showListPage()         // 手机：回到列表页方便重新选台
        }
    }

    /** 刷新「直播/回放」标签样式（选中优先，其次聚焦） */
    private fun updateTabStyle() {
        renderTab(tabLive, mode == MODE_LIVE)
        renderTab(tabReplay, mode == MODE_REPLAY)
    }

    /**
     * 渲染单个「直播/回放」标签。
     * 优先级：当前模式（红底白字）> 仅聚焦（灰底白字）> 普通（透明底灰字）。
     * 这样即使用户把光标移到「回放」上，也能立刻看到它变亮 —— 电视端最基本的可用性要求。
     */
    private fun renderTab(v: TextView, selected: Boolean) {
        val focused = v.isFocused
        v.setTextColor(if (selected || focused) Color.WHITE else COLOR_DIM)
        val bg = when {
            selected -> COLOR_ACCENT
            focused -> COLOR_FOCUS_BG
            else -> Color.TRANSPARENT
        }
        paintFocus(v, bg, focused)   // 聚焦时额外加一圈细边框，电视上一眼可见
    }

    // ══════════════════ 页面切换（手机） ══════════════════

    /** 显示播放页（电视上播放区本来就常驻，无需切换） */
    private fun showPlayerPage() {
        if (isTv) return
        panelList.visibility = View.GONE
        panelPlayer.visibility = View.VISIBLE
    }

    /** 显示列表页并暂停播放（手机上离开播放页就没必要继续耗流量） */
    private fun showListPage() {
        if (isTv) return
        if (isFullscreen) applyFullscreen(false)   // 离开播放页时收起全屏，避免状态错乱
        player.pause()
        panelPlayer.visibility = View.GONE
        panelList.visibility = View.VISIBLE
    }

    // ══════════════════ 收藏 ══════════════════

    /** 切换收藏状态 */
    private fun onToggleFav(ch: Channel) {
        val nowFav = Prefs.toggleFavorite(ch.id)
        toast(if (nowFav) "已收藏：${ch.name}" else "已取消收藏：${ch.name}")
        adapter.notifyDataSetChanged()                 // 列表里的星标需要同步刷新
        if (curChannel?.id == ch.id) updateFavIcon()   // 若正是当前频道，同步播放页星标
    }

    /** 刷新播放页收藏星标 */
    private fun updateFavIcon() {
        val fav = curChannel?.let { Prefs.isFavorite(it.id) } ?: false
        btnFav.text = if (fav) "★" else "☆"
    }

    // ══════════════════ 后端设置 ══════════════════

    /** 弹出后端地址修改框（改完立即重载数据，不用重装 App） */
    private fun showBackendDialog() {
        val input = EditText(this).apply {
            inputType = InputType.TYPE_TEXT_VARIATION_URI   // 弹出便于输入网址的键盘
            setText(Prefs.backendUrl)
            setSelection(text.length)                       // 光标置于末尾，方便直接追加修改
        }

        AlertDialog.Builder(this)
            .setTitle("后端地址")
            .setMessage("例如：${Backend.DEFAULT_BASE}\n也可填局域网地址，如 http://192.168.1.10:8899")
            .setView(input)
            .setPositiveButton("保存并重载") { _, _ ->
                val v = input.text.toString().trim()
                if (v.startsWith("http://") || v.startsWith("https://")) {
                    Prefs.backendUrl = v
                    webViewLoaded = false     // 后端变了，回放页需重新加载
                    loadData()                // 重新拉频道与配置
                } else {
                    toast("地址需以 http:// 或 https:// 开头")
                }
            }
            .setNegativeButton("取消", null)
            .show()
    }

    // ══════════════════ 全屏 ══════════════════

    /** 切换全屏（真机反馈「找不到全屏按钮」，故做成画面上一眼可见的按钮） */
    private fun toggleFullscreen() = applyFullscreen(!isFullscreen)

    /**
     * 应用全屏状态。
     * 全屏 = 隐藏左侧频道列表 + 隐藏播放页顶栏 + 隐藏系统状态栏/导航栏。
     * 电视上尤其明显：左侧列表要吃掉约三成画面宽，全屏后画面才真正铺满整屏。
     */
    private fun applyFullscreen(on: Boolean) {
        isFullscreen = on
        // 顶栏（返回/收藏/重载）在全屏时一并收起，做到「真全屏」
        playerTopBar.visibility = if (on) View.GONE else View.VISIBLE

        if (on) {
            panelList.visibility = View.GONE
            hideSystemBars()
        } else {
            // 手机：播放页本就不显示列表；电视/横屏：列表常驻
            val listShouldShow = isTv || panelPlayer.visibility != View.VISIBLE
            panelList.visibility = if (listShouldShow) View.VISIBLE else View.GONE
            showSystemBars()
        }
        syncControlLabels()
        // v1.4.4：全屏切换改变了 WebView 视口 → 页面会重排，主动让网页里的红点原位重对齐
        // （修「全屏返回后红点定位不准、明明点这里却点到别处」）。调两次：一次赶在动画初，一次等布局稳定。
        repaintNavSoon(150)
        repaintNavSoon(500)
        // 焦点归属：全屏时落到「退出全屏」按钮；退出全屏后按模式送回——直播回频道列表，
        // 回放交给网页（此时方向键仍被 dispatchKeyEvent 接管，焦点位置只影响输入法等细节）。
        liveControls.post {
            if (on) btnCtrlFull.requestFocus()
            else if (isTv) {
                if (mode == MODE_REPLAY) webView.requestFocus() else recycler.requestFocus()
            }
        }
    }

    /**
     * 让网页里的红点「原位重对齐」（v1.4.4）。
     *
     * 全屏切换会改变 WebView 尺寸 → 页面重排（播放器 56.25vw 高度、播放列表位置都会变）。
     * 只靠网页自己的 resize 事件，有时读到的是**尚未完成重排**的旧布局，导致红点提示与实际元素不符。
     * 这里由原生层延时主动调用 __tvNav.repaint()（不把红点挪回中心，只做夹取+重新命中测试），
     * 在布局稳定后再对齐一次，定位才准。
     */
    private fun repaintNavSoon(delayMs: Long) {
        handler.postDelayed({
            if (mode == MODE_REPLAY && ::webView.isInitialized && webView.visibility == View.VISIBLE) {
                webView.evaluateJavascript(
                    "window.__tvNav&&window.__tvNav.repaint&&window.__tvNav.repaint()", null
                )
            }
        }, delayMs)
    }

    /** 隐藏系统状态栏与导航栏（沉浸式全屏） */
    private fun hideSystemBars() {
        val c = WindowInsetsControllerCompat(window, window.decorView)
        c.systemBarsBehavior = WindowInsetsControllerCompat.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        c.hide(WindowInsetsCompat.Type.systemBars())
    }

    /** 恢复系统状态栏与导航栏 */
    private fun showSystemBars() {
        WindowInsetsControllerCompat(window, window.decorView)
            .show(WindowInsetsCompat.Type.systemBars())
    }

    // ══════════════════ 遥控器 / 按键 ══════════════════

    /**
     * 遥控器按键总入口。手机端不拦截，逻辑全在下面这个回放分支里。
     *
     * 回放模式下把方向键/确定键**原样转发**给注入网页的红点光标脚本：
     * WebView 没有内建的「方向键在网页元素之间移动」能力，不转发的话用户会觉得
     * 「遥控器在回放页完全没反应、也不知道选中了哪里」（真机反馈的原话）。
     *
     * v1.1.0 追加：确定键拆成「短按 = 点击」和「长按 = 切换全屏」。
     * 之所以要这样：方向键被网页接管后，遥控器根本无法把焦点移到画面上那个
     * 「全屏」按钮上，而全屏（把左侧列表收掉、让网页铺满屏幕）在电视上又是刚需，
     * 所以必须给一个只用到「确定键」的入口 —— 每台遥控器都有确定键。
     * 「菜单」键同样可以切全屏，照顾带菜单键的遥控器。
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (mode == MODE_REPLAY && webView.visibility == View.VISIBLE &&
            fullscreenContainer.visibility != View.VISIBLE
        ) {
            when (event.keyCode) {
                // ── 方向键：按下即转发（不等抬起，手感才跟手）──
                KeyEvent.KEYCODE_DPAD_UP, KeyEvent.KEYCODE_DPAD_DOWN,
                KeyEvent.KEYCODE_DPAD_LEFT, KeyEvent.KEYCODE_DPAD_RIGHT -> {
                    if (event.action == KeyEvent.ACTION_DOWN) forwardKeyToPage(event.keyCode)
                    return true
                }

                // ── 确定键：短按点击 / 长按切全屏 ──
                KeyEvent.KEYCODE_DPAD_CENTER, KeyEvent.KEYCODE_ENTER -> {
                    if (event.action == KeyEvent.ACTION_DOWN) {
                        // 只认第一次按下（repeatCount==0），长按产生的重复事件忽略掉
                        if (event.repeatCount == 0) {
                            okLongPressFired = false                          // 复位长按标记
                            handler.postDelayed(okLongPressTask, OK_LONG_PRESS_MS)  // 开始长按计时
                        }
                    } else if (event.action == KeyEvent.ACTION_UP) {
                        handler.removeCallbacks(okLongPressTask)                  // 抬起即取消长按计时
                        // 没被判定成长按 → 才当作一次点击；否则长按已经切过全屏，不能再点一下
                        if (!okLongPressFired) forwardKeyToPage(KeyEvent.KEYCODE_DPAD_CENTER)
                        okLongPressFired = false
                    }
                    return true   // 完全接管，避免 WebView 自己拿去滚动页面
                }

                // ── 菜单键：直接切全屏（带菜单键的遥控器的便捷入口）──
                KeyEvent.KEYCODE_MENU -> {
                    if (event.action == KeyEvent.ACTION_DOWN) toggleFullscreen()
                    return true
                }
            }
        }
        return super.dispatchKeyEvent(event)
    }

    /** 把一次按键转发给网页里注入的红点光标脚本（脚本不存在时静默忽略，不会崩） */
    private fun forwardKeyToPage(keyCode: Int) {
        webView.evaluateJavascript("window.__tvNav&&window.__tvNav.key($keyCode)", null)
    }

    /** 遥控器数字键直选：缓冲若干位数字后自动切台（如按 1、2 → 切第 12 台） */
    private val digitTask = Runnable {
        val n = digitBuf.toString().toIntOrNull()
        digitBuf.setLength(0)
        if (n != null) {
            if (n in 1..shownChannels.size) {
                onChannelClicked(n - 1, shownChannels[n - 1])
            } else {
                toast("当前列表没有第 $n 台")
            }
        }
    }

    /**
     * 红点心跳（v1.4.3）：回放模式下每 1.2 秒探一次网页里是否还挂着红点光标脚本与清理脚本。
     * 背景：详情页这个播放页结构复杂，在页面重载/跳转/广告脚本扰动后，偶尔会漏掉一次注入，
     * 表现正是「进播放页后红点没了」。这里只要发现 window.__tvNav / window.__tvClean 不见了就补注入，
     * 脚本自身有版本短路由：已存在时补注入只是重绘、不会把红点拽回屏幕中央（不打扰用户操作）。
     */
    private val navHeartbeat = object : Runnable {
        override fun run() {
            if (mode == MODE_REPLAY && ::webView.isInitialized && webView.visibility == View.VISIBLE) {
                // 红点光标缺失 → 补注入 TvNavScript
                webView.evaluateJavascript("(typeof window.__tvNav==='undefined')?'need':'ok'") { r ->
                    if (r == "\"need\"" || r == "need") webView.evaluateJavascript(TvNavScript.JS, null)
                }
                // 清理脚本缺失 → 补注入 ReplayCleanupScript（广告可能又冒出来）
                webView.evaluateJavascript("(typeof window.__tvClean==='undefined')?'need':'ok'") { r ->
                    if (r == "\"need\"" || r == "need") webView.evaluateJavascript(ReplayCleanupScript.JS, null)
                }
            }
            handler.postDelayed(this, 1200)
        }
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        // 数字键 0-9 → 进入缓冲
        val digit = when (keyCode) {
            KeyEvent.KEYCODE_0 -> 0
            KeyEvent.KEYCODE_1 -> 1
            KeyEvent.KEYCODE_2 -> 2
            KeyEvent.KEYCODE_3 -> 3
            KeyEvent.KEYCODE_4 -> 4
            KeyEvent.KEYCODE_5 -> 5
            KeyEvent.KEYCODE_6 -> 6
            KeyEvent.KEYCODE_7 -> 7
            KeyEvent.KEYCODE_8 -> 8
            KeyEvent.KEYCODE_9 -> 9
            else -> -1
        }
        if (digit >= 0) {
            // 回放模式下数字键不用于切台（此时用户是在网页里操作），直接放行
            if (mode == MODE_REPLAY) return super.onKeyDown(keyCode, event)
            if (digitBuf.length < 3) digitBuf.append(digit)   // 最多支持三位数
            handler.removeCallbacks(digitTask)                 // 重置计时，等待用户继续输入
            handler.postDelayed(digitTask, DIGIT_TIMEOUT)
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    /** 返回键：优先退出网页全屏 → 再回到列表页 → 最后才退出应用 */
    @Deprecated("基类已标记废弃，此处仍沿用以保证 API 21 上行为一致")
    override fun onBackPressed() {
        // 0) 处于自绘全屏 → 先退出全屏（此时顶栏都已隐藏，不退全屏用户会被困住）
        if (isFullscreen) {
            applyFullscreen(false)
            return
        }
        // 1) 正在网页全屏 → 先退出全屏
        if (fullscreenContainer.visibility == View.VISIBLE) {
            fullscreenContainer.removeAllViews()
            fullscreenContainer.visibility = View.GONE
            customViewCallback?.onCustomViewHidden()
            customViewCallback = null
            return
        }
        // 2) 回放模式：优先在网页内部**一步一步后退**（v1.4.4 修正）。
        //    为什么不能只靠 canGoBack：回放站的「列表页 → 点卡片进播放页」跳转多发生在**同源 iframe 内**，
        //    顶层 WebView 历史不增长 → canGoBack() 恒为 false → 旧逻辑会**直接回直播**、退不回上一屏
        //    （用户 2026-10-13 反馈「不要马上回直播，要一步一步返回上一个画面」）。
        //    注入脚本为此维护了一个「后退栈」并用 report('nav') 上报深度：深度>0 就交给网页退一步，
        //    退到网页第一屏（深度 0）后才继续往下走（回列表 / 回直播）。
        if (mode == MODE_REPLAY && webView.visibility == View.VISIBLE) {
            if (webNavDepth > 0) {
                webView.evaluateJavascript("window.__tvNav&&window.__tvNav.back&&window.__tvNav.back()", null)
                if (webNavDepth > 0) webNavDepth--   // 乐观递减；脚本后退后会补报真实深度
                return
            }
            if (webView.canGoBack()) {
                webView.goBack()
                return
            }
        }
        // 3) 手机处于播放页 → 回到列表页
        if (!isTv && panelPlayer.visibility == View.VISIBLE) {
            showListPage()
            return
        }
        // 4) 电视端处于回放模式 → 退回直播，并把焦点收回左侧列表。
        //    这是遥控器「走进网页」之后唯一的退路：否则用户会被困在网页里，
        //    再按返回就直接退出应用了。
        if (isTv && mode == MODE_REPLAY) {
            switchMode(MODE_LIVE)
            recycler.post { recycler.requestFocus() }
            return
        }
        // 5) 其它情况：交给系统（退出应用）
        @Suppress("DEPRECATION")
        super.onBackPressed()
    }

    // ══════════════════ 生命周期 ══════════════════

    override fun onResume() {
        super.onResume()
        // 从后台回来时系统栏可能被系统恢复，全屏状态需要重新应用一次
        if (isFullscreen) hideSystemBars()
    }

    override fun onPause() {
        super.onPause()
        // 退到后台时暂停播放：避免后台继续占用带宽与声音
        if (mode == MODE_LIVE) player.pause()
    }

    override fun onDestroy() {
        super.onDestroy()
        handler.removeCallbacksAndMessages(null)   // 清理数字键缓冲任务，防止泄漏
        handler.removeCallbacks(navHeartbeat)        // v1.4.3：停掉红点心跳
        player.release()                           // 释放播放器
        // 先摘除再销毁 WebView，避免部分系统在销毁时崩溃
        (webView.parent as? ViewGroup)?.removeView(webView)
        webView.destroy()
    }

    // ══════════════════ 小工具 ══════════════════

    /** dp 转像素（用于代码创建的控件排版） */
    private fun dp(v: Int): Int = (v * resources.displayMetrics.density).toInt()

    /** 短提示 */
    private fun toast(msg: String) = Toast.makeText(this, msg, Toast.LENGTH_SHORT).show()

    /** 收起软键盘（备用：弹窗保存后调用，避免键盘遮挡） */
    @Suppress("unused")
    private fun hideKeyboard(v: View) {
        (getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager)
            ?.hideSoftInputFromWindow(v.windowToken, 0)
    }
}
