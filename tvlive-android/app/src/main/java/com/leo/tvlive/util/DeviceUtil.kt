package com.leo.tvlive.util

import android.content.Context
import android.content.pm.PackageManager
import android.content.res.Configuration

/**
 * 设备形态判定工具。
 * 用途：同一份 APK 要同时服务「手机（触屏/竖屏）」与「电视盒子（遥控器/横屏）」，
 *      界面与交互需要按形态分流，故集中在此判断，避免各处重复写判断逻辑。
 */
object DeviceUtil {

    /**
     * 是否为电视类设备。
     * 两重判断，任一命中即视为电视：
     *   1) 系统 UI 模式被标记为 TELEVISION（Android TV / 部分国产电视系统）
     *   2) 系统声明具备 leanback 特性（多数电视盒子会声明）
     */
    fun isTelevision(context: Context): Boolean {
        // 判断一：系统 UI 模式
        val uiMode = context.resources.configuration.uiMode and Configuration.UI_MODE_TYPE_MASK
        if (uiMode == Configuration.UI_MODE_TYPE_TELEVISION) return true

        // 判断二：系统特性（用 try 包住，个别定制系统查询该特性会抛异常）
        return try {
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_LEANBACK)
        } catch (e: Exception) {
            false
        }
    }
}
