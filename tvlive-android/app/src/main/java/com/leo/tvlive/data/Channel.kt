package com.leo.tvlive.data

/**
 * 频道数据模型。
 *
 * @param id    频道编号（后端分配，如 101；用于收藏标记与「上次观看」记录）
 * @param name  频道显示名（如 "Arirang TV (1080p)"）
 * @param url   播放源地址（后端返回的原始地址，如 http://xxx/playlist.m3u8）
 *              注意：默认不能直连该地址，必须经中继（见 Backend.relay）；
 *              仅当 [relay] 为 false 时才反过来——必须用它直连。
 * @param logo  频道图标地址（可能为空）
 * @param group 分组名（如 "韩国" / "电影"），用于分组筛选
 * @param relay 是否允许走服务端中继播放。**默认 true**。
 *              后端会把部分频道标成 `"relay": false`，含义是「连部署在上海的中继都够不到这个源，
 *              只能由播放端本机直连」——例如受地域封锁的韩国地面波主台
 *              （KBS 1TV/2TV、JTBC、SBS、MBC 首尔主台）与凤凰卫视中文台。
 *
 *              为什么必须有这个字段（v1.1.1 与网页版对齐的修复）：
 *                网页版 `app.js` 里写的是 `useRelay = relayOn && ch.relay !== false`，
 *                即它会按这个标记决定「走中继」还是「本机直连」；
 *                而安卓端此前**完全忽略**该字段、一律拼中继地址，
 *                导致这批被标 `relay:false` 的台在 App 上必然播放失败，
 *                与网页版行为不一致（即用户反馈的「跟网页版比起来好像少了几个」）。
 */
data class Channel(
    val id: Int,
    val name: String,
    val url: String,
    val logo: String = "",
    val group: String = "",
    val relay: Boolean = true
)
