// 抓播放器内页依赖的脚本并扫描可疑关键字（诊断用）
const fs = require("fs");
const path = require("path");
const OUT = path.resolve(__dirname, "probe_out");
const LIST = [
  ["common.js", "https://xiaoca.top/one/common.js?v=51"],
  ["disabledev2.js", "https://xiaoca.top/mediaframe/disabledev2.js"],
  ["a2.js", "https://xiaoca.top/one/a2.js?v=4"],
];
const KEYS = ["error0", "location.href", "location.replace", "location =", "userAgent",
  "WebView", "Android", "devtools", "debugger", "toString", "m3u8", "vid", "atob", "eval("];

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  for (const [nm, u] of LIST) {
    try {
      const r = await fetch(u, { headers: { "User-Agent": "Mozilla/5.0", "Referer": "https://xiaoca.top/" } });
      const t = await r.text();
      fs.writeFileSync(path.join(OUT, nm), t, "utf8");
      console.log("=== " + nm + "  HTTP " + r.status + "  " + t.length + " 字节 ===");
      for (const k of KEYS) {
        let c = 0, i = -1;
        while ((i = t.indexOf(k, i + 1)) >= 0) c++;
        if (c) console.log("   " + k + " × " + c);
      }
      // 默认只打印前 600 字（大文件里关键信息通常在开头）
      console.log("   开头：" + JSON.stringify(t.slice(0, 600)));
      console.log("");
    } catch (e) { console.log(nm + " 失败 " + e.message); }
  }
})();
