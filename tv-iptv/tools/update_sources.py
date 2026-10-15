#!/usr/bin/env python3
# update_sources.py —— TvLive 免费公开源「持续更新」工具（在你自己的机器上运行）
#
# 做什么：
#   1) 从 GitHub 上最大的公开 IPTV 合集 iptv-org/iptv 拉取多个分类的播放列表（公开、免费）；
#   2) 并发探测每个 HLS(.m3u8) 源在你本机的可达性（只保留能连上且真返回播放列表的活源）；
#   3) 按「主流全球 CDN / 对国内友好」排序，每类保留 Top N，写出 candidates 文件。
#
# 用法：
#   python3 update_sources.py            # 默认：新闻/音乐/纪录片/体育/娱乐，每类取前 8 个活源
#   python3 update_sources.py --per 12   # 每类多取几个
#
# 产出：../backend/sources.candidates.json  （数组，字段与 server.js 的 CHANNELS 对齐）
#   拿到后人工审阅，把想要的频道合并进 server.js 的 CHANNELS 即可（保留原有测试保底源）。
#
# 说明：这些源是 iptv-org 聚合的公开免费流，合法性由来源保证；生产请替换为「你有权播放」的源。
import urllib.request, ssl, re, json, os, sys, argparse, random
from concurrent.futures import ThreadPoolExecutor

BASE = "https://iptv-org.github.io/iptv/categories/{}.m3u"
CATS = ["news", "music", "documentary", "sports", "entertainment", "kids"]
PER_CAT = 8
WORKERS = 20
TIMEOUT = 12

# CDN 偏好排序：分值越高越优先（全球主流 CDN + 对国内较友好者排前）
CDN_SCORE = [
    ("amagi.tv", 100), ("cctvplus", 100), ("rakuten", 95),        # 含 CGTN/China Travel 等
    ("akamaized.net", 90), ("akamai", 88),
    ("mediatailor", 86), ("amazonaws", 84), ("cloudfront", 82),
    ("stingray.com", 80),
    ("itworkscdn", 70), ("edgenextcdn", 68), ("encoders.immergo", 66),
]
ctx = ssl.create_default_context(); ctx.check_hostname = False; ctx.verify_mode = ssl.CERT_NONE

def parse_m3u(text):
    out, name = [], None
    for line in text.splitlines():
        line = line.strip()
        if line.startswith("#EXTINF"):
            g = re.search(r'group-title="([^"]*)"', line)
            name = (line.split(",")[-1].strip(), g.group(1) if g else "")
        elif line and not line.startswith("#"):
            if re.search(r"\.m3u8(\?.*)?$", line, re.I) and line.lower().startswith("http"):
                out.append({"name": name[0] or "未知", "group": name[1] or "", "url": line})
            name = None
    return out

def score(url):
    s = 0
    for k, v in CDN_SCORE:
        if k in url: s = max(s, v)
    return s

def probe(item):
    url = item["url"]
    try:
        req = urllib.request.Request(url, method="GET", headers={"User-Agent": "Mozilla/5.0"})
        with urllib.request.urlopen(req, timeout=TIMEOUT, context=ctx) as r:
            data = r.read(1024).decode("utf-8", "ignore")
            if r.status == 200 and ("#EXTM3U" in data or "#EXTINF" in data or "m3u8" in data):
                item["_score"] = score(url)
                return True
    except Exception:
        pass
    return False

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--per", type=int, default=PER_CAT)
    a = ap.parse_args()
    candidates = []
    for cat in CATS:
        try:
            with urllib.request.urlopen(BASE.format(cat), timeout=40, context=ctx) as r:
                txt = r.read().decode("utf-8", "ignore")
        except Exception as e:
            print(f"[{cat}] 拉取失败: {e}"); continue
        items = parse_m3u(txt)
        seen, uniq = set(), []
        for it in items:
            if it["url"] not in seen:
                seen.add(it["url"]); uniq.append(it)
        print(f"[{cat}] 解析 {len(uniq)} 个唯一HLS源，并发探测…")
        alive = []
        with ThreadPoolExecutor(max_workers=WORKERS) as ex:
            for ok, it in zip(ex.map(probe, uniq), uniq):
                if ok: alive.append(it)
        alive.sort(key=lambda x: x.get("_score", 0), reverse=True)
        top = alive[:a.per]
        for it in top:
            candidates.append({"name": it["name"], "url": it["url"], "group": it["group"] or cat.capitalize(), "note": "iptv-org 公开免费流"})
        print(f"[{cat}] 活源 {len(alive)}，取 Top {len(top)}")
    out = os.path.join(os.path.dirname(__file__), "..", "backend", "sources.candidates.json")
    out = os.path.abspath(out)
    with open(out, "w", encoding="utf-8") as f:
        json.dump(candidates, f, ensure_ascii=False, indent=2)
    print(f"\n共 {len(candidates)} 个候选源 → {out}")

if __name__ == "__main__":
    main()
