package com.leo.tvlive

import com.leo.tvlive.data.Backend
import com.leo.tvlive.data.ChannelRepo
import com.leo.tvlive.data.MimeHint
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/**
 * 核心逻辑单元测试（纯 JVM，无需模拟器/真机即可运行）。
 *
 * 覆盖范围：URL 构造（中继/内嵌/频道接口）+ 频道 JSON 解析。
 * 这些正是「App 能不能拿到频道、能不能播」的关键前置逻辑，
 * 属于即便没有设备也能自动验证的部分。
 */
class CoreLogicTest {

    /** 取自后端 /api/channels 的真实响应片段（原样复制，含 ? 参数，用于验证编码与解析） */
    private val realChannelJson = """
        [{"id":101,"name":"TV Chosun (720p)",
          "url":"http://onair.cdn.tvchosun.com/origin1/_definst_/tvchosun_s1/playlist.m3u8?t=abc&n=1",
          "logo":"https://i.imgur.com/62EwaCG.png","group":"韩国"}]
    """.trimIndent()

    // ── URL 构造 ─────────────────────────────────────────────

    @Test
    fun relay_encodes_stream_url_completely() {
        // 中继地址必须把整条流地址编码：其中的 ? 与 & 若不编码，会变成外层 URL 的参数
        val out = Backend.relay(
            "https://tvlive-relay.app.workbuddy.host",
            "http://a.com/x.m3u8?t=1&n=2"
        )
        assertEquals(
            "https://tvlive-relay.app.workbuddy.host/api/relay?url=http%3A%2F%2Fa.com%2Fx.m3u8%3Ft%3D1%26n%3D2",
            out
        )
    }

    @Test
    fun base_url_with_trailing_slash_does_not_produce_double_slash() {
        // 用户手输后端地址时常带结尾斜杠，必须规范化，否则会拼出 "//api/channels"
        assertEquals("https://x.com/api/channels", Backend.channels("https://x.com/"))
        assertEquals("https://x.com/api/channels", Backend.channels("https://x.com//"))
        // 前后空格也要容错
        assertEquals("https://x.com/api/channels", Backend.channels("  https://x.com/  "))
    }

    @Test
    fun embed_encodes_replay_target() {
        // 回放地址同样需要整体编码
        val out = Backend.embed("https://b.com", "https://www.dodotv20.com/show.php?tid=3&order_type=")
        assertTrue(out.startsWith("https://b.com/api/embed?url="))
        // 编码后不应再出现裸露的 "?" 与 "&"（它们必须成为 %3F / %26）
        val paramPart = out.substringAfter("url=")
        assertTrue("参数部分不应含裸露的 &", !paramPart.contains("&"))
        assertTrue("参数部分不应含裸露的 ?", !paramPart.contains("?"))
    }

    // ── JSON 解析 ────────────────────────────────────────────

    @Test
    fun parses_real_backend_channel_json() {
        val list = ChannelRepo.parseChannels(realChannelJson)
        assertEquals(1, list.size)
        val ch = list[0]
        assertEquals(101, ch.id)
        assertEquals("TV Chosun (720p)", ch.name)
        assertEquals("韩国", ch.group)
        // 带 ? 参数的流地址必须被完整解析出来，不能在中途被截断
        assertTrue(ch.url.endsWith("playlist.m3u8?t=abc&n=1"))
    }

    @Test
    fun filters_out_channels_without_url() {
        // 没有播放地址的条目应在解析阶段被丢弃，避免列表里出现「点了没反应」的项
        val json = """
            [{"id":1,"name":"有地址","url":"http://a/x.m3u8","group":"G"},
             {"id":2,"name":"无地址","url":"","group":"G"}]
        """.trimIndent()
        val list = ChannelRepo.parseChannels(json)
        assertEquals(1, list.size)
        assertEquals("有地址", list[0].name)
    }

    @Test
    fun tolerates_missing_optional_fields() {
        // 后端若未返回 logo/group，应回退默认值而不是抛异常
        val json = """[{"id":7,"name":"裸数据","url":"http://a/y.m3u8"}]"""
        val list = ChannelRepo.parseChannels(json)
        assertEquals(1, list.size)
        assertEquals("", list[0].logo)
        assertEquals("未分组", list[0].group)
    }

    @Test
    fun builtin_fallback_channels_are_usable() {
        // 后端不可达时的兜底列表必须非空且都带播放地址
        val builtin = ChannelRepo.builtinChannels()
        assertTrue("兜底列表不应为空", builtin.isNotEmpty())
        assertTrue("兜底频道必须有播放地址", builtin.all { it.url.startsWith("http") })
    }

    // ── MIME 推断（v1.0.1 修复真机播放报错的核心逻辑）───────────

    @Test
    fun m3u8_source_is_reported_as_hls() {
        // 背景：播放地址经中继包装后形如 https://后端/api/relay?url=...，路径里没有 .m3u8，
        //      播放器会按普通 MP4 解析 m3u8 文本，抛 ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED
        //      （2026-10-12 真机实测报错）。所以必须拿**源地址**推断出 HLS 显式告知播放器。
        assertEquals(MimeHint.HLS, MimeHint.of("http://onair.cdn.tvchosun.com/origin1/_definst_/tvchosun_s1/playlist.m3u8"))
        assertEquals(MimeHint.HLS, MimeHint.of("http://a/x.m3u8?t=1&n=2"))   // 带 ? 参数的地址也要识别
        assertEquals(MimeHint.HLS, MimeHint.of("http://a/X.M3U8"))          // 大写后缀也要识别
    }

    @Test
    fun non_hls_source_returns_null_so_player_sniffs_itself() {
        // 后端内置的测试台是渐进式 MP4，不应被强行标成 HLS，交给播放器自行嗅探即可
        assertNull(MimeHint.of("https://x/big_buck_bunny.mp4"))
        assertNull(MimeHint.of(""))
    }

    // ── relay 标记（v1.1.1 与网页版对齐的核心逻辑）─────────────
    // 背景：网页版 app.js 写的是 `useRelay = relayOn && ch.relay !== false`，
    //      即按后端标记决定「走中继」还是「本机直连」。
    //      App 此前忽略该标记、一律走中继，导致被标 relay:false 的台（韩国地面波主台）必然失败。
    //      以下用例把这条规则钉死，防止以后又被改回「一律中继」。

    @Test
    fun relay_true_uses_relay_url() {
        val out = Backend.playUrl("https://b.com", "http://a/x.m3u8", relay = true)
        assertEquals("https://b.com/api/relay?url=http%3A%2F%2Fa%2Fx.m3u8", out)
    }

    @Test
    fun relay_false_uses_raw_source_url() {
        // relay:false 的频道必须**原样**直连源地址：
        // 它代表「连上海中继都够不到这个源」，套上中继等于必失败。
        assertEquals(
            "http://123.108.164.71/etv2sb/phd852/playlist.m3u8",
            Backend.playUrl("https://b.com", "http://123.108.164.71/etv2sb/phd852/playlist.m3u8", relay = false)
        )
    }

    @Test
    fun relay_label_is_human_readable() {
        // 状态行要能把「经中继 / 本机直连」讲清楚，方便用户判断失败原因
        assertEquals("经中继", Backend.relayLabel(true))
        assertEquals("本机直连", Backend.relayLabel(false))
    }

    @Test
    fun parses_relay_flag_from_real_backend_json() {
        val list = ChannelRepo.parseChannels(
            """[{"id":1,"name":"默认","url":"http://a/x.m3u8"},
                {"id":2,"name":"直连","url":"http://b/y.m3u8","relay":false}]"""
        )
        // 未写 relay 字段 → 默认 true（与网页版语义一致：不会因为缺字段就改走直连）
        assertTrue("缺省应为 true", list[0].relay)
        // 显式 false → 直连
        assertEquals(false, list[1].relay)
    }

    // ── 与网页版的频道清单一致性（用线上真实响应做夹具）─────────
    // 夹具 app/src/test/resources/channels_live.json 是**线上后端 /api/channels 的原样响应**。
    // 用 App 自己的解析代码跑它，就能证明「App 看到的频道」与「网页版看到的频道」完全一致。

    /** 读取线上响应夹具；读不到就直接失败（否则测试会变成"假通过"） */
    private fun liveFixture(): String =
        javaClass.getResourceAsStream("/channels_live.json")?.bufferedReader(Charsets.UTF_8)?.use { it.readText() }
            ?: error("找不到测试夹具 channels_live.json（应从线上 /api/channels 抓取）")

    @Test
    fun app_sees_same_korean_channels_as_web() {
        val all = ChannelRepo.parseChannels(liveFixture())
        assertEquals("总台数应与网页版一致", 59, all.size)

        // App 的分组过滤规则与网页版一致（按 group 全等筛选）
        val kr = all.filter { it.group == "韩国" }
        assertEquals("韩国组台数应与网页版一致", 31, kr.size)

        // 钉死这 31 个台号：任何一端增删都会被这条断言立刻发现
        assertEquals(
            listOf(
                101, 100, 103, 102, 104, 107, 148, 149, 105, 106, 108, 109,
                118, 119, 121, 122, 126, 144, 145, 146, 147,
                130, 133, 134, 135, 136,
                137, 138, 139, 140, 141
            ),
            kr.map { it.id }
        )

        // 组内不能有重复台号或空地址
        assertEquals("台号不应重复", kr.size, kr.map { it.id }.toSet().size)
        assertTrue("每条都应有播放地址", kr.all { it.url.startsWith("http") })
    }

    @Test
    fun unverified_korean_main_stations_are_marked_direct_connect() {
        // 这 5 个韩国地面波主台（KBS 1TV/2TV、JTBC、SBS、MBC 首尔主台）被后端标成 relay:false：
        // 中继（上海）够不到，只能本机直连。App 必须如实识别，
        // 否则它们会像 v1.1.0 之前那样「出现在列表里但一点就报错」。
        val all = ChannelRepo.parseChannels(liveFixture())
        val direct = all.filter { !it.relay }
        assertEquals(
            "线上 relay:false 的条目",
            listOf(137, 138, 139, 140, 141, 163),
            direct.map { it.id }
        )
        // 其余频道都必须走中继（中继是为破地域封锁而存在的，不能反过来把默认值改错）
        assertEquals("走中继的台数", 59 - 6, all.count { it.relay })
    }
}
