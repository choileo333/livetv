package com.yourapp.tvlive.storage

import com.tencent.mmkv.MMKV

/**
 * 本地存储封装（基于 MMKV，开源）。
 * 负责保存：登录 token、设备 ID、用户偏好（自动启动、上次频道）。
 * 全部使用你自己管理的存储，不读取/不复制原 App 的任何密钥。
 */
object ConfigStore {
    // 取得默认 MMKV 实例（MMKV.initialize 之后即可使用）
    private val kv = MMKV.defaultMMKV()!!

    // —— 账号与设备激活 ——
    fun saveToken(token: String) = kv.encode("auth_token", token)   // 保存登录 token
    fun getToken(): String = kv.decodeString("auth_token", "") ?: "" // 读取 token，缺省空串
    fun saveDeviceId(id: String) = kv.encode("device_id", id)        // 保存设备 ID
    fun getDeviceId(): String = kv.decodeString("device_id", "") ?: ""

    // —— 用户偏好 ——
    fun setAutoBoot(on: Boolean) = kv.encode("auto_boot", on)        // 是否开机自启
    fun isAutoBoot(): Boolean = kv.decodeBool("auto_boot", false)    // 默认关闭
    fun setLastChannel(id: Int) = kv.encode("last_channel", id)      // 记住上次看的频道
    fun getLastChannel(): Int = kv.decodeInt("last_channel", 1)      // 默认 1 号

    // —— 后端地址（你自己的频道/EPG 服务）——
    // TV 盒子上改成局域网/公网 IP，例如 "http://192.168.1.10:8899"
    fun setBackendUrl(url: String) = kv.encode("backend_url", url)
    fun getBackendUrl(): String =
        kv.decodeString("backend_url", "http://localhost:8899") ?: "http://localhost:8899"

    // —— 收藏（频道编号集合，存为字符串 Set）——
    private fun favSet(): MutableSet<String> =
        (kv.decodeStringSet("favorites", mutableSetOf()) ?: mutableSetOf())

    fun isFavorite(id: Int): Boolean = favSet().contains(id.toString())
    fun toggleFavorite(id: Int) {
        val s = favSet()
        val k = id.toString()
        if (s.contains(k)) s.remove(k) else s.add(k)
        kv.encode("favorites", s)
    }
}
