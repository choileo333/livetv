package com.yourapp.tvlive.model

/**
 * 节目单(EPG)单条数据模型（自有定义）。
 * @param title 节目名
 * @param start 开始时间（毫秒时间戳）
 * @param end   结束时间（毫秒时间戳）
 * @param desc  简介（可选）
 */
data class EpgProgram(
    val title: String,
    val start: Long,
    val end: Long,
    val desc: String = ""
)
