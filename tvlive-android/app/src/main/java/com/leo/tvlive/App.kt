package com.leo.tvlive

import android.app.Application
import com.leo.tvlive.data.Prefs

/**
 * 应用入口类：在进程启动时做一次全局初始化。
 * 目前只做一件事——初始化本地偏好存储（Prefs 内部持有 SharedPreferences，
 * 必须先于任何界面调用初始化，否则首次读写会抛异常）。
 */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)   // 初始化偏好存储（后端地址 / 收藏 / 上次频道）
    }
}
