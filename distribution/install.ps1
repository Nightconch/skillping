& {
    $ErrorActionPreference = 'Stop'
    $marketplace = 'Nightconch/skillping'
    $installerFile = $MyInvocation.MyCommand.ScriptBlock.File
    if ($installerFile) {
        $installerRoot = Split-Path -Parent $installerFile
        if (Test-Path -LiteralPath (Join-Path $installerRoot '.agents\plugins\marketplace.json') -PathType Leaf) {
            $marketplace = $installerRoot
        }
    }

    & codex plugin marketplace add $marketplace
    if ($LASTEXITCODE -ne 0) { throw 'SkillPing installation failed: MARKETPLACE_ADD_FAILED.' }
    & codex plugin add skillping-runtime@skillping
    if ($LASTEXITCODE -ne 0) { throw 'SkillPing installation failed: RUNTIME_ADD_FAILED.' }
    & codex plugin add skillping@skillping
    if ($LASTEXITCODE -ne 0) { throw 'SkillPing installation failed: PLUGIN_ADD_FAILED.' }

    Write-Host 'Optional: Sqwish kettei-fat makes initial decisions and workflow matching fast and inexpensive.'
    Write-Host 'It sends request/workflow information to Sqwish, billed separately. Without a Key, Codex handles these decisions.'
    Write-Host 'Get a Key at https://console.sqwish.ai/ . Press Enter to skip and keep existing settings.'
    $secureKey = Read-Host -Prompt 'Sqwish API Key (hidden)' -AsSecureString
    $keyPointer = [IntPtr]::Zero
    $process = $null
    try {
        $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
        $key = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer).Trim()
        if ($key) {
            try {
                $descriptorJson = & codex mcp get skillping --json 2>$null
                if ($LASTEXITCODE -ne 0) { throw 'MCP_GET_FAILED' }
                $descriptor = ($descriptorJson -join "`n") | ConvertFrom-Json
                $transport = $descriptor.transport
                if ($descriptor.name -ne 'skillping' -or $descriptor.enabled -ne $true -or
                    $transport.type -ne 'stdio' -or $transport.command -ne 'node') { throw 'RUNTIME_INVALID' }
                $pluginRoot = [IO.Path]::GetFullPath($transport.env.PLUGIN_ROOT)
                $dataDir = [IO.Path]::GetFullPath($transport.env.PLUGIN_DATA)
                $bundle = Join-Path $pluginRoot 'dist\mcp\server.bundle.js'
                $manifest = Get-Content -LiteralPath (Join-Path $pluginRoot 'plugin.json') -Raw | ConvertFrom-Json
                if ($manifest.name -ne 'skillping-runtime' -or @($transport.args).Count -ne 1 -or
                    [IO.Path]::GetFullPath($transport.args[0]) -ne $bundle -or
                    [IO.Path]::GetFullPath($transport.cwd) -ne $pluginRoot -or
                    -not (Test-Path -LiteralPath $bundle -PathType Leaf) -or
                    -not (Test-Path -LiteralPath $dataDir -PathType Container)) { throw 'RUNTIME_INVALID' }

                $start = New-Object System.Diagnostics.ProcessStartInfo
                $start.FileName = Get-Command node -CommandType Application | Select-Object -First 1 -ExpandProperty Source
                $start.Arguments = '"{0}" --configure-key' -f $bundle
                $start.WorkingDirectory = $pluginRoot
                $start.UseShellExecute = $false
                $start.CreateNoWindow = $true
                $start.RedirectStandardInput = $true
                $start.RedirectStandardOutput = $true
                $start.RedirectStandardError = $true
                $start.EnvironmentVariables['PLUGIN_ROOT'] = $pluginRoot
                $start.EnvironmentVariables['PLUGIN_DATA'] = $dataDir
                $process = [Diagnostics.Process]::Start($start)
                $outputTask = $process.StandardOutput.ReadToEndAsync()
                $errorTask = $process.StandardError.ReadToEndAsync()
                $inputWriter = New-Object IO.StreamWriter($process.StandardInput.BaseStream, (New-Object Text.UTF8Encoding($false)))
                try { $inputWriter.Write($key) } finally { $inputWriter.Dispose() }
                if (-not $process.WaitForExit(30000)) {
                    $process.Kill()
                    throw 'CONFIGURE_FAILED'
                }
                if ($process.ExitCode -ne 0 -or $outputTask.Result.Trim() -ne 'SKILLPING_KEY_CONFIGURED') {
                    throw 'CONFIGURE_FAILED'
                }
            } catch {
                throw 'SkillPing Key configuration failed: CONFIGURE_FAILED. No Key was displayed.'
            }
            Write-Host 'Sqwish Key saved in the Runtime config.json. Decision model enabled.'
        } else {
            Write-Host 'Key setup skipped. Existing settings kept.'
        }
    } finally {
        $key = $null
        if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
        $secureKey.Dispose()
        if ($process) { $process.Dispose() }
    }
    Write-Host 'SkillPing installed. Trust its Hook when prompted, restart Codex, then open a new chat and run $skillping-help.'
}
