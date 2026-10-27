param([switch]$ReuseSources, [switch]$ResumePreparedBuild, [switch]$ShortBuildPath)
$ErrorActionPreference = "Stop"
if ($ReuseSources -and $ResumePreparedBuild) {
  throw "Choose either strict source reuse or an explicitly qualified incremental build"
}
$repository = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot "../.."))
$cache = Join-Path $repository ".cache/private-node/v24.22.1-appcontainer-canonical-v2-final-win-x64"
$toolchain = Join-Path $repository ".cache/private-node/toolchain-17.14.19.1.5"
$source = Join-Path $cache "node-v24.22.1"
$shortCache = $null
if ($repository -match '[\r\n"%]') { throw "Unsupported build directory characters" }
if (![IO.File]::Exists((Join-Path $toolchain "toolchain-manifest.json"))) {
  throw "Run python scripts/private-node/prepare-toolchain.py first"
}
$manifest = Get-Content -LiteralPath (Join-Path $toolchain "toolchain-manifest.json") -Raw |
  ConvertFrom-Json
foreach ($file in $manifest.files) {
  $target = Join-Path (Join-Path $toolchain "clang") $file.path
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) {
    throw "Private toolchain digest changed: $target"
  }
}
foreach ($file in @($manifest.archiveFiles.toolset) + @($manifest.archiveFiles.nasm)) {
  $target = Join-Path $toolchain $file.path
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) {
    throw "Private tool archive extraction digest changed: $target"
  }
}
$signatures = foreach ($name in @("clang.exe", "clang-cl.exe", "lld-link.exe", "llvm-lib.exe")) {
  $target = Join-Path $toolchain "clang/bin/$name"
  $signature = Get-AuthenticodeSignature -LiteralPath $target
  if ($signature.Status -ne "Valid" -or
    $signature.SignerCertificate.Subject -notmatch 'O=Microsoft Corporation') {
    throw "Current Microsoft Authenticode validation failed: $target"
  }
  [ordered]@{ file = $name; status = [string]$signature.Status;
    signer = $signature.SignerCertificate.Subject;
    thumbprint = $signature.SignerCertificate.Thumbprint }
}
$vswhere = Join-Path ${env:ProgramFiles(x86)} "Microsoft Visual Studio/Installer/vswhere.exe"
$visualStudio = & $vswhere -latest -products '*' -version '[17.14,18.0)' `
  -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (!$visualStudio -or $visualStudio -match '[\r\n"%]') {
  throw "Visual Studio 2022 17.14 C++ build tools are required"
}
$targets = Join-Path $toolchain "vctargets"
if (![IO.Directory]::Exists($targets)) {
  Copy-Item -LiteralPath (Join-Path $visualStudio "MSBuild/Microsoft/VC/v170") `
    -Destination $targets -Recurse
  Copy-Item -Path (Join-Path $toolchain "toolset/Contents/Msbuild/Microsoft/VC/v170/*") `
    -Destination $targets -Recurse -Force
}
foreach ($file in $manifest.archiveFiles.toolset) {
  $prefix = "toolset/Contents/Msbuild/Microsoft/VC/v170/"
  if (!$file.path.StartsWith($prefix)) { continue }
  $target = Join-Path $targets $file.path.Substring($prefix.Length)
  if ((Get-FileHash -LiteralPath $target -Algorithm SHA256).Hash -ne $file.sha256) {
    throw "Private MSBuild LLVM toolset copy digest changed: $target"
  }
}
$resumeInputs = @()
if ($ResumePreparedBuild) {
  $sourceManifestPath = Join-Path $cache "source-manifest.json"
  if ((Get-FileHash -LiteralPath $sourceManifestPath -Algorithm SHA256).Hash -ne
    "5b891f2efba741a7ad434773f6b4a694b860cb89cdd0a975c840d7b1098c5067") {
    throw "Incremental build requires the exact qualified canonical-v2 source manifest"
  }
  $sourceManifest = Get-Content -LiteralPath $sourceManifestPath -Raw | ConvertFrom-Json
  $resumeFiles = @($sourceManifest.changes | ForEach-Object {
    [ordered]@{ path = (Join-Path $source $_.path); sha256 = $_.after }
  }) + @(
    [ordered]@{ path = (Join-Path $source $sourceManifest.header.onlyAddedPath); sha256 = $sourceManifest.header.sha256 },
    [ordered]@{ path = (Join-Path $repository $sourceManifest.header.source); sha256 = $sourceManifest.header.sha256 },
    [ordered]@{ path = (Join-Path $repository $sourceManifest.patch.path); sha256 = $sourceManifest.patch.sha256 }
  )
  foreach ($file in $resumeFiles) {
    $actual = (Get-FileHash -LiteralPath $file.path -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($actual -ne $file.sha256) { throw "Qualified incremental build input changed: $($file.path)" }
    $resumeInputs += [ordered]@{ path = $file.path; sha256 = $actual }
  }
} else {
  $sourceArguments = @((Join-Path $PSScriptRoot "prepare-source.py"))
  if ($ReuseSources) { $sourceArguments += "--patch-only" }
  & python @sourceArguments
  if ($LASTEXITCODE -ne 0) { throw "Pinned Node source preparation failed" }
}
if ($ShortBuildPath) {
  $shortCache = Join-Path $repository ".cache/n29"
  if (Test-Path -LiteralPath $shortCache) {
    $shortItem = Get-Item -LiteralPath $shortCache -Force
    if ($shortItem.LinkType -ne "Junction" -or @($shortItem.Target).Count -ne 1 -or
      [IO.Path]::GetFullPath([string](@($shortItem.Target)[0])) -ne [IO.Path]::GetFullPath($cache)) {
      throw "Short build path exists and is not this exact private cache junction"
    }
  } else {
    New-Item -ItemType Junction -Path $shortCache -Target $cache | Out-Null
  }
  $source = Join-Path $shortCache "node-v24.22.1"
}
$configureCommand = @'
python configure --dest-cpu=x64 --clang-cl=19.1.5 --without-npm --without-corepack
if errorlevel 1 exit /b 1
'@
if ($ResumePreparedBuild) {
  if (![IO.File]::Exists((Join-Path $source "node.sln"))) {
    throw "Incremental build requires the existing successfully configured solution"
  }
  $configureCommand = "rem Reusing the previously configured solution and build outputs"
}
$generateCommand = ""
if ($ShortBuildPath -and $ResumePreparedBuild) {
  if (![IO.File]::Exists((Join-Path $source "out/Release/bytecode_builtins_list_generator.exe"))) {
    throw "Incremental short-path build requires the already built bytecode generator"
  }
  $generateCommand = @'
if not exist "out\Release\obj\global_intermediate\generate-bytecode-output-root\builtins-generated" mkdir "out\Release\obj\global_intermediate\generate-bytecode-output-root\builtins-generated"
if errorlevel 1 exit /b 1
pushd tools\v8_gypfiles
"..\..\out\Release\bytecode_builtins_list_generator.exe" "..\..\out\Release\obj\global_intermediate\generate-bytecode-output-root\builtins-generated\bytecodes-builtins-list.h"
set "GUARD_GENERATOR_EXIT=%errorlevel%"
popd
if not "%GUARD_GENERATOR_EXIT%"=="0" exit /b %GUARD_GENERATOR_EXIT%
python -c "from pathlib import Path;p=Path('out/Release/obj/global_intermediate/generate-bytecode-output-root/builtins-generated/bytecodes-builtins-list.h');assert p.is_file() and p.stat().st_size>0,'bytecode header was not generated';print('Verified generated bytecode header:',p.stat().st_size)"
if errorlevel 1 exit /b 1
'@
}
$trackingProps = Join-Path $cache "private-tracking.props"
[IO.File]::WriteAllText($trackingProps, @'
<Project xmlns="http://schemas.microsoft.com/developer/msbuild/2003">
  <PropertyGroup>
    <TrackFileAccess>false</TrackFileAccess>
  </PropertyGroup>
</Project>
'@, [Text.UTF8Encoding]::new($false))
$command = @"
@echo off
setlocal
chcp 65001 >nul
call "$visualStudio\VC\Auxiliary\Build\vcvarsall.bat" amd64
if errorlevel 1 exit /b 1
set "GUARD_TOOLCHAIN=$toolchain"
set "PATH=%GUARD_TOOLCHAIN%\clang\bin;%GUARD_TOOLCHAIN%\nasm\nasm-2.16.03;%PATH%"
set "VCTargetsPath=%GUARD_TOOLCHAIN%\vctargets/"
set "LLVMInstallDir=%GUARD_TOOLCHAIN%\clang"
set "LLVMToolsVersion=19.1.5"
set "GYP_MSVS_VERSION=2022"
set "GYP_MSVS_OVERRIDE_PATH=$visualStudio"
set "PYTHONIOENCODING=utf-8"
set "UseMultiToolTask=True"
set "EnforceProcessCountAcrossBuilds=True"
set "MultiProcMaxCount=2"
set "NUMBER_OF_PROCESSORS=2"
cd /d "$source"
echo %VSCMD_VER%>..\toolchain-vscmd-version.txt
echo %VCToolsVersion%>..\toolchain-msvc-version.txt
echo %WindowsSDKVersion%>..\toolchain-windows-sdk-version.txt
python -c "import sys;print(sys.version)" >..\toolchain-python-version.txt
$configureCommand
$generateCommand
msbuild node.sln /m:2 /nr:false /t:node /p:Configuration=Release /p:Platform=x64 "/p:VCTargetsPath=%VCTargetsPath%" "/p:LLVMInstallDir=%LLVMInstallDir%" "/p:ForceImportAfterCppProps=$trackingProps" /p:LLVMToolsVersion=19.1.5 /clp:NoItemAndPropertyList;Verbosity=minimal /nologo /fl "/flp:logfile=..\build-msbuild.log;verbosity=normal"
exit /b %errorlevel%
"@
$commandPath = Join-Path $cache "build-private.cmd"
[IO.File]::WriteAllText($commandPath, $command, [Text.UTF8Encoding]::new($false))
& $env:ComSpec /d /s /c ('""' + $commandPath + '""')
if ($LASTEXITCODE -ne 0) { throw "Private Node build failed; see $cache/build-msbuild.log" }
$output = Join-Path $cache "runtime"
New-Item -ItemType Directory -Force -Path $output | Out-Null
Copy-Item -LiteralPath (Join-Path $source "out/Release/node.exe") -Destination $output -Force
Copy-Item -LiteralPath (Join-Path $source "LICENSE") `
  -Destination (Join-Path $output "LICENSE.node.txt") -Force
$node = Join-Path $output "node.exe"
$versions = & $node -p 'JSON.stringify(process.versions)' | ConvertFrom-Json
if ($LASTEXITCODE -ne 0 -or $versions.node -ne "24.22.1" -or $versions.modules -ne "137") {
  throw "Private runtime Node version or module ABI does not match the pinned build"
}
$report = [ordered]@{
  status = "built-awaiting-os-verification"
  canonicalMetadataProtocol = 1
  windowsJsRealpathAncestorFallback = 1
  canonicalMetadataQualification = "pending-component-and-real-appcontainer-acceptance"
  platform = "win32"
  architecture = "x64"
  source = (Get-Content -LiteralPath (Join-Path $cache "source-manifest.json") -Raw | ConvertFrom-Json)
  executableSha256 = (Get-FileHash -LiteralPath $node -Algorithm SHA256).Hash.ToLowerInvariant()
  versions = $versions
  visualStudio = $visualStudio
  visualStudioVersion = (Get-Content -LiteralPath (Join-Path $cache "toolchain-vscmd-version.txt") -Raw).Trim()
  msvcVersion = (Get-Content -LiteralPath (Join-Path $cache "toolchain-msvc-version.txt") -Raw).Trim()
  windowsSdkVersion = (Get-Content -LiteralPath (Join-Path $cache "toolchain-windows-sdk-version.txt") -Raw).Trim()
  pythonVersion = (Get-Content -LiteralPath (Join-Path $cache "toolchain-python-version.txt") -Raw).Trim()
  toolchainManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $toolchain "toolchain-manifest.json") -Algorithm SHA256).Hash.ToLowerInvariant()
  toolSignatures = @($signatures)
  globalInstallationChanged = $false
  concurrentCompilerLimit = 2
  fileTrackingDisabledFor = @("all-private-node-build-projects")
  incrementalBuild = [bool]$ResumePreparedBuild
  configureReused = [bool]$ResumePreparedBuild
  shortBuildPath = $shortCache
  buildWorkingDirectory = $source
  sourceRevalidatedCompletely = !$ResumePreparedBuild
  resumeInputFileHashes = @($resumeInputs)
  sourceManifestSha256 = (Get-FileHash -LiteralPath (Join-Path $cache "source-manifest.json") -Algorithm SHA256).Hash.ToLowerInvariant()
  buildScriptSha256 = (Get-FileHash -LiteralPath $PSCommandPath -Algorithm SHA256).Hash.ToLowerInvariant()
  configure = @("--dest-cpu=x64", "--clang-cl=19.1.5", "--without-npm", "--without-corepack")
}
[IO.File]::WriteAllText((Join-Path $output "build-manifest.json"),
  ($report | ConvertTo-Json -Depth 12) + "`n", [Text.UTF8Encoding]::new($false))
Write-Output "Private runtime built: $node. AppContainer/Job verification is still required."
