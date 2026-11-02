# 手机「常驻」：装到桌面

> 一句话：**用手机浏览器打开带口令的链接 → 点安装（或在浏览器菜单里选「安装应用 / 添加到主屏幕」）→ 桌面上就有一个独立图标，全屏打开、不掉登录。**

## 一、为什么必须装到桌面，而不是「收藏个网页」

| | 普通网页书签 | 装到桌面（PWA） |
|---|---|---|
| 打开方式 | 先进浏览器，再点书签，带地址栏 | 桌面图标一点直达，**没有地址栏**，独占全屏 |
| 登录态 | 靠 Cookie，浏览器清缓存就没了 | 同上，但 Cookie 现在是 **365 天** |
| 断网 | 白屏 | **外壳能打开**（SW 缓存），数据等联网 |
| 更新 | 刷新即可 | 刷新即可（`sw.js` network-first，永远拿最新外壳） |

## 二、按你手机的系统来

### 安卓（Chrome / Edge / 三星浏览器）

1. 打开链接（就是二维码那个 `?t=` 地址）；页面顶部会出现紫条：**「把它装到桌面，以后不用再输网址」**；
2. 点右边 **「安装」**，系统弹确认，点 **安装**；
3. 桌面出现紫色对勾图标 —— 完事。

> 没看到紫条或安装按钮？右上是 **⋮（三个点）→「安装应用」/「添加到主屏幕」**，效果一样。
> 小米/OPPO/vivo 自带的浏览器菜单里也叫「添加到主屏幕」，会创建一个快捷方式，行为一致。

**紫条被关掉了也不怕**：页面右上角「待办台」旁边有个常驻的 **「装到桌面」** 胶囊按钮 ——

- Chrome/Edge 这类支持安装的浏览器里，它会变成高亮的 **「一键装到桌面」**，点一下直接弹系统安装框；
- 不支持的浏览器（vivo 自带、UC、夸克等）里它显示 **「怎么装到桌面」**，点一下就把对应菜单路径再告诉你一遍。

### iPhone / iPad（Safari，**必须 Safari**）

1. 用 Safari 打开链接；
2. 点底部中间 **分享 ⬆** → 往下找到 **「添加到主屏幕」** → 右上角 **添加**；
3. 桌面出现图标，点开就是全屏，不会跳回 Safari。

> iOS 上的限制（不是 bug）：苹果只允许 Safari 把网页装到桌面；Chrome/Edge for iOS 只有「添加到书签」。所以 iPhone 上请务必用 Safari，紫条也会这样提示。

### 微信 / QQ 里点开的链接

微信内嵌浏览器**不能**装到桌面（腾讯屏蔽了 PWA 安装）。紫条会提示：**点右上角 ⋯ →「在浏览器打开」**，落进系统浏览器后按上面两步做。

## 三、装好之后你会得到什么

- **一个图标，全屏运行**，状态栏沉浸，没有地址栏，不会被误关标签页；
- **登录一次管一年**（`AUTH_TOKEN` 种进 Cookie，`Max-Age=365 天`，`SameSite=Lax`）；
- **断网也能打开外壳**，显示上次的界面骨架，联网后自动刷数据（数据永远在服务器，不在缓存里）；
- 想卸掉：长按图标 → 卸载 / 移除；服务器端数据不受影响。

## 四、这版为了「能装」改了什么（技术记录）

1. `public/manifest.webmanifest`：补齐 `id` / `start_url` / `scope` / `display: standalone` / `orientation` / PNG 图标（192、512、maskable 512）+ `theme_color`；
2. 新增图标位图：`icon-192.png`、`icon-512.png`、`icon-maskable-512.png`（满版深色，安卓自适应裁切不会被切边）、`apple-touch-180.png`（iOS 主屏图标）；
3. `public/index.html`：补 `mobile-web-app-capable`、`apple-mobile-web-app-*`、`apple-touch-icon`；
4. `public/sw.js`：缓存名升到 `qqtd-shell-v2`，外壳清单纳入全部图标；
5. `public/app.js` 新增 `setupInstall()`：
   - 收到 `beforeinstallprompt` → 顶部紫条 + **安装**按钮（真的调 `prompt()`）；
   - 1.8 秒内没收到事件 → 按 UA 给不同指引（微信内「在浏览器打开」、iOS「分享 → 添加到主屏幕」、其他「浏览器菜单里安装」）；
   - 用户关掉或已装好 → 记 `localStorage`，**不再打扰**；`appinstalled` 事件后给一次「已装到桌面」提示；
6. `src/server/app.js`：
   - Cookie 有效期 30 天 → **365 天**；
   - **`manifest.webmanifest` / `sw.js` / 全部图标改成免口令公开**（见下条，这是踩到的真坑）。

### 踩到的坑：首次扫码安装会失败

浏览器解析 HTML 时就会去抓 `manifest` 和图标，这一次请求**可能早于 `Set-Cookie` 生效**，被 401 挡掉后 Chrome 会把「manifest 不可用」记下来 → 首屏点安装没反应，要刷新一次才行。
实测证据：CDP `Page.getInstallabilityErrors` 报 `manifest-parsing-or-network-error` + `no-acceptable-icon`，同一 profile 刷新后全部消失。

修法：把**安装元数据**放进公开白名单（`src/server/app.js` 的 `PUBLIC_PATHS`）——`manifest.webmanifest`、`sw.js`、4 个图标。它们不含任何用户数据；页面本体 `/` 与 `/api/*` 仍然要令牌（无 `t` 返回 401，已用 curl 复验）。

## 五、验收口径（可复跑）

验收分两层，都是脚本化、可重复的：

```text
① 本机：伪造 beforeinstallprompt、微信 UA、iOS UA、appinstalled 四种情形，26 项断言
② 公网：https + 真实可安装性判定（CDP Page.getInstallabilityErrors）+ 断网开外壳，12 项断言
```

第二层用的是 Chrome DevTools Protocol 的 `Page.getInstallabilityErrors` —— 返回空数组才算「真可安装」，
这是浏览器自己给的判定，不是我们自己说的。第一层的断言覆盖四种 UA 下的安装入口文案与事件绑定。

## 六、还差的最后一步（可选）

现在公网入口是 Cloudflare 临时隧道（`*.trycloudflare.com`），**能装、能离线，但域名是临时的，且国内移动网络偶有抖动**（实测 8 次里 2 次连接失败，随后 6 次全通；服务器侧 6/6 通）。

想彻底稳，两个正规做法，都只差你点一下：

1. **放行阿里云安全组 7788** → 直接走 `http://your-server:7788`。稳，但是 http，装不到桌面（只能存书签）。
2. **给一个域名 + Cloudflare 账号**（免费版即可）→ 我给你配 named tunnel，`https://todo.你的域名`，稳定 + HTTPS + 可安装，一次配好长期有效。

两条都不做也能用：隧道断了重拿新地址即可（`grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' /var/log/cloudflared.log | tail -1`）。
