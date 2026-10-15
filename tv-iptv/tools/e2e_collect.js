/**
 * e2e_collect.js —— 端到端验证的「结果收集器」。
 * 验证页（web/_e2e.html）每 0.7s 把播放器的实时状态用 <img> 信标发到本服务，这里打印到 stdout。
 * 之所以要单独起一个端口：无头浏览器要「跑满 40 秒」才能看到真实播放，
 * 而 --screenshot/--dump-dom 会在页面 load 时就抢跑退出，所以改用「常驻 Chrome + 信标回报」。
 */
const http = require("http");
const PORT = 8803;
http.createServer((req, res) => {
  const u = new URL(req.url, "http://127.0.0.1:" + PORT);
  if (u.pathname === "/r") {
    const d = u.searchParams.get("d") || "";
    d.split("\n").forEach((l) => console.log("[E2E] " + l));
    console.log("[E2E] ----");
  }
  res.writeHead(200, { "Content-Type": "image/gif", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" });
  res.end(Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64"));
}).listen(PORT, "127.0.0.1", () => console.log("[collector] http://127.0.0.1:" + PORT));
