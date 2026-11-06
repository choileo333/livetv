package com.leo.tvlive.data

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 频道与配置的数据仓库。
 *
 * 设计要点：
 *  1) 全部使用 JDK 自带的 HttpURLConnection + Android 自带的 org.json，不引入任何第三方网络库
 *  2) 网络失败一律返回 null（而不是抛异常），由界面层决定「提示错误」还是「回退内置列表」
 *  3) 所有网络调用都必须在后台线程执行（本类不做线程切换，由调用方负责）
 */
object ChannelRepo {

    private const val TIMEOUT_MS = 10000   // 连接与读取超时（10 秒）

    /**
     * 拉取频道列表。
     * @return 成功返回频道列表；网络异常 / 非 200 / 解析失败均返回 null
     */
    fun fetchChannels(baseUrl: String): List<Channel>? {
        val text = httpGet(Backend.channels(baseUrl)) ?: return null
        return try {
            parseChannels(text)
        } catch (e: Exception) {
            null   // JSON 结构不符预期时同样视为失败，交由上层回退
        }
    }

    /**
     * 拉取回放站地址（来自后端 /api/config 的 replayUrl 字段）。
     * 这样「回放地址」可在服务端随时修改，App 不用重装——正是网页版已有的能力。
     * @return 成功返回地址；失败返回 null（调用方用默认地址兜底）
     */
    fun fetchReplayUrl(baseUrl: String): String? {
        val text = httpGet(Backend.config(baseUrl)) ?: return null
        return try {
            val o = JSONObject(text)
            o.optString("replayUrl", "").takeIf { it.isNotBlank() }
        } catch (e: Exception) {
            null
        }
    }

    /** 解析后端返回的 JSON 数组为频道列表（internal 以便单元测试直接验证解析逻辑） */
    internal fun parseChannels(json: String): List<Channel> {
        val arr = JSONArray(json)
        val out = ArrayList<Channel>(arr.length())
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            out.add(
                Channel(
                    id = o.optInt("id", i + 1),
                    name = o.optString("name", "未命名频道"),
                    url = o.optString("url", ""),
                    logo = o.optString("logo", ""),
                    group = o.optString("group", "未分组"),
                    // 缺省视为 true（走中继）：字段不存在时保持网页版的默认语义。
                    // 只有后端显式写 "relay": false 的条目才会被改成「本机直连」。
                    relay = o.optBoolean("relay", true)
                )
            )
        }
        // 过滤掉没有播放地址的条目，避免列表里出现点了没反应的项
        return out.filter { it.url.isNotBlank() }
    }

    /**
     * 通用 GET 请求。
     * @return 200 时返回响应体；其它情况（非 200、超时、DNS 失败等）返回 null
     */
    private fun httpGet(url: String): String? {
        var conn: HttpURLConnection? = null
        return try {
            conn = (URL(url).openConnection() as HttpURLConnection).apply {
                requestMethod = "GET"
                connectTimeout = TIMEOUT_MS
                readTimeout = TIMEOUT_MS
                // 部分服务端会校验 User-Agent，显式带一个标识，避免被当异常流量拦掉
                setRequestProperty("User-Agent", "TvLive-Android/1.0")
            }
            if (conn.responseCode != HttpURLConnection.HTTP_OK) {
                null
            } else {
                conn.inputStream.bufferedReader(Charsets.UTF_8).use { it.readText() }
            }
        } catch (e: Exception) {
            null
        } finally {
            conn?.disconnect()   // 无论成功失败都断开连接，避免连接泄漏
        }
    }

    /**
     * 内置兜底频道（仅在后端完全不可达时使用）。
     * 只放极少量公开源，保证「开屏不白屏、有东西可点」，并附带提示由界面层展示。
     */
    fun builtinChannels(): List<Channel> = listOf(
        Channel(1, "Arirang TV（内置兜底）", "http://amdlive-ch01.ctnd.com.edgesuite.net/arirang_1ch/smil:arirang_1ch.smil/playlist.m3u8", group = "兜底"),
        Channel(2, "TV Chosun（内置兜底）", "http://onair.cdn.tvchosun.com/origin1/_definst_/tvchosun_s1/playlist.m3u8", group = "兜底")
    )
}
