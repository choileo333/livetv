#!/usr/bin/env python3
# 拉取 HLS 分片（经上海中继），扫描其中的可读字符串，寻找频道台名（service_name）以确证频道身份。
import urllib.parse, urllib.request, re

RELAY_HOST = "https://tvlive-relay.app.workbuddy.host"
RELAY = RELAY_HOST + "/api/relay"

def get(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=40) as r:
        return r.read()

def fetch_relay(target):
    u = RELAY + "?url=" + urllib.parse.quote(target, safe="")
    return get(u)

def printable_runs(b):
    runs = re.findall(rb'[\x20-\x7e]{4,}', b)
    return [x.decode('latin1') for x in runs]

# 频道主播放列表 URL（74.91.26.218 转发源）
channels = {
    "CCTV-13": "http://74.91.26.218:82/live/cctv13hd.m3u8",
    "CCTV-1":  "http://74.91.26.218:82/live/cctv1hd.m3u8",
}

for name, m3u8 in channels.items():
    print("===== %s =====" % name)
    try:
        pl = fetch_relay(m3u8).decode('utf-8', 'ignore')
        # 取第一个 /api/relay?url= 分片行（中继已把分片 URL 改写回自身）
        seg_rel = None
        for line in pl.splitlines():
            if line.startswith('/api/relay?url='):
                seg_rel = RELAY_HOST + line
                break
        if not seg_rel:
            print("no segment line found in m3u8:\n", pl[:400])
            continue
        print("seg url:", seg_rel[:120], "...")
        data = get(seg_rel)
        print("segment bytes:", len(data), "first16:", data[:16].hex())
        runs = printable_runs(data)
        kw = ["CCTV", "PHOENIX", "凤凰", "新闻", "综合", "cctv", "NEWS", "CHINA", "JAZEERA", "NHK", "CCTV-13", "CCTV-1", "央"]
        hits = []
        for r in runs:
            if any(k.lower() in r.lower() for k in kw) and len(r) < 80 and r not in hits:
                hits.append(r)
        print("total printable runs:", len(runs), " keyword hits:", len(hits))
        for h in hits[:50]:
            print("   |", h)
        if not hits:
            print("   (no keyword string found — TS 元数据可能不含台名，需 ffmpeg 抽帧确认)")
    except Exception as e:
        print("ERROR:", repr(e))
