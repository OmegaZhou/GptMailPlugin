param([Parameter(Mandatory = $true)][string]$SshHost)
$ErrorActionPreference = 'Stop'
$mailLoginKey = & ssh -o BatchMode=yes -o ConnectTimeout=12 $SshHost 'python3 -c ''import json; print(json.load(open("/etc/gpt-mail/config.json"))["apiKey"])'''
if ($LASTEXITCODE -ne 0 -or -not $mailLoginKey -or $mailLoginKey.Length -lt 32) {
    throw 'Unable to read the server login key.'
}
Set-Clipboard -Value ([string]$mailLoginKey)
$mailLoginKey = $null
Write-Host '登录密钥已复制到剪贴板。仅粘贴到自己的 GptMail 服务端授权页。'
