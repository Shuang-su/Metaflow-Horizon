# 正式发布回执

2026-11-16（Asia/Shanghai）完成内容与阅读界面的同批发布。

- 整合 PR：[#138](https://github.com/Shuang-su/Metaflow-Horizon/pull/138)。最终产品 checkpoint `1b71a4a35bfc4576b88058fb60ad3294e77ba3d6`；合并提交 `9c6b36717ca4cd60baf5e8d4dd924a235e479cf0`。
- [独立部署运行](https://github.com/Shuang-su/Metaflow-Horizon/actions/runs/43756288368)全部通过，包括正式站回读。未修改 Metaflow 主站或代理配置。
- 正式地址：<https://metaflow.shuang-su.com/horizon/>。共 59 期，最新一期为 2026-11-15。
- 首页、搜索、日报／周报／文章 RSS、sitemap 均通过回读；11 月 10、13、14、15 日的原文与阅读稿 SHA-256 和当前部署一致。证据见 [public-readback.json](evidence/public-readback.json) 与 [selected-reports-readback.json](evidence/selected-reports-readback.json)。
- 正式站 613×939 阅读页确认：无独立“日报”小字，元信息两端对齐，圆按钮 44×44 px，速览无固定讨论／纠错项；字号面板从按钮展开，Escape 收回后恢复焦点，无菜单或残留动画。运行日志未捕获页面错误。见 [published-reader.jpg](evidence/published-reader.jpg)。
- 补充目录面板鼠标输入验证：持有左键时移动 65 px，面板跟随；回弹途中重新抓取保持当前位置；175 px 下拉关闭，焦点回到“打开文章目录”。见 [sheet-mouse-drag.json](evidence/sheet-mouse-drag.json)。最初测试将移动消息的 button 置为 none，导致输入链取消；更正为按住 left 后通过，不计作产品缺陷。
- 本地 4337 已改为 `/horizon/` 构建；旧 `/gaussian-splatting-daily/` 路径重定向并保留路径与查询参数。本地构建记录产品 checkpoint，线上记录其合并 SHA，产品代码和稿件相同。

11 月 14、15 日分别通过 `record_publication.py --mode manual` 校验远端 main、首页、详情与源文件后记账。发布游标推进至 11 月 15 日，观察表追加两条人工补发。研究记录的采集模式保持原样，连续定时成功仍为 **0/3**，[#129](https://github.com/Shuang-su/Metaflow-Horizon/issues/129)继续观察。回执提交与后续部署的 SHA 会变化，但不会重复计算补发成功。

实体 iPhone Safari 的手势与 HDR、Mac 真实触控板惯性、iPad／折叠屏连续尺寸变化仍待设备验收，浏览器结果不替代这些结果。真实 Giscus 登录返回已在本地验证，草稿测试后清空，未提交测试评论。
