# 单词听读（背单词 PWA）

一个自己用的安卓背单词网页应用。功能：

- 多个词表，可批量录入单词，自动带出中文翻译（可手改）
- 内置约 4.2 万常见/考试英汉词条，离线可查
- 逐字母拼读 + 读整词（a-p-p-l-e → apple），点一次读一次
- 单词循环、多词按顺序循环，间隔/速度可调
- 背词：闪卡 + 选择题，按简化记忆曲线安排复习
- 导出/导入 JSON 备份
- 可离线使用（PWA），手机“添加到主屏幕”后像 App 一样

## 文件说明

- `index.html`、`styles.css`、`app.js`：应用本体
- `dictionary.json`：离线英汉词典（约 4.2 万词条）
- `manifest.webmanifest`、`sw.js`、`icons/`：PWA 安装与离线缓存

## 本地试运行（可选）

在电脑上这个文件夹里运行一个本地服务器：

```bash
python -m http.server 8000
```

然后浏览器打开 `http://localhost:8000`。

> 注意：PWA 的“添加到主屏幕”和离线缓存需要 HTTPS 或 localhost 才能生效，
> 所以正式使用请发布到 GitHub Pages。

## 发布到 GitHub Pages

1. 在 GitHub 网页或 GitHub Desktop 里新建一个仓库（例如 `wordbook`），设为 **Public**。
2. 把这个文件夹里的所有文件上传到仓库的根目录（不要套一层文件夹）。
3. 在仓库页面点 **Settings → Pages**，把 Source 选为 **Deploy from a branch**，
   分支选 `main`，目录选 `/ (root)`，保存。
4. 等一两分钟，页面会显示网址：`https://<你的用户名>.github.io/wordbook/`。

## 装到安卓手机

1. 手机 Chrome 打开上面那个网址（首次需要联网）。
2. 等页面加载完，点浏览器右上角菜单 → **添加到主屏幕**（Add to Home screen）。
3. 桌面出现“单词听读”图标，之后点图标就能用，没网也能用。

## 使用建议

- 首次联网打开一次，让离线词典缓存到手机里，之后可断网使用。
- 换手机或怕丢数据：在“设置”里点“导出”，把 JSON 文件存好；新设备用“导入”恢复。
