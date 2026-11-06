package com.leo.tvlive.player

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory   // 注意：该类位于 ...exoplayer.source 包下

/**
 * 直播播放器封装（基于 Media3 / ExoPlayer，Apache-2.0 开源）。
 *
 * 关键设计一：播放地址必须传入「中继地址」而非源站地址（`relay:false` 的频道除外）。
 *   原因：频道源普遍存在地域封锁与 Referer 校验，直连大概率加载失败；
 *         网页版之所以能播，正是因为所有流请求都走了后端 /api/relay 中继。
 *         本类只负责播放，地址由调用方经 Backend.playUrl() 按频道的 relay 标记决定。
 *
 * 关键设计二：必须显式告诉播放器「这是 HLS」。
 *   DefaultMediaSourceFactory 默认只靠 URI 后缀猜解析器，而中继地址形如
 *   https://后端/api/relay?url=...，路径里没有 .m3u8，于是它按普通 MP4 解析，
 *   把 m3u8 文本当视频容器读 → 抛 ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
 *   （真机实测复现）。故 play() 增加 mimeType 参数，由调用方按源地址推断后传入。
 */
class LivePlayer(
    context: Context,
    /** 播放出错时的回调（在主线程触发），参数为可读的错误码名 */
    private val onError: (String) -> Unit = {}
) {

    /** 暴露底层 ExoPlayer，供 PlayerView 绑定 */
    val exo: ExoPlayer = ExoPlayer.Builder(context).build().apply {
        playWhenReady = true   // 准备完成后自动播放
        // 监听播放错误：直播流常见「源不可达 / 403」，需要把错误反馈到界面，避免用户面对黑屏无从判断
        addListener(object : Player.Listener {
            override fun onPlayerError(error: PlaybackException) {
                onError(error.errorCodeName)
            }
        })
    }

    /**
     * 播放指定地址（应为中继地址）。
     * 每次调用都会先清空上一条媒体，避免切换频道时旧流残留。
     *
     * @param url      播放地址（通常为中继地址）
     * @param mimeType 媒体类型；传 null/空则交由播放器按地址自行嗅探。
     *                 HLS 流必须传 application/x-mpegURL，否则会解析失败。
     */
    fun play(url: String, mimeType: String? = null) {
        exo.stop()             // 停止当前播放
        exo.clearMediaItems()  // 清空媒体队列

        // 统一的 HTTP 数据源：设置超时与重定向策略
        val httpFactory = DefaultHttpDataSource.Factory()
            .setUserAgent("TvLive-Android/1.0")          // 部分 CDN 需要 UA
            .setConnectTimeoutMs(15000)                   // 连接超时 15 秒
            .setReadTimeoutMs(15000)                      // 读取超时 15 秒
            .setAllowCrossProtocolRedirects(true)         // 允许跨协议重定向（http→https 常见）

        // 组装媒体项：把 MIME 显式带上（中继地址没有 .m3u8 后缀，不声明会被当成普通视频解析而报错）
        val item = MediaItem.Builder()
            .setUri(url)
            .apply { if (!mimeType.isNullOrEmpty()) setMimeType(mimeType) }
            .build()

        // DefaultMediaSourceFactory 会依据 MediaItem 上的 MIME 选择解析器
        // （mimeType=application/x-mpegURL → HLS 解析器）
        val source = DefaultMediaSourceFactory(httpFactory).createMediaSource(item)

        exo.setMediaSource(source)   // 装载媒体源
        exo.prepare()                // 开始准备（异步）
        exo.playWhenReady = true     // 就绪即播
    }

    /** 暂停播放（切换到回放时调用，避免直播声音与回放声音叠加） */
    fun pause() {
        exo.playWhenReady = false
    }

    /** 释放播放器资源（界面销毁时必须调用） */
    fun release() {
        exo.release()
    }
}
