package com.yourapp.tvlive.receiver

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import com.yourapp.tvlive.storage.ConfigStore
import com.yourapp.tvlive.ui.MainActivity

/**
 * 开机自启广播接收器。
 * 行为：仅在用户开启了「自动启动」偏好时才拉起主界面。
 * 这是你自己的偏好开关控制，不复制原 App 的任何自启逻辑。
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent) {
        // 仅响应开机完成 / 部分盒子的 QUICKBOOT 广播
        if (intent.action == Intent.ACTION_BOOT_COMPLETED ||
            intent.action == "android.intent.action.QUICKBOOT_POWERON"
        ) {
            if (ConfigStore.isAutoBoot()) {
                // 以新任务方式启动主界面
                val launch = Intent(context, MainActivity::class.java).apply {
                    addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
                }
                context.startActivity(launch)
            }
        }
    }
}
