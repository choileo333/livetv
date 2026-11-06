#!/usr/bin/env node
/**
 * 「安卓端 vs 网页版」频道清单一致性验证（v1.1.1 新增）
 *
 * 为什么需要它：
 *   用户反馈「跟网页版比起来好像少了几个（韩国台）」。
 *   要回答这个问题，必须**用实测数据**证明两端的清单到底一致到哪一步，而不是靠嘴说。
 *
 * 本脚本做四件事：
 *   1) 拉线上后端 /api/channels（这是网页版与 App **共用**的同一个接口）
 *   2) 分别用「网页版规则」和「App 规则」算出频道清单与分组，逐个对比是否一致
 *   3) 统计韩国组明细，并列出 relay:false（本机直连）的台
 *   4) 与工程内归档的夹具 app/src/test/resources/channels_live.json 比对，发现线上漂移就报警
 *
 * 用法：node tools/verify_channel_parity.js
 * 退出码：0 = 全部通过；1 = 有断言失败
 */

const fs = require("fs");
const path = require("path");

const BASE = process.env.TV_BASE || "https://tvlive-relay.app.workbuddy.host";
const FIXTURE = path.join(__dirname, "..", "app", "src", "test", "resources", "channels_live.json");

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log("  [OK]   " + name); }
  else { fail++; console.log("  [FAIL] " + name + (extra ? "  → " + extra : "")); }
}
function section(t) { console.log("\n=== " + t + " ==="); }

/** 网页版 app.js 的清单规则：直接使用后端数组（不丢条目、不重排） */
function webRules(arr) {
  return arr.filter((c) => c && c.url && String(c.url).trim() !== "");
}

/**
 * App 端 ChannelRepo.parseChannels 的规则：
 *   id = optInt("id", i+1)；name/url/logo/group 取字符串（group 缺省 "未分组"）；
 *   relay = optBoolean("relay", true)；最后过滤掉 url 为空的条目。
 * 这里逐条等价复刻，保证「脚本算出的 App 清单」= 真机上 App 会显示的清单。
 */
function appRules(arr) {
  const out = arr.map((c, i) => ({
    id: typeof c.id === "number" ? c.id : i + 1,
    name: typeof c.name === "string" ? c.name : "未命名频道",
    url: typeof c.url === "string" ? c.url : "",
    logo: typeof c.logo === "string" ? c.logo : "",
    group: typeof c.group === "string" ? c.group : "未分组",
    relay: c.relay === undefined ? true : !!c.relay,
  }));
  return out.filter((c) => c.url.trim() !== "");
}

(async () => {
  console.log("后端: " + BASE);
  const res = await fetch(BASE + "/api/channels", { headers: { "User-Agent": "TvLive-Android/1.1" } });
  ok("接口返回 200", res.status === 200, "HTTP " + res.status);
  if (res.status !== 200) process.exit(1);
  const live = await res.json();
  ok("响应为裸数组（App 用 JSONArray 解析，不是对象包一层）", Array.isArray(live));

  const web = webRules(live);
  const app = appRules(live);

  section("1) 两端清单是否逐条一致");
  ok("总数一致", web.length === app.length, "网页版 " + web.length + " / App " + app.length);
  const sameOrder = web.length === app.length &&
    web.every((c, i) => c.id === app[i].id && c.name === app[i].name);
  ok("台号与名称逐个一致（含顺序）", sameOrder);
  // 只有 App 会把「url 为空」的条目丢掉——检查线上是否真的没有这种条目，避免出现"网页版能看到、App 看不到"
  const blank = live.filter((c) => !c || !c.url || String(c.url).trim() === "");
  ok("线上没有 url 为空的条目（否则会被 App 丢弃）", blank.length === 0, JSON.stringify(blank));

  section("2) 分组明细");
  const groups = [...new Set(app.map((c) => c.group))];
  groups.forEach((g) => {
    const n = app.filter((c) => c.group === g).length;
    console.log("  " + g + ": " + n + " 台");
  });

  section("3) 韩国组逐条对照（App 规则）");
  const krApp = app.filter((c) => c.group === "韩国");
  const krWeb = web.filter((c) => c.group === "韩国");
  ok("韩国组台数一致", krApp.length === krWeb.length, "网页版 " + krWeb.length + " / App " + krApp.length);
  console.log("  id    播放方式   频道名");
  krApp.forEach((c) => {
    console.log(
      "  " + String(c.id).padEnd(6) +
      (c.relay ? "经中继  " : "本机直连").padEnd(11) +
      c.name
    );
  });
  const direct = krApp.filter((c) => !c.relay);
  console.log("  → 其中 relay:false（本机直连）: " + direct.map((c) => c.id + " " + c.name).join(" | "));

  section("4) 与归档夹具比对（防止线上静默漂移）");
  if (!fs.existsSync(FIXTURE)) {
    ok("夹具存在", false, FIXTURE);
  } else {
    const fx = JSON.parse(fs.readFileSync(FIXTURE, "utf8"));
    const fxApp = appRules(fx);
    ok("夹具总数 = 线上总数", fxApp.length === app.length, fxApp.length + " vs " + app.length);
    const fxIds = fxApp.map((c) => c.id).join(",");
    const liveIds = app.map((c) => c.id).join(",");
    ok("夹具台号序列 = 线上台号序列", fxIds === liveIds);
    if (fxIds !== liveIds) {
      console.log("    夹具: " + fxIds);
      console.log("    线上: " + liveIds);
    }
  }

  section("5) 关键断言（写进单测的那几条，这里再实测一次）");
  ok("总台数 = 59", app.length === 59, String(app.length));
  ok("韩国组 = 31 台", krApp.length === 31, String(krApp.length));
  const allDirect = app.filter((c) => !c.relay).map((c) => c.id);
  ok("relay:false 恰为 [137,138,139,140,141,163]",
    JSON.stringify(allDirect) === JSON.stringify([137, 138, 139, 140, 141, 163]),
    JSON.stringify(allDirect));

  console.log("\n──────────────────────────────");
  console.log("通过 " + pass + " 项，失败 " + fail + " 项");
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => {
  console.error("验证失败: " + e.message);
  process.exit(1);
});
