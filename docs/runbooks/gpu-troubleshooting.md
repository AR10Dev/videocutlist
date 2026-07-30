# GPU troubleshooting

Software H.264 is the production default. Do not set a hardware encoder merely because `ffmpeg -encoders` lists one: a real encode and output probe must succeed on the host.

For VAAPI, first grant only the render-node group and inspect the device:

```bash
getent group render
ls -l /dev/dri/renderD128
sudo usermod -a -G render editapp
sudo scripts/ops/probe-gpu-encoder.sh /srv/editapp/media/SHORT-TEST-CLIP.mp4
```

The current preview runner accepts only the software profile, so stop here on this release: the successful probe is evidence for a later hardware-enabled release, not permission to enable an unimplemented encoder. When a reviewed release adds VAAPI preview support, install the supplied narrowly scoped systemd drop-in, select its documented preference in `/etc/editapp/editapp.env`, and restart:

```bash
sudo install -d /etc/systemd/system/editapp.service.d
sudo install -m 0644 deployments/systemd/editapp-gpu.conf.example /etc/systemd/system/editapp.service.d/gpu.conf
sudo systemctl daemon-reload
sudo systemctl restart editapp
sudo scripts/ops/verify-deployment.sh
```

The drop-in permits only `/dev/dri/renderD128` and disables `PrivateDevices`, which is why it is opt-in. If probe or production previews fail, remove the drop-in, restore `EDITAPP_ENCODER_PREFERENCE=software`, restart, and retain the failed FFmpeg log excerpt for diagnosis. NVIDIA and QSV need their vendor driver/device prerequisites and an equivalent real probe before any service permission change.
