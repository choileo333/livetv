package com.yourapp.tvlive.data

import com.yourapp.tvlive.model.EpgProgram
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * 节目单(EPG)数据源：从自有后端 /api/epg?channelId= 拉取。
 * 不依赖任何第三方受保护的 EPG 服务。
 */
object EpgRepository {

    /**
     * 拉取某频道的节目单。
     * @param baseUrl  后端地址
     * @param channelId 频道编号
     * @return 节目列表（按时间升序）；失败返回空列表
     */
    fun loadEpg(baseUrl: String, channelId: Int): List<EpgProgram> {
        return try {
            val conn = URL("$baseUrl/api/epg?channelId=$channelId").openConnection() as HttpURLConnection
            conn.connectTimeout = 8000
            conn.readTimeout = 8000
            val txt = conn.inputStream.bufferedReader().readText()
            conn.disconnect()
            val arr = JSONObject(txt).optJSONArray("programs") ?: return emptyList()
            val out = mutableListOf<EpgProgram>()
            for (i in 0 until arr.length()) {
                val o = arr.getJSONObject(i)
                out.add(
                    EpgProgram(
                        title = o.optString("title"),
                        start = o.optLong("start"),
                        end = o.optLong("end"),
                        desc = o.optString("desc", "")
                    )
                )
            }
            out
        } catch (e: Exception) {
            emptyList()
        }
    }
}
