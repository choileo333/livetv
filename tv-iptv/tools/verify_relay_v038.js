// 经云端中继(上海)实测：验证 v0.3.8 重定向跟随是否解锁凤凰 + 国内台可达性
const https = require("https");
const BASE = "https://tvlive-relay.app.workbuddy.host/api/relay?url=";
function test(name, url) {
  return new Promise((res) => {
    const req = https.get(BASE + encodeURIComponent(url), { headers: { "User-Agent": "Mozilla/5.0" }, timeout: 12000 }, (r) => {
      let s = "";
      r.on("data", (c) => (s += c));
      r.on("end", () => {
        const ok = /#EXTM3U/i.test(s);
        let first = "";
        if (ok) {
          const lines = s.split(/\r?\n/).filter((x) => x.trim() && !x.startsWith("#"));
          first = lines[0] ? lines[0].slice(0, 80) : "(已是分片)";
        }
        console.log(name.padEnd(20) + " | st " + r.statusCode + " | HLS " + (ok ? "Y" : "n") + " | b " + String(s.length).padStart(5) + (ok ? " | " + first : ""));
        res();
      });
    });
    req.on("timeout", () => { req.destroy(); console.log(name.padEnd(20) + " | TIMEOUT"); res(); });
    req.on("error", (e) => { console.log(name.padEnd(20) + " | ERR " + (e.code || e.message)); res(); });
  });
}
(async () => {
  await test("凤凰 ccav(跟跳)", "http://ccav.zone.id/php/fh.php?id=2");
  await test("CCTV1 voc.com.cn", "https://liveplay-srs.voc.com.cn/hls/tv/134_180adf.m3u8");
  await test("CCTV13 hebtv", "https://event.pull.hebtv.com/jishi/cp1.m3u8");
})();
