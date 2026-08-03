# Performance baseline

Measured 2026-07-30 on a 12th Gen Intel Core i7-12700H (20 logical CPUs),
tmpfs storage, FFmpeg 6.1.1, and the `software-h264-v1` libx264 profile.
The source was the deterministic 320x180 H.264/AAC MP4 smoke fixture; the
requested preview was centered at 1,000 ms and produced a valid 2.021-second
fragmented MP4.

| Scenario | Cache | Wall time | Result |
| --- | --- | ---: | --- |
| Preview over loopback HTTP | miss | 251 ms | success |
| Equivalent preview over loopback HTTP | hit | 57 ms | success |

These are single local observations, not regression thresholds or throughput
claims. CPU/GPU utilization, queue wait, and remote-network latency were not
measurable in this workspace. Establish repeated production-host samples before
defining an SLO or CI performance gate.

Reproduce a record with:

```bash
test/performance/measure-command.sh preview mp4 software-h264-v1 miss -- \
  curl --fail --silent --show-error -o preview.mp4 \
  'http://127.0.0.1:8787/api/v1/media/MEDIA_ID/preview?centerMs=1000'
```
