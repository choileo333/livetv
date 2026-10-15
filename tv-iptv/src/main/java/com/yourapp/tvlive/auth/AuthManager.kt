package com.yourapp.tvlive.auth

import android.content.Context
import com.yourapp.tvlive.storage.ConfigStore
import com.yourapp.tvlive.util.DeviceUtil

/**
 * 自有账号/激活体系。
 * 这里实现的是「你自己的」设备激活流程，使用 Android ID 作为设备凭依，
 * 与原 App 的微信扫码 / 第三方 license 校验完全无关。
 *
 * 生产环境建议：
 *   1) 调用你自己的后端接口做设备注册，换取登录 token；
 *   2) token 存入 ConfigStore（MMKV）；
 *   3) 之后的请求都带上该 token。
 */
class AuthManager(private val context: Context) {

    /**
     * 设备激活：生成/保存设备 ID，并向自有后端换取 token。
     * 此处用本地模拟（占位 token），请替换成真实后端调用。
     * @return 是否激活成功
     */
    fun activateDevice(): Boolean {
        // 1) 取得自有设备 ID 并持久化
        val deviceId = DeviceUtil.getDeviceId(context)
        ConfigStore.saveDeviceId(deviceId)

        // 2) 调用自有后端激活（伪代码，替换为你的 API）：
        //    val resp = yourApi.activate(deviceId)
        //    ConfigStore.saveToken(resp.token)

        // 3) 本地模拟：写入占位 token
        ConfigStore.saveToken("local-demo-token-$deviceId")
        return true
    }

    /** 是否已激活（有 token 即视为已激活） */
    fun isActivated(): Boolean = ConfigStore.getToken().isNotBlank()

    /** 退出登录：清空 token */
    fun logout() = ConfigStore.saveToken("")
}
