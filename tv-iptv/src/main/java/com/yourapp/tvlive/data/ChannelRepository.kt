package com.yourapp.tvlive.data

import com.yourapp.tvlive.model.Channel
import org.json.JSONArray
import java.net.HttpURLConnection
import java.net.URL

/**
 * 频道数据源。
 * 优先从「你自己的后端」(/api/channels) 拉取；失败回退到本地列表。
 * 这里不连接任何第三方受保护的频道后台（如原 App 的 ForceTV 授权服务）。
 */
object ChannelRepository {

    /**
     * 从自有后端拉取频道列表。
     * @param baseUrl 后端地址，例如 "http://192.168.1.10:8899"
     * @return 成功返回频道列表；网络/解析失败返回 null（调用方应回退本地列表）
     */
    fun loadFromBackend(baseUrl: String): List<Channel>? {
        return try {
            val conn = URL("$baseUrl/api/channels").openConnection() as HttpURLConnection
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            if (conn.responseCode != 200) return null
            val txt = conn.inputStream.bufferedReader().readText()
            conn.disconnect()
            parseChannels(txt)
        } catch (e: Exception) {
            null
        }
    }

    /** 解析后端返回的 JSON 数组（用 Android 内置 org.json，不引第三方库） */
    private fun parseChannels(json: String): List<Channel> {
        val arr = JSONArray(json)
        val out = mutableListOf<Channel>()
        for (i in 0 until arr.length()) {
            val o = arr.getJSONObject(i)
            out.add(
                Channel(
                    id = o.optInt("id"),
                    name = o.optString("name"),
                    url = o.optString("url"),
                    logo = o.optString("logo", ""),
                    group = o.optString("group", "")
                )
            )
        }
        return out
    }

    /**
     * 本地兜底频道列表（无后端时使用）。
     * TODO: 把示例地址换成你有权播放的内容；或部署 backend/ 作为你自己的源。
     */
    fun loadChannels(): List<Channel> = listOf(
        Channel(1, "示例频道 1", "https://example.com/live/1/index.m3u8", group = "示例"),
        Channel(2, "示例频道 2", "rtsp://example.com/live/2", group = "示例"),
        Channel(3, "示例频道 3", "https://example.com/live/3/index.m3u8", group = "示例")
    )

    /** 按频道编号查找（数字键盘切台用） */
    fun findByNumber(num: Int, list: List<Channel>): Channel? =
        list.firstOrNull { it.id == num }
}
