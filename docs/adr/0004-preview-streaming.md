# ADR 0004: Preview Streaming and Cancellation

Status: accepted

FFmpeg writes fragmented MP4 to stdout. A single-flight manager fans bytes out
to subscribers and a partial cache file. Subscriber cancellation is
reference-counted; the process stops when nobody remains. Successful output is
validated and atomically renamed. Software libx264 is the mandatory fallback.

