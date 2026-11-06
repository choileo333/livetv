package com.leo.tvlive.data

/**
 * 流类型（MIME）推断工具。
 *
 * 为什么需要它（v1.0.1 修复的真机播放报错）：
 *   播放地址经中继包装后形如 https://后端/api/relay?url=<源地址>，
 *   **路径里没有 .m3u8 后缀**；而 Media3 的 DefaultMediaSourceFactory 默认只靠
 *   URI 后缀猜解析器 —— 猜不出就直接按「普通 MP4」处理，
 *   把 m3u8 纯文本当视频容器读，于是抛
 *   ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED（真机截图实测报错）。
 *   解决办法：显式声明 MIME，工厂才会走 HLS 解析器。
 *
 * 实现上刻意不引用任何 Android / Media3 类，只用纯字符串判断，
 * 这样本逻辑可以直接用「纯 JVM 单元测试」验证，不需要模拟器或真机。
 */
object MimeHint {

    /**
     * HLS 播放列表的标准 MIME 值。
     * 与 androidx.media3.common.MimeTypes.APPLICATION_M3U8 的取值完全一致，
     * 这里写成字面量是为了避免为了一个常量而让本文件依赖 Media3。
     */
    const val HLS = "application/x-mpegURL"

    /**
     * 依据「源地址」推断 MIME。
     *
     * @param sourceUrl 频道原始播放地址（**不是**中继地址，中继地址已丢失后缀信息）
     * @return HLS 流返回 [HLS]；无法确定时返回 null（交给播放器自行嗅探，适用于普通 MP4 等）
     */
    fun of(sourceUrl: String): String? =
        if (sourceUrl.contains(".m3u8", ignoreCase = true)) HLS else null
}
