# 计数伴侣（PWA）

一个轻量的计数器工具，支持多计数器、备注与历史、导入导出，并可安装为 PWA 离线使用。前端纯静态（HTML/CSS/JS），无需后端。

## 在线访问
- GitHub Pages（HTTPS，可直接安装为 PWA）：https://125tiantian.github.io/counter-buddy/

## 功能概览
- 多计数器：新增、+1、−1（−1 视为撤销最近一次 +1）、重命名、删除（应用内确认弹窗）。
- 历史与记录：
  - +1 历史自动记录；支持“快速记录”（不加一，仅写一条带时间的记录）。
  - 历史项可直接“编辑/删除”，并带有过渡动画。
  - 历史徽标随主题变色（+1/记录/−1 有所区分）。
- 快速记录按钮：在每张卡片“+1”右侧新增小按钮“记”，点开与 +1 备注一致的输入浮层。
- 拖拽排序：支持拖拽改变卡片顺序（含 FLIP 动画）；触屏设备下可在“更多”菜单使用“上移/下移/置顶/置底”。
- 导入/导出：JSON 导入导出；PC/PWA 上优先使用文件保存对话框（File System Access），避免重复弹框。
- 主题与动效：粉/薄荷/蓝主题；重命名逐字上浮、卡片新增/删除、对话框进出场、菜单弹层动效。
- PWA 离线：安装后可离线运行；首屏采用“缓存优先 + 后台更新”，启动更快（GitHub Pages 部署下无需“强制刷新”按钮，更新将后台完成）。

## 目录结构
```
counter-buddy-web/
  index.html        # 主页面（注册 SW、PWA 元信息）
  styles.css        # 样式与动画
  app.js            # 逻辑（计数、历史、弹窗、拖拽、PWA 行为）
  manifest.webmanifest
  sw.js             # Service Worker（缓存策略）
  icons/
```

## 使用方式
### 直接打开（快速试用）
- 打开 `counter-buddy-web/index.html` 即可使用（此模式下不注册 SW，不支持脱机）。
- 或直接访问在线版本（GitHub Pages）：https://125tiantian.github.io/counter-buddy/
- 数据存储在浏览器 `localStorage`，可随时导出 JSON 备份。

### 本地安装为 PWA（推荐）
1) 在 `counter-buddy-web` 目录启动本地服务器（示例）：
```bash
python -m http.server 5173
```
2) 访问 `http://127.0.0.1:5173`，浏览器地址栏或菜单中选择“安装应用/添加到主屏幕”。
3) 安装后以独立窗口打开，离线也能使用（资源已缓存）。

说明：为了避免开发缓存干扰，“localhost 的普通标签页”默认不注册 SW；但“已安装窗口”会注册 SW 以支持离线。

### 生成 PNG 图标（提升“可安装”稳定性）
- 新增了更精致的图标（SVG）以及图标生成器：
  - `icons/icon.svg`（圆角背景版本）
  - `icons/icon-maskable.svg`（maskable 全屏版本）
  - `icons/generate-icons.html`（在浏览器一键导出 192/512 PNG）
- 使用方法：
  1) 用桌面 Chrome 打开 `icons/generate-icons.html`（直接双击或通过本地服务器访问均可）。
  2) 点击“【一键生成并保存两个 PNG】”，保存到项目的 `icons/` 目录下（文件名已经内置为 `icon-192.png` 和 `icon-512.png`）。
  3) 重新打开站点一次让 Service Worker 缓存新资源（已将这两个 PNG 加入缓存列表）。

说明：manifest 已加入 PNG 与 SVG 两类图标，浏览器会自动挑选合适资源。PNG 能提升在部分设备上的安装判定与图标显示质量。

### 安卓 & Windows 安装说明（仅考虑 Android/Win）
- Windows/本机开发：在浏览器里打开 `http://localhost` 或 `http://127.0.0.1`，即可安装 PWA（Chrome 允许 localhost 在 HTTP 下注册 Service Worker）。
- 局域网访问（Android/Windows 手机/平板 → 访问 PC 的局域网 IP）：
  - 仅使用 `http://192.168.x.x:端口` 时，属于“非安全上下文”，浏览器会拒绝注册 Service Worker，导致无法“真正安装应用”，菜单里通常只显示“添加到主屏幕”快捷方式。
  - 要在局域网设备上安装，需满足“安全上下文（HTTPS）”。推荐两种方式：
    1) 使用外网隧道（最省事）：Cloudflare Tunnel / ngrok / localtunnel，将本机服务暴露为一个 HTTPS 域名，手机用该域名访问即可安装。
    2) 自签/本地证书（纯内网）：使用 mkcert 等工具给一个本地域名（如 `counter-buddy.local`）签发证书；在 Windows 与 Android 上都导入根证书并信任；两端 hosts 指向你的内网 IP；用 Nginx/Caddy/Node 等开 HTTPS 站点后访问安装。
  - 仅用于开发的临时方案（不建议长期使用）：在 Android Chrome 打开 `chrome://flags/#unsafely-treat-insecure-origin-as-secure`，把你的 `http://192.168.x.x:端口` 加入允许列表，重启浏览器后可在 HTTP 下测试 PWA 安装与 SW 行为。

安装判定要点（Android/Windows Chrome）
- 必须：HTTPS（或 localhost）+ 正常可用的 Service Worker。
- Manifest 必须有效：`name/short_name/start_url/display`；建议提供 PNG 图标（至少 192×192 与 512×512，含 `purpose: maskable`）。仅有 SVG 图标在某些设备上不会触发“可安装”。
- 验证路径：Chrome DevTools → Application → Manifest/Service Workers；或用 Lighthouse 的 PWA 审计。

### 部署到线上（HTTPS）
- 任意静态托管（GitHub Pages、Vercel、Netlify、Nginx 等）均可，建议开启 HTTPS 以便移动端安装。

## 在手机上好用吗？
支持安装到主屏幕离线运行：
- Android（Chrome/Edge）：HTTPS 访问 → 菜单 → “添加到主屏幕/安装应用”。安装后离线可用，数据在本地存储。
- iOS/macOS 暂不在本项目考虑范围内（仅 Android/Windows 侧重）。

注意事项（移动端）：
- PWA 在 HTTP（如局域网 IP）下无法安装；需 HTTPS。
- 某些浏览器对“直接下载文件”支持不一致，项目已内置导出 JSON 的多级回退（FSA/分享/下载/剪贴板）。

## 移动端问题与修复（Android 为主）
- 点击白色闪一下：移动浏览器会给点击元素加系统高亮（tap highlight），自定义按钮上看起来像白光一闪。已在样式中关闭 `-webkit-tap-highlight-color` 并去掉原生按钮外观，修复闪白。
- 计数徽章动画在手机上不明显：`rotateX` 在移动端没有透视时效果很弱。已在关键帧中加入 `perspective(...)` 并设置 `will-change: transform`，动画可见性与流畅度更好。
- 输入法遮挡：
  - 重命名弹窗：以前不随键盘上移；
  - 历史记录里备注编辑：会上移过头；
 统一改为基于 `visualViewport` 计算与“恰好在键盘上方约 10px”的上移量，对话框/浮层/主面板按需平移，失焦后还原。
- “−1” 在 0 时禁用：这是刻意的（把 −1 视为撤销最近一次 +1），因此 0 时点击不会有动画；如果需要“不可用时轻微提示动画”，可后续按需添加。

提示：如果你通过 HTTP 局域网访问（非 localhost），你会看到“添加到主屏幕”只创建快捷方式，不是“真正安装”。这是浏览器对非安全上下文的限制；按上面的 HTTPS 方案处理后，安装入口会出现。

## 已实现的交互与细节
- 快速备注（+1）：Shift 点击或长按“+1”弹出备注浮层（默认聚焦全选，长按阈值约 0.32 秒）。
- 快速记录（不加一）：点击“记”按钮弹出同款浮层，确认时若输入为空则显示“直接记录”，有内容则显示“添加记录”。
- “−1” 视为撤销最近一次 “+1”（历史仅保留 “+” 条目）。
- 历史编辑/删除：进入编辑时时间淡出、输入框滑入；保存/取消时反向动画；输入框默认全选。每项右侧提供圆形红色删除按钮。
- 重命名：保存后标题逐字上浮动画，输入框默认全选。
- 删除/清空/重置：应用内确认弹窗（淡入/淡出），卡片删除/清空带收拢过渡动画。
- 菜单（…）：鼠标悬浮 150ms 才弹出，点击立即弹出；若底部空间不足自动向上弹出；快速移动时不误关。

## 历史视图优化
- 日期两行显示：第一行是日期，第二行是时间，在窄窗口也不拥挤。
- 控件靠右：记录/加一 → 编辑 → 删除，三者整体靠右；备注文本在其左侧自然换行、完整显示。
- 删除项悬浮：危险项 hover 颜色更明显，不会被浅色 hover 覆盖。

## 备份与迁移
- 通过“导出 JSON/导入 JSON”完成备份与迁移，适合跨设备或重装场景。
- 桌面/PWA 环境下导出优先走系统“另存为”（File System Access），失败再回退到分享/下载/剪贴板。

## 开发提示
- 修改 `app.js` 与 `styles.css` 可直接看到效果；若以 PWA 安装，建议在联网状态打开一次并重启应用，以确保 SW 拉取到最新版本。
- SW 策略：
  - 文档（index.html）：缓存优先 + 后台更新（并启用 Navigation Preload），启动更快。
  - 其它资源：stale-while-revalidate。
- 本地开发：localhost 普通标签页默认不注册 SW（避免缓存干扰）；“已安装窗口”会注册 SW 以支持离线。

## 变更记录（节选）
- v1.1.0
  - 新增“快速记录”按钮（不加一，记录一条带时间的备注）。
  - 历史项支持一键删除；“编辑备注/添加备注”文案简化为“编辑/添加”。
  - +1 徽标随主题变色；危险项 hover 视觉更明显。
  - 页脚改为独立区域，内容较多时不再遮挡列表。
- v1.0.16
  - 首屏更快：文档改为缓存优先 + 后台更新，启用 Navigation Preload。
  - 导出体验：桌面/PWA 优先使用 File System Access，避免重复弹窗；保留分享/下载/剪贴板回退。
  - 菜单体验：悬浮 150ms 才弹出；底部空间不足自动向上弹出；移入弹层不误关。
  - 布局修复：移除计数区的最小高度强制，修正窗口高度变化时底部留白问题；卡片不再显示抓手指针。
  - 历史对话框：名称与当前值样式重做并增加分隔线，更清晰。

---
如需进一步适配移动端（更大触控区域、更多手势、窄屏优化等）或添加高级能力（云同步、账号、多设备合并），欢迎提 Issue/PR。
