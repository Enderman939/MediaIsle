param(
    [Parameter(Mandatory = $true)][string]$PlanPath,
    [switch]$Headless,
    [switch]$NoLaunch
)
$ErrorActionPreference = 'Stop'
$plan = Get-Content -LiteralPath $PlanPath -Raw -Encoding UTF8 | ConvertFrom-Json
$root = [IO.Path]::GetFullPath($plan.installDir).TrimEnd('\')
$stage = [IO.Path]::GetFullPath($plan.newDir).TrimEnd('\')
$backup = Join-Path ([IO.Path]::GetDirectoryName($PlanPath)) 'rollback'
$journal = New-Object 'System.Collections.Generic.List[object]'
$form = $null
$label = $null
$progress = $null

function Show-Stage([string]$text, [int]$percent) {
    if ($form) {
        $label.Text = $text
        $progress.Value = [Math]::Min(100, [Math]::Max(0, $percent))
        [Windows.Forms.Application]::DoEvents()
    }
}

function Save-Result([string]$status, [string]$message) {
    @{ status = $status; message = $message; version = $plan.to; at = [DateTime]::UtcNow.ToString('o') } |
        ConvertTo-Json | Set-Content -LiteralPath $plan.resultFile -Encoding UTF8
}

try {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) { throw 'Install directory missing' }
    if (-not (Test-Path -LiteralPath (Join-Path $stage $plan.exeName) -PathType Leaf)) { throw 'Update executable missing' }
    if ($root -eq $stage -or $root.StartsWith($stage + '\') -or $stage.StartsWith($root + '\')) { throw 'Update staging must be outside the install directory' }
    if (Test-Path -LiteralPath $backup) { throw 'Rollback directory already exists' }

    if (-not $Headless) {
        Add-Type -AssemblyName System.Windows.Forms
        Add-Type -AssemblyName System.Drawing
        [Windows.Forms.Application]::EnableVisualStyles()
        $form = New-Object Windows.Forms.Form
        $form.Text = 'MediaIsle'
        $form.ClientSize = New-Object Drawing.Size(460, 190)
        $form.StartPosition = 'CenterScreen'
        $form.FormBorderStyle = 'FixedDialog'
        $form.ControlBox = $false
        $form.BackColor = [Drawing.Color]::FromArgb(20, 18, 24)
        $form.ForeColor = [Drawing.Color]::FromArgb(230, 224, 233)
        $title = New-Object Windows.Forms.Label
        $title.Text = 'MediaIsle ' + $plan.to
        $title.Font = New-Object Drawing.Font('Segoe UI', 18)
        $title.SetBounds(28, 22, 400, 40)
        $label = New-Object Windows.Forms.Label
        $label.Font = New-Object Drawing.Font('Segoe UI', 10)
        $label.SetBounds(30, 72, 400, 48)
        $progress = New-Object Windows.Forms.ProgressBar
        $progress.SetBounds(30, 140, 400, 8)
        $form.Controls.AddRange(@($title, $label, $progress))
        $form.Show()
    }

    Show-Stage $plan.ui.waiting 5
    $deadline = [DateTime]::UtcNow.AddSeconds(60)
    while (Get-Process -Id $plan.pid -ErrorAction SilentlyContinue) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'The running application did not exit' }
        Start-Sleep -Milliseconds 100
        if ($form) { [Windows.Forms.Application]::DoEvents() }
    }

    $files = @(Get-ChildItem -LiteralPath $stage -File -Recurse)
    if ($files.Count -eq 0) { throw 'Update archive is empty' }
    foreach ($file in $files) {
        $relative = $file.FullName.Substring($stage.Length).TrimStart('\')
        $destination = Join-Path $root $relative
        $saved = Join-Path $backup $relative
        $existed = Test-Path -LiteralPath $destination
        if ($existed) {
            [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($saved)) | Out-Null
            Copy-Item -LiteralPath $destination -Destination $saved -Force
        }
        $journal.Add(@{ destination = $destination; saved = $saved; existed = $existed })
        [IO.Directory]::CreateDirectory([IO.Path]::GetDirectoryName($destination)) | Out-Null
        Copy-Item -LiteralPath $file.FullName -Destination $destination -Force
        Show-Stage $plan.ui.installing (10 + [int](75 * $journal.Count / $files.Count))
    }

    Show-Stage $plan.ui.restarting 92
    Save-Result 'installed' ''
    if (-not $NoLaunch) {
        Start-Process -FilePath (Join-Path $root $plan.exeName) -ArgumentList '--updated' -WorkingDirectory $root | Out-Null
    }
    Show-Stage $plan.ui.done 100
    if ($form) { Start-Sleep -Milliseconds 600 }
    exit 0
} catch {
    $failure = $_.Exception.Message
    for ($i = $journal.Count - 1; $i -ge 0; $i--) {
        $entry = $journal[$i]
        try {
            if ($entry.existed) { Copy-Item -LiteralPath $entry.saved -Destination $entry.destination -Force }
            else { Remove-Item -LiteralPath $entry.destination -Force -ErrorAction SilentlyContinue }
        } catch { $failure += '; rollback: ' + $_.Exception.Message }
    }
    Save-Result 'error' $failure
    if (-not $NoLaunch -and (Test-Path -LiteralPath (Join-Path $root $plan.exeName))) {
        Start-Process -FilePath (Join-Path $root $plan.exeName) -ArgumentList '--settings' -WorkingDirectory $root | Out-Null
    }
    if ($form) { [Windows.Forms.MessageBox]::Show($plan.ui.failed + "`r`n" + $failure, 'MediaIsle') | Out-Null }
    exit 1
} finally {
    if ($form) { $form.Dispose() }
}
