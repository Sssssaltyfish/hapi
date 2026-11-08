# HAPI 线上依赖磁盘审计

迁移前 WSL 根 `node_modules` 的实测磁盘占用为 **1.42 GiB**。与 HAPI 上游基线 `85ccab1ac673bb848a3ca80e448b919db1cfccef` 比较，实际新增 **23 个包版本，共 7.92 MiB，占 0.54%**。新增占用全部来自 Passkey。Hub 的 Passkey 服务端及新增传递依赖合计 **7.18 MiB**，Web 的 Passkey 浏览器包为 **0.74 MiB**。

| 归因 | 包实例数 | 磁盘字节 | MiB | 占比 |
| --- | ---: | ---: | ---: | ---: |
| 上游锁文件已有的包版本 | 1,628 | 1,489,735,680 | 1,420.72 | 97.44% |
| 本地直接新增且已安装 | 2 | 3,010,560 | 2.87 | 0.20% |
| 本地传递新增且已安装 | 21 | 5,292,032 | 5.05 | 0.35% |
| Bun 安装结构及包目录外文件 | — | 30,769,152 | 29.34 | 2.01% |
| 合计 | 1,651 | 1,528,807,424 | 1,457.98 | 100% |

## 清单新增的直接声明

| 工作区 | 声明 | 安装中的包占用 | 相对上游增加 |
| --- | --- | ---: | ---: |
| Hub 运行依赖 | `@simplewebauthn/server@14.0.0` | 2.13 MiB | 2.13 MiB |
| Web 依赖 | `@simplewebauthn/browser@14.0.0` | 0.74 MiB | 0.74 MiB |
| Hub 运行依赖 | `ws@8.18.3` | 200 KiB | 0，上游 CLI 已声明同版本 |
| Hub 开发依赖 | `@types/ws@8.18.1` | 56 KiB | 0，上游 CLI 已声明同版本 |
| Web 依赖 | `@tanstack/react-virtual@3.14.25` | 0 | 清单和锁文件已声明，实际未安装 |

`@tanstack/virtual-core@3.19.10` 是虚拟列表依赖引入的传递包，实测也未安装。锁文件中 `@types/hast@3.0.5` 从嵌套位置调整到顶层，上游已有该版本。`tslib@1.14.1` 是新增的具体版本，上游已有其他版本的 `tslib`。

## 实际新增包按占用排序

| 包与版本 | 类别 | MiB |
| --- | --- | ---: |
| `@simplewebauthn/server@14.0.0` | 直接，Hub Passkey | 2.13 |
| `@simplewebauthn/browser@14.0.0` | 直接，Web Passkey | 0.74 |
| `tsyringe@4.10.0` | Hub Passkey 传递依赖 | 0.74 |
| `@peculiar/asn1-x509@2.11.1` | 同上 | 0.57 |
| `@peculiar/x509@1.14.3` | 同上 | 0.55 |
| `@peculiar/utils@2.0.3` | 同上 | 0.44 |
| `@peculiar/asn1-cms@2.11.1` | 同上 | 0.35 |
| `asn1js@3.1.0` | 同上 | 0.34 |
| `@peculiar/asn1-schema@2.11.1` | 同上 | 0.30 |
| `@peculiar/asn1-x509-attr@2.11.1` | 同上 | 0.28 |
| `reflect-metadata@0.2.2` | 同上 | 0.26 |
| `@peculiar/asn1-pfx@2.11.1` | 同上 | 0.21 |
| `@peculiar/asn1-rsa@2.11.1` | 同上 | 0.16 |
| `@peculiar/asn1-android@2.11.1` | 同上 | 0.12 |
| `@peculiar/asn1-ecc@2.11.1` | 同上 | 0.12 |
| `@levischuck/tiny-cbor@0.2.11` | 同上 | 0.11 |
| `tslib@1.14.1` | 同上 | 0.09 |
| `@peculiar/asn1-csr@2.11.1` | 同上 | 0.08 |
| `@peculiar/asn1-pkcs9@2.11.1` | 同上 | 0.08 |
| `@hexagon/base64@1.1.28` | 同上 | 0.07 |
| `@peculiar/asn1-pkcs8@2.11.1` | 同上 | 0.07 |
| `pvtsutils@1.3.6` | 同上 | 0.06 |
| `pvutils@1.2.0` | 同上 | 0.05 |

## 根安装体积前 25 名

按包名汇总各已安装版本及 Bun 实例。下表各版本均已出现在上游锁文件中。类别描述其已观察到的用途。

| 排名 | 包 | MiB | 类别 |
| ---: | --- | ---: | --- |
| 1 | `lucide-react` | 194.52 | Web 与官网图标 |
| 2 | `mermaid` | 139.89 | Web 与官网图表 |
| 3 | `antd` | 59.86 | Web UI 传递依赖 |
| 4 | `typescript` | 44.64 | 类型检查及构建工具，也是部分依赖的 peer |
| 5 | `es-toolkit` | 39.49 | CLI 与 Web 工具库 |
| 6 | `date-fns` | 38.98 | Web 与官网日期处理 |
| 7 | `@shikijs/langs` | 29.07 | Web、官网与文档的代码高亮 |
| 8 | `@emoji-mart/data` | 26.89 | Web 表情数据 |
| 9 | `@lobehub/icons` | 24.95 | Web 图标 |
| 10 | `playwright-core` | 24.70 | 端到端测试 |
| 11 | `@ant-design/icons` | 20.68 | Web UI 图标 |
| 12 | `pnpm` | 20.45 | 官网开发工具 |
| 13 | `@ant-design/icons-svg` | 20.24 | Web UI 图标数据 |
| 14 | `@esbuild/linux-x64` | 19.87 | Linux 构建和开发工具 |
| 15 | `zod-to-json-schema` | 18.88 | CLI 传递依赖，转换 JSON Schema |
| 16 | `date-fns-jalali` | 15.54 | 官网日期处理 |
| 17 | `react-devtools-core` | 15.18 | React 调试工具，由根清单声明为开发依赖 |
| 18 | `zod` | 14.14 | 工作区共享的输入验证库 |
| 19 | `@base-ui/react` | 13.90 | Web UI 传递依赖 |
| 20 | `@mermaid-js/parser` | 12.97 | Web 与官网图表解析 |
| 21 | `rxjs` | 11.45 | Web 传递依赖 |
| 22 | `shiki` | 11.13 | Web、官网与文档的代码高亮 |
| 23 | `@lobehub/ui` | 10.88 | Web UI 传递依赖 |
| 24 | `langium` | 10.84 | Web 与官网图表解析 |
| 25 | `es-abstract` | 10.63 | 根开发依赖的传递包 |

按安装树依赖链接递归并包含可选依赖和 peer，上游包体中约 913.11 MiB 可由 Hub、CLI、Web、shared 或 relay 的 `dependencies` 到达，235.21 MiB 只由官网的 `dependencies` 到达，272.41 MiB 只从开发依赖到达。静态可达性用于描述来源，实际 Hub 运行子集取决于代码执行路径。

## 测量和迁移证据

- 测量对象为 WSL Ubuntu-26.04 中迁移前的 `/home/igna/hapi-deployment/source/node_modules`。按 `lstat` 的 `st_blocks × 512` 累加，同一 `(st_dev, st_ino)` 只计一次，且不沿符号链接重复遍历。总量和 `du -s -B1 node_modules` 完全一致。单个包统计包含包内文件及目录，Bun 外层目录、链接、元数据等汇入安装结构。1,651 个包实例对应 1,648 个包版本和 1,415 个包名。原始数据的 `apparent_bytes` 是按相同 inode 规则累加的 `st_size`，包含目录的 `st_size`。
- 对比 8 份 `package.json` 与两份 `bun.lock`。WSL Git HEAD 指向上游，功能补丁位于工作树。十份 WSL 清单与锁文件归一化换行后均和 Windows main `6a5341eef0130c1041bc8c3454cd336ce1611902` 的 SHA-256 相同。磁盘测量只覆盖根安装目录，不含浏览器缓存、构建输出或各工作区链接目录。Bun 缓存与安装目录间如有硬链接，删除安装目录实际释放的磁盘空间取决于缓存中剩余链接。
- Hub 源码运行保留根 `node_modules/.bun`、`hub/node_modules` 与 `shared/node_modules` 及对应源码。`hub/node_modules/@hapi/protocol` 指向 `../../../shared`。在原布局检查各工作区及根目录的依赖链接，未发现绝对符号链接，Hub 与 shared 的工作区链接也均可解析。两处链接目录分别占 64 KiB 和 16 KiB。已有 `web/dist` 可随部署使用，Web 构建和源码 CLI 需保留各自的工作区链接目录。
- 逐文件比较 WSL 工作树与 Windows main。3,287 份内容匹配，其中 2,580 份只差 CRLF 换行。其余 Git 中的差异均为文档。WSL 另有三份未跟踪的 CLI 审计和冒烟脚本，详见逐文件记录。

原始数据 [measurement.json](measurement.json)，按包名排序 [packages-ranked.csv](packages-ranked.csv)，源码逐文件结果 [source-comparison.json](source-comparison.json)。
