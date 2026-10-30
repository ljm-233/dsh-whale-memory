# 把向量服务挂到「启动」文件夹——不需要管理员权限，不改计划任务
#
#   .\scripts\install-embed-startup.ps1 `
#       -ServiceScript "C:\...\patches\embed\embed_server.py" `
#       -ModelDir      "C:\...\patches\embed" `
#       -Libs          "C:\...\patches\embed\pylibs"
#
# 计划任务报「拒绝访问」时用这个：往 %APPDATA%\...\Startup 放一个 .vbs，
# 开机登录后隐藏窗口拉起 python，不弹黑框。

param(
    [Parameter(Mandatory = $true)][string]$ServiceScript,
    [Parameter(Mandatory = $true)][string]$ModelDir,
    [string]$Libs = '',
    [string]$PythonExe = 'python',
    [int]$Port = 8377
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ServiceScript)) { throw "找不到服务脚本：$ServiceScript" }
if (-not (Test-Path $ModelDir)) { throw "找不到模型目录：$ModelDir" }

$startup = [Environment]::GetFolderPath('Startup')
$vbs = Join-Path $startup 'dsh-whale-embed.vbs'

$cmd = "`$env:WHALE_MODEL_DIR='$ModelDir'; `$env:EMBED_PORT='$Port';"
if ($Libs -ne '') {
    if (-not (Test-Path $Libs)) { throw "找不到依赖目录：$Libs" }
    $cmd += " `$env:PYTHONPATH='$Libs';"
}
$cmd += " & '$PythonExe' '$ServiceScript'"

# 0 = 隐藏窗口，False = 不等它结束
$vbsBody = @"
' DSH 鲸娘记忆：启动 BGE 向量服务（隐藏窗口）
Set sh = CreateObject("WScript.Shell")
sh.Run "powershell.exe -NoProfile -WindowStyle Hidden -Command ""$($cmd -replace '"', '""')""", 0, False
"@

Set-Content -Path $vbs -Value $vbsBody -Encoding ASCII
Write-Host "已写入启动项：$vbs"
Write-Host "下次登录会自动起。现在想立刻起，直接双击这个 .vbs 就行。"
