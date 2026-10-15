package com.yourapp.tvlive.util

import android.content.Context
import android.provider.Settings
import java.util.UUID

/**
 * 自有设备标识生成器。
 * 说明：这里用 Android ID（设备重置前稳定）作为设备唯一标识，
 * 与原 App 读取 MAC 地址的做法无关，也不涉及任何第三方授权绑定逻辑。
 * 如果你有自有后端，可用它来做「设备注册 / 激活」的凭依。
 */
object DeviceUtil {
    fun getDeviceId(context: Context): String {
        // 读取 Android ID（系统级稳定标识）
        val androidId = Settings.Secure.getString(
            context.contentResolver,
            Settings.Secure.ANDROID_ID
        )
        // 过滤掉已知的虚拟/无效值，必要时用随机 UUID 兜底
        if (!androidId.isNullOrBlank() && androidId != "9774d56d682e549c") {
            return androidId
        }
        return UUID.randomUUID().toString()
    }
}
