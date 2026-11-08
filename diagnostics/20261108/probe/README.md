# First expansion layout diagnosis

The largest cost in the earlier 4× Chromium profile was strongly dependent on the test machine's cold font environment. The previous launcher used a custom Fontconfig file that points to `/mnt/c/Windows/Fonts` and a cache on `/mnt/c`. With the same formal bundle `index-DIlTXYBC.js`, the same 390 × 844 viewport, the same 22 summaries and 23 tools, and the same 4× throttle, the normal Linux Fontconfig reduced the longest layout from 765.4 ms to 34.1 ms. No application files or system font configuration were changed.

| Control | Longest layout | Layout total before panel opened | Longest main-thread task |
|---|---:|---:|---:|
| [Original custom Fontconfig](baseline/report.json) | 765.4 ms | 778.6 ms | 787 ms |
| [Only two tools, no summaries](tiny-tools/report.json) | 759.4 ms | 762.4 ms | 772 ms |
| [Same group with Arial applied inside the panel](system-font/report.json) | 220.9 ms | 233.1 ms | 239 ms |
| [Reopen the same group after its rows detached](repeat-open/report.json) | 5.9 ms | 11.5 ms | 87 ms |
| [Normal Linux Fontconfig, fresh browser](baseline-system-fontconfig/report.json) | 34.1 ms | 44.0 ms | 88 ms |

Setting an explicit zero-minimum grid column, containing the inner panel's inline size, changing all 22 summaries to explicit multiline text, and replacing the outer grid with a block while keeping its closed height at zero all left the first long layout between 681 and 798 ms in the original font environment. The block variant reduced layout work during the animation after opening, while the expensive first layout remained. Removing either most tools or all summaries also left a long first layout. These single-run controls rule out those changes as large wins in this fixture.

The original profile identified the assistant-ui viewport MutationObserver as the synchronous trigger. An earlier adapter experiment removed that trigger while the same large layout still ran during the browser's render phase. Here, the normal Linux configuration rendered the sampled label with DejaVu Sans. All 56 declared `HAPI Code Mono` font faces remained `unloaded` and the page requested zero font files during these runs. The sample therefore provides no evidence that the bundled Maple font or its CJK shards caused this layout. The synthetic CPU throttle and WSL font configuration do not measure latency on the user's phone.

The runner defaults to `/etc/fonts/fonts.conf` for performance diagnosis. To reproduce the older Windows-font appearance environment, set `HAPI_PROBE_FONTCONFIG` to `interaction-improvements-20261031/browser-validation/fonts.conf` using its WSL absolute path. Set `HAPI_ABLATION` to `baseline`, `grid-width`, `inner-contain`, `reasoning-multiline`, `outer-block`, `tools-only`, `reasoning-heavy`, `tiny-tools`, `system-font`, or `repeat-open`. Set `HAPI_ABLATION_SAMPLE` to a unique suffix if preserving an existing result for the same variant.
