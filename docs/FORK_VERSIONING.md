# Fork 版本号规则 / Fork versioning

## 规则

本 fork 的版本号**不使用**上游的版本号，而是：

```
fork 版本 = 上游 MAJOR.MINOR . (上游 PATCH × 100 + fork 序号)
```

| 基于的上游版本 | fork 第 1 次发布 | fork 第 2 次发布 | tag |
| --- | --- | --- | --- |
| 0.2.10 | 0.2.1001 | 0.2.1002 | `v0.2.1001`, `v0.2.1002` |
| 0.2.11 | 0.2.1101 | 0.2.1102 | `v0.2.1101` |
| 0.2.12 | 0.2.1201 | 0.2.1202 | `v0.2.1201` |
| 0.2.9  | 0.2.901  | 0.2.902  | `v0.2.901` |
| 0.3.0  | 0.3.1    | 0.3.2    | `v0.3.1` |

fork 序号从 1 开始，最多 99。上游 MINOR 或 MAJOR 变了就照常跟着变（0.3.0 → 0.3.1）。

## 为什么不用 `0.2.10-1` 或 `0.2.10+1`

- `fork-release.py` 只接受 `vMAJOR.MINOR.PATCH` 的 tag。
- Tauri 更新器按 semver 比较：`0.2.10-1` 是预发布版，**比 `0.2.10` 小**，装了 0.2.10 的用户收不到更新。
  `strata_control/feed.py` 的 `app_version_key` 也是这样排序。
- `0.2.10+1` 的构建元数据在 semver 比较里被忽略，等于 `0.2.10`，同样不会更新。
- 直接用 `0.2.11` 会和上游以后的 0.2.11 同名，tag 也会冲突。

`PATCH × 100 + 序号` 全是数字，现有比较逻辑都能正确排序，而且总是大于它所基于的上游版本，也不会和上游 tag 重名。
桌面端只打 NSIS 包（没有 MSI 的 65535 限制），所以较大的补丁号没有问题。

## 同步上游后要做的事（重要）

合并上游代码时，上游会把下面这些位置改成它自己的版本号（例如 `0.2.11`）。**合并后必须改回 fork 规则的版本号**（例如 `0.2.1101`）：

1. `apps/desktop/package.json` 的 `version`
2. `apps/desktop/src-tauri/Cargo.toml` 的 `version`
3. `apps/desktop/src-tauri/Cargo.lock` 里 `name = "strata-desktop"` 下面的 `version`
4. `apps/host/package.json` 的 `version`
5. `apps/host/package-lock.json` 顶层的 `version` 和 `packages[""].version`
6. `strata_cli/__init__.py` 的 `PRODUCT_VERSION`
7. `AGENTS.md` 第一行 `Version X, engine Y.`（engine 版本保持上游的，不要改）
8. `tests/terminal/test_tui2_023_versions.py` 里的期望版本（包括 `strata X (build Y;` 那一行）
9. `apps/host/tests/qa1-storage.test.mjs` 里 `assert.equal(cargo, '...')` 的期望版本
10. `tests/terminal/test_tui2_023_old_launcher.py` 里 `strata X (build ` 的期望版本

只改 app/Terminal 版本。engine、Control 的版本（`CMakeLists.txt` 等，如 `0.1.56`）跟上游走，不要套 fork 规则。

`tests/terminal/test_fork_release.py` 里有一个检查：桌面端版本的 PATCH 不符合 fork 规则（小于 100，或序号为 0）时测试会失败，
这样忘了改版本号会在 CI 里直接报出来。

## 发布步骤

1. 按上面的规则改好版本号，合并到 `main`。
2. 在该提交上打 tag，例如 `git tag v0.2.1001 && git push origin v0.2.1001`。
3. GitHub Actions → **Prepare signed fork release** → **Run workflow**，"Use workflow from" 选这个 tag。
4. 如果 `fork-release` 环境要求审批，批准它。
5. workflow 只生成**草稿** release。检查后发布，并勾选 **Set as the latest release**
   （客户端的更新地址是 `releases/latest/download/latest.json`）。

签名密钥等配置见 [FORK_CI.md](FORK_CI.md#fork-updater-release-preparation)。

---

## English summary

Fork app version = upstream `MAJOR.MINOR.(PATCH × 100 + n)`, n = 1..99. Upstream 0.2.10 → fork 0.2.1001, 0.2.1002;
upstream 0.2.11 → 0.2.1101; upstream 0.2.12 → 0.2.1201. Suffixes like `0.2.10-1` sort *below* 0.2.10 in semver (Tauri updater and
`app_version_key`) and are rejected by `fork-release.py`. After every upstream sync, reset the ten app/Terminal
version locations listed above to the fork number; leave engine/Control versions as upstream has them.
`test_fork_release.py` fails if the desktop patch number does not follow this rule.
