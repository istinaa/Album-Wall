# 唱片墙 / Album Wall

从公开唱片数据库检索专辑，管理想听和听过的唱片，留下评分、简评与分类，并把收藏展示为缓慢流动的唱片墙。当前版本 **0.9.0**。

## 直接使用桌面版

完成下方的桌面版打包后，双击项目目录中的 **start-app.cmd**，也可以直接运行：

```text
dist/Album Wall-win32-x64/Album Wall.exe
```

这是独立的 Windows x64 应用，使用时不需要安装 Node.js、输入 npm 命令或打开浏览器。移动应用时，请保留整个 `Album Wall-win32-x64` 文件夹，不能只复制 exe；移动后可重新创建快捷方式。

启动页“聆听空间”展示倾斜排列、缓慢向左移动的唱片，上下边缘渐进虚化。“发现唱片”和收藏卡片都可以直接点击“想听 / 听过”完成收藏或切换状态；点击“听过”后，卡片原地出现带颜色渐变的 0–10 分滑块，松开即保存，不必打开详情。已有评分、简评和分类会保留；点击封面仍可编辑完整记录。

“墙面展示”使用你的收藏，支持暂停、全屏和 **导出 PNG 截图**。导出保存当前墙面的画面，包含倾斜封面与边缘虚化；桌面版会弹出系统保存对话框。首次使用的精选唱片只用于预览，不会自动加入收藏。欢迎页在收藏不足 4 张时使用精选预览；展示页只要有收藏就使用自己的唱片。

收藏页和展示页都支持最低评分、聆听状态、艺人、类别与关键词组合筛选。例如最低评分选“≥ 8.5 分”，会显示个人评分不低于 8.5 的收藏，排除未评分唱片。收藏页的“展示筛选结果”会将当前条件带入动态唱片墙；全屏和 PNG 导出也使用同一批筛选结果。筛选无结果时显示空状态并禁用导出，可通过“清除筛选”恢复。侧栏“我的排行”会按收藏唱片数、平均评分或已听唱片数排列艺人，同时显示类别平均分排行；侧栏“范围筛选”提供两个渐变滑块，可拖出 0–10 分的评分区间，并叠加状态、艺人、类别、关键词条件，实时展示符合条件的已收藏专辑。

## 搜索与封面

- 元数据来自 [MusicBrainz](https://musicbrainz.org/) 与 Apple Music 公开目录。搜索会合并两者并按专辑名、艺人和首发年份去重，MusicBrainz 尚未收录的新发行也可以直接收藏。艺人搜索会同时展开明确的本地化别名，例如“宇多田光 / 宇多田ヒカル / Hikaru Utada / Utada Hikaru”，结果排序和本地筛选使用同一个身份键。
- 默认只查询录音室专辑，减少现场录音、单曲和合辑干扰。需要时切换到“全部发行（含现场、单曲）”。精确名称优先，同一艺人的专辑在相关度相同时按年份排序。
- 封面同时查询 [Cover Art Archive](https://coverartarchive.org/)、Apple Music 与网易云音乐，使用先成功且元数据相符的图片。中文唱片优先使用台湾、香港地区目录；Apple 没有上架的中文唱片也可由网易云音乐补齐。简繁体、艺人别名、双语标题和版本名会统一比较，网络失败时不会把失败结果永久写入封面缓存。
- 匹配支持简繁转换、空格与大小写归一、艺人别名和 MusicBrainz 提供的专辑别名，兼容重制版、地区版名称。对于“Jay / 同名專輯”、陶喆同名专辑、Beatles 白专辑，以及“夢想家 The Dreamer / The Dreamer”“Groupies 吉他手 / 吉他手”这类地区目录只保留半个双语标题的情况，会结合艺人、发行年份与曲目数核对，并排除现场、翻唱和混音等不同发行。简繁转换使用随桌面应用打包的 OpenCC。
- 仍无法找到时显示黑胶占位图。数据库没有收录、地区目录差异或网络问题可能导致个别封面缺失。
- 封面通过本地服务加载并缓存，减少重复下载，也让 PNG 导出不受跨域图片限制。首次检索和未缓存封面需要联网，已有收藏可离线编辑。

## 数据与迁移

仓库中的 [唱片墙收藏备份](backups/album-wall.json) 是 2026 年 11 月 21 日的快照。要在另一台电脑上恢复这份收藏，请打开“数据与同步”，点击“导入备份”并选择该 JSON 文件。

桌面版收藏保存在 `%APPDATA%\AlbumWall\library\album-wall.json`，封面缓存位于其中的 `covers` 文件夹。桌面版启动时会先同步读取这份持久文件，再绘制首屏，避免空的浏览器存储覆盖或遮蔽已有收藏。每次编辑都会同步写入主文件，关闭窗口前不会依赖尚未完成的后台队列；每次保存先写临时文件再原子替换，并在 `library\backups` 保留快照。若主文件因中断损坏，启动时会从最近的有效快照恢复。应用页面和 API 都通过本机回环 HTTP 服务提供，内部端口变化不会影响收藏文件。更新程序时保留该数据目录。

浏览器版和桌面版使用各自的本地存储。将旧收藏迁移到桌面版：

1. 在原浏览器页面打开“数据与同步”，导出 JSON 备份。
2. 在桌面版打开同一面板，选择“导入备份”。

导入会合并收藏，同一唱片保留更新的记录及删除标记。桌面版“数据与同步”还可以选择 OneDrive、Dropbox 或坚果云已经同步的本地文件夹，应用会把同一份 JSON 原子镜像到该目录，不需要输入云端账号密码。选择文件夹时会先按每条记录的更新时间合并双方内容，再写回并保留快照。

如果需要真正的云端数据库，可以在“数据与同步”中填写自己的 Supabase 项目 URL 和 anon key。先在 Supabase SQL Editor 执行 `supabase/migrations/001_library.sql`，并在 Authentication → Providers 开启 Anonymous；点击“连接云端”后再点击“同步收藏”，应用会使用匿名用户把记录 upsert 到 `library_records`，每次按 `updatedAt` 合并本地与云端版本。anon key 和匿名会话只保存在当前设备的应用存储中，未配置时不会向 Supabase 发请求。没有同步文件夹或云数据库时，仍可随时导出 JSON；评分、简评和个人分类只保存在本地及你主动选择的同步目标。搜索关键词会发送给 MusicBrainz 与 Apple Music；加载封面时会向 Cover Art Archive、Apple Music 或网易云音乐发送公开的唱片信息。

## 开发与打包

开发环境需要 Node.js **22.12 或更高版本**。首次设置桌面运行环境：

```bash
npm install
npm run setup:desktop
npm start
```

`setup:desktop` 下载 Electron 运行时，已安装时会跳过。下载与首次构建需要网络。生成可直接分发的 Windows 应用：

```bash
npm run package
```

输出到 `dist/Album Wall-win32-x64`。打包前关闭正在运行的该目录中的应用。若 `.cache/electron-zips` 中存在对应版本的 Electron ZIP，构建脚本会使用它；放入的 ZIP 应当先与官方 npm 包的 `checksums.json` 核对 SHA256。

其他命令：

```bash
npm test          # 模型、备份、搜索、HTTP 与封面回归测试
npm run dev       # 可选的浏览器开发模式，监听服务端文件修改
npm run server    # 可选的本地 HTTP 服务，默认 http://127.0.0.1:3000
```

浏览器服务可以从 `.env` 读取 `PORT` 和 `MUSICBRAINZ_USER_AGENT`，参见 `.env.example`。桌面版不依赖 `.env`；自定义 User-Agent 可通过启动进程的同名环境变量传入。浏览器封面缓存位于项目的 `.cache/covers`。

## 代码与接口

- `desktop/main.mjs` / `preload.cjs`：桌面窗口、固定应用地址、单实例、本地服务、受限文件保存桥接、磁盘收藏与同步文件夹 IPC。
- `public/app.js` / `styles.css`：页面状态、搜索、筛选、编辑与响应式界面。
- `public/wall.js`：欢迎页和展示页共用的 Canvas 动画、暂停、当前画面导出。
- `public/domain.js` / `artist-identity.js` / `storage.js`：记录校验、艺人身份归一、版本化存储、数据迁移与备份合并。
- `server/musicbrainz.mjs`：MusicBrainz 查询、相关度排序、分页、限流和缓存。
- `server/apple.mjs`：Apple Music 多地区目录查询和受限封面代理。
- `server/catalog.mjs`：合并两个目录并按简繁归一后的标题、艺人和年份去重。
- `server/covers.mjs` / `cover-matching.mjs`：多地区封面查询、名称核对、并发控制与磁盘缓存。
- `server/artwork-providers.mjs` / `request-control.mjs`：目录与封面共用查询缓存、请求合并、取消队列、供应方冷却与 Retry-After。
- `public/cover-loader.js`：卡片与画布共用封面下载，仅加载可见内容；离开页面取消请求，临时失败按退避时间重试。
- `scripts/package.mjs`：仅打包应用所需文件，生成包含运行时的 Windows 程序。
- `supabase/migrations/001_library.sql`：预留的云同步数据库结构，尚未部署。

接口：

- `GET /api/health`：健康检查与版本。
- `GET /api/config`：当前存储能力，云端 `enabled: false`。
- `GET /api/search?q=...&field=all|title|artist&kind=studio|all&limit=20&offset=0`：搜索，默认 `kind=studio`。
- `GET /api/cover/:mbid?title=...&artist=...&year=...`：封面或本地占位图；可重复传入 `artistAlias`（艺人别名）与 `titleAlias`（专辑别名），`X-Cover-Source` 标明来源。
- `POST /api/sync`：暂时返回 `501 CLOUD_NOT_CONFIGURED`。

MusicBrainz 请求间隔至少约 1 秒，合并相同请求并缓存 5 分钟；Apple 与网易云目录查询缓存 15 分钟，默认请求间隔分别为 3.2 秒与 0.7 秒。搜索和封面解析共用已匹配的图片地址；成功图片保存在磁盘，下次打开直接读取。遇到 HTTP 限流或网易云 JSON `code: 405` 时，整个供应方暂停至少 60 秒，并遵守更长的 `Retry-After`。临时失败返回 `503` 与重试时间，确认无封面返回 `404`，两者均禁止 HTTP 缓存，避免将暂时失败保存成永久占位图。每 100 条结果合并排序后分页。桌面服务仅监听随机的本机回环端口。渲染页面启用沙盒、上下文隔离与内容安全策略。
