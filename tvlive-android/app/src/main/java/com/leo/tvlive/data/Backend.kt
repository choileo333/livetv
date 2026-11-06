package com.leo.tvlive.data

import java.net.URLEncoder

/**
 * 后端接口地址构造器。
 *
 * 统一在这里拼接 URL，好处是：接口路径只写一次，改动时不会漏；
 * 且所有参数都经过编码，避免流地址里的 & 与 ? 破坏外层 URL 结构。
 *
 * 注意：编码使用纯 JDK 的 URLEncoder 而非 Android 的 Uri.encode，
 *      这样本模块的核心逻辑可以在**纯 JVM 单元测试**里直接验证（无需模拟器/真机）。
 */
object Backend {

    /** 默认后端地址：线上部署的实例（可在 App 界面里改成局域网自建地址） */
    const val DEFAULT_BASE = "https://tvlive-relay.app.workbuddy.host"

    /** 去掉用户可能误输入的结尾斜杠，保证拼接结果不会出现 "//api" */
    private fun norm(base: String): String = base.trim().trimEnd('/')

    /**
     * 对查询参数值做编码。
     * URLEncoder 会把空格编成 "+"，但 "+" 在查询串里表示空格、在路径里则是字面加号，
     * 统一替换成 %20 可消除歧义；其余字符（含 : / ? & =）都会被正确转义。
     */
    private fun enc(s: String): String =
        URLEncoder.encode(s, "UTF-8").replace("+", "%20")

    /** 频道列表接口 */
    fun channels(base: String): String = "${norm(base)}/api/channels"

    /** 配置接口（返回版本号与回放站地址） */
    fun config(base: String): String = "${norm(base)}/api/config"

    /**
     * 中继播放接口（后端真实路径，已实测可用）。
     * 作用：服务端代取流并补上源站要求的 Referer，破解地域封锁与防盗链。
     * 注意：URL 参数必须整体编码——原始流地址自带 ? 与 & 参数，不编码会破坏外层 URL 结构。
     */
    fun relay(base: String, rawUrl: String): String =
        "${norm(base)}/api/relay?url=${enc(rawUrl)}"

    /** 内嵌代理接口：用于回放（服务端会补 Referer + 注入播放器补丁） */
    fun embed(base: String, target: String): String =
        "${norm(base)}/api/embed?url=${enc(target)}"

    /**
     * 计算「实际拿去播放的地址」——**与网页版 `app.js` 的规则完全一致**。
     *
     * 网页版原句：`const useRelay = relayOn && ch.relay !== false;`
     * 即：默认走中继；但频道被后端标了 `relay:false` 时改走**本机直连**。
     *
     * 为什么这条规则必须由 App 也遵守：
     *   `relay:false` 是后端给出的明确信号——「这个源连上海中继都够不到，
     *   只有播放端自己直连才有机会」。App 若无视它、照样套中继，这些台必然失败。
     *
     * 写成纯字符串函数（不碰 Android API），因此可被**纯 JVM 单元测试**直接覆盖。
     *
     * @param base   后端地址
     * @param rawUrl 频道源地址（后端返回的原始 url）
     * @param relay  该频道是否允许中继（来自 Channel.relay）
     * @return relay 为 true 时返回中继地址；为 false 时原样返回源地址
     */
    fun playUrl(base: String, rawUrl: String, relay: Boolean): String =
        if (relay) relay(base, rawUrl) else rawUrl

    /**
     * 播放方式的展示文案，用于状态行。
     * 用户需要能一眼看出「这一台是走中继还是本机直连」——这正是与网页版对齐后新增的信息。
     */
    fun relayLabel(relay: Boolean): String = if (relay) "经中继" else "本机直连"
}
