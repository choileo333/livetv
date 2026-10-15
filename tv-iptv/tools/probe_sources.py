#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
候选源实测：对 m3u 里每个源做「真实拉流」测速，判据与后端 checkDeep 一致。
 ratio = 分片时长 / 下载耗时（越大越快）；>=1.3 流畅(ok) / 0.9~1.3 偏慢(slow) / <0.9 跟不上(dead)
 并识别「冻结假直播」（PROGRAM-DATE-TIME 陈旧 > 300s）。
用法: python probe_cand.py <m3u文件> <输出文件> [名称正则过滤]
"""
import sys, re, time, ssl, datetime, urllib.request
from urllib.parse import urljoin
from concurrent.futures import ThreadPoolExecutor, as_completed

UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) TvLiveProbe/2.0"
CTX = ssl.create_default_context(); CTX.check_hostname = False; CTX.verify_mode = ssl.CERT_NONE
CAP = 1500 * 1024          # 单分片最多读 1.5MB
PL_TO = 6                  # 播放列表超时
SEG_TO = 7                 # 分片超时（每次 read 的空闲超时）
WALL = 14                  # 单个源的总墙钟上限（防慢速滴流挂死）


def parse_pdt(line):
    """解析 #EXT-X-PROGRAM-DATE-TIME:2026-08-19T08:13:01.000Z -> epoch 秒"""
    try:
        s = line.split(":", 1)[1].strip().replace("Z", "+00:00")
        return datetime.datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def get_text(url, timeout=PL_TO):
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            if r.getcode() != 200:
                return r.getcode(), r.headers.get("Content-Type", ""), ""
            return 200, r.headers.get("Content-Type", ""), r.read(500 * 1024).decode("utf-8", "ignore")
    except Exception as e:
        return 0, "", ""


def fetch(url, timeout=SEG_TO, cap=CAP):
    t0 = time.time(); total = 0; reason = "end"
    try:
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        with urllib.request.urlopen(req, timeout=timeout, context=CTX) as r:
            if r.getcode() != 200:
                return {"code": r.getcode(), "total": 0, "secs": 0.001, "reason": "http"}
            while True:
                if time.time() - t0 > WALL:
                    reason = "slowtimeout"; break
                b = r.read(65536)
                if not b:
                    break
                total += len(b)
                if total >= cap:
                    reason = "cap"; break
            return {"code": 200, "total": total, "secs": max(time.time() - t0, 0.001), "reason": reason}
    except Exception:
        return {"code": 0, "total": total, "secs": max(time.time() - t0, 0.001), "reason": "err"}


def test(name, url):
    u = url
    for _ in range(4):
        code, ct, text = get_text(u)
        if code != 200:
            return (name, url, "dead", 0, None, f"http{code}")
        if u.lower().endswith(".mp4") or "video/mp4" in ct:
            return (name, url, "ok", None, None, "mp4")
        if "#EXTM3U" not in text:
            return (name, url, "dead", 0, None, "not-hls")
        is_master = "#EXT-X-STREAM-INF" in text
        segs, lastinf, pdts = [], 0, []
        for l in (x.strip() for x in text.splitlines()):
            if not l:
                continue
            if l.startswith("#EXTINF"):
                m = re.match(r"#EXTINF:\s*([\d.]+)", l)
                lastinf = float(m.group(1)) if m else 0
                continue
            if l.startswith("#EXT-X-PROGRAM-DATE-TIME:"):
                t = parse_pdt(l)
                if t:
                    pdts.append(t)
                continue
            if l.startswith("#"):
                continue
            segs.append((l, lastinf))
        if not segs:
            return (name, url, "dead", 0, None, "no-url")
        if ("#EXT-X-ENDLIST" not in text) and pdts:
            age = time.time() - max(pdts)
            if age > 300:
                return (name, url, "dead", 0, None, f"stale{int(age)}")
        if is_master:
            u = urljoin(u, segs[0][0]); continue
        lasturl = urljoin(u, segs[-1][0]); dur = segs[-1][1] or 0
        r = fetch(lasturl)
        if r["code"] != 200:
            return (name, url, "dead", 0, None, f"seg{r['code']}")
        kbps = round(r["total"] * 8 / 1000 / r["secs"])
        if r["reason"] == "end" and dur > 0:
            ratio = dur / r["secs"]
            state = "ok" if ratio >= 1.3 else "slow" if ratio >= 0.9 else "dead"
            return (name, url, state, kbps, round(ratio, 2), "end")
        state = "ok" if kbps >= 1200 else "slow" if kbps >= 300 else "dead"
        return (name, url, state, kbps, None, r["reason"])
    return (name, url, "dead", 0, None, "depth")


def parse_m3u(path, filt=None):
    items, name = [], None
    rx = re.compile(filt) if filt else None
    for line in open(path, encoding="utf-8", errors="ignore"):
        line = line.rstrip("\n")
        if line.startswith("#EXTINF"):
            name = line.rsplit(",", 1)[-1].strip()
        elif line.startswith("http"):
            nm = name or line
            if (rx is None) or rx.search(nm) or rx.search(line):
                items.append((nm, line))
            name = None
    return items


def main():
    src, out = sys.argv[1], sys.argv[2]
    filt = sys.argv[3] if len(sys.argv) > 3 else None
    items = parse_m3u(src, filt)
    print(f"待测: {len(items)} 个源 -> {out}", flush=True)
    res = []
    with ThreadPoolExecutor(max_workers=24) as ex:
        futs = {ex.submit(test, n, u): (n, u) for n, u in items}
        for i, f in enumerate(as_completed(futs), 1):
            try:
                res.append(f.result())
            except Exception as e:
                n, u = futs[f]; res.append((n, u, "dead", 0, None, "raise"))
            if i % 20 == 0:
                print(f"  进度 {i}/{len(items)}", flush=True)
    rank = {"ok": 0, "slow": 1, "dead": 2}
    res.sort(key=lambda r: (rank.get(r[2], 3), -(r[4] or 0)))
    with open(out, "w", encoding="utf-8") as f:
        for n, u, st, kb, ratio, reason in res:
            f.write(f"{st:4} | {str(kb):>8}kbps | ratio={str(ratio):>5} | {reason:>10} | {n} | {u}\n")
    from collections import Counter
    print("总览:", dict(Counter(r[2] for r in res)), flush=True)
    print("=== ok ===", flush=True)
    for r in res:
        if r[2] == "ok":
            print(f"  {r[3]}kbps ratio={r[4]} | {r[0]}", flush=True)


if __name__ == "__main__":
    main()
