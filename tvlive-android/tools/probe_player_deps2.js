// 播放器内页「依赖可用性」体检：逐个请求它引用的 script/link，报真实 HTTP 状态
const fs = require("fs");
const path = require("path");
const OUT = path.resolve(__dirname, "probe_out");
const PAGE = "https://xiaoca.top/one/onet.php?url=https://wiselife.blog/pop/txz1up1xz33zw11srztpqn1r.m3u8";

(async () => {
  const html = fs.readFileSync(path.join(OUT, "inner_direct.html"), "utf8");
  const urls = [];
  const re = /<(script|link)\b[^>]*?(?:src|href)=("([^"]*)"|'([^']*)')/gi;
  let m;
  while ((m = re.exec(html))) urls.push(m[3] !== undefined ? m[3] : m[4]);

  console.log("播放器页共引用 " + urls.length + " 个外部资源：\n");
  for (const raw of urls) {
    if (/^(data:|blob:)/i.test(raw)) continue;
    let abs;
    try { abs = new URL(raw, PAGE).toString(); } catch (e) { console.log("  ? 无法解析 " + raw); continue; }
    let line = "  " + abs;
    try {
      const r = await fetch(abs, {
        headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://xiaoca.top/one/onet.php" },
      });
      const t = await r.text();
      // 404 页面也能返回 200，故同时看内容特征
      const isHtml404 = /<title>404|不存在|not found/i.test(t.slice(0, 400));
      line = "  [" + r.status + (isHtml404 ? "/内容像404" : "") + "] " + abs + "  (" + t.length + " 字节)";
      if (r.status === 200 && !isHtml404) {
        // 关键全局变量是否在里面定义
        const marks = [];
        if (/\bArtplayer\b/.test(t)) marks.push("Artplayer");
        if (/\bHls\b/.test(t)) marks.push("Hls");
        if (/jQuery/.test(t)) marks.push("jQuery");
        if (marks.length) line += "  ← 定义 " + marks.join(",");
      }
    } catch (e) {
      line = "  [连不上] " + abs + "  " + e.message;
    }
    console.log(line);
  }

  // 页面里有没有别的 Artplayer 引用（例如被注释掉的）
  const art = [];
  let i = -1;
  while ((i = html.indexOf("artplayer", i + 1)) >= 0) art.push(html.slice(Math.max(0, i - 90), i + 40).replace(/\s+/g, " "));
  console.log("\n页面里所有 artplayer 出现位置（" + art.length + "）：");
  art.forEach((s) => console.log("   …" + s + "…"));
})();
