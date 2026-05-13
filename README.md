# 光鸭云盘 aria2 助手

油猴脚本，在光鸭云盘网页上加一个浮动面板：勾选文件夹/文件 → 点一下 → 自动取签名直链 → 推到 aria2。**aria2 落地的目录结构与云盘保持一致**。

## 这个脚本能做什么

- 在 `https://guangyapan.com` 系列页面右下角注入一个面板
- 自动拦截光鸭 API 的 `authorization` / `did` / `dt` 三个鉴权头（你正常登录刷一下目录就够了，无需手填）
- 勾选任意数量的文件 + 文件夹（可混合）后：
  - 递归展开所有子层文件夹，BFS 遍历光鸭 `get_file_list`
  - 并发 3 路调用 `get_res_download_url` 拿签名直链
  - 通过 `system.multicall` 把 50 条直链合一次 HTTP 提交到 aria2 JSON-RPC
- aria2 的 `dir` 字段保留路径：云端 `A/B/video.mp4` → 本地 `{下载根}/A/B/video.mp4`
- 配置（aria2 地址、secret、下载根、手填鉴权头）持久化在脚本管理器里，刷新页面不丢

## 不能做的

- 取消已推送的 aria2 任务、查询下载进度、断点续传——交给 aria2 前端去做（AriaNg 等）
- 不绕开光鸭服务端限流；签名 URL 有时效（通常 1-12 小时），aria2 排队太久会过期 403
- 不动云盘文件本身（不重命名、不删除、不上传）

## 安装

1. 浏览器装 [Tampermonkey](https://www.tampermonkey.net/) 或 [Violentmonkey](https://violentmonkey.github.io/)
2. 打开脚本管理器 → 「创建新脚本」→ 把 `光鸭云盘-aria2助手.user.js` 内容整段粘贴 → 保存
3. 访问 `https://guangyapan.com/`，右下角应该出现深色面板「光鸭→aria2」

Tampermonkey 首次会因为 `@connect *`（aria2 RPC 地址用户填的，不确定）弹窗确认跨域，点允许即可。

## 配置

展开面板「设置」一栏：

| 字段 | 说明 |
|---|---|
| aria2 RPC URL | 形如 `http://127.0.0.1:6800/jsonrpc`。家用 NAS、远程服务器都行 |
| aria2 Secret | aria2 启动时的 `--rpc-secret`。没设就留空 |
| 下载根目录 | aria2 守护进程视角的可写绝对路径，所有下载会落在它下面 |
| 取直链并发 | 默认 3。光鸭对 `get_res_download_url` 频率敏感，建议别调高 |
| 每批 multicall 条数 | 默认 50。一次 RPC 调用打包多少条 `addUri` |
| 调试日志 | 勾选后把每次拦到的 guangyapan 请求 URL、列表项数都打到面板日志，排错用 |

设置面板下方还有「手填光鸭认证」三个文本框（`Bearer …` / `did` / `dt`）。**正常情况留空即可**——脚本会自己从你刷新过的 API 请求里拿。手填值只在自动捕获失败或你想覆盖时才需要。

aria2 启动建议（最少参数）：

```bash
aria2c \
  --enable-rpc \
  --rpc-listen-all \
  --rpc-allow-origin-all \
  --rpc-secret=YOUR_SECRET \
  --dir=/downloads
```

## 使用

1. 在云盘里进到你要下载的目录（让脚本拦到一次 `get_file_list`）
2. 看面板左上角状态：
   - `✓拦截器已装` —— 注入成功
   - `认证：已就绪：Bearer / did / dt` —— 三个鉴权头都拿到了
   - `当前目录：parentId=… 已缓存 N 项` —— 当前目录的文件列表已经被脚本看到了
3. 勾选你想下载的若干文件夹/文件（可混合可多选）
4. 点 **「推送选中到 aria2」** —— 完整跑「展开 → 取直链 → 推送」
   - 或先点 **「展开预览」** 看看会下哪些文件、落到哪个目录，确认后再正式推
   - 或先点 **「测试 aria2」** 验证 RPC 连通
5. 日志区会显示每一步进度，例如：
   ```
   勾选 1 项：测试A
   展开完成，共 12 个文件
   直链就绪 12/12
   已推送 12/12，aria2 失败 0，取直链失败 0
   ```

## 排错

| 现象 | 怎么办 |
|---|---|
| 「⚠拦截器未确认」 | 强刷新页面 `Ctrl+Shift+R`，确保脚本在 `document-start` 抢在页面前装好 hook |
| 「认证：缺少 …」 | 在云盘里进任一目录刷一次列表请求；或在「设置-手填光鸭认证」里粘贴一份 |
| 「当前目录：未拦截」 | 确认是不是没在云盘的「文件列表」页（脚本只拦 `get_file_list`） |
| `[list] → 0 项` | 勾选「调试日志」，下一次列表请求会带 `[shape]` 信息（顶层 keys、数组分布、首元素 keys）；贴回给开发者，把字段名加进 `ID_KEYS`/`NAME_KEYS` 即可 |
| `aria2 错误 1: Unauthorized` | RPC secret 填错 |
| 推送成功但 aria2 下不动 | 八成是签名 URL 过期，光鸭 `signedURL` 一般 1-12h 失效，等不了那么久 |
| 含中文 / 特殊字符的路径 | 不需要额外处理，aria2 的 `out`/`dir` 字段都按 UTF-8 透传 |

## 路径还原细节

例：你勾选了云盘里的文件夹 `电影/动画`，它下面有 `第一季/01.mkv`，下载根设为 `/downloads`。

- 脚本展开到的相对路径是 `动画/第一季/01.mkv`（**从被勾选的那一层开始**，不带云盘根到它的祖先路径）
- 推到 aria2 的参数：`dir=/downloads/动画/第一季`，`out=01.mkv`
- aria2 自动创建中间目录，最终落地 `/downloads/动画/第一季/01.mkv`

如果你想保留更长的上下文（包含「电影」这一层），在云盘里进到 `电影` 目录后再勾选 `动画` 文件夹，路径就会是 `动画/...`；当前版本不自动追加云端祖先路径。

## 安全提示

- 脚本只往 `api.guangyapan.com` 和你配置的 aria2 RPC 发请求
- `authorization` / `did` / `dt` 和 aria2 secret 都存在脚本管理器自带的存储里（GM_setValue），跟脚本同源，不会暴露给页面 JS
- 不上传任何东西到第三方服务

## 文件

| 路径 | 说明 |
|---|---|
| `光鸭云盘-aria2助手.user.js` | 主脚本（约 1200 行） |
