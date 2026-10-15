package com.yourapp.tvlive.player

import android.content.Context
import androidx.media3.common.MediaItem
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.DefaultMediaSourceFactory
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.hls.HlsMediaSource
import androidx.media3.exoplayer.rtmp.RtmpMediaSource
import androidx.media3.exoplayer.rtsp.RtspMediaSource

/**
 * 播放器封装：基于开源 ExoPlayer（Media3）。
 * 支持 HLS(.m3u8) / RTSP / RTMP，全部为开源协议栈，无第三方 license 依赖。
 *
 * 用法：
 *   val p = VideoPlayer(context)
 *   playerView.player = p.exoPlayer
 *   p.play("https://.../index.m3u8")
 *   // 退出时 p.release()
 */
class VideoPlayer(private val context: Context) {

    // ExoPlayer 实例（Media3 的新类名）
    val exoPlayer: ExoPlayer = ExoPlayer.Builder(context).build()

    /**
     * 播放指定地址。
     * 根据协议头自动选择对应的 MediaSource 工厂。
     */
    fun play(url: String) {
        val mediaItem = MediaItem.fromUri(url)

        // 按协议分流：RTSP / RTMP 需要专用工厂；HLS 与普通 http 走默认工厂
        val source = when {
            url.startsWith("rtsp", ignoreCase = true) ->
                RtspMediaSource.Factory().createMediaSource(mediaItem)
            url.startsWith("rtmp", ignoreCase = true) ->
                RtmpMediaSource.Factory().createMediaSource(mediaItem)
            else -> {
                // HLS / 渐进式：DefaultMediaSourceFactory 会按 URI 自动识别
                val httpFactory = DefaultHttpDataSource.Factory()
                DefaultMediaSourceFactory(httpFactory).createMediaSource(mediaItem)
            }
        }

        exoPlayer.setMediaSource(source)
        exoPlayer.prepare()
        exoPlayer.playWhenReady = true   // 准备就绪立即播放
    }

    /** 释放播放器资源（在 onDestroy 调用） */
    fun release() = exoPlayer.release()
}
