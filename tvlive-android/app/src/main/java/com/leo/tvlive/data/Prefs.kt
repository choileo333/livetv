package com.leo.tvlive.data

import android.content.Context
import android.content.SharedPreferences

/**
 * 本地偏好存储（基于系统自带 SharedPreferences，不引入第三方存储库）。
 * 保存内容：后端地址、上次观看的频道、收藏的频道编号集合。
 */
object Prefs {

    private const val FILE_NAME = "tvlive_prefs"   // 存储文件名
    private const val K_BASE = "backend_url"       // 后端地址
    private const val K_LAST = "last_channel"      // 上次观看频道编号
    private const val K_FAV = "favorites"          // 收藏集合

    private lateinit var sp: SharedPreferences

    /** 在 Application 启动时调用一次即可 */
    fun init(context: Context) {
        if (!::sp.isInitialized) {
            sp = context.applicationContext.getSharedPreferences(FILE_NAME, Context.MODE_PRIVATE)
        }
    }

    /** 后端地址（默认指向线上实例） */
    var backendUrl: String
        get() = sp.getString(K_BASE, Backend.DEFAULT_BASE) ?: Backend.DEFAULT_BASE
        set(value) = sp.edit().putString(K_BASE, value.trim()).apply()

    /** 上次观看的频道编号（-1 表示没有记录） */
    var lastChannelId: Int
        get() = sp.getInt(K_LAST, -1)
        set(value) = sp.edit().putInt(K_LAST, value).apply()

    /** 收藏集合（存字符串集合，跨版本升级更安全） */
    private fun favSet(): MutableSet<String> =
        (sp.getStringSet(K_FAV, emptySet()) ?: emptySet()).toMutableSet()

    fun isFavorite(id: Int): Boolean = favSet().contains(id.toString())

    /** 切换收藏状态，返回切换后的结果（true=已收藏） */
    fun toggleFavorite(id: Int): Boolean {
        val set = favSet()
        val key = id.toString()
        val nowFav: Boolean
        if (set.contains(key)) {
            set.remove(key); nowFav = false
        } else {
            set.add(key); nowFav = true
        }
        sp.edit().putStringSet(K_FAV, set).apply()
        return nowFav
    }
}
