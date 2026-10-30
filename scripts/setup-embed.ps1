# Windows 11：一键准备向量服务
#
#   .\scripts\setup-embed.ps1
#
# 做三件事：装 onnxruntime/numpy → 下载 BGE 模型 → 起服务并自检。
# 需要先装好 Python 3.10+ 和 uv（没有的话：winget install astral-sh.uv）。

$ErrorActionPreference = 'Stop'

$root   = Split-Path -Parent $PSScriptRoot
$libs   = Join-Path $env:USERPROFILE '.dsh-whale\pylibs'
$models = Join-Path $env:USERPROFILE '.dsh-whale\models\bge-small-zh-v1.5-int8'

Write-Host "[1/3] 装 Python 依赖到 $libs"
if (-not (Test-Path $libs)) {
    uv pip install --target $libs onnxruntime numpy
}

Write-Host "[2/3] 准备模型到 $models"
if (-not (Test-Path (Join-Path $models 'model.onnx'))) {
    New-Item -ItemType Directory -Force -Path $models | Out-Null
    # 两个文件：model.onnx + tokenizer.json
    uv pip install --target $libs huggingface_hub
    $env:PYTHONPATH = $libs
    python -c @"
import os, shutil
from huggingface_hub import hf_hub_download
dst = os.environ['WHALE_MODEL_DIR']
for name in ('model.onnx', 'tokenizer.json'):
    p = hf_hub_download('BAAI/bge-small-zh-v1.5', name, local_dir=dst)
    print('下载', name, '→', p)
"@
} else {
    Write-Host "模型已存在，跳过"
}

Write-Host "[3/3] 启动向量服务（新窗口，关掉窗口就停）"
$env:WHALE_MODEL_DIR = $models
$env:PYTHONPATH = $libs
Start-Process powershell -ArgumentList @(
    '-NoExit', '-NoProfile', '-Command',
    "`$env:WHALE_MODEL_DIR='$models'; `$env:PYTHONPATH='$libs'; python '$root\embed_server.py'"
)

Start-Sleep -Seconds 8
try {
    $r = Invoke-RestMethod -Uri 'http://127.0.0.1:8377/health' -TimeoutSec 5
    Write-Host "自检通过：$($r | ConvertTo-Json -Compress)"
} catch {
    Write-Warning "自检没通，看看那个新窗口里的报错"
}
