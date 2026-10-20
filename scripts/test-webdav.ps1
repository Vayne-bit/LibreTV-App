# 坚果云 WebDAV 连通性诊断脚本
# 用法：.\test-webdav.ps1 -Email "你的邮箱" -Password "应用密码"
#
# 目的：不装 App，直接在电脑上验证同步依赖的每个 WebDAV 操作

param(
    [Parameter(Mandatory = $true)][string]$Email,
    [Parameter(Mandatory = $true)][string]$Password,
    [string]$Code = "TESTCODE1234"
)

$dav = "https://dav.jianguoyun.com/dav"
$pair = "${Email}:${Password}"
$b64 = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($pair))
$headers = @{ Authorization = "Basic $b64" }
$file = "$dav/libretv-sync-$Code.json"

function Test-Step {
    param($Name, $Expected, $ScriptBlock)
    Write-Host ""
    Write-Host "── $Name ──" -ForegroundColor Cyan
    try {
        $result = & $ScriptBlock
        $code = $result.StatusCode
        $ok = $Expected -contains $code
        $mark = if ($ok) { "✓" } else { "✗" }
        $color = if ($ok) { "Green" } else { "Red" }
        Write-Host "$mark HTTP $code (期望 $($Expected -join ' / '))" -ForegroundColor $color
        return $result
    } catch {
        $code = $null
        if ($_.Exception.Response) { $code = [int]$_.Exception.Response.StatusCode }
        $ok = $code -and ($Expected -contains $code)
        $mark = if ($ok) { "✓" } else { "✗" }
        $color = if ($ok) { "Green" } else { "Red" }
        Write-Host "$mark HTTP $code (期望 $($Expected -join ' / '))" -ForegroundColor $color
        if (-not $ok) { Write-Host "   错误: $($_.Exception.Message)" -ForegroundColor DarkGray }
        return $null
    }
}

Write-Host "坚果云 WebDAV 诊断" -ForegroundColor Yellow
Write-Host "账号: $Email"
Write-Host "测试文件: libretv-sync-$Code.json"
Write-Host ""

# 1. 认证 + 根目录访问
Write-Host "【1】验证账号密码" -ForegroundColor Yellow
$authOk = Test-Step "PROPFIND 根目录" @(207, 403, 200) {
    Invoke-WebRequest -Uri "$dav/" -Method PROPFIND -Headers ($headers + @{ Depth = "0" }) -TimeoutSec 20 -UseBasicParsing
}
if (-not $authOk -and -not $?) {
    Write-Host ""
    Write-Host "账号验证失败，请检查：" -ForegroundColor Red
    Write-Host "  · 是否用了「应用密码」而不是登录密码"
    Write-Host "  · 邮箱是否完整"
    exit 1
}

# 2. 上传文件到根目录
Write-Host ""
Write-Host "【2】上传测试文件（关键步骤）" -ForegroundColor Yellow
$putOk = Test-Step "PUT 文件" @(201, 204, 200) {
    $body = @{ test = $true; time = (Get-Date).ToString("o") } | ConvertTo-Json
    Invoke-WebRequest -Uri $file -Method PUT -Headers ($headers + @{ "Content-Type" = "application/json" }) -Body $body -TimeoutSec 30 -UseBasicParsing
}

# 3. 读回
Write-Host ""
Write-Host "【3】读回文件" -ForegroundColor Yellow
$getOk = Test-Step "GET 文件" @(200) {
    Invoke-WebRequest -Uri $file -Method GET -Headers $headers -TimeoutSec 20 -UseBasicParsing
}
if ($getOk) {
    Write-Host "  内容: $($getOk.Content)" -ForegroundColor DarkGray
}

# 4. 覆盖写（模拟第二次同步）
Write-Host ""
Write-Host "【4】覆盖写（模拟重复同步）" -ForegroundColor Yellow
Test-Step "PUT 覆盖" @(204, 200, 201) {
    $body = @{ test = $true; round = 2 } | ConvertTo-Json
    Invoke-WebRequest -Uri $file -Method PUT -Headers ($headers + @{ "Content-Type" = "application/json" }) -Body $body -TimeoutSec 30 -UseBasicParsing
} | Out-Null

# 5. 删除测试文件
Write-Host ""
Write-Host "【5】清理测试文件" -ForegroundColor Yellow
Test-Step "DELETE" @(204, 200, 404) {
    Invoke-WebRequest -Uri $file -Method DELETE -Headers $headers -TimeoutSec 20 -UseBasicParsing
} | Out-Null

# 总结
Write-Host ""
Write-Host "═══════════════════════════" -ForegroundColor Yellow
if ($putOk -and $getOk) {
    Write-Host "✓ 全部通过，同步功能应该可用" -ForegroundColor Green
    Write-Host ""
    Write-Host "如果 App 里仍报 404，说明问题在 App 端而不是坚果云。"
} else {
    Write-Host "✗ 存在失败步骤，请把上面的输出发给我" -ForegroundColor Red
}
Write-Host "═══════════════════════════" -ForegroundColor Yellow
