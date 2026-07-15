# 更新器自测通道使用说明

## 目标

自测通道用于开发者在本机验证刚打出来的安装包或 ASAR 包，不影响正式
`cmbdevclaw-latest.json`，也不占用正式 `staging` 灰度名单。

默认情况下客户端仍然走正式更新源。只有本机存在并启用了
`update-channel.json` 时，客户端才会改读自测 manifest。

## 开关文件

Windows：

```text
C:\Users\<用户名>\.cmbcoworkagent\update-channel.json
```

macOS / Linux：

```text
~/.cmbcoworkagent/update-channel.json
```

推荐内容：

```json
{
  "enabled": true,
  "channel": "selftest",
  "manifestFile": "cmbdevclaw-latest.selftest.json",
  "baseUrl": "http://127.0.0.1:8787",
  "expiresAt": "2026-07-15T23:59:59+08:00"
}
```

字段说明：

| 字段           | 必填 | 说明                                                                           |
| -------------- | ---: | ------------------------------------------------------------------------------ |
| `enabled`      |   是 | 只有 `true` 才启用自测通道。                                                   |
| `channel`      |   是 | 必须是 `"selftest"`，避免误把其它配置当成更新源。                              |
| `manifestFile` |   否 | 默认 `cmbdevclaw-latest.selftest.json`；不能写正式 `cmbdevclaw-latest.json`。  |
| `baseUrl`      |   否 | 不填时沿用正式更新服务器，只切换 manifest 文件名；填写时用于本机或测试服务器。 |
| `expiresAt`    | 建议 | 过期后自动回退正式通道，防止测试完忘记关闭。                                   |

关闭自测通道：

- 删除 `update-channel.json`；或
- 改成 `"enabled": false`。

## 自测 manifest

自测 manifest 结构复用正式 `latest.json` 协议。例如：

```json
{
  "version": "1.4.8",
  "minVersion": "1.4.5",
  "releaseNotes": "自测 1.4.8",
  "mandatory": false,
  "asar": {
    "version": "1.4.8",
    "file": "CMBDevClaw-1.4.8.asar.gz",
    "sha256": "<asar.gz 的 sha256>",
    "size": 123456
  },
  "platforms": {
    "win32": {
      "full": {
        "version": "1.4.5",
        "file": "CMBDevClaw-win-unpacked-1.4.5.zip",
        "sha256": "<zip 的 sha256>",
        "size": 123456789
      }
    },
    "linux": {
      "full": {
        "version": "1.4.5",
        "file": "CMBDevClaw-linux-unpacked-1.4.5.zip",
        "sha256": "<zip 的 sha256>",
        "size": 123456789
      }
    }
  }
}
```

注意：

- 自测 manifest 不需要再写 `staging`，它本身就是本机测试入口。
- 需要测试“旧大版本 → 中间 full → 最终 ASAR”时，保持 `version` 为最终版本，
  `full.version` 写中间版本，`minVersion` 写中间版本即可。
- 链式更新第一阶段完成后，请保留 `update-channel.json`，直到第二阶段 ASAR
  也验证完成；否则重启后的下一次检查可能回到正式源。

## 本地服务要求

当前更新器下载接口是：

```text
POST /download?file=<文件名>
```

因此普通 `python -m http.server` 不够用，因为它只支持静态 GET。用于本地
自测的服务需要支持：

1. `POST /download?file=cmbdevclaw-latest.selftest.json`
2. `POST /download?file=<manifest 中声明的包文件>`

如果文件上传到正式更新服务器，也可以不填 `baseUrl`，只把自测 manifest 用
独立文件名上传到同一位置。

## 推荐自测流程

1. 打包新版本，例如 `1.4.8`。
2. 生成并校验：
   - `cmbdevclaw-latest.selftest.json`
   - `CMBDevClaw-1.4.8.asar.gz`
   - 需要 full 测试时再放对应 zip。
3. 启动支持 `POST /download?file=...` 的本地更新服务，或上传到测试服务器。
4. 写入本机 `~/.cmbcoworkagent/update-channel.json`。
5. 安装旧版本客户端。
6. 打开旧版本，点击“检查更新”。
7. 弹窗中看到“自测更新通道”提示后，执行下载、重启、安装验证。
8. 验证完成后删除 `update-channel.json`。

## 如何确认当前走的是自测通道

主进程日志会打印：

```text
[Updater] SELFTEST update source enabled: manifest=cmbdevclaw-latest.selftest.json baseUrl=http://127.0.0.1:8787 expiresAt=...
```

更新弹窗也会显示：

```text
自测更新通道
manifest：cmbdevclaw-latest.selftest.json
baseUrl：http://127.0.0.1:8787
```

如果没有看到这些提示，说明当前仍在走正式更新源。

## 兼容性与安全边界

- 没有 `update-channel.json` 的普通用户完全不受影响。
- 正式 `cmbdevclaw-latest.json`、`staging` 灰度、`mandatory` 旧语义都不变。
- 自测通道只允许读取非正式名的 `cmbdevclaw-latest*.json`，不能把
  `manifestFile` 配成正式 `cmbdevclaw-latest.json`。
- `baseUrl` 只接受 `http` / `https`。
- `expiresAt` 过期后自动回退正式更新源。
