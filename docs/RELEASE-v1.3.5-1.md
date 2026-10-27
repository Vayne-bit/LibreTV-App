## 流水线验证（临时）

这个 tag 只用来验证 release 作业会读取 `docs/RELEASE-<tag>.md` 作为正文，验证完立即删除。

- 如果 release 页面上能看到这段文字，说明 `body_path` 生效
- 如果只看到 `**Full Changelog**` 一行，说明还是走了自动生成的分支
