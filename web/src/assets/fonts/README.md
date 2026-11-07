# Code font

The code font comes from the Regular face in the [Maple Mono 7.9 Normal NL CN unhinted release](https://github.com/subframe7536/maple-font/releases/download/v7.9/MapleMonoNormalNL-CN-unhinted.zip). The CN edition builds on [Resource Han Rounded](https://github.com/CyanoHao/Resource-Han-Rounded).

`maple-code/` contains a base WOFF2 face for letters, punctuation and symbols, plus Han faces of up to 384 code points each. The generated CSS lists disjoint Unicode ranges so the browser fetches only the faces used on the page. Together the faces retain all 22,731 mapped code points and their upstream horizontal metrics.

To regenerate, extract `MapleMonoNormalNL-CN-Regular.ttf` from the release archive and run the command below from the repository root with Python 3.10 or newer, FontTools 4.60.1 and Brotli 1.1.0. The script verifies the pinned input hash and checks each WOFF2's character mappings and horizontal metrics.

```sh
python web/src/assets/fonts/prepare_maple_code.py /path/to/MapleMonoNormalNL-CN-Regular.ttf
```

Upstream TTF SHA-256 `8cec0b9c25139a75d4fb02b0690fc2fe970ecd3bae7b69451edc53627256897f`.

The [upstream SIL Open Font License](../../../public/fonts/Maple-Mono-OFL.txt) ships with the web build.
