# Raycast 截图与图片 comment

记录日期：2026-11-15。源码已实现，包含截图入口、图片草稿以及原生桥接和 Herdr 传输。实际验收范围见 [local-acceptance.md](local-acceptance.md)。尚未发布新的运行时或 Store 版本。

## 使用流程

1. 在 Raycast Settings → Extensions → Argo，为 **Screenshot and Comment** 设置 **Control + Command + Shift + H**。热键由 Raycast 用户设置管理，扩展不会写入默认热键。现有 Recent Agent Session 的 J 入口继续使用。
2. 激活截图命令，Raycast 隐藏后拖选区域。Escape 取消，不会发送消息。
3. 截图成功后回到捕获开始时的最近会话，直接在原输入栏继续写 comment；右侧显示图片图标及 Image attached，不自动打开 Compose，不展示附件文件名或缓存路径。Enter 明确发送文字及图片，⌘N 可主动打开多行编辑。
4. 没有可用的最近会话时，截图保留在会话选择器中，选择目标后继续编辑。已有图片须确认后替换；已有投递未知的消息禁止换图。
5. 点击输入栏右侧 Image attached，可直接移除、预览或更换图片，无需先打开 ⌘K。移除只清除附件，保留文字草稿；投递未知时仍禁止改动原附件。Actions 中保留相同操作；Attach Image 可手选本地图片，选择并保存后回到原输入位置。首版支持一张 PNG、JPEG 或 WebP，最多 4 MiB，comment 必填。

截图期间打开其他会话不会改变截图原来绑定的目标。启动 Recent 命令失败时，下次激活 Screenshot and Comment 会先恢复已保存的截图。没有任何截图或附件会自动发送。

## 图片实际如何交付

Mac 选择图片后先保存不可变私有副本。草稿只保存图片引用；发送前重新验证实际文件、大小、结构格式及 SHA-256 摘要。改动用户原文件不影响已选择的附件。拒绝目录、符号链接、空文件、超限文件及格式不符或结构截断的图片。结构检查不代替原生图片解码。

| 会话接入 | 交付方式 | 前置条件 |
| --- | --- | --- |
| Claude cooperative pull | `next` 返回 Agent 机器上的私有图片路径和 Read 指令 | 更新 bridge、connector 与 argo-bind skill，Agent 正在等待 `next` |
| Claude Channel | 通知携带 `meta.file_path`，接收说明要求使用 Read | 已注册并确认的可用 Channel，更新 bridge 与 connector |
| Codex shared App Server | 同一次 turn/start 包含 comment 和 localImage | 既有共享运行时已接入，路径对 App Server 可见；仍属实验支持 |
| Herdr 本地或 HC 已配置远端 | terminal.put 先上传真实字节，再引用返回的目标机器路径 | HC 支持可选 terminal.put，目标为已识别的 Claude/Codex，报告 idle 或 done |

Mac 本地路径不能代替远端图片。原生桥接把真实字节以独立 HTTP 字段上传并原子保存为 SQLite BLOB。消息、WebSocket 命令和日志只包含元数据，connector 用绑定专属凭据下载到 Agent 机器的私有目录。跨 binding 下载被拒绝，解绑撤销读取。

新 bridge 在认证后的 WebSocket upgrade 返回 `X-Argo-Images: 1`。connector 仅在看到此标记时注册图片能力。旧 bridge/connector 仍能处理原有文字消息；没有图片能力的目标会在发送前明确提示更新，绝不静默丢图。

Herdr 上传与输入共用持久任务锁。上传后重新检查 owning core、程序指纹和可输入状态，再捕获 baseline 并以 `force:false` 发送。上传成功不表示消息已提交。Shell、工作中的 Agent，以及权限/认证对话框不会通过普通图片发送入口接收输入。远端路径仅用于接收程序读取，原始 comment 与附件元数据仍独立显示。

## 草稿、去重与生命周期

- 原生消息的持久 ID 绑定 comment、图片摘要及完整元数据。相同提交重试不产生第二次执行；相同 ID 换图被拒绝。
- Herdr 区分 upload 与 send 阶段。关闭、断连、程序变化和投递未知不会自动重放。需检查原 Agent 后按现有显式恢复流程处理。
- 失败保留文字和附件。旧提交完成不能清掉用户之后输入的新 comment。文件选择或草稿持久化失败时禁止提交。
- Mac 私有图片缓存上限 100 MiB。附加前清除旧的释放标记并刷新恢复时间，再持久化草稿。确认发送或明确移除后保留七天恢复窗口；未附加或放弃使用的截图也会在七天后由后续导入清理。清理前检查所有持久引用，包括原生/Herdr 草稿、未知投递记录和截图恢复入口；即使有旧释放标记，仍被引用的图片也保留。引用存储读取失败时停止清理，用户原始文件不被清理。
- Bridge 与 connector 各按 binding 限额 100 MiB。完成或明确失败的图片在七天后惰性清理，消息元数据及去重记录保留。排队或未知附件保留到完成或解绑，解绑清理对应字节。Herdr 远端文件随 HC 终端生命周期清理，并有累计上传预算。

## 版本与验收

仓库当前版本号仍为 v0.1.4。旧固定安装 URL 不会获得这次源码更新，不要覆盖现有固定 release 标签。原生图片能力需要从本次源码构建 bridge/connector，并在原 Agent 中显式重新接入。扩展单独更新不代表远端运行时已经支持附件。

测试覆盖原始字节一致性、最大尺寸、作用域和撤销、摘要碰撞、原子失败、旧握手、私有落盘、格式与路径拒绝、截图取消和失败恢复、冻结最近目标、图片草稿恢复、投递未知、Herdr 上传后的新状态检查，以及纯文字回归。

真实图片读取必须通过隔离 Agent 回答只存在于图片像素中的内容。协议 fixture、模拟 App Server/MCP 和编译通过均不能替代真实读图或桌面验收。具体已执行与未执行项统一记录在 local-acceptance.md。
