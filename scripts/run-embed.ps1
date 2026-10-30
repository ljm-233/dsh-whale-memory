# 在 Windows 上起向量服务
#
# 用法（PowerShell）：
#   .\scripts\run-embed.ps1
#
# 需要先装依赖（一次性）：
#   uv pip install --target "$env:USERPROFILE\.dsh-whale\pylibs" onnxruntime numpy

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $PSScriptRoot
$libs = Join-Path $env:USERPROFILE '.dsh-whale\pylibs'

if (-not (Test-Path $libs)) {
    Write-Error "找不到依赖目录 $libs，先运行：uv pip install --target `"$libs`" onnxruntime numpy"
}

$env:PYTHONPATH = $libs
if (-not $env:EMBED_PORT) { $env:EMBED_PORT = '8377' }

Write-Host "启动向量服务（端口 $env:EMBED_PORT）……"
python (Join-Path $root 'embed_server.py')
