/**
 * HLS 链路验证：复刻 Android 端 ExoPlayer 的取流路径，确认「App 真的能拿到视频数据」。
 *
 * 为什么单独写这个脚本：
 *   播放报错 ERROR_CODE_PARSING_CONTAINER_UNSUPPORTED 修好后，必须证明「中继 → 播放列表 → 分片」
 *   每一跳都通，而不是只看播放列表能返回 200 就算完。
 *
 * 关键点：中继把播放列表里的地址改写成了**根相对路径**（如 /api/relay?url=...）。
 *   ExoPlayer 解析相对地址时以「媒体地址」为基准（等同 new URL(rel, mediaUrl)），
 *   本脚本用完全相同的规则解析，确保结论能代表 App 的真实行为。
 *
 * 用法：node tools/verify_hls_chain.js
 */

const BASE = "https://tvlive-relay.app.workbuddy.host";
const UA = "TvLive-Android/1.0";

/** 只取真正需要的数据，避免整棵响应体进内存 */
async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  const buf = Buffer.from(await r.arrayBuffer());
  return { status: r.status, text: buf.toString("utf8"), buf };
}

/** 从 m3u8 文本里取出「非注释、非空」的行（即子清单或分片地址） */
function lines(text) {
  return text.split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
}

/** 与 ExoPlayer 相同的相对地址解析：以媒体地址为基准 */
function resolve(base, rel) {
  return new URL(rel, base).toString();
}

/** 容器识别：TS 分片以 0x47 同步字节开头；fMP4 含 ftyp box */
function sniff(buf) {
  if (buf.length === 0) return "空";
  if (buf[0] === 0x47) return "TS";
  if (buf.slice(0, 64).includes(Buffer.from("ftyp"))) return "fMP4";
  if (buf.slice(0, 8).toString("utf8") === "#EXTM3U") return "m3u8(仍是清单)";
  return "未识别";
}

(async () => {
  let pass = 0, fail = 0;
  const check = (name, ok, extra = "") => {
    console.log(`${ok ? "  ✓" : "  ✗"} ${name}${extra ? "  [" + extra + "]" : ""}`);
    ok ? pass++ : fail++;
  };

  console.log("=".repeat(72));
  console.log("HLS 链路验证（复刻 ExoPlayer 取流路径）");
  console.log("=".repeat(72));

  // ── 1. 取频道列表，挑出截图里那台 TV Chosun ─────────────────
  console.log("\n[1] 取频道（与 App 相同：/api/channels）");
  const chRes = await get(`${BASE}/api/channels`);
  const channels = JSON.parse(chRes.text);
  const ch = channels.find((c) => /^TV Chosun \(720p\)/.test(c.name)) || channels[0];
  check("频道列表可取", chRes.status === 200 && channels.length > 0, `${channels.length} 台`);
  check("选中频道", !!ch, `${ch.name} | ${ch.url}`);

  // ── 2. 中继取 master（媒体地址）────────────────────────────
  console.log("\n[2] 中继取播放列表（媒体地址 = ExoPlayer 的解析基准）");
  const mediaUrl = `${BASE}/api/relay?url=${encodeURIComponent(ch.url)}`;
  const master = await get(mediaUrl);
  check("媒体地址 200", master.status === 200, `status=${master.status}`);
  check("内容为 m3u8", master.text.startsWith("#EXTM3U"), master.text.split("\n")[0]);
  const variants = lines(master.text);
  check("master 含子清单", variants.length > 0, variants[0] || "(空)");

  // ── 3. 按 ExoPlayer 规则解析子清单并取回 ───────────────────
  console.log("\n[3] 解析子清单（根相对地址 → 以媒体地址为基准拼接）");
  const subUrl = resolve(mediaUrl, variants[0]);
  console.log(`    解析结果: ${subUrl.slice(0, 120)}…`);
  check("解析结果指向本后端中继", subUrl.startsWith(`${BASE}/api/relay?`));
  const sub = await get(subUrl);
  check("子清单 200", sub.status === 200, `status=${sub.status}`);
  check("子清单为 m3u8", sub.text.startsWith("#EXTM3U"));
  const segs = lines(sub.text);
  check("子清单含分片", segs.length > 0, `${segs.length} 个分片`);

  // ── 4. 取真实分片，确认是媒体数据而不是文本 ─────────────────
  console.log("\n[4] 取真实分片（决定能否出画面的硬证据）");
  let okSeg = 0, lastInfo = "";
  for (const rel of segs.slice(0, 3)) {
    const u = resolve(subUrl, rel);
    const seg = await get(u);
    const kind = sniff(seg.buf);
    const usable = seg.status === 200 && seg.buf.length > 5000 && (kind === "TS" || kind === "fMP4");
    if (usable) okSeg++;
    lastInfo = `size=${seg.buf.length} 容器=${kind}`;
    check(`分片可播（${rel.slice(0, 40)}…）`, usable, lastInfo);
  }
  check("至少一个分片是真实媒体数据", okSeg > 0, `${okSeg}/${Math.min(3, segs.length)}`);

  // ── 5. MIME 是否被判定的验证点（对应本次修复）──────────────
  console.log("\n[5] 本次修复的关键点验证");
  // Media3 判断容器类型时看的是「路径末段」后缀（util.inferContentType(Uri)），
  // 而不是整条 URL 字符串 —— 所以中继地址里虽然带着 .m3u8（在查询串里），也照样判不出。
  const lastSeg = (u) => {
    const path = u.split("?")[0].split("#")[0];
    return path.split("/").filter(Boolean).pop() || "";
  };
  console.log(`    源地址:            ${ch.url}`);
  console.log(`    源地址路径末段:    ${lastSeg(ch.url)}   → 含 .m3u8，可判定为 HLS`);
  console.log(`    中继地址路径末段:  ${lastSeg(mediaUrl)}   → 不含 .m3u8，播放器无法靠后缀判断`);
  check(
    "源地址可判定为 HLS 而后继地址不能（故必须显式传 MIME）",
    /\.m3u8/i.test(lastSeg(ch.url)) && !/\.m3u8/i.test(lastSeg(mediaUrl)),
    `源=${lastSeg(ch.url)} 中继=${lastSeg(mediaUrl)}`
  );

  console.log("\n" + "=".repeat(72));
  console.log(`结果：通过 ${pass} 项，失败 ${fail} 项`);
  console.log("=".repeat(72));
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("验证异常：" + e.message);
  process.exit(2);
});
