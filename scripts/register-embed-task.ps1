# 把向量服务注册成「登录就自动起」的计划任务
#
# 用法（按自己的路径改）：
#   .\scripts\register-embed-task.ps1 `
#       -ServiceScript "C:\Users\你\dsh-whale-memory\embed_server.py" `
#       -ModelDir "C:\Users\你\.dsh-whale\models\bge-small-zh-v1.5-int8" `
#       -Libs "C:\Users\你\.dsh-whale\pylibs"
#
# 不传 -Libs 就只设模型目录。任务名默认 dsh-whale-embed。
param(
    [Parameter(Mandatory = $true)][string]$ServiceScript,
    [Parameter(Mandatory = $true)][string]$ModelDir,
    [string]$Libs = '',
    [string]$TaskName = 'dsh-whale-embed',
    [string]$PythonExe = 'python'
)

$ErrorActionPreference = 'Stop'

if (-not (Test-Path $ServiceScript)) { throw "找不到服务脚本：$ServiceScript" }
if (-not (Test-Path $ModelDir)) { throw "找不到模型目录：$ModelDir" }

# 拼一条命令行出来，环境变量在启动前设好
$envs = "`$env:WHALE_MODEL_DIR='$ModelDir'; `$env:EMBED_PORT='8377';"
if ($Libs -ne '') {
    if (-not (Test-Path $Libs)) { throw "找不到依赖目录：$Libs" }
    $envs += " `$env:PYTHONPATH='$Libs';"
}
$arguments = "-NoProfile -WindowStyle Hidden -Command `"$envs & '$PythonExe' '$ServiceScript'`""

$action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $arguments

# 登录时起；已在跑就别重复起
$trigger = New-ScheduledTaskTrigger -AtLogOn

$settings = New-ScheduledTaskSettingsSet `
    -AllowStartIfOnBatteries `
    -DontStopIfGoingOnBatteries `
    -StartWhenAvailable `
    -RestartCount 3 `
    -RestartInterval (New-TimeSpan -Minutes 1) `
    -ExecutionTimeLimit ([TimeSpan]::Zero)

# 删旧的（幂等）
if (Get-ScheduledTask -TaskName $TaskName -ErrorAction SilentlyContinue) {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
}

Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger -Settings $settings `
    -Description 'DSH 鲸娘记忆：BGE 中文向量服务（127.0.0.1:8377）' | Out-Null

Write-Host "已注册计划任务：$TaskName"

# 立刻起一次并自检
Start-ScheduledTask -TaskName $TaskName
Start-Sleep -Seconds 8
try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8377/health' -TimeoutSec 5
    Write-Host "自检通过：$($r | ConvertTo-Json -Compress)"
} catch {
    Write-Warning "任务已注册，但自检没通。看看 $TaskName 的『上次运行结果』，或者把 -PythonExe 换成 python.exe 的完整路径。"
}
