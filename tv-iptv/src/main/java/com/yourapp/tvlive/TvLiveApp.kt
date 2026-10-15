package com.yourapp.tvlive

import android.app.Application
import com.tencent.mmkv.MMKV

/**
 * 应用全局入口。
 * 作用：在 App 启动时初始化 MMKV（本地加密存储，开源库，密钥由你自己管理）。
 * 这是「你自己 App」的初始化，不依赖任何第三方授权/license 体系。
 */
class TvLiveApp : Application() {
    override fun onCreate() {
        super.onCreate()
        // 初始化 MMKV：会在内部生成/读取默认加密存储实例
        MMKV.initialize(this)
    }
}
