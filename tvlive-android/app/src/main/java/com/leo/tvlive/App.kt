package com.leo.tvlive

import android.app.Application
import com.leo.tvlive.data.Prefs
import com.leo.tvlive.data.RemoteConfig

/**
 * 应用入口类：在进程启动时做一次全局初始化。
 * 目前做两件事——
 * 1. 初始化本地偏好存储（Prefs 内部持有 SharedPreferences，
 *    必须先于任何界面调用初始化，否则首次读写会抛异常）；
 * 2. 引导远程配置（v1.4.8）：先秒应用上次缓存的 后端地址+网关访问码，
 *    再后台拉取仓库里的 remote-config.json 刷新——
 *    以后换后端域名/换码只需改仓库里的 JSON，所有设备自动跟随，无需重装 App。
 */
class App : Application() {
    override fun onCreate() {
        super.onCreate()
        Prefs.init(this)              // 初始化偏好存储（后端地址 / 收藏 / 上次频道）
        RemoteConfig.bootstrap(this)  // 远程配置：缓存秒应用 + 后台拉新（不阻塞启动）
    }
}
