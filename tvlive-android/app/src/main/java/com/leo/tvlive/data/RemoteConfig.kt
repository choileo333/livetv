package com.leo.tvlive.data

import android.content.Context
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 远程配置发现（v1.4.8）——让「换后端域名/换网关访问码」从此不再需要重装 App。
 *
 * 工作原理：
 * 1. 后端仓库里维护一个极小的 JSON：`tv-iptv/backend/remote-config.json`（base + sharecode）。
 * 2. App 启动时从多个镜像源拉取它（GitHub CDN / 直连，都是与后端部署无关的稳定地址）。
 * 3. 解析后**先做健康校验**：真实请求 `base/api/health?sharecode=码`，返回 ok:true 才应用——
 *    防止镜像内容陈旧或被篡改的坏配置把 App 带沟里。
 * 4. 应用 = 更新 Backend.shareCode + （用户没手动改过后端时）更新 Prefs.backendUrl，
 *    并把配置缓存进本地——下次启动秒应用，不等网络。
 *
 * 维护流程（换后端时）：改 remote-config.json → 推 GitHub main → 全部设备下次启动自动跟随。
 */
object RemoteConfig {

    /** 配置源（按优先级）：前两个是国内可达的 GitHub 镜像，最后是官方直连 */
    private val SOURCES = listOf(
        "https://cdn.jsdelivr.net/gh/choileo333/livetv@main/tv-iptv/backend/remote-config.json",
        "https://gh-proxy.com/https://raw.githubusercontent.com/choileo333/livetv/main/tv-iptv/backend/remote-config.json",
        "https://raw.githubusercontent.com/choileo333/livetv/main/tv-iptv/backend/remote-config.json"
    )

    private const val FETCH_TIMEOUT_MS = 6000    // 单个源的超时：配置很小，6 秒足够
    private const val HEALTH_TIMEOUT_MS = 8000   // 健康校验超时（后端首次冷启动可能慢些）

    /** 解析结果：base=后端地址，code=网关访问码 */
    data class Cfg(val base: String, val code: String)

    /**
     * 纯 JVM 可测：解析配置文本。base 必须以 http(s):// 开头、sharecode 非空，否则返回 null。
     * 有意忽略未知字段（如 note/updated/v），向前兼容未来加字段。
     */
    fun parse(text: String): Cfg? = try {
        val o = JSONObject(text)
        val b = o.getString("base").trim()
        val c = o.getString("sharecode").trim()
        if ((b.startsWith("http://") || b.startsWith("https://")) && c.isNotEmpty()) Cfg(b, c) else null
    } catch (e: Exception) {
        null
    }

    /** Application.onCreate 调用：先秒应用缓存，再后台拉新 */
    fun bootstrap(context: Context) {
        Prefs.cachedRemoteCfg?.let { raw ->
            parse(raw)?.let { apply(it, persist = false) }
        }
        Thread { fetchAndApply() }.start()   // 后台拉新，绝不阻塞启动
    }

    /** 逐源尝试拉取 → 校验 → 应用。全部失败则静默保留现状（内置默认或上次缓存）。 */
    fun fetchAndApply() {
        for (src in SOURCES) {
            try {
                val text = httpGet(src, FETCH_TIMEOUT_MS) ?: continue
                val cfg = parse(text) ?: continue
                if (!healthy(cfg)) continue            // 健康校验不过 = 配置不可信，试下一个源
                apply(cfg, persist = true)
                return
            } catch (e: Exception) {
                // 单个源失败不影响其它源；全部失败保留现状即可
            }
        }
    }

    /** 应用配置：码必换；base 仅在用户未手动指定后端时跟随（尊重用户填的局域网地址） */
    private fun apply(cfg: Cfg, persist: Boolean) {
        Backend.shareCode = cfg.code
        if (!Prefs.backendCustomized) Prefs.backendUrl = cfg.base
        if (persist) Prefs.cachedRemoteCfg =
            JSONObject().put("base", cfg.base).put("sharecode", cfg.code).toString()
    }

    /** 健康校验：真实请求后端 /api/health，2xx 且返回 ok:true 才算通过 */
    private fun healthy(cfg: Cfg): Boolean = try {
        val u = "${cfg.base.trimEnd('/')}/api/health?sharecode=${cfg.code}"
        val text = httpGet(u, HEALTH_TIMEOUT_MS) ?: return false
        JSONObject(text).optBoolean("ok", false)
    } catch (e: Exception) {
        false
    }

    /** 极简 GET（纯 JDK，无第三方依赖），失败/非 2xx 返回 null */
    private fun httpGet(url: String, timeoutMs: Int): String? = try {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = timeoutMs
        c.readTimeout = timeoutMs
        c.instanceFollowRedirects = true
        c.setRequestProperty("User-Agent", "TvLiveApp/1.4.8")
        if (c.responseCode in 200..299) c.inputStream.bufferedReader().use { it.readText() } else null
    } catch (e: Exception) {
        null
    }
}
