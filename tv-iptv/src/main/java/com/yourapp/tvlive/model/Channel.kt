package com.yourapp.tvlive.model

/**
 * 频道数据模型（完全自有定义）。
 * 注意：这是你自己 App 的数据结构，与原 App 的受保护结构无关。
 *
 * @param id    自有频道编号（用于遥控器数字键盘切台，例如按 1 切到 id=1 的频道）
 * @param name  频道显示名
 * @param url   播放地址，支持 HLS(http/https .m3u8)、RTSP、RTMP
 * @param logo  频道图标地址（可选）
 * @param group 分组名（可选，如「央视」「卫视」）
 */
data class Channel(
    val id: Int,
    val name: String,
    val url: String,
    val logo: String = "",
    val group: String = ""
)
