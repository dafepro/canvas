# Mobile profiling protocol

This protocol records the evidence needed to close the Phase 6 mobile-profile
gap. Desktop CPU throttling may diagnose a problem, but it does not count as a
representative device result.

## Device matrix

Record one currently supported device in each tier. Include the model, OS,
browser or installed-PWA version, refresh rate, and whether battery saver was
enabled.

| Tier | Device | OS/browser | Refresh rate | Battery saver | Result |
| --- | --- | --- | ---: | --- | --- |
| Low | Pending | Pending | Pending | Off | Pending |
| Mid | Pending | Pending | Pending | Off | Pending |
| High | Pending | Pending | Pending | Off | Pending |

## Run

1. Serve the production Docker demo to the device over HTTPS or the local
   network. Do not profile a development build.
2. Join 20 clients and populate the room with 50 items, including five rockets.
   Make the measured device the simulation host.
3. Move the avatars and disturb the item pile for 60 seconds. Record simulation
   Hz, worker drift, worst physics step, render p95, render worst, long frames,
   awake bodies, active colliders, and inbound/outbound KB/s.
4. Leave the host visible and idle for 60 seconds, then record the same fields.
5. Background the host for 30 seconds and return. Record `background resumes`,
   `last background`, the host migration count/reason, and whether the room
   remained responsive and converged without a reload.
6. Repeat once with the measured device as a peer so rendering can be separated
   from host-worker cost.

The demo's rolling render metrics cover roughly the latest 300 visible frames.
A frame slower than 33.3 ms counts as long. The first ticker delta after a tab
resumes is excluded from render percentiles and reported as background duration
instead.

## Decision record

The scene budget remains 60 Hz fixed simulation, up to 60 FPS rendering, and no
more than 150 active colliders. Low-end adaptive rendering is allowed by the
spec. Do not add a 30 Hz simulation profile until the device results show host
worker drift or physics-step cost—not rendering—to be the limiting factor.
